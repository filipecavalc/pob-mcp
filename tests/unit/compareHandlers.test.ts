import { describe, it, expect, beforeEach } from '@jest/globals';
import zlib from 'zlib';

const readFile = jest.fn(async (..._args: unknown[]) => '<PathOfBuilding><Build/></PathOfBuilding>');
jest.mock('fs/promises', () => ({ __esModule: true, default: { readFile } }));

import {
  decodeBuildCode, defaultTradeLeague, formatCompareReport,
  handleCompareAddBuild, handleCompareBuySimilar, handleCompareCopy, handleCompareDifferences,
  handleComparePowerReport, handleCompareRemoveBuild,
} from '../../src/handlers/compareHandlers.js';
import { routeToolCall } from '../../src/server/toolRouter.js';
import { getLuaToolSchemas } from '../../src/server/toolSchemas.js';
import type { CompareEntryInfo, CompareReport } from '../../src/types/compareTypes.js';

const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');

const ENTRY: CompareEntryInfo = {
  index: 1, label: 'RF pohx', active: true, className: 'Marauder', ascendClassName: 'Chieftain', level: 95,
  treeSets: [{ index: 1, title: 'Early', active: false }, { index: 2, title: 'Late', active: true }],
  itemSets: [{ index: 1, id: 3, title: 'Main', active: true }],
  skillSets: [{ index: 1, id: 1, title: 'Default', active: true }],
  configSets: [{ index: 1, id: 1, title: 'Default', active: true }],
  mainSocketGroup: 2, calcsSocketGroup: 2, calcsBuffMode: 'EFFECTIVE',
  socketGroups: [{ index: 1, label: 'Auras', enabled: true }, { index: 2, label: 'Righteous Fire', enabled: true }],
  stats: { Life: 5162, EnergyShield: 150, TotalEHP: 87250.9, CombinedDPS: 1425161.4, FullDPS: 8319044.6 },
};

function makeLua() {
  return {
    compareImport: jest.fn(async (_xml: string, label?: string) => ({ entry: { ...ENTRY, label: label ?? 'x' }, count: 1 })),
    compareList: jest.fn(async () => ({ primary: { name: 'RF atual' }, activeIndex: 1, entries: [ENTRY] })),
    compareRemove: jest.fn(async () => ({ primary: { name: 'RF atual' }, activeIndex: 0, entries: [], removed: 'RF pohx' })),
    compareSelect: jest.fn(async () => ({ entry: ENTRY, changed: ['tree_set'] })),
    compareReport: jest.fn(async (): Promise<CompareReport> => ({ primaryName: 'RF atual', compareName: 'RF pohx', index: 1, onlyDifferences: true })),
    comparePowerReport: jest.fn(async () => ({})),
    compareBuySimilar: jest.fn(async (params: Record<string, unknown>) => ({
      url: 'https://www.pathofexile.com/trade/search/' + String(params.league) + '?q=' + encodeURIComponent(JSON.stringify({ query: { status: { option: 'securable' }, name: 'Cloak of Flame' }, sort: { price: 'asc' } })),
      item: { name: 'Cloak of Flame, Scholar\'s Robe', rarity: 'UNIQUE' }, slot: 'Body Armour', unique: true,
      realm: 'PC', league: String(params.league), listed: 'securable',
      mods: [{ index: 1, type: 'explicit', text: '+65% to Fire Resistance', searchable: true, selected: true, tradeIds: ['explicit.stat_3372524247'], value: 65, min: 65 }],
      skippedMods: [], defences: [], compareName: 'RF pohx', index: 1,
    })),
    compareCopy: jest.fn(async (params: Record<string, unknown>) => ({
      what: params.what, used: params.use === true, compareName: 'RF pohx', index: 1,
      item: { name: 'New Item, Archdemon Crown' }, slot: 'Helmet', equipped: params.use === true, stats: { Life: 5325 },
    })),
  };
}

function makeContext(lua: ReturnType<typeof makeLua>) {
  return {
    pobDirectory: 'C:/builds',
    luaEnabled: true,
    getLuaClient: () => lua as never,
    ensureLuaClient: async () => {},
    stopLuaClient: async () => {},
  };
}

describe('decodeBuildCode', () => {
  it('inflates a URL-safe base64 PoB code, as CompareTab:ImportFromCode', () => {
    const xml = '<PathOfBuilding><Build level="90"/></PathOfBuilding>';
    const code = zlib.deflateSync(Buffer.from(xml)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeBuildCode(code)).toBe(xml);
  });

  it('rejects text that is not a build code', () => {
    expect(() => decodeBuildCode('not a code!')).toThrow(/Invalid build code/);
  });
});

describe('compare_add_build', () => {
  beforeEach(() => { readFile.mockClear(); });

  it('loads a builds-dir file and labels it with the file name', async () => {
    const lua = makeLua();
    const res = await handleCompareAddBuild(makeContext(lua), { buildName: 'RF pohx.xml' });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(String(readFile.mock.calls[0][0]).replace(/\\/g, '/')).toBe('C:/builds/RF pohx.xml');
    expect(lua.compareImport).toHaveBeenCalledWith('<PathOfBuilding><Build/></PathOfBuilding>', 'RF pohx');
    expect(textOf(res)).toContain('Loaded "RF pohx" for comparison');
    expect(textOf(res)).toContain('*[2] Late');
  });

  it('decodes a build code and uses PoB\'s default name', async () => {
    const lua = makeLua();
    const xml = '<PathOfBuilding/>';
    const code = zlib.deflateSync(Buffer.from(xml)).toString('base64');
    await handleCompareAddBuild(makeContext(lua), { buildCode: code });
    expect(readFile).not.toHaveBeenCalled();
    expect(lua.compareImport).toHaveBeenCalledWith(xml, 'Imported build');
  });

  it('needs exactly one source and refuses paths outside the builds dir', async () => {
    const lua = makeLua();
    await expect(handleCompareAddBuild(makeContext(lua), {})).rejects.toThrow(/exactly one/);
    await expect(handleCompareAddBuild(makeContext(lua), { buildName: 'a.xml', buildCode: 'x' })).rejects.toThrow(/exactly one/);
    await expect(handleCompareAddBuild(makeContext(lua), { buildName: '../../secret.xml' })).rejects.toThrow();
    expect(lua.compareImport).not.toHaveBeenCalled();
  });
});

describe('compare_remove_build', () => {
  it('validates the index before calling the engine', async () => {
    const lua = makeLua();
    await expect(handleCompareRemoveBuild(makeContext(lua), Number(undefined))).rejects.toThrow(/positive integer/);
    expect(lua.compareRemove).not.toHaveBeenCalled();
    const res = await handleCompareRemoveBuild(makeContext(lua), 1);
    expect(textOf(res)).toContain('Removed "RF pohx"');
  });
});

describe('compare_differences', () => {
  it('rejects unknown sections and passes the rest through without the output flag', async () => {
    const lua = makeLua();
    await expect(handleCompareDifferences(makeContext(lua), { sections: ['gear' as never] })).rejects.toThrow(/unknown section/);
    await handleCompareDifferences(makeContext(lua), { sections: ['stats', 'calcs'], only_differences: false, output: 'json' });
    expect(lua.compareReport).toHaveBeenCalledWith({ sections: ['stats', 'calcs'], only_differences: false });
  });

  it('formats every section the engine returns', () => {
    const report: CompareReport = {
      primaryName: 'RF atual', compareName: 'RF pohx', index: 1, onlyDifferences: true,
      stats: { minionStats: false, rows: [{ label: 'Total Life', primaryText: '5,447', compareText: '5,162', diffText: '-285', percent: -5.23, better: false }] },
      tree: {
        primary: { className: 'Marauder', ascendClassName: 'Chieftain', pointsUsed: 106, ascendancyPointsUsed: 8, treeVersion: '3_29', specTitle: 'Default' },
        compare: { className: 'Marauder', ascendClassName: 'Chieftain', pointsUsed: 120, ascendancyPointsUsed: 8, treeVersion: '3_29', specTitle: 'Late' },
        compareOnly: [{ id: 55485, name: 'Constitution', type: 'Notable', status: 'compare_only' }],
        primaryOnly: [],
        differs: [{ id: 26725, name: 'Jewel Socket', type: 'Socket', status: 'differs', primaryJewel: 'Hypnotic Vessel', compareJewel: 'Foulborn The Red Dream' }],
        sharedCount: 90,
      },
      items: {
        primaryItemSet: 'Default', compareItemSet: 'Main',
        slots: [{ slot: 'Helmet', slotName: 'Helmet', status: 'different', primary: { name: 'Brood Brow, Siege Helmet', rarity: 'RARE' }, compare: { name: 'New Item, Archdemon Crown', rarity: 'RARE' },
          primaryMods: [{ text: '+117 to maximum Life', marker: '+' }], compareMods: [{ text: '+2 to Level of Socketed Skill Gems', marker: '+' }], equipStatChanges: ['-122 Total Life (-2.2%)'] }],
        jewels: [],
      },
      skills: { primarySkillSet: 'Default', compareSkillSet: 'Default', pairs: [{
        primaryGroup: { index: 3, label: 'Frostblink', enabled: true, main: false },
        compareGroup: { index: 18, label: 'Frostblink', enabled: true, main: false },
        primaryGems: [{ name: 'Frostblink', status: 'common', level: 19, quality: 0 }, { name: 'Arcane Surge', status: 'additional', level: 19, quality: 0 }],
        compareGems: [{ name: 'Frostblink', status: 'common', level: 1, quality: 0 }, { name: 'Arcane Surge', status: 'missing' }],
        differs: true,
      }] },
      config: { primaryConfigSet: 'Default', compareConfigSet: 'Default', differences: 1, sections: [{ name: 'General', diffCount: 1, rows: [{ var: 'conditionStationary', label: 'Time spent stationary', primary: '(not set)', compare: '1', differs: true }] }] },
      calcs: { error: 'calcs environment not available' },
    };
    const out = formatCompareReport(report);
    expect(out).toContain('Total Life: 5,447 -> 5,162  -285 (-5.2%) worse');
    expect(out).toContain('Constitution (Notable, id 55485)');
    expect(out).toContain('[loaded: Hypnotic Vessel | compared: Foulborn The Red Dream]');
    expect(out).toContain('- Helmet: different');
    expect(formatCompareReport({ ...report, stats: undefined, tree: undefined, skills: undefined, config: undefined, calcs: undefined,
      items: { primaryItemSet: 'A', compareItemSet: 'B', jewels: [], slots: [{ slot: 'Amulet', slotName: 'Amulet', status: 'match', identical: false,
        primary: { name: 'Eye of Chayula, Onyx Amulet' }, compare: { name: 'Eye of Chayula, Onyx Amulet' } }] } }))
      .toContain('- Amulet: match (same name, different item)');
    expect(out).toContain('+ +117 to maximum Life');
    expect(out).toContain('equipping the compared item: -122 Total Life (-2.2%)');
    expect(out).toContain('loaded:   Frostblink 19/0, + Arcane Surge 19/0');
    expect(out).toContain('compared: Frostblink 1/0, - Arcane Surge');
    expect(out).toContain('* Time spent stationary: (not set) -> 1  (conditionStationary)');
    expect(out).toContain('== Calcs ==\nerror: calcs environment not available');
  });
});

describe('compare_power_report', () => {
  it('lists the metrics when none is chosen', async () => {
    const lua = makeLua();
    lua.comparePowerReport.mockResolvedValueOnce({ needsMetric: true, metrics: [{ stat: 'FullDPS', label: 'Full DPS' }] } as never);
    const out = textOf(await handleComparePowerReport(makeContext(lua), {}));
    expect(out).toContain('Choose a metric');
    expect(out).toContain('FullDPS (Full DPS)');
  });

  it('prints PoB\'s rows with points for passives', async () => {
    const lua = makeLua();
    lua.comparePowerReport.mockResolvedValueOnce({
      metric: { stat: 'Life', label: 'Life' }, categories: { tree: true, items: true, skill_gems: false, support_gems: true, config: true },
      compareName: 'RF pohx', index: 1, total: 2,
      rows: [
        { category: 'Item', name: 'New Item, Ezomyte Tower Shield, Weapon 2', impact: 507, impactText: '+507 (+9.3%)' },
        { category: 'Tree', name: 'Constitution', impact: 264, impactText: '+264 (+4.8%)', points: 6, perPointText: '+44' },
      ],
    } as never);
    const out = textOf(await handleComparePowerReport(makeContext(lua), { metric: 'Life' }));
    expect(out).toContain('Categories: tree, items, support_gems, config.');
    expect(out).toContain('+264 (+4.8%)');
    expect(out).toContain('Constitution  6 pt, +44 per point');
  });
});

describe('compare_buy_similar', () => {
  it('picks the league the popup would pick', () => {
    const leagues = [
      { id: 'Standard', realm: 'pc' }, { id: 'Hardcore', realm: 'pc' },
      { id: 'Keepers', realm: 'pc' }, { id: 'Hardcore Keepers', realm: 'pc' }, { id: 'Keepers Event', realm: 'pc' },
      { id: 'Keepers', realm: 'xbox' },
    ];
    // Each softcore league is inserted at the front, so the last listed wins.
    expect(defaultTradeLeague(leagues, 'pc')).toBe('Keepers Event');
    expect(defaultTradeLeague([], 'pc')).toBe('Standard');
  });

  it('only reads the league list, as the popup does, unless run_search is set', async () => {
    const lua = makeLua();
    const trade = { getLeagues: jest.fn(async () => ({ result: [{ id: 'Keepers', realm: 'pc' }] })), searchItems: jest.fn() };
    const out = textOf(await handleCompareBuySimilar(makeContext(lua), { slot: 'Body Armour', mods: 'all' }, trade as never));
    expect(lua.compareBuySimilar).toHaveBeenCalledWith({ slot: 'Body Armour', mods: 'all', league: 'Keepers' });
    expect(trade.getLeagues).toHaveBeenCalledTimes(1);
    expect(trade.searchItems).not.toHaveBeenCalled();
    expect(out).toContain('URL: https://www.pathofexile.com/trade/search/Keepers?q=');
    expect(out).toContain('"name": "Cloak of Flame"');
  });

  it('runs PoB\'s query once when asked', async () => {
    const lua = makeLua();
    const trade = { getLeagues: jest.fn(), searchItems: jest.fn(async () => ({ id: 'abc', total: 12, result: [], complexity: 1 })) };
    const out = textOf(await handleCompareBuySimilar(makeContext(lua), { slot: 'Body Armour', league: 'Standard', run_search: true }, trade as never));
    expect(trade.getLeagues).not.toHaveBeenCalled();
    expect(trade.searchItems).toHaveBeenCalledWith('Standard', { query: { status: { option: 'securable' }, name: 'Cloak of Flame' }, sort: { price: 'asc' } });
    expect(out).toContain('Trade search: 12 listing(s)');
  });

  it('falls back to Standard without the trade API and refuses run_search', async () => {
    const lua = makeLua();
    const out = textOf(await handleCompareBuySimilar(makeContext(lua), { slot: 'Helmet' }, null));
    expect(lua.compareBuySimilar).toHaveBeenCalledWith({ slot: 'Helmet' });
    expect(out).toContain('trade API disabled');
    await expect(handleCompareBuySimilar(makeContext(lua), { slot: 'Helmet', run_search: true }, null)).rejects.toThrow(/POE_TRADE_ENABLED/);
  });
});

describe('compare_copy', () => {
  it('validates what and slot, then reports the copy', async () => {
    const lua = makeLua();
    await expect(handleCompareCopy(makeContext(lua), { what: 'gems' as never })).rejects.toThrow(/tree, item or config/);
    await expect(handleCompareCopy(makeContext(lua), { what: 'item' })).rejects.toThrow(/slot is required/);
    expect(lua.compareCopy).not.toHaveBeenCalled();
    const out = textOf(await handleCompareCopy(makeContext(lua), { what: 'item', slot: 'Helmet', use: true }));
    expect(out).toContain('equipped it in Helmet');
    expect(out).toContain('lua_save_build');
  });
});

describe('routing and schemas', () => {
  it('advertises every compare tool among the Lua tools', () => {
    const names = getLuaToolSchemas().map((t) => t.name);
    for (const name of ['compare_add_build', 'compare_list', 'compare_remove_build', 'compare_select',
      'compare_differences', 'compare_power_report', 'compare_buy_similar', 'compare_copy']) {
      expect(names).toContain(name);
    }
  });

  it('maps snake_case arguments to the handler', async () => {
    const lua = makeLua();
    const ctx = makeContext(lua);
    const deps = {
      contextBuilder: {
        buildHandlerContext: () => ({}), buildWatchContext: () => ({}), buildLuaContext: () => ctx,
        buildItemSkillContext: () => ({}), buildOptimizationContext: () => ({}), buildExportContext: () => ({}),
        buildSkillGemContext: () => ({}),
      },
      tradeClient: null, statMapper: null, recommendationEngine: null, ninjaClient: {},
      getLuaClient: () => lua, ensureLuaClient: async () => {},
    };
    readFile.mockClear();
    await routeToolCall('compare_add_build', { build_name: 'Other.xml', label: 'Mine' }, deps as never);
    expect(lua.compareImport).toHaveBeenCalledWith(expect.any(String), 'Mine');
    await routeToolCall('compare_select', { index: 1, tree_set: 2 }, deps as never);
    expect(lua.compareSelect).toHaveBeenCalledWith({ index: 1, tree_set: 2 });
    await routeToolCall('compare_copy', { what: 'tree', use: true }, deps as never);
    expect(lua.compareCopy).toHaveBeenCalledWith({ what: 'tree', use: true });
  });
});
