import { describe, it, expect, beforeEach } from '@jest/globals';

const readFile = jest.fn(async (..._args: unknown[]) => '<?xml version="1.0"?><PathOfBuilding/>');
const access = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('fs/promises', () => ({ __esModule: true, default: { readFile, access } }));

import { handleImportCharacter, describeItemRaw, describeGearChanges, gemsBySlot, describeGemChanges } from '../../src/handlers/characterImportHandlers.js';

describe('gem comparison', () => {
  it('reports level changes, new and removed gems, and keeps duplicate gems apart', () => {
    const before = gemsBySlot({ groups: [
      { slot: 'Helmet', gems: [{ name: 'Fire Trap', level: 18 }, { name: 'Lifetap', level: 10 }] },
      { slot: 'Gloves', gems: [{ name: 'Lifetap', level: 5 }, { name: 'Lifetap', level: 6 }] },
    ] });
    const after = gemsBySlot({ groups: [
      { slot: 'Helmet', gems: [{ name: 'Fire Trap', level: 19 }, { name: 'Combustion', level: 1 }] },
      { slot: 'Gloves', gems: [{ name: 'Lifetap', level: 5 }, { name: 'Lifetap', level: 6 }] },
    ] });
    expect(describeGemChanges(before, after)).toEqual([
      '  Helmet: Fire Trap level 18, quality 0 → level 19, quality 0',
      '  Helmet: Lifetap level 10, quality 0 → (removed)',
      '  Helmet: Combustion (not socketed) → level 1, quality 0',
    ]);
  });
});

// Raw text of one real item as PoB holds it after loading a saved build, and
// after a fresh import from pathofexile.com.
const BOOTS_FROM_XML = [
  'Rarity: RARE', 'Fate Hoof', 'Shagreen Boots', 'Evasion: 238', 'EvasionBasePercentile: 0.6505',
  'Unique ID: 9b48', 'Item Level: 61', 'Quality: 0', 'Sockets: W W-W', 'LevelReq: 55', 'Implicits: 0',
  '+118 to maximum Life', '+13% to Item Rarity', '+20% to Fire Resistance',
].join('\n');
const BOOTS_IMPORTED = [
  'Rarity: RARE', 'Fate Hoof', 'Shagreen Boots', 'Evasion: 238',
  'Unique ID: 9b48', 'Item Level: 61', 'Quality: 0', 'Sockets: W W-W', 'Implicits: 0',
  '+118 to maximum Life', '+13% to [PlayerItemRarity|Item Rarity]', '+20% to Fire Resistance',
].join('\n');

describe('item comparison across XML load and fresh import', () => {
  const slot = (raw: string, label = 'Fate Hoof') => ({ label, ...describeItemRaw(raw) });

  it('treats the same item as unchanged despite formatting differences', () => {
    const before = new Map([['Boots', slot(BOOTS_FROM_XML)]]);
    const after = new Map([['Boots', slot(BOOTS_IMPORTED)]]);
    expect(describeGearChanges(before, after)).toEqual([]);
  });

  it('reports a mod change on the same item id', () => {
    const before = new Map([['Boots', slot(BOOTS_FROM_XML)]]);
    const after = new Map([['Boots', slot(BOOTS_IMPORTED.replace('+20% to Fire Resistance', '+31% to Chaos Resistance'))]]);
    expect(describeGearChanges(before, after)).toEqual([
      '  Boots: Fate Hoof changed',
      '      - +20% to Fire Resistance',
      '      + +31% to Chaos Resistance',
    ]);
  });

  it('reports a quality change on the same item id', () => {
    const before = new Map([['Boots', slot(BOOTS_FROM_XML)]]);
    const after = new Map([['Boots', slot(BOOTS_IMPORTED.replace('Quality: 0', 'Quality: 20'))]]);
    expect(describeGearChanges(before, after)).toContain('      + Quality: 20');
  });

  it('reports a different item id as a replacement', () => {
    const before = new Map([['Boots', slot(BOOTS_FROM_XML)]]);
    const after = new Map([['Boots', slot(BOOTS_IMPORTED.replace('Unique ID: 9b48', 'Unique ID: ffff'), 'Other Boots')]]);
    expect(describeGearChanges(before, after)).toEqual(['  Boots: Fate Hoof → Other Boots']);
  });

  it('reports emptied and newly filled slots', () => {
    const before = new Map([['Ring 1', slot(BOOTS_FROM_XML, 'Old Ring')]]);
    const after = new Map([['Ring 2', slot(BOOTS_IMPORTED, 'New Ring')]]);
    expect(describeGearChanges(before, after)).toEqual(['  Ring 1: Old Ring → (empty)', '  Ring 2: (empty) → New Ring']);
  });
});

const entry = { name: 'RfChar', class: 'Chieftain', league: 'Covens', level: 83 };

function makeLuaClient(overrides: Record<string, unknown> = {}) {
  const statsQueue = [
    { Life: 5113, CombinedDPS: 59559, ChaosResist: -52 },
    { Life: 5290, CombinedDPS: 73663, ChaosResist: -52 },
  ];
  const itemsQueue = [
    [{ slot: 'Helmet', name: 'Old Helm' }, { slot: 'Belt', name: 'Immortal Flesh' }],
    [{ slot: 'Helmet', name: 'Brood Brow' }, { slot: 'Belt', name: 'Immortal Flesh' }],
  ];
  const skillsQueue = [
    { groups: [{ slot: 'Body Armour', gems: [{ name: 'Righteous Fire', level: 20, quality: 0 }, { name: 'Swift Affliction', level: 16, quality: 0 }] }] },
    { groups: [{ slot: 'Body Armour', gems: [{ name: 'Righteous Fire', level: 20, quality: 0 }, { name: 'Swift Affliction', level: 17, quality: 0 }] }] },
  ];
  return {
    getSkills: jest.fn(async () => skillsQueue.shift() ?? { groups: [] }),
    loadBuildXml: jest.fn(async () => ({ ok: true })),
    newBuild: jest.fn(async () => ({ ok: true })),
    getStats: jest.fn(async () => statsQueue.shift() ?? {}),
    getItems: jest.fn(async () => itemsQueue.shift() ?? []),
    importCharacter: jest.fn(async () => ({
      class: 'Marauder', ascendancy: 'Chieftain', level: 83, allocatedNodes: 113, socketGroups: 7,
      mainSkill: 'Righteous Fire', mainSkillSource: 'kept',
      restoredConfig: { bandit: { imported: 'None', kept: 'Kraityn' } },
      items: [{ slot: 'Helmet', name: 'Brood Brow' }],
    })),
    saveBuild: jest.fn(async (filePath: string, _overwrite?: boolean) => ({ path: filePath, size: 1234 })),
    ...overrides,
  };
}

function makeCharacterClient() {
  return {
    listCharacters: jest.fn(async () => [entry, { name: 'Other', class: 'Witch', league: 'Standard', level: 90 }]),
    getPassives: jest.fn(async () => ({ hashes: [1] })),
    getItems: jest.fn(async () => ({ items: [] })),
  };
}

function makeContext(luaClient: ReturnType<typeof makeLuaClient>) {
  return {
    pobDirectory: '/builds',
    luaEnabled: true,
    getLuaClient: () => luaClient,
    ensureLuaClient: async () => {},
    stopLuaClient: async () => {},
    buildService: { invalidateBuild: jest.fn() },
  } as any;
}

const text = (result: any): string => result.content.map((c: any) => c.text).join('\n');

describe('handleImportCharacter', () => {
  beforeEach(() => {
    readFile.mockClear();
    access.mockClear();
  });

  it('imports on top of save_as when it exists, reports changes and saves back', async () => {
    const lua = makeLuaClient();
    const chars = makeCharacterClient();
    const result = await handleImportCharacter(makeContext(lua), { accountName: 'Acc#1', character: 'RfChar', saveAs: 'RF atual' },
      { characterClient: chars, env: {}, fileExists: async () => true });
    const out = text(result);

    expect(lua.loadBuildXml).toHaveBeenCalledTimes(1);
    expect(lua.newBuild).not.toHaveBeenCalled();
    expect(lua.importCharacter).toHaveBeenCalledWith(expect.objectContaining({ character: entry, passives: { hashes: [1] }, items: { items: [] } }));
    expect(String(lua.saveBuild.mock.calls[0][0]).replace(/\\/g, '/')).toMatch(/\/builds\/RF atual\.xml$/);
    // saving back over the base it imported into is allowed explicitly
    expect(lua.saveBuild.mock.calls[0][1]).toBe(true);
    expect(out).toMatch(/Helmet: Old Helm → Brood Brow/);
    expect(out).not.toMatch(/Belt:/);
    expect(out).toMatch(/bandit: kept Kraityn \(importer set None\)/);
    expect(out).toMatch(/Main skill: Righteous Fire \(kept\)/);
    expect(out).toMatch(/Body Armour: Swift Affliction level 16, quality 0 → level 17, quality 0/);
    expect(out).not.toMatch(/Righteous Fire level/);
  });

  it('fetches everything before touching the loaded build', async () => {
    const lua = makeLuaClient();
    const chars = makeCharacterClient();
    chars.getItems.mockRejectedValueOnce(new Error('rate limited'));
    await expect(handleImportCharacter(makeContext(lua), { accountName: 'Acc#1', character: 'RfChar', saveAs: 'RF atual' },
      { characterClient: chars, env: {}, fileExists: async () => true })).rejects.toThrow(/rate limited/);
    expect(lua.loadBuildXml).not.toHaveBeenCalled();
    expect(lua.newBuild).not.toHaveBeenCalled();
    expect(lua.importCharacter).not.toHaveBeenCalled();
  });

  it('refuses to replace an existing save_as that is not the base, before any request', async () => {
    const lua = makeLuaClient();
    const chars = makeCharacterClient();
    await expect(handleImportCharacter(makeContext(lua), { accountName: 'Acc#1', character: 'RfChar', baseBuild: 'Base', saveAs: 'Other' },
      { characterClient: chars, env: {}, fileExists: async () => true })).rejects.toThrow(/already exists and is not the base build/);
    expect(chars.listCharacters).not.toHaveBeenCalled();
    expect(lua.loadBuildXml).not.toHaveBeenCalled();
  });

  it('reloads the base when the import fails halfway', async () => {
    const lua = makeLuaClient({ importCharacter: jest.fn(async () => { throw new Error('item import failed: boom'); }) });
    await expect(handleImportCharacter(makeContext(lua), { accountName: 'Acc#1', character: 'RfChar', baseBuild: 'Base' },
      { characterClient: makeCharacterClient(), env: {} })).rejects.toThrow(/item import failed/);
    expect(lua.loadBuildXml).toHaveBeenCalledTimes(2);
    expect(lua.saveBuild).not.toHaveBeenCalled();
  });

  it('retries with the profile spelling of the account name when the exact-case endpoints refuse it', async () => {
    const chars = {
      ...makeCharacterClient(),
      getPassives: jest.fn(async (account: string) => {
        if (account !== 'Acc#1') throw Object.assign(new Error('private'), { status: 403 });
        return { hashes: [1] };
      }),
      resolveAccountName: jest.fn(async () => 'Acc#1'),
    };
    await handleImportCharacter(makeContext(makeLuaClient()), { accountName: 'acc#1', character: 'RfChar' },
      { characterClient: chars, env: {}, fileExists: async () => false });
    expect(chars.resolveAccountName).toHaveBeenCalledWith('acc#1', 'pc');
    expect(chars.getPassives).toHaveBeenLastCalledWith('Acc#1', 'RfChar', 'pc');
    expect(chars.getItems).toHaveBeenCalledWith('Acc#1', 'RfChar', 'pc');
  });

  it('rethrows when the profile spelling is the same', async () => {
    const chars = {
      ...makeCharacterClient(),
      getPassives: jest.fn(async () => { throw Object.assign(new Error('really private'), { status: 403 }); }),
      resolveAccountName: jest.fn(async () => 'Acc#1'),
    };
    await expect(handleImportCharacter(makeContext(makeLuaClient()), { accountName: 'Acc#1', character: 'RfChar' },
      { characterClient: chars, env: {} })).rejects.toThrow(/really private/);
    expect(chars.getPassives).toHaveBeenCalledTimes(1);
  });

  it('starts from a new build when no base exists and lists gear instead of a diff', async () => {
    const lua = makeLuaClient();
    const result = await handleImportCharacter(makeContext(lua), { accountName: 'Acc#1', character: 'RfChar' },
      { characterClient: makeCharacterClient(), env: {}, fileExists: async () => false });
    expect(lua.newBuild).toHaveBeenCalledTimes(1);
    expect(lua.loadBuildXml).not.toHaveBeenCalled();
    expect(lua.saveBuild).not.toHaveBeenCalled();
    expect(text(result)).toMatch(/Not saved/);
  });

  it('takes account, character and save target from the env', async () => {
    const lua = makeLuaClient();
    const chars = makeCharacterClient();
    await handleImportCharacter(makeContext(lua), {},
      { characterClient: chars, env: { POE_ACCOUNT_NAME: 'Env#9', POE_CHARACTER: 'rfchar', POB_CHARACTER_BUILD: 'Env Build' }, fileExists: async () => false });
    expect(chars.listCharacters).toHaveBeenCalledWith('Env#9', 'pc');
    // case-insensitive fallback resolves to the account's real spelling
    expect(chars.getItems).toHaveBeenCalledWith('Env#9', 'RfChar', 'pc');
    expect(lua.saveBuild).toHaveBeenCalledTimes(1);
  });

  it('lists the characters when none is named', async () => {
    await expect(handleImportCharacter(makeContext(makeLuaClient()), { accountName: 'Acc#1' },
      { characterClient: makeCharacterClient(), env: {} })).rejects.toThrow(/RfChar \(Chieftain, level 83, Covens\)/);
  });

  it('fails without an account name, before any request', async () => {
    const chars = makeCharacterClient();
    await expect(handleImportCharacter(makeContext(makeLuaClient()), {}, { characterClient: chars, env: {} }))
      .rejects.toThrow(/account_name is required/);
    expect(chars.listCharacters).not.toHaveBeenCalled();
  });

  it('treats an empty restoredConfig array (empty Lua table) as nothing restored', async () => {
    const lua = makeLuaClient({
      importCharacter: jest.fn(async () => ({ class: 'Marauder', ascendancy: 'Chieftain', level: 83, mainSkill: 'Righteous Fire', mainSkillSource: 'kept', restoredConfig: [] })),
    });
    const result = await handleImportCharacter(makeContext(lua), { accountName: 'Acc#1', character: 'RfChar', baseBuild: 'Base' },
      { characterClient: makeCharacterClient(), env: {} });
    expect(text(result)).not.toMatch(/Kept from the base build/);
  });
});
