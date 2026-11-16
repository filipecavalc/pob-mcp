import { describe, it, expect, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import {
  handleRankGemsByDps, handleCreateSkillSet, handleDeleteSkillSet, handleSelectSkillSet, handleRenameSkillSet,
  handleCreateConfigSet, handleDeleteConfigSet, handleListConfigSets, handleListSpectres, handleSetSpectres,
  handleGetMinionOptions, handleSetMinion, handleGetCustomMods, handleSetCustomMods, formatGemRanking,
} from '../../src/handlers/skillsConfigHandlers.js';
import { handleGetConfig } from '../../src/handlers/configHandlers.js';
import { getLuaToolSchemas } from '../../src/server/toolSchemas.js';
import { routeToolCall } from '../../src/server/toolRouter.js';
import type { CustomModsState, GemDpsRanking, MinionOptions, SkillSetList } from '../../src/pobLuaBridge.js';
import { textOf } from '../helpers/response.js';

const ctx = (api: Record<string, unknown>) => ({
  ensureLuaClient: async () => {},
  getLuaClient: () => api as never,
});

const stats = (dps: number) => async () => ({ CombinedDPS: dps, Life: 5000 });

const ranking = (over: Partial<GemDpsRanking> = {}): GemDpsRanking => ({
  groupIndex: 1, groupLabel: 'Righteous Fire', activeSkills: ['Righteous Fire'], mainSocketGroup: 1, gemIndex: 7,
  dpsField: 'CombinedDPS', gemType: 'support', search: '', defaultGemLevel: 'normalMaximum', defaultGemQuality: 0,
  baseDPS: 80043, evaluatedCount: 32, listedCount: 225,
  candidates: [
    { position: 1, name: 'Concentrated Effect', gemId: 'x', support: true, canSupport: true, evaluated: true, level: 20, dps: 111119, delta: 31076, percent: 38.8 },
    { position: 2, name: 'Inspiration', gemId: 'y', support: true, canSupport: true, evaluated: true, level: 20, dps: 72198, delta: -7845, percent: -9.8 },
  ],
  ...over,
});

const skillSets: SkillSetList = {
  activeSkillSetId: 1,
  skillSets: [{ index: 1, id: 1, title: 'Default', active: true, socketGroups: 7 }, { index: 2, id: 2, title: 'Maps', active: false, socketGroups: 7 }],
};

describe('rank_gems_by_dps', () => {
  it('passes the slot and options to PoB and lists the candidates with their DPS change', async () => {
    const rankGemsByDps = jest.fn(async () => ranking());
    const text = textOf(await handleRankGemsByDps(ctx({ rankGemsByDps }), { group_index: 1, gem_index: 7, dps_field: 'CombinedDPS', limit: 5 }));
    expect(rankGemsByDps).toHaveBeenCalledWith(expect.objectContaining({ groupIndex: 1, gemIndex: 7, dpsField: 'CombinedDPS', limit: 5 }));
    expect(text).toContain('Concentrated Effect (lvl 20)');
    expect(text).toContain('+38.8%');
    expect(text).toContain('-9.8%');
    expect(text).toContain('PoB calculated 32 of 225');
  });

  it('rejects an unknown sort field before calling PoB', async () => {
    const rankGemsByDps = jest.fn();
    await expect(handleRankGemsByDps(ctx({ rankGemsByDps }), { dps_field: 'Damage' })).rejects.toThrow(/dps_field must be one of/);
    expect(rankGemsByDps).not.toHaveBeenCalled();
  });

  it('says the DPS is the main skill when ranking another group', () => {
    const text = formatGemRanking(ranking({ groupIndex: 2, mainSocketGroup: 1, replaces: 'Lifetap', gemIndex: 4 })).join('\n');
    expect(text).toContain('replacing Lifetap');
    expect(text).toMatch(/main skill's \(group 1\)/);
    expect(formatGemRanking(ranking({ groupIndex: 2, dpsField: 'FullDPS' })).join('\n')).not.toMatch(/main skill's/);
  });

  it('explains a zero Full DPS base', () => {
    const text = formatGemRanking(ranking({ dpsField: 'FullDPS', baseDPS: 0, candidates: [] })).join('\n');
    expect(text).toMatch(/included in Full DPS/);
    expect(text).toContain('No gems to show.');
  });
});

describe('skill sets and config sets', () => {
  it('creates a skill set without switching to it unless asked', async () => {
    const createSkillSet = jest.fn(async () => ({ ...skillSets, created: 2 }));
    const text = textOf(await handleCreateSkillSet(ctx({ createSkillSet }), { title: 'Maps', copy_from: 1 }));
    expect(createSkillSet).toHaveBeenCalledWith({ title: 'Maps', copyFrom: 1, activate: false });
    expect(text).toContain('Created skill set id 2 "Maps" (as a copy of id 1)');
  });

  it('refuses to delete a skill set without confirm', async () => {
    const deleteSkillSet = jest.fn();
    await expect(handleDeleteSkillSet(ctx({ deleteSkillSet, getStats: stats(1) }), { id: 2 })).rejects.toThrow(/confirm: true/);
    expect(deleteSkillSet).not.toHaveBeenCalled();
  });

  it('deletes with confirm and shows the stat change', async () => {
    const deleteSkillSet = jest.fn(async () => ({ ...skillSets, deleted: { id: 2, title: 'Maps' } }));
    let dps = 100;
    const getStats = async () => ({ CombinedDPS: dps++ });
    const text = textOf(await handleDeleteSkillSet(ctx({ deleteSkillSet, getStats }), { id: 2, confirm: true }));
    expect(deleteSkillSet).toHaveBeenCalledWith(2);
    expect(text).toContain('Deleted skill set id 2 "Maps"');
    expect(text).toMatch(/Combined DPS: 100 -> 101/);
  });

  it('reports selecting the active set as no change, without reading stats twice', async () => {
    const selectSkillSet = jest.fn(async () => ({ ...skillSets, unchanged: true }));
    const getStats = jest.fn(stats(1));
    const text = textOf(await handleSelectSkillSet(ctx({ selectSkillSet, getStats }), { id: 1 }));
    expect(text).toContain('Skill set id 1 is already active; nothing changed.');
    expect(text).not.toContain('Stats (PoB)');
    expect(getStats).toHaveBeenCalledTimes(1);
  });

  it('validates ids and titles', async () => {
    await expect(handleSelectSkillSet(ctx({}), { id: 0 })).rejects.toThrow(/positive integer/);
    await expect(handleRenameSkillSet(ctx({}), { id: 1 })).rejects.toThrow(/title is required/);
    await expect(handleCreateConfigSet(ctx({}), { title: '  ' })).rejects.toThrow(/title is required/);
  });

  it('refuses to delete a config set without confirm, deletes with it', async () => {
    const deleteConfigSet = jest.fn(async () => ({ activeConfigSetId: 1, configSets: [], deleted: { id: 2, title: 'Boss' } }));
    await expect(handleDeleteConfigSet(ctx({ deleteConfigSet }), { id: 2, confirm: false })).rejects.toThrow(/confirm: true/);
    expect(deleteConfigSet).not.toHaveBeenCalled();
    const text = textOf(await handleDeleteConfigSet(ctx({ deleteConfigSet, getStats: stats(1) }), { id: 2, confirm: true }));
    expect(text).toContain('Deleted config set id 2 "Boss"');
  });

  it('lists config sets with the active one marked', async () => {
    const listConfigSets = async () => ({
      activeConfigSetId: 2,
      configSets: [{ index: 1, id: 1, title: 'Default', active: false, customModGroups: 1 }, { index: 2, id: 2, title: 'Boss', active: true, customModGroups: 2 }],
    });
    const text = textOf(await handleListConfigSets(ctx({ listConfigSets })));
    expect(text).toContain('> [id 2] Boss (2 custom modifier groups)');
    expect(text).toContain('Active config set: id 2.');
  });
});

describe('spectres and minions', () => {
  it('passes the library search through', async () => {
    const listSpectres = jest.fn(async () => ({
      spectres: [],
      library: { search: 'solar', searchMode: 'names' as const, total: 1, results: [{ id: 'M/Solar', name: 'Solar Guard', skills: ['Beam'] }] },
    }));
    const text = textOf(await handleListSpectres(ctx({ listSpectres }), { search: 'solar', limit: 5 }));
    expect(listSpectres).toHaveBeenCalledWith({ search: 'solar', searchMode: undefined, limit: 5 });
    expect(text).toContain('Solar Guard [M/Solar]: Beam');
    await expect(handleListSpectres(ctx({ listSpectres }), { search_mode: 'monsters' })).rejects.toThrow(/search_mode/);
  });

  it('needs spectres to add or remove, as string lists', async () => {
    await expect(handleSetSpectres(ctx({}), {})).rejects.toThrow(/add and\/or remove/);
    await expect(handleSetSpectres(ctx({}), { add: 'Solar Guard' })).rejects.toThrow(/array/);
    const setSpectres = jest.fn(async () => ({ spectres: [{ id: 'M/Solar', name: 'Solar Guard', skills: [], index: 1 }], added: ['M/Solar'] }));
    const text = textOf(await handleSetSpectres(ctx({ setSpectres, getStats: stats(1) }), { add: ['Solar Guard'] }));
    expect(setSpectres).toHaveBeenCalledWith({ add: ['Solar Guard'], remove: undefined });
    expect(text).toContain('added 1');
  });

  it('maps the minion arguments and shows the selection', async () => {
    const options: MinionOptions = {
      calcs: false, groupIndex: 8, skill: 'Raise Spectre', hasMinion: true, usesSpectreLibrary: true,
      options: [{ minionId: 'M/Gull', label: 'Gluttonous Gull' }], selectedMinion: 'M/Gull',
      minionSkills: [{ index: 1, name: 'Consume Corpse' }, { index: 3, name: 'Blood Projectile' }], selectedMinionSkill: 3,
    };
    const setMinion = jest.fn(async () => options);
    const text = textOf(await handleSetMinion(ctx({ setMinion, getStats: stats(1) }), { minion: 'Gluttonous Gull', minion_skill: 3, item_set_id: undefined }));
    expect(setMinion).toHaveBeenCalledWith({ calcs: false, minion: 'Gluttonous Gull', itemSetId: undefined, minionSkill: 3 });
    expect(text).toContain('> Gluttonous Gull [M/Gull]');
    expect(text).toContain('> 3. Blood Projectile');
    await expect(handleSetMinion(ctx({ setMinion }), {})).rejects.toThrow(/minion, item_set_id or minion_skill/);
  });

  it('reports a main skill without a minion', async () => {
    const getMinionOptions = async () => ({ calcs: true, groupIndex: 1, skill: 'Righteous Fire', hasMinion: false });
    const text = textOf(await handleGetMinionOptions(ctx({ getMinionOptions }), { calcs: true }));
    expect(text).toContain('(Calcs tab)');
    expect(text).toContain('no minion to choose');
  });
});

describe('custom modifiers', () => {
  const state: CustomModsState = {
    configSetId: 1, configSetTitle: 'Default',
    groups: [{ index: 1, title: 'Default', enabled: true, text: '20% more Damage\nnonsense', lines: [
      { text: '20% more Damage', supported: true }, { text: 'nonsense', supported: false, unparsed: 'nonsense' },
    ] }],
    groupIndex: 1,
  };

  it('marks lines PoB cannot parse', async () => {
    const text = textOf(await handleGetCustomMods(ctx({ getCustomMods: async () => state })));
    expect(text).toContain('ok  20% more Damage');
    expect(text).toMatch(/nonsense {2}\(PoB cannot parse this line/);
  });

  it('maps the edit arguments and shows the stat change', async () => {
    const setCustomMods = jest.fn(async () => state);
    let dps = 1000;
    const getStats = async () => { const out = { CombinedDPS: dps }; dps = 1200; return out; };
    const text = textOf(await handleSetCustomMods(ctx({ setCustomMods, getStats }), { append_mod: '20% more Damage' }));
    expect(setCustomMods).toHaveBeenCalledWith(expect.objectContaining({ appendMod: '20% more Damage', groupIndex: undefined }));
    expect(text).toMatch(/Combined DPS: 1,?000 -> 1,?200 \(\+200 \(\+20\.0%\)\)/);
  });

  it('removes a group only with group_index and confirm', async () => {
    const setCustomMods = jest.fn(async () => ({ ...state, groupIndex: undefined, removed: { index: 2, title: 'Junk', text: '' } }));
    await expect(handleSetCustomMods(ctx({ setCustomMods }), { remove_group: true, confirm: true })).rejects.toThrow(/group_index/);
    await expect(handleSetCustomMods(ctx({ setCustomMods }), { remove_group: true, group_index: 2 })).rejects.toThrow(/confirm: true/);
    expect(setCustomMods).not.toHaveBeenCalled();
    const text = textOf(await handleSetCustomMods(ctx({ setCustomMods, getStats: stats(1) }), { remove_group: true, group_index: 2, confirm: true }));
    expect(text).toContain('Removed custom modifier group 2 "Junk"');
  });

  it('get_config shows the custom modifiers, and still works without them', async () => {
    const base = { getConfig: async () => ({ bandit: 'None', enemyLevel: 84 }), getConfigLabels: async () => ({}) };
    const withMods = textOf(await handleGetConfig(ctx({ ...base, getCustomMods: async () => state })));
    expect(withMods).toContain('=== Custom Modifiers (config set "Default") ===');
    expect(withMods).toContain('nonsense  (not parsed by PoB)');
    const without = textOf(await handleGetConfig(ctx(base)));
    expect(without).toContain('=== Configuration State ===');
    expect(without).not.toContain('Custom Modifiers');
  });
});

describe('registration', () => {
  const TOOLS = ['rank_gems_by_dps', 'list_skill_sets', 'select_skill_set', 'create_skill_set', 'rename_skill_set', 'delete_skill_set',
    'list_config_sets', 'select_config_set', 'create_config_set', 'rename_config_set', 'delete_config_set', 'list_spectres',
    'set_spectres', 'get_minion_options', 'set_minion', 'get_custom_mods', 'set_custom_mods'];
  const ACTIONS = ['rank_gems_by_dps', 'list_skill_sets', 'select_skill_set', 'create_skill_set', 'rename_skill_set', 'delete_skill_set',
    'list_config_sets', 'select_config_set', 'create_config_set', 'rename_config_set', 'delete_config_set', 'list_spectres',
    'set_spectres', 'get_minion_options', 'set_minion', 'get_custom_mods', 'set_custom_mods'];
  const READS = new Set(['rank_gems_by_dps', 'list_skill_sets', 'list_config_sets', 'list_spectres', 'get_minion_options', 'get_custom_mods']);

  it('advertises every tool, deletes requiring confirm', () => {
    const schemas = getLuaToolSchemas();
    for (const name of TOOLS) expect(schemas.some((s) => s.name === name)).toBe(true);
    for (const name of ['delete_skill_set', 'delete_config_set']) {
      expect(schemas.find((s) => s.name === name)?.inputSchema.required).toContain('confirm');
    }
  });

  it('routes every tool to its handler', async () => {
    const deps = { contextBuilder: { buildHandlerContext: () => ({}), buildWatchContext: () => ({}), buildLuaContext: () => ({}),
      buildItemSkillContext: () => ({}), buildOptimizationContext: () => ({}), buildExportContext: () => ({}),
      buildSkillGemContext: () => ({}), buildValidationContext: () => ({}) },
      getLuaClient: () => ({ listSkillSets: async () => skillSets }), ensureLuaClient: async () => {} };
    const text = textOf(await routeToolCall('list_skill_sets', {}, deps as never));
    expect(text).toContain('[id 2] Maps');
    for (const name of TOOLS) {
      await routeToolCall(name, {}, deps as never).catch((e: Error) => expect(e.message).not.toMatch(/Unknown tool/));
    }
  });

  it('registers every bridge action, and the desktop server marks the changing ones', () => {
    const root = path.resolve(__dirname, '../..');
    const handlers = fs.readFileSync(path.join(root, 'lua/bridge_handlers.lua'), 'utf8');
    const ops = fs.readFileSync(path.join(root, 'lua/pob_ops.lua'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'pob-gui/src/Modules/McpServer.lua'), 'utf8');
    const modifies = server.match(/local MODIFIES_BUILD = \{([\s\S]*?)\n\}/)?.[1] ?? '';
    for (const action of ACTIONS) {
      expect(handlers).toContain(`handlers.${action} = op(BuildOps.${action}, 'result')`);
      expect(ops).toContain(`function M.${action}(`);
      if (READS.has(action)) expect(modifies).not.toMatch(new RegExp(`\\b${action} = true`));
      else expect(modifies).toMatch(new RegExp(`\\b${action} = true`));
    }
    // A custom mod search opens the Add Mod popup, so it is refused while the user has a dialog open.
    const opensPopups = server.match(/local OPENS_POPUPS = \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(opensPopups).toMatch(/\bget_custom_mods = function\(params\) return params\.search ~= nil end/);
  });
});
