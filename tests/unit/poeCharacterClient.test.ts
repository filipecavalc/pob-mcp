import { describe, it, expect } from '@jest/globals';
import { PoeCharacterClient, PoeCharacterError, normalizeAccountName, parseRateLimit } from '../../src/services/poeCharacterClient.js';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected request');
    const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: reply.status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})),
    };
  };
  return { fetchImpl, calls };
}

const noWait = { sleep: async () => {}, minIntervalMs: 0 };

describe('normalizeAccountName', () => {
  // PoB turns the last '-' or '#' into the discriminator's '#' and drops whitespace.
  it('keeps a name that already has a #discriminator', () => {
    expect(normalizeAccountName('Some Name#1234')).toBe('SomeName#1234');
  });
  it('turns the last dash into #', () => {
    expect(normalizeAccountName('my-name-1234')).toBe('my-name#1234');
  });
  // ImportTab.lua: console realms only trim the ends and keep inner spaces.
  it('keeps inner spaces on console realms', () => {
    expect(normalizeAccountName('  Big Bob#12? ', 'xbox')).toBe('Big Bob#12');
    expect(normalizeAccountName('Big Bob#12', 'sony')).toBe('Big Bob#12');
  });
});

describe('PoeCharacterClient review fixes', () => {
  it('sends console account names with their spaces encoded', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: [] }]);
    await new PoeCharacterClient({ fetchImpl, ...noWait }).listCharacters('Big Bob#12', 'xbox');
    expect(calls[0].url).toContain('accountName=Big%20Bob%2312&realm=xbox');
  });

  it('does not invent a Retry-After when the header is missing', async () => {
    const { fetchImpl } = fakeFetch([{ status: 429 }]);
    const error = await new PoeCharacterClient({ fetchImpl, ...noWait }).listCharacters('Acc#1').catch((e) => e);
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.message).not.toMatch(/retry after/);
  });

  it('treats a literal false body as no data, as PoB does', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: 'false' }]);
    await expect(new PoeCharacterClient({ fetchImpl, ...noWait }).getItems('Acc#1', 'C')).rejects.toThrow(/no data/);
  });

  it('reports a null character list cleanly', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: 'null' }]);
    await expect(new PoeCharacterClient({ fetchImpl, ...noWait }).listCharacters('Acc#1')).rejects.toThrow(/no character list/);
  });

  it('refuses to send while the last reported state shows a full rule', async () => {
    const { fetchImpl, calls } = fakeFetch([{
      status: 200, body: [],
      headers: { 'X-Rate-Limit-Policy': 'p', 'X-Rate-Limit-Ip': '15:60:120', 'X-Rate-Limit-Ip-State': '15:60:0' },
    }]);
    let clock = 0;
    const client = new PoeCharacterClient({ fetchImpl, minIntervalMs: 0, sleep: async () => {}, now: () => clock });
    await client.listCharacters('Acc#1');
    clock += 10_000;
    const error = await client.listCharacters('Acc#1').catch((e) => e);
    expect(error.message).toMatch(/rate limit reached .* wait about 50s/);
    expect(calls).toHaveLength(1);
  });

  it('allows requests again once the rule period has passed', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: [], headers: { 'X-Rate-Limit-Policy': 'p', 'X-Rate-Limit-Ip': '15:60:120', 'X-Rate-Limit-Ip-State': '15:60:0' } },
      { status: 200, body: [] },
    ]);
    let clock = 0;
    const client = new PoeCharacterClient({ fetchImpl, minIntervalMs: 0, sleep: async () => {}, now: () => clock });
    await client.listCharacters('Acc#1');
    clock += 61_000;
    await client.listCharacters('Acc#1');
    expect(calls).toHaveLength(2);
  });

  it('reads the exact account spelling from the profile page, as PoB does', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: '<a href="/account/view-profile/Acc-1/characters">Characters</a>' }]);
    const name = await new PoeCharacterClient({ fetchImpl, ...noWait }).resolveAccountName('acc#1');
    expect(calls[0].url).toBe('https://www.pathofexile.com/account/view-profile/acc%231');
    expect(name).toBe('Acc#1');
  });
});

describe('parseRateLimit', () => {
  it('pairs each rule with its current hit count', () => {
    const state = parseRateLimit('15:60:120,90:1800:600', '3:60:0,7:1800:0', 'backend-character-request-limit');
    expect(state).toEqual({
      policy: 'backend-character-request-limit',
      rules: [
        { limit: { hits: 15, periodSeconds: 60, penaltySeconds: 120 }, current: 3, restrictedSeconds: 0 },
        { limit: { hits: 90, periodSeconds: 1800, penaltySeconds: 600 }, current: 7, restrictedSeconds: 0 },
      ],
    });
  });
  it('returns undefined without a limit header', () => {
    expect(parseRateLimit(null, null)).toBeUndefined();
  });
});

describe('PoeCharacterClient', () => {
  it('requests the same character-window URLs PoB uses, with the # encoded', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: [{ name: 'Char One', class: 'Chieftain', league: 'Covens', level: 83 }] },
      { status: 200, body: { hashes: [1, 2] } },
      { status: 200, body: { items: [] } },
    ]);
    const client = new PoeCharacterClient({ fetchImpl, ...noWait });
    await client.listCharacters('Acc#1234');
    await client.getPassives('Acc#1234', 'Char One');
    await client.getItems('Acc#1234', 'Char One');
    expect(calls.map((c) => c.url)).toEqual([
      'https://www.pathofexile.com/character-window/get-characters?accountName=Acc%231234&realm=pc',
      'https://www.pathofexile.com/character-window/get-passive-skills?accountName=Acc%231234&character=Char%20One&realm=pc',
      'https://www.pathofexile.com/character-window/get-items?accountName=Acc%231234&character=Char%20One&realm=pc',
    ]);
    expect(calls[0].headers?.['User-Agent']).toBeTruthy();
  });

  it('accepts the { characters: [...] } response shape', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: { characters: [{ name: 'A', class: 'Witch', league: 'Standard', level: 1 }] } }]);
    const client = new PoeCharacterClient({ fetchImpl, ...noWait });
    await expect(client.listCharacters('Acc#1')).resolves.toHaveLength(1);
  });

  it.each([
    [403, /private or does not exist/],
    [401, /private or does not exist/],
    [404, /not found/],
    [500, /unexpected HTTP 500/],
  ])('maps HTTP %i to a clear error', async (status, message) => {
    const { fetchImpl } = fakeFetch([{ status }]);
    const client = new PoeCharacterClient({ fetchImpl, ...noWait });
    await expect(client.listCharacters('Acc#1')).rejects.toThrow(message);
  });

  it('reports Retry-After on HTTP 429', async () => {
    const { fetchImpl } = fakeFetch([{ status: 429, headers: { 'Retry-After': '60' } }]);
    const client = new PoeCharacterClient({ fetchImpl, ...noWait });
    const error = await client.listCharacters('Acc#1').catch((e) => e);
    expect(error).toBeInstanceOf(PoeCharacterError);
    expect(error.retryAfterSeconds).toBe(60);
    expect(error.message).toMatch(/retry after 60s/);
  });

  it('rejects a non-JSON body instead of passing HTML on', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: '<html>maintenance</html>' }]);
    const client = new PoeCharacterClient({ fetchImpl, ...noWait });
    await expect(client.listCharacters('Acc#1')).rejects.toThrow(/not JSON/);
  });

  it('records the server-reported rate-limit state per policy', async () => {
    const { fetchImpl } = fakeFetch([{
      status: 200,
      body: [],
      headers: { 'X-Rate-Limit-Policy': 'backend-character-request-limit', 'X-Rate-Limit-Ip': '15:60:120', 'X-Rate-Limit-Ip-State': '2:60:0' },
    }]);
    const client = new PoeCharacterClient({ fetchImpl, ...noWait });
    await client.listCharacters('Acc#1');
    expect(client.rateLimits.get('backend-character-request-limit')?.rules[0].current).toBe(2);
  });

  it('spaces consecutive requests by minIntervalMs', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: [] }, { status: 200, body: [] }]);
    let clock = 1_000;
    const waits: number[] = [];
    const client = new PoeCharacterClient({
      fetchImpl,
      minIntervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => { waits.push(ms); clock += ms; },
    });
    await client.listCharacters('Acc#1');
    clock += 250;
    await client.listCharacters('Acc#1');
    expect(waits).toEqual([750]);
  });
});
