/**
 * Shapes returned by the Compare tab actions (lua/pob_ops.lua, compare_*).
 * Each mirrors what PoB's Compare tab (Classes/CompareTab.lua) shows.
 */

export interface CompareSetEntry {
  index: number;
  id?: number;
  title: string;
  active: boolean;
}

export interface CompareEntryInfo {
  index: number;
  label: string;
  active: boolean;
  className?: string;
  ascendClassName?: string;
  level?: number;
  treeVersion?: string;
  treeSets: CompareSetEntry[];
  itemSets: CompareSetEntry[];
  skillSets: CompareSetEntry[];
  configSets: CompareSetEntry[];
  mainSocketGroup?: number;
  calcsSocketGroup?: number;
  calcsBuffMode?: string;
  socketGroups: Array<{ index: number; label: string; enabled: boolean }>;
  stats: Record<string, number | undefined>;
}

export interface CompareList {
  primary: { name?: string; className?: string; ascendClassName?: string; level?: number };
  activeIndex: number;
  entries: CompareEntryInfo[];
  removed?: string;
}

export interface CompareImportResult {
  entry: CompareEntryInfo;
  count: number;
}

export interface CompareSelectResult {
  entry: CompareEntryInfo;
  changed: string[];
}

export interface CompareSelectParams {
  index?: number;
  tree_set?: number;
  item_set?: number;
  skill_set?: number;
  config_set?: number;
  main_socket_group?: number;
  calcs_socket_group?: number;
  calcs_buff_mode?: string;
  calcs_show_minion?: boolean;
}

export interface CompareStatRow {
  label: string;
  stat?: string;
  childStat?: string;
  primary?: number;
  compare?: number;
  primaryText: string;
  compareText: string;
  diff?: number;
  diffText?: string;
  percent?: number;
  better?: boolean;
  lowerIsBetter?: boolean;
}

export interface CompareTreeNode {
  id: number;
  name?: string;
  type?: string;
  status: 'compare_only' | 'primary_only' | 'differs';
  ascendancy?: string;
  clusterNode?: boolean;
  primaryEffect?: string;
  compareEffect?: string;
  primaryJewel?: string;
  compareJewel?: string;
}

export interface CompareTreeSide {
  className?: string;
  ascendClassName?: string;
  treeVersion?: string;
  pointsUsed?: number;
  ascendancyPointsUsed?: number;
  specTitle?: string;
}

export interface CompareItemSummary {
  id?: number;
  name?: string;
  title?: string;
  baseName?: string;
  rarity?: string;
  corrupted?: boolean;
}

export interface CompareModLine {
  text: string;
  marker?: '+' | '>' | '<';
}

export interface CompareItemRow {
  slot: string;
  slotName: string;
  status: string;
  primary?: CompareItemSummary;
  compare?: CompareItemSummary;
  nodeId?: number;
  primaryNodeAllocated?: boolean;
  compareNodeAllocated?: boolean;
  slotMissingInPrimary?: boolean;
  /** Same item text on both sides (PoB's label says "match" on equal names only). */
  identical?: boolean;
  primaryMods?: CompareModLine[];
  compareMods?: CompareModLine[];
  equipStatChanges?: string[];
}

export interface CompareGemEntry {
  name: string;
  status: 'common' | 'additional' | 'missing';
  level?: number;
  quality?: number;
  enabled?: boolean;
  support?: boolean;
  imbued?: boolean;
}

export interface CompareGroupRef {
  index: number;
  label: string;
  enabled: boolean;
  main: boolean;
}

export interface CompareSkillPair {
  primaryGroup?: CompareGroupRef;
  compareGroup?: CompareGroupRef;
  similarity?: number;
  primaryGems: CompareGemEntry[];
  compareGems: CompareGemEntry[];
  differs: boolean;
}

export interface CompareConfigRow {
  var: string;
  label: string;
  primary: string;
  compare: string;
  differs?: boolean;
}

export interface CompareCalcsRow {
  label: string;
  primary?: string;
  compare?: string;
}

export interface CompareCalcsSubSection {
  label: string;
  rows: CompareCalcsRow[];
  primaryExtra?: string;
  compareExtra?: string;
}

type SectionError = { error: string };

export interface CompareReport {
  primaryName: string;
  compareName: string;
  index: number;
  onlyDifferences: boolean;
  stats?: { minionStats: boolean; rows: CompareStatRow[] } | SectionError;
  tree?: {
    primary: CompareTreeSide;
    compare: CompareTreeSide;
    compareOnly: CompareTreeNode[];
    primaryOnly: CompareTreeNode[];
    differs: CompareTreeNode[];
    sharedCount: number;
  } | SectionError;
  items?: { primaryItemSet: string; compareItemSet: string; slots: CompareItemRow[]; jewels: CompareItemRow[] } | SectionError;
  skills?: { primarySkillSet: string; compareSkillSet: string; pairs: CompareSkillPair[] } | SectionError;
  config?: {
    primaryConfigSet: string;
    compareConfigSet: string;
    differences: number;
    sections: Array<{ name: string; diffCount: number; rows: CompareConfigRow[] }>;
  } | SectionError;
  calcs?: {
    primarySkill?: string;
    compareSkill?: string;
    primaryBuffMode?: string;
    compareBuffMode?: string;
    primaryShowsMinion: boolean;
    compareShowsMinion: boolean;
    rowCount: number;
    sections: Array<{ id: string; group?: number; subSections: CompareCalcsSubSection[] }>;
  } | SectionError;
}

export type CompareSection = 'stats' | 'tree' | 'items' | 'skills' | 'config' | 'calcs';

export interface CompareReportParams {
  index?: number;
  sections?: CompareSection[];
  only_differences?: boolean;
  items_expanded?: boolean;
  item_stat_changes?: boolean;
  config_show_all?: boolean;
  calcs_filter?: string;
}

export interface ComparePowerMetric {
  stat: string;
  label: string;
}

export interface ComparePowerRow {
  category: string;
  name: string;
  impact: number;
  percent?: number;
  impactText: string;
  points?: number;
  perPoint?: number;
  perPointText?: string;
  nodeId?: number;
  slotName?: string;
}

export interface ComparePowerReport {
  /** Present when no (or an unknown) metric was given: the dropdown's choices. */
  metrics?: ComparePowerMetric[];
  needsMetric?: boolean;
  unknownMetric?: string;
  metric?: ComparePowerMetric;
  categories?: Record<string, boolean>;
  compareName?: string;
  index?: number;
  total?: number;
  status?: string;
  rows?: ComparePowerRow[];
}

export interface ComparePowerParams {
  index?: number;
  metric?: string;
  categories?: { tree?: boolean; items?: boolean; skill_gems?: boolean; support_gems?: boolean; config?: boolean };
  sort_by?: 'category' | 'impact' | 'points' | 'per_point';
  limit?: number;
}

export interface CompareBuySimilarParams {
  index?: number;
  slot: string;
  league?: string;
  realm?: 'pc' | 'sony' | 'xbox';
  listed?: 'securable' | 'available' | 'online' | 'any';
  use_base_type?: boolean;
  ilvl_min?: number;
  ilvl_max?: number;
  mods?: 'all' | number[];
  mod_values?: Record<string, { min?: number; max?: number }>;
  defences?: 'all' | string[];
  defence_values?: Record<string, { min?: number; max?: number }>;
}

export interface CompareBuySimilarResult {
  url: string;
  item: CompareItemSummary;
  slot: string;
  unique: boolean;
  category?: string;
  categoryLabel?: string;
  realm: string;
  league: string;
  listed: string;
  mods: Array<{
    index: number; type: string; text: string; searchable: boolean; selected: boolean;
    option?: boolean; tradeIds: string[]; value?: number | string; min?: number; max?: number;
  }>;
  skippedMods: number[];
  defences: Array<{ label: string; tradeKey: string; value: number; selected: boolean; min?: number; max?: number }>;
  compareName: string;
  index: number;
}

export interface CompareCopyParams {
  index?: number;
  what: 'tree' | 'item' | 'config';
  slot?: string;
  use?: boolean;
}

export interface CompareCopyResult {
  what: string;
  used: boolean;
  compareName: string;
  index: number;
  specIndex?: number;
  specTitle?: string;
  activeSpec?: number;
  item?: CompareItemSummary;
  slot?: string;
  equipped?: boolean;
  configSet?: string;
  stats: Record<string, number | undefined>;
}
