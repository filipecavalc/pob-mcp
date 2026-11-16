// Smoke test for the Tree tab actions (node power, timeless jewel finder,
// tattoos) against the real PoB engine. No network.
// Usage: node tests/smoke/tree-power.mjs   (after a build; set POB_PATH only to force a checkout)
// POB_CMD / POB_ARGS work as for the server (for example a Python host for
// PoB's lua51.dll: POB_ARGS="-I scripts/luajit-win.py lua/vanilla_stdio_bridge.lua").
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PoBLuaApiClient } from '../../build/pobLuaBridge.js';
import { gearedBuildXml, smokePoBSrc } from './pobSource.mjs';

const cwd = smokePoBSrc();
const client = new PoBLuaApiClient({
  cwd,
  cmd: process.env.POB_CMD,
  args: process.env.POB_ARGS ? process.env.POB_ARGS.split(/\s+/).filter(Boolean) : [resolve('lua/vanilla_stdio_bridge.lua')],
  env: { POB_API_STDIO: '0' },
  timeoutMs: 120_000,
});

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
};
const timelessDir = join(cwd, 'Data', 'TimelessJewelData');
const binFiles = async () => (await readdir(timelessDir)).filter((f) => f.endsWith('.bin')).sort();

try {
  await client.start();
  const capabilities = await client.getCapabilities();
  for (const action of ['node_power', 'find_timeless_jewel', 'list_tattoos', 'apply_tattoo', 'remove_tattoos']) {
    check(`adapter offers ${action}`, capabilities.actions?.includes(action));
  }
  await client.loadBuildXml(await readFile(gearedBuildXml, 'utf8'), 'tree-power-smoke');

  // Node power at a small depth: PoB's report, every row within the depth.
  const started = Date.now();
  const power = await client.nodePower({ stat: 'Life', maxDepth: 3, limit: 50 });
  const rowsWithinDepth = power.nodes.every((n) => typeof n.points === 'number' && n.points <= 3);
  check('node_power reports PoB rows for Life within depth 3', power.stat === 'Life' && power.nodes.length > 0 && rowsWithinDepth,
    `${power.listed} rows, top ${power.nodes[0]?.name} ${power.nodes[0]?.power}, ${power.seconds.toFixed(1)} s in Lua, ${Date.now() - started} ms round trip`);
  check('node_power defaults to CombinedDPS', (await client.nodePower({ maxDepth: 1, limit: 1 })).stat === 'CombinedDPS');

  // Tattoos survive set_tree and update_tree_delta (ImportFromNodeList used to drop them).
  const attrs = [];
  for (const keyword of ['Strength', 'Dexterity', 'Intelligence']) {
    const found = await client.searchNodes({ keyword, nodeType: 'normal', maxResults: 200, includeAllocated: true });
    attrs.push(...found.nodes.filter((n) => n.name === keyword));
  }
  const target = attrs.find((n) => n.allocated);
  const twin = target && attrs.find((n) => n.name === target.name && n.id !== target.id);
  check('fixture has an allocated attribute node and a second one of that name', Boolean(target && twin));
  if (target && twin) {
    const normal = await client.listTattoos({ nodeId: target.id });
    const first = normal.options.find((o) => !o.legacy && o.name);
    const lifeBefore = (await client.getStats(['Life'])).Life;
    await client.applyTattoo({ nodeId: target.id, tattoo: first.name });
    const lifeTattooed = (await client.getStats(['Life'])).Life;
    const tree = await client.getTree();
    await client.setTree(tree);
    check('set_tree keeps the tattoo', (await client.listTattoos({ nodeId: target.id })).current?.name === first.name);
    await client.updateTreeDelta({ addNodes: [] });
    check('update_tree_delta keeps the tattoo', (await client.listTattoos({ nodeId: target.id })).current?.name === first.name);
    check('the tattoo still counts after both', (await client.getStats(['Life'])).Life === lifeTattooed,
      `Life ${lifeBefore} -> ${lifeTattooed}`);

    // A legacy tattoo stores an index into the longer legacy list; the editor
    // without legacy tattoos must still open, for this node and its namesakes.
    const withLegacy = await client.listTattoos({ nodeId: target.id, includeLegacy: true });
    const legacy = [...withLegacy.options].reverse().find((o) => o.legacy && o.name);
    check('PoB lists legacy tattoos for the node', Boolean(legacy) && withLegacy.options.length > normal.options.length,
      `${withLegacy.options.length} with legacy, ${normal.options.length} without`);
    if (legacy) {
      await client.applyTattoo({ nodeId: target.id, tattoo: legacy.name, includeLegacy: true });
      const reopened = await client.listTattoos({ nodeId: target.id }).then((r) => r, (e) => e);
      check('editor opens without legacy after a legacy tattoo', !(reopened instanceof Error) && reopened.current?.name === legacy.name,
        reopened instanceof Error ? reopened.message : '');
      const namesake = await client.listTattoos({ nodeId: twin.id }).then((r) => r, (e) => e);
      check('editor opens on another node of the same name', !(namesake instanceof Error), namesake instanceof Error ? namesake.message : '');
    }
    const removed = await client.removeTattoos({ nodeId: target.id });
    check('Reset Node removes the tattoo', removed.remaining === 0 && removed.after.Life === lifeBefore,
      `Life back to ${removed.after.Life}`);
  }

  // Timeless jewel finder: the LUT loads, no .bin cache lands in the PoB
  // checkout, and an empty search does not report earlier results.
  const binsBefore = await binFiles();
  const options = await client.findTimelessJewel({ optionsOnly: true, jewelType: 'Lethal Pride' });
  const socket = options.sockets.find((s) => s.allocated && s.id !== -1) ?? options.sockets.find((s) => s.id !== -1);
  const mod = options.mods.find((m) => !m.totalMod);
  const found = await client.findTimelessJewel({ jewelType: 'Lethal Pride', socketId: socket.id, desired: [{ node: mod.id }], maxResults: 3 });
  check('Lethal Pride search finds seeds', found.resultCount > 0 && found.results.length > 0, `${found.resultCount} seeds for ${mod.name} at ${socket.label}`);
  const binsAfter = await binFiles();
  check('no .bin cache written into the PoB checkout', binsAfter.join() === binsBefore.join(), binsAfter.join(', ') || 'none');
  const none = await client.findTimelessJewel({ jewelType: 'Lethal Pride', socketId: socket.id, desired: [{ node: mod.id, required: true }], totalMinimumWeight: 1e9, maxResults: 3 });
  check('a search with no match reports no results', none.resultCount === 0 && none.results.length === 0, `${none.resultCount} results`);

  // Reclaimed Malevolence needs a path from an allocated socket to the class
  // start; on an unallocated socket PoB's Search finds nothing to search and
  // leaves its result tables as they were.
  const rmOptions = await client.findTimelessJewel({ optionsOnly: true, jewelType: 'Reclaimed Malevolence' });
  const loose = rmOptions.sockets.find((s) => !s.allocated && s.id !== -1);
  const outcome = rmOptions.abyssAscendancyOutcomes.find((o) => o.id);
  const rm = await client.findTimelessJewel({ jewelType: 'Reclaimed Malevolence', socketId: loose.id, abyssAscendancy: outcome.label, maxResults: 3 });
  check('Reclaimed Malevolence on an unallocated socket reports no results', rm.resultCount === 0 && rm.results.length === 0,
    `${rm.resultCount} results at ${loose.label}`);

  check('bridge still alive', client.isAlive());
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
} finally {
  await client.stop();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\ntree-power smoke passed');
}
