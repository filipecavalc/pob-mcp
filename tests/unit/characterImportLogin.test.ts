import { describe, it, expect } from '@jest/globals';

const readFile = jest.fn(async (..._args: unknown[]) => '<?xml version="1.0"?><PathOfBuilding/>');
const access = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('fs/promises', () => ({ __esModule: true, default: { readFile, access } }));

import { handleImportCharacter, splitLoginCharacter, type PobLoginSource } from '../../src/handlers/characterImportHandlers.js';

// Shape of GGG's login API character (PoB's "Import From Your Account").
const LOGIN_CHARACTER = {
  id: 'abc', name: 'RfChar', realm: 'pc', class: 'Chieftain', league: 'Covens', level: 85,
  equipment: [{ id: 'e1', inventoryId: 'Helm' }],
  inventory: [{ id: 'bag1', inventoryId: 'MainInventory' }],
  jewels: [{ id: 'j1', inventoryId: 'PassiveJewels' }],
  passives: { hashes: [1, 2], bandit_choice: 'Kraityn', pantheon_major: 'TheBrineKing', pantheon_minor: 'Ralakesh' },
};

function makeLuaClient() {
  return {
    getSkills: jest.fn(async () => ({ groups: [] })),
    loadBuildXml: jest.fn(async () => ({ ok: true })),
    newBuild: jest.fn(async () => ({ ok: true })),
    getStats: jest.fn(async () => ({ Life: 5000 })),
    getItems: jest.fn(async () => []),
    importCharacter: jest.fn(async () => ({
      class: 'Marauder', ascendancy: 'Chieftain', level: 85, allocatedNodes: 115, socketGroups: 7,
      mainSkill: 'Righteous Fire', mainSkillSource: 'kept', restoredConfig: [],
      questChoices: { bandit: 'Kraityn', pantheonMajorGod: 'TheBrineKing', pantheonMinorGod: 'Ralakesh' },
      items: [],
    })),
    saveBuild: jest.fn(async (filePath: string) => ({ path: filePath, size: 1 })),
  };
}

const context = (lua: ReturnType<typeof makeLuaClient>) => ({
  pobDirectory: '/builds', luaEnabled: true, getLuaClient: () => lua,
  ensureLuaClient: async () => {}, stopLuaClient: async () => {}, buildService: { invalidateBuild: jest.fn() },
}) as any;

const publicClient = () => ({
  listCharacters: jest.fn(async () => [{ name: 'RfChar', class: 'Chieftain', league: 'Covens', level: 84 }]),
  getPassives: jest.fn(async () => ({ hashes: [1] })),
  getItems: jest.fn(async () => ({ items: [] })),
});

const login = (authenticated = true, overrides: Partial<PobLoginSource> = {}): PobLoginSource & { character: jest.Mock } => ({
  status: jest.fn(async () => ({ authenticated })),
  character: jest.fn(async () => structuredClone(LOGIN_CHARACTER)),
  ...overrides,
}) as any;

const text = (result: any): string => result.content.map((c: any) => c.text).join('\n');

describe('splitLoginCharacter', () => {
  it('splits the login character into the importer shape, without bag items', () => {
    const { entry, passives, items } = splitLoginCharacter(structuredClone(LOGIN_CHARACTER));
    expect(entry).toMatchObject({ name: 'RfChar', class: 'Chieftain', league: 'Covens', level: 85 });
    expect(entry).not.toHaveProperty('equipment');
    expect(entry).not.toHaveProperty('inventory');
    expect(passives).toMatchObject({ hashes: [1, 2], bandit_choice: 'Kraityn', items: [{ id: 'j1', inventoryId: 'PassiveJewels' }] });
    expect(items).toEqual({ items: [{ id: 'e1', inventoryId: 'Helm' }] });
  });

  it('copes with absent equipment or jewels, and passes a missing level through for PoB', () => {
    const { entry, passives, items } = splitLoginCharacter({ name: 'a', class: 'b', league: 'c', passives: { hashes: [] } });
    expect(passives.items).toEqual([]);
    expect(items).toEqual({ items: [] });
    expect(entry.level).toBeUndefined();
  });

  it('refuses a response without a tree or identity', () => {
    expect(() => splitLoginCharacter({ name: 'x', class: 'y', league: 'z' })).toThrow(/passive tree/);
    expect(() => splitLoginCharacter({ passives: {} })).toThrow(/name, class or league/);
  });
});

describe('import source', () => {
  it('auto uses the PoB login when the window is logged in, and says so', async () => {
    const lua = makeLuaClient();
    const chars = publicClient();
    const pobLogin = login(true);
    const out = text(await handleImportCharacter(context(lua), { character: 'RfChar' },
      { characterClient: chars, pobLogin, env: {}, fileExists: async () => false }));
    expect(pobLogin.character).toHaveBeenCalledWith('RfChar', 'pc');
    expect(chars.listCharacters).not.toHaveBeenCalled();
    expect(lua.importCharacter).toHaveBeenCalledWith(expect.objectContaining({
      questChoicesFromResponse: true,
      items: { items: [{ id: 'e1', inventoryId: 'Helm' }] },
    }));
    expect(out).toMatch(/Source: Path of Building \(MCP\)'s Path of Exile login/);
    expect(out).toMatch(/bandit Kraityn, major TheBrineKing, minor Ralakesh/);
    expect(out).not.toMatch(/character requests used/);
  });

  it('auto falls back to the public profile when the window is not logged in, and says why', async () => {
    const lua = makeLuaClient();
    const chars = publicClient();
    const pobLogin = login(false);
    const out = text(await handleImportCharacter(context(lua), { character: 'RfChar' },
      { characterClient: chars, pobLogin, env: { POE_ACCOUNT_NAME: 'Acc#1' }, fileExists: async () => false }));
    expect(pobLogin.character).not.toHaveBeenCalled();
    expect(chars.listCharacters).toHaveBeenCalled();
    expect(lua.importCharacter).toHaveBeenCalledWith(expect.objectContaining({ questChoicesFromResponse: false }));
    expect(out).toMatch(/Source: public profile \(Path of Building \(MCP\) is not logged in/);
    expect(out).not.toMatch(/Bandit and pantheon from the account/);
  });

  it('auto falls back when the window does not answer', async () => {
    const lua = makeLuaClient();
    const pobLogin = login(true, { status: jest.fn(async () => { throw new Error('connect ECONNREFUSED'); }) });
    const out = text(await handleImportCharacter(context(lua), { character: 'RfChar' },
      { characterClient: publicClient(), pobLogin, env: { POE_ACCOUNT_NAME: 'Acc#1' }, fileExists: async () => false }));
    expect(out).toMatch(/Source: public profile \(Path of Building \(MCP\) is not running or did not answer: connect ECONNREFUSED/);
  });

  it('pob_login fails instead of falling back', async () => {
    const lua = makeLuaClient();
    const chars = publicClient();
    await expect(handleImportCharacter(context(lua), { accountName: 'Acc#1', character: 'RfChar', source: 'pob_login' },
      { characterClient: chars, pobLogin: login(false), env: {}, fileExists: async () => false }))
      .rejects.toThrow(/source pob_login: Path of Building \(MCP\) is not logged in/);
    expect(chars.listCharacters).not.toHaveBeenCalled();
    expect(lua.loadBuildXml).not.toHaveBeenCalled();
    expect(lua.newBuild).not.toHaveBeenCalled();
  });

  it('public_profile never asks the window', async () => {
    const lua = makeLuaClient();
    const pobLogin = login(true);
    await handleImportCharacter(context(lua), { accountName: 'Acc#1', character: 'RfChar', source: 'public_profile' },
      { characterClient: publicClient(), pobLogin, env: {}, fileExists: async () => false });
    expect(pobLogin.status).not.toHaveBeenCalled();
    expect(pobLogin.character).not.toHaveBeenCalled();
  });

  it('the login path needs no account name', async () => {
    const lua = makeLuaClient();
    const out = text(await handleImportCharacter(context(lua), { character: 'RfChar', source: 'pob_login' },
      { pobLogin: login(true), env: {}, fileExists: async () => false }));
    expect(out).toMatch(/Imported RfChar/);
  });

  it('a failed download leaves the loaded build untouched', async () => {
    const lua = makeLuaClient();
    const pobLogin = login(true, { character: jest.fn(async () => { throw new Error('rate limited by pathofexile.com; retry in 30 s'); }) });
    await expect(handleImportCharacter(context(lua), { character: 'RfChar' },
      { pobLogin, env: {}, fileExists: async () => false })).rejects.toThrow(/rate limited/);
    expect(lua.loadBuildXml).not.toHaveBeenCalled();
    expect(lua.newBuild).not.toHaveBeenCalled();
    expect(lua.importCharacter).not.toHaveBeenCalled();
  });

  it('auto uses the public profile when account_name is given (someone else\'s character)', async () => {
    const lua = makeLuaClient();
    const chars = publicClient();
    const pobLogin = login(true);
    const out = text(await handleImportCharacter(context(lua), { accountName: 'Friend#1', character: 'RfChar' },
      { characterClient: chars, pobLogin, env: { POE_ACCOUNT_NAME: 'Me#1' }, fileExists: async () => false }));
    expect(pobLogin.character).not.toHaveBeenCalled();
    expect(chars.listCharacters).toHaveBeenCalledWith('Friend#1', 'pc');
    expect(out).toMatch(/account_name was given/);
  });

  it('auto with the account only in the env still uses the login', async () => {
    const pobLogin = login(true);
    await handleImportCharacter(context(makeLuaClient()), { character: 'RfChar' },
      { characterClient: publicClient(), pobLogin, env: { POE_ACCOUNT_NAME: 'Me#1' }, fileExists: async () => false });
    expect(pobLogin.character).toHaveBeenCalled();
  });

  it('auto falls back to the public profile when the login account has no such character', async () => {
    const lua = makeLuaClient();
    const chars = publicClient();
    const pobLogin = login(true, { character: jest.fn(async () => { throw Object.assign(new Error('no character'), { notFound: true }); }) });
    const out = text(await handleImportCharacter(context(lua), { character: 'RfChar' },
      { characterClient: chars, pobLogin, env: { POE_ACCOUNT_NAME: 'Me#1' }, fileExists: async () => false }));
    expect(chars.listCharacters).toHaveBeenCalled();
    expect(out).toMatch(/PoB's login found no "RfChar" on its account/);
  });

  it('pob_login does not fall back on a missing character', async () => {
    const chars = publicClient();
    const pobLogin = login(true, { character: jest.fn(async () => { throw Object.assign(new Error('no character'), { notFound: true }); }) });
    await expect(handleImportCharacter(context(makeLuaClient()), { character: 'RfChar', source: 'pob_login' },
      { characterClient: chars, pobLogin, env: { POE_ACCOUNT_NAME: 'Me#1' }, fileExists: async () => false })).rejects.toThrow(/no character/);
    expect(chars.listCharacters).not.toHaveBeenCalled();
  });

  it('says why the login was not used when the public profile then lacks an account', async () => {
    await expect(handleImportCharacter(context(makeLuaClient()), { character: 'RfChar' },
      { pobLogin: login(false), env: {}, fileExists: async () => false }))
      .rejects.toThrow(/account_name is required.*not logged in/);
  });

  it('treats an unconfigured window target as unavailable', async () => {
    const pobLogin = login(true, { status: jest.fn(async () => undefined) });
    const out = text(await handleImportCharacter(context(makeLuaClient()), { character: 'RfChar' },
      { characterClient: publicClient(), pobLogin, env: { POE_ACCOUNT_NAME: 'Me#1' }, fileExists: async () => false }));
    expect(out).toMatch(/window target is not configured/);
  });

  it('rejects an unknown source', async () => {
    await expect(handleImportCharacter(context(makeLuaClient()), { character: 'RfChar', source: 'nope' as any },
      { pobLogin: login(true), env: {}, fileExists: async () => false })).rejects.toThrow(/source must be auto, pob_login or public_profile/);
  });
});
