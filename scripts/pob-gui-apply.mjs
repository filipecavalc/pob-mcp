#!/usr/bin/env node
// Apply this repo's Path of Building desktop additions to a PoB source tree.
//
// PoB is not forked: the additions live in pob-gui/ as new files, the
// bridge's shared Lua is copied next to them, and one small hook goes into
// Modules/Main.lua (idempotently, between marker comments). Re-run it after
// checking out a new PoB release. Nothing is written unless every step can be.
//
// Usage: node scripts/pob-gui-apply.mjs <PathOfBuilding checkout> [--check]
//   --check  report what would change without writing
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 1. Plan the Main.lua hook first, so an unrecognised PoB version changes nothing.
const BEGIN = '\t-- pob-mcp: begin';
const END = '\t-- pob-mcp: end';
const HOOK = [
  BEGIN,
  '\tif not self.mcpServerTried then',
  '\t\tself.mcpServerTried = true',
  '\t\tlocal ok, mod = pcall(LoadModule, "Modules/McpServer")',
  '\t\tif ok and mod then self.mcpServer = mod.start(self) else ConPrintf("MCP server: %s", tostring(mod)) end',
  '\tend',
  '\tif self.mcpServer then self.mcpServer:Poll() end',
  END,
].join('\n');
const main = readFileSync(mainLua, 'utf8');
const eol = main.includes('\r\n') ? '\r\n' : '\n';
const anchor = /^function main:OnFrame\(\)\r?\n/m;
if (!anchor.test(main)) {
  console.error('could not find "function main:OnFrame()" in Modules/Main.lua; PoB changed, update this script. Nothing was written.');
  process.exit(1);
}
const existingHook = /\t-- pob-mcp: begin[\s\S]*?-- pob-mcp: end\r?\n/;
const patched = main.replace(existingHook, '').replace(anchor, (m) => m + HOOK.replace(/\n/g, eol) + eol);

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
if (patched === main) {
  console.log('unchanged  src/Modules/Main.lua (hook present)');
} else {
  console.log(`${checkOnly ? 'would patch' : 'patched'}  src/Modules/Main.lua (OnFrame hook)`);
  if (!checkOnly) writeFileSync(mainLua, patched);
}
