// Smoke test for the Compare tab actions against the real PoB engine.
// Usage: node tests/smoke/compare.mjs   (after a build; set POB_PATH only to force a checkout)
//
// The fixture build has an item id gap (no item 8), and ItemsTab:AddItem
// gives a new item the lowest free id. compare_copy must still find the item
// it copied, rather than report a failure after copying and equipping it.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PoBLuaApiClient } from '../../build/pobLuaBridge.js';
import { gearedBuildXml, smokePoBSrc } from './pobSource.mjs';

const client = new PoBLuaApiClient({
  cwd: smokePoBSrc(),
  // As the server starts the engine (luaClientManager): POB_CMD / POB_ARGS when set.
  cmd: process.env.POB_CMD,
  args: process.env.POB_ARGS ? process.env.POB_ARGS.split(/\s+/).filter(Boolean) : [resolve('lua/vanilla_stdio_bridge.lua')],
  env: { POB_API_STDIO: '0' },
  timeoutMs: 120_000,
});

const assert = (cond, message) => { if (!cond) throw new Error(message); };
const rejects = async (promise, pattern, what) => {
  try { await promise; } catch (e) {
    assert(pattern.test(e.message), `${what}: unexpected error "${e.message}"`);
    return;
  }
  throw new Error(`${what}: expected a refusal`);
};

try {
  await client.start();
  const xml = await readFile(gearedBuildXml, 'utf8');
  assert(/<Item id="7">/.test(xml) && !/<Item id="8">/.test(xml) && /<Item id="9">/.test(xml), 'fixture lost its item id gap');

  // The compared build: the same helmet with one value changed (same name),
  // and a ring in the Ring 3 slot, which the loaded build does not have.
  const helmetStart = xml.indexOf('<Item id="11">');
  const helmetEnd = xml.indexOf('</Item>', helmetStart);
  const helmet = xml.slice(helmetStart, helmetEnd);
  assert(helmet.includes('+44 to maximum Energy Shield'), 'fixture helmet changed');
  let compared = xml.slice(0, helmetStart) + helmet.replace('+44 to maximum Energy Shield', '+40 to maximum Energy Shield') + xml.slice(helmetEnd);
  compared = compared.replace(/(\t*)(<Slot name="Ring 2" itemId="6"\/>)/g, '$1$2\n$1<Slot name="Ring 3" itemId="5"/>');
  assert((compared.match(/name="Ring 3"/g) ?? []).length === 2, 'Ring 3 not added to the compared build');

  await client.loadBuildXml(xml, 'compare-smoke');
  const added = await client.compareImport(compared, 'variant');
  assert(added.count === 1 && added.entry.label === 'variant', 'comparison not loaded');

  // A same-named but different item counts as a difference; PoB's label stays.
  const report = await client.compareReport({ sections: ['items'] });
  const rows = report.items.slots;
  const helmetRow = rows.find((r) => r.slotName === 'Helmet');
  assert(helmetRow && helmetRow.status === 'match' && helmetRow.identical === false, `helmet row: ${JSON.stringify(helmetRow)}`);
  assert(rows.every((r) => r.identical === false), 'only_differences kept an identical slot');

  // A bad choice changes nothing.
  const before = (await client.compareList()).entries[0];
  await rejects(client.compareSelect({ tree_set: 1, item_set: 99 }), /item set 99 not found/, 'compare_select');
  const after = (await client.compareList()).entries[0];
  assert(JSON.stringify(after.treeSets) === JSON.stringify(before.treeSets), 'compare_select changed the tree set before refusing');
  await rejects(client.comparePowerReport({ metric: 'Life', sort_by: 'bogus' }), /sort_by must be/, 'compare_power_report');

  // Equip into Ring 3 is not offered without the slot.
  await rejects(client.compareCopy({ what: 'item', slot: 'Ring 3', use: true }), /no Ring 3 slot/, 'compare_copy Ring 3');

  // The copy lands in the id gap and is reported as copied and equipped.
  const equipped = await client.compareCopy({ what: 'item', slot: 'Helmet', use: true });
  assert(equipped.item?.id === 8 && equipped.equipped === true, `helmet copy: ${JSON.stringify(equipped)}`);
  const plain = await client.compareCopy({ what: 'item', slot: 'Ring 3' });
  assert(plain.item?.id === 20 && plain.equipped === false, `ring copy: ${JSON.stringify(plain)}`);
  const helmetNow = (await client.getItems()).find((i) => i.slot === 'Helmet');
  assert(helmetNow?.id === 8 && String(helmetNow.raw).includes('+40 to maximum Energy Shield'), `equipped helmet: ${JSON.stringify(helmetNow)}`);
  console.log(`compare smoke ok (copied item ids ${equipped.item.id} and ${plain.item.id})`);
} finally {
  await client.stop();
}
