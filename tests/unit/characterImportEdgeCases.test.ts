import { describe, it, expect } from '@jest/globals';
import { PoeCharacterClient } from '../../src/services/poeCharacterClient.js';
import { describeItemRaw, describeGearChanges, gemsBySlot, describeGemChanges } from '../../src/handlers/characterImportHandlers.js';

function scriptedFetch(replies: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: number[] = [];
  let clock = 100_000; // like Date.now(): well past the client's initial lastRequestAt of 0
  const fetchImpl = async () => {
    calls.push(clock);
    const r = replies.shift() ?? { status: 200, body: '[]' };
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => r.body ?? '[]' };
  };
  return { fetchImpl, calls, now: () => clock, advance: (ms: number) => { clock += ms; } };
}

describe('PoeCharacterClient under concurrency and penalties', () => {
  it('spaces concurrent requests instead of firing them together', async () => {
    const f = scriptedFetch([]);
    const client = new PoeCharacterClient({ fetchImpl: f.fetchImpl, minIntervalMs: 1000, now: f.now, sleep: async (ms) => f.advance(ms) });
    await Promise.all([client.listCharacters('A#1'), client.listCharacters('A#1'), client.listCharacters('A#1')]);
    expect(f.calls).toEqual([100_000, 101_000, 102_000]);
  });

  it('honours an active penalty reported in the state header', async () => {
    const f = scriptedFetch([{ status: 200, body: '[]', headers: { 'X-Rate-Limit-Policy': 'p', 'X-Rate-Limit-Ip': '15:60:120', 'X-Rate-Limit-Ip-State': '3:60:90' } }]);
    const client = new PoeCharacterClient({ fetchImpl: f.fetchImpl, minIntervalMs: 0, now: f.now, sleep: async () => {} });
    await client.listCharacters('A#1');
    f.advance(30_000);
    await expect(client.listCharacters('A#1')).rejects.toThrow(/restricting requests .* wait about 60s/);
    expect(f.calls).toHaveLength(1);
  });

  it('keeps working after a failed request', async () => {
    const f = scriptedFetch([{ status: 500 }, { status: 200, body: '[]' }]);
    const client = new PoeCharacterClient({ fetchImpl: f.fetchImpl, minIntervalMs: 0, now: f.now, sleep: async () => {} });
    await expect(client.listCharacters('A#1')).rejects.toThrow(/500/);
    await expect(client.listCharacters('A#1')).resolves.toEqual([]);
  });
});

describe('gear comparison edge cases', () => {
  const slot = (raw: string, label: string) => ({ label, ...describeItemRaw(raw) });

  it('ignores PoB planner prefixes such as {tags:...} and {range:...} but keeps {crafted}', () => {
    expect(describeItemRaw('Implicits: 0\n{tags:life}{range:0.5}+90 to maximum Life\n{crafted}+20 to Strength').lines)
      .toEqual(['+90 to maximum Life', '{crafted}+20 to Strength']);
  });

  it('compares an id-less planner item with its imported copy by name without markup noise', () => {
    const planner = slot('Rarity: UNIQUE\nImmortal Flesh\nImplicits: 1\n{tags:life}+30 to maximum Life\n{range:0.5}Regenerate (250-300) Life per second', 'Immortal Flesh');
    const imported = slot('Rarity: UNIQUE\nImmortal Flesh\nUnique ID: abc\nImplicits: 1\n+30 to maximum Life\nRegenerate (250-300) Life per second', 'Immortal Flesh');
    expect(describeGearChanges(new Map([['Belt', planner]]), new Map([['Belt', imported]]))).toEqual([]);
  });

  it('notices a duplicated mod line changing count', () => {
    const a = slot('Unique ID: x\nImplicits: 0\n+10 to Strength\n+10 to Strength', 'Ring');
    const b = slot('Unique ID: x\nImplicits: 0\n+10 to Strength', 'Ring');
    expect(describeGearChanges(new Map([['Ring 1', a]]), new Map([['Ring 1', b]]))).toEqual(['  Ring 1: Ring changed', '      - +10 to Strength']);
  });
});

describe('gem comparison edge cases', () => {
  it('does not report two copies of a gem as changed when only their order differs', () => {
    const before = gemsBySlot({ groups: [{ slot: 'Gloves', gems: [{ name: 'Lifetap', level: 5 }, { name: 'Lifetap', level: 18 }] }] });
    const after = gemsBySlot({ groups: [{ slot: 'Gloves', gems: [{ name: 'Lifetap', level: 18 }, { name: 'Lifetap', level: 5 }] }] });
    expect(describeGemChanges(before, after)).toEqual([]);
  });
});
