import fs from "fs/promises";
import { wrapHandler } from "../utils/errorHandling.js";
import { resolveBuildFile } from "../utils/pathSanitizer.js";
import { decodeBuildCode, type PartyDestination, type PartyEffect, type PartyState, type PoBLuaApiClient, type StatsExport } from "../pobLuaBridge.js";
import { formatDelta, formatStat, statNumber, type LuaHandlerContext } from "./luaHandlers.js";

/**
 * PoB's Party tab (Classes/PartyTab.lua): import the auras, curses, warcries,
 * links, party member stats and enemy modifiers another build exports with
 * "Export Support", and the tab's Append / Clear / Disable Party Effects /
 * Rebuild All. The Lua side presses the tab's own buttons, so the parsing and
 * the effect on the calculation are PoB's.
 */

const PARTY_DESTINATIONS: PartyDestination[] = ['All', 'Party Member Stats', 'Aura', 'Curse', 'Warcry Skills', 'Link Skills', 'EnemyConditions', 'EnemyMods'];

/** Stats compared before and after a Party tab change. */
const PARTY_STATS: Array<{ key: string; label: string }> = [
  { key: 'CombinedDPS', label: 'Combined DPS' },
  { key: 'TotalDotDPS', label: 'Total DoT DPS' },
  { key: 'Life', label: 'Life' },
  { key: 'EnergyShield', label: 'Energy Shield' },
  { key: 'Mana', label: 'Mana' },
  { key: 'TotalEHP', label: 'Effective HP' },
  { key: 'Armour', label: 'Armour' },
  { key: 'Evasion', label: 'Evasion' },
  { key: 'FireResist', label: 'Fire Resistance' },
  { key: 'ColdResist', label: 'Cold Resistance' },
  { key: 'LightningResist', label: 'Lightning Resistance' },
  { key: 'ChaosResist', label: 'Chaos Resistance' },
  { key: 'Speed', label: 'Attack/cast speed' },
  { key: 'EffectiveMovementSpeedMod', label: 'Movement speed' },
];

export function parseDestination(destination: string | undefined): PartyDestination | undefined {
  if (destination === undefined || destination === '') return undefined;
  const found = PARTY_DESTINATIONS.find((d) => d.toLowerCase() === destination.toLowerCase());
  if (!found) throw new Error(`destination must be one of: ${PARTY_DESTINATIONS.join(', ')}`);
  return found;
}

async function client(context: LuaHandlerContext): Promise<PoBLuaApiClient> {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_start, then load a build.');
  return luaClient;
}

const effectList = (effects: PartyEffect[]) =>
  effects.length === 0 ? '-' : effects.map((e) => `${e.name}${e.effect !== undefined ? ` ${formatStat(e.effect)}%` : ''}${e.isMark ? ' (mark)' : ''}`).join(', ');

/** The Party tab as text: what applies to the calculation, and what text it keeps. */
export function formatPartyState(state: PartyState): string[] {
  const a = state.active;
  const lines = [`Party tab: destination ${state.destination ?? 'All'}, append ${state.append ? 'on' : 'off'}`, '', 'Applied to the calculation:'];
  lines.push(`  Auras: ${effectList(a.auras)}`);
  if (a.auraDebuffs.length > 0) lines.push(`  Aura debuffs on the enemy: ${effectList(a.auraDebuffs)}`);
  if (a.extraAuraMods > 0) lines.push(`  Extra aura modifiers: ${a.extraAuraMods}`);
  if (a.otherEffects.length > 0) lines.push(`  Other buffs: ${effectList(a.otherEffects)}`);
  lines.push(`  Curses${a.curseLimit !== undefined ? ` (party curse limit ${a.curseLimit})` : ''}: ${effectList(a.curses)}`);
  lines.push(`  Warcries: ${effectList(a.warcries)}`);
  lines.push(`  Links: ${effectList(a.links)}`);
  const stats = Object.entries(a.partyMemberStats ?? {});
  const memberStats = [...stats.map(([k, v]) => `${k}=${formatStat(v)}`), ...a.partyMemberFlags];
  lines.push(`  Party member stats: ${memberStats.length > 0 ? memberStats.join(', ') : '-'}`);
  const conditions = a.enemyMods.filter((m) => m.name.startsWith('Condition:'));
  const mods = a.enemyMods.filter((m) => !m.name.startsWith('Condition:'));
  lines.push(`  Enemy conditions: ${conditions.length > 0 ? conditions.map((m) => m.name.replace(/^Condition:(Party:)?/, '')).join(', ') : '-'}`);
  lines.push(`  Enemy modifiers: ${mods.length > 0 ? mods.map((m) => `${m.name} ${m.type} ${m.value ?? ''}`.trim()).join(', ') : '-'}`);

  const kept = Object.entries(state.imported).filter(([, text]) => text !== '').map(([name]) => name);
  const anyActive = a.auras.length + a.auraDebuffs.length + a.curses.length + a.warcries.length + a.links.length
    + a.enemyMods.length + stats.length + a.partyMemberFlags.length + a.otherEffects.length + a.extraAuraMods > 0;
  lines.push('', `Imported text kept in the tab: ${kept.length > 0 ? kept.join(', ') : 'none'}`);
  if (kept.length > 0 && !anyActive) lines.push('None of it applies now (Disable Party Effects); party_rebuild applies it again.');
  lines.push(`This build's own Export Support: ${state.exportSupport ? 'on' : 'off'}`);
  return lines;
}

function statLines(before: StatsExport | undefined, after: StatsExport): string[] {
  const lines: string[] = [];
  for (const { key, label } of PARTY_STATS) {
    const now = statNumber(after, key);
    if (now === undefined) continue;
    const was = before ? statNumber(before, key) : undefined;
    if (was === undefined || was === now) continue;
    lines.push(`  ${label}: ${formatStat(was)} → ${formatStat(now)}  ${formatDelta(now - was, was)}`);
  }
  return lines.length > 0 ? ['', 'Stats changed:', ...lines] : ['', 'No compared stat changed (Combined DPS, life, EHP, defences, resistances, speed).'];
}

const statKeys = PARTY_STATS.map((s) => s.key);

async function withStats(luaClient: PoBLuaApiClient, change: () => Promise<PartyState>): Promise<string[]> {
  const before = await luaClient.getStats(statKeys);
  const state = await change();
  const after = await luaClient.getStats(statKeys);
  return [...formatPartyState(state), ...statLines(before, after)];
}

export async function handleGetParty(context: LuaHandlerContext) {
  return wrapHandler('get Party tab', async () => {
    const luaClient = await client(context);
    const state = await luaClient.getParty();
    return { content: [{ type: "text" as const, text: formatPartyState(state).join('\n') }] };
  });
}

export interface PartyImportArgs {
  /** A PoB build code (Import/Export "Generate"). */
  code?: string;
  /** A build file in the builds directory. */
  buildName?: string;
  /** Build XML. */
  xml?: string;
  destination?: string;
  append?: boolean;
}

export async function handlePartyImport(context: LuaHandlerContext, args: PartyImportArgs) {
  return wrapHandler('import into the Party tab', async () => {
    const sources = [args.code, args.buildName, args.xml].filter((s) => typeof s === 'string' && s.trim() !== '');
    if (sources.length !== 1) throw new Error('give exactly one of code, build_name or xml');
    const destination = parseDestination(args.destination);
    let xml: string;
    if (args.code) {
      if (/^\s*https?:\/\//i.test(args.code)) {
        throw new Error('build site links are not downloaded here; open the link, copy its build code, and pass that as code');
      }
      xml = decodeBuildCode(args.code);
    } else if (args.buildName) {
      xml = await fs.readFile(resolveBuildFile(args.buildName, context.pobDirectory), 'utf8');
    } else {
      xml = args.xml as string;
    }
    const luaClient = await client(context);
    let exported: string[] = [];
    const lines = await withStats(luaClient, async () => {
      const state = await luaClient.partyImport({ xml, destination, append: args.append === true });
      exported = state.exportedSections ?? [];
      return state;
    });
    const header = [
      `Imported into the Party tab (${destination ?? 'All'}${args.append === true ? ', appended' : ', replacing'}).`,
      `The source exports: ${exported.join(', ')}.`,
      '',
    ];
    return { content: [{ type: "text" as const, text: [...header, ...lines].join('\n') }] };
  });
}

export async function handlePartyClear(context: LuaHandlerContext, destinationArg?: string) {
  return wrapHandler('clear the Party tab', async () => {
    const destination = parseDestination(destinationArg);
    const luaClient = await client(context);
    const lines = await withStats(luaClient, () => luaClient.partyClear(destination));
    // PartyTab's Clear button always empties the enemy modifier list as well.
    const note = `Cleared ${destination ?? 'All'} in the Party tab (PoB's Clear also drops the parsed enemy conditions and modifiers).`;
    return { content: [{ type: "text" as const, text: [note, '', ...lines].join('\n') }] };
  });
}

export async function handlePartyDisableEffects(context: LuaHandlerContext) {
  return wrapHandler('disable party effects', async () => {
    const luaClient = await client(context);
    const lines = await withStats(luaClient, () => luaClient.partyDisableEffects());
    return { content: [{ type: "text" as const, text: ['Party effects disabled; the imported text is kept.', '', ...lines].join('\n') }] };
  });
}

export async function handlePartyRebuild(context: LuaHandlerContext) {
  return wrapHandler('rebuild party effects', async () => {
    const luaClient = await client(context);
    const lines = await withStats(luaClient, () => luaClient.partyRebuild());
    return { content: [{ type: "text" as const, text: ['Party effects rebuilt from the text in the tab.', '', ...lines].join('\n') }] };
  });
}

/** Effect names in a PartyTab:exportBuffs text: the line after each "---" divider. */
export function exportedNames(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim());
  const names: string[] = [];
  let expectName = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '--- Curse Limit ---') { i++; continue; }
    if (line === '---') { expectName = true; continue; }
    if (expectName && line !== '') {
      names.push(line);
      expectName = false;
    }
  }
  return names;
}

export async function handleSetPartyExportSupport(context: LuaHandlerContext, enabled: boolean) {
  return wrapHandler('set Export Support', async () => {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
    const luaClient = await client(context);
    const result = await luaClient.setPartyExportSupport(enabled);
    const lines = [`Export Support is ${result.exportSupport ? 'on' : 'off'} for the loaded build.`];
    if (result.exportSupport) {
      const exports = Object.entries(result.exports ?? {});
      lines.push('', 'What its build file or code will carry for another build\'s Party tab:');
      for (const [section, text] of exports) {
        const count = text.split('\n').filter((l) => l.trim() !== '').length;
        const detail = ['Aura', 'Curse', 'Warcry Skills', 'Link Skills'].includes(section)
          ? (exportedNames(text).join(', ') || 'none')
          : `${count} ${count === 1 ? 'line' : 'lines'}`;
        lines.push(`  ${section}: ${detail}`);
      }
      if (exports.length === 0) lines.push('  nothing (no auras, curses, warcries, links or enemy modifiers to share)');
      lines.push('', 'Save it (lua_save_build) or export it (export_build), then party_import it into the other build.');
    }
    return { content: [{ type: "text" as const, text: lines.join('\n') }] };
  });
}
