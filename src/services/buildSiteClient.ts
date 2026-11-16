/**
 * Network side of Path of Building's build sharing.
 *
 * PoB decides every URL and field in Lua: buildSites.websiteList
 * (Modules/BuildSiteTools.lua) and ImportBuild (Modules/Common.lua). The
 * headless engine has no HTTP client, so the requests those functions would
 * make through launch:DownloadPage and buildSites.UploadBuild (lcurl) run
 * here instead, with the same method, body and success rules.
 */

/** One entry of buildSites.websiteList (list_build_sites / resolve_build_link). */
export interface BuildSite {
  label: string;
  id: string;
  matchURL?: string;
  regexURL?: string;
  downloadURL?: string;
  codeOut?: string;
  postUrl?: string;
  postFields?: string;
  linkURL?: string;
  /** postUrl, postFields and codeOut are all set (ImportTab's export site list). */
  canShare: boolean;
}

/** resolve_build_link result (M.resolve_build_link). */
export type ResolvedBuildLink =
  | { kind: 'code' }
  | { kind: 'link'; link: string; downloadUrl: string; site?: BuildSite };

interface FetchResponse {
  status: number;
  headers?: { get(name: string): string | null };
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
  text(): Promise<string>;
}

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow';
  signal?: AbortSignal;
}) => Promise<FetchResponse>;

/**
 * Cloudflare answers bots it challenges with 403 and "cf-mitigated: challenge".
 * The challenge needs a browser; it is reported, never worked around.
 */
function challengeNote(response: FetchResponse): string {
  return response.headers?.get('cf-mitigated') === 'challenge'
    ? ' (the site answered with a Cloudflare bot challenge, which only a browser can pass)'
    : '';
}

export interface BuildSiteClientOptions {
  fetchImpl?: FetchLike;
  userAgent?: string;
  /** Whole request, body included (default 15 s, as the poe.ninja client). */
  timeoutMs?: number;
  /** Largest response accepted (default 10 MB; build codes are far smaller). */
  maxResponseBytes?: number;
}

export class BuildSiteError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'BuildSiteError';
  }
}

export class BuildSiteClient {
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: BuildSiteClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.userAgent = options.userAgent ?? 'pob-mcp-server/1.0';
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
  }

  /**
   * GET as launch:DownloadPage (Launch.lua): follows redirects; an HTTP status
   * other than 200 or an empty body is an error.
   */
  async download(url: string): Promise<string> {
    const { response, body } = await this.request(url, { method: 'GET', headers: { 'User-Agent': this.userAgent } });
    if (response.status !== 200) throw new BuildSiteError(`${url}: Response code: ${response.status}${challengeNote(response)}`, response.status);
    if (body.length === 0) throw new BuildSiteError(`${url}: No data returned`, response.status);
    return body;
  }

  /**
   * POST as buildSites.UploadBuild (BuildSiteTools.lua): curl OPT_POSTFIELDS
   * with the body sent as given (form encoding, no escaping), redirects
   * followed, success only on 200.
   */
  async post(url: string, body: string): Promise<string> {
    const { response, body: text } = await this.request(url, {
      method: 'POST',
      headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (response.status !== 200) {
      const challenge = challengeNote(response);
      const detail = challenge ? '' : text.trim().slice(0, 300);
      throw new BuildSiteError(`${url}: HTTP ${response.status}${challenge}${detail ? `: ${detail}` : ''}`, response.status);
    }
    return text;
  }

  /**
   * buildSites.UploadBuild: POST postFields .. code to postUrl; on 200
   * ImportTab's Share button shows codeOut .. response. The response is
   * trimmed of surrounding whitespace.
   */
  async uploadBuild(site: BuildSite, code: string): Promise<string> {
    if (!site.canShare || site.postUrl === undefined || site.postFields === undefined || site.codeOut === undefined) {
      throw new BuildSiteError(`${site.label} does not accept uploads in Path of Building`);
    }
    const response = await this.post(site.postUrl, site.postFields + code);
    const id = response.trim();
    if (!id) throw new BuildSiteError(`${site.label} returned an empty response`);
    return site.codeOut + id;
  }

  private async request(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ response: FetchResponse; body: string }> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, redirect: 'follow', signal });
      const declared = Number(response.headers?.get('content-length'));
      if (Number.isFinite(declared) && declared > this.maxResponseBytes) throw this.tooLarge(url);
      return { response, body: await this.readBody(url, response) };
    } catch (e) {
      if (e instanceof BuildSiteError) throw e;
      const name = (e as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError' || signal.aborted) {
        throw new BuildSiteError(`${url}: no complete answer within ${Math.round(this.timeoutMs / 1000)} s`);
      }
      throw new BuildSiteError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private tooLarge(url: string): BuildSiteError {
    return new BuildSiteError(`${url}: response larger than ${Math.round(this.maxResponseBytes / 1024)} KB; not a build code`);
  }

  private async readBody(url: string, response: FetchResponse): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) throw this.tooLarge(url);
      return text;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > this.maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw this.tooLarge(url);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

let shared: BuildSiteClient | undefined;

export function sharedBuildSiteClient(): BuildSiteClient {
  shared ??= new BuildSiteClient();
  return shared;
}
