import { describe, it, expect, jest } from '@jest/globals';
import zlib from 'zlib';
import { BuildSiteClient, type BuildSite } from '../../src/services/buildSiteClient.js';
import { decodeBuildCode, encodeBuildCode } from '../../src/utils/buildCode.js';
import { handleImportBuildLink, handleShareBuild, codeHash, describeSharedData } from '../../src/handlers/buildSourceHandlers.js';

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding><Build level="90" className="Marauder"/></PathOfBuilding>';
const XML_WITH_IMPORT = [
  '<PathOfBuilding>',
  '<Build level="90" className="Marauder"/>',
  '<Import lastRealm="PC" lastLeague="Settlers" lastAccountHash="abc123" lastCharacterHash="def456" importLink="https://pobb.in/xyz"/>',
  '<Notes>Gear notes here</Notes>',
  '<Items><ItemSet id="1" title="Leveling"/><ItemSet id="2" title="Endgame"/></Items>',
  '</PathOfBuilding>',
].join('\n');

const POBBIN: BuildSite = {
  label: 'pobb.in', id: 'POBBin', matchURL: '^https://pobb%.in/.+', regexURL: 'pobb%.in/(.+)%s*$', downloadURL: 'pobb.in/pob/%1',
  codeOut: 'https://pobb.in/', postUrl: 'https://pobb.in/pob/', postFields: '', linkURL: 'pobb.in/%1', canShare: true,
};
const NINJA: BuildSite = {
  label: 'PoeNinja', id: 'PoeNinja', codeOut: '', postUrl: 'https://poe.ninja/poe1/pob/api/upload', postFields: 'code=', canShare: true,
};
const PASTEBIN: BuildSite = { label: 'Pastebin.com', id: 'pastebin', downloadURL: 'pastebin.com/raw/%1', canShare: false };

type Init = { method?: string; headers?: Record<string, string>; body?: string; redirect?: string; signal?: AbortSignal };
type Call = { url: string; init?: Init };

function fakeFetch(responses: Array<{ status: number; body: string; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: Init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return { status: next.status, headers: { get: (n: string) => next.headers?.[n.toLowerCase()] ?? null }, text: async () => next.body };
  };
  return { calls, impl };
}

function makeContext(lua: Record<string, unknown>) {
  return {
    pobDirectory: 'C:/builds',
    luaEnabled: true,
    getLuaClient: () => lua as never,
    ensureLuaClient: async () => {},
    stopLuaClient: async () => {},
    buildService: { invalidateBuild: jest.fn() },
  };
}

function makeLua(overrides: Record<string, unknown> = {}) {
  return {
    resolveBuildLink: jest.fn(async () => ({ kind: 'code' })),
    listBuildSites: jest.fn(async () => [POBBIN, NINJA, PASTEBIN]),
    loadImportedBuild: jest.fn(async () => ({ ok: true })),
    saveBuild: jest.fn(async (p: string) => ({ path: p, size: 123 })),
    exportBuildXml: jest.fn(async () => XML),
    getBuildInfo: jest.fn(async () => ({ name: 'RF test', level: 90 })),
    // Read by the post-load summary.
    listSpecs: jest.fn(async () => ({ specs: [] })),
    listItemSets: jest.fn(async () => ({ itemSets: [] })),
    ...overrides,
  };
}

const text = (res: { content: Array<{ text: string }> }) => res.content[0].text;

describe('build codes', () => {
  it('encodes as PoB does (zlib, URL-safe base64) and decodes back', () => {
    const code = encodeBuildCode(XML);
    expect(code).not.toMatch(/[+/]/);
    expect(zlib.inflateSync(Buffer.from(code.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toString()).toBe(XML);
    expect(decodeBuildCode(`  ${code}\n`)).toBe(XML);
  });

  it('accepts raw deflate and rejects text that is not a code', () => {
    const raw = zlib.deflateRawSync(Buffer.from(XML)).toString('base64');
    expect(decodeBuildCode(raw)).toBe(XML);
    expect(() => decodeBuildCode('hello world')).toThrow();
    expect(() => decodeBuildCode(encodeBuildCode('   '))).toThrow('decodes to nothing');
  });
});

describe('BuildSiteClient', () => {
  it('downloads with a GET that follows redirects, under a timeout', async () => {
    const f = fakeFetch([{ status: 200, body: 'CODE\n' }]);
    const client = new BuildSiteClient({ fetchImpl: f.impl });
    await expect(client.download('https://pobb.in/pob/abc')).resolves.toBe('CODE\n');
    expect(f.calls[0].init).toMatchObject({ method: 'GET', redirect: 'follow' });
    expect(f.calls[0].init?.headers?.['User-Agent']).toBe('pob-mcp-server/1.0');
    expect(f.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats a non-200 status or an empty body as a failure, like launch:DownloadPage', async () => {
    const client = new BuildSiteClient({ fetchImpl: fakeFetch([{ status: 404, body: 'nope' }, { status: 200, body: '' }]).impl });
    await expect(client.download('https://x/1')).rejects.toThrow('Response code: 404');
    await expect(client.download('https://x/2')).rejects.toThrow('No data returned');
  });

  it('gives up when the site does not answer in time', async () => {
    const hang = (_url: string, init?: Init) => new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    });
    const client = new BuildSiteClient({ fetchImpl: hang, timeoutMs: 20 });
    await expect(client.download('https://pobb.in/pob/slow')).rejects.toThrow('https://pobb.in/pob/slow: no complete answer within 0 s');
  });

  it('refuses responses over the size cap, by header or by body', async () => {
    const big = fakeFetch([
      { status: 200, body: 'x', headers: { 'content-length': '5000' } },
      { status: 200, body: 'y'.repeat(2000) },
    ]);
    const client = new BuildSiteClient({ fetchImpl: big.impl, maxResponseBytes: 1024 });
    await expect(client.download('https://a/1')).rejects.toThrow('response larger than 1 KB');
    await expect(client.download('https://a/2')).rejects.toThrow('response larger than 1 KB');
  });

  it('stops reading a streamed body once it passes the cap', async () => {
    const cancel = jest.fn(async () => undefined);
    let reads = 0;
    const streamed = async () => ({
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => { reads++; return { done: false, value: new Uint8Array(600) }; }, cancel }) },
      text: async () => '',
    });
    const client = new BuildSiteClient({ fetchImpl: streamed, maxResponseBytes: 1024 });
    await expect(client.download('https://a/stream')).rejects.toThrow('response larger than 1 KB');
    expect(reads).toBe(2);
    expect(cancel).toHaveBeenCalled();
  });

  it('names a Cloudflare bot challenge instead of passing it', async () => {
    const f = fakeFetch([
      { status: 403, body: '<html>Just a moment...</html>', headers: { 'cf-mitigated': 'challenge' } },
      { status: 403, body: '<html>Just a moment...</html>', headers: { 'cf-mitigated': 'challenge' } },
    ]);
    const client = new BuildSiteClient({ fetchImpl: f.impl });
    await expect(client.download('https://site/a')).rejects.toThrow('Response code: 403 (the site answered with a Cloudflare bot challenge');
    await expect(client.post('https://site/b', 'x')).rejects.toThrow(/HTTP 403 \(the site answered with a Cloudflare bot challenge[^:]*$/);
  });

  it('uploads postFields followed by the code and returns codeOut plus the response', async () => {
    const f = fakeFetch([{ status: 200, body: 'Ab12Cd\n' }, { status: 200, body: 'https://poe.ninja/poe1/pob/xyz' }]);
    const client = new BuildSiteClient({ fetchImpl: f.impl });
    await expect(client.uploadBuild(POBBIN, 'CODE-_=')).resolves.toBe('https://pobb.in/Ab12Cd');
    await expect(client.uploadBuild(NINJA, 'CODE')).resolves.toBe('https://poe.ninja/poe1/pob/xyz');
    expect(f.calls[0]).toMatchObject({ url: 'https://pobb.in/pob/', init: { method: 'POST', body: 'CODE-_=', redirect: 'follow' } });
    expect(f.calls[0].init?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(f.calls[1].init?.body).toBe('code=CODE');
  });

  it('refuses sites PoB does not share to, and reports upload errors', async () => {
    const f = fakeFetch([{ status: 500, body: 'server error' }]);
    const client = new BuildSiteClient({ fetchImpl: f.impl });
    await expect(client.uploadBuild(PASTEBIN, 'CODE')).rejects.toThrow('does not accept uploads');
    await expect(client.uploadBuild(POBBIN, 'CODE')).rejects.toThrow('HTTP 500: server error');
  });
});

describe('import_build_link', () => {
  it('downloads the code from the URL PoB resolves and loads it with the link', async () => {
    const lua = makeLua({
      resolveBuildLink: jest.fn(async () => ({ kind: 'link', link: 'https://pobb.in/abc', downloadUrl: 'https://pobb.in/pob/abc', site: POBBIN })),
    });
    const download = jest.fn(async () => encodeBuildCode(XML) + '\n');
    const res = await handleImportBuildLink(makeContext(lua), { link: ' https://pobb.in/abc ' }, { siteClient: { download } as never });
    expect(lua.resolveBuildLink).toHaveBeenCalledWith('https://pobb.in/abc');
    expect(download).toHaveBeenCalledWith('https://pobb.in/pob/abc');
    expect(lua.loadImportedBuild).toHaveBeenCalledWith(XML, 'Imported build', 'https://pobb.in/abc');
    expect(text(res)).toContain('imported from https://pobb.in/abc (pobb.in, downloaded from https://pobb.in/pob/abc)');
    expect(lua.saveBuild).not.toHaveBeenCalled();
  });

  it('loads a plain build code without any download', async () => {
    const lua = makeLua();
    const download = jest.fn();
    await handleImportBuildLink(makeContext(lua), { link: encodeBuildCode(XML), name: 'Mine' }, { siteClient: { download } as never });
    expect(download).not.toHaveBeenCalled();
    expect(lua.loadImportedBuild).toHaveBeenCalledWith(XML, 'Mine', undefined);
  });

  it('names the supported sites when a link matches none', async () => {
    const lua = makeLua();
    await expect(handleImportBuildLink(makeContext(lua), { link: 'https://example.com/build/1' }))
      .rejects.toThrow(/no site in Path of Building's list matches this link.*pobb\.in \(POBBin\)/);
    expect(lua.loadImportedBuild).not.toHaveBeenCalled();
  });

  it('reports a site answer that is not a build code', async () => {
    const lua = makeLua({
      resolveBuildLink: jest.fn(async () => ({ kind: 'link', link: 'https://pobb.in/abc', downloadUrl: 'https://pobb.in/pob/abc', site: POBBIN })),
    });
    const download = jest.fn(async () => '<html>Not found</html>');
    await expect(handleImportBuildLink(makeContext(lua), { link: 'https://pobb.in/abc' }, { siteClient: { download } as never }))
      .rejects.toThrow('pobb.in answered https://pobb.in/pob/abc with something that is not a build code');
    expect(lua.loadImportedBuild).not.toHaveBeenCalled();
  });

  it('refuses an existing save_as before touching the network or the engine', async () => {
    const lua = makeLua();
    const download = jest.fn();
    await expect(handleImportBuildLink(makeContext(lua), { link: 'https://pobb.in/abc', saveAs: 'Taken' }, {
      siteClient: { download } as never, fileExists: async () => true,
    })).rejects.toThrow('"Taken.xml" already exists; pass overwrite: true');
    expect(lua.resolveBuildLink).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('saves to save_as, replacing only with overwrite', async () => {
    const lua = makeLua();
    const ctx = makeContext(lua);
    const res = await handleImportBuildLink(ctx, { link: encodeBuildCode(XML), saveAs: 'New', overwrite: true }, { fileExists: async () => true });
    expect(lua.saveBuild).toHaveBeenCalledWith(expect.stringMatching(/New\.xml$/), true);
    expect(ctx.buildService.invalidateBuild).toHaveBeenCalledWith('New');
    expect(text(res)).toContain('Saved to "New.xml" (123 bytes).');
  });
});

describe('share_build', () => {
  it('previews without uploading: what the code carries and its hash', async () => {
    const lua = makeLua({ exportBuildXml: jest.fn(async () => XML_WITH_IMPORT) });
    const uploadBuild = jest.fn();
    const out = text(await handleShareBuild(makeContext(lua), { site: 'pobb.in' }, { siteClient: { uploadBuild } as never }));
    expect(uploadBuild).not.toHaveBeenCalled();
    expect(out).toContain('Not uploaded');
    expect(out).toContain('to pobb.in: a POST of its build code');
    expect(out).toContain('https://pobb.in/pob/');
    expect(out).toContain('- Import section: realm PC, league Settlers, account name hash, character name hash, import link https://pobb.in/xyz');
    expect(out).toContain('- Notes: 15 characters');
    expect(out).toContain('- Item set names: Leveling, Endgame');
    const hash = codeHash(encodeBuildCode(XML_WITH_IMPORT));
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(out).toContain(`confirm_code_hash: "${hash}"`);
  });

  it('uploads the previewed code when given its hash, and returns the link', async () => {
    const lua = makeLua();
    const uploadBuild = jest.fn(async () => 'https://pobb.in/Ab12');
    const hash = codeHash(encodeBuildCode(XML));
    const res = await handleShareBuild(makeContext(lua), { site: 'pobbin', confirmCodeHash: hash.toUpperCase() }, { siteClient: { uploadBuild } as never });
    expect(uploadBuild).toHaveBeenCalledWith(POBBIN, encodeBuildCode(XML));
    expect(text(res)).toContain('Shared the loaded build "RF test" on pobb.in: https://pobb.in/Ab12');
  });

  it('refuses when the loaded build changed since the preview', async () => {
    const lua = makeLua();
    const uploadBuild = jest.fn();
    const staleHash = codeHash(encodeBuildCode(XML_WITH_IMPORT));
    await expect(handleShareBuild(makeContext(lua), { site: 'pobb.in', confirmCodeHash: staleHash }, { siteClient: { uploadBuild } as never }))
      .rejects.toThrow(`does not match the loaded build's code (now ${codeHash(encodeBuildCode(XML))})`);
    expect(uploadBuild).not.toHaveBeenCalled();
  });

  it('only offers the sites PoB shares to', async () => {
    const lua = makeLua();
    const uploadBuild = jest.fn();
    await expect(handleShareBuild(makeContext(lua), { site: 'pastebin', confirmCodeHash: 'abc' }, { siteClient: { uploadBuild } as never }))
      .rejects.toThrow('"pastebin" is not a site Path of Building shares to. Choose one of: pobb.in (POBBin), PoeNinja (PoeNinja).');
    await expect(handleShareBuild(makeContext(lua), {})).rejects.toThrow('site is required');
    expect(uploadBuild).not.toHaveBeenCalled();
  });

  it('describes a build with no Import data, notes or item sets', () => {
    expect(describeSharedData(XML)).toEqual(['- Import section: nothing recorded', '- Notes: none', '- Item set names: none']);
  });
});
