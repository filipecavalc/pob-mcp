import { describe, it, expect, jest } from '@jest/globals';
import zlib from 'zlib';
import { BuildSiteClient, decodeBuildCode, encodeBuildCode, type BuildSite } from '../../src/services/buildSiteClient.js';
import { handleImportBuildLink, handleListArchiveBuilds, handleShareBuild, formatArchiveBuild } from '../../src/handlers/buildSourceHandlers.js';

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding><Build level="90" className="Marauder"/></PathOfBuilding>';

const POBBIN: BuildSite = {
  label: 'pobb.in', id: 'POBBin', matchURL: '^https://pobb%.in/.+', regexURL: 'pobb%.in/(.+)%s*$', downloadURL: 'pobb.in/pob/%1',
  codeOut: 'https://pobb.in/', postUrl: 'https://pobb.in/pob/', postFields: '', linkURL: 'pobb.in/%1', canShare: true,
};
const NINJA: BuildSite = {
  label: 'PoeNinja', id: 'PoeNinja', codeOut: '', postUrl: 'https://poe.ninja/poe1/pob/api/upload', postFields: 'code=', canShare: true,
};
const PASTEBIN: BuildSite = { label: 'Pastebin.com', id: 'pastebin', downloadURL: 'pastebin.com/raw/%1', canShare: false };

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: string } };

function fakeFetch(responses: Array<{ status: number; body: string }>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: Call['init']) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return { status: next.status, text: async () => next.body };
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
    archivesRequest: jest.fn(async () => ({})),
    archivesParse: jest.fn(async () => ({ builds: [] })),
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

  it('rejects text that is not a code', () => {
    expect(() => decodeBuildCode('hello world')).toThrow(/not a valid build code/);
  });
});

describe('BuildSiteClient', () => {
  it('downloads with a GET that follows redirects', async () => {
    const f = fakeFetch([{ status: 200, body: 'CODE\n' }]);
    const client = new BuildSiteClient({ fetchImpl: f.impl });
    await expect(client.download('https://pobb.in/pob/abc')).resolves.toBe('CODE\n');
    expect(f.calls[0].init?.method).toBe('GET');
    expect(f.calls[0].init?.redirect).toBe('follow');
    expect(f.calls[0].init?.headers?.['User-Agent']).toBe('pob-mcp-server/1.0');
  });

  it('treats a non-200 status or an empty body as a failure, like launch:DownloadPage', async () => {
    const client = new BuildSiteClient({ fetchImpl: fakeFetch([{ status: 404, body: 'nope' }, { status: 200, body: '' }]).impl });
    await expect(client.download('https://x/1')).rejects.toThrow('Response code: 404');
    await expect(client.download('https://x/2')).rejects.toThrow('No data returned');
  });

  it('names a Cloudflare bot challenge instead of passing it', async () => {
    const challenged = async () => ({
      status: 403,
      headers: { get: (name: string) => (name === 'cf-mitigated' ? 'challenge' : null) },
      text: async () => '<html>Just a moment...</html>',
    });
    const client = new BuildSiteClient({ fetchImpl: challenged });
    await expect(client.download('https://pobarchives.com/api/builds?q=trending')).rejects.toThrow('Response code: 403 (the site answered with a Cloudflare bot challenge');
    await expect(client.post('https://pobarchives.com/api/recommendations', 'importCode=x', false)).rejects.toThrow('HTTP 403 (the site answered with a Cloudflare bot challenge');
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

describe('list_archive_builds', () => {
  const archiveBuild = {
    buildName: 'RF Chieftain', author: 'someone', mainSkill: 'Righteous Fire', ascendancy: 'Chieftain', class: 'Marauder',
    previewLink: 'https://pobarchives.com/build/u1', buildLink: 'https://pobb.in/x1', ehp: 81234.4, life: 6000, es: 0, dps: 1234567.8, version: '3_26',
  };

  it('downloads Trending from the URL PoB gives and lists what PoB parsed', async () => {
    const lua = makeLua({
      archivesRequest: jest.fn(async () => ({ mode: 'builds', list: 'Trending', lists: ['Trending', 'Latest'], url: 'https://pobarchives.com/api/builds?q=trending', method: 'GET', pageUrl: 'https://pobarchives.com/builds/7U8QXU8m?sort=popularity' })),
      archivesParse: jest.fn(async () => ({ builds: [archiveBuild, { ...archiveBuild, buildName: 'Second' }] })),
    });
    const download = jest.fn(async () => '{"builds":[]}');
    const res = await handleListArchiveBuilds(makeContext(lua), { limit: 1 }, { siteClient: { download } as never });
    expect(lua.archivesRequest).toHaveBeenCalledWith('builds', 'trending');
    expect(download).toHaveBeenCalledWith('https://pobarchives.com/api/builds?q=trending');
    expect(lua.archivesParse).toHaveBeenCalledWith('builds', '{"builds":[]}');
    const out = text(res);
    expect(out).toContain('[1] RF Chieftain by someone');
    expect(out).toContain('Chieftain | Righteous Fire | tree 3_26');
    expect(out).toContain('DPS 1,234,568 | Life 6,000 | ES 0 | EHP 81,234');
    expect(out).toContain('Link: https://pobb.in/x1');
    expect(out).toContain('1 more');
    expect(out).not.toContain('Second');
  });

  it("posts the loaded build's code for Similar Builds", async () => {
    const lua = makeLua({
      archivesRequest: jest.fn(async () => ({ mode: 'similar', list: 'Similar Builds', lists: ['Similar Builds'], url: 'https://pobarchives.com/api/recommendations', method: 'POST', postField: 'importCode=' })),
      archivesParse: jest.fn(async () => ({ builds: [{ ...archiveBuild, metadata: [{ key: 'Match Score', value: 0.87 }] }] })),
    });
    const post = jest.fn(async () => '{}');
    const res = await handleListArchiveBuilds(makeContext(lua), { list: 'similar' }, { siteClient: { post } as never });
    expect(lua.archivesRequest).toHaveBeenCalledWith('similar', undefined);
    expect(post).toHaveBeenCalledWith('https://pobarchives.com/api/recommendations', 'importCode=' + encodeBuildCode(XML), false);
    expect(text(res)).toContain('Similar Builds for the loaded build "RF test"');
    expect(text(res)).toContain('Match Score 0.87');
  });

  it("shows PoB's status message when nothing was found, and rejects unknown lists", async () => {
    const lua = makeLua({
      archivesRequest: jest.fn(async () => ({ mode: 'builds', list: 'Latest', lists: [], url: 'u', method: 'GET' })),
      archivesParse: jest.fn(async () => ({ builds: [], statusMsg: 'No builds found.' })),
    });
    const res = await handleListArchiveBuilds(makeContext(lua), { list: 'Latest' }, { siteClient: { download: async () => '{}' } as never });
    expect(text(res)).toContain('No builds found.');
    await expect(handleListArchiveBuilds(makeContext(lua), { list: 'popular' })).rejects.toThrow('list must be trending, latest or similar');
  });

  it('formats a build with missing fields', () => {
    expect(formatArchiveBuild({}, 3)).toEqual(['[3] (untitled)', '    DPS 0 | Life 0 | ES 0 | EHP 0']);
  });
});

describe('share_build', () => {
  it('uploads nothing without confirm', async () => {
    const lua = makeLua();
    const uploadBuild = jest.fn();
    const res = await handleShareBuild(makeContext(lua), { site: 'pobb.in' }, { siteClient: { uploadBuild } as never });
    expect(uploadBuild).not.toHaveBeenCalled();
    expect(text(res)).toContain('Not uploaded');
    expect(text(res)).toContain('to pobb.in: a POST of its build code');
    expect(text(res)).toContain('https://pobb.in/pob/');
  });

  it("uploads the loaded build's code with confirm and returns the link", async () => {
    const lua = makeLua();
    const uploadBuild = jest.fn(async () => 'https://pobb.in/Ab12');
    const res = await handleShareBuild(makeContext(lua), { site: 'pobbin', confirm: true }, { siteClient: { uploadBuild } as never });
    expect(uploadBuild).toHaveBeenCalledWith(POBBIN, encodeBuildCode(XML));
    expect(text(res)).toContain('Shared the loaded build "RF test" on pobb.in: https://pobb.in/Ab12');
  });

  it('only offers the sites PoB shares to', async () => {
    const lua = makeLua();
    const uploadBuild = jest.fn();
    await expect(handleShareBuild(makeContext(lua), { site: 'pastebin', confirm: true }, { siteClient: { uploadBuild } as never }))
      .rejects.toThrow('"pastebin" is not a site Path of Building shares to. Choose one of: pobb.in (POBBin), PoeNinja (PoeNinja).');
    await expect(handleShareBuild(makeContext(lua), {})).rejects.toThrow('site is required');
    expect(uploadBuild).not.toHaveBeenCalled();
  });
});
