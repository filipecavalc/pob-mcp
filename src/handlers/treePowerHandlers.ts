/**
 * Tree tab features of Path of Building, run by PoB's own code through the
 * Lua bridge (lua/pob_ops.lua):
 *   - get_node_power: the node power report ("Show Node Power" / "Show Power Report")
 *   - find_timeless_jewel: the "Find Timeless Jewel" dialog, with its trade URL
 *   - list_tattoos / apply_tattoo / remove_tattoos: the tattoo editor and
 *     "Remove All Tattoos"
 */
import type { PoBLuaApiClient } from '../pobLuaBridge.js';
import { wrapHandler } from '../utils/errorHandling.js';
import type {
  NodePowerEntry, NodePowerParams, NodePowerReport, TimelessDesiredNode, TimelessOptions,
  TimelessSearchParams, TimelessSearchResult, TreeChangeStats,
} from '../types/treePower.js';

export interface TreePowerContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

type TextResponse = { content: Array<{ type: 'text'; text: string }> };
const text = (lines: string[]): TextResponse => ({ content: [{ type: 'text' as const, text: lines.join('\n') }] });

async function client(context: TreePowerContext): Promise<PoBLuaApiClient> {
  await context.ensureLuaClient();
  const lua = context.getLuaClient();
  if (!lua) throw new Error('Lua bridge not active. Use lua_start and lua_load_build first.');
  return lua;
}

/** PoB's printf format for the stat (BuildDisplayStats fmt: "d", ".1f", ".0f", ...). */
export function formatPower(value: number, fmt: string): string {
  const fixed = fmt.match(/\.(\d)f/);
  const decimals = fixed ? Number(fixed[1]) : /d/.test(fmt) ? 0 : 1;
  const sign = value > 0 ? '+' : '';
  const percent = fmt.includes('%%') ? '%' : '';
  return sign + value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + percent;
}

function formatPoints(points: number | string): string {
  if (points === 1000) return 'anoint only';
  if (typeof points === 'number') return `${points} point${points === 1 ? '' : 's'}`;
  return String(points).toLowerCase();
}

// ---------------------------------------------------------------- node power

export interface GetNodePowerArgs {
  stat?: string;
  max_depth?: number;
  filter?: NodePowerParams['filter'];
  sort_by?: NodePowerParams['sortBy'];
  types?: string[];
  show_masteries?: boolean;
  limit?: number;
}

export function formatNodePowerReport(report: NodePowerReport, wallMs?: number): string[] {
  const percentOfBase = (entry: NodePowerEntry) =>
    report.scale === 1 && report.base !== 0 ? ` (${entry.power >= 0 ? '+' : ''}${(entry.power / Math.abs(report.base) * 100).toFixed(2)}%)` : '';
  const baseShown = (report.base * report.scale).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const lines = [
    `=== Node Power: ${report.label} (${report.stat}) ===`,
    `PoB's power report (Tree tab > Show Node Power > Show Power Report). Base ${report.label}: ${baseShown}${report.scale === 100 ? ' (x100, as PoB shows it)' : ''}`,
    `Depth: ${report.maxDepth ?? 'all'} | filter: ${report.filter}${report.showMasteries ? '' : ', no masteries'} | sorted by: ${report.sortBy}${report.lowerIsBetter ? ' (lower is better)' : ''}`,
    `PoB's power builder ran in ${report.seconds.toFixed(1)} s${wallMs !== undefined ? ` (${(wallMs / 1000).toFixed(1)} s round trip)` : ''}; ${report.listed} of ${report.reportSize} report rows pass the filter, showing ${report.nodes.length}.`,
    '',
  ];
  if (!report.nodes.length) {
    lines.push(report.filter === 'allocated' ? 'No allocated nodes in the report.' : `No node gains ${report.label} within this depth.`);
  }
  report.nodes.forEach((entry, i) => {
    const power = `${formatPower(entry.power, report.fmt)}${percentOfBase(entry)}`;
    const perPoint = typeof entry.points === 'number' && entry.points !== 1000 ? ` | ${formatPower(entry.perPoint, report.fmt)} per point with its path` : '';
    lines.push(`${i + 1}. ${entry.name} [${entry.id}] ${entry.type}: ${power} | ${formatPoints(entry.points)}${perPoint}`);
    // A mastery row's name already holds its effect; its stat lines list every effect of the mastery.
    if (entry.stats.length && entry.type !== 'Mastery') lines.push(`   ${entry.stats.join('; ')}`);
    if (entry.path && entry.path.length > 1) lines.push(`   Path: ${entry.path.join(', ')}`);
  });
  lines.push('', report.filter === 'allocated'
    ? 'Allocated rows show what removing the node (with the nodes that depend on it) would change.'
    : 'Power = change from the node alone; per point = change from the node with its whole path, divided by the points. Allocate with update_tree_delta (add the path ids).');
  return lines;
}

export async function handleGetNodePower(context: TreePowerContext, args: GetNodePowerArgs): Promise<TextResponse> {
  return wrapHandler('get node power', async () => {
    const lua = await client(context);
    const started = Date.now();
    const report = await lua.nodePower({
      stat: args.stat,
      maxDepth: args.max_depth,
      filter: args.filter,
      sortBy: args.sort_by,
      types: args.types,
      showMasteries: args.show_masteries,
      limit: args.limit ?? 10,
    });
    return text(formatNodePowerReport(report, Date.now() - started));
  });
}

// ----------------------------------------------------------- timeless jewels

export interface FindTimelessJewelArgs {
  list_options?: boolean;
  jewel_type?: string | number;
  conqueror?: string | number;
  socket_id?: number | string;
  desired_nodes?: Array<{ node: string; weight?: number; weight2?: number; min_weight?: number; required?: boolean }>;
  search_list?: string;
  fallback_list?: string;
  fallback_stat?: string;
  socket_filter?: boolean;
  socket_filter_distance?: number;
  devotion_1?: string | number;
  devotion_2?: string | number;
  total_minimum_weight?: number;
  protect_nodes?: string[];
  abyss_ascendancy?: string;
  max_results?: number;
  league?: string;
  realm?: 'pc' | 'sony' | 'xbox';
  trade_type?: 'securable' | 'available' | 'onlineleague' | 'online' | 'any';
  search_more?: boolean;
  trade_pages?: number;
  start_rank?: number;
}

function socketParam(value: number | string | undefined): number | 'all' | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'all') return 'all';
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`socket_id must be a jewel socket node id or "all", got "${value}"`);
  return n === -1 ? 'all' : n;
}

export function timelessParams(args: FindTimelessJewelArgs): TimelessSearchParams {
  const desired: TimelessDesiredNode[] | undefined = args.desired_nodes?.map((d) => ({
    node: String(d.node), weight: d.weight, weight2: d.weight2, minWeight: d.min_weight, required: d.required,
  }));
  const params: TimelessSearchParams = {
    jewelType: args.jewel_type,
    conqueror: args.conqueror,
    socketId: socketParam(args.socket_id),
    desired,
    searchList: args.search_list,
    fallbackList: args.fallback_list,
    fallbackStat: args.fallback_stat,
    socketFilter: args.socket_filter,
    socketFilterDistance: args.socket_filter_distance,
    devotion1: args.devotion_1,
    devotion2: args.devotion_2,
    totalMinimumWeight: args.total_minimum_weight,
    protectNodes: args.protect_nodes,
    abyssAscendancy: args.abyss_ascendancy,
    maxResults: args.max_results ?? 10,
    optionsOnly: args.list_options === true,
  };
  if (args.league) {
    params.trade = {
      league: args.league,
      realm: args.realm,
      tradeType: args.trade_type,
      searchMore: args.search_more,
      pages: args.trade_pages,
      startRow: args.start_rank,
    };
  }
  return params;
}

export function formatTimelessOptions(options: TimelessOptions): string[] {
  const lines = [
    `=== Find Timeless Jewel: options for ${options.jewelType?.label ?? '?'} (PoB's dialog) ===`,
    '',
    `Jewel types: ${options.jewelTypes.map((t) => `${t.label} (${t.id})`).join(', ')}`,
    `Conquerors: ${options.conquerors.map((c) => c.label).join(', ')}`,
  ];
  if (options.jewelType?.id === 4) lines.push(`Devotion modifiers (devotion_1/devotion_2): ${options.devotionVariants.map((d) => d.label).join(', ')}`);
  if (options.jewelType?.id === 11) lines.push(`Required ascendancy outcome (abyss_ascendancy): ${options.abyssAscendancyOutcomes.map((a) => a.label).join(', ')}`);
  lines.push('', 'Jewel sockets (# = allocated):');
  for (const socket of options.sockets) lines.push(`  ${socket.id === -1 ? 'all' : socket.id}: ${socket.label}`);
  if (options.protectableNodes.length) lines.push('', `Protectable allocated notables (protect_nodes): ${options.protectableNodes.join(', ')}`);
  lines.push('', `Searchable nodes (desired_nodes[].node takes the id or the name), ${options.mods.length}:`);
  for (const mod of options.mods) lines.push(`  ${mod.id} | ${mod.name}${mod.stats?.length ? ` | ${mod.stats.join(' / ')}` : ''}`);
  lines.push('', `Fallback weight modes (fallback_stat): ${options.fallbackWeightModes.map((f) => f.stat ?? f.label).join(', ')}`);
  return lines;
}

export function formatTimelessSearch(result: TimelessSearchResult, wallMs?: number): string[] {
  const lines = [
    `=== Find Timeless Jewel: ${result.jewelType}, ${result.conqueror}, socket ${result.socket} ===`,
    `PoB searched in ${result.seconds.toFixed(2)} s${wallMs !== undefined ? ` (${(wallMs / 1000).toFixed(1)} s round trip)` : ''}: ${result.resultCount} seeds match, showing ${result.results.length}.`,
    '',
    'Desired nodes (weight, weight2):',
  ];
  for (const d of result.desired) lines.push(`  ${d.index}. ${d.name} [${d.id}] (${d.weight}, ${d.weight2})`);
  lines.push('');
  for (const row of result.results) {
    lines.push(`${row.rank}. Seed ${row.seed}${row.socket && result.socketId === -1 ? ` in ${row.socket}` : ''}: total weight ${Number(row.total.toFixed(3))}  [${row.row.trim()}]`);
    for (const match of row.matches) {
      if (match.nodes && match.nodes.length) lines.push(`   ${match.name}: ${match.nodes.join(', ')}`);
    }
  }
  if (!result.results.length) lines.push('No seed passes the weights and minimums.');
  if (result.trade) {
    lines.push('', `Trade search URLs (PoB's "Open Trade URL"; ${result.trade.realm}, ${result.trade.league}, ${result.trade.tradeType}${result.trade.searchMore ? ', search maximum' : ''}):`);
    if (!result.trade.urls.length) lines.push('  (no rows to search)');
    for (const page of result.trade.urls) {
      lines.push(`  Ranks ${page.fromRank}-${page.toRank} (${page.seeds.length} seed${page.seeds.length === 1 ? '' : 's'}):`, `  ${page.url}`);
    }
  }
  lines.push('', 'The search runs PoB\'s own finder; the build\'s saved finder settings are left as they were.');
  return lines;
}

export async function handleFindTimelessJewel(context: TreePowerContext, args: FindTimelessJewelArgs): Promise<TextResponse> {
  return wrapHandler('find timeless jewel', async () => {
    const lua = await client(context);
    const params = timelessParams(args);
    if (params.optionsOnly) {
      return text(formatTimelessOptions(await lua.findTimelessJewel({ ...params, optionsOnly: true })));
    }
    if (params.socketId === undefined) throw new Error('socket_id is required (a jewel socket node id, or "all"); list the sockets with list_options: true');
    if (!params.desired?.length && !params.searchList && !params.fallbackList && !params.fallbackStat && !params.abyssAscendancy) {
      throw new Error('give desired_nodes (or search_list, fallback_list, fallback_stat); list the searchable nodes with list_options: true');
    }
    const started = Date.now();
    const result = await lua.findTimelessJewel(params);
    return text(formatTimelessSearch(result, Date.now() - started));
  });
}

// ------------------------------------------------------------------- tattoos

const STAT_LABELS: Record<string, string> = {
  Life: 'Life', EnergyShield: 'Energy Shield', Mana: 'Mana', TotalEHP: 'Effective HP',
  CombinedDPS: 'Combined DPS', FullDPS: 'Full DPS', Str: 'Strength', Dex: 'Dexterity', Int: 'Intelligence',
};

export function formatStatChanges(before: TreeChangeStats, after: TreeChangeStats): string[] {
  const lines: string[] = [];
  for (const [key, label] of Object.entries(STAT_LABELS)) {
    const a = before[key];
    const b = after[key];
    if (a === undefined || b === undefined) continue;
    const delta = b - a;
    const round = (v: number) => Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Number(v.toFixed(2)).toString();
    const pct = a !== 0 && delta !== 0 ? ` (${delta > 0 ? '+' : ''}${(delta / Math.abs(a) * 100).toFixed(2)}%)` : '';
    lines.push(`  ${label}: ${round(a)} -> ${round(b)}${delta !== 0 ? ` ${delta > 0 ? '+' : ''}${round(delta)}${pct}` : ''}`);
  }
  return lines;
}

function nodeIdParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`node_id must be a passive node id, got "${String(value)}"`);
  return n;
}

export async function handleListTattoos(context: TreePowerContext, args: { node_id: number; include_legacy?: boolean }): Promise<TextResponse> {
  return wrapHandler('list tattoos', async () => {
    const lua = await client(context);
    const list = await lua.listTattoos({ nodeId: nodeIdParam(args.node_id), includeLegacy: args.include_legacy === true });
    const lines = [
      `=== Tattoos for ${list.node} [${list.nodeId}] (${list.type}, ${list.allocated ? 'allocated' : 'not allocated'}) ===`,
      `Current: ${list.current ? `${list.current.name} (${list.current.stats.join('; ')})` : 'none'} | build tattoo count: ${list.tattooCount ?? '?'}/${list.tattooLimit}`,
      `${list.options.length} option(s) from PoB's tattoo editor${args.include_legacy ? ', legacy tattoos included' : ' (include_legacy shows legacy ones)'}:`,
      '',
    ];
    for (const option of list.options) {
      const extra = [option.legacy ? 'legacy' : '', option.minimumConnected ? `needs ${option.minimumConnected} connected` : ''].filter(Boolean).join(', ');
      lines.push(`- ${option.name || '(unnamed)'}${extra ? ` [${extra}]` : ''}: ${option.stats.join('; ')}`);
    }
    return text(lines);
  });
}

export async function handleApplyTattoo(context: TreePowerContext, args: { node_id: number; tattoo: string; include_legacy?: boolean }): Promise<TextResponse> {
  return wrapHandler('apply tattoo', async () => {
    if (!args.tattoo || typeof args.tattoo !== 'string') throw new Error('tattoo is required (a name from list_tattoos)');
    const lua = await client(context);
    const result = await lua.applyTattoo({ nodeId: nodeIdParam(args.node_id), tattoo: args.tattoo, includeLegacy: args.include_legacy === true });
    const lines = [
      `=== Tattoo applied: ${result.applied?.name ?? result.tattoo} on ${result.node} [${result.nodeId}] ===`,
      `Stats: ${result.applied?.stats.join('; ') ?? '?'}`,
    ];
    if (result.replaced) lines.push(`Replaced: ${result.replaced.name}`);
    lines.push(`Build tattoo count: ${result.tattooCount}/${result.tattooLimit}${result.tattooCount > result.tattooLimit ? ' (over the limit PoB marks in red)' : ''}`);
    if (!result.allocated) lines.push('The node is not allocated, so the tattoo changes nothing until it is.');
    lines.push('', 'Stat changes (PoB main output):', ...formatStatChanges(result.before, result.after), '', 'The build in memory changed; save it with lua_save_build.');
    return text(lines);
  });
}

export async function handleRemoveTattoos(context: TreePowerContext, args: { node_id?: number; all?: boolean; confirm?: boolean }): Promise<TextResponse> {
  return wrapHandler('remove tattoos', async () => {
    if (args.all && args.node_id !== undefined) throw new Error('give node_id or all, not both');
    if (!args.all && args.node_id === undefined) throw new Error('give node_id (one tattoo) or all: true ("Remove All Tattoos")');
    if (args.all && args.confirm !== true) {
      throw new Error('removing all tattoos needs confirm: true (PoB warns it cannot be undone)');
    }
    const lua = await client(context);
    const result = await lua.removeTattoos(args.all ? { all: true } : { nodeId: nodeIdParam(args.node_id) });
    const lines = [
      `=== ${args.all ? 'Remove All Tattoos' : 'Tattoo removed'}: ${result.removed.length} removed, ${result.remaining} left ===`,
    ];
    for (const entry of result.removed) lines.push(`- ${entry.tattoo} from ${entry.node ?? '?'} [${entry.nodeId}]`);
    if (!result.removed.length) lines.push('The build had no tattoos.');
    lines.push('', 'Stat changes (PoB main output):', ...formatStatChanges(result.before, result.after), '', 'The build in memory changed; save it with lua_save_build.');
    return text(lines);
  });
}
