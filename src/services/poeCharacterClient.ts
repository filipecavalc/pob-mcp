/**
 * Reads a character from pathofexile.com's public character-window endpoints,
 * the same requests Path of Building's "Import from website" makes
 * (ImportTab.lua: DownloadSiteCharacterList, DownloadPassiveTree, DownloadItems).
 * The account's profile must expose its characters; no login is involved.
 */

export type Realm = 'pc' | 'xbox' | 'sony';

/** One entry of get-characters, as PoB passes it on to its importer. */
export interface CharacterEntry {
  name: string;
  class: string;
  league: string;
  level: number;
  [key: string]: unknown;
}

export interface RateLimitRule {
  hits: number;
  periodSeconds: number;
  penaltySeconds: number;
}

export interface RateLimitState {
  policy?: string;
  /** current: hits counted in the period; restrictedSeconds: active penalty, 0 when none. */
  rules: Array<{ limit: RateLimitRule; current: number; restrictedSeconds: number }>;
}

export class PoeCharacterError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'PoeCharacterError';
  }
}

const SITE = 'https://www.pathofexile.com/';
const API = `${SITE}character-window/`;

/**
 * PoB's normalisation (ImportTab.lua): on PC drop all whitespace; on console
 * realms trim spaces and '?' at the ends and keep inner spaces (PoB sends them
 * as '+', which a query string reads as a space, as %20 is). Then the last '-'
 * or '#' becomes the '#' before the account discriminator.
 */
export function normalizeAccountName(accountName: string, realm: Realm = 'pc'): string {
  const trimmed = realm === 'pc'
    ? accountName.replace(/\s+/g, '')
    : accountName.replace(/^[\s?]+/, '').replace(/[\s?]+$/, '');
  return trimmed.replace(/(.*)[#-]/, '$1#');
}

/**
 * Limit "hits:period:penalty" ("15:60:120,90:1800:600") paired with state
 * "current:period:activePenalty" ("1:60:0,1:1800:0").
 */
export function parseRateLimit(limitHeader: string | null, stateHeader: string | null, policy?: string | null): RateLimitState | undefined {
  if (!limitHeader) return undefined;
  const limits = limitHeader.split(',').map((rule) => {
    const [hits, periodSeconds, penaltySeconds] = rule.split(':').map(Number);
    return { hits, periodSeconds, penaltySeconds };
  });
  const states = (stateHeader ?? '').split(',').map((rule) => rule.split(':').map(Number));
  const num = (n: number | undefined) => (n !== undefined && Number.isFinite(n) ? n : 0);
  return {
    policy: policy ?? undefined,
    rules: limits.map((limit, i) => ({ limit, current: num(states[i]?.[0]), restrictedSeconds: num(states[i]?.[2]) })),
  };
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface PoeCharacterClientOptions {
  fetchImpl?: FetchLike;
  userAgent?: string;
  /** Gap between consecutive requests; GGG's character policy allows 15 per 60s. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class PoeCharacterClient {
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastRequestAt = 0;
  /** Last server-reported rate-limit state per policy. */
  readonly rateLimits = new Map<string, RateLimitState>();
  private readonly rateLimitSeenAt = new Map<string, number>();

  constructor(options: PoeCharacterClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.userAgent = options.userAgent ?? 'pob-mcp-server/1.0';
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async listCharacters(accountName: string, realm: Realm = 'pc'): Promise<CharacterEntry[]> {
    const body = await this.getJson(`get-characters?accountName=${this.account(accountName, realm)}&realm=${realm}`);
    const list = Array.isArray(body) ? body : (body as { characters?: unknown } | null)?.characters;
    if (!Array.isArray(list)) throw new PoeCharacterError('Unexpected get-characters response: no character list.');
    return list as CharacterEntry[];
  }

  async getPassives(accountName: string, character: string, realm: Realm = 'pc'): Promise<Record<string, unknown>> {
    return this.getJson(`get-passive-skills?accountName=${this.account(accountName, realm)}&character=${encodeURIComponent(character)}&realm=${realm}`) as Promise<Record<string, unknown>>;
  }

  async getItems(accountName: string, character: string, realm: Realm = 'pc'): Promise<Record<string, unknown>> {
    return this.getJson(`get-items?accountName=${this.account(accountName, realm)}&character=${encodeURIComponent(character)}&realm=${realm}`) as Promise<Record<string, unknown>>;
  }

  /**
   * get-characters ignores the account name's case but get-passive-skills and
   * get-items do not. PoB works around this by reading the exact spelling from
   * the profile page (ImportTab.lua, DownloadSiteCharacterList); so does this.
   */
  async resolveAccountName(accountName: string, realm: Realm = 'pc'): Promise<string> {
    const html = await this.request(`${SITE}account/view-profile/${this.account(accountName, realm)}`, 'view-profile');
    const match = html.match(/\/view-profile\/([^/"'?]+)\/characters/);
    if (!match) throw new PoeCharacterError('Could not read the account name from its profile page.');
    let name = match[1];
    try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* keep as found */ }
    return normalizeAccountName(name, realm);
  }

  private account(accountName: string, realm: Realm): string {
    return encodeURIComponent(normalizeAccountName(accountName, realm));
  }

  private async getJson(path: string): Promise<unknown> {
    const endpoint = path.split('?')[0];
    const text = await this.request(API + path, endpoint);
    // PoB treats a literal "false" body as "no data" (ImportTab.lua, DownloadPassiveTree).
    if (text.trim() === 'false') throw new PoeCharacterError(`${endpoint}: pathofexile.com returned no data for this character.`);
    try {
      return JSON.parse(text);
    } catch {
      throw new PoeCharacterError(`${endpoint}: response was not JSON (a Cloudflare or maintenance page?).`);
    }
  }

  /** Refuse before sending when the last reported state says a rule is already full. */
  private checkRateLimits(): void {
    const now = this.now();
    for (const [policy, state] of this.rateLimits) {
      const seenAt = this.rateLimitSeenAt.get(policy) ?? 0;
      for (const { limit, current, restrictedSeconds } of state.rules) {
        const elapsed = (now - seenAt) / 1000;
        if (restrictedSeconds > 0 && elapsed < restrictedSeconds) {
          const wait = Math.ceil(restrictedSeconds - elapsed);
          throw new PoeCharacterError(`pathofexile.com is restricting requests (${policy}); wait about ${wait}s.`, 429, wait);
        }
        if (current >= limit.hits && elapsed < limit.periodSeconds) {
          const wait = Math.ceil(limit.periodSeconds - elapsed);
          throw new PoeCharacterError(`pathofexile.com rate limit reached (${policy}: ${current}/${limit.hits} per ${limit.periodSeconds}s); wait about ${wait}s.`, 429, wait);
        }
      }
    }
  }

  /** Requests run one at a time, so spacing and the rate-limit check hold for concurrent callers. */
  private queue: Promise<unknown> = Promise.resolve();

  private request(url: string, endpoint: string): Promise<string> {
    const run = this.queue.then(() => this.send(url, endpoint));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(url: string, endpoint: string): Promise<string> {
    this.checkRateLimits();
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();

    const response = await this.fetchImpl(url, { headers: { 'User-Agent': this.userAgent } });
    const state = parseRateLimit(
      response.headers.get('x-rate-limit-ip'),
      response.headers.get('x-rate-limit-ip-state'),
      response.headers.get('x-rate-limit-policy'),
    );
    if (state) {
      const policy = state.policy ?? 'unknown';
      this.rateLimits.set(policy, state);
      this.rateLimitSeenAt.set(policy, this.now());
    }

    switch (response.status) {
      case 200:
        return response.text();
      case 401:
      case 403:
        throw new PoeCharacterError(`${endpoint}: the account's profile is private or does not exist (HTTP ${response.status}). Its Characters tab must be public.`, response.status);
      case 404:
        throw new PoeCharacterError(`${endpoint}: account or character not found (HTTP 404). Check the account name, including its #1234 discriminator.`, 404);
      case 429: {
        const header = response.headers.get('retry-after');
        const retry = header === null || header.trim() === '' ? undefined : Number(header);
        const seconds = retry !== undefined && Number.isFinite(retry) ? retry : undefined;
        throw new PoeCharacterError(`${endpoint}: rate limited by pathofexile.com (HTTP 429)${seconds !== undefined ? `; retry after ${seconds}s` : ''}.`, 429, seconds);
      }
      default:
        throw new PoeCharacterError(`${endpoint}: unexpected HTTP ${response.status} from pathofexile.com.`, response.status);
    }
  }
}

let shared: PoeCharacterClient | undefined;

/** One client per server process, so request spacing and rate-limit state span tool calls. */
export function sharedPoeCharacterClient(): PoeCharacterClient {
  shared ??= new PoeCharacterClient();
  return shared;
}
