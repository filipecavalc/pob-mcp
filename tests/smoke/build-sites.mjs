// Smoke test for build links: resolve_build_link and load_imported_build run
// PoB's own Modules/BuildSiteTools.lua and ImportBuild, headless, with no network.
// Usage: node tests/smoke/build-sites.mjs   (set POB_PATH only to force a checkout;
// POB_CMD / POB_ARGS as for the server when there is no luajit on PATH)
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PoBLuaApiClient } from '../../build/pobLuaBridge.js';
import { resolvePoBLayout } from '../../build/utils/pobLayout.js';
import { encodeBuildCode } from '../../build/utils/buildCode.js';
import { smokePoBSrc } from './pobSource.mjs';

const cwd = smokePoBSrc();
const bridge = resolve('lua/vanilla_stdio_bridge.lua');
const cmd = process.env.POB_CMD || 'luajit';
const args = process.env.POB_ARGS ? process.env.POB_ARGS.split(/\s+/).filter(Boolean) : [bridge];

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

// Each link with the site and download URL PoB's table gives it.
const LINKS = [
  ['https://maxroll.gg/poe/pob/abcd1234', 'Maxroll', 'https://maxroll.gg/poe/api/pob/abcd1234'],
  ['https://pob.codes/b/Xy_z', 'PoBCodes', 'https://api.pob.codes/Xy_z/raw'],
  ['  https://pobb.in/AbC123xyz  ', 'POBBin', 'https://pobb.in/pob/AbC123xyz'],
  ['https://poe.ninja/poe1/pob/1a2b', 'PoeNinja', 'https://poe.ninja/poe1/pob/raw/1a2b'],
  ['https://poe.ninja/pob/1a2b', 'PoeNinja', 'https://poe.ninja/poe1/pob/raw/1a2b'],
  ['https://pastebin.com/k3y', 'pastebin', 'https://pastebin.com/raw/k3y'],
  ['https://pastebinp.com/k3y', 'pastebinProxy', 'https://pastebinp.com/raw/k3y'],
  ['https://rentry.co/k3y', 'rentry', 'https://rentry.co/paste/k3y/raw'],
  ['https://poedb.tw/pob/k3y', 'PoEDB', 'https://poedb.tw/pob/k3y/raw'],
  ['https://www.youtube.com/redirect?event=x&q=https%3A%2F%2Fpobb.in%2FXyZ&v=1', 'POBBin', 'https://pobb.in/pob/XyZ'],
];
// pob:// links: Main:Init's protocol handler; the stored link is the site's linkURL.
const URIS = [
  ['pob://pobbin/QwErTy', 'POBBin', 'https://pobb.in/QwErTy', 'https://pobb.in/pob/QwErTy'],
  ['pob://poeninja/1a2b', 'PoeNinja', 'https://poe.ninja/poe1/pob/1a2b', 'https://poe.ninja/poe1/pob/raw/1a2b'],
  // PastebinP's linkURL is pastebin.com; the site is still PastebinP.
  ['pob://pastebinproxy/k3y', 'pastebinProxy', 'https://pastebin.com/k3y', 'https://pastebinp.com/raw/k3y'],
];

const client = new PoBLuaApiClient({ cwd, cmd, args, env: { POB_API_STDIO: '0' }, timeoutMs: 60_000 });
try {
  await client.start();
  const { actions = [] } = await client.getCapabilities();
  for (const action of ['list_build_sites', 'resolve_build_link', 'load_imported_build']) {
    check(`capability ${action}`, actions.includes(action));
  }

  const sites = await client.listBuildSites();
  check('PoB lists its build sites', sites.length >= 8, sites.map((s) => s.id).join(','));
  check('share sites are those with postUrl, postFields and codeOut',
    sites.filter((s) => s.canShare).map((s) => s.id).join(',') === 'Maxroll,PoBCodes,POBBin,PoeNinja,PoEDB');

  for (const [link, siteId, downloadUrl] of LINKS) {
    const r = await client.resolveBuildLink(link);
    check(`${link.trim().slice(0, 50)} -> ${siteId}`, r.kind === 'link' && r.site?.id === siteId && r.downloadUrl === downloadUrl, JSON.stringify({ site: r.site?.id, url: r.downloadUrl }));
  }
  for (const [uri, siteId, link, downloadUrl] of URIS) {
    const r = await client.resolveBuildLink(uri);
    check(`${uri} -> ${siteId}`, r.kind === 'link' && r.site?.id === siteId && r.link === link && r.downloadUrl === downloadUrl, JSON.stringify({ site: r.site?.id, link: r.link, url: r.downloadUrl }));
  }
  const unknown = await client.resolveBuildLink('pob://nosuch/abc').then(() => 'resolved', (e) => e.message);
  check('unknown pob:// site is refused', unknown.includes('Download information not found'), unknown);
  const xml = await readFile(resolve('example-build.xml'), 'utf8');
  check('a build code is not a link', (await client.resolveBuildLink(encodeBuildCode(xml))).kind === 'code');
  check('an unknown https link is not a site link', (await client.resolveBuildLink('https://example.com/x')).kind === 'code');

  await client.loadImportedBuild(xml, 'build-sites-smoke', 'https://pobb.in/QwErTy');
  const saved = await client.exportBuildXml();
  check('load_imported_build keeps the import link', /<Import\b[^>]*importLink="https:\/\/pobb\.in\/QwErTy"/.test(saved));
} finally {
  await client.stop();
}

// State restored after PoB's code raises: a standalone Lua run, as no bridge input can make it raise.
const layout = resolvePoBLayout(cwd);
const toSearchPath = (entries) => entries.join(';') + ';;';
const script = resolve('tests/smoke/build-sites-state.lua');
const stateArgs = process.env.POB_ARGS ? args.map((a) => (a.endsWith('vanilla_stdio_bridge.lua') ? script : a)) : [script];
const out = execFileSync(cmd, stateArgs, {
  cwd: layout.src,
  env: { ...process.env, LUA_PATH: toSearchPath(layout.luaPath), LUA_CPATH: toSearchPath(layout.luaCPath) },
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: 300_000,
});
const line = out.split(/\r?\n/).find((l) => l.startsWith('SMOKE-RESULT '));
if (!line) {
  check('state script reported', false, out.slice(-500));
} else {
  for (const r of JSON.parse(line.slice('SMOKE-RESULT '.length))) check(r.name, r.ok, r.ok ? '' : r.detail);
}

if (failures.length) {
  console.error(`build sites smoke: ${failures.length} failed`);
  process.exit(1);
}
console.log('build sites smoke passed');
