import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import {
  handleGetParty, handlePartyImport, handlePartyClear, handlePartyDisableEffects, handleSetPartyExportSupport,
  exportedNames, parseDestination,
} from '../../src/handlers/partyHandlers.js';
import type { PartyState } from '../../src/pobLuaBridge.js';
import { textOf } from '../helpers/response.js';

type Context = Parameters<typeof handlePartyImport>[0];

const SUPPORT_XML = '<PathOfBuilding><Build level="90"/><Party><ExportedBuffs name="Aura">Grace\n100\n---</ExportedBuffs></Party></PathOfBuilding>';

const emptyState = (): PartyState => ({
  destination: 'All', append: false, exportSupport: false,
  imported: { partyMemberStats: '', auras: '', curses: '', warcries: '', links: '', enemyConditions: '', enemyMods: '' },
  active: {
    auras: [], auraDebuffs: [], extraAuraMods: 0, otherEffects: [], curses: [], warcries: [], links: [],
    partyMemberStats: {}, partyMemberFlags: [], enemyMods: [],
  },
});

const importedState = (): PartyState => {
  const state = emptyState();
  state.imported.auras = 'Grace\n100\n---';
  state.imported.curses = '--- Curse Limit ---\n1\nFlammability\n100\nfalse\n---';
  state.active.auras = [{ name: 'Grace', effect: 100, mods: 2 }, { name: 'Haste', effect: 100, mods: 3 }];
  state.active.curses = [{ name: 'Flammability', effect: 100, mods: 2 }];
  state.active.curseLimit = 1;
  state.active.partyMemberStats = { MovementSpeedMod: 1.16 };
  state.active.enemyMods = [{ name: 'Condition:Party:Burning', type: 'FLAG', value: true }, { name: 'DamageTaken', type: 'INC', value: 60 }];
  return state;
};

function fakeClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let statsCall = 0;
  const base: Record<string, (...args: unknown[]) => unknown> = {
    getStats: () => (statsCall++ % 2 === 0 ? { CombinedDPS: 80043, Evasion: 1266, Life: 5447 } : { CombinedDPS: 137674, Evasion: 4483, Life: 5447 }),
    getParty: () => importedState(),
    partyImport: () => ({ ...importedState(), exportedSections: ['Aura', 'Curse'] }),
    partyClear: () => emptyState(),
    partyDisableEffects: () => { const s = importedState(); s.active = emptyState().active; return s; },
    setPartyExportSupport: (enabled: unknown) => ({ exportSupport: enabled, exports: { Aura: 'Determination\n100\n1|x\n---\nPurity of Fire\n100\n---', Curse: '--- Curse Limit ---\n1', EnemyMods: 'a\nb' } }),
    ...(overrides as Record<string, (...args: unknown[]) => unknown>),
  };
  const client = Object.fromEntries(Object.entries(base).map(([name, fn]) => [name, async (...args: unknown[]) => { calls.push({ name, args }); return fn(...args); }]));
  return { client, calls };
}

function contextFor(client: unknown, pobDirectory = '.'): Context {
  return { ensureLuaClient: async () => {}, getLuaClient: () => client, pobDirectory, luaEnabled: true, stopLuaClient: async () => {} } as unknown as Context;
}

describe('party_import', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pob-party-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('decodes a build code and hands the XML to PoB with destination and append', async () => {
    const { client, calls } = fakeClient();
    const code = zlib.deflateSync(Buffer.from(SUPPORT_XML)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    const text = textOf(await handlePartyImport(contextFor(client), { code, destination: 'aura', append: true }));
    const importCall = calls.find((c) => c.name === 'partyImport');
    expect(importCall?.args[0]).toEqual({ xml: SUPPORT_XML, destination: 'Aura', append: true });
    expect(text).toContain('Imported into the Party tab (Aura, appended).');
    expect(text).toContain('The source exports: Aura, Curse.');
    expect(text).toContain('Auras: Grace 100%, Haste 100%');
    expect(text).toContain('Curses (party curse limit 1): Flammability 100%');
    expect(text).toContain('Party member stats: MovementSpeedMod=1.16');
    expect(text).toContain('Enemy conditions: Burning');
    expect(text).toContain('Enemy modifiers: DamageTaken INC 60');
    expect(text).toMatch(/Combined DPS: 80[.,]043 → 137[.,]674/);
    expect(text).not.toContain('Life:');
  });

  it('reads a build file from the builds directory, and refuses one outside it', async () => {
    await fs.writeFile(path.join(dir, 'Support.xml'), SUPPORT_XML);
    const { client, calls } = fakeClient();
    await handlePartyImport(contextFor(client, dir), { buildName: 'Support' });
    expect(calls.find((c) => c.name === 'partyImport')?.args[0]).toEqual({ xml: SUPPORT_XML, destination: undefined, append: false });
    await expect(handlePartyImport(contextFor(client, dir), { buildName: '../Support' })).rejects.toThrow(/traversal/);
  });

  it('needs exactly one source and refuses build site links', async () => {
    const { client, calls } = fakeClient();
    await expect(handlePartyImport(contextFor(client), {})).rejects.toThrow(/exactly one of code, build_name or xml/);
    await expect(handlePartyImport(contextFor(client), { code: 'abc', xml: SUPPORT_XML })).rejects.toThrow(/exactly one/);
    await expect(handlePartyImport(contextFor(client), { code: 'https://pobb.in/abc' })).rejects.toThrow(/not downloaded/);
    await expect(handlePartyImport(contextFor(client), { xml: SUPPORT_XML, destination: 'Everything' })).rejects.toThrow(/destination must be one of/);
    expect(calls.filter((c) => c.name === 'partyImport')).toHaveLength(0);
  });
});

describe('Party tab buttons', () => {
  it('get_party shows effects and the kept text', async () => {
    const { client } = fakeClient();
    const text = textOf(await handleGetParty(contextFor(client)));
    expect(text).toContain('Party tab: destination All, append off');
    expect(text).toContain('Imported text kept in the tab: auras, curses');
  });

  it('Disable Party Effects keeps the text and says how to apply it again', async () => {
    const { client } = fakeClient();
    const text = textOf(await handlePartyDisableEffects(contextFor(client)));
    expect(text).toContain('Auras: -');
    expect(text).toContain('party_rebuild applies it again');
  });

  it('Clear passes the destination and warns that enemy modifiers go too', async () => {
    const { client, calls } = fakeClient();
    const text = textOf(await handlePartyClear(contextFor(client), 'curse'));
    expect(calls.find((c) => c.name === 'partyClear')?.args).toEqual(['Curse']);
    expect(text).toContain('also drops the parsed enemy conditions and modifiers');
  });

  it('Export Support lists the exported effect names', async () => {
    const { client, calls } = fakeClient();
    const text = textOf(await handleSetPartyExportSupport(contextFor(client), true));
    expect(calls[0]).toEqual({ name: 'setPartyExportSupport', args: [true] });
    expect(text).toContain('Aura: Determination, Purity of Fire');
    expect(text).toContain('Curse: none');
    expect(text).toContain('EnemyMods: 2 lines');
    await expect(handleSetPartyExportSupport(contextFor(client), 'yes' as unknown as boolean)).rejects.toThrow(/true or false/);
  });
});

describe('loading a build saved on Windows', () => {
  it('hands PoB LF line ends, as its text-mode file read does, so party text parses', async () => {
    const { PoBLuaApiClient } = await import('../../src/pobLuaBridge.js');
    const sent: Array<{ action: string; params?: { xml?: string } }> = [];
    class Recording extends PoBLuaApiClient {
      protected override async send(obj: { action: string; params?: object }) { sent.push(obj as never); return { ok: true }; }
    }
    await new Recording().loadBuildXml('<PathOfBuilding>\r\n<Party><ImportedBuffs name="Aura">Grace\r\n100\r\n---</ImportedBuffs></Party>\r\n</PathOfBuilding>');
    expect(sent[0].params?.xml).toBe('<PathOfBuilding>\n<Party><ImportedBuffs name="Aura">Grace\n100\n---</ImportedBuffs></Party>\n</PathOfBuilding>');
  });

  it('does the same for a build loaded from a site link and for a comparison build', async () => {
    const { PoBLuaApiClient } = await import('../../src/pobLuaBridge.js');
    const sent: Array<{ action: string; params?: { xml?: string } }> = [];
    class Recording extends PoBLuaApiClient {
      protected override async send(obj: { action: string; params?: object }) { sent.push(obj as never); return { ok: true, result: {} }; }
    }
    const crlf = '<PathOfBuilding>\r\n<Party><EnemyMods>Enemy is Hindered\r\n</EnemyMods></Party>\r\n</PathOfBuilding>';
    const client = new Recording();
    await client.loadImportedBuild(crlf, 'Linked', 'https://example.invalid/b');
    await client.compareImport(crlf, 'Other');
    expect(sent.map((s) => s.action)).toEqual(['load_imported_build', 'compare_import']);
    for (const s of sent) expect(s.params?.xml).not.toContain('\r');
  });
});

describe('helpers', () => {
  it('exportedNames reads the names PartyTab:exportBuffs writes', () => {
    expect(exportedNames('--- Curse Limit ---\n2\nFlammability\n100\nfalse\n1|x\n---\nDespair\n50\ntrue\n---')).toEqual(['Flammability', 'Despair']);
  });
  it('parseDestination matches the dropdown names case-insensitively', () => {
    expect(parseDestination('link skills')).toBe('Link Skills');
    expect(parseDestination(undefined)).toBeUndefined();
  });
});
