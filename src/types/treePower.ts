/**
 * Results of the Tree tab actions of the Lua bridge (lua/pob_ops.lua):
 * node_power, find_timeless_jewel, list_tattoos, apply_tattoo, remove_tattoos.
 */

/** One row of PoB's Power Report (TreeTab:BuildPowerReportList). */
export interface NodePowerEntry {
  id: number;
  name: string;
  type: string;
  /** Stat change from this node alone, scaled like PoB's report (percent stats x100). */
  power: number;
  /** PoB's "Per Point": the change from the node with its whole path, divided by points. */
  perPoint: number;
  /** PoB's "Points" column: path cost. 1000 is PoB's "Anoint" (no path); "Cluster" for cluster notables. */
  points: number | string;
  allocated: boolean;
  /** Node ids PoB would allocate to reach the node (the node itself included). */
  path?: number[];
  stats: string[];
}

export interface NodePowerReport {
  stat: string;
  label: string;
  /** The stat's value in the base output the power builder compares against. */
  base: number;
  /** 100 when PoB shows the stat as a percentage (power values are already scaled). */
  scale: number;
  fmt: string;
  lowerIsBetter: boolean;
  maxDepth?: number;
  filter: string;
  sortBy: string;
  showMasteries: boolean;
  /** Rows PoB's list shows with these filters. */
  listed: number;
  /** All rows of PoB's report before filtering. */
  reportSize: number;
  /** Lua os.clock() time spent in CalcsTab:PowerBuilder. */
  seconds: number;
  /** Times the power builder coroutine was resumed. */
  resumes: number;
  nodes: NodePowerEntry[];
}

export interface NodePowerParams {
  stat?: string;
  maxDepth?: number;
  filter?: 'unallocated' | 'unallocated_and_clusters' | 'allocated';
  showMasteries?: boolean;
  sortBy?: 'power' | 'per_point' | 'points' | 'type';
  types?: string[];
  limit?: number;
}

export interface TimelessDesiredNode {
  /** Mod id from the finder's "Search for Node" list, or its name. */
  node: string;
  weight?: number;
  weight2?: number;
  minWeight?: number;
  required?: boolean;
}

export interface TimelessSearchParams {
  jewelType?: string | number;
  conqueror?: string | number;
  socketId?: number | 'all';
  desired?: TimelessDesiredNode[];
  searchList?: string;
  fallbackList?: string;
  fallbackStat?: string;
  socketFilter?: boolean;
  socketFilterDistance?: number;
  devotion1?: string | number;
  devotion2?: string | number;
  totalMinimumWeight?: number;
  protectNodes?: string[];
  abyssAscendancy?: string;
  maxResults?: number;
  optionsOnly?: boolean;
  trade?: {
    league: string;
    realm?: 'pc' | 'sony' | 'xbox';
    tradeType?: 'securable' | 'available' | 'onlineleague' | 'online' | 'any';
    searchMore?: boolean;
    pages?: number;
    startRow?: number;
  };
}

export interface TimelessOption { id?: number | string; label: string }

export interface TimelessOptions {
  jewelTypes: TimelessOption[];
  jewelType: TimelessOption;
  conquerors: TimelessOption[];
  sockets: Array<{ id: number; label: string; keystone: string; allocated: boolean }>;
  devotionVariants: TimelessOption[];
  abyssAscendancyOutcomes: TimelessOption[];
  fallbackWeightModes: Array<{ index: number; label: string; stat?: string }>;
  protectableNodes: string[];
  mods: Array<{ id: string; name: string; stats?: string[]; totalMod?: boolean }>;
}

export interface TimelessSearchResult {
  jewelType: string;
  jewelTypeId: number;
  conqueror: string;
  socket: string;
  socketId: number;
  searchList?: string;
  searchListFallback?: string;
  desired: Array<{ id: string; name: string; index: number; weight: number; weight2: number }>;
  resultCount: number;
  seconds: number;
  results: Array<{
    rank: number;
    seed: number;
    total: number;
    socketId?: number;
    socket?: string;
    /** The row as PoB's result list shows it: seed, then each desired node's weight. */
    row: string;
    matches: Array<{ id: string; name: string; nodes?: string[] }>;
  }>;
  trade?: {
    league: string;
    realm: string;
    tradeType: string;
    searchMore: boolean;
    urls: Array<{ url: string; fromRank: number; toRank: number; seeds: number[] }>;
  };
}

export interface TattooOption {
  id: string;
  name: string;
  stats: string[];
  targetType?: string;
  minimumConnected?: number;
  legacy: boolean;
}

export interface TattooList {
  nodeId: number;
  node: string;
  type: string;
  allocated: boolean;
  current?: { name: string; stats: string[] };
  tattooCount?: number;
  tattooLimit: number;
  options: TattooOption[];
}

export type TreeChangeStats = Record<string, number>;

export interface TattooApplied {
  nodeId: number;
  node: string;
  tattoo: string;
  applied?: { name: string; stats: string[] };
  replaced?: { name: string; stats: string[] };
  /** A tattoo on an unallocated node changes nothing until the node is allocated. */
  allocated: boolean;
  tattooCount: number;
  tattooLimit: number;
  before: TreeChangeStats;
  after: TreeChangeStats;
}

export interface TattoosRemoved {
  removed: Array<{ nodeId: number; node?: string; tattoo: string }>;
  remaining: number;
  before: TreeChangeStats;
  after: TreeChangeStats;
}
