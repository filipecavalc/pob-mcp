// Smoke test for the Skills/Config tab actions against the real PoB engine (no network):
// gem DPS ranking, skill and config sets, custom modifiers, the main skill's minion.
// Usage: npm run build && node tests/smoke/skills-config.mjs
// (POB_PATH forces a checkout; POB_CMD / POB_ARGS replace `luajit <bridge>`, e.g.
// POB_CMD=python POB_ARGS="-I scripts/luajit-win.py lua/vanilla_stdio_bridge.lua")
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PoBLuaApiClient } from '../../build/pobLuaBridge.js';
import { gearedBuildXml, smokePoBSrc } from './pobSource.mjs';

const client = new PoBLuaApiClient({
  cwd: smokePoBSrc(),
  cmd: process.env.POB_CMD || 'luajit',
  args: process.env.POB_ARGS
    ? process.env.POB_ARGS.split(' ').map((a) => (a.endsWith('.lua') || a.endsWith('.py') ? resolve(a) : a))
    : [resolve('lua/vanilla_stdio_bridge.lua')],
  env: { POB_API_STDIO: '0' },
  timeoutMs: 120_000,
});

const fail = (message) => { throw new Error(message); };
const expectReject = async (promise, pattern, what) => {
  try { await promise; } catch (e) {
    if (!pattern.test(e.message)) fail(`${what}: unexpected error "${e.message}"`);
    return;
  }
  fail(`${what}: expected a refusal`);
};
// The first line that differs, so a failure says what changed.
const firstDiff = (a, b) => {
  const al = a.split('\n'), bl = b.split('\n');
  const i = al.findIndex((line, n) => line !== bl[n]);
  return i < 0 ? `line count ${al.length} vs ${bl.length}` : `line ${i + 1}:\n- ${al[i]}\n+ ${bl[i]}`;
};
const sameXml = async (expected, what) => {
  const now = await client.exportBuildXml();
  if (now !== expected) fail(`${what} changed the exported build XML at ${firstDiff(expected, now)}`);
};
const checks = [];
const pass = (name) => { checks.push(name); };

try {
  await client.start();
  const fixture = await readFile(gearedBuildXml, 'utf8');

  // 1. Ranking gems must leave the build exactly as it was.
  await client.loadBuildXml(fixture, 'skills-config-smoke');
  const before = await client.exportBuildXml();
  const main = (await client.getSkills()).mainSocketGroup;
  const ranking = await client.rankGemsByDps({ groupIndex: main, limit: 5 });
  if (!(ranking.evaluatedCount > 0) || ranking.candidates.length === 0) fail(`ranking calculated nothing: ${JSON.stringify(ranking)}`);
  if (ranking.candidates.some((c) => c.evaluated && typeof c.dps !== 'number')) fail('ranking returned a non-numeric DPS');
  await client.rankGemsByDps({ groupIndex: main, gemIndex: 2, gemType: 'all', limit: 3 });
  await sameXml(before, 'rank_gems_by_dps');
  pass(`ranking (${ranking.evaluatedCount} gems calculated, top ${ranking.candidates[0].name}) left the build unchanged`);

  // 2. Selecting the active set is a no-op; deleting the active set hands over; the last set cannot go.
  const sameSkill = await client.selectSkillSet((await client.listSkillSets()).activeSkillSetId);
  const sameConfig = await client.selectConfigSet((await client.listConfigSets()).activeConfigSetId);
  if (!sameSkill.unchanged || !sameConfig.unchanged) fail('selecting the active set was not a no-op');
  await sameXml(before, 'selecting the active set');
  const created = await client.createSkillSet({ title: 'Smoke copy', copyFrom: 1, activate: true });
  if (created.activeSkillSetId !== created.created) fail('create_skill_set did not activate the new set');
  const afterDelete = await client.deleteSkillSet(created.created);
  if (afterDelete.skillSets.length !== 1 || afterDelete.activeSkillSetId !== 1) fail(`deleting the active skill set: ${JSON.stringify(afterDelete)}`);
  await expectReject(client.deleteSkillSet(1), /only skill set/, 'deleting the last skill set');
  const config = await client.createConfigSet({ title: 'Smoke config', activate: true });
  const configAfterDelete = await client.deleteConfigSet(config.created);
  if (configAfterDelete.configSets.length !== 1 || configAfterDelete.activeConfigSetId !== 1) fail('deleting the active config set did not hand over');
  await expectReject(client.deleteConfigSet(1), /only config set/, 'deleting the last config set');
  pass('select no-op, delete of the active set, refusal of the last set');

  // 3. Custom modifiers change the calculation and are saved with the build.
  await client.loadBuildXml(fixture, 'skills-config-smoke');
  const baseLife = (await client.getStats(['Life'])).Life;
  const mods = await client.setCustomMods({ groupIndex: 1, text: '+1000 to maximum Life\nnot a modifier' });
  if (!mods.groups[0].lines[0].supported || mods.groups[0].lines[1].supported) fail('custom mod parse flags are wrong');
  const moddedLife = (await client.getStats(['Life'])).Life;
  if (!(moddedLife > baseLife)) fail(`+1000 life did not raise Life (${baseLife} -> ${moddedLife})`);
  const saved = await client.exportBuildXml();
  if (!/<CustomModifierBlock[^>]*>\s*\+1000 to maximum Life/.test(saved)) fail('the custom modifier is not in the saved XML');
  await client.loadBuildXml(saved, 'skills-config-smoke-reload');
  if ((await client.getStats(['Life'])).Life !== moddedLife) fail('the reloaded build does not apply the custom modifier');
  await client.setCustomMods({ groupIndex: 1, enabled: false });
  if ((await client.getStats(['Life'])).Life !== baseLife) fail('disabling the group did not restore Life');
  pass(`custom mods: Life ${baseLife} -> ${moddedLife}, saved, reloaded, disabled`);

  // 4. A set_minion call that fails on the minion skill leaves the build unchanged.
  await client.loadBuildXml(fixture, 'skills-config-smoke');
  const group = (await client.createSocketGroup({ label: 'Spectres' })).index;
  await client.addGem({ groupIndex: group, gemName: 'Raise Spectre', level: 20 });
  await client.setMainSelection({ mainSocketGroup: group });
  await client.setSpectres({ add: ['Solar Guard', 'Gluttonous Gull'] });
  const options = await client.getMinionOptions();
  if (options.options?.length !== 2) fail(`expected two spectres: ${JSON.stringify(options)}`);
  const minionBefore = await client.exportBuildXml();
  const other = options.options.find((o) => o.minionId !== options.selectedMinion).minionId;
  await expectReject(client.setMinion({ minion: other, minionSkill: 99 }), /minion skill 99 not found/, 'set_minion with a bad skill');
  const optionsAfter = await client.getMinionOptions();
  if (optionsAfter.selectedMinion !== options.selectedMinion) fail('the failed set_minion still switched the minion');
  await sameXml(minionBefore, 'the failed set_minion');
  const switched = await client.setMinion({ minion: other, minionSkill: 1 });
  if (switched.selectedMinion !== other) fail('set_minion did not switch the minion');
  pass('failed set_minion left the build unchanged; a valid one applies');

  for (const name of checks) console.log(`ok - ${name}`);
  console.log(`skills-config smoke passed (${checks.length} checks)`);
} finally {
  await client.stop();
}
