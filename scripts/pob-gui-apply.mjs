#!/usr/bin/env node
// Apply this repo's Path of Building desktop additions to a PoB source tree.
//
// PoB is not forked: the additions live in pob-gui/ as new files, the
// bridge's shared Lua is copied next to them, and two small hooks go in
// idempotently: main:OnFrame in Modules/Main.lua (starts and polls the
// server) and the tab dispatch in Modules/Build.lua (draws the MCP tab).
// Re-run it after checking out a new PoB release. Nothing is written unless
// every step can be.
//
// Usage: node scripts/pob-gui-apply.mjs <PathOfBuilding checkout> [--check]
//   --check  report what would change without writing
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOKED_FILES } from './lib/pob-gui-hooks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!target) {
  console.error('usage: node scripts/pob-gui-apply.mjs <PathOfBuilding checkout> [--check]');
  process.exit(2);
}
const targetSrc = path.resolve(target, 'src');
const mainLua = path.join(targetSrc, 'Modules', 'Main.lua');
if (!existsSync(mainLua)) {
  console.error(`not a PoB checkout: ${mainLua} missing`);
  process.exit(2);
}

// 1. Plan both hooks first, so an unrecognised PoB version changes nothing.
const hooks = Object.entries(HOOKED_FILES).map(([rel, patch]) => {
  const file = path.join(target, ...rel.split('/'));
  const original = readFileSync(file, 'utf8');
  const result = patch(original);
  if (result.error) {
    console.error(`${result.error}; PoB changed, update scripts/lib/pob-gui-hooks.mjs. Nothing was written.`);
    process.exit(1);
  }
  return { rel, file, original, patched: result.text };
});

// 2. Collect files: everything under pob-gui/src, and the shared bridge Lua into src/Modules/PobMcp.
const overlay = path.join(repoRoot, 'pob-gui', 'src');
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const copies = walk(overlay).map((file) => ({ from: file, rel: path.relative(overlay, file) }));
for (const name of ['pob_compat.lua', 'pob_ops.lua', 'bridge_handlers.lua']) {
  copies.push({ from: path.join(repoRoot, 'lua', name), rel: path.join('Modules', 'PobMcp', name) });
}

// 3. Write.
for (const { from, rel } of copies) {
  const dest = path.join(targetSrc, rel);
  const content = readFileSync(from);
  const same = existsSync(dest) && Buffer.compare(readFileSync(dest), content) === 0;
  console.log(`${same ? 'unchanged' : checkOnly ? 'would copy' : 'copied'}  src/${rel.replace(/\\/g, '/')}`);
  if (!same && !checkOnly) {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}
for (const { rel, file, original, patched } of hooks) {
  if (patched === original) {
    console.log(`unchanged  ${rel} (hook present)`);
  } else {
    console.log(`${checkOnly ? 'would patch' : 'patched'}  ${rel} (hook)`);
    if (!checkOnly) writeFileSync(file, patched);
  }
}
