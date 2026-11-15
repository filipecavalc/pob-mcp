import fs from "fs/promises";
import path from "path";
import { noteIgnoredError, wrapHandler } from "../utils/errorHandling.js";
import { buildFileName, resolveBuildFile } from "../utils/pathSanitizer.js";
import { normalizeAccountName, sharedPoeCharacterClient, type CharacterEntry, type PoeCharacterClient, type PoeCharacterError, type Realm } from "../services/poeCharacterClient.js";
import { formatDelta, formatStat, statNumber, type LuaHandlerContext } from "./luaHandlers.js";

/** Stats compared before and after a character import. */
const IMPORT_STATS: Array<{ key: string; label: string }> = [
  { key: 'CombinedDPS', label: 'Combined DPS' },
  { key: 'TotalDotDPS', label: 'Total DoT DPS' },
  { key: 'Life', label: 'Life' },
  { key: 'EnergyShield', label: 'Energy Shield' },
  { key: 'Mana', label: 'Mana' },
  { key: 'TotalNetRegen', label: 'Net recovery/s' },
  { key: 'TotalEHP', label: 'Effective HP' },
  { key: 'Armour', label: 'Armour' },
  { key: 'Evasion', label: 'Evasion' },
  { key: 'FireResist', label: 'Fire Resistance' },
  { key: 'ColdResist', label: 'Cold Resistance' },
  { key: 'LightningResist', label: 'Lightning Resistance' },
  { key: 'ChaosResist', label: 'Chaos Resistance' },
  { key: 'PhysicalMaximumHitTaken', label: 'Physical max hit' },
  { key: 'FireMaximumHitTaken', label: 'Fire max hit' },
  { key: 'ColdMaximumHitTaken', label: 'Cold max hit' },
  { key: 'LightningMaximumHitTaken', label: 'Lightning max hit' },
  { key: 'ChaosMaximumHitTaken', label: 'Chaos max hit' },
];

export interface ImportCharacterArgs {
  accountName?: string;
  character?: string;
  realm?: Realm;
  /** Build file to import on top of; its config and skill settings are kept. */
  baseBuild?: string;
  /** Build file to save the result to. */
  saveAs?: string;
  overwrite?: boolean;
  mainSkill?: string;
  ignoreWeaponSwap?: boolean;
}

export interface ImportCharacterDeps {
  characterClient?: Pick<PoeCharacterClient, 'listCharacters' | 'getPassives' | 'getItems'> &
    Partial<Pick<PoeCharacterClient, 'rateLimits' | 'resolveAccountName'>>;
  env?: Record<string, string | undefined>;
  fileExists?: (filePath: string) => Promise<boolean>;
}

const describeCharacter = (c: CharacterEntry) => `${c.name} (${c.class}, level ${c.level}, ${c.league})`;

interface SlotItem {
  label: string;
  /** pathofexile.com's item id, carried in PoB's raw text as "Unique ID:". */
  id?: string;
  /** Quality, sockets and mod lines, normalised so XML-loaded and freshly imported text compare equal. */
  lines: string[];
}

/**
 * PoB's raw text for the same item differs between a build loaded from XML
 * and a fresh import (BasePercentile/LevelReq lines, "[Tag|Text]" wiki
 * markup, "{tags:...}"/"{range:...}" planner prefixes), so only the parts that
 * describe the item are compared. Prefixes without a colon, such as
 * {crafted} or {fractured}, are kept: they are part of what the item is.
 */
export function describeItemRaw(raw: string | undefined): Pick<SlotItem, 'id' | 'lines'> {
  const lines = (raw ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const id = lines.find((l) => l.startsWith('Unique ID: '))?.slice('Unique ID: '.length);
  const kept = lines.filter((l) => l.startsWith('Quality: ') || l.startsWith('Sockets: '));
  const implicitsAt = lines.findIndex((l) => l.startsWith('Implicits: '));
  if (implicitsAt >= 0) kept.push(...lines.slice(implicitsAt + 1));
  const normalise = (l: string) => l
    .replace(/\{[A-Za-z]+:[^}]*\}/g, '')
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$2')
    .replace(/\[([^\]|]+)\]/g, '$1')
    .trim();
  return { id, lines: kept.map(normalise).filter(Boolean) };
}

// Hidden slots (weapon swap while set 1 is active) still hold real gear, so
// any slot with an item is compared; empty hidden slots have no label anyway.
function itemsBySlot(items: Array<{ slot: string; name?: string; baseName?: string; raw?: string }>): Map<string, SlotItem> {
  const bySlot = new Map<string, SlotItem>();
  for (const item of items ?? []) {
    const label = item.name || item.baseName;
    if (label) bySlot.set(item.slot, { label, ...describeItemRaw(item.raw) });
  }
  return bySlot;
}

/** Multiset difference: lines in `a` not matched one-for-one in `b`. */
function minus(a: string[], b: string[]): string[] {
  const left = [...b];
  const out: string[] = [];
  for (const line of a) {
    const i = left.indexOf(line);
    if (i >= 0) left.splice(i, 1);
    else out.push(line);
  }
  return out;
}

type GemLike = { name: string; level?: number; quality?: number; enabled?: boolean };
type SkillsLike = { groups?: Array<{ slot?: string; gems?: GemLike[] }> };

/**
 * "slot|gem name" -> "level/quality". Copies of one gem in one slot are sorted
 * by level/quality before numbering, so their socket order cannot make an
 * unchanged pair look changed.
 */
export function gemsBySlot(skills: SkillsLike | undefined): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const group of skills?.groups ?? []) {
    for (const gem of group.gems ?? []) {
      const base = `${group.slot || '(no slot)'}|${gem.name}`;
      const value = `level ${gem.level ?? '?'}, quality ${gem.quality ?? 0}`;
      grouped.set(base, [...(grouped.get(base) ?? []), value]);
    }
  }
  const out = new Map<string, string>();
  for (const [base, values] of grouped) {
    values.sort().forEach((value, i) => out.set(i === 0 ? base : `${base}#${i + 1}`, value));
  }
  return out;
}

/** One line per gem added, removed, or whose level/quality changed. */
export function describeGemChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key);
    const b = after.get(key);
    if (a === b) continue;
    const [slot, name] = key.replace(/#\d+$/, '').split('|');
    out.push(`  ${slot}: ${name} ${a ?? '(not socketed)'} → ${b ?? '(removed)'}`);
  }
  return out;
}

/** One line per slot whose item was replaced or whose quality/sockets/mods changed. */
export function describeGearChanges(before: Map<string, SlotItem>, after: Map<string, SlotItem>): string[] {
  const out: string[] = [];
  for (const slot of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(slot);
    const b = after.get(slot);
    if (!a || !b) {
      out.push(`  ${slot}: ${a?.label ?? '(empty)'} → ${b?.label ?? '(empty)'}`);
      continue;
    }
    const sameItem = a.id && b.id ? a.id === b.id : a.label === b.label;
    if (!sameItem) {
      out.push(`  ${slot}: ${a.label} → ${b.label}`);
      continue;
    }
    const removed = minus(a.lines, b.lines);
    const added = minus(b.lines, a.lines);
    if (removed.length || added.length) {
      out.push(`  ${slot}: ${b.label} changed`);
      for (const l of removed) out.push(`      - ${l}`);
      for (const l of added) out.push(`      + ${l}`);
    }
  }
  return out;
}

/**
 * Pull a character from pathofexile.com (public profile) and import it with
 * PoB's own importer, on top of a base build so its config and skill settings
 * survive, then optionally save it. Reports what changed against the base.
 */
export async function handleImportCharacter(context: LuaHandlerContext, args: ImportCharacterArgs, deps: ImportCharacterDeps = {}) {
  return wrapHandler('import character', async () => {
    const env = deps.env ?? process.env;
    const accountName = args.accountName || env.POE_ACCOUNT_NAME;
    const characterName = args.character || env.POE_CHARACTER;
    const saveAs = args.saveAs || env.POB_CHARACTER_BUILD;
    const realm: Realm = args.realm ?? 'pc';
    if (!accountName) {
      throw new Error('account_name is required (or set POE_ACCOUNT_NAME in the server env). Use the full name with its #1234 discriminator.');
    }

    // Settle every file decision before any request or bridge change.
    const fileExists = deps.fileExists ?? (async (p: string) => fs.access(p).then(() => true, () => false));
    const savePath = saveAs ? resolveBuildFile(saveAs, context.pobDirectory) : undefined;
    const saveTargetExists = savePath ? await fileExists(savePath) : false;
    let baseBuild = args.baseBuild;
    if (!baseBuild && saveAs && saveTargetExists) baseBuild = saveAs;
    const basePath = baseBuild ? resolveBuildFile(baseBuild, context.pobDirectory) : undefined;
    const sameFile = (a: string, b: string) => process.platform === 'win32'
      ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      : path.resolve(a) === path.resolve(b);
    const savingOverBase = !!savePath && !!basePath && sameFile(savePath, basePath);
    if (savePath && saveTargetExists && !savingOverBase && !args.overwrite) {
      throw new Error(`"${buildFileName(saveAs!)}" already exists and is not the base build; pass overwrite: true to replace it, or choose another save_as.`);
    }
    const baseXml = basePath ? await fs.readFile(basePath, 'utf-8') : undefined;

    // Fetch everything first: a network failure must not disturb the build loaded in the bridge.
    const client = deps.characterClient ?? sharedPoeCharacterClient();
    const characters = await client.listCharacters(accountName, realm);
    const listing = () => characters.map((c) => `  - ${describeCharacter(c)}`).join('\n');
    if (!characterName) {
      throw new Error(`character is required (or set POE_CHARACTER). Characters on this account:\n${listing()}`);
    }
    const entry = characters.find((c) => c.name === characterName)
      ?? characters.find((c) => c.name.toLowerCase() === characterName.toLowerCase());
    if (!entry) {
      throw new Error(`character "${characterName}" not found on this account. Characters:\n${listing()}`);
    }
    let account = accountName;
    let passives: Record<string, unknown>;
    try {
      passives = await client.getPassives(account, entry.name, realm);
    } catch (error) {
      // PoB reads the exact account spelling from the profile page because
      // these endpoints used to be case-sensitive (ImportTab.lua). Checked
      // 2026-11-15: a wrong-case name worked on all of them, so this only runs
      // when one refuses the name.
      const status = (error as PoeCharacterError).status;
      if ((status !== 403 && status !== 404) || !client.resolveAccountName) throw error;
      const exact = await client.resolveAccountName(account, realm);
      if (exact === normalizeAccountName(account, realm)) throw error;
      account = exact;
      passives = await client.getPassives(account, entry.name, realm);
    }
    const items = await client.getItems(account, entry.name, realm);

    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized');

    const statKeys = IMPORT_STATS.map((s) => s.key);
    let beforeStats: Record<string, unknown> | undefined;
    let beforeItems: Map<string, SlotItem> | undefined;
    const loadBase = async () => {
      if (basePath && baseXml !== undefined) {
        await luaClient.loadBuildXml(baseXml, buildFileName(baseBuild!).replace(/\.xml$/i, ''), basePath);
      } else {
        await luaClient.newBuild();
      }
    };
    await loadBase();
    let beforeGems: Map<string, string> | undefined;
    if (basePath) {
      beforeStats = await luaClient.getStats(statKeys);
      beforeItems = itemsBySlot(await luaClient.getItems());
      beforeGems = gemsBySlot(await luaClient.getSkills());
    }

    let result;
    try {
      result = await luaClient.importCharacter({
        character: entry,
        passives,
        items,
        mainSkill: args.mainSkill,
        ignoreWeaponSwap: args.ignoreWeaponSwap,
      });
    } catch (error) {
      // Do not leave a half-imported build in the bridge.
      await loadBase().catch((reloadError: unknown) => noteIgnoredError('reload base after a failed character import', reloadError));
      throw error;
    }
    const afterStats = await luaClient.getStats(statKeys);
    const afterItems = itemsBySlot(await luaClient.getItems());

    const lines: string[] = [
      `✅ Imported ${describeCharacter(entry)} from pathofexile.com with PoB's importer${baseBuild ? ` on top of "${buildFileName(baseBuild)}"` : ' into a new build'}.`,
      `Class: ${result.class}/${result.ascendancy} · level ${result.level} · ${result.allocatedNodes} passive nodes · ${result.socketGroups} socket groups`,
      `Main skill: ${result.mainSkill ?? 'none'} (${result.mainSkillSource}${result.mainSkillWanted && result.mainSkill?.toLowerCase() !== result.mainSkillWanted.toLowerCase() ? `; no group has ${result.mainSkillWanted}, pass main_skill to choose` : ''})`,
    ];

    // dkjson encodes an empty Lua table as [], so only an object carries entries.
    const restored = result.restoredConfig && !Array.isArray(result.restoredConfig) ? Object.entries(result.restoredConfig) : [];
    if (restored.length) {
      lines.push('', "Kept from the base build (PoB's importer overwrites these: bandit and pantheon are not in the public API, the resistance penalty is re-estimated from passive points):");
      for (const [key, value] of restored) lines.push(`  ${key}: kept ${String(value.kept)} (importer set ${String(value.imported)})`);
    }

    if (beforeItems) {
      const changes = describeGearChanges(beforeItems, afterItems);
      lines.push('', changes.length ? 'Gear changes:' : 'Gear: no slot changed.', ...changes);
      const gemChanges = describeGemChanges(beforeGems ?? new Map(), gemsBySlot(await luaClient.getSkills()));
      lines.push('', gemChanges.length ? 'Gem changes:' : 'Gems: no change.', ...gemChanges);
    } else {
      lines.push('', 'Gear:');
      for (const item of result.items ?? []) lines.push(`  ${item.slot}: ${item.name ?? item.base ?? '?'}`);
    }

    lines.push('', beforeStats ? 'Stats (base → imported):' : 'Stats:');
    for (const { key, label } of IMPORT_STATS) {
      const after = statNumber(afterStats, key);
      if (after === undefined) continue;
      const before = beforeStats ? statNumber(beforeStats, key) : undefined;
      if (before === undefined) {
        lines.push(`  ${label}: ${formatStat(after)}`);
      } else {
        const delta = after - before;
        lines.push(`  ${label}: ${formatStat(before)} → ${formatStat(after)}  ${delta === 0 ? 'unchanged' : formatDelta(delta, before)}`);
      }
    }

    if (saveAs && savePath) {
      // Replacing the base is the point of the tool; any other existing file was cleared above.
      const saved = await luaClient.saveBuild(savePath, args.overwrite === true || savingOverBase);
      context.buildService?.invalidateBuild(saveAs);
      lines.push('', `Saved to "${buildFileName(saveAs)}" (${saved.size} bytes).`);
    } else {
      lines.push('', 'Not saved (pass save_as or set POB_CHARACTER_BUILD). The import stays loaded in the bridge.');
    }

    const characterLimit = client.rateLimits?.get('backend-character-request-limit');
    if (characterLimit) {
      const usage = characterLimit.rules.map((r) => `${r.current}/${r.limit.hits} per ${r.limit.periodSeconds}s`).join(', ');
      lines.push(`pathofexile.com character requests used: ${usage}.`);
    }
    lines.push("Note: pathofexile.com refreshes a character's items when it changes zone or logs out.");

    return { content: [{ type: "text" as const, text: lines.join('\n') }] };
  });
}
