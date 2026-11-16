import { wrapHandler } from "../utils/errorHandling.js";
import type { CalcBreakdownSection, CalcCell, CalcMode, PoBLuaApiClient } from "../pobLuaBridge.js";
import type { LuaHandlerContext } from "./luaHandlers.js";

/**
 * Calcs tab breakdowns. The rows come from PoB itself: the Lua side walks the
 * Calcs tab's cells (Modules/CalcSections.lua) and runs
 * CalcBreakdownControl's AddBreakdownSection / AddModSection on them, so
 * this file only lays the result out as text.
 */

const MODE_LABELS: Record<CalcMode, string> = {
  UNBUFFED: 'Unbuffed',
  BUFFED: 'Buffed',
  COMBAT: 'In Combat',
  EFFECTIVE: 'Effective DPS',
};

const CALC_MODES = Object.keys(MODE_LABELS) as CalcMode[];

export interface CalcViewArgs {
  minion?: boolean;
  mode?: string;
}

function parseMode(mode: string | undefined): CalcMode | undefined {
  if (mode === undefined || mode === '') return undefined;
  const wanted = mode.toUpperCase().replace(/[\s_-]/g, '');
  const found = CALC_MODES.find((m) => m === wanted)
    ?? CALC_MODES.find((m) => MODE_LABELS[m].toUpperCase().replace(/\s/g, '') === wanted);
  if (!found) throw new Error(`mode must be one of ${CALC_MODES.join(', ')}`);
  return found;
}

async function client(context: LuaHandlerContext): Promise<PoBLuaApiClient> {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_start, then load a build.');
  return luaClient;
}

export function cellPath(cell: Pick<CalcCell, 'section' | 'subsection' | 'row' | 'column'>): string {
  const parts = [cell.subsection || cell.section, cell.row].filter(Boolean).join(' > ');
  return cell.column ? `${parts} (${cell.column})` : parts;
}

function cellLine(cell: CalcCell): string {
  const value = cell.shown ? (cell.value !== undefined && cell.value !== '' ? cell.value : '-') : 'hidden for this build';
  const keys = cell.breakdowns.length > 0 ? `  [breakdown: ${cell.breakdowns.join(', ')}]` : '';
  return `  ${cell.id}  ${cellPath(cell)}: ${value}${keys}`;
}

function viewLine(view: { mode: CalcMode; actor: string; skill?: string }): string {
  return `Calculation mode: ${MODE_LABELS[view.mode] ?? view.mode} | ${view.actor === 'minion' ? 'minion' : 'player'}` +
    (view.skill ? ` | skill: ${view.skill}` : '');
}

/** One breakdown section as text: lines, or a pipe table, as PoB draws them. */
export function formatBreakdownSection(section: CalcBreakdownSection): string[] {
  if (section.type === 'text') return [...section.lines];
  if (section.type === 'radius') return [`Area radius: ${section.radius}`];
  const lines: string[] = [];
  if (section.label) lines.push(`${section.label}:`);
  lines.push(section.columns.join(' | '));
  for (const row of section.rows) lines.push(row.join(' | '));
  if (section.footer) lines.push(section.footer);
  return lines;
}

export async function handleListCalcBreakdowns(context: LuaHandlerContext, args: CalcViewArgs & { filter?: string; includeHidden?: boolean }) {
  return wrapHandler('list Calcs tab stats', async () => {
    const luaClient = await client(context);
    const result = await luaClient.listCalcBreakdowns({
      filter: args.filter, includeHidden: args.includeHidden === true, minion: args.minion === true, mode: parseMode(args.mode),
    });
    const lines = [`=== Calcs tab${args.filter ? ` matching "${args.filter}"` : ''} ===`, viewLine(result), ''];
    if (result.cells.length === 0) {
      lines.push(args.filter ? 'No Calcs tab stat matches that filter.' : 'The Calcs tab shows no stats for this build.');
    } else {
      let section = '';
      for (const cell of result.cells) {
        if (cell.section !== section) {
          section = cell.section;
          lines.push(`${section}:`);
        }
        lines.push(cellLine(cell));
      }
      lines.push('', `${result.cells.length} stats. Pass an id, an output or breakdown key, or a row label to get_calc_breakdown.`);
    }
    return { content: [{ type: "text" as const, text: lines.join('\n') }] };
  });
}

export async function handleGetCalcBreakdown(context: LuaHandlerContext, args: CalcViewArgs & { stat: string; section?: string }) {
  return wrapHandler('get Calcs breakdown', async () => {
    if (typeof args.stat !== 'string' || args.stat.trim() === '') throw new Error('stat is required');
    const luaClient = await client(context);
    const result = await luaClient.getCalcBreakdown({
      stat: args.stat.trim(), section: args.section, minion: args.minion === true, mode: parseMode(args.mode),
    });
    if (!result.found) {
      const lines = result.ambiguous
        ? [`"${args.stat}" names more than one Calcs tab stat. Pass one of these ids as stat, or narrow with section:`]
        : [`No Calcs tab stat is named "${args.stat}".${result.candidates.length > 0 ? ' Stats whose names contain it:' : ' list_calc_breakdowns lists them.'}`];
      for (const cell of result.candidates) lines.push(cellLine(cell));
      return { content: [{ type: "text" as const, text: lines.join('\n') }] };
    }
    const lines = [
      `=== ${cellPath(result)} ===`,
      `Value: ${result.shown ? (result.value || '-') : '(hidden)'}   [${result.id}${result.outputKey ? `, output ${result.outputKey}` : ''}]`,
      viewLine(result),
      '',
    ];
    if (!result.shown) {
      lines.push('PoB hides this stat for this build (it does not apply to the skill or setup the Calcs tab shows), so there is no breakdown.');
    } else if (result.sections.length === 0) {
      lines.push('PoB shows no breakdown for this stat, only its value.');
    } else {
      result.sections.forEach((section, i) => {
        if (i > 0) lines.push('');
        lines.push(...formatBreakdownSection(section));
      });
    }
    return { content: [{ type: "text" as const, text: lines.join('\n') }] };
  });
}
