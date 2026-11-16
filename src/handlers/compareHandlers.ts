/**
 * Compare tab handlers.
 *
 * Path of Building's Compare tab (Classes/CompareTab.lua) holds comparison
 * builds next to the loaded build and shows how they differ. These tools run
 * that tab in the PoB engine (lua/pob_ops.lua, compare_*): every number and
 * difference is PoB's own. Comparison builds live with the loaded build:
 * loading another build (lua_load_build, lua_new_build, ...) clears them, as
 * opening another build does in the app.
 *
 * compare_builds and compare_trees are separate, older tools: they load or
 * parse two build files on their own and do not use the Compare tab.
 */
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { wrapHandler, noteIgnoredError } from "../utils/errorHandling.js";
import { resolveBuildFile } from "../utils/pathSanitizer.js";
import type { LuaHandlerContext } from "./luaHandlers.js";
import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import type { TradeApiClient } from "../services/tradeClient.js";
import type { TradeQuery } from "../types/tradeTypes.js";
import type {
  CompareBuySimilarParams, CompareCopyParams, CompareEntryInfo, CompareList, ComparePowerParams,
  CompareReport, CompareReportParams, CompareSection, CompareSelectParams, CompareItemRow, CompareModLine,
} from "../types/compareTypes.js";

type TextResponse = { content: Array<{ type: "text"; text: string }> };

const text = (body: string): TextResponse => ({ content: [{ type: "text" as const, text: body }] });

async function client(context: LuaHandlerContext): Promise<PoBLuaApiClient> {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error("Lua client not initialized");
  return luaClient;
}

/**
 * A PoB build code to XML, as CompareTabClass:ImportFromCode does it:
 * URL-safe base64, then zlib inflate. Inflated here because the headless
 * engine may lack a real Inflate (see PoBLuaApiClient.importCode).
 */
export function decodeBuildCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) throw new Error("build_code is empty");
  const compressed = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  try {
    return zlib.inflateSync(compressed).toString("utf8");
  } catch (zlibErr) {
    try {
      return zlib.inflateRawSync(compressed).toString("utf8");
    } catch {
      const msg = zlibErr instanceof Error ? zlibErr.message : String(zlibErr);
      throw new Error(`Invalid build code: ${msg}`);
    }
  }
}

const num = (value: number | undefined, digits = 0): string =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 })
    : "-";

function setsLine(label: string, sets: CompareEntryInfo["treeSets"]): string {
  if (!sets || sets.length === 0) return `  ${label}: -`;
  return `  ${label}: ` + sets.map((s) => `${s.active ? "*" : ""}[${s.index}] ${s.title}`).join(", ");
}

export function formatCompareEntry(entry: CompareEntryInfo): string[] {
  const lines = [
    `[${entry.index}] ${entry.label}${entry.active ? " (active)" : ""}: ${entry.className ?? "?"}${entry.ascendClassName && entry.ascendClassName !== "None" ? ` / ${entry.ascendClassName}` : ""}, level ${entry.level ?? "?"}`,
    `  Life ${num(entry.stats.Life)} | ES ${num(entry.stats.EnergyShield)} | EHP ${num(entry.stats.TotalEHP)} | Combined DPS ${num(entry.stats.CombinedDPS, 1)} | Full DPS ${num(entry.stats.FullDPS, 1)}`,
    setsLine("Tree sets", entry.treeSets),
    setsLine("Item sets", entry.itemSets),
    setsLine("Skill sets", entry.skillSets),
    setsLine("Config sets", entry.configSets),
  ];
  const main = entry.socketGroups.find((g) => g.index === entry.mainSocketGroup);
  lines.push(`  Main skill group: [${entry.mainSocketGroup ?? "?"}] ${main?.label || "-"}${entry.calcsSocketGroup !== entry.mainSocketGroup ? ` | Calcs view group: [${entry.calcsSocketGroup}]` : ""} | Calcs mode: ${entry.calcsBuffMode ?? "-"}`);
  return lines;
}

function formatList(list: CompareList): string {
  if (list.entries.length === 0) {
    return `No comparison builds loaded for "${list.primary.name ?? "the loaded build"}". Use compare_add_build.`;
  }
  const lines = [`Comparing against the loaded build "${list.primary.name ?? "?"}" (${list.primary.className ?? "?"}${list.primary.ascendClassName && list.primary.ascendClassName !== "None" ? ` / ${list.primary.ascendClassName}` : ""}, level ${list.primary.level ?? "?"}):`, ""];
  for (const entry of list.entries) lines.push(...formatCompareEntry(entry), "");
  lines.push("Sets marked * are active. Change them with compare_select.");
  return lines.join("\n");
}

export interface CompareAddArgs {
  buildName?: string;
  buildCode?: string;
  label?: string;
}

export async function handleCompareAddBuild(context: LuaHandlerContext, args: CompareAddArgs) {
  return wrapHandler("add comparison build", async () => {
    if (!!args.buildName === !!args.buildCode) throw new Error("Give exactly one of build_name or build_code");
    let xml: string;
    let label = args.label;
    if (args.buildName) {
      // The "Import from Folder" popup labels the entry with the build's name.
      const buildPath = resolveBuildFile(args.buildName, context.pobDirectory);
      xml = await fs.readFile(buildPath, "utf-8");
      label = label || path.basename(buildPath).replace(/\.xml$/i, "");
    } else {
      xml = decodeBuildCode(args.buildCode as string);
      // The Import popup's default name for a pasted code.
      label = label || "Imported build";
    }
    const luaClient = await client(context);
    const result = await luaClient.compareImport(xml, label);
    return text([
      `Loaded "${result.entry.label}" for comparison (${result.count} loaded).`,
      "",
      ...formatCompareEntry(result.entry),
      "",
      "Next: compare_differences (stats, tree, items, skills, config, calcs), compare_power_report, compare_select to pick its sets.",
    ].join("\n"));
  });
}

export async function handleCompareList(context: LuaHandlerContext) {
  return wrapHandler("list comparison builds", async () => {
    const luaClient = await client(context);
    return text(formatList(await luaClient.compareList()));
  });
}

export async function handleCompareRemoveBuild(context: LuaHandlerContext, index: number) {
  return wrapHandler("remove comparison build", async () => {
    if (!Number.isInteger(index) || index < 1) throw new Error("index must be a positive integer (see compare_list)");
    const luaClient = await client(context);
    const list = await luaClient.compareRemove(index);
    return text(`Removed "${list.removed}".\n\n${formatList(list)}`);
  });
}

export async function handleCompareSelect(context: LuaHandlerContext, params: CompareSelectParams) {
  return wrapHandler("select comparison sets", async () => {
    const luaClient = await client(context);
    const result = await luaClient.compareSelect(params);
    const changed = result.changed.length > 0 ? `Changed: ${result.changed.join(", ")}.` : "Nothing changed; active comparison selected.";
    return text([changed, "", ...formatCompareEntry(result.entry)].join("\n"));
  });
}

// ---------------------------------------------------------------- report text

function sectionError(section: unknown): string | undefined {
  return section && typeof section === "object" && "error" in section ? String((section as { error: unknown }).error) : undefined;
}

const MARKER_TEXT: Record<string, string> = { "+": "+ ", ">": "> ", "<": "< " };

function modLines(mods: CompareModLine[] | undefined, indent: string): string[] {
  return (mods ?? []).map((m) => `${indent}${m.marker ? MARKER_TEXT[m.marker] : "  "}${m.text}`);
}

function itemName(item: CompareItemRow["primary"]): string {
  if (!item) return "(empty)";
  return `${item.name ?? "?"}${item.rarity ? ` [${item.rarity.toLowerCase()}]` : ""}`;
}

function formatItemRow(row: CompareItemRow, lines: string[]) {
  const notes: string[] = [];
  if (row.slotMissingInPrimary) notes.push("loaded build has no Ring 3 slot");
  if (row.primary && row.primaryNodeAllocated === false) notes.push("socket not allocated in loaded build");
  if (row.compare && row.compareNodeAllocated === false) notes.push("socket not allocated in compared build");
  const where = row.nodeId !== undefined ? `${row.slotName} (${row.slot})` : row.slot;
  lines.push(`- ${where}: ${row.status}${notes.length ? ` (${notes.join("; ")})` : ""}`);
  lines.push(`    loaded:   ${itemName(row.primary)}`);
  lines.push(`    compared: ${itemName(row.compare)}`);
  if (row.primaryMods || row.compareMods) {
    lines.push("    loaded mods:", ...modLines(row.primaryMods, "      "));
    lines.push("    compared mods:", ...modLines(row.compareMods, "      "));
  }
  if (row.equipStatChanges) {
    lines.push(`    equipping the compared item: ${row.equipStatChanges.length ? row.equipStatChanges.join("; ") : "no changes"}`);
  }
}

export function formatCompareReport(report: CompareReport): string {
  const lines: string[] = [
    `Compare: "${report.primaryName}" (loaded) vs "${report.compareName}" [${report.index}]${report.onlyDifferences ? ", differences only" : ""}`,
  ];

  if (report.stats) {
    lines.push("", "== Stats (Summary view) ==");
    const err = sectionError(report.stats);
    if (err) lines.push(`error: ${err}`);
    else if ("rows" in report.stats) {
      if (report.stats.minionStats) lines.push("(minion stats: a main skill is a minion skill)");
      if (report.stats.rows.length === 0) lines.push("No differences.");
      for (const r of report.stats.rows) {
        const diff = r.diffText ? `  ${r.diffText}${r.percent !== undefined ? ` (${r.percent >= 0 ? "+" : ""}${r.percent.toFixed(1)}%)` : ""}${r.better === undefined ? "" : r.better ? " better" : " worse"}` : "";
        lines.push(`${r.label}: ${r.primaryText} -> ${r.compareText}${diff}`);
      }
    }
  }

  if (report.tree) {
    lines.push("", "== Tree (overlay) ==");
    const err = sectionError(report.tree);
    if (err) lines.push(`error: ${err}`);
    else if ("compareOnly" in report.tree) {
      const t = report.tree;
      const side = (s: typeof t.primary) => `${s.className ?? "?"}${s.ascendClassName && s.ascendClassName !== "None" ? `/${s.ascendClassName}` : ""}, ${s.pointsUsed ?? "?"} points + ${s.ascendancyPointsUsed ?? 0} ascendancy, tree ${s.treeVersion ?? "?"}, spec "${s.specTitle ?? "?"}"`;
      lines.push(`loaded:   ${side(t.primary)}`, `compared: ${side(t.compare)}`);
      lines.push(`shared allocated nodes: ${t.sharedCount}`);
      const nodeLine = (n: (typeof t.compareOnly)[number]) => {
        let extra = "";
        if (n.primaryEffect || n.compareEffect) extra = ` [loaded: ${n.primaryEffect ?? "-"} | compared: ${n.compareEffect ?? "-"}]`;
        if (n.primaryJewel || n.compareJewel) extra = ` [loaded: ${n.primaryJewel ?? "empty"} | compared: ${n.compareJewel ?? "empty"}]`;
        return `  ${n.name ?? "?"} (${n.type ?? "?"}${n.ascendancy ? `, ${n.ascendancy}` : ""}${n.clusterNode ? ", cluster" : ""}, id ${n.id})${extra}`;
      };
      lines.push(`Only in compared build (green, ${t.compareOnly.length}):`, ...t.compareOnly.map(nodeLine));
      lines.push(`Only in loaded build (red, ${t.primaryOnly.length}):`, ...t.primaryOnly.map(nodeLine));
      lines.push(`Allocated in both, different mastery or jewel (blue, ${t.differs.length}):`, ...t.differs.map(nodeLine));
    }
  }

  if (report.items) {
    lines.push("", "== Items ==");
    const err = sectionError(report.items);
    if (err) lines.push(`error: ${err}`);
    else if ("slots" in report.items) {
      const it = report.items;
      lines.push(`item sets: loaded "${it.primaryItemSet}", compared "${it.compareItemSet}"`);
      if (it.slots.length === 0 && it.jewels.length === 0) lines.push("No differences.");
      for (const row of it.slots) formatItemRow(row, lines);
      if (it.jewels.length) {
        lines.push("-- Jewels --");
        for (const row of it.jewels) formatItemRow(row, lines);
      }
      if (it.slots.some((r) => r.primaryMods)) lines.push("(mod markers: + only on this side, > higher value, < lower value than the other side)");
    }
  }

  if (report.skills) {
    lines.push("", "== Skills ==");
    const err = sectionError(report.skills);
    if (err) lines.push(`error: ${err}`);
    else if ("pairs" in report.skills) {
      const sk = report.skills;
      lines.push(`skill sets: loaded "${sk.primarySkillSet}", compared "${sk.compareSkillSet}"`);
      if (sk.pairs.length === 0) lines.push("No differences.");
      const gem = (g: (typeof sk.pairs)[number]["primaryGems"][number]) => {
        const prefix = g.status === "missing" ? "- " : g.status === "additional" ? "+ " : "";
        const lvl = g.level !== undefined ? ` ${g.level}/${g.quality ?? 0}` : "";
        return `${prefix}${g.name}${lvl}${g.enabled === false ? " (disabled)" : ""}`;
      };
      for (const p of sk.pairs) {
        const pg = p.primaryGroup ? `[${p.primaryGroup.index}] ${p.primaryGroup.label || "(no label)"}${p.primaryGroup.main ? " (main)" : ""}` : "(none)";
        const cg = p.compareGroup ? `[${p.compareGroup.index}] ${p.compareGroup.label || "(no label)"}${p.compareGroup.main ? " (main)" : ""}` : "(none)";
        lines.push(`- loaded ${pg}  <->  compared ${cg}`);
        if (p.primaryGems.length) lines.push(`    loaded:   ${p.primaryGems.map(gem).join(", ")}`);
        if (p.compareGems.length) lines.push(`    compared: ${p.compareGems.map(gem).join(", ")}`);
      }
      lines.push("(+ only in this group, - in the other build's group only)");
    }
  }

  if (report.config) {
    lines.push("", "== Config ==");
    const err = sectionError(report.config);
    if (err) lines.push(`error: ${err}`);
    else if ("sections" in report.config) {
      const c = report.config;
      lines.push(`config sets: loaded "${c.primaryConfigSet}", compared "${c.compareConfigSet}"; ${c.differences} difference(s)`);
      for (const s of c.sections) {
        lines.push(`${s.name}${s.diffCount ? ` (${s.diffCount} diff)` : ""}:`);
        for (const r of s.rows) lines.push(`  ${r.differs ? "*" : " "} ${r.label}: ${r.primary} -> ${r.compare}  (${r.var})`);
      }
    }
  }

  if (report.calcs) {
    lines.push("", "== Calcs ==");
    const err = sectionError(report.calcs);
    if (err) lines.push(`error: ${err}`);
    else if ("sections" in report.calcs) {
      const c = report.calcs;
      lines.push(`skill: loaded "${c.primarySkill ?? "-"}" (${c.primaryBuffMode}${c.primaryShowsMinion ? ", minion" : ""}), compared "${c.compareSkill ?? "-"}" (${c.compareBuffMode}${c.compareShowsMinion ? ", minion" : ""}); ${c.rowCount} row(s)`);
      for (const s of c.sections) {
        for (const sub of s.subSections) {
          const extra = sub.primaryExtra !== undefined ? `  [${sub.primaryExtra} | ${sub.compareExtra}]` : "";
          lines.push(`${s.id} / ${sub.label}${extra}`);
          for (const r of sub.rows) lines.push(`  ${r.label}: ${r.primary ?? "-"} -> ${r.compare ?? "-"}`);
        }
      }
    }
  }
  return lines.join("\n");
}

const SECTIONS: CompareSection[] = ["stats", "tree", "items", "skills", "config", "calcs"];

export async function handleCompareDifferences(context: LuaHandlerContext, params: CompareReportParams & { output?: "text" | "json" }) {
  return wrapHandler("compare builds (Compare tab)", async () => {
    for (const s of params.sections ?? []) {
      if (!SECTIONS.includes(s)) throw new Error(`unknown section "${s}" (one of ${SECTIONS.join(", ")})`);
    }
    const { output, ...lua } = params;
    const luaClient = await client(context);
    const report = await luaClient.compareReport(lua);
    return text(output === "json" ? JSON.stringify(report, null, 2) : formatCompareReport(report));
  });
}

export async function handleComparePowerReport(context: LuaHandlerContext, params: ComparePowerParams) {
  return wrapHandler("compare power report", async () => {
    const luaClient = await client(context);
    const report = await luaClient.comparePowerReport(params);
    if (report.needsMetric || report.unknownMetric !== undefined) {
      const head = report.unknownMetric !== undefined ? `Unknown metric "${report.unknownMetric}".` : "Choose a metric.";
      return text(`${head} The Compare tab's power report metrics:\n` + (report.metrics ?? []).map((m) => `  ${m.stat} (${m.label})`).join("\n"));
    }
    const rows = report.rows ?? [];
    const lines = [
      `Compare power report: ${report.metric?.label} — what each element of "${report.compareName}" [${report.index}] would change on the loaded build.`,
      `Categories: ${Object.entries(report.categories ?? {}).filter(([, on]) => on).map(([k]) => k).join(", ") || "none"}. ${report.total ?? 0} element(s) with an effect${rows.length < (report.total ?? 0) ? `, showing ${rows.length}` : ""}.`,
      "",
    ];
    if (rows.length === 0) lines.push(report.status ?? "No differences found.");
    for (const r of rows) {
      const points = r.points !== undefined ? `  ${r.points} pt, ${r.perPointText} per point` : "";
      lines.push(`${r.category.padEnd(11)} ${r.impactText.padEnd(20)} ${r.name}${points}`);
    }
    return text(lines.join("\n"));
  });
}

export interface CompareBuySimilarArgs extends CompareBuySimilarParams {
  /** Run the search once through the trade API and report the number of listings. */
  run_search?: boolean;
}

/**
 * The league the Buy Similar popup selects by default: CompareBuySimilar's
 * fetchLeaguesForRealm puts the realm's leagues that are neither hardcore nor
 * ruthless first (each inserted at the front, so the last one listed ends up
 * first), then the others, then the permanent leagues; it selects the first.
 */
export function defaultTradeLeague(leagues: Array<{ id: string; realm?: string }>, realm: string): string {
  const permanent = new Set(["Standard", "Ruthless", "Hardcore", "Hardcore Ruthless"]);
  const list: string[] = [];
  for (const league of leagues) {
    if (league.realm !== realm || permanent.has(league.id)) continue;
    if (!league.id.includes("Hardcore") && !league.id.includes("Ruthless")) list.unshift(league.id);
    else list.push(league.id);
  }
  list.push("Standard", "Hardcore", "Ruthless", "Hardcore Ruthless");
  return list[0];
}

export async function handleCompareBuySimilar(context: LuaHandlerContext, args: CompareBuySimilarArgs, tradeClient: TradeApiClient | null) {
  return wrapHandler("build trade search for compared item", async () => {
    if (!args.slot) throw new Error("slot is required");
    const { run_search: runSearch, ...params } = args;
    const realm = params.realm ?? "pc";
    let leagueNote = "";
    if (!params.league) {
      if (tradeClient) {
        try {
          params.league = defaultTradeLeague((await tradeClient.getLeagues()).result ?? [], realm);
          leagueNote = " (the popup's default for the realm)";
        } catch (e) {
          noteIgnoredError("trade leagues for the Buy Similar default (PoB falls back to Standard)", e);
          leagueNote = " (league list unavailable; PoB's fallback)";
        }
      } else {
        leagueNote = " (trade API disabled, so PoB's fallback; pass league to choose)";
      }
    }
    const luaClient = await client(context);
    const result = await luaClient.compareBuySimilar(params);
    const query = new URL(result.url).searchParams.get("q");
    const queryJson = query ? JSON.parse(query) as TradeQuery : undefined;
    const lines = [
      `Buy similar: ${result.item.name} (${result.slot}) from "${result.compareName}"`,
      `Realm ${result.realm}, league ${result.league}${leagueNote}, listed: ${result.listed}${result.unique ? ", searched by unique name" : `, category ${result.category ?? "any"} (${result.categoryLabel ?? "Item"})`}`,
      "",
      "Mods (select with mods: [index...] or \"all\"; set min/max with mod_values):",
      ...result.mods.map((m) => `  ${m.selected ? "[x]" : "[ ]"} ${m.index}. (${m.type}) ${m.text}${m.searchable ? "" : "  -- no trade stat"}${m.min !== undefined || m.max !== undefined ? `  min ${m.min ?? "-"} max ${m.max ?? "-"}` : ""}`),
    ];
    if (result.defences.length) {
      lines.push("Defences (select with defences: [label...] or \"all\"):", ...result.defences.map((d) => `  ${d.selected ? "[x]" : "[ ]"} ${d.label} ${d.value}  min ${d.min ?? "-"} max ${d.max ?? "-"}`));
    }
    if (result.skippedMods.length) lines.push(`Not searchable, left out: ${result.skippedMods.join(", ")}`);
    lines.push("", `URL: ${result.url}`, "", "Query:", JSON.stringify(queryJson, null, 2));
    if (runSearch) {
      if (!tradeClient) throw new Error("run_search needs the trade API (POE_TRADE_ENABLED=true)");
      if (result.realm !== "PC") throw new Error("run_search supports the PC realm only; open the URL instead");
      if (!queryJson) throw new Error("PoB's URL carries no query");
      const search = await tradeClient.searchItems(result.league, queryJson);
      lines.push("", `Trade search: ${search.total} listing(s)${search.inexact ? " (inexact)" : ""}, search id ${search.id}.`);
    }
    return text(lines.join("\n"));
  });
}

export async function handleCompareCopy(context: LuaHandlerContext, params: CompareCopyParams) {
  return wrapHandler("copy from comparison build", async () => {
    if (!["tree", "item", "config"].includes(params.what)) throw new Error("what must be tree, item or config");
    if (params.what === "item" && !params.slot) throw new Error("slot is required to copy an item");
    const luaClient = await client(context);
    const r = await luaClient.compareCopy(params);
    let head: string;
    if (r.what === "tree") {
      head = `Copied the compared tree into the loaded build as spec [${r.specIndex}] "${r.specTitle}"${r.used ? " and made it active" : ` (active spec stays [${r.activeSpec}])`}. Jewels are not copied (PoB does not).`;
    } else if (r.what === "item") {
      head = `Copied ${r.item?.name ?? "the item"} into the loaded build${r.equipped ? ` and equipped it in ${r.slot}` : " (not equipped)"}.`;
    } else {
      head = `Copied every config value of "${r.compareName}" into the loaded build's config set "${r.configSet}".`;
    }
    return text([
      head,
      `Loaded build now: Life ${num(r.stats.Life)} | ES ${num(r.stats.EnergyShield)} | EHP ${num(r.stats.TotalEHP)} | Combined DPS ${num(r.stats.CombinedDPS, 1)}`,
      "Not saved: use lua_save_build to keep it.",
    ].join("\n"));
  });
}
