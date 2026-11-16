import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import { wrapHandler } from "../utils/errorHandling.js";
import { sanitizeBuildName } from "../utils/pathSanitizer.js";

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
 * follows PoB's, with two deliberate differences: nothing is ever
 * overwritten (PoB's rename and copy dialogs refuse an existing name too, but
 * its folder moves would merge), and deleting needs confirm: true.
 */

export interface BuildFolderContext {
  pobDirectory: string;
  buildService?: { invalidateBuild(buildName: string): void };
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

// The characters the rename, copy and new folder dialogs filter out of a
// name: EditControl filter "\\/:%*%?\"<>|%c".
const FORBIDDEN_NAME = /[\\/:*?"<>|\x00-\x1f\x7f]/;

/** A file or folder name for the builds directory, checked as PoB's dialogs check it. */
export function validateEntryName(name: unknown, what: string): string {
  if (typeof name !== 'string' || !/\S/.test(name)) throw new Error(`${what} must be a non-empty name`);
  if (FORBIDDEN_NAME.test(name)) throw new Error(`${what} may not contain \\ / : * ? " < > | or control characters`);
  if (name === '.' || name === '..') throw new Error(`${what} may not be "." or ".."`);
  if (name.length > 100) throw new Error(`${what} is longer than 100 characters`);
  return name;
}

function toRel(relPath: string | undefined): string {
  return (relPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/^\.$/, '');
}

/**
 * Resolve a path relative to the builds directory. Rejects anything that
 * leaves it (sanitizeBuildName), and also a path that reaches outside through
 * a link: the nearest existing ancestor must really be inside the directory.
 */
export async function resolveInBuilds(relPath: string | undefined, baseDir: string, opts: { allowRoot?: boolean } = {}): Promise<{ rel: string; full: string }> {
  const rel = toRel(relPath);
  if (rel === '') {
    if (!opts.allowRoot) throw new Error('a path inside the builds directory is required (the builds directory itself cannot be changed)');
    return { rel, full: path.resolve(baseDir) };
  }
  const full = sanitizeBuildName(rel, baseDir);
  const realBase = await fs.realpath(baseDir);
  let probe = full;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new Error('Path resolves outside the builds directory');
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
      if (!entry.isFile() || !/\.xml$/i.test(entry.name)) continue;
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
      if (!entry.isDirectory()) continue;
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
    if (await statOrUndefined(target.full)) throw new Error(`"${target.rel}" already exists`);
    await fs.mkdir(target.full);
    return { content: [{ type: "text" as const, text: `Created folder "${target.rel}".` }] };
  });
}

interface ResolvedEntry { rel: string; full: string; isFolder: boolean; parentRel: string; baseName: string }

async function resolveEntry(context: BuildFolderContext, relPath: string | undefined): Promise<ResolvedEntry> {
  if (typeof relPath !== 'string' || toRel(relPath) === '') throw new Error('path is required');
  let resolved = await resolveInBuilds(relPath, context.pobDirectory);
  let stat = await statOrUndefined(resolved.full);
  // Build names are routinely given without .xml, as list_builds and the other tools accept.
  if (!stat && !/\.xml$/i.test(resolved.rel)) {
    resolved = await resolveInBuilds(`${resolved.rel}.xml`, context.pobDirectory);
    stat = await statOrUndefined(resolved.full);
  }
  if (!stat) throw new Error(`no build or folder "${toRel(relPath)}" in the builds directory`);
  const isFolder = stat.isDirectory();
  if (!isFolder && !(stat.isFile() && /\.xml$/i.test(resolved.rel))) throw new Error(`"${resolved.rel}" is not a build (.xml) or a folder`);
  const slash = resolved.rel.lastIndexOf('/');
  return { ...resolved, isFolder, parentRel: slash < 0 ? '' : resolved.rel.slice(0, slash), baseName: slash < 0 ? resolved.rel : resolved.rel.slice(slash + 1) };
}

const join = (folder: string, name: string) => (folder === '' ? name : `${folder}/${name}`);

/** Every build file below a folder (or the file itself), for cache invalidation and reports. */
async function buildFilesIn(entry: ResolvedEntry): Promise<string[]> {
  if (!entry.isFolder) return [entry.rel];
  const found: string[] = [];
  const walk = async (rel: string, full: string) => {
    for (const child of await fs.readdir(full, { withFileTypes: true })) {
      if (child.isDirectory()) await walk(`${rel}/${child.name}`, path.join(full, child.name));
      else if (/\.xml$/i.test(child.name)) found.push(`${rel}/${child.name}`);
    }
  };
  await walk(entry.rel, entry.full);
  return found;
}

function invalidate(context: BuildFolderContext, rels: string[]) {
  for (const rel of rels) context.buildService?.invalidateBuild(rel);
}

/** A new build name as the rename dialog takes it: without .xml, which it adds. */
function newBuildFileName(newName: unknown): string {
  const name = validateEntryName(typeof newName === 'string' ? newName.replace(/\.xml$/i, '') : newName, 'new_name');
  return `${name}.xml`;
}

/** listMode:GetDestName (BuildList.lua): "name.xml", else "name[2].xml", "name[3].xml", ... */
export async function freeDestName(folderFull: string, fileName: string): Promise<string> {
  let destName = fileName;
  for (let i = 2; await statOrUndefined(path.join(folderFull, destName)); i++) {
    destName = `${fileName.replace(/\.xml$/i, '')}[${i}].xml`;
  }
  return destName;
}

/** CanMoveToSubPath (BuildListHelpers.lua): not where it is, and a folder not into itself. */
function checkCanMoveTo(entry: ResolvedEntry, targetRel: string, verb: string) {
  if (entry.isFolder && (targetRel === entry.rel || targetRel.startsWith(`${entry.rel}/`))) {
    throw new Error(`A folder cannot be ${verb} into itself.`);
  }
}

/** BuildListControl:RenameBuild (Rename button / F2): a new name in the same folder. */
export async function handleRenameBuild(context: BuildFolderContext, args: { path: string; newName: string }) {
  return wrapHandler('rename build', async () => {
    const entry = await resolveEntry(context, args.path);
    const newBase = entry.isFolder ? validateEntryName(args.newName, 'new_name') : newBuildFileName(args.newName);
    const target = await resolveInBuilds(join(entry.parentRel, newBase), context.pobDirectory);
    const caseOnly = newBase.toLowerCase() === entry.baseName.toLowerCase();
    if (newBase === entry.baseName) throw new Error('the new name is the same as the current one');
    // The dialog's Save stays disabled while another file has the name; a
    // change of case only is allowed.
    if (!caseOnly && await statOrUndefined(target.full)) throw new Error(`"${target.rel}" already exists`);
    const before = await buildFilesIn(entry);
    await fs.rename(entry.full, target.full);
    invalidate(context, before);
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
    if (target.rel === entry.parentRel) throw new Error(`"${entry.rel}" is already in ${target.rel === '' ? 'the builds directory' : `"${target.rel}"`}`);
    checkCanMoveTo(entry, target.rel, 'moved');
    let destBase = entry.baseName;
    if (entry.isFolder) {
      // main:MoveFolder would merge into an existing folder; refuse instead.
      if (await statOrUndefined(path.join(target.full, destBase))) throw new Error(`"${join(target.rel, destBase)}" already exists`);
    } else {
      destBase = await freeDestName(target.full, entry.baseName);
    }
    const dest = await resolveInBuilds(join(target.rel, destBase), context.pobDirectory);
    const before = await buildFilesIn(entry);
    await fs.rename(entry.full, dest.full);
    invalidate(context, before);
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
    const sameFolder = target.rel === entry.parentRel;
    checkCanMoveTo(entry, target.rel, 'copied');
    let destBase: string;
    if (args.newName !== undefined && args.newName !== '') {
      destBase = entry.isFolder ? validateEntryName(args.newName, 'new_name') : newBuildFileName(args.newName);
      if (await statOrUndefined(path.join(target.full, destBase))) throw new Error(`"${join(target.rel, destBase)}" already exists`);
    } else if (sameFolder) {
      throw new Error('new_name is required to copy within the same folder');
    } else if (entry.isFolder) {
      destBase = entry.baseName;
      if (await statOrUndefined(path.join(target.full, destBase))) throw new Error(`"${join(target.rel, destBase)}" already exists`);
    } else {
      destBase = await freeDestName(target.full, entry.baseName);
    }
    const dest = await resolveInBuilds(join(target.rel, destBase), context.pobDirectory);
    if (entry.isFolder) {
      await fs.cp(entry.full, dest.full, { recursive: true, errorOnExist: true, force: false });
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
    invalidate(context, files);
    return { content: [{ type: "text" as const, text: `Deleted the ${what}.` }] };
  });
}
