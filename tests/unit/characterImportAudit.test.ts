import { describe, it, expect } from '@jest/globals';
import { describeAudit, describeLastLogin } from '../../src/handlers/characterImportHandlers.js';

describe('describeAudit', () => {
  it('confirms a complete import', () => {
    expect(describeAudit({ counts: { items: 15, gems: 19 }, missingItems: [], missingGems: [], unsupportedLines: [] }))
      .toEqual(['Import complete: all 15 items and 19 gems from pathofexile.com are in the build.']);
  });

  it('lists items and gems PoB did not import', () => {
    const out = describeAudit({
      counts: { items: 3, gems: 2 },
      missingItems: [{ where: 'Ring2', name: 'Doom Loop', base: 'Iron Ring' }],
      missingGems: [{ where: 'Helm', name: 'Some New Support' }],
      unsupportedLines: [],
    });
    expect(out).toContain('  item Ring2: Doom Loop, Iron Ring');
    expect(out).toContain('  gem Helm: Some New Support');
    expect(out.join('\n')).toMatch(/Not imported by PoB/);
  });

  it('lists lines PoB cannot calculate', () => {
    const out = describeAudit({
      counts: { items: 1, gems: 0 },
      missingItems: [],
      missingGems: [],
      unsupportedLines: [{ slot: 'Boots', item: 'Fate Hoof', line: '+13% to Item Rarity' }],
    });
    expect(out).toContain('  Boots (Fate Hoof): +13% to Item Rarity');
  });

  it('accepts dkjson shapes: empty tables as [] and sparse ones as objects', () => {
    const out = describeAudit({
      counts: { items: 1, gems: 0 },
      missingItems: [] as never,
      missingGems: {} as never,
      unsupportedLines: { 1: { slot: 'Ring 2', item: 'Le Heup of All', line: '+11% to Item Rarity' } } as never,
    });
    expect(out).toContain('  Ring 2 (Le Heup of All): +11% to Item Rarity');
  });

  it('mentions ignored bag entries without calling them missing', () => {
    expect(describeAudit({ counts: { items: 15, gems: 19, notEquipped: 4 }, missingItems: [], missingGems: [], unsupportedLines: [] })[0])
      .toMatch(/all 15 items and 19 gems .*\(4 unequipped bag entries ignored, as PoB does\.\)/);
  });

  it('reports an audit that could not run without failing the import', () => {
    expect(describeAudit({ error: 'boom' })).toEqual(['⚠️ Completeness check could not run (boom); the import itself succeeded.']);
  });

  it('says nothing when there is no audit', () => {
    expect(describeAudit(undefined)).toEqual([]);
  });
});

describe('describeLastLogin', () => {
  const now = new Date('2026-11-15T20:00:00Z');
  it('formats Unix seconds with how long ago', () => {
    expect(describeLastLogin(Date.parse('2026-11-15T19:30:00Z') / 1000, now)).toBe('2026-11-15 19:30 UTC (30 min ago)');
    expect(describeLastLogin(Date.parse('2026-11-14T20:00:00Z') / 1000, now)).toBe('2026-11-14 20:00 UTC (24 h ago)');
    expect(describeLastLogin(Date.parse('2026-11-01T20:00:00Z') / 1000, now)).toBe('2026-11-01 20:00 UTC (14 days ago)');
  });
  it('ignores missing or invalid values', () => {
    expect(describeLastLogin(undefined, now)).toBeUndefined();
    expect(describeLastLogin('x', now)).toBeUndefined();
    expect(describeLastLogin(0, now)).toBeUndefined();
  });
});
