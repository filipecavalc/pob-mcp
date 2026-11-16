import { describe, it, expect } from '@jest/globals';
import {
  handleCraftItemBases, handleCraftItemCreate, handleCraftItemAffixes, handleCraftItemProperties,
  handleCraftItemAddModifier, handleCraftItemAddImplicit, handleCraftItemCorrupt, handleCraftItemEnchant,
  handleSearchItemDb, handleManageItemSet, handleListSharedItems, formatCraftedItem,
  type CraftedItem, type ItemCraftingContext,
} from '../../src/handlers/itemCraftingHandlers.js';

// The Items tab tools forward to one bridge entry point (itemsTabAction) and
// format what PoB's popups return. The Lua side is exercised live; these pin
// the parameter mapping, the follow-up paths and the formatting.

type Call = { action: string; params: Record<string, unknown> };

const ITEM: CraftedItem = {
  text: 'Rarity: RARE\nCrafted Crown\nHubris Circlet\nCrafted: true\nPrefix: {range:1}IncreasedLife9\nImplicits: 0\n{prefix}+144 to maximum Life',
  name: 'Crafted Crown, Hubris Circlet', title: 'Crafted Crown', baseName: 'Hubris Circlet', rarity: 'RARE',
  primarySlot: 'Helmet', quality: 20, levelRequirement: 69, corrupted: false, crafted: true, influences: ['Eater of Worlds'],
  implicits: [{ text: '15% increased Attack Damage', eater: true }],
  explicits: [{ text: '+144 to maximum Life', prefix: true }, { text: '+20 to Strength', crafted: true }],
  affixLimit: 2,
  prefixes: [{ modId: 'IncreasedLife9', affix: 'Fecund', range: 1 }],
  suffixes: [{ modId: 'None' }],
};

function fakeClient(responses: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const api = {
    itemsTabAction: async (action: string, params: Record<string, unknown>) => {
      calls.push({ action, params });
      const response = responses[action];
      if (response instanceof Error) throw response;
      return response;
    },
    ...extra,
  };
  const context = {
    ensureLuaClient: async () => {},
    getLuaClient: () => api,
  } as unknown as ItemCraftingContext;
  return { calls, context, api };
}

const textOf = (r: { content: Array<{ type: string; text: string }> }) => r.content.map((c) => c.text).join('\n');

describe('formatCraftedItem', () => {
  it('prints the parsed parts and PoB item text in a fenced block', () => {
    const text = formatCraftedItem(ITEM).join('\n');
    expect(text).toContain('Item: RARE "Crafted Crown" Hubris Circlet (slot Helmet, quality 20, level 69, Eater of Worlds)');
    expect(text).toContain('15% increased Attack Damage (eater)');
    expect(text).toContain('+20 to Strength (crafted)');
    expect(text).toContain('Prefix 1: Fecund [IncreasedLife9] roll 1');
    expect(text).toContain('Suffix 1: (empty)');
    expect(text).toContain('Item text:\n```\nRarity: RARE\nCrafted Crown');
  });
});

describe('craft_item_create', () => {
  it('maps base, rarity and name to PoB\'s Craft item popup', async () => {
    const { calls, context } = fakeClient({ item_craft_create: { item: ITEM, source: 'Craft item' } });
    const text = textOf(await handleCraftItemCreate(context, { base: 'Hubris Circlet', rarity: 'RARE', name: 'Crafted Crown' }));
    expect(calls).toEqual([{ action: 'item_craft_create', params: { base: 'Hubris Circlet', rarity: 'RARE', title: 'Crafted Crown' } }]);
    expect(text).toContain('=== Craft item ===');
    expect(text).toContain('Hubris Circlet');
  });

  it('uses Create custom when item_text is given, ignoring base', async () => {
    const { calls, context } = fakeClient({ item_craft_create: { item: ITEM } });
    const text = textOf(await handleCraftItemCreate(context, { base: 'ignored', item_text: 'Rarity: RARE\nX\nHubris Circlet' }));
    expect(calls[0].params).toEqual({ text: 'Rarity: RARE\nX\nHubris Circlet' });
    expect(text).toContain('=== Create custom item ===');
  });

  it('refuses a call with neither base nor item_text before reaching PoB', async () => {
    const { calls, context } = fakeClient({});
    await expect(handleCraftItemCreate(context, {})).rejects.toThrow(/base .*item_text/);
    expect(calls).toHaveLength(0);
  });

  it('simulates first, then equips through the existing add_item path', async () => {
    const order: string[] = [];
    const { context } = fakeClient({ item_craft_create: { item: ITEM } }, {
      calcWith: async (params: Record<string, unknown>) => {
        order.push(`calc ${params.repSlotName}`);
        expect(params.repItem).toBe(ITEM.text);
        return { base: { CombinedDPS: 100, Life: 5000 }, output: { CombinedDPS: 120, Life: 5100 } };
      },
      addItem: async (text: string, slot: string) => {
        order.push(`add ${slot}`);
        expect(text).toBe(ITEM.text);
        return { id: 18, name: 'Crafted Crown, Hubris Circlet', slot };
      },
    });
    const text = textOf(await handleCraftItemCreate(context, { base: 'Hubris Circlet', simulate_slot: 'Helmet', equip_slot: 'Helmet' }));
    expect(order).toEqual(['calc Helmet', 'add Helmet']);
    expect(text).toContain('=== Simulated: swap Helmet ===');
    expect(text).toContain('Added to the build and equipped: Crafted Crown, Hubris Circlet → Helmet (item id 18).');
  });
});

describe('craft_item_affixes', () => {
  it('passes changes through and reports applied tiers and the option list', async () => {
    const { calls, context } = fakeClient({
      item_craft_affixes: {
        item: ITEM,
        applied: [{ type: 'prefix', index: 1, modId: 'IncreasedLife9', affix: 'Fecund', lines: ['+(130-144) to maximum Life'], range: 1, tier: 1 }],
        listed: { type: 'suffix', index: 1, selected: 1 },
        sortBy: 'Full DPS',
        matched: 1,
        options: [{ index: 4, label: '+#% to Fire Resistance', tiers: [{ tier: 1, modId: 'FireResist8', affix: 'of Tzteosh', level: 82, lines: ['+(46-48)% to Fire Resistance'] }] }],
      },
    });
    const text = textOf(await handleCraftItemAffixes(context, {
      item_text: ITEM.text, changes: [{ type: 'prefix', modifier: 'maximum Life', tier: 1, roll: 1 }], list: 'suffix', sort_by: 'FullDPS',
    }));
    expect(calls[0].params).toEqual({
      text: ITEM.text, changes: [{ type: 'prefix', modifier: 'maximum Life', tier: 1, roll: 1 }], list: 'suffix', sortBy: 'FullDPS',
    });
    expect(text).toContain('prefix 1: Fecund [IncreasedLife9] T1 roll 1');
    expect(text).toContain('Options for suffix 1 (sorted by Full DPS)');
    expect(text).toContain('T1 of Tzteosh L82 [FireResist8]: +(46-48)% to Fire Resistance');
  });

  it('only lists (no simulation) when there are no changes', async () => {
    const { context } = fakeClient({ item_craft_affixes: { item: ITEM, applied: [], options: [], listed: { type: 'prefix', index: 1, selected: 1 } } },
      { calcWith: async () => { throw new Error('must not simulate a listing'); } });
    const text = textOf(await handleCraftItemAffixes(context, { item_text: ITEM.text, list: 'prefix', simulate_slot: 'Helmet' }));
    expect(text).not.toContain('Simulated');
  });
});

describe('craft_item_add_modifier and friends', () => {
  it('lists a source\'s options without crafting or equipping', async () => {
    const { calls, context } = fakeClient({
      item_add_modifier: {
        sources: [{ label: 'Crafting Bench', id: 'MASTER' }, { label: 'Custom', id: 'CUSTOM' }],
        source: 'MASTER', sortBy: 'Life', matched: 3,
        options: [{ index: 1, label: '+(41-45) to maximum Life/Regenerate 4 Mana per second (Prefix)', type: 'Prefix', affix: 'Upgraded', level: 81, sortValue: 5628 },
          { index: 2, id: 'IncreasedLifeEssence1', label: 'Deafening Essence of Greed', type: 'Prefix' }],
      },
    }, { addItem: async () => { throw new Error('must not equip a listing'); } });
    const text = textOf(await handleCraftItemAddModifier(context, { item_text: ITEM.text, source: 'MASTER', sort_by: 'Life', limit: 1, equip_slot: 'Helmet' }));
    expect(calls[0].params).toEqual({ text: ITEM.text, source: 'MASTER', sortBy: 'Life', limit: 1 });
    expect(text).toContain('Sources: Crafting Bench (MASTER), Custom (CUSTOM)');
    expect(text).toContain('1. +(41-45) to maximum Life/Regenerate 4 Mana per second (Prefix) ("Upgraded", L81, sort value 5,628)');
    expect(text).toContain('2. Deafening Essence of Greed [IncreasedLifeEssence1] (Prefix)');
    expect(text).toContain('a bare index is refused');
    expect(text).toContain('... 1 more');
    expect(text).toContain('Nothing was crafted');
  });

  it('maps implicit group and modifier', async () => {
    const { calls, context } = fakeClient({ item_add_implicit: { item: ITEM, source: 'EATER', group: '#% increased Attack Damage',
      addedLabel: '15% increased Attack Damage', addedId: 'EaterAttackDamage1' } });
    const text = textOf(await handleCraftItemAddImplicit(context, { item_text: ITEM.text, source: 'EATER', group: '1:#% increased Attack Damage', modifier: 'EaterAttackDamage1' }));
    expect(calls[0].params).toEqual({ text: ITEM.text, source: 'EATER', group: '1:#% increased Attack Damage', modifier: 'EaterAttackDamage1' });
    expect(text).toContain('Chosen: #% increased Attack Damage → 15% increased Attack Damage [EaterAttackDamage1]');
  });

  it('shows the implicit types when no group is given', async () => {
    const { context } = fakeClient({ item_add_implicit: { sources: [{ label: 'Eater of Worlds', id: 'EATER' }], source: 'EATER', matched: 24,
      groups: [{ index: 1, label: '#% increased Attack Damage', modifierCount: 15 }] } });
    const text = textOf(await handleCraftItemAddImplicit(context, { item_text: ITEM.text }));
    expect(text).toContain('1. #% increased Attack Damage (15 modifiers)');
    expect(text).toContain('pass group');
  });

  it('maps corruption implicits, rolls and list', async () => {
    const { calls, context } = fakeClient({ item_corrupt: { source: 'Corrupted', sources: ['Corrupted', 'Scourge'],
      implicitSlots: [{ slot: 1, kind: 'implicit', matched: 1, options: [{ index: 6, label: '(4-6)% increased maximum Life', type: 'Corrupted', level: 1 }] }],
      rollLines: [{ index: 1, line: '+1000 to maximum Life' }] } });
    const text = textOf(await handleCraftItemCorrupt(context, { item_text: ITEM.text, list: true, search: 'life' }));
    expect(calls[0].params).toEqual({ text: ITEM.text, list: true, search: 'life' });
    expect(text).toContain('Implicit #1 (implicit) — implicits[0]');
    expect(text).toContain('6. (4-6)% increased maximum Life (Corrupted, L1)');
    expect(text).toContain('1. +1000 to maximum Life');
  });

  it('maps enchant arguments', async () => {
    const { calls, context } = fakeClient({ item_enchant: { item: ITEM, slot: 1 } });
    await handleCraftItemEnchant(context, { item_text: ITEM.text, skill: 'Righteous Fire', all_skills: true, enchantment: '1:40% increased Righteous Fire Damage' });
    expect(calls[0].params).toEqual({ text: ITEM.text, skill: 'Righteous Fire', allSkills: true, enchantment: '1:40% increased Righteous Fire Damage' });
  });

  it('maps property changes and lists what can be set', async () => {
    const { calls, context } = fakeClient({ item_craft_properties: { item: ITEM, influenceOptions: ['Influence', 'Shaper', 'Elder'],
      applied: { influences: ['Shaper'], removed: ['+20 to Strength'] },
      rangeLines: [{ index: 1, line: '+(15-25) to maximum Life', roll: 0.5 }], removableModifiers: [{ index: 1, line: '+20 to Strength', kind: 'crafted' }] } });
    const text = textOf(await handleCraftItemProperties(context, { item_text: ITEM.text, influences: ['Shaper'], catalyst_quality: 20, remove_modifiers: ['1:+20 to Strength'] }));
    expect(calls[0].params).toEqual({ text: ITEM.text, influences: ['Shaper'], catalystQuality: 20, removeModifiers: ['1:+20 to Strength'] });
    expect(text).toContain('Chosen: influences: Shaper; removed: +20 to Strength');
    expect(text).toContain('Influences PoB offers: Shaper, Elder');
    expect(text).toContain('1. +(15-25) to maximum Life (roll 0.5)');
    expect(text).toContain('1. +20 to Strength (crafted)');
  });

  it('surfaces PoB-side refusals as handler errors', async () => {
    const { context } = fakeClient({ item_add_modifier: new Error('PoB offers "Add modifier..." only for magic and rare items') });
    await expect(handleCraftItemAddModifier(context, { item_text: ITEM.text })).rejects.toThrow(/Failed to add modifier: PoB offers/);
  });
});

describe('item databases, item sets and shared items', () => {
  it('lists bases and base types', async () => {
    const { calls, context } = fakeClient({ item_craft_bases: { types: [{ name: 'Ring', count: 20 }] } });
    expect(textOf(await handleCraftItemBases(context, {}))).toContain('Ring (20)');
    expect(calls[0].params).toEqual({});
  });

  it('maps database filters to ItemDBControl\'s and shows the item text', async () => {
    const { calls, context } = fakeClient({ search_item_db: { db: 'unique', matched: 1, offset: 0,
      items: [{ name: "Kaom's Heart, Glorious Plate", primarySlot: 'Body Armour', levelRequirement: 68, variants: ['Pre 1.0.0', 'Current'], text: "Kaom's Heart\nGlorious Plate" }] } });
    const text = textOf(await handleSearchItemDb(context, { name: "Kaom's Heart", item_type: 'Armour', search_mode: 'Names', sort_by: 'Life', include_text: true }));
    expect(calls[0].params).toEqual({ name: "Kaom's Heart", type: 'Armour', searchMode: 'Names', sortBy: 'Life', includeText: true });
    expect(text).toContain("1. Kaom's Heart, Glorious Plate (Body Armour, L68)");
    expect(text).toContain('Variants: 1 Pre 1.0.0; 2 Current');
    expect(text).toContain("   Kaom's Heart");
  });

  it('refuses to delete an item set without confirm', async () => {
    const { calls, context } = fakeClient({});
    await expect(handleManageItemSet(context, { action: 'delete', id: 2 })).rejects.toThrow(/confirm: true/);
    expect(calls).toHaveLength(0);
  });

  it('reports item set changes with the resulting list', async () => {
    const { calls, context } = fakeClient({ item_set_manage: { action: 'copy', id: 3, activeItemSetId: 1,
      itemSets: [{ id: 1, title: 'Main', active: true, useSecondWeaponSet: false }, { id: 3, title: 'Copy', active: false, useSecondWeaponSet: false }] } });
    const text = textOf(await handleManageItemSet(context, { action: 'copy', id: 1, title: 'Copy' }));
    expect(calls[0].params).toEqual({ action: 'copy', id: 1, title: 'Copy' });
    expect(text).toContain('Copied to item set 3.');
    expect(text).toContain('1. Main (active)');
  });

  it('explains an empty shared list', async () => {
    const { context } = fakeClient({ list_shared_items: { items: [], itemSets: [] } });
    expect(textOf(await handleListSharedItems(context, {}))).toMatch(/headless engine reads no user settings/);
  });

  it('lists shared items and sets', async () => {
    const { context } = fakeClient({ list_shared_items: { items: [{ index: 1, name: 'Tabula Rasa, Simple Robe', rarity: 'UNIQUE' }],
      itemSets: [{ index: 1, title: 'Swap', slots: { Helmet: 'Goldrim, Leather Cap' } }] } });
    const text = textOf(await handleListSharedItems(context, {}));
    expect(text).toContain('1. Tabula Rasa, Simple Robe (UNIQUE)');
    expect(text).toContain('Helmet: Goldrim, Leather Cap');
  });

  it('fails clearly without a Lua bridge', async () => {
    const context = { ensureLuaClient: async () => {}, getLuaClient: () => null } as unknown as ItemCraftingContext;
    await expect(handleCraftItemBases(context, {})).rejects.toThrow(/Lua bridge not active/);
  });
});

describe('chosen option echo', () => {
  it('names the corruption implicits PoB applied', async () => {
    const { context } = fakeClient({ item_corrupt: { item: { ...ITEM, corrupted: true }, source: 'Corrupted',
      chosen: ['(4-6)% increased maximum Life', 'Regenerate (1.6-2)% of Life per second'] } });
    const text = textOf(await handleCraftItemCorrupt(context, { item_text: ITEM.text, implicits: ['increased maximum Life', 'V2LifeRegenCorrupted'] }));
    expect(text).toContain('Chosen: (4-6)% increased maximum Life; Regenerate (1.6-2)% of Life per second');
  });

  it('passes a stale index:label pair through so PoB can refuse it', async () => {
    const { context } = fakeClient({ item_add_modifier: new Error('modifier 2 is "+(26-40) to maximum Life (Prefix)" now, not "+(15-25) to maximum Life (Prefix)"; list the options again') });
    await expect(handleCraftItemAddModifier(context, { item_text: ITEM.text, source: 'MASTER', modifier: '2:+(15-25) to maximum Life (Prefix)' }))
      .rejects.toThrow(/list the options again/);
  });
});
