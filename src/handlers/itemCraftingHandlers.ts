/**
 * Items tab tools: crafting with PoB's own popups ("Craft item...", "Create
 * custom...", "Add modifier...", "Add Implicit...", "Corrupt...", "Change
 * Enchantment..."), the unique and rare template databases, item set
 * management and the shared item lists. The Lua side (lua/pob_ops.lua) opens
 * those popups and presses their buttons, so mod pools, labels and the item
 * text are PoB's. Crafting is item text in, item text out; equip_slot and
 * simulate_slot hand the result to the existing add_item and lua_simulate paths.
 */
import { wrapHandler } from "../utils/errorHandling.js";
import { handleLuaSimulate, type LuaHandlerContext } from "./luaHandlers.js";
import type { ItemsTabAction, PoBLuaApiClient } from "../pobLuaBridge.js";

export type ItemCraftingContext = Pick<LuaHandlerContext, "getLuaClient" | "ensureLuaClient"> & Partial<LuaHandlerContext>;

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export interface CraftedModLine {
  text: string;
  crafted?: boolean;
  custom?: boolean;
  fractured?: boolean;
  scourge?: boolean;
  crucible?: boolean;
  mutated?: boolean;
  exarch?: boolean;
  eater?: boolean;
  prefix?: boolean;
  suffix?: boolean;
  unsupported?: boolean;
  disabled?: boolean;
  range?: number;
  corruptedRange?: number;
}

export interface CraftedAffixSlot {
  modId: string;
  affix?: string;
  lines?: string[];
  level?: number;
  range?: number;
  fractured?: boolean;
}

/** describeItem in lua/pob_ops.lua */
export interface CraftedItem {
  text: string;
  name?: string;
  title?: string;
  baseName?: string;
  type?: string;
  rarity?: string;
  primarySlot?: string;
  quality?: number;
  itemLevel?: number;
  levelRequirement?: number;
  corrupted?: boolean;
  crafted?: boolean;
  influences?: string[];
  catalyst?: number;
  catalystQuality?: number;
  enchants?: CraftedModLine[];
  scourge?: CraftedModLine[];
  implicits?: CraftedModLine[];
  explicits?: CraftedModLine[];
  crucible?: CraftedModLine[];
  affixLimit?: number;
  prefixes?: CraftedAffixSlot[];
  suffixes?: CraftedAffixSlot[];
}

export interface ModOption {
  index: number;
  label?: string;
  /** "index:label" as PoB listed it; pickFromList checks it when it is used. */
  pick?: string;
  /** PoB's mod id where it has one (stable across calls). */
  id?: string;
  lines?: string[];
  type?: string;
  affix?: string;
  level?: number;
  group?: string;
  sortValue?: number;
  essence?: string;
  none?: boolean;
  modifierCount?: number;
  tiers?: Array<{ tier: number; modId: string; affix?: string; level?: number; lines?: string[] }>;
}

interface Source { label: string; id: string }

interface CraftResult {
  item?: CraftedItem;
  note?: string;
  source?: string | Source;
  sources?: Source[] | string[];
  options?: ModOption[];
  groups?: ModOption[];
  group?: string;
  matched?: number;
  sortBy?: string;
  added?: { lines?: string[] } | string;
  addedLabel?: string;
  addedId?: string;
  chosen?: string[];
  removed?: boolean;
  [key: string]: unknown;
}

/** Shared follow-up arguments of the crafting tools. */
export interface CraftFollowUp {
  equip_slot?: string;
  simulate_slot?: string;
}

async function client(context: ItemCraftingContext): Promise<PoBLuaApiClient> {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error("Lua bridge not active. Use lua_start and lua_load_build first.");
  return luaClient;
}

/** Drops undefined values so the Lua side sees only what the caller passed. */
function defined(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

const fmt = (value: number | undefined): string =>
  value === undefined ? "" : Math.abs(value) >= 100 ? Math.round(value).toLocaleString("en-US") : String(Math.round(value * 100) / 100);

function lineTags(line: CraftedModLine): string {
  const tags = (["crafted", "custom", "fractured", "scourge", "crucible", "mutated", "exarch", "eater"] as const)
    .filter((flag) => line[flag]);
  if (line.unsupported) tags.push("unsupported" as never);
  return tags.length ? ` (${tags.join(", ")})` : "";
}

/** Item summary plus PoB's item text, which the other tools take as item_text. */
export function formatCraftedItem(item: CraftedItem): string[] {
  const head = [item.rarity, item.title && item.title !== item.baseName ? `"${item.title}"` : undefined, item.baseName]
    .filter(Boolean).join(" ");
  const facts = [
    item.primarySlot ? `slot ${item.primarySlot}` : undefined,
    item.quality !== undefined ? `quality ${item.quality}` : undefined,
    item.levelRequirement ? `level ${item.levelRequirement}` : undefined,
    item.influences?.length ? item.influences.join(" + ") : undefined,
    item.corrupted ? "corrupted" : undefined,
  ].filter(Boolean).join(", ");
  const lines = [`Item: ${head}${facts ? ` (${facts})` : ""}`];
  const section = (title: string, mods?: CraftedModLine[]) => {
    if (mods?.length) lines.push(`  ${title}:`, ...mods.map((mod) => `    ${mod.text}${lineTags(mod)}`));
  };
  section("Enchants", item.enchants);
  section("Scourge", item.scourge);
  section("Implicits", item.implicits);
  section("Explicits", item.explicits);
  section("Crucible", item.crucible);
  if (item.prefixes && item.suffixes) {
    const slots = (kind: string, list: CraftedAffixSlot[]) => list.map((slot, i) =>
      `    ${kind} ${i + 1}: ${slot.modId === "None" ? "(empty)" : `${slot.affix ?? slot.modId} [${slot.modId}]${slot.range !== undefined ? ` roll ${fmt(slot.range)}` : ""}`}`);
    lines.push("  Affix slots:", ...slots("Prefix", item.prefixes), ...slots("Suffix", item.suffixes));
  }
  lines.push("", "Item text:", "```", item.text.trimEnd(), "```");
  return lines;
}

/**
 * How to name an option in a later call. PoB rebuilds and re-sorts these lists,
 * so a bare index is refused: pass the label text, an id, or "index:label"
 * exactly as listed (checked against the list at the time of the click).
 */
export const PICK_HINT = 'by text, [id] or "index:label" as listed; a bare index is refused';

function formatOption(option: ModOption): string {
  const parts = [`${option.index}. ${option.label ?? option.lines?.join(" / ") ?? ""}`];
  if (option.id) parts.push(`[${option.id}]`);
  const meta = [
    // Bench, veiled and delve labels already end in "(Prefix)" / "(Suffix)".
    option.type && !option.label?.includes(`(${option.type})`) ? option.type : undefined,
    option.affix ? `"${option.affix}"` : undefined,
    option.level !== undefined ? `L${option.level}` : undefined,
    option.modifierCount !== undefined ? `${option.modifierCount} modifiers` : undefined,
    option.sortValue !== undefined ? `sort value ${fmt(option.sortValue)}` : undefined,
  ].filter(Boolean);
  if (meta.length) parts.push(`(${meta.join(", ")})`);
  return parts.join(" ");
}

function formatOptions(options: ModOption[] | undefined, matched: number | undefined, withTiers = false): string[] {
  if (!options?.length) return ["  (no options)"];
  const lines: string[] = [];
  for (const option of options) {
    lines.push(`  ${formatOption(option)}`);
    if (option.tiers?.length) {
      if (withTiers) {
        for (const tier of option.tiers) {
          lines.push(`      T${tier.tier} ${tier.affix ?? ""} L${tier.level ?? "?"} [${tier.modId}]: ${tier.lines?.join(" / ") ?? ""}`);
        }
      } else {
        const best = option.tiers[0];
        lines.push(`      ${option.tiers.length} tier(s); T1 ${best.affix ?? ""} L${best.level ?? "?"}: ${best.lines?.join(" / ") ?? ""}`);
      }
    }
  }
  if (matched !== undefined && matched > options.length) lines.push(`  ... ${matched - options.length} more (narrow with search or raise limit)`);
  return lines;
}

function formatSources(sources: CraftResult["sources"]): string | undefined {
  if (!sources?.length) return undefined;
  return sources.map((source) => typeof source === "string" ? source : `${source.label} (${source.id})`).join(", ");
}

/** Hands the crafted item to lua_simulate (no build change) and then add_item. */
async function followUp(context: ItemCraftingContext, item: CraftedItem | undefined, args: CraftFollowUp): Promise<string[]> {
  if (!item || (!args.equip_slot && !args.simulate_slot)) return [];
  const lines: string[] = [];
  if (args.simulate_slot) {
    const simulated = await handleLuaSimulate(context as LuaHandlerContext, { itemText: item.text, slotName: args.simulate_slot });
    lines.push("", ...simulated.content.map((block) => block.text));
  }
  if (args.equip_slot) {
    const luaClient = await client(context);
    const added = await luaClient.addItem(item.text, args.equip_slot);
    lines.push("", `Added to the build and equipped: ${added.name ?? item.name} → ${added.slot ?? args.equip_slot} (item id ${added.id}).`);
  }
  return lines;
}

async function runCraft(
  context: ItemCraftingContext,
  action: ItemsTabAction,
  title: string,
  params: Record<string, unknown>,
  args: CraftFollowUp,
  describeList: (result: CraftResult) => string[],
): Promise<ToolResult> {
  const luaClient = await client(context);
  const result = await luaClient.itemsTabAction<CraftResult>(action, defined(params));
  const lines = [`=== ${title} ===`, ""];
  if (result.item) {
    const chosen = [
      result.addedLabel ? `${result.group ? `${result.group} → ` : ""}${result.addedLabel}${result.addedId ? ` [${result.addedId}]` : ""}` : undefined,
      ...(result.chosen ?? []),
      result.removed ? "enchantment removed" : undefined,
    ].filter(Boolean);
    if (chosen.length) lines.push(`Chosen: ${chosen.join("; ")}`, "");
    lines.push(...formatCraftedItem(result.item));
    lines.push(...await followUp(context, result.item, args));
  } else {
    lines.push(...describeList(result));
    if (args.equip_slot || args.simulate_slot) lines.push("", "Nothing was crafted, so nothing was equipped or simulated.");
  }
  if (result.note) lines.push("", `Note: ${result.note}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

const textResult = (lines: string[]): ToolResult => ({ content: [{ type: "text", text: lines.join("\n") }] });

export async function handleCraftItemBases(context: ItemCraftingContext, args: { base_type?: string; search?: string; limit?: number }) {
  return wrapHandler("list item bases", async () => {
    const luaClient = await client(context);
    const result = await luaClient.itemsTabAction<{
      types?: Array<{ name: string; count: number }>;
      type?: string;
      bases?: Array<{ name: string; type: string; level?: number; implicit?: string; influenceable?: boolean }>;
      matched?: number;
    }>("item_craft_bases", defined({ type: args.base_type, search: args.search, limit: args.limit }));
    if (result.types) {
      return textResult(["=== Item base types (PoB 'Craft item...' Type list) ===", "",
        ...result.types.map((t) => `  ${t.name} (${t.count})`), "", "Pass base_type or search to list bases."]);
    }
    const bases = result.bases ?? [];
    const lines = [`=== Item bases${result.type ? ` of ${result.type}` : ""}${args.search ? ` matching "${args.search}"` : ""} ===`, ""];
    for (const base of bases) {
      lines.push(`  ${base.name} [${base.type}]${base.level ? ` L${base.level}` : ""}${base.implicit ? ` — ${base.implicit.replace(/\n/g, " / ")}` : ""}${base.influenceable ? "" : " (no influence)"}`);
    }
    if (!bases.length) lines.push("  (none)");
    if ((result.matched ?? 0) > bases.length) lines.push(`  ... ${(result.matched ?? 0) - bases.length} more`);
    return textResult(lines);
  });
}

export async function handleCraftItemCreate(
  context: ItemCraftingContext,
  args: { base?: string; rarity?: string; name?: string; item_text?: string } & CraftFollowUp,
) {
  return wrapHandler("create item", async () => {
    if (!args.base && !args.item_text) throw new Error("pass base (PoB's 'Craft item...') or item_text (PoB's 'Create custom...')");
    return runCraft(context, "item_craft_create", args.item_text ? "Create custom item" : "Craft item", {
      base: args.item_text ? undefined : args.base, rarity: args.rarity, title: args.name, text: args.item_text,
    }, args, () => []);
  });
}

export interface AffixChange {
  type: "prefix" | "suffix";
  index?: number;
  modifier?: string | number;
  tier?: number;
  roll?: number;
  clear?: boolean;
}

export async function handleCraftItemAffixes(
  context: ItemCraftingContext,
  args: { item_text: string; changes?: AffixChange[]; list?: "prefix" | "suffix"; list_index?: number; sort_by?: string; search?: string; limit?: number } & CraftFollowUp,
) {
  return wrapHandler("set item affixes", async () => {
    const luaClient = await client(context);
    const result = await luaClient.itemsTabAction<CraftResult & {
      applied?: Array<{ type: string; index: number; label?: string; modId?: string; affix?: string; lines?: string[]; range?: number; tier?: number }>;
      listed?: { type: string; index: number; selected: number };
    }>("item_craft_affixes", defined({
      text: args.item_text, changes: args.changes, list: args.list, listIndex: args.list_index,
      sortBy: args.sort_by, search: args.search, limit: args.limit,
    }));
    const lines = ["=== Crafted item affixes ===", ""];
    if (result.applied?.length) {
      lines.push("Applied:");
      for (const change of result.applied) {
        lines.push(change.modId === "None"
          ? `  ${change.type} ${change.index}: cleared`
          : `  ${change.type} ${change.index}: ${change.label ? `${change.label} → ` : ""}${change.affix ?? ""} [${change.modId}]${change.tier ? ` T${change.tier}` : ""}${change.range !== undefined ? ` roll ${fmt(change.range)}` : ""} — ${change.lines?.join(" / ") ?? ""}`);
      }
      lines.push("");
    }
    if (result.item) lines.push(...formatCraftedItem(result.item));
    if (result.options && result.listed) {
      lines.push("", `Options for ${result.listed.type} ${result.listed.index}${result.sortBy ? ` (sorted by ${result.sortBy})` : ""} — pass modifier (${PICK_HINT}; a tier's mod id picks that tier) with tier (1 = best) and roll (0-1):`);
      lines.push(...formatOptions(result.options, result.matched, result.options.length <= 10));
    }
    if (result.applied?.length) lines.push(...await followUp(context, result.item, args));
    return textResult(lines);
  });
}

export async function handleCraftItemProperties(
  context: ItemCraftingContext,
  args: { item_text: string; influences?: string[]; quality?: number; catalyst?: string; catalyst_quality?: number; cluster_skill?: string; cluster_node_count?: number; ranges?: Array<{ line: string | number; roll: number }>; remove_modifiers?: Array<string | number> } & CraftFollowUp,
) {
  return wrapHandler("set item properties", async () => {
    const luaClient = await client(context);
    const result = await luaClient.itemsTabAction<CraftResult & {
      influenceOptions?: string[];
      catalystOptions?: string[];
      rangeLines?: Array<{ index: number; line: string; roll?: number }>;
      removableModifiers?: Array<{ index: number; line: string; kind: string }>;
      clusterSkills?: string[];
      clusterNodeCount?: { value?: number; min: number; max: number };
    }>("item_craft_properties", defined({
      text: args.item_text, influences: args.influences, quality: args.quality, catalyst: args.catalyst,
      catalystQuality: args.catalyst_quality, clusterSkill: args.cluster_skill, clusterNodeCount: args.cluster_node_count,
      ranges: args.ranges, removeModifiers: args.remove_modifiers,
    }));
    const lines = ["=== Item properties ===", ""];
    const applied = result.applied as { influences?: string[]; ranges?: Array<{ line: string; roll: number }>; removed?: string[]; clusterSkill?: string; catalyst?: string } | undefined;
    const chosen = [
      applied?.influences ? `influences: ${applied.influences.join(", ") || "none"}` : undefined,
      applied?.catalyst ? `catalyst: ${applied.catalyst}` : undefined,
      applied?.clusterSkill ? `cluster skill: ${applied.clusterSkill}` : undefined,
      ...(applied?.ranges ?? []).map((r) => `roll ${fmt(r.roll)}: ${r.line}`),
      ...(applied?.removed ?? []).map((line) => `removed: ${line}`),
    ].filter(Boolean);
    if (chosen.length) lines.push(`Chosen: ${chosen.join("; ")}`, "");
    if (result.item) lines.push(...formatCraftedItem(result.item));
    if (result.influenceOptions) lines.push("", `Influences PoB offers: ${result.influenceOptions.slice(1).join(", ")}`);
    if (result.catalystOptions) lines.push(`Catalysts PoB offers: ${result.catalystOptions.slice(1).join(", ")}`);
    if (result.clusterSkills) lines.push(`Cluster jewel skills: ${result.clusterSkills.join(", ")}`);
    if (result.clusterNodeCount) lines.push(`Added passives: ${result.clusterNodeCount.value ?? "?"} (${result.clusterNodeCount.min}-${result.clusterNodeCount.max})`);
    if (result.rangeLines?.length) {
      lines.push(`Range lines (ranges: [{ line, roll 0-1 }]; ${PICK_HINT}):`, ...result.rangeLines.map((r) => `  ${r.index}. ${r.line}${r.roll !== undefined ? ` (roll ${fmt(r.roll)})` : ""}`));
    }
    if (result.removableModifiers?.length) {
      lines.push(`Removable modifiers (remove_modifiers; ${PICK_HINT}):`, ...result.removableModifiers.map((r) => `  ${r.index}. ${r.line} (${r.kind})`));
    }
    const changed = ["influences", "quality", "catalyst", "catalyst_quality", "cluster_skill", "cluster_node_count", "ranges", "remove_modifiers"]
      .some((key) => (args as unknown as Record<string, unknown>)[key] !== undefined);
    if (changed) lines.push(...await followUp(context, result.item, args));
    return textResult(lines);
  });
}

export async function handleCraftItemAddModifier(
  context: ItemCraftingContext,
  args: { item_text: string; source?: string; modifier?: string | number; custom?: string; sort_by?: string; search?: string; limit?: number } & CraftFollowUp,
) {
  return wrapHandler("add modifier", async () => runCraft(context, "item_add_modifier", "Add modifier", {
    text: args.item_text, source: args.source, modifier: args.modifier, custom: args.custom,
    sortBy: args.sort_by, search: args.search, limit: args.limit,
  }, args, (result) => [
    `Sources: ${formatSources(result.sources) ?? "-"}`,
    `Listing source ${result.source}${result.sortBy ? `, sorted by ${result.sortBy}` : ""} — pass modifier to add one (${PICK_HINT}):`,
    ...formatOptions(result.options, result.matched),
  ]));
}

export async function handleCraftItemAddImplicit(
  context: ItemCraftingContext,
  args: { item_text: string; source?: string; group?: string | number; modifier?: string | number; custom?: string; sort_by?: string; search?: string; limit?: number } & CraftFollowUp,
) {
  return wrapHandler("add implicit", async () => runCraft(context, "item_add_implicit", "Add implicit", {
    text: args.item_text, source: args.source, group: args.group, modifier: args.modifier, custom: args.custom,
    sortBy: args.sort_by, search: args.search, limit: args.limit,
  }, args, (result) => result.groups
    ? [
      `Sources: ${formatSources(result.sources) ?? "-"}`,
      `Implicit types of ${result.source}${result.sortBy ? `, sorted by ${result.sortBy}` : ""} — pass group to list its modifiers (${PICK_HINT}):`,
      ...formatOptions(result.groups, result.matched),
    ]
    : [
      `Sources: ${formatSources(result.sources) ?? "-"}`,
      `Modifiers of ${result.source} / ${result.group ?? ""}${result.sortBy ? `, sorted by ${result.sortBy}` : ""} — pass modifier to add one (${PICK_HINT}):`,
      ...formatOptions(result.options, result.matched),
    ]));
}

export async function handleCraftItemCorrupt(
  context: ItemCraftingContext,
  args: { item_text: string; source?: string; implicits?: Array<string | number>; rolls?: Array<{ line: string | number; value: number }>; list?: boolean; sort_by?: string; search?: string; limit?: number } & CraftFollowUp,
) {
  return wrapHandler("corrupt item", async () => runCraft(context, "item_corrupt", "Corrupt item", {
    text: args.item_text, source: args.source, implicits: args.implicits, rolls: args.rolls, list: args.list,
    sortBy: args.sort_by, search: args.search, limit: args.limit,
  }, args, (result) => {
    const slots = (result.implicitSlots as Array<{ slot: number; kind: string; options: ModOption[]; matched: number }> | undefined) ?? [];
    const rolls = (result.rollLines as Array<{ index: number; line: string }> | undefined) ?? [];
    const lines = [`Sources: ${formatSources(result.sources) ?? "-"}; listing ${result.source}${result.sortBy ? `, sorted by ${result.sortBy}` : ""}`];
    if (result.implicitsCannotBeChanged) lines.push("PoB: this item's implicits cannot be changed.");
    for (const slot of slots) {
      lines.push("", `Implicit #${slot.slot} (${slot.kind}) — implicits[${slot.slot - 1}] (${PICK_HINT}; each pick rebuilds the paired list):`, ...formatOptions(slot.options, slot.matched));
    }
    if (rolls.length) lines.push("", `Roll range lines (rolls: [{ line, value 0.78-1.22 }]; ${PICK_HINT}):`, ...rolls.map((r) => `  ${r.index}. ${r.line}`));
    return lines;
  }));
}

export async function handleCraftItemEnchant(
  context: ItemCraftingContext,
  args: { item_text: string; slot?: number; skill?: string; all_skills?: boolean; source?: string; enchantment?: string | number; remove?: boolean; sort_by?: string; search?: string; limit?: number } & CraftFollowUp,
) {
  return wrapHandler("enchant item", async () => runCraft(context, "item_enchant", "Enchant item", {
    text: args.item_text, slot: args.slot, skill: args.skill, allSkills: args.all_skills, source: args.source,
    enchantment: args.enchantment, remove: args.remove, sortBy: args.sort_by, search: args.search, limit: args.limit,
  }, args, (result) => {
    const skills = result.skills as string[] | undefined;
    const lines: string[] = [];
    if (skills?.length) lines.push(`Skills (${skills.length}): ${skills.slice(0, 40).join(", ")}${skills.length > 40 ? ", ..." : ""}`);
    lines.push(`Sources: ${formatSources(result.sources) ?? "-"}`);
    lines.push(`Listing${result.skill ? ` skill ${result.skill as string},` : ""} source ${typeof result.source === "string" ? result.source : ""}${result.sortBy ? `, sorted by ${result.sortBy}` : ""} — pass enchantment (${PICK_HINT}):`);
    lines.push(...formatOptions(result.options, result.matched));
    return lines;
  }));
}

interface DbItem {
  name: string;
  type?: string;
  baseName?: string;
  rarity?: string;
  league?: string;
  source?: string;
  levelRequirement?: number;
  measuredPower?: number;
  primarySlot?: string;
  variants?: string[];
  versions?: string[];
  selectedVariant?: string;
  text?: string;
}

export async function handleSearchItemDb(
  context: ItemCraftingContext,
  args: { db?: string; name?: string; variant?: number; slot?: string; item_type?: string; league?: string; requirement?: string; obtainable?: string; search?: string; search_mode?: string; sort_by?: string; limit?: number; offset?: number; include_text?: boolean },
) {
  return wrapHandler("search item database", async () => {
    const luaClient = await client(context);
    const result = await luaClient.itemsTabAction<{
      db: string; items: DbItem[]; matched: number; offset?: number; sortBy?: string;
      filters?: Record<string, string[] | undefined>;
    }>("search_item_db", defined({
      db: args.db, name: args.name, variant: args.variant, slot: args.slot, type: args.item_type, league: args.league,
      requirement: args.requirement, obtainable: args.obtainable, search: args.search, searchMode: args.search_mode,
      sortBy: args.sort_by, limit: args.limit, offset: args.offset, includeText: args.include_text,
    }));
    const dbName = result.db === "rare" ? "Rare templates" : "Uniques";
    const lines = [`=== ${dbName}: ${result.matched} match(es)${result.sortBy ? `, ${result.sortBy}` : ""} ===`, ""];
    const offset = result.offset ?? 0;
    result.items.forEach((item, i) => {
      const facts = [item.primarySlot, item.league, item.levelRequirement ? `L${item.levelRequirement}` : undefined,
        item.measuredPower !== undefined ? `sort value ${fmt(item.measuredPower)}` : undefined].filter(Boolean).join(", ");
      lines.push(`${offset + i + 1}. ${item.name}${facts ? ` (${facts})` : ""}`);
      if (item.source && args.name) lines.push(`   Source: ${item.source}`);
      if (item.variants) lines.push(`   Variants: ${item.variants.map((v, k) => `${k + 1} ${v}`).join("; ")}`);
      if (item.versions) lines.push(`   Versions: ${item.versions.join("; ")}`);
      if (item.selectedVariant) lines.push(`   Selected variant: ${item.selectedVariant}`);
      if (item.text) lines.push("   ```", ...item.text.trimEnd().split("\n").map((line) => `   ${line}`), "   ```");
    });
    if (!result.items.length) lines.push("No items match those filters.");
    if (result.matched > offset + result.items.length) lines.push("", `... ${result.matched - offset - result.items.length} more (offset ${offset + result.items.length}).`);
    if (!args.name && result.filters) {
      const f = result.filters;
      lines.push("", "Filter values PoB offers:", `  slot: ${f.slot?.join(", ")}`, `  item_type: ${f.type?.join(", ")}`);
      if (f.league) lines.push(`  league: ${f.league.join(", ")}`);
      if (f.requirement) lines.push(`  requirement: ${f.requirement.join(", ")}`);
      if (f.obtainable) lines.push(`  obtainable: ${f.obtainable.join(", ")}`);
      lines.push(`  search_mode: ${f.searchMode?.join(", ")}`);
    }
    lines.push("", "To use an item: pass its text (include_text or name) to add_item with assume_max_quality (PoB's database add normalises quality the same way), lua_simulate, or the craft_item_* tools.");
    return textResult(lines);
  });
}

export async function handleManageItemSet(
  context: ItemCraftingContext,
  args: { action: string; id?: number; title?: string; confirm?: boolean },
) {
  return wrapHandler("manage item set", async () => {
    if (args.action === "delete" && args.confirm !== true) {
      throw new Error("deleting an item set needs confirm: true (the items stay in the build)");
    }
    const luaClient = await client(context);
    const result = await luaClient.itemsTabAction<{
      action: string; id?: number; activeItemSetId: number;
      itemSets: Array<{ id: number; title: string; active: boolean; useSecondWeaponSet: boolean }>;
    }>("item_set_manage", defined({ action: args.action, id: args.id, title: args.title, confirm: args.confirm }));
    const verb = { create: "Created", copy: "Copied to", rename: "Renamed", delete: "Deleted" }[result.action] ?? result.action;
    const lines = [`${verb} item set ${result.id ?? ""}.`, "", "Item sets:"];
    for (const set of result.itemSets) lines.push(`  ${set.id}. ${set.title}${set.active ? " (active)" : ""}`);
    return textResult(lines);
  });
}

export async function handleListSharedItems(context: ItemCraftingContext, args: { include_text?: boolean }) {
  return wrapHandler("list shared items", async () => {
    const luaClient = await client(context);
    const result = await luaClient.itemsTabAction<{
      items: Array<{ index: number; name: string; rarity?: string; type?: string; text?: string }>;
      itemSets: Array<{ index: number; title: string; slots: Record<string, string | { name: string; text: string }> }>;
    }>("list_shared_items", defined({ includeText: args.include_text }));
    const lines = ["=== Shared items (PoB settings, shared by every build) ===", ""];
    if (!result.items.length && !result.itemSets.length) {
      lines.push("None. The headless engine reads no user settings, so this list is empty there; the Path of Building window shows the user's own.");
    }
    for (const item of result.items) {
      lines.push(`${item.index}. ${item.name}${item.rarity ? ` (${item.rarity})` : ""}`);
      if (item.text) lines.push("   ```", ...item.text.trimEnd().split("\n").map((line) => `   ${line}`), "   ```");
    }
    if (result.itemSets.length) lines.push("", "Shared item sets:");
    for (const set of result.itemSets) {
      lines.push(`${set.index}. ${set.title}`);
      for (const [slot, value] of Object.entries(set.slots)) {
        if (typeof value === "string") lines.push(`   ${slot}: ${value}`);
        else lines.push(`   ${slot}: ${value.name}`, "   ```", ...value.text.trimEnd().split("\n").map((line) => `   ${line}`), "   ```");
      }
    }
    return textResult(lines);
  });
}
