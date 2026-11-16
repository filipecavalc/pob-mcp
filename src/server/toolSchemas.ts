/**
 * Tool Schemas
 *
 * Defines all MCP tool schemas for the PoB server.
 * These schemas describe the available tools, their parameters, and documentation.
 */

/**
 * One MCP tool advertisement. `inputSchema.properties` values are JSON Schema
 * objects (arbitrary nesting — some properties carry `properties`,
 * `additionalProperties`, or no `type` at all); the values reach the MCP SDK
 * unchanged, so this is the wire contract, not a local invention.
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, Record<string, unknown>> & { type?: string };
    required?: string[];
  };
  /**
   * Server-side policy flag: large text responses from this tool are
   * truncated to keep token use bounded. Declared per tool next to its
   * definition (the previous hand-maintained name list in index.ts rotted -
   * five unbounded-output tools had silently fallen outside it). Never sent
   * over the wire; stripped in ListTools.
   */
  truncatable?: boolean;
}

/**
 * Get all tool schemas for registration with the MCP server
 */
export function getToolSchemas(): ToolSchema[] {
  return [
    {
      name: "analyze_build",
      truncatable: true,
      description: "Analyze a Path of Building build file and extract detailed information including stats, skills, gear, passive skill tree analysis with keystones, notables, jewel sockets, build archetype detection, and optimization suggestions",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Name of the build file (e.g., 'MyBuild.xml')",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "compare_builds",
      description: "Compare two Path of Building builds side by side",
      inputSchema: {
        type: "object",
        properties: {
          build1: {
            type: "string",
            description: "First build file name",
          },
          build2: {
            type: "string",
            description: "Second build file name",
          },
        },
        required: ["build1", "build2"],
      },
    },
    {
      name: "list_builds",
      description: "List all available Path of Building builds",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_build_stats",
      description: "Extract specific stats from a build (Life, DPS, resistances, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Name of the build file",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "start_watching",
      description: "Start monitoring the builds directory for changes. Builds will be auto-reloaded when saved in PoB.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "stop_watching",
      description: "Stop monitoring the builds directory for changes.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_recent_changes",
      description: "Get a list of recently changed build files.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of recent changes to return (default: 10)",
          },
        },
      },
    },
    {
      name: "watch_status",
      description: "Check if file watching is currently enabled.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "refresh_tree_data",
      description: "Force refresh the passive skill tree data cache. Use this if tree data seems outdated.",
      inputSchema: {
        type: "object",
        properties: {
          version: {
            type: "string",
            description: "Specific tree version to refresh (optional, defaults to all versions)",
          },
        },
      },
    },
    {
      name: "compare_trees",
      description: "Compare passive skill trees between two builds, showing differences in allocated nodes",
      inputSchema: {
        type: "object",
        properties: {
          build1: {
            type: "string",
            description: "First build file name",
          },
          build2: {
            type: "string",
            description: "Second build file name",
          },
        },
        required: ["build1", "build2"],
      },
    },
    {
      name: "get_nearby_nodes",
      description: "Find notable and keystone passives near your current tree allocation. Uses loaded Lua bridge build when no build_name is provided.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build file to analyze (optional if a build is loaded via lua_load_build)",
          },
          max_distance: {
            type: "number",
            description: "Maximum path distance to search (default: 5)",
          },
          filter: {
            type: "string",
            description: "Optional text filter for node names/stats",
          },
        },
      },
    },
    {
      name: "find_path_to_node",
      description: "Find the shortest path from your current tree to a specific passive node. Uses loaded Lua bridge build when no build_name is provided.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze (optional if a build is loaded via lua_load_build)",
          },
          target_node_id: {
            type: "string",
            description: "ID of the target passive node",
          },
        },
        required: ["target_node_id"],
      },
    },
    {
      name: "get_build_notes",
      description: "Read the notes/documentation from a PoB build file",
      inputSchema: {
        type: "object",
        properties: {
          build_name: { type: "string", description: "Name of the build file (e.g., 'MyBuild.xml')" },
        },
        required: ["build_name"],
      },
    },
    {
      name: "set_build_notes",
      description: "Write notes/documentation into a PoB build file (overwrites existing notes)",
      inputSchema: {
        type: "object",
        properties: {
          build_name: { type: "string", description: "Name of the build file" },
          notes: { type: "string", description: "Notes content to write (plain text or markdown)" },
        },
        required: ["build_name", "notes"],
      },
    },
    {
      name: "classify_item_affixes",
      description: "Resolve an item's explicit mod lines back to the affixes that produced them, using Path of Building's ModExplicit (legacy ModItem) and ModMaster tables. Reports matched prefix and suffix counts, remaining slots when the classification is complete and unambiguous, affix ranges and minimum item levels, and which lines belong to one hybrid affix. USE THIS BEFORE recommending any craft or reroll: one affix can print several lines, and counting those lines separately inverts the answer (a hybrid energy shield prefix also prints stun recovery, which reads like a suffix). LIMITS: explicit mods only. Unmatched lines may be unrecognized explicit affixes that still occupy slots. Remaining slots are reported as unknown when any lines are unmatched or ambiguous. An item whose lines admit more than one reading is flagged as ambiguous rather than guessed. Slot counts assume a rare, which holds three prefixes and three suffixes; a magic item holds one of each.",
      inputSchema: {
        type: "object",
        properties: {
          mod_lines: {
            type: "array",
            items: { type: "string" },
            description: "The item's mod lines, one per entry, exactly as printed (e.g. '+42 to maximum Life'). PoB tags such as {crafted} are stripped automatically.",
          },
        },
        required: ["mod_lines"],
      },
    },
    {
      name: "list_craftable_mods",
      description: "List the crafting bench mods an item class can take at a given item level, from Path of Building's ModMaster table. Use it to answer 'what can I put in the open suffix', and to say what a higher item level would unlock. A craft occupies a slot of its own type, so check the type of the affix being replaced, not only the one being added. LIMITS: bench crafts only, no essences, fossils or veiled mods, and no metacrafting. It does not know what the item already has, so pair it with classify_item_affixes.",
      inputSchema: {
        type: "object",
        properties: {
          item_class: {
            type: "string",
            description: "Item class as PoB names it: 'Body Armour', 'Helmet', 'Gloves', 'Boots', 'Shield', 'Ring', 'Amulet', 'Belt', 'Quiver', 'Wand', 'Bow', 'Staff', 'Sceptre', 'Dagger', 'Claw', 'One Handed Sword', and so on. A wrong value returns the full list of known classes.",
          },
          item_level: {
            type: "number",
            description: "The item's item level. Crafts requiring a higher level are reported separately rather than hidden.",
          },
          affix_type: {
            type: "string",
            enum: ["Prefix", "Suffix"],
            description: "Restrict to the slot type you actually have open.",
          },
          search: {
            type: "string",
            description: "Optional wording, affix name, group or mod tag filter (e.g. 'Cold Resistance', 'life').",
          },
        },
        required: ["item_class", "item_level"],
      },
    },
    {
      name: "find_affix_tiers",
      description: "Look up every tier of a rollable affix in Path of Building's ModExplicit table (ModItem on older installs): prefix or suffix, minimum item level, the value range per entry, and the base tags it can roll on. Displays affix names and item levels without inventing T1/T2 labels from filtered result order. Use it to price an affix before pricing an item, since a top-tier rare suffix often replaces a costly unique built around the same stat. LIMITS: slot filtering uses PoB's base tags, not slot names. Body armour bases carry str_armour / dex_armour / int_armour and their hybrids; influenced variants add a suffix like _elder or _shaper; a plain 'armour' tag exists too and does not cover the attribute-specific ones. Pass several tags when unsure. Mods whose spawn weights are all zero are excluded unless include_unobtainable is set.",
      inputSchema: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Stat wording, affix name, group or mod tag (e.g. 'Chaos Resistance', 'of Bameth', 'ChaosResistance').",
          },
          affix_type: {
            type: "string",
            enum: ["Prefix", "Suffix"],
            description: "Restrict to prefixes or suffixes.",
          },
          slot_tags: {
            type: "array",
            items: { type: "string" },
            description: "PoB base tags the mod must be able to roll on, matched exactly, any one of them. Examples: 'ring', 'amulet', 'belt', 'int_armour', 'body_armour', 'bow'.",
          },
          max_item_level: {
            type: "number",
            description: "Drop tiers the item level cannot reach.",
          },
          include_unobtainable: {
            type: "boolean",
            description: "Include mods with no non-zero spawn weight. They exist in the data but nothing can roll them. Default false.",
            default: false,
          },
          max_results: {
            type: "number",
            description: "Maximum affix groups to return (default 10).",
            default: 10,
          },
        },
        required: ["search"],
      },
    },
  ];
}

/**
 * Get Lua-specific tool schemas (only included if Lua is enabled)
 */
export function getLuaToolSchemas(): ToolSchema[] {
  return [
    {
      name: "lua_get_capabilities",
      description: "Report the active PoB bridge mode, adapter version, and supported actions.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "lua_get_build_snapshot",
      description: "Get a compact, current-state summary after loading or editing a build: metadata, core live stats, passive-node count, equipped items, and main skill gems. Use detailed tools only when you need the underlying data.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "lua_start",
      description: "Start the PoB headless API process. This will spawn the LuaJIT process that can load builds and compute stats using the actual PoB calculation engine.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "lua_stop",
      description: "Stop the PoB headless API process and clean up resources.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "lua_new_build",
      description: "Create a new blank build with specified class and ascendancy. Auto-starts the Lua bridge if needed (no need to call lua_start first). Classes and ascendancies (PoE1): Scion: Ascendant | Marauder: Juggernaut, Berserker, Chieftain | Ranger: Raider, Deadeye, Pathfinder | Witch: Occultist, Elementalist, Necromancer | Duelist: Slayer, Gladiator, Champion | Templar: Inquisitor, Hierophant, Guardian | Shadow: Assassin, Trickster, Saboteur",
      inputSchema: {
        type: "object",
        properties: {
          class_name: { type: "string", description: "Class name (e.g., 'Witch', 'Marauder')" },
          ascendancy: { type: "string", description: "Ascendancy class name (optional)" },
        },
        required: ["class_name"],
      },
    },
    {
      name: "lua_save_build",
      description: "Save the currently loaded in-memory Lua bridge build atomically. Saving back to its source file is allowed; replacing another existing file requires overwrite=true. Required before using file-based tools (validate_build, analyze_build, etc.) on an in-memory build.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Output filename (e.g., 'MyBuild.xml'). .xml extension added automatically if missing.",
          },
          overwrite: {
            type: "boolean",
            description: "Explicitly allow replacing a different existing build file (default: false).",
            default: false,
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "pob_show",
      description: "Show text to the user inside the Path of Building desktop window, in its MCP tab (next to Compare in the sidebar): an upgrade table, a comparison, notes. Works whichever engine runs the other tools, when POB_GUI_PATH is configured and the window with the MCP server is running. Replaces the previous panel. PoB colour codes work: ^7 white, ^8 grey, ^1 red, ^2 green, ^3 blue, ^4 yellow, ^xRRGGBB any colour; lines are plain text, one per newline, so align columns with spaces. Prefer ASCII: PoB's font may not draw accented or other non-ASCII characters.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Panel title (default: MCP)." },
          text: { type: "string", description: "Panel body; newlines separate lines; PoB colour codes allowed. Max 64 KB and 1000 lines." },
          focus: { type: "boolean", description: "Open the MCP tab in the window (default true).", default: true },
        },
        required: ["text"],
      },
    },
    {
      name: "pob_target",
      description: "Show or choose which Path of Building engine runs the lua_* and build tools: the Path of Building desktop window (the build the user sees, when POB_GUI_PATH is configured and the window with the MCP server is running) or the headless engine. Without target, reports the engine in use, whether the window is reachable, the build open in it and whether it has unsaved changes. With target, switches engines; the new engine has its own build, so open or load one afterwards. The engine never switches by itself mid-session: if the window stops answering (minimised windows do not process), tool calls fail with an explanation instead.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["auto", "gui", "headless"],
            description: "auto: the window if it answers, else headless. gui: the window only. headless: the background engine only.",
          },
        },
      },
    },
    {
      name: "import_character",
      description: "Pull a character's current tree, items and gems from pathofexile.com (through the Path of Building (MCP) window's Path of Exile login when available, see source; otherwise the public profile, which needs the account's Characters tab public) and import them with PoB's own importer, the same code as the desktop app's 'Import from website'. Imports on top of base_build (or save_as when that file exists) so its config and skill settings are kept; the resistance penalty, which PoB's importer re-estimates, is kept from the base, and so are bandit and pantheon with the public profile (it does not carry them; the login does). Like the desktop import, replaced gear is removed from every item set of the base, and only the active spec, item set and config set receive the import. Everything is fetched before the loaded build is touched, and a failed import reloads the base. Reports gear and stat changes against the base and saves to save_as. Defaults come from POE_ACCOUNT_NAME, POE_CHARACTER and POB_CHARACTER_BUILD. pathofexile.com refreshes items only when the character changes zone or logs out.",
      inputSchema: {
        type: "object",
        properties: {
          account_name: {
            type: "string",
            description: "pathofexile.com account name with its discriminator, e.g. 'Name#1234'. Defaults to POE_ACCOUNT_NAME.",
          },
          character: {
            type: "string",
            description: "Character name. Defaults to POE_CHARACTER. With the public profile, when neither is set the error lists the account's characters; with the login the name must match exactly.",
          },
          realm: {
            type: "string",
            enum: ["pc", "xbox", "sony"],
            description: "Realm (default: pc).",
          },
          source: {
            type: "string",
            enum: ["auto", "pob_login", "public_profile"],
            description: "Where the character comes from. pob_login: the Path of Exile login held by the Path of Building (MCP) window (official API, as PoB's 'Import From Your Account'; also brings bandit and pantheon; account_name not needed). public_profile: pathofexile.com's public profile, no login. auto (default): pob_login when that window runs and is logged in, otherwise public_profile; the report says which was used and why.",
          },
          base_build: {
            type: "string",
            description: "Build file to import on top of. Defaults to save_as when that file exists; otherwise a new build.",
          },
          save_as: {
            type: "string",
            description: "Build file to save the result to (.xml added if missing). Defaults to POB_CHARACTER_BUILD; not saved when neither is set.",
          },
          overwrite: {
            type: "boolean",
            description: "Allow replacing save_as when it is not the base build (default: false).",
            default: false,
          },
          main_skill: {
            type: "string",
            description: "Active gem to make the main skill (e.g. 'Righteous Fire'). Defaults to the base build's main skill.",
          },
          ignore_weapon_swap: {
            type: "boolean",
            description: "Skip weapon-swap items and their gems (default: false).",
            default: false,
          },
        },
      },
    },
    {
      name: "lua_load_build",
      description: "Load a build file into the PoB calculation engine. Required before using other lua_* tools. AUTO-RETURNS a brief summary (life, DPS, EHP, resistances, top issues) — do NOT immediately follow with lua_get_stats or get_build_issues just to get basic numbers. Call additional tools only when you need details beyond the summary.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Name of the build file to load. Exactly one of build_name or build_xml must be provided.",
          },
          build_xml: {
            type: "string",
            description: "Raw PoB build XML to load directly instead of reading a file. Exactly one of build_name or build_xml must be provided.",
          },
          name: {
            type: "string",
            description: "Display name for the loaded build (optional; defaults to the build filename when build_name is used)",
          },
        },
      },
    },
    {
      name: "lua_import_code",
      description: "Import a PoB build/passive-tree export code (the string generated by PoB's 'Generate' button or a pobb.in-style share code — URL-safe base64 + zlib deflate) directly into the PoB calculation engine. AUTO-RETURNS a brief summary (life, DPS, EHP, resistances, top issues), same as lua_load_build. Follow up with lua_save_build to persist it to a file. For links (pobb.in, poe.ninja, Maxroll, ...) use import_build_link.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The PoB import/export code to decode and load.",
          },
          name: {
            type: "string",
            description: "Display name for the imported build (optional; defaults to 'Imported Build').",
          },
        },
        required: ["code"],
      },
    },
    {
      name: "list_specs",
      description: "List all passive tree specs in the currently loaded build. Each spec can have a different tree allocation, class, and ascendancy.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "select_spec",
      description: "Switch the active passive tree spec in the currently loaded build. Recalculates all stats with the selected spec.",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Spec index (1-based, use list_specs to see available specs)" },
        },
        required: ["index"],
      },
    },
    {
      name: "create_spec",
      description: "Create a new passive tree spec in the currently loaded build, optionally copying an existing spec. Requires Lua bridge with a loaded build.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title for the new spec (optional)" },
          copyFrom: { type: "number", description: "Spec index (1-based) to copy the tree allocation from (optional, use list_specs to see available specs)" },
          activate: { type: "boolean", description: "Make the new spec active immediately (default: false)" },
        },
      },
    },
    {
      name: "delete_spec",
      description: "Delete a passive tree spec from the currently loaded build. Requires Lua bridge with a loaded build.",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Spec index to delete (1-based, use list_specs to see available specs)" },
        },
        required: ["index"],
      },
    },
    {
      name: "rename_spec",
      description: "Rename a passive tree spec in the currently loaded build. Requires Lua bridge with a loaded build.",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Spec index to rename (1-based, use list_specs to see available specs)" },
          title: { type: "string", description: "New title for the spec" },
        },
        required: ["index", "title"],
      },
    },
    {
      name: "list_item_sets",
      description: "List all item sets in the currently loaded build. Each item set can have different gear equipped.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "select_item_set",
      description: "Switch the active item set in the currently loaded build. Recalculates all stats with the selected item set.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Item set ID (use list_item_sets to see available item sets)" },
        },
        required: ["id"],
      },
    },
    {
      name: "set_character_level",
      description: "Set the character level for the currently loaded build. Recalculates all stats.",
      inputSchema: {
        type: "object",
        properties: {
          level: {
            type: "number",
            description: "Character level (1-100)",
          },
        },
        required: ["level"],
      },
    },
    {
      name: "lua_simulate",
      description: "Answer a 'what if' about the loaded build without changing it: swap an item into a slot, toggle a flask, allocate or unallocate passives, or pick mastery effects, and get the resulting stats with the delta against the current build. This is the tool to reach for before recommending any gear or tree change, because it costs nothing to undo — nothing is written, nothing is saved, and the build the player has open is untouched. It also reports when the simulated gear would leave an attribute requirement unmet, which PoB itself will happily quote full DPS for even though the game would disable the item. What it does NOT do: it does not equip, buy, price or persist anything (use add_item for a real change); it does not check socket colours, links, item level or affix legality, so it will price a physically impossible item as if it existed; and it simulates one change at a time against the current build, not a sequence.",
      inputSchema: {
        type: "object",
        properties: {
          itemText: { type: "string", description: "Full PoB item text to try in slotName. Requires slotName. The item is parsed and calculated, never equipped." },
          slotName: { type: "string", description: "Equipment slot the item replaces, exactly as PoB names it: 'Body Armour', 'Weapon 1', 'Ring 1', 'Amulet'. A base type such as 'Chest' or 'Ring' is rejected. Use get_equipped_items for the slot names of this build." },
          toggleFlask: { type: "number", description: "Flask slot 1-5 to FLIP: an active flask is simulated off, an inactive one on. The slot must hold a flask." },
          addNodes: { type: "array", items: { type: "number" }, description: "Passive node IDs to allocate for this calculation." },
          removeNodes: { type: "array", items: { type: "number" }, description: "Passive node IDs to unallocate for this calculation." },
          masteryEffects: { type: "object", description: "Mastery effect choices as { nodeId: effectId } (see suggest_masteries)." },
          useFullDPS: { type: "boolean", description: "Total the DPS of every enabled skill instead of the main one." },
          assumeMaxQuality: { type: "boolean", description: "Value itemText at 20% quality, as PoB's paste box does for gear without a Unique ID (in-game copies have none). Default false: the item keeps the quality its text states, none stated meaning 0, so a trade listing is valued as sold." },
        },
      },
    },
    {
      name: "lua_get_ailments",
      description: "Show non-damaging ailments (Shock, Chill, Scorch, Brittle, Sap) with what the DPS calculation is actually crediting next to what the main skill would inflict on the configured enemy. Call this for any build that shocks or chills: PoB applies a chance-based ailment only when its magnitude is entered by hand, so an uncounted shock silently understates every DPS figure. Magnitude is measured for the MAIN skill against the CURRENT enemy config, and it falls off steeply with enemy life, so re-read it per enemy rather than quoting one number for all content.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "lua_get_stats",
      truncatable: true,
      description: "Get comprehensive calculated stats from the currently loaded build (requires lua_load_build first). Use category='offense' for DPS details, category='defense' for survivability, category='all' only when you need everything at once. Avoid calling multiple times with different categories — pick the right one.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Stat category: 'offense', 'defense', 'all' (default: all)",
          },
        },
      },
    },
    {
      name: "lua_get_tree",
      truncatable: true,
      description: "Get passive tree allocation from currently loaded build",
      inputSchema: {
        type: "object",
        properties: {
          include_node_ids: {
            type: "boolean",
            description: "Include the full list of allocated node IDs in the response (default: false). Omit unless you need to pass node IDs to another tool.",
          },
        },
      },
    },
    {
      name: "lua_set_tree",
      description: "Set passive tree allocation (modifies currently loaded build). IMPORTANT: (1) All nodes must form a connected path from the class start node — any node not reachable through other allocated nodes back to the start will be silently dropped. Use find_path_to_node first to discover the intermediate travel nodes needed to reach your target. (2) Maximum 8 ascendancy points — do not allocate more than 8 ascendancy nodes (excluding the ascendancy start node).",
      inputSchema: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Array of node IDs to allocate",
          },
          classId: {
            type: "number",
            description: "Class ID (0=Scion, 1=Marauder, 2=Ranger, 3=Witch, 4=Duelist, 5=Templar, 6=Shadow). If omitted, preserves current class.",
          },
          ascendClassId: {
            type: "number",
            description: "Ascendancy class ID (0=None, 1-3 class-specific). Scion: 1=Ascendant | Marauder: 1=Juggernaut, 2=Berserker, 3=Chieftain | Ranger: 1=Raider, 2=Deadeye, 3=Pathfinder | Witch: 1=Occultist, 2=Elementalist, 3=Necromancer | Duelist: 1=Slayer, 2=Gladiator, 3=Champion | Templar: 1=Inquisitor, 2=Hierophant, 3=Guardian | Shadow: 1=Assassin, 2=Trickster, 3=Saboteur",
          },
          masteryEffects: {
            type: "object",
            description: "Map of mastery node ID -> chosen effect ID (from get_mastery_options). A Mastery node with no effect selection is silently dropped by the tree import, so provide one entry per mastery node you want allocated. Existing mastery selections already on the build are preserved automatically and only need to be listed here if you want to change them.",
            additionalProperties: { type: "number" },
          },
        },
        required: ["nodes"],
      },
    },
    {
      name: "update_tree_delta",
      description: "Incrementally add or remove specific passive nodes from the current tree allocation. Automatically finds and includes intermediate path nodes when adding nodes that aren't directly adjacent to the current tree. Safer than lua_set_tree because you only specify the nodes to change, not the entire tree. Note: max 8 ascendancy points allowed.",
      inputSchema: {
        type: "object",
        properties: {
          add_nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node IDs to add to the current allocation",
          },
          remove_nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node IDs to remove from the current allocation",
          },
          mastery_effects: {
            type: "object",
            additionalProperties: { type: "number" },
            description: "Effect to select for each Mastery node being added, as {\"<nodeId>\": <effectId>}. Required to allocate a Mastery: Path of Building refuses to allocate a Mastery node that has no effect chosen. Use suggest_masteries or search_tree_nodes to find effect IDs.",
          },
        },
      },
    },
    {
      name: "lua_get_build_info",
      description: "Get metadata about the currently loaded build: name, character level, class, ascendancy, and tree version. Useful to confirm which build is active after lua_load_build or lua_new_build. Classes and ascendancies (PoE1): Scion: Ascendant | Marauder: Juggernaut, Berserker, Chieftain | Ranger: Raider, Deadeye, Pathfinder | Witch: Occultist, Elementalist, Necromancer | Duelist: Slayer, Gladiator, Champion | Templar: Inquisitor, Hierophant, Guardian | Shadow: Assassin, Trickster, Saboteur",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "lua_reload_build",
      description: "Reload the current build from disk, picking up any changes made in PoB GUI or via direct XML editing. If build_name is omitted, reloads the build that is currently loaded (determined via lua_get_build_info).",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Name of the build file to reload (e.g., 'MyBuild.xml'). If omitted, reloads the currently loaded build.",
          },
        },
      },
    },
    {
      name: "search_tree_nodes",
      description: "Search passive tree for nodes matching specific criteria",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for node names or stats",
          },
          node_type: {
            type: "string",
            description: "Filter by type: 'keystone', 'notable', 'jewel', or 'any' (default)",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default: 20)",
          },
          include_allocated: {
            type: "boolean",
            description: "Include nodes that are already allocated in the results (default: false)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "add_item",
      description: "Add an item to the build from item text (paste from game)",
      inputSchema: {
        type: "object",
        properties: {
          item_text: {
            type: "string",
            description: "Full item text from clipboard",
          },
          slot_name: {
            type: "string",
            description: "Slot to equip in, using PoB's exact slot names: Weapon 1, Weapon 2, Helmet, Body Armour, Gloves, Boots, Amulet, Ring 1, Ring 2, Belt, Flask 1-5, plus any version-specific slots (e.g. Ring 3, Graft 1/2) as reported by get_equipped_items. Unknown names fail with the item reported as added-but-not-equipped.",
          },
          no_auto_equip: {
            type: "boolean",
            description: "Add the item to the build's item list without equipping it in a slot (default: false)",
          },
          assume_max_quality: {
            type: "boolean",
            description: "Raise gear without a Unique ID to 20% quality, as PoB's paste box does. Default false: the item keeps the quality its text states (none stated = 0).",
          },
        },
        required: ["item_text", "slot_name"],
      },
    },
    {
      name: "get_equipped_items",
      description: "Get all currently equipped items (empty slots are omitted). Returns name, base, rarity, and all mod lines (implicit, explicit, crafted, enchant) for each equipped item. Use when you need to evaluate gear choices or read specific affixes.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "toggle_flask",
      description: "Toggle a flask on/off",
      inputSchema: {
        type: "object",
        properties: {
          flask_number: {
            type: "number",
            description: "Flask slot number (1-5)",
          },
          active: {
            type: "boolean",
            description: "true to activate, false to deactivate",
          },
        },
        required: ["flask_number", "active"],
      },
    },
    {
      name: "get_skill_setup",
      description: "Get current skill gem setup. Default main_only=true shows only the main DPS socket group — use this first. Set main_only=false only if you need to see all utility/aura/movement groups too.",
      inputSchema: {
        type: "object",
        properties: {
          main_only: {
            type: "boolean",
            description: "Only show the main socket group (default: true). Set to false to see all socket groups.",
          },
        },
      },
    },
    {
      name: "set_main_skill",
      description: "Set which skill group is the main skill for DPS calculations",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          active_skill_index: {
            type: "number",
            description: "Active skill index within group (1-based, optional). Selects which active skill in the group to use for DPS calculation — relevant when a group has multiple active skills.",
          },
          skill_part: {
            type: "number",
            description: "Skill part index (1-based, optional). Selects which part of a multi-part skill to use for DPS calculation.",
          },
        },
        required: ["group_index"],
      },
    },
    {
      name: "create_socket_group",
      description: "Create a new socket group for skill gems",
      inputSchema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "Label for the socket group (e.g., 'Main Skill', 'Auras')",
          },
          slot: {
            type: "string",
            description: "Item the skill is socketed in - PoB's skill group slots: 'Weapon 1', 'Weapon 2', 'Weapon 1 Swap', 'Weapon 2 Swap', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt' (plus 'Ring 3' on newer PoB versions). Omit for an unattached group.",
          },
          enabled: {
            type: "boolean",
            description: "Whether group is enabled (default: true)",
          },
          include_in_full_dps: {
            type: "boolean",
            description: "Include this group's skills in Full DPS totals (default: false)",
          },
        },
        required: ["label"],
      },
    },
    {
      name: "add_gem",
      description: "Add a gem to a socket group. IMPORTANT: Use the gem's base name WITHOUT 'Support' suffix — e.g. 'Brutality' not 'Brutality Support', 'Concentrated Effect' not 'Concentrated Effect Support', 'Melee Physical Damage' not 'Melee Physical Damage Support'. The server will auto-resolve names but correct names ensure proper matching.",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          gem_name: {
            type: "string",
            description: "Gem name WITHOUT 'Support' suffix (e.g. 'Brutality', 'Concentrated Effect', 'Multistrike')",
          },
          level: {
            type: "number",
            description: "Gem level (default: 20)",
          },
          quality: {
            type: "number",
            description: "Gem quality % (default: 0)",
          },
          quality_type: {
            type: "string",
            description: "Type: 'Default', 'Anomalous', 'Divergent', 'Phantasmal' (optional)",
          },
          enabled: {
            type: "boolean",
            description: "Whether gem is enabled (default: true)",
          },
        },
        required: ["group_index", "gem_name"],
      },
    },
    {
      name: "set_gem_level",
      description: "Set the level of a gem",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          gem_index: {
            type: "number",
            description: "Gem index within group (1-based)",
          },
          level: {
            type: "number",
            description: "New gem level",
          },
        },
        required: ["group_index", "gem_index", "level"],
      },
    },
    {
      name: "set_gem_quality",
      description: "Set the quality of a gem",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          gem_index: {
            type: "number",
            description: "Gem index within group (1-based)",
          },
          quality: {
            type: "number",
            description: "Quality percentage (0-23 for normal, up to 30+ for corrupted)",
          },
          quality_type: {
            type: "string",
            description: "Type: 'Default', 'Anomalous', 'Divergent', 'Phantasmal' (optional)",
          },
        },
        required: ["group_index", "gem_index", "quality"],
      },
    },
    {
      name: "remove_skill",
      description: "Remove an entire socket group",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index to remove (1-based)",
          },
        },
        required: ["group_index"],
      },
    },
    {
      name: "remove_gem",
      description: "Remove a specific gem from a socket group",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          gem_index: {
            type: "number",
            description: "Gem index to remove (1-based)",
          },
        },
        required: ["group_index", "gem_index"],
      },
    },
    {
      name: "toggle_socket_group",
      description: "Enable or disable an entire socket group. Stats are recalculated. Requires Lua bridge with a loaded build.",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          enabled: {
            type: "boolean",
            description: "true to enable the group, false to disable it",
          },
        },
        required: ["group_index", "enabled"],
      },
    },
    {
      name: "toggle_gem",
      description: "Enable or disable a single gem within a socket group. Stats are recalculated. Requires Lua bridge with a loaded build.",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          gem_index: {
            type: "number",
            description: "Gem index within group (1-based)",
          },
          enabled: {
            type: "boolean",
            description: "true to enable the gem, false to disable it",
          },
        },
        required: ["group_index", "gem_index", "enabled"],
      },
    },
    {
      name: "setup_skill_with_gems",
      description: "Setup a complete skill with multiple support gems in one operation. Does NOT auto-set as main skill for DPS. Call set_main_skill with the returned group_index afterward if this should be the primary DPS skill.",
      inputSchema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "Label for skill group",
          },
          active_gem: {
            type: "string",
            description: "Active skill gem name",
          },
          support_gems: {
            type: "array",
            items: { type: "string" },
            description: "Array of support gem names",
          },
          slot: {
            type: "string",
            description: "Item slot (optional)",
            enum: ["Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Belt", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5"],
          },
          enabled: {
            type: "boolean",
            description: "Whether the new group is enabled (default: true)",
          },
          include_in_full_dps: {
            type: "boolean",
            description: "Include this group's skills in Full DPS totals (default: false)",
          },
        },
        required: ["label", "active_gem", "support_gems"],
      },
    },
    {
      name: "add_multiple_items",
      description: "Add multiple items at once (efficient bulk operation)",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item_text: { type: "string" },
                slot_name: { type: "string" },
              },
              required: ["item_text", "slot_name"],
            },
            description: "Array of items to add",
          },
        },
        required: ["items"],
      },
    },
    {
      name: "plan_leveling",
      truncatable: true,
      description: "Generate an act-by-act leveling progression guide for a build, including skill gem progression, lab timing, and passive tree priority order",
      inputSchema: {
        type: "object",
        properties: {
          build_name: { type: "string", description: "Build file to read class/skill from (optional if build loaded in Lua bridge)" },
          class_name: { type: "string", description: "Override class name (e.g. 'Witch', 'Ranger')" },
          main_skill: { type: "string", description: "Override main skill name" },
          ascendancy: { type: "string", description: "Override ascendancy name" },
        },
      },
    },
    {
      name: "find_item_upgrades",
      truncatable: true,
      description: "Generate a shopping spec for a gear slot — describes what item type, base, and mods to look for based on the build's current gaps (resistances, life, ES, DPS). Works with a loaded build in the Lua bridge. No trade API required.",
      inputSchema: {
        type: "object",
        properties: {
          slot: {
            type: "string",
            description: "Gear slot to get a shopping spec for (e.g., 'Helmet', 'Body Armour', 'Boots', 'Gloves', 'Belt', 'Amulet', 'Ring 1', 'Ring 2', 'Weapon 1', 'Weapon 2')",
          },
          priority: {
            type: "string",
            description: "What to optimize for: 'dps', 'defense', 'resistance', or 'balanced' (default: 'balanced')",
            enum: ["dps", "defense", "resistance", "balanced"],
          },
        },
        required: ["slot"],
      },
    },
    {
      name: "import_build_link",
      description: "Import a build from a link, as Path of Building's Import/Export tab does with 'enter URL or code' and Import to a new build. Accepts links from every site in PoB's own list (Modules/BuildSiteTools.lua: pobb.in, poe.ninja, Maxroll, pob.codes, Pastebin, PastebinP, Rentry, poedb), pob:// links, YouTube/Google redirect links to those, and plain build codes. PoB's code recognises the link and gives the download URL; the code is downloaded and loaded into the engine, and the link is kept as the build's import link. AUTO-RETURNS the same summary as lua_load_build. Optionally saves to save_as (never replaces a file without overwrite).",
      inputSchema: {
        type: "object",
        properties: {
          link: { type: "string", description: "Build link (e.g. https://pobb.in/abc, https://poe.ninja/poe1/pob/abc) or a build code." },
          name: { type: "string", description: "Name for the imported build (default 'Imported build', as PoB)." },
          save_as: { type: "string", description: "Build file to save it to (.xml added if missing). Not saved when omitted." },
          overwrite: { type: "boolean", description: "Allow replacing an existing save_as file (default: false).", default: false },
        },
        required: ["link"],
      },
    },
    {
      name: "share_build",
      description: "Publish the loaded build to a build site and get its link, as Path of Building's Import/Export 'Share' button (buildSites.UploadBuild). Sites are those PoB shares to (pobb.in, poe.ninja, Maxroll, pob.codes, poedb). Two steps: without confirm_code_hash nothing is uploaded; the preview lists what the code carries (the whole build file: notes, item set names, and the Import section with realm, league, account and character name hashes and import link) and a hash of the code. Uploading needs that hash and is refused if the build changed since the preview. The upload is public to anyone with the link: only confirm when the user asked to share after seeing the preview.",
      inputSchema: {
        type: "object",
        properties: {
          site: { type: "string", description: "Site label or id from PoB's list, e.g. 'pobb.in', 'PoeNinja', 'Maxroll', 'pob.codes', 'poedb.tw'." },
          confirm_code_hash: { type: "string", description: "The code hash a preview reported. Omit to preview; give it to upload exactly that code." },
        },
        required: ["site"],
      },
    },
    // Compare tab (PoB's Classes/CompareTab.lua). Comparison builds live with
    // the loaded build; loading another build clears them, as in the app.
    {
      name: "compare_add_build",
      description: "Load a build into Path of Building's Compare tab, next to the loaded build (lua_load_build first), from a build file or a PoB build code. Several can be loaded; the newest becomes the active comparison. Uses PoB's own CompareTab:ImportBuild, so the compared build is calculated by PoB. The loaded build is not changed. Then use compare_differences, compare_power_report, compare_select, compare_buy_similar, compare_copy. Unlike compare_builds (which reloads two files and reads a few stats), this keeps both builds in the engine.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: { type: "string", description: "Build file in the builds directory (e.g. 'RF.xml' or 'folder/name')." },
          build_code: { type: "string", description: "A PoB build code (the export string). Give build_name or build_code." },
          label: { type: "string", description: "Name shown for the comparison (default: the file name, or 'Imported build' for a code, as in PoB)." },
        },
      },
    },
    {
      name: "compare_list",
      description: "List the builds loaded in the Compare tab with their tree, item, skill and config sets (active marked), main skill group and headline stats.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "compare_remove_build",
      description: "Remove a build from the Compare tab (PoB's Remove button). Only the in-memory comparison is dropped; no file is touched.",
      inputSchema: {
        type: "object",
        properties: { index: { type: "number", description: "Comparison index from compare_list." } },
        required: ["index"],
      },
    },
    {
      name: "compare_select",
      description: "Choose the active comparison and the compared build's tree set, item set, skill set, config set and main socket group, as the Compare tab's selectors do; also the Calcs view's socket group, buff mode and minion toggle for the compared build. Sets are given by their position from compare_list.",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Comparison to make active (default: the active one)." },
          tree_set: { type: "number", description: "Tree set position." },
          item_set: { type: "number", description: "Item set position." },
          skill_set: { type: "number", description: "Skill set position." },
          config_set: { type: "number", description: "Config set position." },
          main_socket_group: { type: "number", description: "Main skill socket group (Summary/power report)." },
          calcs_socket_group: { type: "number", description: "Socket group for the Calcs section." },
          calcs_buff_mode: { type: "string", enum: ["UNBUFFED", "BUFFED", "COMBAT", "EFFECTIVE"], description: "Calcs section mode." },
          calcs_show_minion: { type: "boolean", description: "Calcs section shows the minion instead of the player." },
        },
      },
    },
    {
      name: "compare_differences",
      description: "How the active comparison build differs from the loaded build, computed the way PoB's Compare tab does: stats (Summary view: every sidebar stat relevant to either skill, with difference and %), tree (overlay: nodes only in one build, and allocated nodes whose mastery or jewel differs), items (per slot match/different/missing/extra, jewel sockets, optional mod-by-mod markers and the stat change of equipping each compared item), skills (socket groups paired by gem similarity; gems common/only here/only there), config (options whose values differ), calcs (Calcs view rows, using PoB's own 'Show only differences' test). only_differences (default true) keeps only rows that differ; an item slot differs when the item text differs, even if PoB labels same-named items a 'match'.",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Comparison to use (default: the active one)." },
          sections: {
            type: "array",
            items: { type: "string", enum: ["stats", "tree", "items", "skills", "config", "calcs"] },
            description: "Sections to report (default: stats, tree, items, skills, config; calcs is long, ask for it explicitly).",
          },
          only_differences: { type: "boolean", description: "Only rows that differ (default true). False also lists equal stats, matching slots and groups, and relevant equal config options.", default: true },
          items_expanded: { type: "boolean", description: "List each item's mods with PoB's markers (+ only on this side, > / < higher / lower value), as the Items view's expanded mode.", default: false },
          item_stat_changes: { type: "boolean", description: "For each differing slot, the loaded build's stat changes from equipping the compared item (the Equip button's tooltip).", default: false },
          config_show_all: { type: "boolean", description: "With only_differences false: list all equal options, not only relevant ones (the 'Show All Configurations' toggle).", default: false },
          calcs_filter: { type: "string", description: "Calcs: only sections, subsections or rows whose name contains this text." },
          output: { type: "string", enum: ["text", "json"], description: "text (default) or the raw JSON." },
        },
      },
    },
    {
      name: "compare_power_report",
      truncatable: true,
      description: "The Compare tab's power report: for one metric, the change on the loaded build from taking each element of the compared build — each passive it has that the loaded build lacks (with path length and per-point value), each item and jewel, each socket group the loaded build lacks, each support gem of its main skill, each differing config option. Calculated by PoB (CompareTab:ComparePowerBuilder). Without metric, lists the metrics. Long reports are truncated; use limit and sort_by.",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Comparison to use (default: the active one)." },
          metric: { type: "string", description: "Stat or label from the metric list, e.g. FullDPS, CombinedDPS, Life, TotalEHP." },
          categories: {
            type: "object",
            description: "Categories to include (all default true).",
            properties: {
              tree: { type: "boolean" }, items: { type: "boolean" }, skill_gems: { type: "boolean" },
              support_gems: { type: "boolean" }, config: { type: "boolean" },
            },
          },
          sort_by: { type: "string", enum: ["impact", "category", "points", "per_point"], description: "Sort column (default impact, as PoB)." },
          limit: { type: "number", description: "Show at most this many rows." },
        },
      },
    },
    {
      name: "compare_buy_similar",
      description: "The Items view's Buy button for a compared build's item: PoB builds the pathofexile.com trade search (CompareBuySimilar) for it. Returns the URL and query, and the mod and defence choices of the popup. As in the popup nothing is ticked by default; pick mods by number or 'all'. Uniques are searched by name. Reaches the trade site only to read its league list when no league is given (as the popup does), and for one search request when run_search is set.",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Comparison to use (default: the active one)." },
          slot: { type: "string", description: "Slot of the compared build: 'Helmet', 'Ring 1', 'Weapon 1 Swap', 'Flask 2', 'Belt Abyssal Socket 1', or a jewel socket 'Jewel <nodeId>' (see compare_differences items)." },
          league: { type: "string", description: "Trade league. Default: what the popup picks (the current challenge league from the trade API), or Standard when the trade API is off." },
          realm: { type: "string", enum: ["pc", "sony", "xbox"], description: "Realm (default pc)." },
          listed: { type: "string", enum: ["securable", "available", "online", "any"], description: "Listing status: securable = Instant Buyout (popup default), available = Instant Buyout & In Person, online = In Person (Online), any." },
          use_base_type: { type: "boolean", description: "Search the same base type (non-unique)." },
          ilvl_min: { type: "number", description: "Minimum item level (non-unique)." },
          ilvl_max: { type: "number", description: "Maximum item level (non-unique)." },
          mods: { description: "Mods to search: 'all' or a list of mod numbers from the listing.", anyOf: [{ type: "string", enum: ["all"] }, { type: "array", items: { type: "number" } }] },
          mod_values: { type: "object", description: "Per mod number, { min?, max? } replacing the prefilled minimum (the item's value).", additionalProperties: { type: "object", properties: { min: { type: "number" }, max: { type: "number" } } } },
          defences: { description: "Defences to search (non-unique armour): 'all' or labels like 'Armour', 'Energy Shield'.", anyOf: [{ type: "string", enum: ["all"] }, { type: "array", items: { type: "string" } }] },
          defence_values: { type: "object", description: "Per defence label, { min?, max? } replacing the prefilled minimum.", additionalProperties: { type: "object", properties: { min: { type: "number" }, max: { type: "number" } } } },
          run_search: { type: "boolean", description: "Also run the search once through the trade API (needs POE_TRADE_ENABLED, PC realm) and report the listing count.", default: false },
        },
        required: ["slot"],
      },
    },
    {
      name: "compare_copy",
      description: "Copy from the compared build into the loaded build, as the Compare tab's buttons do: what 'tree' adds the compared build's active tree as a new tree set ('Copy tree'; use true = 'Copy and use'); 'item' adds the compared item of a slot to the loaded build's items ('Copy'; use true = 'Equip' into the same slot, refused for Ring 3 when the loaded build has no third ring slot, where PoB shows 'Missing slot'); 'config' copies all its config values into the loaded build's active config set. Changes the loaded build in memory; save with lua_save_build.",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Comparison to copy from (default: the active one)." },
          what: { type: "string", enum: ["tree", "item", "config"] },
          slot: { type: "string", description: "For item: the slot, e.g. 'Body Armour' or 'Jewel 26725'." },
          use: { type: "boolean", description: "tree: make the copied tree active; item: equip it. Default false.", default: false },
        },
        required: ["what"],
      },
    },
    // Skills tab, config tab and minions (gem DPS ranking, skill and config
    // sets, spectres, the main skill's minion, custom modifiers).
    {
      name: "rank_gems_by_dps",
      truncatable: true,
      description: "Rank the gems Path of Building offers for one gem slot of a socket group by the DPS PoB itself calculates with each gem there: PoB's Skills tab gem dropdown with 'Sort gems by DPS' on. Gives each candidate's DPS and the change from the current build. Support gems that cannot support the group's skills are not calculated. With the default fields the DPS is the main skill's, as in PoB. Reads only; the build is unchanged. Requires a loaded build.",
      inputSchema: {
        type: "object",
        properties: {
          group_index: { type: "number", description: "Socket group (1-based, as in get_skill_setup). Default: the main socket group." },
          gem_index: { type: "number", description: "Gem slot to fill (1-based). A slot holding a gem ranks replacements for it; the default is the empty slot after the last gem." },
          dps_field: { type: "string", enum: ["FullDPS", "CombinedDPS", "TotalDPS", "AverageDamage", "TotalDot", "BleedDPS", "IgniteDPS", "TotalPoisonDPS", "TotalEHP"], description: "Stat to sort by (PoB's sort field). Default: the build's own setting (usually CombinedDPS)." },
          gem_type: { type: "string", enum: ["support", "active", "all"], description: "Which gems the dropdown lists (its S/A filter). Default: support." },
          search: { type: "string", description: "PoB's gem search text, e.g. 'fire' or ':fire:-aura'. Default: all gems." },
          default_gem_level: { type: "string", enum: ["normalMaximum", "corruptedMaximum", "awakenedMaximum", "characterLevel", "levelOne"], description: "Level candidates are tried at (PoB's 'Default gem level'). Default: the build's setting." },
          default_gem_quality: { type: "number", description: "Quality candidates are tried at, 0-23. Default: the build's setting." },
          show_support_types: { type: "string", enum: ["ALL", "NORMAL", "EXCEPTIONAL"], description: "PoB's 'Show support gems' option. Default: the build's setting." },
          show_legacy_gems: { type: "boolean", description: "PoB's 'Show legacy gems' option. Default: the build's setting." },
          include_unevaluated: { type: "boolean", description: "Also list gems PoB does not calculate (default false)." },
          limit: { type: "number", description: "Candidates to return, 1-500 (default 25)." },
        },
      },
    },
    {
      name: "list_skill_sets",
      description: "List the build's skill sets (Skills tab 'Skill set' / Manage...), with ids and which one is active.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "select_skill_set",
      description: "Switch the active skill set, as double-clicking it in PoB's Manage Skill Sets. Stats are recalculated. Selecting the set already active changes nothing.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "Skill set id (see list_skill_sets)" } },
        required: ["id"],
      },
    },
    {
      name: "create_skill_set",
      description: "Create a skill set: an empty one (PoB's New) or a copy of another (Copy). Like PoB, it does not switch to it unless activate is true.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Name of the new skill set (1-100 characters)" },
          copy_from: { type: "number", description: "Skill set id to copy (optional; omit for an empty set)" },
          activate: { type: "boolean", description: "Switch to the new set (default false)" },
        },
        required: ["title"],
      },
    },
    {
      name: "rename_skill_set",
      description: "Rename a skill set.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Skill set id (see list_skill_sets)" },
          title: { type: "string", description: "New name (1-100 characters)" },
        },
        required: ["id", "title"],
      },
    },
    {
      name: "delete_skill_set",
      description: "Delete a skill set and its socket groups. The last set cannot be deleted; deleting the active set switches to the one above it. Needs confirm: true.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Skill set id (see list_skill_sets)" },
          confirm: { type: "boolean", description: "Must be true to delete" },
        },
        required: ["id", "confirm"],
      },
    },
    {
      name: "list_config_sets",
      description: "List the config sets stored inside the build (Configuration tab 'Config set' / Manage...), with ids and which one is active. get_config, set_config and the custom modifier tools work on the active set. Not the preset files of save_config_preset / list_config_presets.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "select_config_set",
      description: "Switch the active config set stored inside the build, as double-clicking it in PoB's Manage Config Sets. Stats are recalculated. Selecting the set already active changes nothing. For preset files, use load_config_preset.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "Config set id (see list_config_sets)" } },
        required: ["id"],
      },
    },
    {
      name: "create_config_set",
      description: "Create a config set stored inside the build (saved with it): one with PoB's default settings (New) or a copy of another (Copy). Like PoB, it does not switch to it unless activate is true. Unlike save_config_preset, which writes a separate preset file.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Name of the new config set (1-100 characters)" },
          copy_from: { type: "number", description: "Config set id to copy (optional)" },
          activate: { type: "boolean", description: "Switch to the new set (default false)" },
        },
        required: ["title"],
      },
    },
    {
      name: "rename_config_set",
      description: "Rename a config set.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Config set id (see list_config_sets)" },
          title: { type: "string", description: "New name (1-100 characters)" },
        },
        required: ["id", "title"],
      },
    },
    {
      name: "delete_config_set",
      description: "Delete a config set. The last set cannot be deleted; deleting the active set switches to the one above it. Needs confirm: true.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Config set id (see list_config_sets)" },
          confirm: { type: "boolean", description: "Must be true to delete" },
        },
        required: ["id", "confirm"],
      },
    },
    {
      name: "list_spectres",
      truncatable: true,
      description: "Show the build's spectre list (what Raise Spectre can raise; PoB's 'Manage Spectres...'), and optionally search PoB's spectre library by name or skill.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search the spectre library (PoB's search box; empty lists every spectre)" },
          search_mode: { type: "string", enum: ["names", "skills", "both"], description: "Match monster names, their skills, or both (default names)" },
          limit: { type: "number", description: "Library results to show (default 50)" },
        },
      },
    },
    {
      name: "set_spectres",
      description: "Add spectres to or remove them from the build's spectre list, as PoB's Spectre Library popup. Spectres are given by name or by id (from list_spectres). Then choose the raised spectre with set_minion.",
      inputSchema: {
        type: "object",
        properties: {
          add: { type: "array", items: { type: "string" }, description: "Spectres to add (names or ids)" },
          remove: { type: "array", items: { type: "string" }, description: "Spectres to remove (names or ids)" },
        },
      },
    },
    {
      name: "get_minion_options",
      description: "Show the main skill's minion choices: the Minion and Minion Skill dropdowns of PoB's sidebar (or of the Calcs tab with calcs: true).",
      inputSchema: {
        type: "object",
        properties: { calcs: { type: "boolean", description: "Read the Calcs tab's own selection instead of the sidebar's (default false)" } },
      },
    },
    {
      name: "set_minion",
      description: "Choose the main skill's minion (e.g. which spectre Raise Spectre raises), the item set of a minion that uses one, and the minion skill whose damage PoB shows. Stats are recalculated.",
      inputSchema: {
        type: "object",
        properties: {
          minion: { type: "string", description: "Minion name or id (see get_minion_options)" },
          item_set_id: { type: "number", description: "Item set for a minion that takes one (e.g. Animate Guardian)" },
          minion_skill: { description: "Minion skill index (1-based) or name" },
          calcs: { type: "boolean", description: "Set the Calcs tab's own selection instead of the sidebar's (default false)" },
        },
      },
    },
    {
      name: "get_custom_mods",
      truncatable: true,
      description: "Show the active config set's custom modifiers (Configuration tab, Custom Modifiers): each group, whether it is enabled, and whether PoB parses each line. With search, also lists matching modifiers from PoB's 'Add Mod' browser.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search PoB's Add Mod browser (e.g. 'burning damage')" },
          limit: { type: "number", description: "Browser results to show (default 50)" },
        },
      },
    },
    {
      name: "set_custom_mods",
      description: "Change the active config set's custom modifiers, which PoB adds to the calculation: add a group (Add Mod Group), set a group's title, its whole text (one modifier per line), append one modifier (Add Mod), enable or disable it, or remove it (needs confirm: true). Lines PoB cannot parse have no effect and are reported. Stats are recalculated.",
      inputSchema: {
        type: "object",
        properties: {
          group_index: { type: "number", description: "Group to change (1-based, see get_custom_mods). Optional when there is one group or with add_group." },
          add_group: { type: "boolean", description: "Add a new group first; the other fields then apply to it" },
          remove_group: { type: "boolean", description: "Remove group_index (needs confirm: true)" },
          title: { type: "string", description: "New group title" },
          text: { type: "string", description: "Replace the group's text: modifiers, one per line, e.g. '20% more Damage'" },
          append_mod: { type: "string", description: "Append one modifier line to the group" },
          enabled: { type: "boolean", description: "Enable or disable the group" },
          confirm: { type: "boolean", description: "Must be true with remove_group" },
        },
      },
    },
  ];
}

/**
 * Get optimization tool schemas
 */
export function getOptimizationToolSchemas(): ToolSchema[] {
  return [
    {
      name: "analyze_defenses",
      truncatable: true,
      description: "Ranks a build's defences by the BINDING CONSTRAINT: the max hit PoB computes per damage type (physical/fire/cold/lightning/chaos), lowest first, so you can see which hit kills this character and how much headroom the rest have. Use this before recommending any defensive purchase — TotalEHP averages across damage types and will rank a patch to the strongest type about level with a patch to the weakest. Also reports the usual layers (avoidance/mitigation/recovery, suppression, block, armour/PDR, regen). Limits: max hits use CAPPED resistance, so types at the cap tie and overcap counts for nothing here; the figures are for the currently loaded config and enemy settings. validate_build does NOT report max hits, so call this one for any survivability ranking.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze",
          },
          sweep_resistances: {
            type: "boolean",
            description: "Measure how far the binding resistance is worth buying. Steps that resistance up 5% at a time on the real engine (a few seconds) and reports the point at which the floor changes hands, past which more of it buys nothing. Each step is a hypothetical calculation that swaps an equipped item for a copy carrying the extra resistance; the loaded build is never changed. Sweeps the lowest resisted max hit, so when physical is the overall floor it still ranks resistances and says physical owns the floor.",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "suggest_optimal_nodes",
      truncatable: true,
      description: "AI-powered suggestion of optimal passive nodes based on build goals",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to optimize",
          },
          goal: {
            type: "string",
            description: "Optimization goal: 'damage', 'defense', 'life', 'es', or stat name",
          },
          points_available: {
            type: "number",
            description: "Number of passive points to spend (default: 10)",
          },
        },
        required: ["build_name", "goal"],
      },
    },
    {
      name: "optimize_tree",
      truncatable: true,
      description: "Full passive tree optimization - removes inefficient nodes and reallocates to better options",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to optimize",
          },
          goal: {
            type: "string",
            description: "Primary optimization goal: 'damage', 'defense', 'balanced'",
          },
          constraints: {
            type: "object",
            description: "Optional constraints: { minLife, minES, protectedNodes: string[] }. protectedNodes are excluded from recommendations; minLife/minES are evaluated against current stats and reported (suggestions are not stat-recalculated).",
          },
          max_points: {
            type: "number",
            description: "Number of passive points to optimize; caps how many recommended allocations are returned (default: 10)",
          },
          max_iterations: {
            type: "number",
            description: "Maximum optimization iterations (accepted for forward compatibility; not used by the current analyzer)",
          },
        },
        required: ["build_name", "goal"],
      },
    },
    {
      name: "analyze_items",
      truncatable: true,
      description: "Analyze equipped items and suggest upgrades or improvements",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "optimize_skill_links",
      truncatable: true,
      description: "Analyze skill gem setups for 'more' multipliers, penetration, and support gem synergies. Flags missing multiplicative damage supports and suggests clear-speed vs bossing balance. These are template estimates, not Path of Building's calculation; rank_gems_by_dps gives PoB's own DPS for every candidate gem.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "create_budget_build",
      truncatable: true,
      description: "Create a league-start/budget-friendly version of a build",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to create budget version of",
          },
          budget_tier: {
            type: "string",
            description: "Budget tier: 'league-start', 'low', 'medium' (default: league-start)",
          },
        },
        required: ["build_name"],
      },
    },
  ];
}

/**
 * Get configuration tool schemas (Phase 9)
 */
export function getConfigToolSchemas(): ToolSchema[] {
  return [
    {
      name: "get_config",
      description: "View current configuration state including charge usage, enemy settings, and active conditions. Requires Lua bridge with a loaded build.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "set_config",
      description: "Modify configuration inputs. Common keys — Charges: usePowerCharges, useFrenzyCharges, useEnduranceCharges | Conditions: buffFortification, conditionLeeching, conditionFullLife, conditionFullEnergyShield | Buffs: buffOnslaught | Enemy: enemyIsBoss ('None'/'Boss'/'Pinnacle'/'Uber'; legacy names 'Shaper'/'Sirus' map to 'Pinnacle', 'Atziri'/'Uber Atziri' to 'Boss'), enemyLevel | Build: bandit ('None'/'Oak'/'Alira'/'Kraityn'), pantheonMajorGod, pantheonMinorGod | Custom modifiers: customMods (text of the first custom modifier group, one modifier per line; set_custom_mods handles every group). Values outside an option's accepted set are rejected per key, never silently ignored. Call get_config to see all current values.",
      inputSchema: {
        type: "object",
        properties: {
          config_name: {
            type: "string",
            description: "Name of configuration input to change (e.g., 'usePowerCharges', 'enemyIsBoss', 'buffFortification')",
          },
          value: {
            description: "New value (boolean for most flags, number for counts)",
          },
        },
        required: ["config_name", "value"],
      },
    },
    {
      name: "set_enemy_stats",
      description: "Configure enemy parameters for DPS calculations. Test against different enemy types (map boss, Shaper, Maven). Requires Lua bridge.",
      inputSchema: {
        type: "object",
        properties: {
          level: {
            type: "number",
            description: "Enemy level (default: 84)",
          },
          fire_resist: {
            type: "number",
            description: "Fire resistance % (default: 40)",
          },
          cold_resist: {
            type: "number",
            description: "Cold resistance % (default: 40)",
          },
          lightning_resist: {
            type: "number",
            description: "Lightning resistance % (default: 40)",
          },
          chaos_resist: {
            type: "number",
            description: "Chaos resistance % (default: 20)",
          },
          armor: {
            type: "number",
            description: "Enemy armor value",
          },
          evasion: {
            type: "number",
            description: "Enemy evasion value",
          },
        },
      },
    },
    {
      name: "save_config_preset",
      description: "Save the current configuration (charges, conditions, enemy settings) as a named preset for quick reuse. Presets are separate files under the builds folder, shared across builds; for config sets stored inside the build (PoB's Config set dropdown), use create_config_set.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Preset name (e.g. 'bossing', 'mapping', 'full-charges')",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "load_config_preset",
      description: "Load a previously saved configuration preset, restoring all charge, condition, and enemy settings at once. Presets are separate files (save_config_preset), not the build's own config sets (select_config_set).",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Preset name to load",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "list_config_presets",
      description: "List all saved configuration presets (separate preset files, not the config sets stored inside the build; see list_config_sets).",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

/**
 * Get build validation tool schemas (Phase 7)
 */
export function getValidationToolSchemas(): ToolSchema[] {
  return [
    {
      name: "validate_build",
      truncatable: true,
      description: "Comprehensive build validation: resistances, life pool, defensive layers (avoidance/mitigation/recovery), mana sustain, accuracy, flask immunities, damage scaling. Provides prioritized critical/warning/info recommendations. PREFER this over get_build_issues — it covers both in one call. It does NOT report per-damage-type max hits, so use analyze_defenses when the question is which damage type kills the character or where a defensive point should go.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to validate. If omitted and Lua bridge is active, validates currently loaded build.",
          },
        },
      },
    },
  ];
}

/**
 * Get skill gem analysis tool schemas (Phase 11)
 */
export function getSkillGemToolSchemas(): ToolSchema[] {
  return [
    {
      name: "analyze_skill_links",
      truncatable: true,
      description: "Analyze skill gem setup and evaluate support gem choices. Detects build archetype, rates each support gem, and identifies issues with current setup.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze",
          },
          skill_index: {
            type: "number",
            description: "Which skill to analyze (0 = main skill, default: 0)",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "suggest_support_gems",
      truncatable: true,
      description: "Get intelligent support gem recommendations based on build archetype. Provides ranked suggestions with DPS estimates, cost, and reasoning. The DPS figures are template estimates, not Path of Building's calculation; rank_gems_by_dps gives PoB's own DPS for every candidate.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze",
          },
          skill_index: {
            type: "number",
            description: "Which skill to optimize (0 = main skill, default: 0)",
          },
          count: {
            type: "number",
            description: "Number of suggestions to return (default: 5)",
          },
          include_exceptional: {
            type: "boolean",
            description: "Include Exceptional gem recommendations (default: true)",
          },
          budget: {
            type: "string",
            description: "Budget tier: 'league_start', 'mid_league', or 'endgame' (default: 'endgame')",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "compare_gem_setups",
      truncatable: true,
      description: "Compare multiple gem configurations side-by-side to evaluate different options. NOTE: Full DPS comparison requires Lua bridge integration (future enhancement). For PoB's own DPS of each gem in a slot, use rank_gems_by_dps.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to test",
          },
          skill_index: {
            type: "number",
            description: "Which skill to test (default: 0)",
          },
          setups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                gems: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["name", "gems"],
            },
            description: "Array of gem setups to compare (minimum 2)",
          },
        },
        required: ["build_name", "setups"],
      },
    },
    {
      name: "validate_gem_quality",
      description: "Check all gems for quality and level improvements. Identifies missing quality, Exceptional upgrade opportunities, and corruption targets.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to validate",
          },
          include_corrupted: {
            type: "boolean",
            description: "Include corruption recommendations for 21/23 gems (default: true)",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "find_optimal_links",
      truncatable: true,
      description: "Auto-generate the best support gem combination for a skill based on budget and optimization goal. Provides step-by-step upgrade path. These are template estimates, not Path of Building's calculation; rank_gems_by_dps gives PoB's own DPS for every candidate gem.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to optimize",
          },
          skill_index: {
            type: "number",
            description: "Which skill to optimize (default: 0)",
          },
          link_count: {
            type: "number",
            description: "Number of links (4, 5, or 6)",
          },
          budget: {
            type: "string",
            description: "Budget tier: 'league_start', 'mid_league', or 'endgame' (default: 'endgame')",
          },
        },
        required: ["build_name", "link_count"],
      },
    },
    {
      name: "gem_upgrade_path",
      description: "Generate a prioritized gem upgrade shopping list showing which gems to level, quality, and upgrade to Exceptional versions, ordered by impact and budget",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build file (optional if loaded in Lua bridge)",
          },
          budget: {
            type: "string",
            description: "Budget tier: 'league_start', 'mid_league', 'endgame' (default: endgame)",
          },
        },
      },
    },
  ];
}

/**
 * Get export and persistence tool schemas (Phase 8)
 */
export function getExportToolSchemas(): ToolSchema[] {
  return [
    {
      name: "export_build",
      description: "Export a copy of a build to an XML file. Creates a variant/copy from an existing build file. NOTE: This does NOT export from Lua bridge - use save_tree to apply Lua bridge modifications back to files.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Source build filename (e.g., 'MyBuild.xml')",
          },
          output_name: {
            type: "string",
            description: "Output filename (without .xml extension)",
          },
          output_directory: {
            type: "string",
            description: "Sub-directory under POB_DIRECTORY to export into (optional, defaults to POB_DIRECTORY/.pob-mcp/exports). Paths outside POB_DIRECTORY are rejected.",
          },
          overwrite: {
            type: "boolean",
            description: "Allow overwriting existing file (default: false)",
          },
          notes: {
            type: "string",
            description: "Additional notes to append to build notes",
          },
        },
        required: ["build_name", "output_name"],
      },
    },
    {
      name: "save_tree",
      description: "Update only the passive tree in an existing build file. Use this to apply tree optimizations or Lua bridge modifications back to the original build.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Target build filename to update",
          },
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Array of node IDs to allocate",
          },
          mastery_effects: {
            type: "object",
            description: "Mastery selections as object mapping node ID to effect ID (optional)",
          },
          backup: {
            type: "boolean",
            description: "Create backup before modifying (default: true)",
          },
        },
        required: ["build_name", "nodes"],
      },
    },
    {
      name: "snapshot_build",
      description: "Create a versioned snapshot of a build for easy rollback. Snapshots are stored separately with metadata tracking stats and changes.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to snapshot",
          },
          description: {
            type: "string",
            description: "Description of this snapshot (optional)",
          },
          tag: {
            type: "string",
            description: "User-friendly tag (e.g., 'before-respec', 'league-start') (optional)",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "list_snapshots",
      description: "List all snapshots for a build with metadata and stats",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to list snapshots for",
          },
          limit: {
            type: "number",
            description: "Maximum number of snapshots to return (optional)",
          },
          tag_filter: {
            type: "string",
            description: "Filter by tag (optional)",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "restore_snapshot",
      description: "Restore a build from a snapshot. Optionally creates a backup of current state before restoring.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to restore",
          },
          snapshot_id: {
            type: "string",
            description: "Snapshot ID (timestamp) or tag to restore from",
          },
          backup_current: {
            type: "boolean",
            description: "Create snapshot of current state before restore (default: true)",
          },
        },
        required: ["build_name", "snapshot_id"],
      },
    },
    {
      name: "export_build_summary",
      description: "Generate a clean markdown summary of the loaded build suitable for sharing on Reddit, Discord, or as build documentation",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

/**
 * Get Trade API tool schemas (require POE_TRADE_ENABLED=true)
 */
export function getTradeToolSchemas(): ToolSchema[] {
  return [
    {
      name: "find_weighted_trade_items",
      description: "Find build-specific best-in-slot listings using upstream PoB's native TradeQueryGenerator stat weights. Requires a loaded build, POE_TRADE_ENABLED=true, and POE_SESSION_ID (the official Trade API rejects anonymous weighted searches).",
      inputSchema: { type: "object", properties: { league: { type: "string" }, slot: { type: "string" }, options: { type: "object" }, limit: { type: "number" } }, required: ["league", "slot"] },
    },
    {
      name: "search_trade_items",
      truncatable: true,
      description: "Search the Path of Exile trade site for items with filters. Returns matching items with prices, stats, and seller information. Default limit is 5 items to minimize token usage. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user (e.g., 'Standard', 'Settlers', 'Keepers', 'Hardcore'). Use get_leagues to see available leagues. Do not substitute or change the league name.",
          },
          item_name: {
            type: "string",
            description: "Specific item name to search for (e.g., 'Headhunter', 'Taste of Hate')",
          },
          item_type: {
            type: "string",
            description: "Base item type (e.g., 'Corsair Sword', 'Astral Plate')",
          },
          min_price: {
            type: "number",
            description: "Minimum price in the specified currency",
          },
          max_price: {
            type: "number",
            description: "Maximum price in the specified currency",
          },
          price_currency: {
            type: "string",
            description: "Currency for price filter (default: 'chaos'). Options: 'chaos', 'divine', 'exalted'",
          },
          item_rarity: {
            type: "string",
            description: "Item rarity filter: 'unique', 'rare', 'magic', 'normal'",
          },
          min_links: {
            type: "number",
            description: "Minimum number of links (for weapons/armor)",
          },
          corrupted: {
            type: "boolean",
            description: "Filter by corruption status (true/false/undefined for any)",
          },
          identified: {
            type: "boolean",
            description: "Filter by identification status",
          },
          online_status: {
            type: "string",
            enum: ["available", "online", "onlineleague", "securable", "any"],
            description: "Online-status filter (default: 'available'). Use 'securable' to restrict to instant-buyout listings from currently-online sellers (i.e. a click-and-buy result).",
          },
          mods: {
            type: "array",
            items: {
              type: "object",
              properties: {
                stat_id: { type: "string" },
                min: { type: "number" },
                max: { type: "number" },
              },
              required: ["stat_id"],
            },
            description: "List of stat filters with min/max values",
          },
          limit: {
            type: "number",
            description: "Maximum results (default: 5, max: 10)",
          },
        },
        required: ["league"],
      },
    },
    {
      name: "get_item_price",
      description: "Quick price check for a specific item by name. Returns current market price and recent sales. REQUIRES: POE_TRADE_ENABLED environment variable set to true. IMPORTANT: Use the EXACT league name the user specifies.",
      inputSchema: {
        type: "object",
        properties: {
          item_name: {
            type: "string",
            description: "Name of the item to price check",
          },
          league: {
            type: "string",
            description: "EXACT league name as specified by user",
          },
          item_type: {
            type: "string",
            description: "Item base type for more accurate results (optional)",
          },
          rarity: {
            type: "string",
            description: "Item rarity: 'unique', 'rare', 'magic', 'normal' (optional)",
            enum: ["unique", "rare", "magic", "normal"],
          },
        },
        required: ["item_name"],
      },
    },
    {
      name: "get_leagues",
      description: "Get list of currently active Path of Exile leagues. Use this to find the correct league name before searching trade or prices. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_stats",
      description: "Search for item stat/mod IDs to use in trade searches. Use this to find the correct stat_id values for mods you want to filter by. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for stat names (e.g., 'life', 'fire resistance')",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default: 10)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "compare_trade_items",
      truncatable: true,
      description: "Compare trade listings side by side with DPS/defense calculations. Takes listing ids from a prior search_trade_items result. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {
          item_ids: {
            type: "array",
            items: { type: "string" },
            description: "Listing ids to compare, from a prior search_trade_items result",
          },
          search_id: {
            type: "string",
            description: "The search id from the same search_trade_items result. Provides the query context expected by the trade fetch endpoint.",
          },
          build_context: {
            type: "object",
            description: "Optional build needs for context-aware scoring",
            properties: {
              life_needed: { type: "number" },
              es_needed: { type: "number" },
              dps_target: { type: "number" },
              fire_resist_needed: { type: "number" },
              cold_resist_needed: { type: "number" },
              lightning_resist_needed: { type: "number" },
            },
          },
        },
        required: ["item_ids"],
      },
    },
    {
      name: "find_resistance_gear",
      truncatable: true,
      description: "Find trade listings that efficiently cover elemental or chaos resistance gaps within a per-item and total budget. REQUIRES: POE_TRADE_ENABLED=true.",
      inputSchema: {
        type: "object",
        properties: {
          league: { type: "string", description: "Exact league name; use get_leagues when needed." },
          fire_resist_needed: { type: "number", description: "Additional fire resistance needed (default: 0)." },
          cold_resist_needed: { type: "number", description: "Additional cold resistance needed (default: 0)." },
          lightning_resist_needed: { type: "number", description: "Additional lightning resistance needed (default: 0)." },
          chaos_resist_needed: { type: "number", description: "Additional chaos resistance needed (default: 0)." },
          max_price_per_item: { type: "number", description: "Maximum price for a single item (default: 50)." },
          total_budget: { type: "number", description: "Maximum combined budget (default: 200)." },
          currency: { type: "string", description: "Budget currency (default: chaos)." },
          slots: { type: "array", items: { type: "string" }, description: "Optional slots to search, such as Ring 1, Belt, Boots, or Gloves." },
          limit: { type: "number", description: "Maximum recommendations (default: 8)." },
        },
        required: ["league"],
      },
    },
    {
      name: "search_cluster_jewels",
      truncatable: true,
      description: "Search for cluster jewels with specific enchants and notables. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user",
          },
          jewel_size: {
            type: "string",
            description: "Cluster jewel size: 'large', 'medium', or 'small'",
            enum: ["large", "medium", "small"],
          },
          enchant: {
            type: "string",
            description: "Enchant modifier name (e.g., 'Added Small Passive Skills grant: 10% increased Fire Damage')",
          },
          notables: {
            type: "array",
            items: { type: "string" },
            description: "Notable passives to search for (e.g., ['Doryani\\'s Lesson', 'Prismatic Heart'])",
          },
          max_price: {
            type: "number",
            description: "Maximum price in Chaos Orbs",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default: 5)",
          },
        },
        required: ["league", "jewel_size"],
      },
    },
    {
      name: "generate_shopping_list",
      truncatable: true,
      description: "Generate a prioritized shopping list of items to upgrade for a build within a budget. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to generate shopping list for",
          },
          league: {
            type: "string",
            description: "EXACT league name as specified by user",
          },
          budget_tier: {
            type: "string",
            description: "Budget tier for recommendations (default: 'medium')",
            enum: ["budget", "medium", "endgame"],
          },
        },
        required: ["build_name", "league"],
      },
    },
  ];
}

/**
 * Get build goals/diagnostics tool schemas (require Lua bridge, no Trade API dependency)
 */
export function getBuildGoalsToolSchemas(): ToolSchema[] {
  return [
    {
      name: "get_build_issues",
      truncatable: true,
      description: "Quick issue scan: uncapped resistances, low life, over-reserved mana, incomplete spell suppression. Lighter than validate_build. Use this for a fast check; use validate_build when you want full analysis including flask immunities and damage scaling. Do NOT call both.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_passive_upgrades",
      truncatable: true,
      description: "Find the best unallocated notable passives to pick up next, ranked by their actual stat impact. Uses calcWith to simulate each candidate and scores by relative DPS/EHP gain.",
      inputSchema: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            description: "What to optimize for (default: 'both')",
            enum: ["dps", "defence", "both"],
          },
          max_results: {
            type: "number",
            description: "Maximum number of upgrade suggestions to return (default: 10)",
          },
        },
      },
    },
    {
      name: "suggest_masteries",
      truncatable: true,
      description: "Evaluate the effects available on allocated mastery nodes against the live PoB build and rank the strongest DPS and defence choices. Requires a loaded build.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "find_best_anointment",
      truncatable: true,
      description: "Rank anointable notables for an equipped Amulet or anointable Belt using upstream PoB's non-destructive live stat simulation. Requires a loaded build with the selected item equipped.",
      inputSchema: { type: "object", properties: { slot: { type: "string", enum: ["Amulet", "Belt"] }, focus: { type: "string", enum: ["dps", "defence", "both"] }, max_results: { type: "number" } }, required: ["slot"] },
    },
    {
      name: "analyze_build_cluster_jewels",
      truncatable: true,
      description: "Analyze the cluster jewels currently equipped in the build, evaluate which notables synergize with the build archetype, and flag wasted notables",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "analyze_cluster_jewels",
      description: "Analyze the cluster jewels in a saved build file: jewel size, passive count, and allocated notables. Reads the build XML directly — does not require the Lua bridge or Trade API.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build file to analyze (e.g., 'MyBuild.xml')",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "suggest_watchers_eye",
      description: "Recommend valuable Watcher's Eye jewel mods based on the build's active auras, ranked by tier (S/A/B) with best combo suggestions",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "check_boss_readiness",
      description: "Check if the loaded build meets the recommended thresholds for a specific endgame boss (Shaper, Elder, Sirus, Maven, Uber Elder, Eater of Worlds, Searing Exarch)",
      inputSchema: {
        type: "object",
        properties: {
          boss: {
            type: "string",
            description: "Boss name: 'shaper', 'elder', 'sirus', 'maven', 'uber_elder', 'eater', 'exarch', or 'pinnacle' for generic endgame",
          },
        },
        required: ["boss"],
      },
    },
    {
      name: "suggest_crafting",
      description: "Recommend the best crafting method for an item. Provide a gear slot and optionally a base type and desired mods. If a build is loaded, auto-detects the equipped base and build gaps.",
      inputSchema: {
        type: "object",
        properties: {
          slot: {
            type: "string",
            description: "Gear slot: helmet, chest, gloves, boots, weapon, offhand, ring, amulet, belt",
            enum: ["helmet", "chest", "gloves", "boots", "weapon", "offhand", "ring", "amulet", "belt"],
          },
          base: {
            type: "string",
            description: "Base item type (e.g. 'Hubris Circlet'). Auto-detected from equipped item if a build is loaded.",
          },
          desired_mods: {
            type: "array",
            items: { type: "string" },
            description: "List of desired mod descriptions (e.g. ['maximum life', 'cold resistance', 'spell damage'])",
          },
          budget: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Crafting budget: low (<50c), medium (50-500c), high (500c+)",
          },
          ilvl: {
            type: "number",
            description: "Item level — determines which mod tiers are reachable. 84+ for top tiers on most bases.",
          },
          league: {
            type: "string",
            description: "League name for currency prices (default: Standard)",
          },
        },
        required: ["slot"],
      },
    },
  ];
}

/**
 * Get poe.ninja API tool schemas
 */
export function getPoeNinjaToolSchemas(): ToolSchema[] {
  return [
    {
      name: "get_currency_rates",
      description: "Get current currency exchange rates from poe.ninja. Returns real-time market prices for all currencies in Chaos Orb equivalent. Updated every 5 minutes from live trading data. IMPORTANT: Use the EXACT league name the user specifies - do not substitute or guess.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user (e.g., 'Standard', 'Settlers', 'Keepers', 'Hardcore'). Do not substitute or change this value.",
          },
        },
        required: ["league"],
      },
    },
    {
      name: "find_arbitrage",
      description: "Find currency arbitrage opportunities - profitable trading loops where you can trade currencies in a circle and end up with more than you started. Uses real-time poe.ninja rates to identify market inefficiencies. Perfect for making passive income through currency trading. IMPORTANT: Use the EXACT league name the user specifies - do not substitute or guess.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user (e.g., 'Standard', 'Settlers', 'Keepers', 'Hardcore'). Do not substitute or change this value.",
          },
          min_profit_percent: {
            type: "number",
            description: "Minimum profit percentage to show (default: 1.0). Lower values find more opportunities but with smaller profits.",
          },
        },
        required: ["league"],
      },
    },
    {
      name: "calculate_trading_profit",
      description: "Calculate the profit/loss from a specific trading chain. Useful for testing your own trading strategies or validating arbitrage opportunities before executing them. Shows step-by-step conversion rates. IMPORTANT: Use the EXACT league name the user specifies - do not substitute or guess.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user (e.g., 'Standard', 'Settlers', 'Keepers', 'Hardcore'). Do not substitute or change this value.",
          },
          currency_chain: {
            type: "array",
            description: "Array of currency names in trading order (e.g., ['Divine Orb', 'Chaos Orb', 'Exalted Orb', 'Divine Orb'])",
            items: {
              type: "string",
            },
          },
          start_amount: {
            type: "number",
            description: "Amount of first currency to start with (default: 1)",
          },
        },
        required: ["league", "currency_chain"],
      },
    },
  ];
}
