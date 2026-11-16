import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import path from 'path';
import {
  handleGetNodePower, handleFindTimelessJewel, handleListTattoos, handleApplyTattoo, handleRemoveTattoos,
  formatPower, timelessParams,
} from '../../src/handlers/treePowerHandlers.js';
import { routeToolCall } from '../../src/server/toolRouter.js';
import { getLuaToolSchemas, getOptimizationToolSchemas, getBuildGoalsToolSchemas } from '../../src/server/toolSchemas.js';
import { shouldTruncate } from '../../src/server/responseUtils.js';
import net from 'node:net';
import os from 'node:os';
import { mkdtempSync, writeFileSync } from 'fs';
import { PoBLuaApiClient, NODE_POWER_TIMEOUT_MS } from '../../src/pobLuaBridge.js';
import { PoBGuiApiClient } from '../../src/pobGuiClient.js';
import type { NodePowerReport, TimelessOptions, TimelessSearchResult, TattooApplied, TattooList, TattoosRemoved } from '../../src/types/treePower.js';
import { textOf } from '../helpers/response.js';

type Calls = Array<{ method: string; params: unknown }>;

/** A Lua client double that records calls and answers each method with a canned value. */
function fakeContext(replies: Record<string, unknown>) {
  const calls: Calls = [];
  const client = new Proxy({}, {
    // `then` must stay undefined, or awaiting the client would treat it as a promise.
    get: (_target, method: string) => method === 'then' ? undefined : async (params: unknown) => {
      calls.push({ method, params });
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return { calls, context: { ensureLuaClient: async () => {}, getLuaClient: () => client as unknown as PoBLuaApiClient } };
}

const report = (over: Partial<NodePowerReport> = {}): NodePowerReport => ({
  stat: 'FullDPS', label: 'Full DPS', base: 80043.08, scale: 1, fmt: '.1f', lowerIsBetter: false,
  filter: 'unallocated', sortBy: 'power', showMasteries: true, listed: 386, reportSize: 3685, seconds: 11.2, resumes: 2,
  nodes: [
    { id: 42649, name: 'Snowforged', type: 'Notable', power: 12065.5, perPoint: 1630.39, points: 10, allocated: false,
      path: [42649, 6785, 20852], stats: ['25% increased Fire Damage', '25% increased Cold Damage'] },
    { id: 28039, name: 'Axe Mastery: 30% increased Damage while in Blood Stance', type: 'Mastery', power: 4430.4, perPoint: 356.9,
      points: 16, allocated: false, path: [28039, 26096], stats: ['Enemies Killed by your Hits are destroyed', 'Gain 2 Rage on Hit with Axes'] },
    { id: 38706, name: 'Way of the Warrior', type: 'Notable', power: 80, perPoint: 0.08, points: 1000, allocated: false, stats: ['+16 to maximum Life'] },
  ],
  ...over,
});

describe('get_node_power', () => {
  it('forwards PoB power report options and defaults to 10 rows', async () => {
    const { calls, context } = fakeContext({ nodePower: report() });
    await handleGetNodePower(context, { stat: 'Life', max_depth: 5, filter: 'allocated', sort_by: 'per_point', types: ['Notable'], show_masteries: false });
    expect(calls).toEqual([{ method: 'nodePower', params: {
      stat: 'Life', maxDepth: 5, filter: 'allocated', sortBy: 'per_point', types: ['Notable'], showMasteries: false, limit: 10,
    } }]);
  });

  it("shows PoB's values, path cost and per-point value", async () => {
    const { context } = fakeContext({ nodePower: report() });
    const text = textOf(await handleGetNodePower(context, { stat: 'FullDPS' }));
    expect(text).toContain('Node Power: Full DPS (FullDPS)');
    expect(text).toMatch(/1\. Snowforged \[42649\] Notable: \+12.065,5|1\. Snowforged \[42649\] Notable: \+12,065\.5/);
    expect(text).toContain('(+15.07%)');
    expect(text).toContain('10 points');
    expect(text).toContain('per point with its path');
    expect(text).toContain('Path: 42649, 6785, 20852');
    expect(text).toContain('25% increased Fire Damage; 25% increased Cold Damage');
    expect(text).toContain('PoB\'s power builder ran in 11.2 s');
  });

  it('does not list every mastery effect under a mastery row, and marks anoint-only nodes', async () => {
    const { context } = fakeContext({ nodePower: report() });
    const text = textOf(await handleGetNodePower(context, {}));
    expect(text).not.toContain('Enemies Killed by your Hits are destroyed');
    expect(text).toContain('Way of the Warrior [38706] Notable: +80.0 (+0.10%) | anoint only');
    expect(text).not.toMatch(/anoint only \| /);
  });

  it('suggests other stats when the report is empty', async () => {
    const { context } = fakeContext({ nodePower: report({ nodes: [], listed: 0 }) });
    const text = textOf(await handleGetNodePower(context, { stat: 'FullDPS' }));
    expect(text).toContain('No node changes Full DPS for this build');
    expect(text).toContain('try stat CombinedDPS');
  });

  it('defaults to CombinedDPS in the description and points the heuristic tools to it', () => {
    const tools = getLuaToolSchemas();
    const nodePower = tools.find((t) => t.name === 'get_node_power')!;
    expect(JSON.stringify(nodePower.inputSchema.properties?.stat)).toContain('default: CombinedDPS');
    expect(nodePower.description).toContain('get_passive_upgrades');
    expect(nodePower.description).toContain('max_depth');
    const others = [...getOptimizationToolSchemas(), ...getBuildGoalsToolSchemas()]
      .filter((t) => t.name === 'suggest_optimal_nodes' || t.name === 'get_passive_upgrades');
    expect(others).toHaveLength(2);
    for (const tool of others) expect(tool.description).toContain('get_node_power');
  });

  it('formats with the sidebar format PoB uses for the stat', () => {
    expect(formatPower(544, 'd')).toBe('+544');
    expect(formatPower(-12.345, '.2f')).toMatch(/^-12[.,]35$/);
    expect(formatPower(15, 'd%%')).toBe('+15%');
  });

  it('passes the bridge error through', async () => {
    const { context } = fakeContext({ nodePower: new Error('unknown node power stat "x"; PoB offers: FullDPS (Full DPS)') });
    await expect(handleGetNodePower(context, { stat: 'x' })).rejects.toThrow('Failed to get node power: unknown node power stat "x"');
  });
});

const options: TimelessOptions = {
  jewelTypes: [{ id: 2, label: 'Lethal Pride' }], jewelType: { id: 2, label: 'Lethal Pride' },
  conquerors: [{ id: 1, label: 'Any' }, { id: 2, label: 'Kaom (Strength of Blood)' }],
  sockets: [{ id: -1, label: 'All Sockets', keystone: 'Multi-Socket Search', allocated: false }, { id: 26725, label: '# Marauder: 26725', keystone: 'Marauder', allocated: true }],
  devotionVariants: [], abyssAscendancyOutcomes: [], fallbackWeightModes: [{ index: 1, label: 'Sort by Full DPS', stat: 'FullDPS' }],
  protectableNodes: [], mods: [{ id: 'karui_notable_add_life', name: 'Add Life', stats: ['4% increased maximum Life'] }],
};

const longUrl = 'https://www.pathofexile.com/trade/search/Standard/?q=' + '%7B%22query%22'.repeat(800);
const search: TimelessSearchResult = {
  jewelType: 'Lethal Pride', jewelTypeId: 2, conqueror: 'Kaom (Strength of Blood)', socket: '# Marauder: 26725', socketId: 26725,
  desired: [{ id: 'karui_notable_add_life', name: '4% increased maximum Life', index: 1, weight: 1.5, weight2: 1 }],
  resultCount: 2258, seconds: 0.02,
  results: [{ rank: 1, seed: 14190, total: 5.5, socketId: 26725, socket: '# Marauder: 26725', row: ' 14190: 1.5 ',
    matches: [{ id: 'karui_notable_add_life', name: '4% increased maximum Life', nodes: ['Hearty'] }] }],
  trade: { league: 'Standard', realm: 'PC', tradeType: 'securable', searchMore: false,
    urls: [{ url: longUrl, fromRank: 1, toRank: 11, seeds: [14190, 12597] }] },
};

describe('find_timeless_jewel', () => {
  it('lists the dialog options with list_options', async () => {
    const { calls, context } = fakeContext({ findTimelessJewel: options });
    const text = textOf(await handleFindTimelessJewel(context, { list_options: true, jewel_type: 'Lethal Pride' }));
    expect((calls[0].params as { optionsOnly: boolean }).optionsOnly).toBe(true);
    expect(text).toContain('26725: # Marauder: 26725');
    expect(text).toContain('all: All Sockets');
    expect(text).toContain('karui_notable_add_life | Add Life | 4% increased maximum Life');
  });

  it('maps snake_case args onto the dialog fields, with the trade block only when a league is given', () => {
    const params = timelessParams({
      jewel_type: 'Lethal Pride', conqueror: 'Kaom', socket_id: '-1',
      desired_nodes: [{ node: 'Add Life', weight: 2, min_weight: 1, required: true }],
      socket_filter: true, socket_filter_distance: 3, total_minimum_weight: 4,
    });
    expect(params.socketId).toBe('all');
    expect(params.desired).toEqual([{ node: 'Add Life', weight: 2, weight2: undefined, minWeight: 1, required: true }]);
    expect(params.trade).toBeUndefined();
    expect(params.maxResults).toBe(10);
    const traded = timelessParams({ socket_id: 26725, league: 'Settlers', realm: 'sony', trade_type: 'any', search_more: true, trade_pages: 2, start_rank: 5 });
    expect(traded.trade).toEqual({ league: 'Settlers', realm: 'sony', tradeType: 'any', searchMore: true, pages: 2, startRow: 5 });
    expect(() => timelessParams({ socket_id: 'Marauder' })).toThrow('socket_id must be a jewel socket node id or "all"');
  });

  it('needs a socket and something to search for', async () => {
    const { calls, context } = fakeContext({ findTimelessJewel: search });
    await expect(handleFindTimelessJewel(context, { jewel_type: 'Lethal Pride', desired_nodes: [{ node: 'Add Life' }] })).rejects.toThrow('socket_id is required');
    await expect(handleFindTimelessJewel(context, { jewel_type: 'Lethal Pride', socket_id: 26725 })).rejects.toThrow('give desired_nodes');
    expect(calls).toHaveLength(0);
  });

  it('shows seeds, matched nodes and the whole trade URL', async () => {
    const { context } = fakeContext({ findTimelessJewel: search });
    const text = textOf(await handleFindTimelessJewel(context, { jewel_type: 'Lethal Pride', socket_id: 26725, desired_nodes: [{ node: 'Add Life' }], league: 'Standard' }));
    expect(text).toContain('2258 seeds match');
    expect(text).toContain('1. Seed 14190: total weight 5.5');
    expect(text).toContain('4% increased maximum Life: Hearty');
    expect(text).toContain('Ranks 1-11 (2 seeds)');
    expect(text).toContain(longUrl);
  });

  it('is not truncated by the server, so URLs stay usable', () => {
    expect(shouldTruncate('find_timeless_jewel', getLuaToolSchemas())).toBe(false);
    expect(shouldTruncate('get_node_power', getLuaToolSchemas())).toBe(true);
  });
});

const list: TattooList = {
  nodeId: 15064, node: 'Strength', type: 'Normal', allocated: true, tattooCount: 1, tattooLimit: 50,
  current: { name: 'Tattoo of the Tukohama Shaman', stats: ['Regenerate 0.3% of Life per second'] },
  options: [{ id: 'Tattoo of the Kitava Warrior', name: 'Tattoo of the Kitava Warrior', stats: ['5% increased Physical Damage'], legacy: false, minimumConnected: 0 }],
};
const applied: TattooApplied = {
  nodeId: 10661, node: 'Iron Reflexes', tattoo: 'Acrobatics', applied: { name: 'Acrobatics', stats: ['Limited to 1 Keystone Tattoo'] },
  allocated: false, tattooCount: 2, tattooLimit: 50, before: { Life: 5447, Str: 281 }, after: { Life: 5434, Str: 271 },
};
const removed: TattoosRemoved = {
  removed: [{ nodeId: 15064, node: 'Strength', tattoo: 'Tattoo of the Tukohama Shaman' }], remaining: 0,
  before: { Life: 5434 }, after: { Life: 5447 },
};

describe('tattoos', () => {
  it('lists the options with the current tattoo and count', async () => {
    const { calls, context } = fakeContext({ listTattoos: list });
    const text = textOf(await handleListTattoos(context, { node_id: 15064 }));
    expect(calls[0]).toEqual({ method: 'listTattoos', params: { nodeId: 15064, includeLegacy: false } });
    expect(text).toContain('Current: Tattoo of the Tukohama Shaman');
    expect(text).toContain('build tattoo count: 1/50');
    expect(text).toContain('- Tattoo of the Kitava Warrior: 5% increased Physical Damage');
  });

  it('applies a tattoo and reports the stat change and an unallocated node', async () => {
    const { calls, context } = fakeContext({ applyTattoo: applied });
    const text = textOf(await handleApplyTattoo(context, { node_id: 10661, tattoo: 'Acrobatics' }));
    expect(calls[0]).toEqual({ method: 'applyTattoo', params: { nodeId: 10661, tattoo: 'Acrobatics', includeLegacy: false } });
    expect(text).toContain('The node is not allocated');
    expect(text).toMatch(/Life: 5[.,]447 -> 5[.,]434 -13 \(-0\.24%\)/);
    expect(text).toContain('Strength: 281 -> 271 -10');
  });

  it('rejects a missing tattoo or node id before calling PoB', async () => {
    const { calls, context } = fakeContext({});
    await expect(handleApplyTattoo(context, { node_id: 15064, tattoo: '' })).rejects.toThrow('tattoo is required');
    await expect(handleListTattoos(context, { node_id: 'abc' as unknown as number })).rejects.toThrow('node_id must be a passive node id');
    expect(calls).toHaveLength(0);
  });

  it('needs confirm to remove all tattoos, and one target', async () => {
    const { calls, context } = fakeContext({ removeTattoos: removed });
    await expect(handleRemoveTattoos(context, { all: true })).rejects.toThrow('needs confirm: true');
    await expect(handleRemoveTattoos(context, {})).rejects.toThrow('give node_id');
    await expect(handleRemoveTattoos(context, { all: true, node_id: 1, confirm: true })).rejects.toThrow('not both');
    expect(calls).toHaveLength(0);
    const text = textOf(await handleRemoveTattoos(context, { all: true, confirm: true }));
    expect(calls[0]).toEqual({ method: 'removeTattoos', params: { all: true } });
    expect(text).toContain('Remove All Tattoos: 1 removed, 0 left');
    await handleRemoveTattoos(context, { node_id: 15064 });
    expect(calls[1]).toEqual({ method: 'removeTattoos', params: { nodeId: 15064 } });
  });
});

describe('Lua bridge actions', () => {
  class RecordingClient extends PoBLuaApiClient {
    sent: Array<{ action: string; params?: unknown }> = [];
    sentOptions: Array<{ minTimeoutMs?: number } | undefined> = [];
    constructor(private reply: Record<string, unknown>) { super(); }
    protected override async send(obj: { action: string; params?: unknown }, options?: { minTimeoutMs?: number }) {
      this.sent.push(obj);
      this.sentOptions.push(options);
      return this.reply as never;
    }
  }

  it('gives node_power alone a longer reply timeout (at least 180 s)', async () => {
    const client = new RecordingClient({ ok: true, result: {} });
    await client.nodePower({});
    await client.listTattoos({ nodeId: 1 });
    expect(NODE_POWER_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
    expect(client.sentOptions).toEqual([{ minTimeoutMs: NODE_POWER_TIMEOUT_MS }, undefined]);
  });

  it('lets node_power outlast the desktop client timeout, and only node_power', async () => {
    // A stand-in for the desktop app's socket server that answers after 300 ms.
    const deadlines: Record<string, number> = {};
    const server = net.createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const req = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (req.action === 'hello') { sock.write(JSON.stringify({ ok: true }) + '\n'); continue; }
          deadlines[req.action] = req.deadline - Date.now();
          setTimeout(() => { if (!sock.destroyed) sock.write(JSON.stringify({ ok: true, result: { stat: 'Life' } }) + '\n'); }, 300);
        }
      });
      sock.on('error', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'treepower-'));
    const tokenFile = path.join(dir, 'pob-mcp-token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const client = new PoBGuiApiClient({ tokenFile, port: (server.address() as net.AddressInfo).port, timeoutMs: 100 });
    try {
      await client.start();
      await expect(client.nodePower({ stat: 'Life' })).resolves.toEqual({ stat: 'Life' });
      expect(deadlines.node_power).toBeGreaterThan(NODE_POWER_TIMEOUT_MS - 5_000);
      await expect(client.listTattoos({ nodeId: 1 })).rejects.toThrow('did not answer "list_tattoos" within 0 s');
    } finally {
      await client.stop().catch(() => undefined);
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('sends each tree action and returns its result', async () => {
    const client = new RecordingClient({ ok: true, result: { marker: 1 } });
    await expect(client.nodePower({ stat: 'Life' })).resolves.toEqual({ marker: 1 });
    await client.findTimelessJewel({ socketId: 26725 });
    await client.listTattoos({ nodeId: 1 });
    await client.applyTattoo({ nodeId: 1, tattoo: 'x' });
    await client.removeTattoos({ all: true });
    expect(client.sent.map((s) => s.action)).toEqual(['node_power', 'find_timeless_jewel', 'list_tattoos', 'apply_tattoo', 'remove_tattoos']);
  });

  it('turns a bridge error into an exception', async () => {
    const client = new RecordingClient({ ok: false, error: 'node 5 has no tattoo' });
    await expect(client.removeTattoos({ nodeId: 5 })).rejects.toThrow('node 5 has no tattoo');
  });

  it('registers every action in the shared handlers, and tattoos as build changes in the desktop server', () => {
    const root = path.resolve(__dirname, '../..');
    const handlers = readFileSync(path.join(root, 'lua/bridge_handlers.lua'), 'utf8');
    for (const action of ['node_power', 'find_timeless_jewel', 'list_tattoos', 'apply_tattoo', 'remove_tattoos']) {
      expect(handlers).toContain(`handlers.${action} = op(BuildOps.${action}, 'result')`);
    }
    const server = readFileSync(path.join(root, 'pob-gui/src/Modules/McpServer.lua'), 'utf8');
    const modifies = server.slice(server.indexOf('local MODIFIES_BUILD = {'), server.indexOf('}', server.indexOf('local MODIFIES_BUILD = {')));
    expect(modifies).toContain('apply_tattoo = true');
    expect(modifies).toContain('remove_tattoos = true');
    expect(modifies).not.toContain('node_power = true');
    expect(modifies).not.toContain('find_timeless_jewel = true');
    // The finder and the tattoo list put back state a dialog the user has open may hold.
    expect(server).toMatch(/local OPENS_DIALOG = \{ find_timeless_jewel = true, list_tattoos = true \}/);
    // The dialog guard line lists OPENS_DIALOG among the sets it refuses while a dialog is open.
    expect(server).toMatch(/if \([^\n]*\bOPENS_DIALOG\[action\][^\n]*\) and main\.popups\[1\] then/);
  });
});

describe('routing', () => {
  it('routes the tree tools to their handlers with the Lua context', async () => {
    const { calls, context } = fakeContext({ nodePower: report(), listTattoos: list });
    const deps = {
      contextBuilder: {
        buildLuaContext: () => context, buildHandlerContext: () => ({}), buildWatchContext: () => ({}),
        buildItemSkillContext: () => ({}), buildOptimizationContext: () => ({}), buildExportContext: () => ({}),
        buildSkillGemContext: () => ({}), buildValidationContext: () => ({}),
      },
      tradeClient: null, statMapper: null, recommendationEngine: null, ninjaClient: {},
      getLuaClient: context.getLuaClient, ensureLuaClient: context.ensureLuaClient,
    };
    await routeToolCall('get_node_power', { stat: 'Life', limit: 3 }, deps as never);
    await routeToolCall('list_tattoos', { node_id: 15064 }, deps as never);
    expect(calls.map((c) => c.method)).toEqual(['nodePower', 'listTattoos']);
    expect((calls[0].params as { limit: number }).limit).toBe(3);
  });
});
