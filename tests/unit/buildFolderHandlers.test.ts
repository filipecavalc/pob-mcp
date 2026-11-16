import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  handleListBuildFolder, handleCreateBuildFolder, handleRenameBuild, handleMoveBuild, handleCopyBuild, handleDeleteBuild,
  naturalCompare, sortList, filterList, scanFolder, validateEntryName, resolveInBuilds, type BuildListEntry,
  openBuildFilesOf, withOpenBuilds,
} from '../../src/handlers/buildFolderHandlers.js';
import { PoBGuiApiClient } from '../../src/pobGuiClient.js';
import { BuildService } from '../../src/services/buildService.js';
import { textOf } from '../helpers/response.js';

const buildXml = (level: number, className: string, ascend: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding>\n\t<Build level="${level}" targetVersion="3_0" className="${className}" ascendClassName="${ascend}" mainSocketGroup="1">\n\t</Build>\n</PathOfBuilding>`;

describe('build folder tools', () => {
  let root: string;
  let builds: string;
  let invalidated: string[];
  let openFiles: string[];
  const ctx = () => ({ pobDirectory: builds, openBuildFiles: async () => openFiles,
    buildService: { invalidatePathsUnder: (p: string) => { invalidated.push(path.relative(builds, p).split(path.sep).join('/')); } } });
  const exists = (rel: string) => fs.stat(path.join(builds, rel)).then(() => true, () => false);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pob-folders-'));
    builds = path.join(root, 'Builds');
    invalidated = [];
    openFiles = [];
    await fs.mkdir(path.join(builds, 'Leagues', 'Old'), { recursive: true });
    await fs.writeFile(path.join(builds, 'RF atual.xml'), buildXml(84, 'Marauder', 'Chieftain'));
    await fs.writeFile(path.join(builds, 'Leagues', 'Support.xml'), buildXml(90, 'Templar', 'None'));
    await fs.writeFile(path.join(builds, 'Leagues', 'Old', 'RF old.xml'), buildXml(70, 'Marauder', 'Chieftain'));
    await fs.writeFile(path.join(root, 'outside.xml'), buildXml(1, 'Witch', 'None'));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('lists one folder as the build list does, folders first, with level and class', async () => {
    const text = textOf(await handleListBuildFolder(ctx(), {}));
    expect(text.indexOf('>> Leagues/')).toBeLessThan(text.indexOf('RF atual'));
    expect(text).toContain('RF atual  (Level 84 Chieftain');
    expect(text).not.toContain('Support');
    const leagues = textOf(await handleListBuildFolder(ctx(), { path: 'Leagues' }));
    expect(leagues).toContain('Support  (Level 90 Templar');
  });

  it('searches every subfolder with a filter, class: matching class or ascendancy', async () => {
    const text = textOf(await handleListBuildFolder(ctx(), { filter: 'class:chieftain' }));
    expect(text).toContain('Leagues/Old/RF old');
    expect(text).toContain('RF atual');
    expect(text).not.toContain('Support');
  });

  it('creates a folder and refuses a taken or invalid name', async () => {
    await handleCreateBuildFolder(ctx(), { name: 'Party', path: 'Leagues' });
    expect(await exists('Leagues/Party')).toBe(true);
    await expect(handleCreateBuildFolder(ctx(), { name: 'Party', path: 'Leagues' })).rejects.toThrow(/already exists/);
    await expect(handleCreateBuildFolder(ctx(), { name: 'a:b' })).rejects.toThrow(/may not contain/);
    await expect(handleCreateBuildFolder(ctx(), { name: 'x', path: '..' })).rejects.toThrow(/traversal/);
  });

  it('renames a build without overwriting, allowing a change of case', async () => {
    await handleRenameBuild(ctx(), { path: 'RF atual', newName: 'RF main' });
    expect(await exists('RF main.xml')).toBe(true);
    expect(invalidated).toEqual(['RF atual.xml']);
    await fs.writeFile(path.join(builds, 'Other.xml'), buildXml(1, 'Witch', 'None'));
    await expect(handleRenameBuild(ctx(), { path: 'RF main', newName: 'Other' })).rejects.toThrow(/already exists/);
    await handleRenameBuild(ctx(), { path: 'RF main.xml', newName: 'rf MAIN.xml' });
    expect((await fs.readdir(builds)).sort()).toContain('rf MAIN.xml');
  });

  it('moves a build with PoB\'s [n] name when the name is taken, and never a folder into itself', async () => {
    await fs.writeFile(path.join(builds, 'Leagues', 'RF atual.xml'), 'other');
    const text = textOf(await handleMoveBuild(ctx(), { path: 'RF atual', toFolder: 'Leagues' }));
    expect(text).toContain('"Leagues/RF atual[2].xml"');
    expect(await fs.readFile(path.join(builds, 'Leagues', 'RF atual.xml'), 'utf8')).toBe('other');
    await expect(handleMoveBuild(ctx(), { path: 'Leagues', toFolder: 'Leagues/Old' })).rejects.toThrow(/cannot be moved into itself/);
    await expect(handleMoveBuild(ctx(), { path: 'Leagues/Old', toFolder: 'Leagues' })).rejects.toThrow(/already in/);
    await handleMoveBuild(ctx(), { path: 'Leagues/Old', toFolder: '' });
    expect(await exists('Old/RF old.xml')).toBe(true);
  });

  it('copies within a folder only under a new name, and into another folder with the [n] name', async () => {
    await expect(handleCopyBuild(ctx(), { path: 'RF atual' })).rejects.toThrow(/new_name is required/);
    await handleCopyBuild(ctx(), { path: 'RF atual', newName: 'RF copy' });
    await expect(handleCopyBuild(ctx(), { path: 'RF atual', newName: 'RF copy' })).rejects.toThrow(/already exists/);
    await handleCopyBuild(ctx(), { path: 'RF atual', toFolder: 'Leagues' });
    await handleCopyBuild(ctx(), { path: 'RF atual', toFolder: 'Leagues' });
    expect(await exists('Leagues/RF atual.xml')).toBe(true);
    expect(await exists('Leagues/RF atual[2].xml')).toBe(true);
    await handleCopyBuild(ctx(), { path: 'Leagues', newName: 'Leagues copy' });
    expect(await exists('Leagues copy/Old/RF old.xml')).toBe(true);
    await expect(handleCopyBuild(ctx(), { path: 'Leagues', toFolder: 'Leagues/Old' })).rejects.toThrow(/cannot be copied into itself/);
  });

  it('deletes only with confirm: true, and a whole folder with it', async () => {
    const dry = textOf(await handleDeleteBuild(ctx(), { path: 'Leagues' }));
    expect(dry).toContain('Not deleted');
    expect(dry).toContain('2 builds');
    expect(await exists('Leagues/Old/RF old.xml')).toBe(true);
    await handleDeleteBuild(ctx(), { path: 'Leagues', confirm: true });
    expect(await exists('Leagues')).toBe(false);
    expect(invalidated).toEqual(['Leagues']);
    await handleDeleteBuild(ctx(), { path: 'RF atual', confirm: true });
    expect(await exists('RF atual.xml')).toBe(false);
  });

  it('never reaches outside the builds directory', async () => {
    await expect(handleDeleteBuild(ctx(), { path: '../outside.xml', confirm: true })).rejects.toThrow(/traversal/);
    await expect(handleDeleteBuild(ctx(), { path: '..\\outside.xml', confirm: true })).rejects.toThrow(/traversal/);
    await expect(handleDeleteBuild(ctx(), { path: path.join(root, 'outside.xml'), confirm: true })).rejects.toThrow(/relative/);
    await expect(handleDeleteBuild(ctx(), { path: '', confirm: true })).rejects.toThrow(/path is required/);
    await expect(handleMoveBuild(ctx(), { path: 'RF atual', toFolder: '..' })).rejects.toThrow(/traversal/);
    await expect(handleCopyBuild(ctx(), { path: 'RF atual', newName: '../escaped' })).rejects.toThrow(/may not contain/);
    expect(await fs.readFile(path.join(root, 'outside.xml'), 'utf8')).toContain('Witch');
  });

  it('refuses a path that leaves through a link', async () => {
    const outsideDir = path.join(root, 'elsewhere');
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'secret.xml'), 'x');
    try {
      await fs.symlink(outsideDir, path.join(builds, 'Link'), 'junction');
    } catch {
      return; // links not creatable here; the lexical checks above still apply
    }
    await expect(resolveInBuilds('Link/secret.xml', builds)).rejects.toThrow(/is a link/);
    await expect(handleDeleteBuild(ctx(), { path: 'Link/secret.xml', confirm: true })).rejects.toThrow(/is a link/);
    expect(await fs.readFile(path.join(outsideDir, 'secret.xml'), 'utf8')).toBe('x');
  });
});

describe('PoB build list helpers', () => {
  it('naturalCompare orders numbers by value, and text as PoB does', () => {
    expect(['b10', 'b2', 'A', 'b1'].sort(naturalCompare)).toEqual(['A', 'b1', 'b2', 'b10']);
    // naturalSortCompare compares the text before a number case-blind, then case-sensitively.
    expect(['b1', 'B2'].sort(naturalCompare)).toEqual(['B2', 'b1']);
  });

  it('sortList puts folders first and sorts builds by level', () => {
    const e = (o: Partial<BuildListEntry>): BuildListEntry => ({ relPath: '', subPath: '', modified: 0, ...o });
    const list = [e({ fileName: 'b.xml', level: 90 }), e({ folderName: 'z' }), e({ fileName: 'a.xml', level: 10 }), e({ fileName: 'c.xml' })];
    expect(sortList(list, 'LEVEL').map((x) => x.folderName ?? x.fileName)).toEqual(['z', 'c.xml', 'a.xml', 'b.xml']);
  });

  it('filterList without terms keeps one folder; with terms all must match', () => {
    const e = (o: Partial<BuildListEntry>): BuildListEntry => ({ relPath: '', subPath: '', modified: 0, ...o });
    const index = [e({ buildName: 'RF', className: 'Marauder' }), e({ buildName: 'RF old', subPath: 'Old/', className: 'Marauder' })];
    expect(filterList(index, '')).toHaveLength(1);
    expect(filterList(index, '', 'rf old')).toHaveLength(1);
    expect(filterList(index, '', 'class:marauder')).toHaveLength(2);
  });

  it('validateEntryName applies the dialogs\' character filter', () => {
    expect(validateEntryName('My build [2]', 'name')).toBe('My build [2]');
    for (const bad of ['', '   ', 'a/b', 'a\\b', 'a?b', '..']) expect(() => validateEntryName(bad, 'name')).toThrow();
  });

  it('scanFolder reads the class from the build header', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pob-scan-'));
    try {
      await fs.writeFile(path.join(dir, 'X.xml'), buildXml(55, 'Witch', 'Necromancer'));
      const [entry] = await scanFolder(dir);
      expect(entry).toMatchObject({ buildName: 'X', level: 55, className: 'Witch', ascendClassName: 'Necromancer', subPath: '' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('build folder tools: review fixes', () => {
  let root: string;
  let builds: string;
  let openFiles: string[];
  const ctx = () => ({ pobDirectory: builds, openBuildFiles: async () => openFiles });
  const exists = (rel: string) => fs.stat(path.join(builds, rel)).then(() => true, () => false);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pob-folders2-'));
    builds = path.join(root, 'Builds');
    openFiles = [];
    await fs.mkdir(path.join(builds, 'Leagues', 'Old'), { recursive: true });
    await fs.writeFile(path.join(builds, 'RF atual.xml'), buildXml(84, 'Marauder', 'Chieftain'));
    await fs.writeFile(path.join(builds, 'Leagues', 'Support.xml'), buildXml(90, 'Templar', 'None'));
    await fs.writeFile(path.join(builds, 'Leagues', 'Old', 'RF old.xml'), buildXml(70, 'Marauder', 'Chieftain'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('the open build', () => {
    it('refuses to rename, move or delete the loaded build, or a folder holding it, but lets it be copied', async () => {
      openFiles = [path.join(builds, 'Leagues', 'Old', 'RF old.xml')];
      await expect(handleRenameBuild(ctx(), { path: 'Leagues/Old/RF old', newName: 'RF older' })).rejects.toThrow(/is the one that is open.*Load or open another build first/s);
      await expect(handleMoveBuild(ctx(), { path: 'Leagues/Old/RF old.xml', toFolder: '' })).rejects.toThrow(/open/);
      await expect(handleDeleteBuild(ctx(), { path: 'Leagues/Old/RF old', confirm: true })).rejects.toThrow(/open/);
      await expect(handleDeleteBuild(ctx(), { path: 'Leagues', confirm: true })).rejects.toThrow(/folder "Leagues" holds the build that is open/);
      await expect(handleRenameBuild(ctx(), { path: 'Leagues/Old', newName: 'Older' })).rejects.toThrow(/holds the build that is open/);
      expect(await exists('Leagues/Old/RF old.xml')).toBe(true);
      await handleCopyBuild(ctx(), { path: 'Leagues/Old/RF old', newName: 'RF copy' });
      expect(await exists('Leagues/Old/RF copy.xml')).toBe(true);
      await handleRenameBuild(ctx(), { path: 'RF atual', newName: 'RF other' });
    });

    it('compares the open file case-insensitively on Windows', async () => {
      if (process.platform !== 'win32') return;
      openFiles = [path.join(builds, 'rf ATUAL.xml')];
      await expect(handleDeleteBuild(ctx(), { path: 'RF atual', confirm: true })).rejects.toThrow(/open/);
    });

    it('reads the open build from the headless client, or from the window when the tools run on it', async () => {
      expect(await openBuildFilesOf(() => null)).toEqual([]);
      const dead = { isAlive: () => false, getLoadedFilePath: () => 'x.xml' };
      expect(await openBuildFilesOf(() => dead as never)).toEqual([]);
      const headless = { isAlive: () => true, getLoadedFilePath: () => path.join(builds, 'RF atual.xml') };
      expect(await openBuildFilesOf(() => headless as never)).toEqual([path.join(builds, 'RF atual.xml')]);
      const gui = Object.assign(Object.create(PoBGuiApiClient.prototype), {
        isAlive: () => true, guiStatus: async () => ({ build: { file: path.join(builds, 'Leagues', 'Support.xml') } }),
      });
      expect(await openBuildFilesOf(() => gui)).toEqual([path.join(builds, 'Leagues', 'Support.xml')]);
      const unreachable = Object.assign(Object.create(PoBGuiApiClient.prototype), {
        isAlive: () => true, guiStatus: async () => { throw new Error('timed out'); },
      });
      await expect(openBuildFilesOf(() => unreachable)).rejects.toThrow(/cannot tell which build is open/);
      const wrapped = withOpenBuilds({ pobDirectory: builds }, () => headless as never);
      await expect(handleMoveBuild(wrapped, { path: 'RF atual', toFolder: 'Leagues' })).rejects.toThrow(/open/);
    });
  });

  it('refuses a name that is both a folder and a build, and takes "X.xml" or "X/"', async () => {
    await fs.mkdir(path.join(builds, 'RF atual'));
    await fs.writeFile(path.join(builds, 'RF atual', 'inner.xml'), 'x');
    for (const call of [
      () => handleDeleteBuild(ctx(), { path: 'RF atual', confirm: true }),
      () => handleMoveBuild(ctx(), { path: 'RF atual', toFolder: 'Leagues' }),
      () => handleRenameBuild(ctx(), { path: 'RF atual', newName: 'Other' }),
    ]) await expect(call()).rejects.toThrow(/names both the folder "RF atual\/" and the build "RF atual.xml"/);
    expect(textOf(await handleDeleteBuild(ctx(), { path: 'RF atual/' }))).toContain('folder "RF atual" and everything in it');
    expect(textOf(await handleDeleteBuild(ctx(), { path: 'RF atual.xml' }))).toContain('build "RF atual.xml"');
    await expect(handleDeleteBuild(ctx(), { path: 'Leagues/Support/' })).rejects.toThrow(/no folder/);
    expect(await exists('RF atual/inner.xml')).toBe(true);
  });

  it('removes a partial folder copy when copying fails', async () => {
    const spy = jest.spyOn(fs, 'cp').mockImplementation(async (_src, dest) => {
      await fs.writeFile(path.join(String(dest), 'half.xml'), 'partial');
      throw new Error('disk full');
    });
    await expect(handleCopyBuild(ctx(), { path: 'Leagues', newName: 'Leagues copy' })).rejects.toThrow(/partial copy "Leagues copy" was removed: disk full/);
    expect(spy).toHaveBeenCalled();
    expect(await exists('Leagues copy')).toBe(false);
    expect(await exists('Leagues/Support.xml')).toBe(true);
  });

  it('rejects Windows reserved names and names ending in a dot or a space', async () => {
    for (const bad of ['CON', 'con', 'Nul.txt', 'COM1', 'lpt9.xml', 'aux.', 'name.', 'name ']) {
      expect(() => validateEntryName(bad, 'name')).toThrow();
    }
    expect(validateEntryName('Console', 'name')).toBe('Console');
    expect(validateEntryName('COM10', 'name')).toBe('COM10');
    await expect(handleCreateBuildFolder(ctx(), { name: 'PRN' })).rejects.toThrow(/reserves/);
    await expect(handleRenameBuild(ctx(), { path: 'RF atual', newName: 'NUL' })).rejects.toThrow(/reserves/);
    await expect(handleRenameBuild(ctx(), { path: 'RF atual', newName: 'CON.xml' })).rejects.toThrow(/reserves/);
    await expect(handleCopyBuild(ctx(), { path: 'RF atual', newName: 'trailing.' })).rejects.toThrow(/dot or a space/);
    await expect(handleRenameBuild(ctx(), { path: 'Leagues', newName: 'LPT1' })).rejects.toThrow(/reserves/);
  });

  describe('case', () => {
    it('treats a folder named in another case as the same folder on Windows', async () => {
      if (process.platform !== 'win32') return;
      await expect(handleMoveBuild(ctx(), { path: 'Leagues/Support', toFolder: 'leagues' })).rejects.toThrow(/already in/);
      await expect(handleMoveBuild(ctx(), { path: 'Leagues', toFolder: 'LEAGUES/old' })).rejects.toThrow(/cannot be moved into itself/);
      await expect(handleCopyBuild(ctx(), { path: 'Leagues', toFolder: 'leagues/OLD' })).rejects.toThrow(/cannot be copied into itself/);
      await expect(handleCopyBuild(ctx(), { path: 'Leagues/Support', toFolder: 'LEAGUES' })).rejects.toThrow(/new_name is required/);
    });

    it('refuses a case-only rename onto a different entry that has that exact name', async () => {
      const realReaddir = fs.readdir;
      jest.spyOn(fs, 'readdir').mockImplementation((async (dir: string, opts?: unknown) => {
        const list = await (realReaddir as (d: string, o?: unknown) => Promise<unknown[]>)(dir, opts);
        return path.resolve(dir) === path.resolve(builds) && !opts ? [...list, 'rf ATUAL.xml'] : list;
      }) as never);
      await expect(handleRenameBuild(ctx(), { path: 'RF atual', newName: 'rf ATUAL' })).rejects.toThrow(/already exists/);
      expect(await exists('RF atual.xml')).toBe(true);
    });

    it('drops cached builds below a path in any case', () => {
      const service = new BuildService(builds) as unknown as { buildCache: Map<string, unknown>; invalidatePathsUnder(p: string): void };
      const cased = process.platform === 'win32' ? path.join(builds, 'LEAGUES', 'support.xml') : path.join(builds, 'Leagues', 'Support.xml');
      service.buildCache.set(cased, {});
      service.buildCache.set(path.join(builds, 'LeaguesX.xml'), {});
      service.invalidatePathsUnder(path.join(builds, 'Leagues'));
      expect([...service.buildCache.keys()]).toEqual([path.join(builds, 'LeaguesX.xml')]);
    });
  });

  it('refuses to act on a link, even one pointing inside the builds directory', async () => {
    try {
      await fs.symlink(path.join(builds, 'Leagues'), path.join(builds, 'Shortcut'), 'junction');
    } catch {
      return;
    }
    await expect(handleDeleteBuild(ctx(), { path: 'Shortcut', confirm: true })).rejects.toThrow(/"Shortcut" is a link/);
    await expect(handleMoveBuild(ctx(), { path: 'RF atual', toFolder: 'Shortcut' })).rejects.toThrow(/is a link/);
    await expect(handleCopyBuild(ctx(), { path: 'Shortcut/Support' })).rejects.toThrow(/is a link/);
    expect(textOf(await handleListBuildFolder(ctx(), {}))).not.toContain('Shortcut');
    expect(await exists('Leagues/Support.xml')).toBe(true);
  });
});
