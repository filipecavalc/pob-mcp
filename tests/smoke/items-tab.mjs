// Headless smoke test for the Items tab actions (crafting popups, item sets),
// against an unmodified PoB. No network. It checks what the unit tests cannot:
// that PoB's own state comes back as it was after each call.
// Usage: npm run build && node tests/smoke/items-tab.mjs   (set POB_PATH only to force a checkout)
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PoBLuaApiClient } from '../../build/pobLuaBridge.js';
import { gearedBuildXml, smokePoBSrc } from './pobSource.mjs';

// POB_CMD / POB_ARGS work as for the server, e.g. on Windows without luajit:
// POB_CMD=python POB_ARGS="-I scripts/luajit-win.py lua/vanilla_stdio_bridge.lua".
// The older POB_CMD_ARGS (the interpreter's arguments only, before the bridge) still works.
const absolute = (arg) => (/\.(py|lua)$/.test(arg) ? resolve(arg) : arg);
const args = process.env.POB_ARGS
  ? process.env.POB_ARGS.split(/\s+/).filter(Boolean).map(absolute)
  : [...(process.env.POB_CMD ? (process.env.POB_CMD_ARGS || '').split(/\s+/).filter(Boolean).map(absolute) : []), resolve('lua/vanilla_stdio_bridge.lua')];
const client = new PoBLuaApiClient({
  cwd: smokePoBSrc(),
  cmd: process.env.POB_CMD || undefined,
  args,
  env: { POB_API_STDIO: '0' },
  timeoutMs: 60_000,
});

const act = (action, params = {}) => client.itemsTabAction(action, params);
async function refused(action, params, pattern) {
  try {
    await act(action, params);
  } catch (error) {
    if (!pattern.test(error.message)) throw new Error(`${action} failed for the wrong reason: ${error.message}`);
    return error.message;
  }
  throw new Error(`${action} should have been refused: ${JSON.stringify(params).slice(0, 200)}`);
}
const check = (condition, message) => { if (!condition) throw new Error(message); };

try {
  await client.start();
  await client.loadBuildXml(await readFile(gearedBuildXml, 'utf8'), 'items-tab-smoke');

  // craft_item_create without rarity is RARE, as its schema says, not the
  // rarity CraftItem remembers from the last popup.
  const crafted = await act('item_craft_create', { base: 'Hubris Circlet' });
  check(crafted.item.rarity === 'RARE' && crafted.item.crafted, `default rarity: ${crafted.item.rarity}`);
  const helmet = crafted.item.text;

  // The user's display item: a crafted item, whose affix dropdowns the
  // "Modifier sorting" choice orders.
  const shown = await act('items_tab_show_item', { text: helmet });
  check(shown.displayItem && shown.firstAffixOptions?.length > 2, 'items_tab_show_item did not show the crafted item');
  await refused('items_tab_show_item', { text: helmet }, /already shows an item/);

  // A sorted listing must not leave its order in the user's dropdowns: the sort
  // goes back before the user's item is shown again.
  const defaultList = await act('item_craft_affixes', { text: helmet, list: 'prefix', limit: 500 });
  const sortedList = await act('item_craft_affixes', { text: helmet, list: 'prefix', limit: 500, sortBy: 'FullDPS' });
  const order = (list) => list.options.map((o) => o.label).join(' | ');
  check(order(defaultList) !== order(sortedList), 'FullDPS sort produced the Default order; the restore check below would prove nothing');
  check(defaultList.sortBy === undefined && sortedList.sortBy === 'Full DPS', `sortBy echo: ${defaultList.sortBy} / ${sortedList.sortBy}`);
  const after = await act('items_tab_state');
  check(after.displayItemText === shown.displayItemText, 'the display item was not restored');
  check(after.craftingSort === shown.craftingSort, `Modifier sorting not restored: ${after.craftingSort}`);
  check(after.firstAffixOptions.join(' | ') === shown.firstAffixOptions.join(' | '),
    'the user\'s affix dropdown kept the tool\'s sort order');
  check(after.snapHScroll === shown.snapHScroll, `snapHScroll not restored: ${after.snapHScroll}`);
  check(after.popups === shown.popups, 'a popup was left open');

  // A bare index is refused; "index:label" is checked against the list as it is
  // when the click happens.
  await refused('item_craft_affixes', { text: helmet, changes: [{ type: 'prefix', modifier: 2 }] }, /bare index is not accepted/);
  const second = defaultList.options[1];
  const wrong = defaultList.options[2];
  await refused('item_craft_affixes', { text: helmet, changes: [{ type: 'prefix', modifier: `${second.index}:${wrong.label}` }] }, /list the options again/);
  const picked = await act('item_craft_affixes', { text: helmet, changes: [{ type: 'prefix', modifier: second.pick, tier: 1 }] });
  check(picked.applied[0].label === second.label, `index:label picked ${picked.applied[0].label}, not ${second.label}`);
  // An earlier pick rebuilds the list for the next: the second change is
  // resolved against the rebuilt list, by its mod id.
  const lifeTier = defaultList.options.find((o) => o.label === '+# to maximum Life')?.tiers?.[0]?.modId;
  check(lifeTier, 'no +# to maximum Life prefix in the listing');
  const two = await act('item_craft_affixes', { text: helmet, changes: [
    { type: 'prefix', modifier: '#% increased Energy Shield', tier: 1 }, { type: 'prefix', modifier: lifeTier }] });
  check(two.applied[1].modId === lifeTier, `mod id pick after a rebuild chose ${two.applied[1].modId}`);

  // Bench crafts: the chosen option is echoed.
  const bench = await act('item_add_modifier', { text: helmet, source: 'MASTER', limit: 1 });
  const benchAdd = await act('item_add_modifier', { text: helmet, source: 'MASTER', modifier: bench.options[0].pick });
  check(benchAdd.addedLabel === bench.options[0].label, 'bench craft echo');

  // Corruption: implicit 1's pick rebuilds implicit 2's list; both by text.
  const corrupted = await act('item_corrupt', { text: helmet, implicits: ['(4-6)% increased maximum Life', 'Regenerate (1.6-2)% of Life per second'] });
  check(corrupted.chosen?.length === 2 && corrupted.item.corrupted, `corrupt chose ${JSON.stringify(corrupted.chosen)}`);

  // PoB 2.67.2's Prefix source raises inside PoB for this item; reported as such.
  const plain = (await act('item_craft_create', { text: 'Rarity: RARE\nPlain\nHubris Circlet\n+50 to maximum Life' })).item.text;
  await refused('item_add_modifier', { text: plain, source: 'PREFIX' }, /PoB's Add modifier popup fails for this item/);

  // Item sets: a refused create leaves no set behind; a copy of the untitled
  // first set works. (Delete is checked only for its refusal here.)
  const setsBefore = await client.listItemSets();
  await refused('item_set_manage', { action: 'create', title: '   ' }, /blank/);
  await refused('item_set_manage', { action: 'delete', id: setsBefore.itemSets[0].id }, /confirm: true/);
  check((await client.listItemSets()).itemSets.length === setsBefore.itemSets.length, 'a refused item set call changed the sets');
  const copied = await act('item_set_manage', { action: 'copy', id: setsBefore.itemSets[0].id });
  check(copied.itemSets.length === setsBefore.itemSets.length + 1, 'copy did not add one set');

  const final = await act('items_tab_state');
  check(final.displayItemText === shown.displayItemText && final.popups === shown.popups, 'Items tab state drifted over the run');
  console.log('items tab smoke passed: display item, sort, scroll and popups restored; bare and stale indexes refused; default rarity RARE; refused set calls leave no set');
} finally {
  await client.stop();
}
