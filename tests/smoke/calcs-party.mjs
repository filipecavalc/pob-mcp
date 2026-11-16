// Headless smoke test for the Calcs breakdowns and the Party tab (no network).
// Usage: npm run build && node tests/smoke/calcs-party.mjs
// POB_PATH, POB_CMD and POB_ARGS work as for the server (e.g. a Python
// launcher on Windows: POB_CMD=python POB_ARGS="-I scripts/luajit-win.py lua/vanilla_stdio_bridge.lua").
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PoBLuaApiClient } from '../../build/pobLuaBridge.js';
import { gearedBuildXml, smokePoBSrc } from './pobSource.mjs';

const client = new PoBLuaApiClient({
  cwd: smokePoBSrc(),
  cmd: process.env.POB_CMD,
  args: process.env.POB_ARGS ? process.env.POB_ARGS.split(/\s+/).filter(Boolean) : [resolve('lua/vanilla_stdio_bridge.lua')],
  env: { POB_API_STDIO: '0' },
  timeoutMs: 120_000,
});

const calcInputs = (xml) => {
  const calcs = xml.match(/<Calcs>[\s\S]*?<\/Calcs>/)?.[0] ?? '';
  // PoB writes attributes in table order, so name/value may come either way round.
  const input = (name) => {
    const tag = calcs.match(new RegExp(`<Input [^>]*name="${name}"[^>]*>`))?.[0];
    return tag?.match(/(?:string|boolean|number)="([^"]*)"/)?.[1];
  };
  return { mode: input('misc_buffMode'), showMinion: input('showMinion') };
};

try {
  await client.start();
  const capabilities = await client.getCapabilities();
  for (const action of ['list_calc_breakdowns', 'get_calc_breakdown', 'party_get', 'party_import', 'party_clear',
    'party_disable_effects', 'party_rebuild', 'party_set_export_support']) {
    assert.ok(capabilities.actions?.includes(action), `missing adapter capability: ${action}`);
  }

  // A support build: Grace, Haste and Flammability, exported with "Export Support".
  await client.newBuild({ className: 'Templar' });
  await client.setLevel(90);
  const group = await client.createSocketGroup({ label: 'auras' });
  for (const gemName of ['Grace', 'Haste', 'Flammability']) await client.addGem({ groupIndex: group.index ?? 1, gemName, level: 20 });
  const exported = await client.setPartyExportSupport(true);
  assert.equal(exported.exportSupport, true);
  assert.match(exported.exports.Aura ?? '', /Grace/);
  const supportXml = await client.exportBuildXml();
  assert.match(supportXml, /<ExportedBuffs name="Aura">/);

  // The build that receives the party effects.
  await client.loadBuildXml(await readFile(gearedBuildXml, 'utf8'), 'calcs-party-smoke');
  const before = calcInputs(await client.exportBuildXml());
  assert.equal(before.mode, 'EFFECTIVE', 'the build saves its Calcs mode');

  // Calcs breakdown: a read in another mode leaves the build's mode as it was.
  const effective = await client.getCalcBreakdown({ stat: 'Life' });
  assert.equal(effective.found, true);
  assert.ok(effective.sections.length > 0, 'Life breakdown has sections');
  const unbuffed = await client.getCalcBreakdown({ stat: 'FireResist', mode: 'UNBUFFED' });
  assert.equal(unbuffed.found && unbuffed.mode, 'UNBUFFED');
  assert.ok(unbuffed.sections.some((s) => s.type === 'table'), 'FireResist breakdown has a modifier table');
  await assert.rejects(client.getCalcBreakdown({ stat: 'Life', mode: 'COMBAT', minion: true }), /no minion/);
  const after = calcInputs(await client.exportBuildXml());
  assert.deepEqual(after, before, 'Calcs mode and minion box are restored in the saved build');
  assert.equal(after.mode ?? 'EFFECTIVE', 'EFFECTIVE');
  assert.equal((await client.listCalcBreakdowns({ filter: 'fire resist' })).mode, 'EFFECTIVE');

  // Party: import then clear brings the stats back.
  const fields = ['Evasion', 'TotalEHP', 'CombinedDPS'];
  const base = await client.getStats(fields);
  const imported = await client.partyImport({ xml: supportXml });
  assert.deepEqual(imported.active.auras.map((a) => a.name).sort(), ['Grace', 'Haste']);
  assert.deepEqual(imported.active.curses.map((c) => c.name), ['Flammability']);
  const withParty = await client.getStats(fields);
  assert.ok(withParty.Evasion > base.Evasion, `Grace adds evasion: ${base.Evasion} -> ${withParty.Evasion}`);
  const disabled = await client.partyDisableEffects();
  assert.equal(disabled.active.auras.length, 0);
  assert.notEqual(disabled.imported.auras, '');
  assert.equal((await client.getStats(fields)).Evasion, base.Evasion);
  assert.equal((await client.partyRebuild()).active.auras.length, 2);
  const cleared = await client.partyClear();
  assert.equal(cleared.active.auras.length + cleared.active.curses.length, 0);
  assert.equal(cleared.imported.auras, '');
  assert.deepEqual(await client.getStats(fields), base, 'clearing the party restores the stats');
  console.log('calcs-party smoke: OK', JSON.stringify({ base, withParty }));
} finally {
  await client.stop();
}
