import fs from "fs/promises";
import path from "path";
import { noteIgnoredError, wrapHandler } from "../utils/errorHandling.js";
import { buildFileName, resolveBuildFile } from "../utils/pathSanitizer.js";
import { normalizeAccountName, sharedPoeCharacterClient, type CharacterEntry, type PoeCharacterClient, type PoeCharacterError, type Realm } from "../services/poeCharacterClient.js";
import { formatDelta, formatStat, statNumber, type LuaHandlerContext } from "./luaHandlers.js";
import type { CharacterImportResult } from "../pobLuaBridge.js";

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
  /**
   * Where the character comes from. 'pob_login': PoB (MCP)'s own Path of
   * Exile login, the official API, which also carries bandit and pantheon.
   * 'public_profile': pathofexile.com's public profile, no login. 'auto'
   * (default): the login when the PoB (MCP) window runs and is logged in.
   */
  source?: ImportSource;
}

export type ImportSource = 'auto' | 'pob_login' | 'public_profile';

/** PoB (MCP)'s Path of Exile login, reached through the window's local server. */
export interface PobLoginSource {
  /** Undefined when the window target is not configured; throws when the window does not answer. */
  status(): Promise<{ authenticated: boolean } | undefined>;
  /** GGG's character object, downloaded by PoB with its own login. */
  character(name: string, realm: Realm): Promise<Record<string, unknown>>;
}

export interface ImportCharacterDeps {
  characterClient?: Pick<PoeCharacterClient, 'listCharacters' | 'getPassives' | 'getItems'> &
    Partial<Pick<PoeCharacterClient, 'rateLimits' | 'resolveAccountName'>>;
  pobLogin?: PobLoginSource;
  env?: Record<string, string | undefined>;
  fileExists?: (filePath: string) => Promise<boolean>;
}

interface FetchedCharacter {
  entry: CharacterEntry;
  passives: Record<string, unknown>;
  items: Record<string, unknown>;
  source: 'pob_login' | 'public_profile';
}

/**
 * The login API returns one character object; PoB's login import passes it to
 * the same importer functions as the public profile's two responses, so it is
 * split into that shape: passives (with the tree jewels as items) and items.
 */
export function splitLoginCharacter(character: Record<string, unknown>): Omit<FetchedCharacter, 'source'> {
  const { equipment, jewels, passives, inventory: _inventory, rucksack: _rucksack, ...rest } = character;
  if (typeof rest.name !== 'string' || typeof rest.class !== 'string' || typeof rest.league !== 'string') {
    throw new Error('the login API response has no character name, class or league');
  }
  if (!passives || typeof passives !== 'object') throw new Error('the login API response has no passive tree');
  return {
    // level passes through as sent: PoB's importer uses 100 when it is missing.
    entry: { ...rest, name: rest.name, class: rest.class, league: rest.league, level: rest.level as number },
    passives: { ...(passives as Record<string, unknown>), items: Array.isArray(jewels) ? jewels : [] },
    items: { items: Array.isArray(equipment) ? equipment : [] },
  };
}

/** Which source 'auto' resolves to, with the reason when it is not the login. */
const publicNote = (why: string) => `Source: public profile (${why}; bandit and pantheon are kept from the base build).`;

async function chooseSource(requested: ImportSource, pobLogin: PobLoginSource | undefined, explicitAccount: boolean): Promise<{ source: 'pob_login' | 'public_profile'; note?: string }> {
  if (requested === 'public_profile') return { source: 'public_profile' };
  const unavailable = (why: string) => {
    if (requested === 'pob_login') throw new Error(`source pob_login: ${why}`);
    return { source: 'public_profile' as const, note: publicNote(why) };
  };
  // The login reaches only the logged-in account's characters; an account
  // named in the call may be anyone's.
  if (requested === 'auto' && explicitAccount) return unavailable('account_name was given, and PoB\'s login reaches only its own account');
  if (!pobLogin) return unavailable('the Path of Building window target is not configured (POB_GUI_PATH)');
  let status: { authenticated: boolean } | undefined;
  try {
    status = await pobLogin.status();
  } catch (e) {
    return unavailable(`Path of Building (MCP) is not running or did not answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!status) return unavailable('the Path of Building window target is not configured (POB_GUI_PATH)');
  if (!status.authenticated) {
    return unavailable('Path of Building (MCP) is not logged in to Path of Exile; log in under Import/Export, "Authorize with Path of Exile"');
  }
  return { source: 'pob_login' };
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

/** get-items carries character.lastLoginTime as Unix seconds. */
export function describeLastLogin(seconds: unknown, now: Date = new Date()): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const at = new Date(seconds * 1000);
  const minutes = Math.round((now.getTime() - at.getTime()) / 60000);
  const ago = minutes < 1 ? 'just now'
    : minutes < 120 ? `${minutes} min ago`
      : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago`
        : `${Math.round(minutes / 1440)} days ago`;
  return `${at.toISOString().replace('T', ' ').slice(0, 16)} UTC (${ago})`;
}

type ImportAudit = NonNullable<CharacterImportResult['audit']>;

/**
 * Completeness of the import: what pathofexile.com sent that PoB did not
 * bring in, and lines PoB cannot calculate (red in PoB), which count in none
 * of the numbers reported.
 */
export function describeAudit(audit: ImportAudit | undefined): string[] {
  if (!audit) return [];
  if (audit.error) return [`⚠️ Completeness check could not run (${audit.error}); the import itself succeeded.`];
  // dkjson encodes empty Lua tables as [] and may send objects for sparse ones.
  const list = <T>(value: T[] | Record<string, T> | undefined): T[] =>
    Array.isArray(value) ? value : value ? Object.values(value) : [];
  const missingItems = list(audit.missingItems);
  const missingGems = list(audit.missingGems);
  const unsupported = list(audit.unsupportedLines);
  const out: string[] = [];
  const counts = audit.counts ?? {};
  if (!missingItems.length && !missingGems.length) {
    out.push(`Import complete: all ${counts.items ?? '?'} items and ${counts.gems ?? '?'} gems from pathofexile.com are in the build.`
      + (counts.notEquipped ? ` (${counts.notEquipped} unequipped bag entries ignored, as PoB does.)` : ''));
  } else {
    out.push('', `⚠️ Not imported by PoB (left out of every number below):`);
    for (const m of missingItems) out.push(`  item ${m.where}: ${[m.name, m.base].filter(Boolean).join(', ')}`);
    for (const g of missingGems) out.push(`  gem ${g.where}: ${g.name ?? '?'}`);
  }
  if (unsupported.length) {
    out.push('', `Lines PoB cannot calculate (shown red in PoB; they count in none of the numbers):`);
    for (const u of unsupported) out.push(`  ${u.slot} (${u.item ?? '?'}): ${u.line}`);
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
    const requestedSource = args.source ?? 'auto';
    if (!['auto', 'pob_login', 'public_profile'].includes(requestedSource)) {
      throw new Error(`source must be auto, pob_login or public_profile (got ${String(requestedSource)})`);
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
    const chosen = await chooseSource(requestedSource, deps.pobLogin, !!args.accountName);
    let client: ImportCharacterDeps['characterClient'] | undefined;
    let fetched: FetchedCharacter | undefined;
    if (chosen.source === 'pob_login') {
      if (!characterName) throw new Error('character is required (or set POE_CHARACTER).');
      try {
        fetched = { ...splitLoginCharacter(await deps.pobLogin!.character(characterName, realm)), source: 'pob_login' };
      } catch (error) {
        // Not on the logged-in account: in auto, the public profile may still have it.
        if (requestedSource !== 'auto' || !(error as { notFound?: boolean }).notFound || !accountName) throw error;
        chosen.source = 'public_profile';
        chosen.note = publicNote(`PoB's login found no "${characterName}" on its account`);
      }
    }
    if (!fetched) {
      if (!accountName) {
        throw new Error('account_name is required for the public profile (or set POE_ACCOUNT_NAME in the server env). Use the full name with its #1234 discriminator.'
          + (chosen.note ? ` ${chosen.note}` : ''));
      }
      const publicClient = deps.characterClient ?? sharedPoeCharacterClient();
      client = publicClient;
      const characters = await publicClient.listCharacters(accountName, realm);
      const listing = () => characters.map((c) => `  - ${describeCharacter(c)}`).join('\n');
      if (!characterName) {
        throw new Error(`character is required (or set POE_CHARACTER). Characters on this account:\n${listing()}`);
      }
      const found = characters.find((c) => c.name === characterName)
        ?? characters.find((c) => c.name.toLowerCase() === characterName.toLowerCase());
      if (!found) {
        throw new Error(`character "${characterName}" not found on this account. Characters:\n${listing()}`);
      }
      let account = accountName;
      let publicPassives: Record<string, unknown>;
      try {
        publicPassives = await publicClient.getPassives(account, found.name, realm);
      } catch (error) {
        // PoB reads the exact account spelling from the profile page because
        // these endpoints used to be case-sensitive (ImportTab.lua). Checked
        // 2026-11-15: a wrong-case name worked on all of them, so this only runs
        // when one refuses the name.
        const status = (error as PoeCharacterError).status;
        if ((status !== 403 && status !== 404) || !publicClient.resolveAccountName) throw error;
        const exact = await publicClient.resolveAccountName(account, realm);
        if (exact === normalizeAccountName(account, realm)) throw error;
        account = exact;
        publicPassives = await publicClient.getPassives(account, found.name, realm);
      }
      const publicItems = await publicClient.getItems(account, found.name, realm);
      fetched = { entry: found, passives: publicPassives, items: publicItems, source: 'public_profile' };
    }
    const { entry, passives, items } = fetched;
    const fromLogin = fetched.source === 'pob_login';

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
        questChoicesFromResponse: fromLogin,
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
      fromLogin
        ? 'Source: Path of Building (MCP)\'s Path of Exile login (official API, as PoB\'s "Import From Your Account").'
        : chosen.note ?? 'Source: public profile (no login).',
      `Class: ${result.class}/${result.ascendancy} · level ${result.level} · ${result.allocatedNodes} passive nodes · ${result.socketGroups} socket groups`,
      `Main skill: ${result.mainSkill ?? 'none'} (${result.mainSkillSource}${result.mainSkillWanted && result.mainSkill?.toLowerCase() !== result.mainSkillWanted.toLowerCase() ? `; no group has ${result.mainSkillWanted}, pass main_skill to choose` : ''})`,
    ];
    const lastLogin = describeLastLogin((items as { character?: { lastLoginTime?: unknown } }).character?.lastLoginTime);
    if (lastLogin) lines.push(`pathofexile.com last login: ${lastLogin}`);
    lines.push(...describeAudit(result.audit));

    // dkjson encodes an empty Lua table as [], so only an object carries entries.
    const restored = result.restoredConfig && !Array.isArray(result.restoredConfig) ? Object.entries(result.restoredConfig) : [];
    if (fromLogin && result.questChoices) {
      const q = result.questChoices;
      lines.push(`Bandit and pantheon from the account: bandit ${q.bandit ?? '?'}, major ${q.pantheonMajorGod ?? '?'}, minor ${q.pantheonMinorGod ?? '?'}.`);
    }
    if (restored.length) {
      lines.push('', fromLogin
        ? "Kept from the base build (PoB's importer re-estimates the resistance penalty from passive points):"
        : "Kept from the base build (PoB's importer overwrites these: bandit and pantheon are not in the public API, the resistance penalty is re-estimated from passive points):");
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

    const characterLimit = client?.rateLimits?.get('backend-character-request-limit');
    if (characterLimit) {
      const usage = characterLimit.rules.map((r) => `${r.current}/${r.limit.hits} per ${r.limit.periodSeconds}s`).join(', ');
      lines.push(`pathofexile.com character requests used: ${usage}.`);
    }
    lines.push("Note: pathofexile.com refreshes a character's items when it changes zone or logs out.");

    return { content: [{ type: "text" as const, text: lines.join('\n') }] };
  });
}
