import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import { wrapHandler } from "../utils/errorHandling.js";
import { sanitizeBuildName } from "../utils/pathSanitizer.js";
import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import { PoBGuiApiClient } from "../pobGuiClient.js";

/**
 * Build folder management as PoB's build list does it (Modules/BuildList.lua,
 * Classes/BuildListControl.lua, Modules/BuildListHelpers.lua and
 * main:CopyFolder / main:MoveFolder / main:OpenNewFolderPopup in
 * Modules/Main.lua).
 *
 * These run in TypeScript, not as Lua actions: they need no open build, and
 * the headless engine cannot do them, because HeadlessWrapper.lua stubs
 * NewFileSearch, MakeDir and RemoveDir (they return nothing), which PoB's
 * build list relies on for every listing and folder change. The behaviour
 * follows PoB's, with deliberate differences for safety:
 * - nothing is ever overwritten (PoB's rename and copy dialogs refuse an
 *   existing name too, but its folder moves would merge);
 * - deleting needs confirm: true;
 * - links are refused (the listing skips them, as they are not folders);
 * - the build loaded in the engine, or open in the window, cannot be
 *   renamed, moved or deleted: PoB's build list is only reachable with no
 *   build open, and a later save would write to the old name;
 * - hidden entries are neither listed nor acted on (see isHiddenEntryName).
 */

export interface BuildFolderContext {
  pobDirectory: string;
  buildService?: { invalidatePathsUnder(absPath: string): void };
  /** Absolute paths of the builds open right now (loaded in the engine, or open in the window). */
  openBuildFiles?: () => Promise<string[]>;
}

/** One entry of ScanFolder's index (BuildListHelpers.lua). */
export interface BuildListEntry {
  /** Path relative to the builds directory, with "/" separators. */
  relPath: string;
  /** Folder of the entry relative to the builds directory: "" or "a/b/". */
  subPath: string;
  folderName?: string;
  fileName?: string;
  buildName?: string;
  level?: number;
  className?: string;
  ascendClassName?: string;
  modified: number;
}

export type BuildSortMode = 'NAME' | 'CLASS' | 'EDITED' | 'LEVEL';

const CASE_INSENSITIVE = process.platform === 'win32';
const fold = (p: string) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
/** Two paths name the same entry (Windows file names ignore case). */
export const samePath = (a: string, b: string) => fold(a) === fold(b);
/** child is inside folder (or is folder itself), comparing as the file system does. */
export const isWithin = (child: string, folder: string, sep = '/') =>
  samePath(child, folder) || fold(child).startsWith(fold(folder) + sep);

/**
 * The builds open right now, whose files the folder tools must not rename,
 * move or delete: the file the headless engine loaded and saves to, or the
 * file open in the Path of Building window when the tools run on it. Does not
 * start an engine; when none runs, nothing is open.
 */
export async function openBuildFilesOf(getLuaClient: () => PoBLuaApiClient | null): Promise<string[]> {
  const client = getLuaClient();
  if (!client || !client.isAlive()) return [];
  if (client instanceof PoBGuiApiClient) {
    let status: Record<string, unknown>;
    try {
      status = await client.guiStatus();
    } catch (error) {
      throw new Error(`cannot tell which build is open in the Path of Building window (${error instanceof Error ? error.message : String(error)}); try again, or switch to the headless engine`);
    }
    const file = (status.build as { file?: unknown } | undefined)?.file;
    return typeof file === 'string' && file !== '' ? [path.resolve(file)] : [];
  }
  const loaded = client.getLoadedFilePath();
  return loaded ? [path.resolve(loaded)] : [];
}

/** A folder tool context that knows which builds are open, so it refuses to rename, move or delete them. */
export function withOpenBuilds<T extends Omit<BuildFolderContext, 'openBuildFiles'>>(base: T, getLuaClient: () => PoBLuaApiClient | null): T & BuildFolderContext {
  return { ...base, openBuildFiles: () => openBuildFilesOf(getLuaClient) };
}

// The characters the rename, copy and new folder dialogs filter out of a
// name: EditControl filter "\\/:%*%?\"<>|%c".
const FORBIDDEN_NAME = /[\\/:*?"<>|\x00-\x1f\x7f]/;
// Names Windows reserves for devices, with or without an extension.
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Entries list_builds skips (BuildService.listBuilds): dot-prefixed names,
 * which include this server's own storage (.pob-mcp/ for snapshots and
 * exports, .pob-mcp-presets/ for config presets), and PoB's ~~temp~~ files.
 * The folder tools do not list them and refuse them as targets or destinations.
 */
export const isHiddenEntryName = (name: string) => name.startsWith('.') || name.startsWith('~~temp~~');

/** A file or folder name for the builds directory, checked as PoB's dialogs check it, plus Windows' rules. */
export function validateEntryName(name: unknown, what: string): string {
  if (typeof name !== 'string' || !/\S/.test(name)) throw new Error(`${what} must be a non-empty name`);
  if (FORBIDDEN_NAME.test(name)) throw new Error(`${what} may not contain \\ / : * ? " < > | or control characters`);
  if (name === '.' || name === '..') throw new Error(`${what} may not be "." or ".."`);
  if (/[. ]$/.test(name)) throw new Error(`${what} may not end with a dot or a space (Windows drops them)`);
  if (RESERVED_NAME.test(name)) throw new Error(`${what} "${name}" is a name Windows reserves for a device`);
  if (name.length > 100) throw new Error(`${what} is longer than 100 characters`);
  return name;
}

function toRel(relPath: string | undefined): string {
  return (relPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/^\.$/, '');
}

async function lstatOrUndefined(full: string) {
  try { return await fs.lstat(full); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Resolve a path relative to the builds directory. Rejects anything that
 * leaves it (sanitizeBuildName), any link on the way (symlink or junction:
 * the build list does not list them, and they may point anywhere), and,
 * as a last guard, a real path outside the directory.
 */
export async function resolveInBuilds(relPath: string | undefined, baseDir: string, opts: { allowRoot?: boolean } = {}): Promise<{ rel: string; full: string }> {
  const rel = toRel(relPath);
  if (rel === '') {
    if (!opts.allowRoot) throw new Error('a path inside the builds directory is required (the builds directory itself cannot be changed)');
    return { rel, full: path.resolve(baseDir) };
  }
  const full = sanitizeBuildName(rel, baseDir);
  const hidden = path.relative(path.resolve(baseDir), full).split(path.sep).find(isHiddenEntryName);
  if (hidden !== undefined) {
    throw new Error(`"${hidden}" is hidden (a name starting with "." or "~~temp~~"); the build folder tools, like list_builds, do not act on hidden entries`);
  }
  let probe = path.resolve(baseDir);
  for (const part of rel.split('/')) {
    probe = path.join(probe, part);
    const stat = await lstatOrUndefined(probe);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`"${path.relative(baseDir, probe).replace(/\\/g, '/')}" is a link; the build list does not show links, so these tools do not act on them or through them`);
    }
  }
  const realBase = await fs.realpath(baseDir);
  probe = full;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!isWithin(real, realBase, path.sep)) throw new Error('Path resolves outside the builds directory');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return { rel, full };
}

async function statOrUndefined(full: string) {
  try { return await fs.stat(full); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** ReadBuildHeader (BuildListHelpers.lua): the <Build> tag in the first 2048 bytes. */
export async function readBuildHeader(full: string): Promise<Pick<BuildListEntry, 'level' | 'className' | 'ascendClassName'>> {
  const handle = await fs.open(full, 'r');
  try {
    const buffer = Buffer.alloc(2048);
    const { bytesRead } = await handle.read(buffer, 0, 2048, 0);
    const header = buffer.subarray(0, bytesRead).toString('utf8');
    const tag = header.match(/<Build\s+[^>]*?>/)?.[0];
    if (!tag) return {};
    const attr = (name: string) => tag.match(new RegExp(`${name}="([^"]+)"`))?.[1];
    const level = Number(attr('level'));
    return { level: Number.isFinite(level) ? level : undefined, className: attr('className'), ascendClassName: attr('ascendClassName') };
  } finally {
    await handle.close();
  }
}

/** ScanFolder (BuildListHelpers.lua): builds and folders below subPath, recursively. */
export async function scanFolder(baseDir: string, subPath = ''): Promise<BuildListEntry[]> {
  const list: BuildListEntry[] = [];
  const scanDir = async (currentSubPath: string) => {
    const dir = path.join(baseDir, currentSubPath);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (isHiddenEntryName(entry.name) || !entry.isFile() || !/\.xml$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stat = await fs.stat(full);
      list.push({
        relPath: currentSubPath + entry.name,
        subPath: currentSubPath,
        fileName: entry.name,
        buildName: entry.name.replace(/\.xml$/i, ''),
        modified: stat.mtimeMs,
        ...(await readBuildHeader(full).catch(() => ({}))),
      });
    }
    for (const entry of entries) {
      if (isHiddenEntryName(entry.name) || !entry.isDirectory()) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      list.push({ relPath: currentSubPath + entry.name, subPath: currentSubPath, folderName: entry.name, modified: stat.mtimeMs });
      await scanDir(`${currentSubPath}${entry.name}/`);
    }
  };
  await scanDir(subPath);
  return list;
}

/** MatchEntry (BuildListHelpers.lua): every term must match; "class:x" matches class, ascendancy or folder. */
function matchEntry(entry: BuildListEntry, terms: string[]): boolean {
  const has = (value: string | undefined, term: string) => value !== undefined && value.toLowerCase().includes(term);
  return terms.every((term) => {
    const lower = term.toLowerCase();
    const classTerm = lower.match(/^class:(.*)$/);
    if (classTerm) {
      const val = classTerm[1];
      return val === '' || has(entry.className, val) || has(entry.ascendClassName, val) || has(entry.folderName, val);
    }
    return has(entry.buildName, lower) || has(entry.folderName, lower) || has(entry.className, lower)
      || has(entry.ascendClassName, lower) || has(entry.subPath, lower);
  });
}

/** FilterList (BuildListHelpers.lua): no filter shows one folder; a filter searches every subfolder. */
export function filterList(index: BuildListEntry[], subPath: string, filterText?: string): BuildListEntry[] {
  const terms = (filterText ?? '').split(/\s+/).filter(Boolean);
  return index.filter((entry) => (terms.length === 0 ? entry.subPath === subPath : matchEntry(entry, terms)));
}

/** naturalSortCompare (Modules/Common.lua), as a sort comparator. */
export function naturalCompare(a: string, b: string): number {
  const less = (x: string, y: string): boolean => {
    let xi = 0, yi = 0;
    for (;;) {
      const xm = /(.*?)(\d+)/s.exec(x.slice(xi));
      const ym = /(.*?)(\d+)/s.exec(y.slice(yi));
      let xs: string, ys: string;
      if (!xm || !ym) { xs = x.slice(xi); ys = y.slice(yi); } else { xs = xm[1]; ys = ym[1]; }
      if (xs.toUpperCase() !== ys.toUpperCase()) return xs.toUpperCase() < ys.toUpperCase();
      if (xs !== ys) return xs < ys;
      if (!xm || !ym) return x < y;
      const xn = Number(xm[2]), yn = Number(ym[2]);
      if (xn !== yn) return xn < yn;
      if (xm[2] !== ym[2]) return xm[2] < ym[2];
      xi += xm[0].length;
      yi += ym[0].length;
    }
  };
  if (a === b) return 0;
  return less(a, b) ? -1 : (less(b, a) ? 1 : 0);
}

/** SortList (BuildListHelpers.lua): folders first, then by the chosen mode. */
export function sortList(list: BuildListEntry[], sortMode: BuildSortMode = 'NAME'): BuildListEntry[] {
  const pathName = (e: BuildListEntry) => (e.subPath ?? '') + (e.folderName ?? e.fileName ?? '');
  return list.sort((a, b) => {
    const aFolder = a.folderName !== undefined, bFolder = b.folderName !== undefined;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    if (sortMode === 'EDITED') {
      if (a.modified !== b.modified) return b.modified - a.modified;
      return naturalCompare(pathName(a), pathName(b));
    }
    if (aFolder) return naturalCompare(pathName(a), pathName(b));
    if (sortMode === 'CLASS') {
      if ((a.className === undefined) !== (b.className === undefined)) return a.className === undefined ? -1 : 1;
      if (a.className !== undefined && a.className !== b.className) return a.className < (b.className as string) ? -1 : 1;
      if ((a.ascendClassName === undefined) !== (b.ascendClassName === undefined)) return a.ascendClassName === undefined ? -1 : 1;
      if (a.ascendClassName !== undefined && a.ascendClassName !== b.ascendClassName) return a.ascendClassName < (b.ascendClassName as string) ? -1 : 1;
    } else if (sortMode === 'LEVEL') {
      if ((a.level === undefined) !== (b.level === undefined)) return a.level === undefined ? -1 : 1;
      if (a.level !== undefined && b.level !== undefined && a.level !== b.level) return a.level - b.level;
    }
    return naturalCompare(pathName(a), pathName(b));
  });
}

/** BuildListControl:GetRowValue's second column: "Level 85 Chieftain". */
function describeEntry(entry: BuildListEntry, currentSubPath: string): string {
  const prefix = entry.subPath !== currentSubPath && entry.subPath.startsWith(currentSubPath) ? entry.subPath.slice(currentSubPath.length) : (entry.subPath !== currentSubPath ? entry.subPath : '');
  if (entry.folderName !== undefined) return `>> ${prefix}${entry.folderName}/`;
  const ascend = entry.ascendClassName && entry.ascendClassName !== 'None' ? entry.ascendClassName : entry.className;
  const edited = new Date(entry.modified).toISOString().slice(0, 16).replace('T', ' ');
  return `${prefix}${entry.buildName}  (Level ${entry.level ?? 1} ${ascend ?? '?'}, edited ${edited})`;
}

const SORT_MODES: BuildSortMode[] = ['NAME', 'CLASS', 'EDITED', 'LEVEL'];

export async function handleListBuildFolder(context: BuildFolderContext, args: { path?: string; filter?: string; sort?: string }) {
  return wrapHandler('list build folder', async () => {
    const sort = (args.sort ?? 'NAME').toUpperCase() as BuildSortMode;
    if (!SORT_MODES.includes(sort)) throw new Error(`sort must be one of ${SORT_MODES.join(', ')}`);
    const { rel, full } = await resolveInBuilds(args.path, context.pobDirectory, { allowRoot: true });
    const stat = await statOrUndefined(full);
    if (!stat?.isDirectory()) throw new Error(`no folder "${rel}" in the builds directory`);
    const subPath = rel === '' ? '' : `${rel}/`;
    const index = await scanFolder(context.pobDirectory, subPath);
    const list = sortList(filterList(index, subPath, args.filter), sort);
    const lines = [`Builds in ${rel === '' ? 'the builds directory' : `"${rel}"`}${args.filter ? `, matching "${args.filter}" in all subfolders` : ''} (sorted by ${sort.toLowerCase()}):`];
    if (list.length === 0) lines.push('  (empty)');
    for (const entry of list) lines.push(`  ${describeEntry(entry, subPath)}`);
    const folders = list.filter((e) => e.folderName !== undefined).length;
    lines.push('', `${list.length - folders} builds, ${folders} folders. Paths for the other build folder tools are relative to the builds directory, e.g. "${list.find((e) => e.fileName)?.relPath ?? 'Folder/Build.xml'}".`);
    return { content: [{ type: "text" as const, text: lines.join('\n') }] };
  });
}

/** main:OpenNewFolderPopup's Create: MakeDir(path..name). */
export async function handleCreateBuildFolder(context: BuildFolderContext, args: { name: string; path?: string }) {
  return wrapHandler('create build folder', async () => {
    const name = validateEntryName(args.name, 'name');
    const parent = await resolveInBuilds(args.path, context.pobDirectory, { allowRoot: true });
    if (!(await statOrUndefined(parent.full))?.isDirectory()) throw new Error(`no folder "${parent.rel}" in the builds directory`);
    const target = await resolveInBuilds(parent.rel === '' ? name : `${parent.rel}/${name}`, context.pobDirectory);
    if (await lstatOrUndefined(target.full)) throw new Error(`"${target.rel}" already exists`);
    await fs.mkdir(target.full);
    return { content: [{ type: "text" as const, text: `Created folder "${target.rel}".` }] };
  });
}

interface ResolvedEntry { rel: string; full: string; isFolder: boolean; parentRel: string; baseName: string }

/**
 * The build or folder a path names. "RF" may be the build RF.xml or the
 * folder RF; when both exist it is refused as ambiguous, so a delete never
 * takes a whole folder for a build. "RF.xml" names the build, "RF/" the folder.
 */
async function resolveEntry(context: BuildFolderContext, relPath: string | undefined): Promise<ResolvedEntry> {
  if (typeof relPath !== 'string' || toRel(relPath) === '') throw new Error('path is required');
  const wantFolder = /[\\/]\s*$/.test(relPath);
  let resolved = await resolveInBuilds(relPath, context.pobDirectory);
  let stat = await statOrUndefined(resolved.full);
  if (wantFolder) {
    if (!stat?.isDirectory()) throw new Error(`no folder "${resolved.rel}" in the builds directory`);
  } else if (!/\.xml$/i.test(resolved.rel)) {
    // Build names are routinely given without .xml, as list_builds and the other tools accept.
    const asBuild = await resolveInBuilds(`${resolved.rel}.xml`, context.pobDirectory);
    const buildStat = await statOrUndefined(asBuild.full);
    if (stat?.isDirectory() && buildStat?.isFile()) {
      throw new Error(`"${resolved.rel}" names both the folder "${resolved.rel}/" and the build "${asBuild.rel}"; pass "${asBuild.rel}" for the build or "${resolved.rel}/" for the folder`);
    }
    if (!stat && buildStat) { resolved = asBuild; stat = buildStat; }
  }
  if (!stat) throw new Error(`no build or folder "${toRel(relPath)}" in the builds directory`);
  const isFolder = stat.isDirectory();
  if (!isFolder && !(stat.isFile() && /\.xml$/i.test(resolved.rel))) throw new Error(`"${resolved.rel}" is not a build (.xml) or a folder`);
  const slash = resolved.rel.lastIndexOf('/');
  return { ...resolved, isFolder, parentRel: slash < 0 ? '' : resolved.rel.slice(0, slash), baseName: slash < 0 ? resolved.rel : resolved.rel.slice(slash + 1) };
}

/**
 * Refuse to rename, move or delete the build that is open, or a folder
 * holding it: a later save would write to the old name (and could replace a
 * file now there), and PoB itself only offers these with no build open.
 */
async function refuseOpenBuild(context: BuildFolderContext, entry: ResolvedEntry, verb: string) {
  const open = context.openBuildFiles ? await context.openBuildFiles() : [];
  const hit = open.find((file) => (entry.isFolder ? isWithin(file, entry.full, path.sep) : samePath(file, entry.full)));
  if (hit) {
    const what = entry.isFolder ? `folder "${entry.rel}" holds the build that is open (${path.basename(hit)})` : `build "${entry.rel}" is the one that is open`;
    throw new Error(`Cannot ${verb}: the ${what} in the Lua engine or the Path of Building window. Load or open another build first (PoB's build list also works only with no build open).`);
  }
}

const join = (folder: string, name: string) => (folder === '' ? name : `${folder}/${name}`);

/** Every build file below a folder (or the file itself), for reports. */
async function buildFilesIn(entry: ResolvedEntry): Promise<string[]> {
  if (!entry.isFolder) return [entry.rel];
  const found: string[] = [];
  const walk = async (rel: string, full: string) => {
    for (const child of await fs.readdir(full, { withFileTypes: true })) {
      if (isHiddenEntryName(child.name)) continue;
      if (child.isDirectory()) await walk(`${rel}/${child.name}`, path.join(full, child.name));
      else if (/\.xml$/i.test(child.name)) found.push(`${rel}/${child.name}`);
    }
  };
  await walk(entry.rel, entry.full);
  return found;
}

function invalidate(context: BuildFolderContext, entry: ResolvedEntry) {
  context.buildService?.invalidatePathsUnder(entry.full);
}

/** A new build name as the rename dialog takes it: without .xml, which it adds. */
function newBuildFileName(newName: unknown): string {
  const name = validateEntryName(typeof newName === 'string' ? newName.replace(/\.xml$/i, '') : newName, 'new_name');
  return `${name}.xml`;
}

/** listMode:GetDestName (BuildList.lua): "name.xml", else "name[2].xml", "name[3].xml", ... */
export async function freeDestName(folderFull: string, fileName: string): Promise<string> {
  let destName = fileName;
  for (let i = 2; await lstatOrUndefined(path.join(folderFull, destName)); i++) {
    destName = `${fileName.replace(/\.xml$/i, '')}[${i}].xml`;
  }
  return destName;
}

/** CanMoveToSubPath (BuildListHelpers.lua): a folder not into itself or below itself. */
function checkCanMoveTo(entry: ResolvedEntry, targetRel: string, verb: string) {
  if (entry.isFolder && isWithin(targetRel, entry.rel)) {
    throw new Error(`A folder cannot be ${verb} into itself.`);
  }
}

/** BuildListControl:RenameBuild (Rename button / F2): a new name in the same folder. */
export async function handleRenameBuild(context: BuildFolderContext, args: { path: string; newName: string }) {
  return wrapHandler('rename build', async () => {
    const entry = await resolveEntry(context, args.path);
    const newBase = entry.isFolder ? validateEntryName(args.newName, 'new_name') : newBuildFileName(args.newName);
    if (newBase === entry.baseName) throw new Error('the new name is the same as the current one');
    await refuseOpenBuild(context, entry, 'rename it');
    const target = await resolveInBuilds(join(entry.parentRel, newBase), context.pobDirectory);
    const caseOnly = newBase.toLowerCase() === entry.baseName.toLowerCase();
    // The dialog's Save stays disabled while another file has the name. A
    // change of case only is allowed, unless a different entry carries that
    // exact name (possible where names are case-sensitive).
    const siblings = await fs.readdir(path.dirname(entry.full));
    if (caseOnly ? siblings.includes(newBase) : await lstatOrUndefined(target.full)) {
      throw new Error(`"${target.rel}" already exists`);
    }
    await fs.rename(entry.full, target.full);
    invalidate(context, entry);
    return { content: [{ type: "text" as const, text: `Renamed ${entry.isFolder ? 'folder' : 'build'} "${entry.rel}" to "${target.rel}".` }] };
  });
}

/**
 * Cut and paste, or a drag onto a folder (BuildList.lua OnFrame, BuildListControl
 * ReceiveDrag): a build keeps its file name, or gets the first free "[n]"
 * name; a folder moves with its contents (main:MoveFolder).
 */
export async function handleMoveBuild(context: BuildFolderContext, args: { path: string; toFolder?: string }) {
  return wrapHandler('move build', async () => {
    const entry = await resolveEntry(context, args.path);
    const target = await resolveInBuilds(args.toFolder, context.pobDirectory, { allowRoot: true });
    if (!(await statOrUndefined(target.full))?.isDirectory()) throw new Error(`no folder "${target.rel}" in the builds directory`);
    if (samePath(target.rel, entry.parentRel)) throw new Error(`"${entry.rel}" is already in ${target.rel === '' ? 'the builds directory' : `"${target.rel}"`}`);
    checkCanMoveTo(entry, target.rel, 'moved');
    await refuseOpenBuild(context, entry, 'move it');
    let destBase = entry.baseName;
    if (entry.isFolder) {
      // main:MoveFolder would merge into an existing folder; refuse instead.
      if (await lstatOrUndefined(path.join(target.full, destBase))) throw new Error(`"${join(target.rel, destBase)}" already exists`);
    } else {
      destBase = await freeDestName(target.full, entry.baseName);
    }
    const dest = await resolveInBuilds(join(target.rel, destBase), context.pobDirectory);
    await fs.rename(entry.full, dest.full);
    invalidate(context, entry);
    return { content: [{ type: "text" as const, text: `Moved ${entry.isFolder ? 'folder' : 'build'} "${entry.rel}" to "${dest.rel}".` }] };
  });
}

/**
 * The Copy button (RenameBuild with copyOnName: a new name in the same
 * folder), or copy and paste into another folder (a build keeps its name or
 * gets the first free "[n]" name; a folder is copied whole, main:CopyFolder).
 */
export async function handleCopyBuild(context: BuildFolderContext, args: { path: string; newName?: string; toFolder?: string }) {
  return wrapHandler('copy build', async () => {
    const entry = await resolveEntry(context, args.path);
    const target = await resolveInBuilds(args.toFolder ?? entry.parentRel, context.pobDirectory, { allowRoot: true });
    if (!(await statOrUndefined(target.full))?.isDirectory()) throw new Error(`no folder "${target.rel}" in the builds directory`);
    const sameFolder = samePath(target.rel, entry.parentRel);
    checkCanMoveTo(entry, target.rel, 'copied');
    let destBase: string;
    if (args.newName !== undefined && args.newName !== '') {
      destBase = entry.isFolder ? validateEntryName(args.newName, 'new_name') : newBuildFileName(args.newName);
      if (await lstatOrUndefined(path.join(target.full, destBase))) throw new Error(`"${join(target.rel, destBase)}" already exists`);
    } else if (sameFolder) {
      throw new Error('new_name is required to copy within the same folder');
    } else if (entry.isFolder) {
      destBase = entry.baseName;
      if (await lstatOrUndefined(path.join(target.full, destBase))) throw new Error(`"${join(target.rel, destBase)}" already exists`);
    } else {
      destBase = await freeDestName(target.full, entry.baseName);
    }
    const dest = await resolveInBuilds(join(target.rel, destBase), context.pobDirectory);
    if (entry.isFolder) {
      // Create the folder first (fails if it appeared meanwhile), so a failed
      // copy can remove exactly what it made and nothing that was there.
      await fs.mkdir(dest.full);
      try {
        await fs.cp(entry.full, dest.full, { recursive: true, errorOnExist: true, force: false });
      } catch (error) {
        await fs.rm(dest.full, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(`copying the folder failed, and the partial copy "${dest.rel}" was removed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      await fs.copyFile(entry.full, dest.full, fsConstants.COPYFILE_EXCL);
    }
    return { content: [{ type: "text" as const, text: `Copied ${entry.isFolder ? 'folder' : 'build'} "${entry.rel}" to "${dest.rel}".` }] };
  });
}

/**
 * BuildListControl:DeleteBuild: a build is removed (os.remove), an empty
 * folder removed, a non-empty one removed with everything in it
 * (RemoveDir(path, true)). PoB asks first for builds and non-empty folders;
 * here every delete needs confirm: true, and it cannot be undone.
 */
export async function handleDeleteBuild(context: BuildFolderContext, args: { path: string; confirm?: boolean }) {
  return wrapHandler('delete build', async () => {
    const entry = await resolveEntry(context, args.path);
    await refuseOpenBuild(context, entry, 'delete it');
    const files = await buildFilesIn(entry);
    const contents = entry.isFolder ? await fs.readdir(entry.full) : [];
    const what = entry.isFolder
      ? `folder "${entry.rel}"${contents.length > 0 ? ` and everything in it (${files.length} builds, ${contents.length} entries at its top level)` : ' (empty)'}`
      : `build "${entry.rel}"`;
    if (args.confirm !== true) {
      return { content: [{ type: "text" as const, text: `Not deleted. This would permanently delete the ${what}; it cannot be undone. Call again with confirm: true to delete it.` }] };
    }
    if (!entry.isFolder) await fs.unlink(entry.full);
    else if (contents.length === 0) await fs.rmdir(entry.full);
    else await fs.rm(entry.full, { recursive: true, force: false });
    invalidate(context, entry);
    return { content: [{ type: "text" as const, text: `Deleted the ${what}.` }] };
  });
}
