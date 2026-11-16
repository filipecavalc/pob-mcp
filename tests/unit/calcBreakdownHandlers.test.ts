import { describe, it, expect } from '@jest/globals';
import { handleGetCalcBreakdown, handleListCalcBreakdowns, formatBreakdownSection } from '../../src/handlers/calcBreakdownHandlers.js';
import type { CalcBreakdownResult, CalcBreakdownList, CalcCell } from '../../src/pobLuaBridge.js';
import { textOf } from '../helpers/response.js';

type Context = Parameters<typeof handleGetCalcBreakdown>[0];

function contextWith(client: Record<string, unknown>, calls: unknown[] = []): Context {
  const recording = Object.fromEntries(Object.entries(client).map(([name, fn]) => [name, async (params: unknown) => {
    calls.push({ name, params });
    return (fn as (p: unknown) => unknown)(params);
  }]));
  return { ensureLuaClient: async () => {}, getLuaClient: () => recording } as unknown as Context;
}

const fireResist: CalcCell = {
  id: 'Resist/1/1/1', section: 'Resist', subsection: 'Resists', row: 'Fire Resist', value: '90% (+226%)',
  outputKey: 'FireResist', breakdowns: ['FireResist'], hasBreakdown: true, shown: true,
};

describe('get_calc_breakdown', () => {
  it('prints PoB breakdown lines and modifier tables as text', async () => {
    const result: CalcBreakdownResult = {
      ...fireResist, found: true, mode: 'EFFECTIVE', actor: 'player', haveMinion: false, skill: 'Righteous Fire',
      sections: [
        { type: 'text', lines: ['Min: -200%', 'Max: 90%', 'Total: 316%'] },
        { type: 'table', columns: ['Value', 'Stat', 'Source', 'Source Name'], rows: [['+75 base', 'Fire Resist Max', 'Base', ''], ['+42 base', 'Fire Resist', 'Skill', 'Purity of Fire']] },
      ],
    };
    const calls: unknown[] = [];
    const text = textOf(await handleGetCalcBreakdown(contextWith({ getCalcBreakdown: () => result }, calls), { stat: ' FireResist ', mode: 'unbuffed' }));
    expect(calls).toEqual([{ name: 'getCalcBreakdown', params: { stat: 'FireResist', section: undefined, minion: false, mode: 'UNBUFFED' } }]);
    expect(text).toContain('=== Resists > Fire Resist ===');
    expect(text).toContain('Value: 90% (+226%)   [Resist/1/1/1, output FireResist]');
    expect(text).toContain('Calculation mode: Effective DPS | player | skill: Righteous Fire');
    expect(text).toContain('Total: 316%');
    expect(text).toContain('Value | Stat | Source | Source Name');
    expect(text).toContain('+42 base | Fire Resist | Skill | Purity of Fire');
  });

  it('accepts the dropdown label as mode and rejects an unknown one', async () => {
    const calls: Array<{ params: { mode?: string } }> = [];
    const ctx = contextWith({ getCalcBreakdown: () => ({ found: false, candidates: [] }) }, calls);
    await handleGetCalcBreakdown(ctx, { stat: 'Life', mode: 'In Combat' });
    expect(calls[0].params.mode).toBe('COMBAT');
    await expect(handleGetCalcBreakdown(ctx, { stat: 'Life', mode: 'sometimes' })).rejects.toThrow(/mode must be one of/);
  });

  it('lists the candidates when a label names several stats', async () => {
    const life = { ...fireResist, id: 'Life/1/6/1', section: 'Life', subsection: 'Life', row: 'Total', value: '5,447', outputKey: 'Life', breakdowns: ['Life'] };
    const mana = { ...life, id: 'Mana/1/5/1', section: 'Mana', subsection: 'Mana', value: '624', outputKey: 'Mana', breakdowns: ['Mana'] };
    const text = textOf(await handleGetCalcBreakdown(contextWith({ getCalcBreakdown: () => ({ found: false, ambiguous: true, candidates: [life, mana] }) }), { stat: 'Total' }));
    expect(text).toContain('names more than one Calcs tab stat');
    expect(text).toContain('Life/1/6/1  Life > Total: 5,447  [breakdown: Life]');
    expect(text).toContain('Mana/1/5/1  Mana > Total: 624');
  });

  it('says so when the stat is hidden for the build, instead of printing an empty breakdown', async () => {
    const hidden: CalcBreakdownResult = {
      id: 'HitDamage/1/28/1', section: 'HitDamage', subsection: 'Skill Hit Damage', row: 'Skill DPS', column: 'All Types',
      outputKey: 'TotalDPS', breakdowns: ['TotalDPS'], hasBreakdown: true, shown: false,
      found: true, mode: 'EFFECTIVE', actor: 'player', haveMinion: false, sections: [],
    };
    const text = textOf(await handleGetCalcBreakdown(contextWith({ getCalcBreakdown: () => hidden }), { stat: 'TotalDPS' }));
    expect(text).toContain('Skill Hit Damage > Skill DPS (All Types)');
    expect(text).toContain('PoB hides this stat for this build');
  });

  it('requires a stat', async () => {
    await expect(handleGetCalcBreakdown(contextWith({}), { stat: '  ' })).rejects.toThrow(/stat is required/);
  });
});

describe('list_calc_breakdowns', () => {
  it('groups the cells by section with their ids and values', async () => {
    const list: CalcBreakdownList = { mode: 'EFFECTIVE', actor: 'player', haveMinion: false, cells: [fireResist, { ...fireResist, id: 'Resist/1/2/1', row: 'Cold Resist', value: '90% (+74%)', breakdowns: ['ColdResist'] }] };
    const calls: unknown[] = [];
    const text = textOf(await handleListCalcBreakdowns(contextWith({ listCalcBreakdowns: () => list }, calls), { filter: 'resist', includeHidden: true }));
    expect(calls).toEqual([{ name: 'listCalcBreakdowns', params: { filter: 'resist', includeHidden: true, minion: false, mode: undefined } }]);
    expect(text).toContain('Resist:\n  Resist/1/1/1  Resists > Fire Resist: 90% (+226%)  [breakdown: FireResist]');
    expect(text).toContain('2 stats.');
  });
});

describe('formatBreakdownSection', () => {
  it('keeps a table label and footer and shows an area radius', () => {
    expect(formatBreakdownSection({ type: 'table', label: 'Maximum hit damage breakdown', footer: 'note', columns: ['Type', 'Pool'], rows: [['100% as Fire', '5937']] }))
      .toEqual(['Maximum hit damage breakdown:', 'Type | Pool', '100% as Fire | 5937', 'note']);
    expect(formatBreakdownSection({ type: 'radius', radius: 24 })).toEqual(['Area radius: 24']);
  });
});
