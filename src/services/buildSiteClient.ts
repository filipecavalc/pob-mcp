/**
 * Network side of Path of Building's build sharing and build archives.
 *
 * PoB decides every URL, field and parsing rule in Lua: buildSites.websiteList
 * (Modules/BuildSiteTools.lua), ImportBuild (Modules/Common.lua) and
 * PoBArchivesProvider (Classes/PoBArchivesProvider.lua). The headless engine
 * has no HTTP client, so the requests those functions would make through
 * launch:DownloadPage and LaunchSubScript/lcurl run here instead, with the
 * same method, body and success rules.
 */
import zlib from "zlib";

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

/** archives_request result (M.archives_request). */
export interface ArchivesRequest {
  mode: 'builds' | 'similar';
  list: string;
  lists: string[];
  url: string;
  method: 'GET' | 'POST';
  /** Prefix of the POST body, "importCode=" for Similar Builds. */
  postField?: string;
  pageUrl?: string;
}

/** One build as PoBArchivesProvider:ParseBuilds fills buildList. */
export interface ArchiveBuild {
  buildName?: string;
  author?: string;
  mainSkill?: string;
  ascendancy?: string;
  class?: string;
  previewLink?: string;
  buildLink?: string;
  ehp?: number;
  life?: number;
  es?: number;
  dps?: number;
  version?: string;
  metadata?: Array<{ key: string; value: unknown }>;
}

/** archives_parse result (M.archives_parse). */
export interface ArchivesParseResult {
  builds: ArchiveBuild[];
  /** PoB's status line; set when no builds were found. */
  statusMsg?: string;
}

/**
 * PoB's build code: zlib deflate of the build XML, base64 with '+' and '/'
 * swapped for '-' and '_' (ImportTab.lua "Generate":
 * common.base64.encode(Deflate(build:SaveDB("code"))):gsub("+","-"):gsub("/","_")).
 */
export function encodeBuildCode(xml: string): string {
  return zlib.deflateSync(Buffer.from(xml, 'utf8')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Reverse of encodeBuildCode (ImportTab.lua: Inflate(common.base64.decode(buf:gsub("-","+"):gsub("_","/")))). */
export function decodeBuildCode(code: string): string {
  const compressed = Buffer.from(code.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  let xml: string;
  try {
    xml = zlib.inflateSync(compressed).toString('utf8');
  } catch (zlibErr) {
    try {
      xml = zlib.inflateRawSync(compressed).toString('utf8');
    } catch {
      throw new Error(`not a valid build code (${zlibErr instanceof Error ? zlibErr.message : String(zlibErr)})`);
    }
  }
  if (!xml.trim()) throw new Error('not a valid build code (it decodes to nothing)');
  return xml;
}

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow' | 'manual';
}) => Promise<{ status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>;

/**
 * Cloudflare answers bots it challenges with 403 and "cf-mitigated: challenge".
 * The challenge needs a browser; it is reported, never worked around.
 */
function challengeNote(response: { headers?: { get(name: string): string | null } }): string {
  return response.headers?.get('cf-mitigated') === 'challenge'
    ? ' (the site answered with a Cloudflare bot challenge, which only a browser can pass)'
    : '';
}

export interface BuildSiteClientOptions {
  fetchImpl?: FetchLike;
  userAgent?: string;
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

  constructor(options: BuildSiteClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.userAgent = options.userAgent ?? 'pob-mcp-server/1.0';
  }

  /**
   * GET as launch:DownloadPage (Launch.lua): follows redirects; an HTTP status
   * other than 200 or an empty body is an error.
   */
  async download(url: string): Promise<string> {
    let response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers: { 'User-Agent': this.userAgent }, redirect: 'follow' });
    } catch (e) {
      throw new BuildSiteError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const body = await response.text();
    if (response.status !== 200) throw new BuildSiteError(`${url}: Response code: ${response.status}${challengeNote(response)}`, response.status);
    if (body.length === 0) throw new BuildSiteError(`${url}: No data returned`, response.status);
    return body;
  }

  /**
   * POST as buildSites.UploadBuild (BuildSiteTools.lua) and
   * PoBArchivesProvider:GetRecommendations: curl OPT_POSTFIELDS with the
   * body sent as given (form encoding, no escaping), success only on 200.
   */
  async post(url: string, body: string, followRedirects: boolean): Promise<string> {
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: followRedirects ? 'follow' : 'manual',
      });
    } catch (e) {
      throw new BuildSiteError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await response.text();
    if (response.status !== 200) {
      const challenge = challengeNote(response);
      if (challenge) throw new BuildSiteError(`${url}: HTTP ${response.status}${challenge}`, response.status);
      const detail = text.trim().slice(0, 300);
      throw new BuildSiteError(`${url}: HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
    }
    return text;
  }

  /**
   * buildSites.UploadBuild: POST postFields .. code to postUrl (following
   * redirects); on 200 ImportTab's Share button shows codeOut .. response.
   * The response is trimmed of surrounding whitespace.
   */
  async uploadBuild(site: BuildSite, code: string): Promise<string> {
    if (!site.canShare || site.postUrl === undefined || site.postFields === undefined || site.codeOut === undefined) {
      throw new BuildSiteError(`${site.label} does not accept uploads in Path of Building`);
    }
    const response = await this.post(site.postUrl, site.postFields + code, true);
    const id = response.trim();
    if (!id) throw new BuildSiteError(`${site.label} returned an empty response`);
    return site.codeOut + id;
  }
}

let shared: BuildSiteClient | undefined;

export function sharedBuildSiteClient(): BuildSiteClient {
  shared ??= new BuildSiteClient();
  return shared;
}
