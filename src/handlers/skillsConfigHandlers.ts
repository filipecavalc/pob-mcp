/**
 * Skills tab, config tab and minion tools: gems ranked by Path of Building's
 * own "Sort gems by DPS", skill sets, config sets, the spectre library, the
 * main skill's minion, and the config tab's custom modifiers. The work runs in
 * PoB's Lua (lua/pob_ops.lua); these handlers validate arguments and format.
 */
import { wrapHandler } from "../utils/errorHandling.js";
import { formatDelta, formatStat } from "./luaHandlers.js";
import type {
  ConfigSetList, CustomModsState, GemDpsRanking, GemSortField, MinionOptions, PoBLuaApiClient, RankGemsParams,
  SkillSetList, SpectreList, SpectreSearchMode, StatsExport,
} from "../pobLuaBridge.js";

export interface SkillsConfigContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const text = (lines: string[]): ToolResult => ({ content: [{ type: "text" as const, text: lines.join("\n") }] });

async function client(context: SkillsConfigContext): Promise<PoBLuaApiClient> {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error("Lua bridge not active. Use lua_start and lua_load_build first.");
  return luaClient;
}

/** Stats shown before/after a change that affects the calculation. */
const CHANGE_STATS: Array<{ key: string; label: string }> = [
  { key: "CombinedDPS", label: "Combined DPS" },
  { key: "FullDPS", label: "Full DPS" },
  { key: "Life", label: "Life" },
  { key: "EnergyShield", label: "Energy Shield" },
  { key: "TotalEHP", label: "Effective HP" },
  { key: "MinionCombinedDPS", label: "Minion Combined DPS" },
  { key: "MinionLife", label: "Minion Life" },
];

const readStats = (luaClient: PoBLuaApiClient): Promise<StatsExport> =>
  luaClient.getStats(CHANGE_STATS.map((s) => s.key)).catch(() => ({}) as StatsExport);

function statChanges(before: StatsExport, after: StatsExport): string[] {
  const lines: string[] = [];
  for (const { key, label } of CHANGE_STATS) {
    const a = Number(before[key]);
    const b = Number(after[key]);
    if (!Number.isFinite(b) || (b === 0 && !(a > 0))) continue;
    if (!Number.isFinite(a) || a === b) {
      lines.push(`  ${label}: ${formatStat(b)}`);
    } else {
      lines.push(`  ${label}: ${formatStat(a)} -> ${formatStat(b)} (${formatDelta(b - a, a)})`);
    }
  }
  return lines.length > 0 ? ["", "Stats (PoB):", ...lines] : [];
}

function requireConfirm(confirm: unknown, what: string): void {
  if (confirm !== true) {
    throw new Error(`Refusing to ${what} without confirm: true. This cannot be undone through the MCP; save the build first if you may want it back.`);
  }
}

function requireId(value: unknown, name: string): number {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

// ---------------------------------------------------------------------------
// Gems ranked by PoB's DPS sort
// ---------------------------------------------------------------------------

export interface RankGemsArgs {
  group_index?: number;
  gem_index?: number;
  dps_field?: string;
  gem_type?: string;
  search?: string;
  default_gem_level?: string;
  default_gem_quality?: number;
  show_support_types?: string;
  show_legacy_gems?: boolean;
  include_unevaluated?: boolean;
  limit?: number;
}

const GEM_SORT_FIELDS: GemSortField[] = ["FullDPS", "CombinedDPS", "TotalDPS", "AverageDamage", "TotalDot", "BleedDPS",
  "IgniteDPS", "TotalPoisonDPS", "TotalEHP"];

export function formatGemRanking(r: GemDpsRanking): string[] {
  const slot = r.replaces ? `gem slot ${r.gemIndex} (replacing ${r.replaces})` : `a new gem slot (${r.gemIndex})`;
  const lines = [
    `=== Gems ranked by PoB's DPS sort: group ${r.groupIndex}${r.groupLabel ? ` "${r.groupLabel}"` : ""}, ${slot} ===`,
    `Skills in the group: ${r.activeSkills.length > 0 ? r.activeSkills.join(", ") : "none"}`,
    `Sort field: ${r.dpsField} | gems: ${r.gemType}${r.search ? ` | search "${r.search}"` : ""} | gem level: ${r.defaultGemLevel}, quality ${r.defaultGemQuality}`,
    `Base ${r.dpsField}: ${formatStat(r.baseDPS)}`,
  ];
  if (r.dpsField !== "FullDPS" && r.groupIndex !== r.mainSocketGroup) {
    lines.push(`Note: ${r.dpsField} is the main skill's (group ${r.mainSocketGroup}), as in PoB; use dps_field FullDPS or set_main_skill to rank for this group's skill.`);
  }
  if (r.dpsField === "FullDPS" && r.baseDPS === 0) {
    lines.push("Note: Full DPS is 0: PoB counts only socket groups included in Full DPS (Ctrl+right-click a group in PoB's Skills tab).");
  }
  lines.push(`PoB calculated ${r.evaluatedCount} of ${r.listedCount} listed gems (the rest cannot affect this group's skills and show the base value).`, "");
  if (r.candidates.length === 0) {
    lines.push("No gems to show.");
    return lines;
  }
  for (const c of r.candidates) {
    const change = c.evaluated ? formatDelta(c.delta, r.baseDPS) : "not calculated";
    const tag = c.support ? (c.canSupport ? "" : " [cannot support]") : " [active]";
    lines.push(`${String(c.position).padStart(3)}. ${c.name} (lvl ${c.level})${tag}: ${formatStat(c.dps)}  ${change}`);
  }
  return lines;
}

export async function handleRankGemsByDps(context: SkillsConfigContext, args: RankGemsArgs = {}) {
  return wrapHandler("rank gems by DPS", async () => {
    if (args.dps_field !== undefined && !GEM_SORT_FIELDS.includes(args.dps_field as GemSortField)) {
      throw new Error(`dps_field must be one of ${GEM_SORT_FIELDS.join(", ")}`);
    }
    const luaClient = await client(context);
    const params: RankGemsParams = {
      groupIndex: args.group_index,
      gemIndex: args.gem_index,
      dpsField: args.dps_field as GemSortField | undefined,
      gemType: args.gem_type as RankGemsParams["gemType"],
      search: args.search,
      defaultGemLevel: args.default_gem_level as RankGemsParams["defaultGemLevel"],
      defaultGemQuality: args.default_gem_quality,
      showSupportGemTypes: args.show_support_types as RankGemsParams["showSupportGemTypes"],
      showLegacyGems: args.show_legacy_gems,
      includeUnevaluated: args.include_unevaluated,
      limit: args.limit,
    };
    const ranking = await luaClient.rankGemsByDps(params);
    return text(formatGemRanking(ranking));
  });
}

// ---------------------------------------------------------------------------
// Skill sets and config sets
// ---------------------------------------------------------------------------

function formatSkillSets(list: SkillSetList, header: string): string[] {
  const lines = [header, ""];
  for (const s of list.skillSets) {
    lines.push(`${s.active ? ">" : " "} [id ${s.id}] ${s.title} (${s.socketGroups} socket group${s.socketGroups === 1 ? "" : "s"})`);
  }
  lines.push("", `Active skill set: id ${list.activeSkillSetId}.`);
  return lines;
}

function formatConfigSets(list: ConfigSetList, header: string): string[] {
  const lines = [header, ""];
  for (const s of list.configSets) {
    lines.push(`${s.active ? ">" : " "} [id ${s.id}] ${s.title} (${s.customModGroups} custom modifier group${s.customModGroups === 1 ? "" : "s"})`);
  }
  lines.push("", `Active config set: id ${list.activeConfigSetId}.`);
  return lines;
}

export async function handleListSkillSets(context: SkillsConfigContext) {
  return wrapHandler("list skill sets", async () => {
    const list = await (await client(context)).listSkillSets();
    return text(formatSkillSets(list, `=== Skill sets (${list.skillSets.length}) ===`));
  });
}

export async function handleSelectSkillSet(context: SkillsConfigContext, args: { id?: number }) {
  return wrapHandler("select skill set", async () => {
    const id = requireId(args.id, "id");
    const luaClient = await client(context);
    const before = await readStats(luaClient);
    const list = await luaClient.selectSkillSet(id);
    const after = await readStats(luaClient);
    return text([...formatSkillSets(list, `Switched to skill set id ${id}.`), ...statChanges(before, after)]);
  });
}

export async function handleCreateSkillSet(context: SkillsConfigContext, args: { title?: string; copy_from?: number; activate?: boolean }) {
  return wrapHandler("create skill set", async () => {
    if (typeof args.title !== "string" || !args.title.trim()) throw new Error("title is required");
    const luaClient = await client(context);
    const list = await luaClient.createSkillSet({
      title: args.title,
      copyFrom: args.copy_from === undefined ? undefined : requireId(args.copy_from, "copy_from"),
      activate: args.activate === true,
    });
    const how = args.copy_from !== undefined ? `as a copy of id ${args.copy_from}` : "empty";
    return text(formatSkillSets(list, `Created skill set id ${list.created} "${args.title}" (${how})${args.activate ? " and switched to it" : ""}.`));
  });
}

export async function handleRenameSkillSet(context: SkillsConfigContext, args: { id?: number; title?: string }) {
  return wrapHandler("rename skill set", async () => {
    const id = requireId(args.id, "id");
    if (typeof args.title !== "string") throw new Error("title is required");
    const list = await (await client(context)).renameSkillSet(id, args.title);
    return text(formatSkillSets(list, `Renamed skill set id ${id} to "${args.title}".`));
  });
}

export async function handleDeleteSkillSet(context: SkillsConfigContext, args: { id?: number; confirm?: boolean }) {
  return wrapHandler("delete skill set", async () => {
    const id = requireId(args.id, "id");
    requireConfirm(args.confirm, `delete skill set id ${id}`);
    const luaClient = await client(context);
    const before = await readStats(luaClient);
    const list = await luaClient.deleteSkillSet(id);
    const after = await readStats(luaClient);
    const name = list.deleted ? ` "${list.deleted.title}"` : "";
    return text([...formatSkillSets(list, `Deleted skill set id ${id}${name}.`), ...statChanges(before, after)]);
  });
}

export async function handleListConfigSets(context: SkillsConfigContext) {
  return wrapHandler("list config sets", async () => {
    const list = await (await client(context)).listConfigSets();
    return text(formatConfigSets(list, `=== Config sets (${list.configSets.length}) ===`));
  });
}

export async function handleSelectConfigSet(context: SkillsConfigContext, args: { id?: number }) {
  return wrapHandler("select config set", async () => {
    const id = requireId(args.id, "id");
    const luaClient = await client(context);
    const before = await readStats(luaClient);
    const list = await luaClient.selectConfigSet(id);
    const after = await readStats(luaClient);
    return text([...formatConfigSets(list, `Switched to config set id ${id}.`), ...statChanges(before, after)]);
  });
}

export async function handleCreateConfigSet(context: SkillsConfigContext, args: { title?: string; copy_from?: number; activate?: boolean }) {
  return wrapHandler("create config set", async () => {
    if (typeof args.title !== "string" || !args.title.trim()) throw new Error("title is required");
    const luaClient = await client(context);
    const before = args.activate ? await readStats(luaClient) : undefined;
    const list = await luaClient.createConfigSet({
      title: args.title,
      copyFrom: args.copy_from === undefined ? undefined : requireId(args.copy_from, "copy_from"),
      activate: args.activate === true,
    });
    const how = args.copy_from !== undefined ? `as a copy of id ${args.copy_from}` : "with PoB's default settings";
    const lines = formatConfigSets(list, `Created config set id ${list.created} "${args.title}" (${how})${args.activate ? " and switched to it" : ""}.`);
    if (before) lines.push(...statChanges(before, await readStats(luaClient)));
    return text(lines);
  });
}

export async function handleRenameConfigSet(context: SkillsConfigContext, args: { id?: number; title?: string }) {
  return wrapHandler("rename config set", async () => {
    const id = requireId(args.id, "id");
    if (typeof args.title !== "string") throw new Error("title is required");
    const list = await (await client(context)).renameConfigSet(id, args.title);
    return text(formatConfigSets(list, `Renamed config set id ${id} to "${args.title}".`));
  });
}

export async function handleDeleteConfigSet(context: SkillsConfigContext, args: { id?: number; confirm?: boolean }) {
  return wrapHandler("delete config set", async () => {
    const id = requireId(args.id, "id");
    requireConfirm(args.confirm, `delete config set id ${id}`);
    const luaClient = await client(context);
    const before = await readStats(luaClient);
    const list = await luaClient.deleteConfigSet(id);
    const after = await readStats(luaClient);
    const name = list.deleted ? ` "${list.deleted.title}"` : "";
    return text([...formatConfigSets(list, `Deleted config set id ${id}${name}.`), ...statChanges(before, after)]);
  });
}

// ---------------------------------------------------------------------------
// Spectres and the main skill's minion
// ---------------------------------------------------------------------------

function formatSpectres(list: SpectreList, header: string): string[] {
  const lines = [header, ""];
  if (list.spectres.length === 0) {
    lines.push("The build's spectre list is empty.");
  } else {
    lines.push(`Spectres in the build (${list.spectres.length}):`);
    for (const s of list.spectres) lines.push(`  ${s.index ?? "-"}. ${s.name} [${s.id}]${s.skills.length ? `: ${s.skills.join(", ")}` : ""}`);
  }
  if (list.library) {
    const lib = list.library;
    lines.push("", `Spectre library, search "${lib.search}" by ${lib.searchMode}: ${lib.total} match${lib.total === 1 ? "" : "es"}${lib.results.length < lib.total ? ` (showing ${lib.results.length})` : ""}`);
    for (const s of lib.results) lines.push(`  ${s.name} [${s.id}]${s.inBuild ? " (in build)" : ""}${s.skills.length ? `: ${s.skills.join(", ")}` : ""}`);
  }
  return lines;
}

export async function handleListSpectres(context: SkillsConfigContext, args: { search?: string; search_mode?: string; limit?: number } = {}) {
  return wrapHandler("list spectres", async () => {
    if (args.search_mode !== undefined && !["names", "skills", "both"].includes(args.search_mode)) {
      throw new Error("search_mode must be names, skills or both");
    }
    const list = await (await client(context)).listSpectres({
      search: args.search,
      searchMode: args.search_mode as SpectreSearchMode | undefined,
      limit: args.limit,
    });
    return text(formatSpectres(list, "=== Spectre library ==="));
  });
}

const stringList = (value: unknown, name: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`${name} must be an array of spectre names or ids`);
  return value as string[];
};

export async function handleSetSpectres(context: SkillsConfigContext, args: { add?: unknown; remove?: unknown }) {
  return wrapHandler("set spectres", async () => {
    const add = stringList(args.add, "add");
    const remove = stringList(args.remove, "remove");
    if (!add?.length && !remove?.length) throw new Error("give add and/or remove");
    const luaClient = await client(context);
    const before = await readStats(luaClient);
    const list = await luaClient.setSpectres({ add, remove });
    const after = await readStats(luaClient);
    const parts: string[] = [];
    if (list.added?.length) parts.push(`added ${list.added.length}`);
    if (list.removed?.length) parts.push(`removed ${list.removed.length}`);
    if (list.alreadyInBuild?.length) parts.push(`${list.alreadyInBuild.length} already in the build`);
    return text([...formatSpectres(list, `Spectre list updated: ${parts.join(", ") || "no change"}.`), ...statChanges(before, after)]);
  });
}

export function formatMinionOptions(m: MinionOptions): string[] {
  const where = m.calcs ? "Calcs tab" : "sidebar";
  const lines = [`=== Main skill minion (${where}): group ${m.groupIndex}, ${m.skill} ===`];
  if (!m.hasMinion) {
    lines.push("The main skill has no minion to choose.");
    return lines;
  }
  if (m.selectsItemSet) {
    lines.push("The minion uses an item set:");
    for (const o of m.options ?? []) lines.push(`  ${o.itemSetId === m.selectedItemSetId ? ">" : " "} [item set ${o.itemSetId}] ${o.label}`);
  } else {
    lines.push(m.usesSpectreLibrary ? "Minions (the build's spectre list):" : "Minions:");
    if (!m.options?.length) lines.push("  <No spectres in build> (add some with set_spectres)");
    for (const o of m.options ?? []) lines.push(`  ${o.minionId === m.selectedMinion ? ">" : " "} ${o.label} [${o.minionId}]`);
  }
  if (m.minionSkills?.length) {
    lines.push("Minion skills:");
    for (const s of m.minionSkills) lines.push(`  ${s.index === m.selectedMinionSkill ? ">" : " "} ${s.index}. ${s.name}`);
  }
  return lines;
}

export async function handleGetMinionOptions(context: SkillsConfigContext, args: { calcs?: boolean } = {}) {
  return wrapHandler("get minion options", async () => {
    const options = await (await client(context)).getMinionOptions({ calcs: args.calcs === true });
    return text(formatMinionOptions(options));
  });
}

export async function handleSetMinion(context: SkillsConfigContext, args: { calcs?: boolean; minion?: string; item_set_id?: number; minion_skill?: number | string }) {
  return wrapHandler("set minion", async () => {
    if (args.minion === undefined && args.item_set_id === undefined && args.minion_skill === undefined) {
      throw new Error("give minion, item_set_id or minion_skill");
    }
    const luaClient = await client(context);
    const before = await readStats(luaClient);
    const options = await luaClient.setMinion({
      calcs: args.calcs === true,
      minion: args.minion,
      itemSetId: args.item_set_id,
      minionSkill: args.minion_skill,
    });
    const after = await readStats(luaClient);
    return text([...formatMinionOptions(options), ...statChanges(before, after)]);
  });
}

// ---------------------------------------------------------------------------
// Custom modifiers
// ---------------------------------------------------------------------------

export function formatCustomMods(state: CustomModsState, header: string): string[] {
  const lines = [header, `Config set: id ${state.configSetId} "${state.configSetTitle}"`, ""];
  for (const g of state.groups) {
    lines.push(`[group ${g.index}] ${g.title} (${g.enabled ? "enabled" : "disabled"})`);
    if (g.lines.length === 0) lines.push("    (empty)");
    for (const l of g.lines) {
      lines.push(`    ${l.supported ? "ok " : "-- "} ${l.text}${l.supported ? "" : "  (PoB cannot parse this line; it has no effect)"}`);
    }
  }
  if (state.browser) {
    const b = state.browser;
    lines.push("", `Mod browser, search "${b.query}": ${b.total} modifier${b.total === 1 ? "" : "s"}${b.results.length < b.total ? ` (showing ${b.results.length})` : ""}`);
    for (const r of b.results) lines.push(`  ${r.supported ? "ok " : "-- "} ${r.text}`);
  }
  return lines;
}

export async function handleGetCustomMods(context: SkillsConfigContext, args: { search?: string; limit?: number } = {}) {
  return wrapHandler("get custom modifiers", async () => {
    const state = await (await client(context)).getCustomMods({ search: args.search, limit: args.limit });
    return text(formatCustomMods(state, "=== Custom modifiers ==="));
  });
}

export interface SetCustomModsArgs {
  group_index?: number;
  add_group?: boolean;
  remove_group?: boolean;
  title?: string;
  text?: string;
  append_mod?: string;
  enabled?: boolean;
  confirm?: boolean;
}

export async function handleSetCustomMods(context: SkillsConfigContext, args: SetCustomModsArgs = {}) {
  return wrapHandler("set custom modifiers", async () => {
    if (args.remove_group === true) {
      if (args.group_index === undefined) throw new Error("remove_group needs group_index");
      requireConfirm(args.confirm, `remove custom modifier group ${args.group_index}`);
    }
    const luaClient = await client(context);
    const before = await readStats(luaClient);
    const state = await luaClient.setCustomMods({
      groupIndex: args.group_index,
      addGroup: args.add_group,
      removeGroup: args.remove_group,
      title: args.title,
      text: args.text,
      appendMod: args.append_mod,
      enabled: args.enabled,
    });
    const after = await readStats(luaClient);
    const header = state.removed
      ? `Removed custom modifier group ${state.removed.index} "${state.removed.title}".`
      : `Updated custom modifier group ${state.groupIndex}.`;
    return text([...formatCustomMods(state, header), ...statChanges(before, after)]);
  });
}
