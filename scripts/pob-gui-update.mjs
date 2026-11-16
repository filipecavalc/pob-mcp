#!/usr/bin/env node
// Move the Path of Building checkouts pob-mcp uses to one PoB release and
// re-apply the desktop additions, so the MCP's numbers match the PoB the
// player has installed.
//
// Two checkouts of the official PoB repository are involved:
//   headless  the engine the MCP server runs in the background (POB_PATH's checkout)
//   desktop   the copy run from source with the MCP tab (POB_GUI_PATH), a git worktree of headless
//
// Usage: node scripts/pob-gui-update.mjs [--to vX.Y.Z] [--check]
//   --to     release tag; default: the version of the installed PoB
//            (%APPDATA%\Path of Building Community\manifest.xml)
//   --check  report what would happen without changing anything
// Env: POB_HEADLESS_DIR (default ../PathOfBuilding), POB_GUI_PATH (default ../PathOfBuilding-gui),
//      POB_MCP_PORT (default 49280)
//
// Before running: close the PoB window with the MCP tab, and stop the MCP
// server (quit the client app that runs it, or call lua_stop), since both
// keep PoB's runtime files open. The script checks this and refuses otherwise.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOKED_FILES } from './lib/pob-gui-hooks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const toIndex = argv.indexOf('--to');
const headless = path.resolve(process.env.POB_HEADLESS_DIR || path.join(repoRoot, '..', 'PathOfBuilding'));
const desktop = path.resolve(process.env.POB_GUI_PATH || path.join(repoRoot, '..', 'PathOfBuilding-gui'));
const port = Number(process.env.POB_MCP_PORT) || 49280;

const fail = (message) => { console.error(`pob-gui-update: ${message}`); process.exit(1); };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (dir, ...args) => { try { return git(dir, ...args).trim(); } catch { return null; } };
const lf = (text) => text.replace(/\r\n/g, '\n');
// Porcelain lines are "XY path"; the leading space is part of the status.
const trackedChanges = (dir) => git(dir, 'status', '--porcelain', '--untracked-files=no')
  .split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));

function installedVersion() {
  const appData = process.env.APPDATA;
  const manifest = appData && path.join(appData, 'Path of Building Community', 'manifest.xml');
  if (!manifest || !existsSync(manifest)) return null;
  const match = readFileSync(manifest, 'utf8').match(/<Version\b[^>]*\bnumber="([^"]+)"/);
  return match ? match[1] : null;
}

/** The desktop server answers on its port only while the PoB window runs. */
function portAnswers() {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const done = (up) => { sock.destroy(); resolve(up); };
    sock.setTimeout(1000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Files Windows will not let git replace: a running PoB holds its exe and
 * runtime DLLs, and the MCP's headless engine holds the DLLs it loaded. Opening
 * for writing (without writing) fails on exactly those.
 */
function filesInUse(dir) {
  const runtime = path.join(dir, 'runtime');
  if (!existsSync(runtime)) return [];
  const candidates = readdirSync(runtime).filter((n) => /\.(dll|exe)$/i.test(n)).map((n) => path.join(runtime, n));
  return candidates.filter((file) => {
    try { closeSync(openSync(file, 'r+')); return false; } catch (e) { return ['EBUSY', 'EPERM', 'EACCES'].includes(e.code); }
  });
}

/**
 * The desktop checkout may differ from its release only by our hooks: each
 * hooked file must equal the release text with the hook applied (or without
 * it). Anything else is someone's edit and must not be thrown away.
 */
function unrecognisedDesktopEdits() {
  const out = [];
  for (const rel of trackedChanges(desktop)) {
    const patch = HOOKED_FILES[rel];
    if (!patch) { out.push(rel); continue; }
    const current = lf(readFileSync(path.join(desktop, ...rel.split('/')), 'utf8'));
    const pristine = lf(git(desktop, 'show', `HEAD:${rel}`));
    const hooked = patch(pristine);
    if (current !== pristine && (hooked.error || current !== lf(hooked.text))) out.push(`${rel} (edits besides the MCP hook)`);
  }
  return out;
}

// --- what and where -----------------------------------------------------------
for (const [label, dir] of [['headless', headless], ['desktop', desktop]]) {
  if (!existsSync(path.join(dir, 'src', 'Modules', 'Main.lua'))) fail(`${label} checkout not found at ${dir}`);
}
let tag = toIndex >= 0 ? argv[toIndex + 1] : null;
if (!tag) {
  const version = installedVersion();
  if (!version) fail('could not read the installed PoB version; pass --to vX.Y.Z');
  tag = `v${version}`;
}
if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`not a release tag: ${tag}`);

const current = {
  headless: tryGit(headless, 'describe', '--tags', '--exact-match') ?? tryGit(headless, 'rev-parse', '--short', 'HEAD'),
  desktop: tryGit(desktop, 'describe', '--tags', '--exact-match') ?? tryGit(desktop, 'rev-parse', '--short', 'HEAD'),
};
console.log(`target: ${tag}  (headless now ${current.headless}, desktop now ${current.desktop})`);

const headlessChanges = trackedChanges(headless);
if (headlessChanges.length) fail(`the headless checkout has local changes; refusing to touch it:\n  ${headlessChanges.join('\n  ')}`);
const desktopEdits = unrecognisedDesktopEdits();
if (desktopEdits.length) fail(`the desktop checkout has changes this script does not recognise; refusing to touch it:\n  ${desktopEdits.join('\n  ')}`);

if (await portAnswers()) fail(`Path of Building with the MCP tab is running (port ${port} answers). Close it first.`);
const busy = [...filesInUse(desktop), ...filesInUse(headless)];
if (busy.length) {
  fail(`these files are in use, so git could not replace them:\n  ${busy.join('\n  ')}\n` +
    'Close Path of Building (MCP) and stop the MCP server (quit the client app that runs it, or call lua_stop), then run this again.');
}

if (!tryGit(headless, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`)) {
  const remote = tryGit(headless, 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
  if (!remote) fail(`${tag} was not found in the official repository`);
}

if (checkOnly) {
  console.log([
    'would:',
    `  fetch ${tag} from the official repository (shallow) if not present`,
    `  check out ${tag} in ${headless}`,
    `  restore ${Object.keys(HOOKED_FILES).join(', ')} in ${desktop}, then check out ${tag} there`,
    '  re-apply the desktop additions (scripts/pob-gui-apply.mjs)',
  ].join('\n'));
  process.exit(0);
}

// --- update -------------------------------------------------------------------
const recovery = (dir) => `To recover: close every program using ${dir}, then run \`git -C "${dir}" checkout -f ${tag}\` and this script again.`;
/** git can move HEAD yet leave locked files behind; confirm the checkout really is clean. */
function checkoutVerified(dir, label) {
  try {
    git(dir, 'checkout', '--detach', tag);
  } catch (e) {
    fail(`could not check out ${tag} in the ${label} checkout:\n${e.stderr || e.message}\n${recovery(dir)}`);
  }
  const left = trackedChanges(dir);
  if (tryGit(dir, 'describe', '--tags', '--exact-match') !== tag || left.length) {
    fail(`the ${label} checkout did not fully switch to ${tag}${left.length ? ` (files left over: ${left.join(', ')})` : ''}. ${recovery(dir)}`);
  }
  console.log(`${label}: ${tag}`);
}

if (!tryGit(headless, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`)) {
  console.log(`fetching ${tag}...`);
  try {
    git(headless, 'fetch', '--depth', '1', 'origin', `refs/tags/${tag}:refs/tags/${tag}`);
  } catch (e) {
    fail(`could not fetch ${tag}: ${e.stderr || e.message}`);
  }
}

checkoutVerified(headless, 'headless');
git(desktop, 'checkout', '--', ...Object.keys(HOOKED_FILES));
checkoutVerified(desktop, 'desktop');

console.log('re-applying the desktop additions...');
try {
  const out = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'pob-gui-apply.mjs'), desktop], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(out.split('\n').filter((l) => l && !l.startsWith('unchanged')).map((l) => `  ${l}\n`).join(''));
} catch (e) {
  fail(`${tag} is checked out, but the MCP additions could not be applied, so the desktop copy runs as plain PoB until scripts/lib/pob-gui-hooks.mjs is updated for this release:\n${e.stdout || ''}${e.stderr || e.message}`);
}
console.log(`done. Both checkouts are on ${tag}. Start Path of Building (MCP) again, and restart the MCP server (restart its client app, or call lua_start) so the headless engine loads ${tag}.`);
