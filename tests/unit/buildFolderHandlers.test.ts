import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  handleListBuildFolder, handleCreateBuildFolder, handleRenameBuild, handleMoveBuild, handleCopyBuild, handleDeleteBuild,
  naturalCompare, sortList, filterList, scanFolder, validateEntryName, resolveInBuilds, type BuildListEntry,
} from '../../src/handlers/buildFolderHandlers.js';
import { textOf } from '../helpers/response.js';

const buildXml = (level: number, className: string, ascend: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding>\n\t<Build level="${level}" targetVersion="3_0" className="${className}" ascendClassName="${ascend}" mainSocketGroup="1">\n\t</Build>\n</PathOfBuilding>`;

describe('build folder tools', () => {
  let root: string;
  let builds: string;
  let invalidated: string[];
  const ctx = () => ({ pobDirectory: builds, buildService: { invalidateBuild: (name: string) => { invalidated.push(name); } } });
  const exists = (rel: string) => fs.stat(path.join(builds, rel)).then(() => true, () => false);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pob-folders-'));
    builds = path.join(root, 'Builds');
    invalidated = [];
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
    expect(invalidated.sort()).toEqual(['Leagues/Old/RF old.xml', 'Leagues/Support.xml']);
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
    await expect(resolveInBuilds('Link/secret.xml', builds)).rejects.toThrow(/outside the builds directory/);
    await expect(handleDeleteBuild(ctx(), { path: 'Link/secret.xml', confirm: true })).rejects.toThrow(/outside/);
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
