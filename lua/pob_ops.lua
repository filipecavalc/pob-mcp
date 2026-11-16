-- Thin wrappers around PoB headless objects for programmatic operations

local Compat = ...

local M = {}

-- PoB's own config option table is the only authoritative list of valid config
-- vars and their types. Deriving from it means new upstream options work here
-- without a code change; a hand-maintained allowlist silently drifts instead.
local configVarIndex
local function getConfigVarIndex()
  if configVarIndex then return configVarIndex end
  local ok, varList = pcall(LoadModule, "Modules/ConfigOptions")
  if not ok or type(varList) ~= 'table' then return nil end
  configVarIndex = {}
  for _, varData in ipairs(varList) do
    if varData.var then
      configVarIndex[varData.var] = varData
    end
  end
  return configVarIndex
end

-- Coerce an incoming JSON value to what PoB's control for this var would store.
-- Returns value, err.
local function coerceConfigValue(varData, value)
  local t = varData.type
  if t == 'check' then
    if type(value) == 'boolean' then return value end
    if value == 'true' or value == 1 then return true end
    if value == 'false' or value == 0 then return false end
    return nil, 'expected boolean'
  elseif t == 'count' or t == 'countAllowZero' or t == 'integer' or t == 'float' then
    local n = tonumber(value)
    if not n then return nil, 'expected number' end
    return n
  elseif t == 'list' then
    -- Accept either the stored val or the human-facing label.
    for _, entry in ipairs(varData.list or {}) do
      if entry.val == value or tostring(entry.val) == tostring(value) then return entry.val end
      if entry.label and tostring(entry.label):lower() == tostring(value):lower() then return entry.val end
    end
    return nil, 'not a valid option for this list'
  end
  -- Unknown control type: store as-is rather than refusing.
  return value
end

-- Human-facing label for a stored config value, so callers see "Kill all"
-- rather than the raw "None" that PoB stores for the bandit quest.
function M.config_value_label(var, value)
  local index = getConfigVarIndex()
  local varData = index and index[var]
  if not varData or varData.type ~= 'list' then return nil end
  for _, entry in ipairs(varData.list or {}) do
    if entry.val == value or tostring(entry.val) == tostring(value) then return entry.label end
  end
  return nil
end

-- Upstream's PassiveSpec:ImportFromNodeList gained a leading className
-- parameter (9 params incl. self, up from 8). Detect which signature the
-- loaded checkout has so both old and current PoB versions work.
--
-- ImportFromNodeList also refuses to allocate a Mastery node that has no
-- effect selected in the `mastery` table, silently dropping it instead. Every
-- tree-mutation entry point (set_tree, update_tree_delta) funnels through
-- here, so the merge lives at this chokepoint: the spec's current selections
-- are merged underneath whatever the caller supplies, and caller-supplied
-- ids/effects are coerced to numbers. That way the invariant holds for every
-- caller, present and future, instead of each one having to re-implement it.
function M.import_from_node_list(spec, classId, ascendId, secondaryId, nodes, overrides, mastery, treeVersion)
  local mergedMastery = {}
  for k, v in pairs(spec.masterySelections or {}) do mergedMastery[k] = v end
  if type(mastery) == 'table' then
    for nodeId, effectId in pairs(mastery) do
      mergedMastery[tonumber(nodeId) or nodeId] = tonumber(effectId) or effectId
    end
  end

  local info = debug and debug.getinfo and debug.getinfo(spec.ImportFromNodeList, 'u')
  if info and info.nparams and info.nparams >= 9 then
    return spec:ImportFromNodeList(nil, classId, ascendId, secondaryId, nodes, overrides or {}, mergedMastery, treeVersion)
  end
  return spec:ImportFromNodeList(classId, ascendId, secondaryId, nodes, overrides or {}, mergedMastery, treeVersion)
end

local MIN_PLAYER_LEVEL = 1
local MAX_PLAYER_LEVEL = 100
local NUM_FLASK_SLOTS = 5
local MAX_ITEM_TEXT_LENGTH = 10240  -- 10KB

function M.get_main_output()
  if not build or not build.calcsTab then
    return nil, "build not initialized"
  end
  if build.calcsTab.BuildOutput then
    build.calcsTab:BuildOutput()
  end
  local output = build.calcsTab and build.calcsTab.mainOutput or nil
  if not output then
    return nil, "no output available"
  end
  return output
end

-- PoB colour codes are display-only: "^8" for grey, "^xRRGGBB" for literal.
local function stripColourCodes(text)
  if type(text) ~= 'string' then return text end
  return (text:gsub('%^[xX]%x%x%x%x%x%x', ''):gsub('%^%d', ''))
end

local function leadingNumber(text)
  return tonumber(tostring(stripColourCodes(text)):match('%-?%d+%.?%d*') or '')
end

-- PoB only *applies* a non-damaging ailment to the enemy when the source is
-- guaranteed (a ShockBase/Override/Minimum mod) or when the player has filled
-- in the matching "Effect of X" config. A chance-to-shock skill produces
-- neither, so output.CurrentShock stays 0 and every downstream number silently
-- ignores the ailment. The magnitude the skill would actually inflict is
-- computed in CalcOffence, but only into the CALCS-mode breakdown table, never
-- into output. Read it back out so callers can see both halves.
--
-- breakdown[<Ailment>DPS].rowList is an effect-by-enemy-threshold curve. The
-- one row whose threshold carries a colour-coded tag is the enemy currently
-- configured; the rest are reference points.
local function readAilmentBreakdown(breakdown, ailment)
  local rows = breakdown and breakdown[ailment .. 'DPS'] and breakdown[ailment .. 'DPS'].rowList
  if type(rows) ~= 'table' then return nil, nil end
  local table_, atConfiguredEnemy = {}, nil
  for _, row in ipairs(rows) do
    local threshold = leadingNumber(row.thresh)
    local effect = leadingNumber(row.effect)
    if threshold and effect then
      local isConfiguredEnemy = type(row.thresh) == 'string' and row.thresh:find('%^') ~= nil
      table_[#table_ + 1] = {
        ailmentThreshold = threshold,
        effect = effect,
        note = stripColourCodes(row.effect):match('%((.-)%)'),
        isConfiguredEnemy = isConfiguredEnemy or nil,
      }
      if isConfiguredEnemy then atConfiguredEnemy = effect end
    end
  end
  if #table_ == 0 then return nil, nil end
  return table_, atConfiguredEnemy
end

-- PoB names the enemy-ailment config vars five different ways
-- (conditionShockEffect but conditionEnemyChilledEffect but
-- conditionScorchedEffect...), so guessing them from the ailment name is wrong
-- for most of them. Derive both vars from the option list itself: the effect
-- control is a 'count' gated on the enemy condition it belongs to, and that
-- gate names the ailment.
local ailmentConfigIndex
local function getAilmentConfigIndex()
  if ailmentConfigIndex then return ailmentConfigIndex end
  ailmentConfigIndex = {}
  local ok, varList = pcall(LoadModule, "Modules/ConfigOptions")
  if not ok or type(varList) ~= 'table' then return ailmentConfigIndex end
  for _, varData in ipairs(varList) do
    local gate = varData.var and varData.type == 'count' and varData.ifOption
    local suffix = type(gate) == 'string' and gate:match('^conditionEnemy(%a+)$')
    -- More than one count control hangs off the same gate (ShockStacks shares
    -- conditionEnemyShocked with the effect field), so match the label too.
    local isEffectControl = suffix
      and stripColourCodes(varData.label or ''):match('^Effect of') ~= nil
    if isEffectControl then
      -- "Shocked" -> Shock, "Scorched" -> Scorch, "Brittle" -> Brittle.
      -- Longest match wins so a future ailment cannot shadow a shorter name.
      local best
      for name in pairs((data and data.nonDamagingAilment) or {}) do
        if suffix:sub(1, #name) == name and (not best or #name > #best) then best = name end
      end
      if best then
        ailmentConfigIndex[best] = { effectVar = varData.var, enabledVar = gate }
      end
    end
  end
  return ailmentConfigIndex
end

function M.get_ailments()
  local output, err = M.get_main_output()
  if not output then return nil, err end
  local configInput = build.configTab and build.configTab.input or {}
  local configIndex = getAilmentConfigIndex()
  -- BuildOutput populates two environments; the breakdown only exists in the
  -- CALCS-mode one, and get_main_output hands back the MAIN-mode output.
  local env = build.calcsTab.calcsEnv
  local breakdown = env and env.player and env.player.breakdown or nil

  -- Freeze is the one non-damaging ailment measured in seconds rather than as
  -- an effect magnitude, and CalcPerform's ailment loop skips it for that
  -- reason. It is also the only entry with no default magnitude, so filter on
  -- the data rather than hardcoding a list that would drift.
  local names = {}
  for name, ailment in pairs((data and data.nonDamagingAilment) or {}) do
    if ailment.default ~= nil then names[#names + 1] = name end
  end
  table.sort(names)

  local result = {}
  for _, name in ipairs(names) do
    local chanceOnHit = tonumber(output[name .. 'ChanceOnHit']) or 0
    local chanceOnCrit = tonumber(output[name .. 'ChanceOnCrit']) or 0
    if chanceOnHit > 0 or chanceOnCrit > 0 or (tonumber(output['Current' .. name]) or 0) > 0 then
      local thresholdTable, calculated = readAilmentBreakdown(breakdown, name)
      local applied = tonumber(output['Current' .. name]) or 0
      -- Below the game's minimum the ailment does not land at all, so a small
      -- calculatedEffect must not be read as "a small amount of shock".
      local minimum = data.nonDamagingAilment[name].min
      local config = configIndex[name] or {}
      result[#result + 1] = {
        name = name,
        chanceOnHit = chanceOnHit,
        chanceOnCrit = chanceOnCrit,
        effectMod = tonumber(output[name .. 'EffectMod']),
        duration = tonumber(output[name .. 'Duration']),
        minimumEffect = minimum,
        maximumEffect = tonumber(output['Maximum' .. name]),
        appliedEffect = applied,
        calculatedEffect = calculated,
        -- Scorch, Brittle and Sap have a minimum of 0, so a zero magnitude
        -- would otherwise read as "lands" and raise a warning about nothing.
        landsOnConfiguredEnemy = (calculated ~= nil and calculated > 0
          and calculated >= (minimum or 0)) or nil,
        creditedInCalc = applied > 0,
        effectConfigVar = config.effectVar,
        enabledConfigVar = config.enabledVar,
        enabledOnEnemy = config.enabledVar ~= nil
          and configInput[config.enabledVar] == true or nil,
        thresholdTable = thresholdTable,
      }
    end
  end
  return { ailments = result }
end

function M.export_stats(fields)
  local output, err = M.get_main_output()
  if not output then
    return nil, err
  end
  -- Callers that pass no field list get this set, so it has to answer "how is
  -- this build doing" on both axes. Damage was missing entirely, which made
  -- every such caller report a build as if it dealt none.
  local wanted = fields or {
    "TotalDPS", "CombinedDPS", "FullDPS", "AverageDamage", "Speed",
    "CritChance", "CritMultiplier",
    "Life", "EnergyShield", "Armour", "Evasion",
    "FireResist", "ColdResist", "LightningResist", "ChaosResist",
    "BlockChance", "SpellBlockChance",
    "LifeRegen", "Mana", "ManaRegen", "ManaUnreserved",
    "Ward", "DodgeChance", "SpellDodgeChance",
    "TotalEHP", "PhysicalDamageReduction",
    "AttackDodgeChance", "EffectiveMovementSpeedMod",
    "SpellSuppressionChance", "LifeLeechGainRate", "ManaLeechGainRate",
    "EnduranceChargesMax", "FrenzyChargesMax", "PowerChargesMax",
  }
  local result = {}
  for _, k in ipairs(wanted) do
    if type(output[k]) ~= 'nil' then
      result[k] = output[k]
    end
  end
  local minionOutput = output.Minion
  if minionOutput and type(minionOutput) == 'table' then
    local minionWanted = {
      "Life", "EnergyShield", "Armour", "Evasion",
      "TotalDPS", "CombinedDPS", "AverageDamage", "Speed",
      "FireResist", "ColdResist", "LightningResist", "ChaosResist",
      "BlockChance", "PhysicalDamageReduction",
    }
    for _, k in ipairs(minionWanted) do
      if type(minionOutput[k]) ~= 'nil' then
        result["Minion" .. k] = minionOutput[k]
      end
    end
  end
  result._meta = result._meta or {}
  if build and build.targetVersion then
    result._meta.treeVersion = tostring(build.targetVersion)
  end
  if build and build.characterLevel then
    result._meta.level = tonumber(build.characterLevel)
  end
  if build and build.buildName then
    result._meta.buildName = tostring(build.buildName)
  end
  return result
end

function M.get_tree()
  if not build or not build.spec then
    return nil, "build/spec not initialized"
  end
  local spec = build.spec
  local out = {
    treeVersion = spec.treeVersion,
    classId = tonumber(spec.curClassId) or 0,
    ascendClassId = tonumber(spec.curAscendClassId) or 0,
    secondaryAscendClassId = tonumber(spec.curSecondaryAscendClassId or 0) or 0,
    nodes = {},
    masteryEffects = {},
  }
  local ascendancyPointsUsed = 0
  for id, _ in pairs(spec.allocNodes or {}) do
    table.insert(out.nodes, id)
    -- Ascendancy points spent = allocated ascendancy nodes, minus the free
    -- ascendancy-start node every chosen ascendancy grants. TS-side guards
    -- (max-8 cap, unspent-point estimates) treat it exactly this way.
    local node = spec.nodes and spec.nodes[id]
    if node and node.ascendancyName and node.isAscendancyStart ~= true then
      ascendancyPointsUsed = ascendancyPointsUsed + 1
    end
  end
  out.ascendancyPointsUsed = ascendancyPointsUsed
  for mastery, effect in pairs(spec.masterySelections or {}) do
    out.masteryEffects[mastery] = effect
  end
  table.sort(out.nodes)
  return out
end

-- params: { classId, ascendClassId, secondaryAscendClassId?, nodes:[int], masteryEffects?:{[id]=effect}, treeVersion? }
function M.set_tree(params)
  if not build or not build.spec then
    return nil, "build/spec not initialized"
  end
  if type(params) ~= 'table' then
    return nil, "invalid params"
  end
  local classId = tonumber(params.classId or 0) or 0
  local ascendId = tonumber(params.ascendClassId or 0) or 0
  local secondaryId = tonumber(params.secondaryAscendClassId or 0) or 0
  local nodes = {}
  if type(params.nodes) == 'table' then
    for _, v in ipairs(params.nodes) do
      table.insert(nodes, tonumber(v))
    end
  end
  local mastery = params.masteryEffects or {}
  local treeVersion = params.treeVersion
  -- Pass the spec's tattoos (hashOverrides) back in: ImportFromNodeList replaces them with its argument.
  M.import_from_node_list(build.spec, classId, ascendId, secondaryId, nodes, build.spec.hashOverrides, mastery, treeVersion)
  M.get_main_output()
  return true
end

function M.export_build_xml()
  if not build or not build.SaveDB then
    return nil, 'build not initialized'
  end
  local xml = build:SaveDB('api-export')
  if not xml then return nil, 'failed to compose xml' end
  return xml
end

function M.set_level(level)
  if not build or not build.configTab then
    return nil, 'build/config not initialized'
  end
  local lvl = tonumber(level)
  if not lvl or lvl < MIN_PLAYER_LEVEL or lvl > MAX_PLAYER_LEVEL then
    return nil, string.format('invalid level (must be %d-%d)', MIN_PLAYER_LEVEL, MAX_PLAYER_LEVEL)
  end
  build.characterLevel = lvl
  build.characterLevelAutoMode = false
  if build.configTab and build.configTab.BuildModList then
    build.configTab:BuildModList()
  end
  M.get_main_output()
  return true
end

function M.get_build_info()
  if not build then return nil, 'build not initialized' end
  local info = {
    name = build.buildName,
    level = build.characterLevel,
    className = build.spec and build.spec.curClassName or nil,
    ascendClassName = build.spec and build.spec.curAscendClassName or nil,
    treeVersion = build.targetVersion or (build.spec and build.spec.treeVersion) or nil,
  }
  return info
end

function M.update_tree_delta(params)
  if not build or not build.spec then return nil, 'build/spec not initialized' end
  local current, err = M.get_tree()
  if not current then return nil, err end
  local set = {}
  for _, id in ipairs(current.nodes) do set[id] = true end
  if params and type(params.removeNodes) == 'table' then
    for _, id in ipairs(params.removeNodes) do set[tonumber(id)] = nil end
  end
  if params and type(params.addNodes) == 'table' then
    for _, id in ipairs(params.addNodes) do set[tonumber(id)] = true end
  end
  local nodes = {}
  for id,_ in pairs(set) do table.insert(nodes, id) end
  table.sort(nodes)

  local classId = params.classId or current.classId or 0
  local ascendId = params.ascendClassId or current.ascendClassId or 0
  local secId = params.secondaryAscendClassId or current.secondaryAscendClassId or 0
  local tv = params.treeVersion or current.treeVersion
  -- import_from_node_list merges the spec's existing mastery selections
  -- underneath params.masteryEffects itself, so a bare pass-through is enough.
  -- Keep the spec's tattoos (hashOverrides); ImportFromNodeList replaces them with its argument.
  M.import_from_node_list(build.spec, tonumber(classId) or 0, tonumber(ascendId) or 0, tonumber(secId) or 0, nodes, build.spec.hashOverrides, params and params.masteryEffects, tv)
  M.get_main_output()

  -- Report what PoB actually allocated. Requesting a node is not the same as
  -- getting it: disconnected nodes and effect-less masteries are dropped.
  local after = M.get_tree()
  local allocated = {}
  for _, id in ipairs(after and after.nodes or {}) do allocated[id] = true end
  local dropped = {}
  if params and type(params.addNodes) == 'table' then
    for _, id in ipairs(params.addNodes) do
      local n = tonumber(id)
      if n and not allocated[n] then table.insert(dropped, n) end
    end
  end
  return { tree = after, droppedNodes = dropped }
end


-- PoB's calculation output is a live object graph: actors link back to their
-- parents and to shared ModStores, so it contains reference cycles. Handing it
-- straight to json.encode raises "reference cycle", which is an uncaught error
-- that takes the whole bridge process down. Copy out a JSON-safe projection:
-- scalars only, cycles broken, depth bounded.
local SANITIZE_MAX_DEPTH = 4
local function sanitizeForJson(value, depth, seen)
  local t = type(value)
  if t == 'string' or t == 'boolean' then return value end
  if t == 'number' then
    -- dkjson also refuses NaN and +/-inf.
    if value ~= value or value == math.huge or value == -math.huge then return nil end
    return value
  end
  if t ~= 'table' then return nil end
  if depth >= SANITIZE_MAX_DEPTH then return nil end
  if seen[value] then return nil end
  seen[value] = true
  local out = nil
  for k, v in pairs(value) do
    local kt = type(k)
    if kt == 'string' or kt == 'number' then
      local clean = sanitizeForJson(v, depth + 1, seen)
      if clean ~= nil then
        out = out or {}
        out[k] = clean
      end
    end
  end
  seen[value] = nil
  return out
end

function M.sanitize_for_json(value)
  return sanitizeForJson(value, 0, {})
end

-- A node this build could actually take: on the passive tree proper, or in the
-- build's own ascendancy. Mastery nodes are excluded because allocating one
-- without an effect selection is a no-op (see PassiveSpec:ImportFromNodeList).
function M.is_allocatable(node)
  if type(node) ~= 'table' then return false end
  if node.type == 'Mastery' or node.isMastery then return false end
  if node.type == 'ClassStart' or node.classStartIndex then return false end
  if node.isProxy then return false end
  local asc = node.ascendancyName
  if asc and asc ~= '' then
    local own = build and build.spec and build.spec.curAscendClassName
    if not own or own == '' or asc ~= own then return false end
  end
  return true
end

-- params: { addNodes?: number[], removeNodes?: number[], masteryEffects?: {[nodeId]: effectId},
--           repItem?: string (item text), repSlotName?: string, toggleFlask?: number (1-NUM_FLASK_SLOTS),
--           useFullDPS?: boolean }
function M.calc_with(params)
  if not build or not build.calcsTab then return nil, 'build not initialized' end
  local calcFunc, baseOut = build.calcsTab:GetMiscCalculator()
  local override = {}
  if params and (params.repItem ~= nil or params.repSlotName ~= nil) then
    if type(params.repItem) ~= 'string' or type(params.repSlotName) ~= 'string' then
      return nil, 'repItem (item text) and repSlotName must be given together'
    end
    if #params.repItem == 0 then return nil, 'repItem text cannot be empty' end
    if #params.repItem > MAX_ITEM_TEXT_LENGTH then
      return nil, string.format('repItem text too long (max %d bytes)', MAX_ITEM_TEXT_LENGTH)
    end
    -- CalcSetup matches repSlotName against itemsTab slot names, not base types.
    -- A name it never matches ("Ring", "Chest") calculates happily and returns the
    -- unchanged build, so reject it here rather than report a zero delta as truth.
    if not (build.itemsTab and build.itemsTab.slots and build.itemsTab.slots[params.repSlotName]) then
      return nil, 'unknown slot: ' .. params.repSlotName
    end
    local parsed, item = pcall(Compat.construct, 'Item', params.repItem)
    if not parsed then return nil, 'invalid item text: ' .. tostring(item) end
    if not item or not item.baseName then return nil, 'failed to parse item' end
    M.apply_item_quality(item, params.assumeMaxQuality == true)
    -- Quality moves the item's mods, so rebuild them as ItemsTab does after normalising.
    item:BuildModList()
    override.repSlotName = params.repSlotName
    override.repItem = item
  end
  if params and params.toggleFlask ~= nil then
    local idx = tonumber(params.toggleFlask)
    if not idx or idx < 1 or idx > NUM_FLASK_SLOTS then
      return nil, string.format('invalid flask index (must be 1-%d)', NUM_FLASK_SLOTS)
    end
    local slot = build.itemsTab and build.itemsTab.slots and build.itemsTab.slots['Flask ' .. tostring(idx)]
    -- The override toggles membership of env.flasks, so handing it an item that is
    -- not in the slot would switch a flask ON that the character does not carry.
    local flask = slot and slot.selItemId and build.itemsTab.items[slot.selItemId]
    if not flask then return nil, 'no flask equipped in Flask ' .. tostring(idx) end
    override.toggleFlask = flask
  end
  if params and type(params.addNodes) == 'table' then
    override.addNodes = {}
    for _, id in ipairs(params.addNodes) do
      local n = build.spec and build.spec.nodes and build.spec.nodes[tonumber(id)]
      -- spec.nodes holds every node on the tree, including other classes'
      -- ascendancies. Simulating one of those is not a meaningful "what if"
      -- and can take the calculator down, so only consider allocatable nodes.
      if n and M.is_allocatable(n) then override.addNodes[n] = true end
    end
  end
  if params and type(params.removeNodes) == 'table' then
    override.removeNodes = {}
    for _, id in ipairs(params.removeNodes) do
      local n = build.spec and build.spec.nodes and build.spec.nodes[tonumber(id)]
      if n then override.removeNodes[n] = true end
    end
  end
  -- Temporarily override mastery selections for simulation
  local origMastery = nil
  if params and type(params.masteryEffects) == 'table' then
    origMastery = {}
    for k, v in pairs(build.spec.masterySelections or {}) do
      origMastery[k] = v
    end
    build.spec.masterySelections = build.spec.masterySelections or {}
    for nodeId, effectId in pairs(params.masteryEffects) do
      build.spec.masterySelections[tonumber(nodeId)] = effectId
    end
  end
  -- pcall returns (ok, result...): the first value is the success flag, not
  -- the stats table. Reading it as the result made every simulation silently
  -- return the caller's CURRENT stats regardless of the override.
  local calcOk, out = pcall(calcFunc, override, params and params.useFullDPS)
  -- Restore original mastery selections on EVERY path: if calcFunc raised and
  -- we skipped the restore, the next get_tree/save_build would report and
  -- persist masteries the caller never committed.
  if origMastery then
    build.spec.masterySelections = origMastery
  end
  if not calcOk then
    return nil, 'calc_with failed: ' .. tostring(out)
  end
  -- The MiscCalculator returns a metatable-backed live object: `pairs()` on it
  -- yields only hand-set keys (nothing), so a direct sanitize would return an
  -- empty object. A table copy strips the metatable so pairs() exposes every
  -- computed stat.
  local function shallowcopy(t)
    local copy = {}
    for k, v in pairs(t) do copy[k] = v end
    return copy
  end
  -- No fallback to baseline stats here: a simulation that produced no stats
  -- table must fail loudly, not pose as the unmodified build.
  if type(out) ~= 'table' then
    return nil, 'calc_with produced no stats table'
  end
  return M.sanitize_for_json(shallowcopy(out)), M.sanitize_for_json(shallowcopy(baseOut))
end


function M.get_config()
  if not build or not build.configTab then return nil, 'build/config not initialized' end
  local input = build.configTab.input
  local cfg = {}
  -- Serialize the full config input table (JSON-encodable values only)
  if type(input) == 'table' then
    for k, v in pairs(input) do
      local vt = type(v)
      if type(k) == 'string' and (vt == 'string' or vt == 'number' or vt == 'boolean') then
        cfg[k] = v
      end
    end
  end
  -- Keep original keys for backward compatibility
  cfg.bandit = (input and input.bandit) or build.bandit
  cfg.pantheonMajorGod = (input and input.pantheonMajorGod) or build.pantheonMajorGod
  cfg.pantheonMinorGod = (input and input.pantheonMinorGod) or build.pantheonMinorGod
  cfg.enemyLevel = build.configTab.enemyLevel
  return cfg
end

-- Dropdown options store a val that often differs from what the UI shows: the
-- bandit quest stores "None" but reads "Kill all". Expose the labels so callers
-- can display what PoB displays instead of the raw stored value.
function M.get_config_labels()
  local cfg, err = M.get_config()
  if not cfg then return nil, err end
  local labels = {}
  for k, v in pairs(cfg) do
    local label = M.config_value_label(k, v)
    if label then labels[k] = label end
  end
  return labels
end

function M.set_config(params)
  if not build or not build.configTab then return nil, 'build/config not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  local input = build.configTab.input or {}
  build.configTab.input = input
  local index = getConfigVarIndex()
  if not index then return nil, 'could not load PoB config options' end

  local applied, rejected = {}, {}
  local changed = false
  -- PoB's saved-XML import (ConfigTab) maps legacy boss names onto the
  -- current enemyIsBoss list ('Uber Atziri'->'Boss', 'Shaper'/'Sirus' ->
  -- 'Pinnacle'). Doing the same here keeps the tool contract stable for
  -- callers who still speak the old names, instead of failing with
  -- 'not a valid option for this list' while the UI accepts the build file.
  local LEGACY_BOSS_ALIASES = {
    ['shaper'] = 'Pinnacle',
    ['sirus'] = 'Pinnacle',
    ['uber atziri'] = 'Boss',
    ['atziri'] = 'Boss',
  }
  for key, value in pairs(params) do
    if key == 'enemyIsBoss' and type(value) == 'string' then
      local alias = LEGACY_BOSS_ALIASES[value:lower()]
      if alias then value = alias end
    end
    -- enemyLevel lives on the tab itself, not in the input table.
    if key == 'enemyLevel' then
      local n = tonumber(value)
      if n then
        build.configTab.enemyLevel = n
        applied[key] = n
        changed = true
      else
        rejected[key] = 'expected number'
      end
    elseif key == 'customMods' then
      -- PoB's old single "customMods" box: ConfigTab:Load moves it into the
      -- first custom modifier group, so it sets that group's text here.
      if type(value) ~= 'string' then
        rejected[key] = 'expected the modifier text'
      else
        local res, err = M.set_custom_mods({ groupIndex = 1, text = value })
        if res then applied[key] = res.groups[1] and res.groups[1].text or value else rejected[key] = err end
      end
    elseif index[key] then
      local coerced, err = coerceConfigValue(index[key], value)
      if err then
        rejected[key] = err
      else
        input[key] = coerced
        applied[key] = coerced
        changed = true
      end
    else
      rejected[key] = 'unknown config option'
    end
  end

  if changed and build.configTab.BuildModList then build.configTab:BuildModList() end
  M.get_main_output()
  return { applied = applied, rejected = rejected }
end


function M.get_skills()
  if not build or not build.skillsTab or not build.calcsTab then return nil, 'skills not initialized' end
  local groups = {}
  for idx, g in ipairs(build.skillsTab.socketGroupList or {}) do
    local names = {}
    if g.displaySkillList then
      for _, eff in ipairs(g.displaySkillList) do
        if eff and eff.activeEffect and eff.activeEffect.grantedEffect then
          table.insert(names, eff.activeEffect.grantedEffect.name)
        end
      end
    end
    local gems = {}
    if g.gemList then
      for gemIdx, gem in ipairs(g.gemList) do
        table.insert(gems, {
          index = gemIdx,
          name = gem.nameSpec or gem.name or '',
          level = gem.level or 1,
          quality = gem.quality or 0,
          qualityId = gem.qualityId or 'Default',
          enabled = gem.enabled ~= false,
          isSupport = gem.skillId and gem.skillId:find('Support') ~= nil or false,
        })
      end
    end
    table.insert(groups, {
      index = idx,
      label = g.label,
      slot = g.slot,
      enabled = g.enabled,
      includeInFullDPS = g.includeInFullDPS,
      mainActiveSkill = g.mainActiveSkill,
      skills = names,
      gems = gems,
    })
  end
  local result = {
    mainSocketGroup = build.mainSocketGroup,
    calcsSkillNumber = build.calcsTab.input and build.calcsTab.input.skill_number or nil,
    groups = groups,
  }
  return result
end

function M.set_main_selection(params)
  if not build or not build.skillsTab or not build.calcsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if params.mainSocketGroup ~= nil then
    build.mainSocketGroup = tonumber(params.mainSocketGroup) or build.mainSocketGroup
  end
  local g = build.skillsTab.socketGroupList[build.mainSocketGroup]
  if not g then return nil, 'invalid mainSocketGroup' end
  if params.mainActiveSkill ~= nil then
    g.mainActiveSkill = tonumber(params.mainActiveSkill) or g.mainActiveSkill
  end
  if params.skillPart ~= nil then
    local idx = g.mainActiveSkill or 1
    local src = g.displaySkillList and g.displaySkillList[idx] and g.displaySkillList[idx].activeEffect and g.displaySkillList[idx].activeEffect.srcInstance
    if src then src.skillPart = tonumber(params.skillPart) end
  end
  -- Keep calcsTab in sync: use active group index
  build.calcsTab.input.skill_number = build.mainSocketGroup
  M.get_main_output()
  return true
end

-- PoB's NormaliseQuality (Item.lua) raises any armour, weapon or flask
-- without a Unique ID that is not corrupted, split or mirrored to 20%
-- quality: the desktop paste box assumes you will quality what you craft.
-- Item text copied in game carries no Unique ID, so a 0% listing would be
-- valued as 20%. By default an item keeps the quality its text states (none
-- stated means 0, as NormaliseQuality's own first branch does); pass
-- assumeMaxQuality to get PoB's assumption.
function M.apply_item_quality(item, assumeMaxQuality)
  if assumeMaxQuality then
    item:NormaliseQuality()
  elseif item.quality == nil and item.base and (item.base.armour or item.base.weapon or item.base.flask or item.base.tincture) then
    item.quality = 0
  end
end

function M.add_item_text(params)
  if not build or not build.itemsTab then return nil, 'items not initialized' end
  if type(params) ~= 'table' or type(params.text) ~= 'string' then return nil, 'missing text' end

  if #params.text == 0 then return nil, 'item text cannot be empty' end
  if #params.text > MAX_ITEM_TEXT_LENGTH then
    return nil, string.format('item text too long (max %d bytes)', MAX_ITEM_TEXT_LENGTH)
  end

  local ok, item = pcall(Compat.construct, 'Item', params.text)
  if not ok then return nil, 'invalid item text: ' .. tostring(item) end
  if not item or not item.baseName then return nil, 'failed to parse item' end

  M.apply_item_quality(item, params.assumeMaxQuality == true)
  build.itemsTab:AddItem(item, params.noAutoEquip == true)
  if params.slotName then
    local slot = tostring(params.slotName)
    if not build.itemsTab.slots[slot] then
      -- Never claim a slot we did not equip into: an unknown name used to
      -- fall through silently while the response echoed the requested slot.
      -- The item IS already in the build (above), so say so - a plain error
      -- would invite a retry that duplicates the item.
      return nil, string.format('unknown slot "%s" (item was added to the build as id %d but NOT equipped) - use the exact slot names reported by get_equipped_items (they vary with the PoB version)', slot, item.id)
    end
    build.itemsTab.slots[slot]:SetSelItemId(item.id)
    build.itemsTab:PopulateSlots()
  end
  build.itemsTab:AddUndoState()
  build.buildFlag = true
  M.get_main_output()
  return { id = item.id, name = item.name, slot = params.slotName or item:GetPrimarySlot() }
end

function M.set_flask_active(params)
  if not build or not build.itemsTab then return nil, 'items not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  local idx = tonumber(params.index)
  local active = params.active == true
  if not idx or idx < 1 or idx > NUM_FLASK_SLOTS then
    return nil, string.format('invalid flask index (must be 1-%d)', NUM_FLASK_SLOTS)
  end
  local slotName = 'Flask ' .. tostring(idx)
  if not build.itemsTab.activeItemSet or not build.itemsTab.activeItemSet[slotName] then return nil, 'slot not found' end
  build.itemsTab.activeItemSet[slotName].active = active
  -- Re-populate slots so flask effects are applied before recalculating
  if build.itemsTab.PopulateSlots then
    build.itemsTab:PopulateSlots()
  end
  if build.configTab and build.configTab.BuildModList then
    build.configTab:BuildModList()
  end
  build.itemsTab:AddUndoState()
  build.buildFlag = true
  M.get_main_output()
  return true
end


function M.get_items()
  if not build or not build.itemsTab then return nil, 'items not initialized' end
  local itemsTab = build.itemsTab
  local result = { }
  -- Prefer orderedSlots for deterministic order
  local ordered = itemsTab.orderedSlots or {}
  local seen = {}
  local function add_slot(slotName)
    if seen[slotName] then return end
    seen[slotName] = true
    local slotCtrl = itemsTab.slots[slotName]
    if not slotCtrl then return end
    local selId = slotCtrl.selItemId or 0
    local entry = { slot = slotName, id = selId }
    -- PoB's own slot visibility gate (Control:IsShown evaluates .shown, a
    -- boolean or function): ItemsTab hides Ring 3 (AdditionalRingSlot flag),
    -- Graft 1/2 (pre-3_27 trees) and the inactive weapon-set variants.
    -- Consumers need shown=false to tell "empty" from "does not apply to
    -- this build". A gate that errors stays shown: analysis must not
    -- silently lose data.
    local gate = slotCtrl.shown
    local vis = true
    if type(gate) == 'function' then
      local okGate, v = pcall(gate)
      if okGate then
        vis = v ~= false and v ~= nil
      else
        -- A failing gate stays shown so analysis never loses data silently,
        -- EXCEPT the version-flagged slots: their gates dereference calcs
        -- state (Ring 3 reads mainEnv.modDB) that may not exist yet, and a
        -- wrongly-shown Ring 3 is the exact false 'slot is empty' this
        -- gate exists to prevent. For those three, unknown means hidden.
        vis = not (slotName == 'Ring 3' or slotName == 'Graft 1' or slotName == 'Graft 2')
      end
    elseif gate ~= nil then
      vis = gate ~= false
    end
    entry.shown = vis
    if selId > 0 then
      local it = itemsTab.items[selId]
      if it then
        entry.name = it.name
        entry.baseName = it.baseName
        entry.type = it.type
        entry.rarity = it.rarity
        entry.raw = it.raw
      end
    end
    -- Flask/Tincture activation flag stored in activeItemSet
    local set = itemsTab.activeItemSet
    if set and set[slotName] and set[slotName].active ~= nil then
      entry.active = set[slotName].active and true or false
    end
    table.insert(result, entry)
  end
  for _, slot in ipairs(ordered) do
    if slot and slot.slotName then add_slot(slot.slotName) end
  end
  -- Add any remaining slots not in ordered list
  for slotName, _ in pairs(itemsTab.slots or {}) do add_slot(slotName) end
  return result
end


-- params: { label?: string, slot?: string, enabled?: boolean, includeInFullDPS?: boolean }
function M.create_socket_group(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then params = {} end

  local socketGroup = {
    label = params.label or '',
    slot = params.slot,
    enabled = params.enabled ~= false,
    includeInFullDPS = params.includeInFullDPS == true,
    gemList = {},
    mainActiveSkill = 1,
    mainActiveSkillCalcs = 1,
  }

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  table.insert(skillSet.socketGroupList, socketGroup)
  local index = #skillSet.socketGroupList

  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end

  build.buildFlag = true
  M.get_main_output()

  return { index = index, label = socketGroup.label }
end

-- params: { groupIndex: number, gemName: string, level?: number, quality?: number, qualityId?: string, enabled?: boolean }
function M.add_gem(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if not params.groupIndex or not params.gemName then return nil, 'missing groupIndex or gemName' end

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  local groupIndex = tonumber(params.groupIndex)
  local socketGroup = skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found at index ' .. tostring(groupIndex) end

  local gemInstance = {
    nameSpec = tostring(params.gemName),
    level = tonumber(params.level) or 20,
    quality = tonumber(params.quality) or 0,
    qualityId = params.qualityId or 'Default',
    enabled = params.enabled ~= false,
    enableGlobal1 = true,
    enableGlobal2 = false,
    count = tonumber(params.count) or 1,
  }

  if build.data and build.data.gems then
    for _, gemData in pairs(build.data.gems) do
      if gemData.name == gemInstance.nameSpec or gemData.nameSpec == gemInstance.nameSpec then
        gemInstance.gemId = gemData.id
        if gemData.grantedEffect then
          gemInstance.skillId = gemData.grantedEffect.id
        elseif gemData.grantedEffectId then
          gemInstance.skillId = gemData.grantedEffectId
        end
        gemInstance.gemData = gemData
        break
      end
    end
  end

  table.insert(socketGroup.gemList, gemInstance)
  local gemIndex = #socketGroup.gemList

  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end

  build.buildFlag = true
  M.get_main_output()

  return { gemIndex = gemIndex, name = gemInstance.nameSpec }
end

-- params: { groupIndex: number, gemIndex: number, level: number }
function M.set_gem_level(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if not params.groupIndex or not params.gemIndex or not params.level then
    return nil, 'missing groupIndex, gemIndex, or level'
  end

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  local groupIndex = tonumber(params.groupIndex)
  local gemIndex = tonumber(params.gemIndex)
  local level = tonumber(params.level)

  local socketGroup = skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found' end

  local gemInstance = socketGroup.gemList[gemIndex]
  if not gemInstance then return nil, 'gem not found' end

  if level < 1 or level > 40 then return nil, 'invalid level (must be 1-40)' end

  gemInstance.level = level

  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end

  build.buildFlag = true
  M.get_main_output()

  return true
end

-- params: { groupIndex: number, gemIndex: number, quality: number, qualityId?: string }
function M.set_gem_quality(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if not params.groupIndex or not params.gemIndex or not params.quality then
    return nil, 'missing groupIndex, gemIndex, or quality'
  end

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  local groupIndex = tonumber(params.groupIndex)
  local gemIndex = tonumber(params.gemIndex)
  local quality = tonumber(params.quality)

  local socketGroup = skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found' end

  local gemInstance = socketGroup.gemList[gemIndex]
  if not gemInstance then return nil, 'gem not found' end

  if quality < 0 or quality > 23 then return nil, 'invalid quality (must be 0-23)' end

  gemInstance.quality = quality
  if params.qualityId then
    gemInstance.qualityId = tostring(params.qualityId)
  end

  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end

  build.buildFlag = true
  M.get_main_output()

  return true
end

-- params: { groupIndex: number }
function M.remove_skill(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if not params.groupIndex then return nil, 'missing groupIndex' end

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  local groupIndex = tonumber(params.groupIndex)
  local socketGroup = skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found' end

  -- Don't allow removing special groups with sources
  if socketGroup.source then
    return nil, 'cannot remove special socket groups (item/node granted skills)'
  end

  table.remove(skillSet.socketGroupList, groupIndex)

  build.buildFlag = true
  M.get_main_output()

  return true
end

-- params: { groupIndex: number, gemIndex: number }
function M.remove_gem(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if not params.groupIndex or not params.gemIndex then
    return nil, 'missing groupIndex or gemIndex'
  end

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  local groupIndex = tonumber(params.groupIndex)
  local gemIndex = tonumber(params.gemIndex)

  local socketGroup = skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found' end

  local gemInstance = socketGroup.gemList[gemIndex]
  if not gemInstance then return nil, 'gem not found' end

  table.remove(socketGroup.gemList, gemIndex)

  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end

  build.buildFlag = true
  M.get_main_output()

  return true
end


-- params: { path: string }
function M.save_build(params)
  if not build or not build.SaveDB then
    return nil, 'build not initialized'
  end
  if type(params) ~= 'table' or type(params.path) ~= 'string' or params.path == '' then
    return nil, 'missing or invalid path'
  end

  -- Sync curAscendClassName from the current ascendClassId so the Build XML
  -- element always reflects the live state (guards against stale names after
  -- set_tree or new_build with a different ascendancy).
  if build.spec and build.spec.curClass and build.spec.curClass.classes then
    local ascendId = build.spec.curAscendClassId or 0
    local ascendClass = build.spec.curClass.classes[ascendId] or build.spec.curClass.classes[0]
    if ascendClass and ascendClass.name then
      build.spec.curAscendClassName = ascendClass.name
    end
  end

  -- Re-process all socket groups so that gem modifications made via add_gem /
  -- set_gem_level / set_gem_quality are fully resolved before SaveDB serialises
  -- the skillsTab.  ProcessSocketGroup populates gemData / grantedEffect from
  -- the current gemId/nameSpec, ensuring accurate gemId and nameSpec values in
  -- the output XML.
  if build.skillsTab and build.skillsTab.socketGroupList then
    for _, socketGroup in ipairs(build.skillsTab.socketGroupList) do
      if build.skillsTab.ProcessSocketGroup then
        build.skillsTab:ProcessSocketGroup(socketGroup)
      end
    end
  end

  local xml = build:SaveDB('api-export')
  if not xml then return nil, 'failed to compose xml' end
  local f, ferr = io.open(params.path, 'w')
  if not f then return nil, 'failed to open file: ' .. tostring(ferr) end
  local ok, werr = f:write(xml)
  f:close()
  if not ok then return nil, 'failed to write file: ' .. tostring(werr) end
  return { path = params.path, size = #xml }
end

function M.list_specs()
  if not build or not build.treeTab then return nil, 'build/treeTab not initialized' end
  local specs = {}
  for i, spec in ipairs(build.treeTab.specList or {}) do
    local nodeCount = 0
    for _ in pairs(spec.allocNodes or {}) do nodeCount = nodeCount + 1 end
    table.insert(specs, {
      index = i,
      title = spec.title or ('Spec ' .. i),
      active = (i == build.treeTab.activeSpec),
      className = spec.curClassName,
      ascendClassName = spec.curAscendClassName,
      treeVersion = spec.treeVersion,
      nodeCount = nodeCount,
    })
  end
  return { specs = specs, activeSpec = build.treeTab.activeSpec }
end

function M.select_spec(params)
  if not build or not build.treeTab then return nil, 'build/treeTab not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  local index = tonumber(params.index)
  local specCount = #(build.treeTab.specList or {})
  if not index or not build.treeTab.specList[index] then
    return nil, string.format('spec index %s not found (valid range: 1-%d)', tostring(params.index), specCount)
  end
  build.treeTab:SetActiveSpec(index)
  M.get_main_output()
  return M.list_specs()
end

function M.list_item_sets()
  if not build or not build.itemsTab then return nil, 'build/itemsTab not initialized' end
  local sets = {}
  for _, id in ipairs(build.itemsTab.itemSetOrderList or {}) do
    local itemSet = build.itemsTab.itemSets[id]
    if itemSet then
      table.insert(sets, {
        id = id,
        title = itemSet.title or ('Item Set ' .. id),
        active = (id == build.itemsTab.activeItemSetId),
        useSecondWeaponSet = itemSet.useSecondWeaponSet == true,
      })
    end
  end
  return { itemSets = sets, activeItemSetId = build.itemsTab.activeItemSetId }
end

function M.select_item_set(params)
  if not build or not build.itemsTab then return nil, 'build/itemsTab not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  local id = tonumber(params.id)
  if not id or not build.itemsTab.itemSets[id] then
    return nil, string.format('item set id %s not found', tostring(params.id))
  end
  build.itemsTab:SetActiveItemSet(id)
  if build.itemsTab.PopulateSlots then
    build.itemsTab:PopulateSlots()
  end
  if build.configTab and build.configTab.BuildModList then
    build.configTab:BuildModList()
  end
  M.get_main_output()
  return M.list_item_sets()
end


-- params: { title?: string, copyFrom?: number (spec index), activate?: boolean }
function M.create_spec(params)
  if not build or not build.treeTab then return nil, 'build/treeTab not initialized' end
  params = type(params) == 'table' and params or {}
  local specList = build.treeTab.specList
  if not specList then return nil, 'spec list not available' end
  local source = nil
  if params.copyFrom ~= nil then
    source = specList[tonumber(params.copyFrom)]
    if not source then
      return nil, string.format('copyFrom spec index %s not found (valid range: 1-%d)', tostring(params.copyFrom), #specList)
    end
  end
  local version = (source and source.treeVersion) or (build.spec and build.spec.treeVersion) or latestTreeVersion
  local newSpec = Compat.construct('PassiveSpec', build, version)
  if source then
    -- Same copy mechanism TreeTab uses for its spec management popup
    newSpec.jewels = copyTable(source.jewels)
    newSpec:RestoreUndoState(source:CreateUndoState(), version)
    if newSpec.BuildClusterJewelGraphs then newSpec:BuildClusterJewelGraphs() end
  end
  newSpec.title = params.title and tostring(params.title)
    or (source and source.title and (tostring(source.title) .. ' (copy)'))
    or ('Spec ' .. (#specList + 1))
  table.insert(specList, newSpec)
  build.modFlag = true
  if params.activate ~= false then
    build.treeTab:SetActiveSpec(#specList)
    M.get_main_output()
  end
  return M.list_specs()
end

-- params: { index: number }
function M.delete_spec(params)
  if not build or not build.treeTab then return nil, 'build/treeTab not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  local specList = build.treeTab.specList or {}
  local index = tonumber(params.index)
  if not index or not specList[index] then
    return nil, string.format('spec index %s not found (valid range: 1-%d)', tostring(params.index), #specList)
  end
  if #specList <= 1 then return nil, 'cannot delete the only remaining spec' end
  table.remove(specList, index)
  local active = build.treeTab.activeSpec or 1
  if active > index then
    build.treeTab:SetActiveSpec(active - 1)
  elseif active == index then
    build.treeTab:SetActiveSpec(math.min(index, #specList))
  end
  build.modFlag = true
  M.get_main_output()
  return M.list_specs()
end

-- params: { index: number, title: string }
function M.rename_spec(params)
  if not build or not build.treeTab then return nil, 'build/treeTab not initialized' end
  if type(params) ~= 'table' or params.title == nil then return nil, 'missing index or title' end
  local specList = build.treeTab.specList or {}
  local index = tonumber(params.index)
  local spec = index and specList[index]
  if not spec then
    return nil, string.format('spec index %s not found (valid range: 1-%d)', tostring(params.index), #specList)
  end
  spec.title = tostring(params.title)
  build.modFlag = true
  return M.list_specs()
end

-- params: { groupIndex: number, enabled: boolean }
function M.set_socket_group_enabled(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' or params.groupIndex == nil or params.enabled == nil then
    return nil, 'missing groupIndex or enabled'
  end
  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end
  local groupIndex = tonumber(params.groupIndex)
  local socketGroup = groupIndex and skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found' end
  socketGroup.enabled = params.enabled == true
  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end
  build.buildFlag = true
  M.get_main_output()
  return {
    groupIndex = groupIndex,
    label = socketGroup.displayLabel or socketGroup.label or ('Group ' .. groupIndex),
    enabled = socketGroup.enabled == true,
  }
end

-- params: { groupIndex: number, gemIndex: number, enabled: boolean }
function M.set_gem_enabled(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' or params.groupIndex == nil or params.gemIndex == nil or params.enabled == nil then
    return nil, 'missing groupIndex, gemIndex or enabled'
  end
  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end
  local groupIndex = tonumber(params.groupIndex)
  local socketGroup = groupIndex and skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found' end
  local gemIndex = tonumber(params.gemIndex)
  local gemInstance = gemIndex and socketGroup.gemList[gemIndex]
  if not gemInstance then return nil, 'gem not found' end
  gemInstance.enabled = params.enabled == true
  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end
  build.buildFlag = true
  M.get_main_output()
  return true
end

-- params: { keyword: string, nodeType?: string ('normal'|'notable'|'keystone'), maxResults?: number, includeAllocated?: boolean }
function M.search_nodes(params)
  if not build or not build.spec then return nil, 'build/spec not initialized' end
  if type(params) ~= 'table' or type(params.keyword) ~= 'string' then
    return nil, 'missing or invalid keyword'
  end

  local keyword = params.keyword:lower()
  local nodeType = params.nodeType and params.nodeType:lower() or nil
  local maxResults = tonumber(params.maxResults) or 50
  local includeAllocated = params.includeAllocated ~= false

  local results = {}
  local count = 0

  local allocatedSet = {}
  if build.spec.allocNodes then
    for id, _ in pairs(build.spec.allocNodes) do
      allocatedSet[id] = true
    end
  end

  for id, node in pairs(build.spec.nodes) do
    if count >= maxResults then break end

    if not includeAllocated and allocatedSet[id] then
      goto continue
    end

    if nodeType then
      local nType = 'normal'
      if node.isKeystone then nType = 'keystone'
      elseif node.isNotable then nType = 'notable'
      elseif node.isJewelSocket then nType = 'jewel'
      elseif node.isMultipleChoiceOption then nType = 'mastery'
      elseif node.ascendancyName then nType = 'ascendancy'
      end
      if nType ~= nodeType then goto continue end
    end

    local matches = false
    if node.name and node.name:lower():find(keyword, 1, true) then
      matches = true
    end

    if not matches and node.sd then
      for _, stat in ipairs(node.sd) do
        if type(stat) == 'string' and stat:lower():find(keyword, 1, true) then
          matches = true
          break
        end
      end
    end

    if not matches and node.modList then
      for _, mod in ipairs(node.modList) do
        local modStr = tostring(mod)
        if modStr:lower():find(keyword, 1, true) then
          matches = true
          break
        end
      end
    end

    if matches then
      local nodeType = 'normal'
      if node.isKeystone then nodeType = 'keystone'
      elseif node.isNotable then nodeType = 'notable'
      elseif node.isJewelSocket then nodeType = 'jewel'
      elseif node.isMultipleChoiceOption then nodeType = 'mastery'
      elseif node.ascendancyName then nodeType = 'ascendancy'
      end

      local stats = {}
      if node.sd then
        for _, stat in ipairs(node.sd) do
          if type(stat) == 'string' then
            table.insert(stats, stat)
          end
        end
      end

      table.insert(results, {
        id = id,
        name = node.name or 'Unnamed',
        type = nodeType,
        stats = stats,
        allocated = allocatedSet[id] == true,
        x = node.x,
        y = node.y,
        orbit = node.orbit,
        orbitIndex = node.orbitIndex,
        ascendancyName = node.ascendancyName,
        -- Blight notables sit off the tree and are reached by anointing, not by
        -- spending a point; callers need to tell them apart from real nodes.
        isBlighted = node.isBlighted == true,
      })
      count = count + 1
    end

    ::continue::
  end

  -- Sort results: keystones first, then notables, then normal
  table.sort(results, function(a, b)
    local typeOrder = { keystone = 1, notable = 2, jewel = 3, mastery = 4, ascendancy = 5, normal = 6 }
    local aOrder = typeOrder[a.type] or 99
    local bOrder = typeOrder[b.type] or 99
    if aOrder ~= bOrder then
      return aOrder < bOrder
    end
    return (a.name or '') < (b.name or '')
  end)

  return { nodes = results, count = #results }
end

-- Returns all allocated mastery nodes and the available effect options for each.
-- Output: { masteries: [ { nodeId, nodeName, allocatedEffect, availableEffects: [{effectId, stat}] } ] }
function M.get_mastery_options()
  if not build or not build.spec then
    return nil, 'build/spec not initialized'
  end
  local spec = build.spec
  local result = {}
  for nodeId, _ in pairs(spec.allocNodes or {}) do
    local node = spec.nodes[nodeId]
    if node and node.isMastery and node.masteryEffects then
      local allocated = spec.masterySelections and spec.masterySelections[nodeId]
      local available = {}
      -- node.masteryEffects is an array of { effect = <id>, stats = {...} }.
      for _, effectData in ipairs(node.masteryEffects) do
        local stat = effectData.stats and table.concat(effectData.stats, ', ') or tostring(effectData.effect)
        table.insert(available, { effectId = effectData.effect, stat = stat })
      end
      table.insert(result, {
        nodeId = nodeId,
        nodeName = node.name or 'Mastery',
        allocatedEffect = allocated,
        availableEffects = available,
      })
    end
  end
  return { masteries = result }
end

-- Import a character from pathofexile.com's public character-window JSON
-- through PoB's own ImportTab code: the same path as the desktop app's
-- "Import from website" button, so items, gems and the tree come out exactly
-- as PoB builds them.
--   params.character  the get-characters entry (name, class, league, level...)
--   params.passives   the get-passive-skills response
--   params.items      the get-items response
--   params.mainSkill  optional active gem name to make the main skill
--
-- What PoB's importer does that this wraps (ImportTab.lua):
--   * ImportPassiveTreeAndJewels sets bandit and both pantheon gods from the
--     response, falling back to None when the response omits them (the public
--     API always does), and re-estimates resistancePenalty from the passive
--     points used. The values held before the import are put back for those
--     four options unless the response carried its own.
--   * ImportItemsAndSkills (clearSkills) restores a socket group's state,
--     including which group is the main skill, only when the group comes back
--     with the same slot and gems; otherwise the old index is left in place
--     and may point at another group. The main skill is therefore checked by
--     name, and PoB's GuessMainSocketGroup is the fallback.
--   * Deleting the replaced gear uses ItemsTab:DeleteItem, which removes the
--     item from every item set, as the desktop import does.

-- Let PoB process a frame after a change. Headless, HeadlessWrapper's
-- runCallback does that; inside the desktop app a command already runs within
-- a frame, so its server replaces this with a no-op.
function M.advanceFrame()
  if runCallback then runCallback("OnFrame") end
end

local IMPORT_SLOTS = { "Weapon 1", "Weapon 2", "Weapon 1 Swap", "Weapon 2 Swap", "Helmet", "Body Armour",
  "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Belt", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5" }

local function activeSkillName(group)
  if not group then return nil end
  local display = group.displaySkillList and group.displaySkillList[group.mainActiveSkill or 1]
  local effect = display and display.activeEffect and display.activeEffect.grantedEffect
  return effect and effect.name or nil
end

-- Same lookup SkillsTab uses: the effect normally lives on gemData. Vaal gems
-- carry the non-Vaal skill as gemData.secondaryGrantedEffect. Names compare
-- case-insensitively so a typed main_skill need not match PoB's casing.
local function sameName(a, b)
  return type(a) == 'string' and type(b) == 'string' and a:lower() == b:lower()
end

local function groupHasActiveGem(group, gemName)
  for _, gem in ipairs(group and group.gemList or {}) do
    local gemData = gem.gemData
    local effects = { gem.grantedEffect, gemData and gemData.grantedEffect, gemData and gemData.secondaryGrantedEffect }
    for i = 1, 3 do
      local effect = effects[i]
      if effect and not effect.support and sameName(effect.name, gemName) then return true end
    end
  end
  return false
end

-- PoB's importer enables only a gem's first effect (enableGlobal1), while gems
-- added in the UI start with both enabled (SkillsTab.lua). When the wanted main
-- skill is a Vaal gem's normal effect, enable it as the UI checkbox would.
local function enableSecondaryEffect(group, gemName)
  for _, gem in ipairs(group and group.gemList or {}) do
    local gemData = gem.gemData
    local secondary = gemData and gemData.secondaryGrantedEffect
    if secondary and not secondary.support and sameName(secondary.name, gemName) and gem.enableGlobal2 ~= true then
      gem.enableGlobal2 = true
      return true
    end
  end
  return false
end

-- A group can show several skills (a Vaal gem shows the Vaal and the normal
-- one, Vaal first). Point the group's main skill at the wanted one; the
-- display list is only built by a calculation pass.
local function selectSkillInGroup(group, gemName)
  for i, display in ipairs(group and group.displaySkillList or {}) do
    local effect = display.activeEffect and display.activeEffect.grantedEffect
    if effect and sameName(effect.name, gemName) then
      if group.mainActiveSkill ~= i then
        group.mainActiveSkill = i
        group.mainActiveSkillCalcs = i
        return true
      end
      return false
    end
  end
  return false
end

-- Same lookup ImportSocketedItems uses (ImportTab.lua); a gem it cannot resolve is dropped there.
local function importableGemId(socketed)
  local gemId = build.data.gemForBaseName[sanitiseText(socketed.typeLine or ''):lower()]
  if socketed.hybrid then
    gemId = build.data.gemForBaseName[sanitiseText(socketed.hybrid.baseTypeName or ''):lower()]
    if gemId and socketed.hybrid.isVaalGem then
      gemId = build.data.gemGrantedEffectIdForVaalGemId[build.data.gems[gemId].grantedEffectId]
    end
  end
  return gemId
end

-- inventoryIds ImportItem places: its slotMap keys plus Flask and PassiveJewels (ImportTab.lua).
local IMPORTED_INVENTORY_IDS = {
  Weapon = true, Offhand = true, Weapon2 = true, Offhand2 = true, Helm = true, BodyArmour = true,
  Gloves = true, Boots = true, Amulet = true, Ring = true, Ring2 = true, Ring3 = true, Belt = true,
  BrequelGrafts = true, BrequelGrafts2 = true, Flask = true, PassiveJewels = true,
}

-- What the response held that the importer did not bring in. ImportItem skips
-- unknown inventoryIds, unknown bases and unrecognised rarities without a
-- message, and ImportSocketedItems skips gems it cannot resolve; every
-- imported item keeps the response's id as uniqueID.
local function auditImport(params)
  local present = {}
  for _, item in pairs(build.itemsTab.items) do
    if item.uniqueID then present[item.uniqueID] = true end
  end
  local missingItems, missingGems = {}, {}
  local counts = { items = 0, gems = 0, notEquipped = 0 }
  local function checkItem(entry, where)
    counts.items = counts.items + 1
    if entry.id and not present[entry.id] then
      table.insert(missingItems, { where = where, name = entry.name ~= '' and entry.name or nil, base = entry.typeLine })
    end
  end
  local function checkGear(entry, where)
    checkItem(entry, where)
    for _, socketed in ipairs(entry.socketedItems or {}) do
      if socketed.abyssJewel then
        checkItem(socketed, where .. ' abyssal socket')
      else
        counts.gems = counts.gems + 1
        if not importableGemId(socketed) then
          table.insert(missingGems, { where = where, name = socketed.typeLine })
        end
      end
    end
  end
  for _, entry in ipairs(params.items.items or {}) do
    local inventoryId = tostring(entry.inventoryId or '?')
    if not IMPORTED_INVENTORY_IDS[inventoryId] then
      -- Bag or stash entries: ImportItem has no slot for them and is not meant to.
      counts.notEquipped = counts.notEquipped + 1
    elseif not (params.ignoreWeaponSwap == true and (inventoryId == 'Weapon2' or inventoryId == 'Offhand2')) then
      checkGear(entry, inventoryId)
    end
  end
  for _, entry in ipairs(params.items.guardian or {}) do checkGear(entry, 'guardian ' .. tostring(entry.inventoryId or '?')) end
  for _, entry in ipairs(params.passives.items or {}) do checkItem(entry, 'passive tree jewel') end

  -- Mod lines PoB shows in red: parsed into nothing, so they do not count in any number.
  local unsupported = {}
  local listNames = { 'enchantModLines', 'scourgeModLines', 'classRequirementModLines', 'implicitModLines',
    'explicitModLines', 'crucibleModLines', 'buffModLines' }
  for slotName, slot in pairs(build.itemsTab.slots) do
    local item = slot.selItemId and build.itemsTab.items[slot.selItemId]
    if item then
      for _, listName in ipairs(listNames) do
        for _, modLine in ipairs(item[listName] or {}) do
          if modLine.extra then
            table.insert(unsupported, { slot = slotName, item = item.title or item.name, line = modLine.line })
          end
        end
      end
    end
  end
  table.sort(unsupported, function(a, b) return a.slot < b.slot end)
  return { counts = counts, missingItems = missingItems, missingGems = missingGems, unsupportedLines = unsupported }
end

function M.import_character(params)
  if not build or not build.importTab or not build.configTab or not build.skillsTab then
    return nil, 'build not initialized'
  end
  if type(params) ~= 'table' or type(params.character) ~= 'table' then return nil, 'missing character' end
  if type(params.passives) ~= 'table' or type(params.items) ~= 'table' then return nil, 'missing passives or items' end
  if type(params.character.class) ~= 'string' or type(params.character.league) ~= 'string' then
    return nil, 'character entry needs class and league'
  end
  local importTab = build.importTab
  local before = {}
  for _, key in ipairs({ 'bandit', 'pantheonMajorGod', 'pantheonMinorGod', 'resistancePenalty' }) do
    before[key] = build.configTab.input[key]
  end
  local mainSkill = params.mainSkill
    or activeSkillName(build.skillsTab.socketGroupList[build.mainSocketGroup])

  local passives = copyTable(params.passives)
  local treeData = copyTable(params.character)
  treeData.passives = passives
  treeData.jewels = passives.items
  local ok, err = pcall(importTab.ImportPassiveTreeAndJewels, importTab, treeData, true)
  if not ok then return nil, 'passive tree import failed: ' .. tostring(err) end

  local itemData = copyTable(params.character)
  itemData.equipment = params.items.items or {}
  itemData.guardian = params.items.guardian
  ok, err = pcall(importTab.ImportItemsAndSkills, importTab, itemData, true, true, params.ignoreWeaponSwap == true)
  if not ok then return nil, 'item import failed: ' .. tostring(err) end

  -- The importer writes through the config dropdowns into the active config
  -- set's input table, which build.configTab.input aliases.
  local input = build.configTab.input
  local fromResponse = {
    bandit = passives.bandit_choice,
    pantheonMajorGod = passives.pantheon_major,
    pantheonMinorGod = passives.pantheon_minor,
  }
  -- The login API (PoB's "Import From Your Account") carries the quest
  -- choices, and a missing one means none was made: PoB sets "None" then.
  -- The public profile never carries them, so there a missing one means unknown.
  local questChoicesKnown = params.questChoicesFromResponse == true
  local restored = {}
  for key, value in pairs(before) do
    local fromApi = questChoicesKnown and key ~= 'resistancePenalty'
    if not fromApi and fromResponse[key] == nil and value ~= nil and input[key] ~= value then
      restored[key] = { imported = input[key], kept = value }
      input[key] = value
    end
  end
  if next(restored) then
    if build.configTab.UpdateControls then build.configTab:UpdateControls() end
    build.configTab:BuildModList()
  end

  -- 'kept': the group at the main index already holds the wanted skill.
  -- 'matched by name': another group holds it. 'guessed by PoB': no wanted
  -- skill (empty base) or no group holds it, so PoB's own guess is used rather
  -- than whatever group now sits at the stale index.
  local mainSkillSource
  local groups = build.skillsTab.socketGroupList
  if mainSkill and groupHasActiveGem(groups[build.mainSocketGroup], mainSkill) then
    mainSkillSource = 'kept'
  else
    if mainSkill then
      for i, group in ipairs(groups) do
        if groupHasActiveGem(group, mainSkill) then
          build.mainSocketGroup = i
          mainSkillSource = 'matched by name'
          break
        end
      end
    end
    if not mainSkillSource then
      build.mainSocketGroup = importTab:GuessMainSocketGroup()
      mainSkillSource = 'guessed by PoB'
    end
  end
  build.calcsTab.input.skill_number = build.mainSocketGroup
  build.buildFlag = true
  M.advanceFrame()
  M.get_main_output()
  if mainSkill then
    local mainGroup = groups[build.mainSocketGroup]
    local recalc = function()
      build.buildFlag = true
      M.advanceFrame()
      M.get_main_output()
    end
    if enableSecondaryEffect(mainGroup, mainSkill) then recalc() end
    if selectSkillInGroup(mainGroup, mainSkill) then recalc() end
  end

  local allocated = 0
  for _ in pairs(build.spec.allocNodes or {}) do allocated = allocated + 1 end
  local items = {}
  for _, slotName in ipairs(IMPORT_SLOTS) do
    local slot = build.itemsTab.slots[slotName]
    local item = slot and slot.selItemId and build.itemsTab.items[slot.selItemId]
    if item then table.insert(items, { slot = slotName, name = item.title or item.name, base = item.baseName }) end
  end
  return {
    name = params.character.name,
    league = params.character.league,
    class = build.spec.curClassName,
    ascendancy = build.spec.curAscendClassName,
    level = build.characterLevel,
    allocatedNodes = allocated,
    socketGroups = #groups,
    mainSkill = activeSkillName(groups[build.mainSocketGroup]),
    mainSkillWanted = mainSkill,
    mainSkillSource = mainSkillSource,
    mainSocketGroup = build.mainSocketGroup,
    restoredConfig = restored,
    questChoices = {
      bandit = input.bandit,
      pantheonMajorGod = input.pantheonMajorGod,
      pantheonMinorGod = input.pantheonMinorGod,
    },
    items = items,
    -- A surprise in the response shape must not turn a finished import into a failure.
    audit = (function()
      local ok, result = pcall(auditImport, params)
      if ok then return result end
      return { error = tostring(result) }
    end)(),
  }
end

-- ---------------------------------------------------------------------------
-- Build sites
-- PoB's own tables and functions decide links, URLs and parsing; only the
-- network requests run in TS (the headless engine has no HTTP client).
-- ---------------------------------------------------------------------------

local BUILD_SITE_FIELDS = { 'label', 'id', 'matchURL', 'regexURL', 'downloadURL', 'codeOut', 'postUrl', 'postFields', 'linkURL' }

local function describeBuildSite(site)
  local out = {}
  for _, key in ipairs(BUILD_SITE_FIELDS) do out[key] = site[key] end
  -- ImportTab.lua getExportSitesFromImportList: a site offers "Share" when it
  -- has postUrl, postFields and codeOut.
  out.canShare = (site.postUrl and site.postFields and site.codeOut) and true or false
  return out
end

-- buildSites.websiteList (Modules/BuildSiteTools.lua, loaded by Modules/Main.lua).
function M.list_build_sites()
  if type(buildSites) ~= 'table' or type(buildSites.websiteList) ~= 'table' then
    return nil, "PoB's buildSites (Modules/BuildSiteTools.lua) is not loaded"
  end
  local sites = {}
  for _, site in ipairs(buildSites.websiteList) do table.insert(sites, describeBuildSite(site)) end
  return { sites = sites }
end

-- Resolve an import link to the URL PoB downloads its build code from, by
-- running PoB's own code with its download step intercepted:
--   https links: ImportBuild (Modules/Common.lua), which trims the input,
--     unwraps youtube/google redirect links, matches buildSites.websiteList
--     and calls buildSites.DownloadBuild (regexURL -> downloadURL);
--   pob:// links: Main:Init's protocol handler (Modules/Main.lua), which
--     calls buildSites.DownloadBuild(uri, nil) and
--     buildSites.ParseImportLinkFromURI for the link it stores.
-- Anything else is treated as a build code, as ImportBuild does.
function M.resolve_build_link(params)
  local input = params.link
  if type(input) ~= 'string' or input == '' then return nil, 'link is required' end
  if type(buildSites) ~= 'table' or type(buildSites.DownloadBuild) ~= 'function' then
    return nil, "PoB's buildSites (Modules/BuildSiteTools.lua) is not loaded"
  end
  if type(ImportBuild) ~= 'function' or type(launch) ~= 'table' then
    return nil, "PoB's ImportBuild (Modules/Common.lua) is not loaded"
  end
  local seen = {}
  local origDownloadBuild = buildSites.DownloadBuild
  local rawDownloadPage = rawget(launch, 'DownloadPage')
  buildSites.DownloadBuild = function(link, websiteInfo, callback)
    seen.called, seen.link, seen.site = true, link, websiteInfo
    return origDownloadBuild(link, websiteInfo, callback)
  end
  launch.DownloadPage = function(_, url) seen.url = url end
  local isUri = input:match('^pob:') ~= nil
  local ok, err = pcall(function()
    if isUri then
      seen.importLink = buildSites.ParseImportLinkFromURI(input)
      buildSites.DownloadBuild(input, nil, function() end)
    else
      -- ImportBuild decodes the input as a code when no site matches; that
      -- result is discarded here (TS decodes codes itself).
      ImportBuild(input, function() end)
    end
  end)
  buildSites.DownloadBuild = origDownloadBuild
  rawset(launch, 'DownloadPage', rawDownloadPage)
  if not ok then return nil, 'resolving the link failed: ' .. tostring(err) end

  if not seen.called then return { kind = 'code' } end
  local link = isUri and seen.importLink or seen.link
  local site = seen.site
  if not site and isUri then
    -- DownloadBuild(uri, nil) picks the first site whose id the URI names,
    -- with this pattern; the link it stores can name another site's page
    -- (PastebinP's linkURL is pastebin.com), so the site comes from the id.
    for _, info in ipairs(buildSites.websiteList) do
      if input:match("^pob:[/\\]*" .. info.id:lower() .. "[/\\]+(.+)") then site = info break end
    end
  end
  if not seen.url then
    return nil, 'no site in PoB\'s list matches "' .. tostring(link or input) .. '" (Download information not found)'
  end
  return {
    kind = 'link',
    link = link,
    downloadUrl = seen.url,
    site = site and describeBuildSite(site) or nil,
  }
end


-- ============================================================
-- Compare tab (Classes/CompareTab.lua, CompareEntry.lua, CompareBuySimilar.lua,
-- ComparePowerReportListControl.lua, TradeHelpers.lua)
--
-- The loaded build owns a CompareTab (build.compareTab, Modules/Build.lua),
-- headless as in the window. Comparison builds are CompareEntry objects held
-- by that tab, so they live as long as the loaded build. Loading, removing,
-- set selection, copying, the power report and the trade URL call the tab's
-- own methods. The difference lists are computed inside its Draw* methods,
-- which only draw; their logic is mirrored here step by step (each function
-- names the method it follows) and calls the same helpers they call. Helpers
-- the tab keeps in file locals (matchFlags, calcRowMatchesBetweenBuilds,
-- tradeHelpers, buySimilar's buildURL, ...) are read from the methods'
-- upvalues, so they are PoB's own functions, not copies.
-- ============================================================

-- The upvalue `name` of a PoB function, or nil.
local function pobUpvalue(fn, name)
  if type(fn) ~= 'function' or not debug or not debug.getupvalue then return nil end
  local i = 1
  while true do
    local upName, value = debug.getupvalue(fn, i)
    if not upName then return nil end
    if upName == name then return value end
    i = i + 1
  end
end

local function compareTab()
  if not build then return nil, 'build not initialized' end
  if not build.compareTab then return nil, 'this Path of Building version has no Compare tab' end
  return build.compareTab
end

-- The comparison entry at `index` (default: the tab's active one). Selecting
-- it makes it the tab's active comparison, as the "Compare with" dropdown does.
local function compareEntryAt(ct, index)
  if #ct.compareEntries == 0 then return nil, 'no comparison build loaded; use compare_add_build first' end
  if index ~= nil then
    local i = tonumber(index)
    if not i or not ct.compareEntries[i] then
      return nil, string.format('comparison %s not found (loaded: 1-%d)', tostring(index), #ct.compareEntries)
    end
    if ct.activeCompareIndex ~= i then
      ct.activeCompareIndex = i
      ct.treeSearchNeedsSync = true
      ct:UpdateBuildSelector()
    end
  end
  local entry = ct:GetActiveCompare()
  if not entry then return nil, 'no active comparison build' end
  -- CompareTabClass:Draw rebuilds a flagged entry before using it.
  if entry.buildFlag then entry:Rebuild() end
  return entry, ct.activeCompareIndex
end

-- Bring the loaded build's output up to date before reading it.
local function refreshPrimary()
  if build.buildFlag then M.advanceFrame() end
  if build.buildFlag then build.calcsTab:BuildOutput() end
end

local function setTitles(orderList, sets, activeId)
  local list = {}
  for index, id in ipairs(orderList or {}) do
    local set = sets and sets[id]
    table.insert(list, { index = index, id = id, title = stripColourCodes(set and set.title or 'Default'), active = id == activeId })
  end
  return list
end

local function socketGroupLabel(group, index)
  local label = group.displayLabel or group.label or ('Group ' .. index)
  if group.slot then label = label .. ' (' .. group.slot .. ')' end
  return stripColourCodes(label)
end

local function compareEntryInfo(ct, entry, index)
  local spec = entry.spec
  local out = entry:GetOutput() or {}
  local treeSets = {}
  for i, title in ipairs(entry.treeTab and entry.treeTab:GetSpecList() or {}) do
    table.insert(treeSets, { index = i, title = stripColourCodes(title), active = i == entry.treeTab.activeSpec })
  end
  local groups = {}
  for i, group in ipairs(entry.skillsTab and entry.skillsTab.socketGroupList or {}) do
    table.insert(groups, { index = i, label = socketGroupLabel(group, i), enabled = group.enabled ~= false })
  end
  return {
    index = index,
    label = entry.label,
    active = index == ct.activeCompareIndex,
    className = spec and spec.curClassName,
    ascendClassName = spec and spec.curAscendClassName,
    level = entry.characterLevel,
    treeVersion = spec and spec.treeVersion,
    treeSets = treeSets,
    itemSets = entry.itemsTab and setTitles(entry.itemsTab.itemSetOrderList, entry.itemsTab.itemSets, entry.itemsTab.activeItemSetId) or {},
    skillSets = entry.skillsTab and setTitles(entry.skillsTab.skillSetOrderList, entry.skillsTab.skillSets, entry.skillsTab.activeSkillSetId) or {},
    configSets = entry.configTab and setTitles(entry.configTab.configSetOrderList, entry.configTab.configSets, entry.configTab.activeConfigSetId) or {},
    mainSocketGroup = entry.mainSocketGroup,
    calcsSocketGroup = entry.calcsTab and entry.calcsTab.input.skill_number,
    calcsBuffMode = entry.calcsTab and entry.calcsTab.input.misc_buffMode,
    socketGroups = groups,
    stats = {
      Life = out.Life, EnergyShield = out.EnergyShield, Mana = out.Mana, TotalEHP = out.TotalEHP,
      CombinedDPS = out.CombinedDPS, FullDPS = out.FullDPS, TotalDPS = out.TotalDPS,
    },
  }
end

function M.compare_list()
  local ct, err = compareTab()
  if not ct then return nil, err end
  local entries = {}
  for i, entry in ipairs(ct.compareEntries) do
    if entry.buildFlag then entry:Rebuild() end
    table.insert(entries, compareEntryInfo(ct, entry, i))
  end
  return {
    primary = { name = build.buildName, className = build.spec and build.spec.curClassName, ascendClassName = build.spec and build.spec.curAscendClassName, level = build.characterLevel },
    activeIndex = ct.activeCompareIndex,
    entries = entries,
  }
end

-- params: { xml: string, label?: string }
-- CompareTabClass:ImportBuild, as the Import popup ("build code") and the
-- "Import from Folder" popup call it after reading the code or file.
function M.compare_import(params)
  local ct, err = compareTab()
  if not ct then return nil, err end
  if type(params) ~= 'table' or type(params.xml) ~= 'string' or params.xml == '' then return nil, 'missing xml' end
  local label = (type(params.label) == 'string' and params.label ~= '') and params.label or 'Imported build'
  local before = #ct.compareEntries
  local ok, imported = pcall(ct.ImportBuild, ct, params.xml, label)
  if not ok then return nil, 'import failed: ' .. tostring(imported) end
  if not imported or #ct.compareEntries == before then
    return nil, 'Path of Building could not load this build for comparison (CompareEntry produced no output); check the XML'
  end
  local index = #ct.compareEntries
  return { entry = compareEntryInfo(ct, ct.compareEntries[index], index), count = index }
end

-- params: { index: number } -- CompareTabClass:RemoveBuild ("Remove" button)
function M.compare_remove(params)
  local ct, err = compareTab()
  if not ct then return nil, err end
  local index = tonumber(params and params.index)
  if not index or not ct.compareEntries[index] then
    return nil, string.format('comparison %s not found (loaded: %d)', tostring(params and params.index), #ct.compareEntries)
  end
  local label = ct.compareEntries[index].label
  ct:RemoveBuild(index)
  local list = M.compare_list()
  list.removed = label
  return list
end

local CALCS_BUFF_MODES = { UNBUFFED = true, BUFFED = true, COMBAT = true, EFFECTIVE = true }

-- params: { index?, tree_set?, item_set?, skill_set?, config_set?, main_socket_group?,
--           calcs_socket_group?, calcs_buff_mode?, calcs_show_minion? }
-- The comparison build's selectors in CompareTabClass:InitControls:
-- compareSpecSelect, compareSkillSetSelect, compareItemSetSelect,
-- compareConfigSetSelect, cmpSocketGroup, cmpCalcsSocketGroup, cmpCalcsMode,
-- cmpCalcsShowMinion. Sets are picked by their position in the dropdown.
function M.compare_select(params)
  local ct, err = compareTab()
  if not ct then return nil, err end
  params = type(params) == 'table' and params or {}
  -- Validate every choice before changing anything, so a bad one leaves the
  -- tab and the compared build as they were.
  local target
  if params.index ~= nil then
    target = ct.compareEntries[tonumber(params.index) or -1]
    if not target then
      return nil, string.format('comparison %s not found (loaded: 1-%d)', tostring(params.index), #ct.compareEntries)
    end
  else
    target = ct:GetActiveCompare()
  end
  if not target then return nil, 'no comparison build loaded; use compare_add_build first' end
  local function pick(orderList, value, what)
    local i = tonumber(value)
    if not i or not orderList[i] then
      return nil, string.format('%s %s not found (1-%d)', what, tostring(value), #orderList)
    end
    return i
  end
  local sel, perr = {}, nil
  if params.tree_set ~= nil then
    sel.tree, perr = pick(target.treeTab.specList, params.tree_set, 'tree set')
    if not sel.tree then return nil, perr end
  end
  if params.skill_set ~= nil then
    sel.skill, perr = pick(target.skillsTab.skillSetOrderList, params.skill_set, 'skill set')
    if not sel.skill then return nil, perr end
  end
  if params.item_set ~= nil then
    sel.item, perr = pick(target.itemsTab.itemSetOrderList, params.item_set, 'item set')
    if not sel.item then return nil, perr end
  end
  if params.config_set ~= nil then
    sel.config, perr = pick(target.configTab.configSetOrderList, params.config_set, 'config set')
    if not sel.config then return nil, perr end
  end
  -- Socket groups belong to the skill set: check them against the one that
  -- will be active (SkillsTab:SetActiveSkillSet swaps socketGroupList).
  local groups = target.skillsTab.socketGroupList
  if sel.skill then
    local skillSet = target.skillsTab.skillSets[target.skillsTab.skillSetOrderList[sel.skill]]
    groups = skillSet and skillSet.socketGroupList or groups
  end
  if params.main_socket_group ~= nil then
    sel.main, perr = pick(groups, params.main_socket_group, 'socket group')
    if not sel.main then return nil, perr end
  end
  if params.calcs_socket_group ~= nil then
    sel.calcs, perr = pick(groups, params.calcs_socket_group, 'socket group')
    if not sel.calcs then return nil, perr end
  end
  if params.calcs_buff_mode ~= nil then
    sel.mode = tostring(params.calcs_buff_mode):upper()
    if not CALCS_BUFF_MODES[sel.mode] then return nil, 'calcs_buff_mode must be UNBUFFED, BUFFED, COMBAT or EFFECTIVE' end
  end

  local entry, index = compareEntryAt(ct, params.index)
  if not entry then return nil, index end
  local changed = {}
  if sel.tree then
    entry:SetActiveSpec(sel.tree)
    if build.spec then build.spec:SetWindowTitleWithBuildClass() end
    table.insert(changed, 'tree_set')
  end
  if sel.skill then
    entry:SetActiveSkillSet(entry.skillsTab.skillSetOrderList[sel.skill])
    table.insert(changed, 'skill_set')
  end
  if sel.item then
    entry:SetActiveItemSet(entry.itemsTab.itemSetOrderList[sel.item])
    table.insert(changed, 'item_set')
  end
  if sel.config then
    entry.configTab:SetActiveConfigSet(entry.configTab.configSetOrderList[sel.config])
    entry.buildFlag = true
    ct.configNeedsRebuild = true
    table.insert(changed, 'config_set')
  end
  if sel.main then
    entry:SetMainSocketGroup(sel.main)
    table.insert(changed, 'main_socket_group')
  end
  if sel.calcs then
    entry.calcsTab.input.skill_number = sel.calcs
    entry.buildFlag = true
    table.insert(changed, 'calcs_socket_group')
  end
  if sel.mode then
    entry.calcsTab.input.misc_buffMode = sel.mode
    entry.buildFlag = true
    table.insert(changed, 'calcs_buff_mode')
  end
  if params.calcs_show_minion ~= nil then
    entry.calcsTab.input.showMinion = params.calcs_show_minion == true
    entry.buildFlag = true
    table.insert(changed, 'calcs_show_minion')
  end
  if entry.buildFlag then entry:Rebuild() end
  return { entry = compareEntryInfo(ct, entry, index), changed = changed }
end

-- Summary view: CompareTabClass:DrawSummary and DrawStatList.
local function compareStats(ct, entry, onlyDifferences)
  local primaryCalcs, compareCalcs = build.calcsTab, entry.calcsTab
  local pEnv, cEnv = primaryCalcs.mainEnv, compareCalcs.mainEnv
  local pMinion = pEnv and pEnv.player and pEnv.player.mainSkill and pEnv.player.mainSkill.minion and pEnv.minion
  local cMinion = cEnv and cEnv.player and cEnv.player.mainSkill and cEnv.player.mainSkill.minion and cEnv.minion
  local useMinion = (pMinion or cMinion) and true or false
  local pOut = pMinion and pEnv.minion.output or primaryCalcs.mainOutput
  local cOut = cMinion and cEnv.minion.output or entry:GetOutput()
  if not pOut or not cOut then return nil, 'no calculated output for one of the builds' end
  local displayStats = useMinion and build.minionDisplayStats or build.displayStats
  local pActor = pMinion and pEnv.minion or pEnv.player
  local cActor = cMinion and cEnv.minion or cEnv.player
  local matchFlags = pobUpvalue(ct.DrawStatList, 'matchFlags')
  if not matchFlags then return nil, "CompareTab's matchFlags helper not found" end
  local pFlags = pActor and pActor.mainSkill and pActor.mainSkill.skillFlags or {}
  local cFlags = cActor and cActor.mainSkill and cActor.mainSkill.skillFlags or {}
  local rows = {}
  for _, statData in ipairs(displayStats) do
    if not statData.stat and not statData.label then
      -- section spacer
    elseif statData.stat == 'SkillDPS' or statData.hideStat then
      -- skipped by DrawStatList
    elseif not matchFlags(statData.flag, statData.notFlag, pFlags) and not matchFlags(statData.flag, statData.notFlag, cFlags) then
      -- not relevant to either build's skill
    elseif statData.stat then
      local pVal = pOut[statData.stat] or 0
      local cVal = cOut[statData.stat] or 0
      if statData.childStat then
        pVal = type(pVal) == 'table' and pVal[statData.childStat] or 0
        cVal = type(cVal) == 'table' and cVal[statData.childStat] or 0
      end
      if type(pVal) == 'table' or type(cVal) == 'table' then pVal, cVal = 0, 0 end
      if (pVal ~= 0 or cVal ~= 0) and (not statData.condFunc or statData.condFunc(pVal, pOut) or statData.condFunc(cVal, cOut)) then
        local fmt = statData.fmt or 'd'
        local multiplier = (statData.pc or statData.mod) and 100 or 1
        local diff = cVal - pVal
        local differs = diff > 0.001 or diff < -0.001
        local row = {
          label = stripColourCodes(statData.label or statData.stat),
          stat = statData.stat,
          childStat = statData.childStat,
          primary = pVal * multiplier,
          compare = cVal * multiplier,
          primaryText = formatNumSep(string.format('%' .. fmt, pVal * multiplier)),
          compareText = formatNumSep(string.format('%' .. fmt, cVal * multiplier)),
          lowerIsBetter = statData.lowerIsBetter and true or false,
        }
        if differs then
          row.diff = diff * multiplier
          row.diffText = formatNumSep(string.format('%+' .. fmt, diff * multiplier))
          row.better = (statData.lowerIsBetter and diff < 0) or (not statData.lowerIsBetter and diff > 0)
          if pVal ~= 0 then row.percent = cVal / pVal * 100 - 100 end
        end
        if differs or not onlyDifferences then table.insert(rows, row) end
      end
    elseif statData.label and statData.condFunc then
      local pShown = statData.condFunc(pOut) and true or false
      local cShown = statData.condFunc(cOut) and true or false
      if (pShown or cShown) and (pShown ~= cShown or not onlyDifferences) then
        table.insert(rows, {
          label = stripColourCodes(statData.label),
          primaryText = pShown and (statData.val or '') or '-',
          compareText = cShown and (statData.val or '') or '-',
        })
      end
    end
  end
  return { minionStats = useMinion, rows = rows }
end

-- Tree view, overlay mode: CompareTabClass:DrawTree hands the comparison's spec
-- to the loaded build's PassiveTreeView as compareSpec; the view colours each
-- node with PassiveTreeViewClass:GetCompareNodeColor (green: compared build
-- only, red: loaded build only, blue: mastery choice or socketed jewel differs)
-- and draws compare-only nodes (cluster jewel subgraphs) green.
local function compareTree(ct, entry, onlyDifferences)
  local spec, cSpec = build.spec, entry.spec
  local viewer = build.treeTab and build.treeTab.viewer
  if not spec or not cSpec or not viewer or not viewer.GetCompareNodeColor then return nil, 'tree view not available' end
  local function jewelName(itemsTab, jewel)
    return jewel and stripColourCodes(jewel.title or jewel.name) or nil
  end
  local function nodeInfo(node, status, cNode)
    local info = { id = node.id, name = node.dn, type = node.type, status = status, ascendancy = node.ascendancyName }
    if node.type == 'Mastery' then
      if node.alloc then info.primaryEffect = stripColourCodes(table.concat(node.sd or {}, ' / ')) end
      if cNode and cNode.alloc then info.compareEffect = stripColourCodes(table.concat(cNode.sd or {}, ' / ')) end
    elseif node.type == 'Socket' then
      local pJewelId = spec.jewels and spec.jewels[node.id]
      info.primaryJewel = jewelName(build.itemsTab, pJewelId and build.itemsTab.items[pJewelId])
      info.compareJewel = jewelName(entry.itemsTab, viewer:GetCompareJewel(node.id))
    end
    return info
  end
  local added, removed, changed = {}, {}, {}
  local shared = 0
  viewer.compareSpec = cSpec
  local ok, perr = pcall(function()
    for nodeId, node in pairs(spec.nodes) do
      local cNode = cSpec.nodes[nodeId]
      local r, g, b = viewer:GetCompareNodeColor(node, cNode, spec, build, 'same')
      if r == 0 and g == 1 and b == 0 then
        table.insert(added, nodeInfo(node, 'compare_only', cNode))
      elseif r == 1 and g == 0 and b == 0 then
        table.insert(removed, nodeInfo(node, 'primary_only', cNode))
      elseif r == 0 and g == 0 and b == 1 then
        table.insert(changed, nodeInfo(node, 'differs', cNode))
      elseif node.alloc then
        shared = shared + 1
      end
    end
    for nodeId, cNode in pairs(cSpec.nodes) do
      if not spec.nodes[nodeId] and cNode.alloc and cNode.type ~= 'ClassStart' and cNode.type ~= 'AscendClassStart' then
        table.insert(added, { id = nodeId, name = cNode.dn, type = cNode.type, status = 'compare_only', clusterNode = true })
      end
    end
  end)
  viewer.compareSpec = nil
  if not ok then return nil, 'tree comparison failed: ' .. tostring(perr) end
  local function byName(a, b) return tostring(a.name) < tostring(b.name) end
  table.sort(added, byName); table.sort(removed, byName); table.sort(changed, byName)
  local function counts(s)
    local used, ascUsed = 0, 0
    if s.CountAllocNodes then used, ascUsed = s:CountAllocNodes() end
    return used, ascUsed
  end
  local pUsed, pAsc = counts(spec)
  local cUsed, cAsc = counts(cSpec)
  return {
    primary = { className = spec.curClassName, ascendClassName = spec.curAscendClassName, treeVersion = spec.treeVersion, pointsUsed = pUsed, ascendancyPointsUsed = pAsc, specTitle = stripColourCodes(spec.title or 'Default') },
    compare = { className = cSpec.curClassName, ascendClassName = cSpec.curAscendClassName, treeVersion = cSpec.treeVersion, pointsUsed = cUsed, ascendancyPointsUsed = cAsc, specTitle = stripColourCodes(cSpec.title or 'Default') },
    compareOnly = added,
    primaryOnly = removed,
    differs = changed,
    sharedCount = shared,
    onlyDifferences = onlyDifferences,
  }
end

-- Items view: CompareTabClass:DrawItems (slot list, jewel section) with
-- TradeHelpers.getSlotDiffLabel, and DrawItemExpanded's mod markers
-- ("+" only on this side, ">" / "<" same mod with a higher / lower value).
local ITEM_BASE_SLOTS = { "Weapon 1", "Weapon 2", "Weapon 1 Swap", "Weapon 2 Swap", "Helmet", "Body Armour", "Gloves",
  "Boots", "Amulet", "Ring 1", "Ring 2", "Belt", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5" }

local function compareTradeHelpers(ct)
  return pobUpvalue(ct.DrawItems, 'tradeHelpers')
end

local function itemModLines(tradeHelpers, item, otherModMap)
  local lines = {}
  if not item then return lines end
  for _, modListData in ipairs{ item.enchantModLines or {}, item.scourgeModLines or {}, item.implicitModLines or {}, item.explicitModLines or {}, item.crucibleModLines or {} } do
    for _, modLine in ipairs(modListData) do
      if item:CheckModLineVariant(modLine) then
        local formatted = itemLib.formatModLine(modLine)
        if formatted then
          local marker
          if otherModMap then
            local otherEntry = otherModMap[tradeHelpers.modLineTemplate(modLine.line)]
            if not otherEntry then
              marker = '+'
            elseif otherEntry.line ~= modLine.line then
              local myVal = tradeHelpers.modLineValue(modLine.line)
              local otherVal = otherEntry.value
              if myVal and otherVal and myVal > otherVal then marker = '>'
              elseif myVal and otherVal and myVal < otherVal then marker = '<' end
            end
          end
          table.insert(lines, { text = stripColourCodes(formatted), marker = marker })
        end
      end
    end
  end
  return lines
end

local function itemSummary(item)
  if not item then return nil end
  return { id = item.id, name = stripColourCodes(item.name), title = item.title, baseName = item.baseName, rarity = item.rarity, corrupted = item.corrupted and true or nil }
end

-- The "Equip" button's hover tooltip in DrawItems: the loaded build's stat
-- changes with the compared item in that slot (Build:AddStatComparesToTooltip).
local function equipStatChanges(slotName, item)
  local calcFunc, calcBase = build.compareTab.calcs.getMiscCalculator(build)
  local newItem = Compat.construct('Item', item.raw)
  newItem:NormaliseQuality()
  local pSlot = build.itemsTab.slots[slotName]
  local override = { repSlotName = slotName, repItem = newItem }
  if pSlot and pSlot.nodeId and build.spec.allocNodes and not build.spec.allocNodes[pSlot.nodeId] then
    local node = build.spec.nodes[pSlot.nodeId]
    if node then override.addNodes = { [node] = true } end
  end
  local output = calcFunc(override)
  local tooltip = new('Tooltip')
  local count = build:AddStatComparesToTooltip(tooltip, calcBase, output, '')
  local lines = {}
  for _, line in ipairs(tooltip.lines) do
    local text = line.text and stripColourCodes(line.text)
    if text and text ~= '' then table.insert(lines, text) end
  end
  return lines, count
end

local function compareItems(ct, entry, onlyDifferences, expanded, statChanges)
  local tradeHelpers = compareTradeHelpers(ct)
  if not tradeHelpers then return nil, "CompareTab's trade helpers not found" end
  local baseSlots = {}
  for _, s in ipairs(ITEM_BASE_SLOTS) do table.insert(baseSlots, s) end
  if ct:ShouldShowRing3(entry) then table.insert(baseSlots, 10, 'Ring 3') end
  ct:AddAbyssSockets(entry, baseSlots, false)
  local pEnv = build.calcsTab.mainEnv
  local primaryHasRing3 = pEnv and pEnv.modDB:Flag(nil, 'AdditionalRingSlot')
  local pTab, cTab = build.itemsTab, entry.itemsTab
  -- PoB's label calls items with the same name a "match"; whether a slot
  -- differs is decided on the full item text instead, as the tree overlay's
  -- jewel comparison does (compareJewelsEqual in PassiveTreeView).
  local function sameItem(a, b)
    if not a or not b then return a == b end
    return a:BuildRaw() == b:BuildRaw()
  end
  local function row(label, slotName, pItem, cItem, extra)
    local diffLabel = stripColourCodes(tradeHelpers.getSlotDiffLabel(pItem, cItem)):gsub('^%((.*)%)$', '%1')
    local identical = sameItem(pItem, cItem)
    if onlyDifferences and identical then return nil end
    local r = { slot = label, slotName = slotName, status = diffLabel, identical = identical, primary = itemSummary(pItem), compare = itemSummary(cItem) }
    for k, v in pairs(extra or {}) do r[k] = v end
    if expanded then
      local pMap, cMap = tradeHelpers.buildModMap(pItem), tradeHelpers.buildModMap(cItem)
      r.primaryMods = itemModLines(tradeHelpers, pItem, cMap)
      r.compareMods = itemModLines(tradeHelpers, cItem, pMap)
    end
    -- No Equip button (and so no tooltip) where the loaded build lacks the
    -- slot: TradeHelpers.drawCopyButtons shows "Missing slot" instead.
    if statChanges and cItem and cItem.raw and not identical and not r.slotMissingInPrimary then
      local ok, lines = pcall(equipStatChanges, slotName, cItem)
      r.equipStatChanges = ok and lines or { 'failed: ' .. tostring(lines) }
    end
    return r
  end
  local slots = {}
  for _, slotName in ipairs(baseSlots) do
    local pSlot, cSlot = pTab.slots[slotName], cTab.slots[slotName]
    local pItem = pSlot and pTab.items[pSlot.selItemId]
    local cItem = cSlot and cTab.items[cSlot.selItemId]
    local r = row(slotName, slotName, pItem, cItem, { slotMissingInPrimary = (slotName == 'Ring 3' and not primaryHasRing3) or nil })
    if r then table.insert(slots, r) end
  end
  local jewels = {}
  for _, jEntry in ipairs(ct:GetJewelComparisonSlots(entry)) do
    local r = row(stripColourCodes(jEntry.label), jEntry.pSlotName, jEntry.pItem, jEntry.cItem, {
      nodeId = jEntry.nodeId,
      primaryNodeAllocated = jEntry.pNodeAllocated,
      compareNodeAllocated = jEntry.cNodeAllocated,
    })
    if r then table.insert(jewels, r) end
  end
  local function activeSetTitle(tab)
    local set = tab.itemSets and tab.itemSets[tab.activeItemSetId]
    return stripColourCodes(set and set.title or 'Default')
  end
  return { primaryItemSet = activeSetTitle(pTab), compareItemSet = activeSetTitle(cTab), slots = slots, jewels = jewels }
end

-- Skills view: CompareTabClass:DrawSkills. Socket groups are paired greedily by
-- Jaccard similarity of their gem names; within a pair common gems come first,
-- then gems only on that side ("additional"), then gems only on the other side
-- ("missing"). Imbued supports are listed as gems of their group.
local function compareSkills(ct, entry, onlyDifferences)
  local pSkillsTab, cSkillsTab = build.skillsTab, entry.skillsTab
  local pGroups = pSkillsTab and pSkillsTab.socketGroupList or {}
  local cGroups = cSkillsTab and cSkillsTab.socketGroupList or {}
  local imbuedCache = {}
  local function getImbuedGem(group, skillsTab)
    if not group or not group.imbuedSupport then return nil end
    if imbuedCache[group] then return imbuedCache[group] end
    local grantedEffect = skillsTab and skillsTab.imbuedSupportBySlot and group.slot and skillsTab.imbuedSupportBySlot[group.slot]
    if not grantedEffect then
      local gemId = data.gemForBaseName and data.gemForBaseName[group.imbuedSupport:lower() .. ' support']
      grantedEffect = gemId and data.gems[gemId] and data.gems[gemId].grantedEffect or nil
    end
    local gem = { grantedEffect = grantedEffect, nameSpec = group.imbuedSupport, level = 1, quality = 0, isImbuedSupport = true }
    imbuedCache[group] = gem
    return gem
  end
  local function gemName(gem) return gem.grantedEffect and gem.grantedEffect.name or gem.nameSpec end
  local function gemsWithImbued(group, skillsTab)
    if not group then return {} end
    local gems = {}
    for _, gem in ipairs(group.gemList or {}) do table.insert(gems, gem) end
    local imbued = getImbuedGem(group, skillsTab)
    if imbued then table.insert(gems, imbued) end
    return gems
  end
  local function nameSet(group, skillsTab)
    local set = {}
    for _, gem in ipairs(gemsWithImbued(group, skillsTab)) do
      local name = gemName(gem)
      if name then set[name] = true end
    end
    return set
  end
  local function similarity(a, b)
    local inter, union, keys = 0, 0, {}
    for k in pairs(a) do keys[k] = true end
    for k in pairs(b) do keys[k] = true end
    for k in pairs(keys) do
      union = union + 1
      if a[k] and b[k] then inter = inter + 1 end
    end
    if union == 0 then return 0 end
    return inter / union
  end
  local pSets, cSets = {}, {}
  for i, g in ipairs(pGroups) do pSets[i] = nameSet(g, pSkillsTab) end
  for i, g in ipairs(cGroups) do cSets[i] = nameSet(g, cSkillsTab) end
  local scorePairs = {}
  for pi = 1, #pGroups do
    for ci = 1, #cGroups do
      local score = similarity(pSets[pi], cSets[ci])
      if score > 0 then table.insert(scorePairs, { pIdx = pi, cIdx = ci, score = score }) end
    end
  end
  table.sort(scorePairs, function(a, b) return a.score > b.score end)
  local pMatched, cMatched, pairsList = {}, {}, {}
  for _, sp in ipairs(scorePairs) do
    if not pMatched[sp.pIdx] and not cMatched[sp.cIdx] then
      table.insert(pairsList, { pIdx = sp.pIdx, cIdx = sp.cIdx, score = sp.score })
      pMatched[sp.pIdx] = true
      cMatched[sp.cIdx] = true
    end
  end
  for i = 1, #pGroups do if not pMatched[i] then table.insert(pairsList, { pIdx = i }) end end
  for i = 1, #cGroups do if not cMatched[i] then table.insert(pairsList, { cIdx = i }) end end

  local function gemEntry(e)
    local out = { name = e.name, status = e.status }
    if e.gem then
      out.level = e.gem.level
      out.quality = e.gem.quality
      out.enabled = e.gem.enabled ~= false
      out.support = (e.gem.grantedEffect and e.gem.grantedEffect.support) and true or false
      out.imbued = e.gem.isImbuedSupport or nil
    end
    return out
  end
  local function aligned(pGroup, cGroup, pSet, cSet)
    local pDisplay, cDisplay = {}, {}
    local pGems, cGems = gemsWithImbued(pGroup, pSkillsTab), gemsWithImbued(cGroup, cSkillsTab)
    local cByName = {}
    for _, gem in ipairs(cGems) do
      local name = gemName(gem)
      if name and pSet[name] and not cByName[name] then cByName[name] = gem end
    end
    local emitted = {}
    for _, gem in ipairs(pGems) do
      local name = gemName(gem)
      if name and cSet[name] and not emitted[name] then
        emitted[name] = true
        table.insert(pDisplay, gemEntry({ gem = gem, name = name, status = 'common' }))
        table.insert(cDisplay, gemEntry({ gem = cByName[name], name = name, status = 'common' }))
      end
    end
    for _, gem in ipairs(pGems) do
      local name = gemName(gem)
      if name and not cSet[name] then table.insert(pDisplay, gemEntry({ gem = gem, name = name, status = 'additional' })) end
    end
    for _, gem in ipairs(cGems) do
      local name = gemName(gem)
      if name and not pSet[name] then table.insert(cDisplay, gemEntry({ gem = gem, name = name, status = 'additional' })) end
    end
    if pGroup and cGroup then
      local pMissing, cMissing = {}, {}
      for name in pairs(cSet) do if not pSet[name] then table.insert(pMissing, name) end end
      for name in pairs(pSet) do if not cSet[name] then table.insert(cMissing, name) end end
      table.sort(pMissing); table.sort(cMissing)
      for _, name in ipairs(pMissing) do table.insert(pDisplay, { name = name, status = 'missing' }) end
      for _, name in ipairs(cMissing) do table.insert(cDisplay, { name = name, status = 'missing' }) end
    end
    return pDisplay, cDisplay
  end
  -- A pair differs when DrawSkills would print something different in its
  -- columns: a gem marked additional/missing, or a common gem whose
  -- level/quality text differs.
  local function pairDiffers(pDisplay, cDisplay, pGroup, cGroup)
    if not pGroup or not cGroup then return true end
    for i, e in ipairs(pDisplay) do
      if e.status ~= 'common' then return true end
      local c = cDisplay[i]
      if not c or c.level ~= e.level or c.quality ~= e.quality then return true end
    end
    for _, e in ipairs(cDisplay) do if e.status ~= 'common' then return true end end
    return false
  end
  local out = {}
  for _, pair in ipairs(pairsList) do
    local pGroup = pair.pIdx and pGroups[pair.pIdx]
    local cGroup = pair.cIdx and cGroups[pair.cIdx]
    local pDisplay, cDisplay = aligned(pGroup, cGroup, pair.pIdx and pSets[pair.pIdx] or {}, pair.cIdx and cSets[pair.cIdx] or {})
    local differs = pairDiffers(pDisplay, cDisplay, pGroup, cGroup)
    if differs or not onlyDifferences then
      table.insert(out, {
        primaryGroup = pGroup and { index = pair.pIdx, label = socketGroupLabel(pGroup, pair.pIdx), enabled = pGroup.enabled ~= false, main = pair.pIdx == build.mainSocketGroup } or nil,
        compareGroup = cGroup and { index = pair.cIdx, label = socketGroupLabel(cGroup, pair.cIdx), enabled = cGroup.enabled ~= false, main = pair.cIdx == entry.mainSocketGroup } or nil,
        similarity = pair.score,
        primaryGems = pDisplay,
        compareGems = cDisplay,
        differs = differs,
      })
    end
  end
  local function activeSkillSet(tab)
    local set = tab.skillSets and tab.skillSets[tab.activeSkillSetId]
    return stripColourCodes(set and set.title or 'Default')
  end
  return { primarySkillSet = activeSkillSet(pSkillsTab), compareSkillSet = activeSkillSet(cSkillsTab), pairs = out }
end

-- Config view: CompareTabClass:RebuildConfigControls groups ConfigOptions into
-- sections (without "Custom Modifiers" and "Map Modifiers and Player
-- Debuffs"); LayoutConfigView lists, per section, the options whose
-- normalised values differ, then (unless only differences are wanted) the
-- equal ones that ConfigVisibility marks relevant to either build, or all but
-- the excluded ones with "Show All Configurations".
local function compareConfig(ct, entry, onlyDifferences, showAll)
  local configVisibility = pobUpvalue(ct.LayoutConfigView, 'configVisibility')
  if not configVisibility then return nil, "CompareTab's ConfigVisibility module not found" end
  ct:RebuildConfigControls(entry)
  ct.configNeedsRebuild = true
  local pInput = build.configTab.input or {}
  local cInput = entry.configTab.input or {}
  local sections = {}
  local diffTotal = 0
  for _, section in ipairs(ct.configSections) do
    local diffs, commons = {}, {}
    for _, ctrlInfo in ipairs(section.items) do
      local varData = ctrlInfo.varData
      local pVal, cVal = ct:NormalizeConfigVals(varData, pInput[varData.var], cInput[varData.var])
      local row = {
        var = varData.var,
        label = stripColourCodes((varData.label or varData.var):gsub(':$', '')),
        primary = stripColourCodes(ct:FormatConfigValue(varData, pInput[varData.var])),
        compare = stripColourCodes(ct:FormatConfigValue(varData, cInput[varData.var])),
        primaryValue = pInput[varData.var],
        compareValue = cInput[varData.var],
      }
      if tostring(pVal) ~= tostring(cVal) then
        row.differs = true
        table.insert(diffs, row)
      elseif not onlyDifferences then
        local relevant = configVisibility.isRelevantForBuild(varData, build) or configVisibility.isRelevantForBuild(varData, entry)
        if relevant or (showAll and not configVisibility.isShowAllExcluded(varData)) then
          table.insert(commons, row)
        end
      end
    end
    local rows = {}
    for _, r in ipairs(diffs) do table.insert(rows, r) end
    for _, r in ipairs(commons) do table.insert(rows, r) end
    if #rows > 0 then
      diffTotal = diffTotal + #diffs
      table.insert(sections, { name = section.name, diffCount = #diffs, rows = rows })
    end
  end
  local function activeConfigSet(tab)
    local set = tab.configSets and tab.configSets[tab.activeConfigSetId]
    return stripColourCodes(set and set.title or 'Default')
  end
  return { primaryConfigSet = activeConfigSet(build.configTab), compareConfigSet = activeConfigSet(entry.configTab), differences = diffTotal, sections = sections }
end

-- Calcs view: CompareTabClass:DrawCalcs over Modules/CalcSections, with the
-- tab's own calcRowMatchesBetweenBuilds and subSectionExtraMatches for
-- "Show only differences". Values are formatCalcStr's text for each build's
-- calcs environment (Calcs view skill selection).
local function compareCalcs(ct, entry, onlyDifferences, filter)
  local rowMatches = pobUpvalue(ct.DrawCalcs, 'calcRowMatchesBetweenBuilds')
  local extraMatches = pobUpvalue(ct.DrawCalcs, 'subSectionExtraMatches')
  if not rowMatches or not extraMatches then return nil, "CompareTab's calcs comparison helpers not found" end
  local pEnv = build.calcsTab.calcsEnv
  local cEnv = entry.calcsTab and entry.calcsTab.calcsEnv
  if not pEnv or not cEnv then return nil, 'calcs environment not available' end
  local pActor = (build.calcsTab.input.showMinion and pEnv.minion) or pEnv.player
  local cActor = (entry.calcsTab.input.showMinion and cEnv.minion) or cEnv.player
  if not pActor or not cActor then return nil, 'calcs actor not available' end
  local needle = type(filter) == 'string' and filter ~= '' and filter:lower() or nil
  local function fmt(colData, actor)
    local ok, str = pcall(formatCalcStr, colData.format, actor, colData)
    if ok and str then return stripColourCodes(tostring(str)) end
    return nil
  end
  local sections = {}
  local rowCount = 0
  for _, secDef in ipairs(ct.calcSections) do
    local id, group, subSections = secDef[2], secDef[3], secDef[5]
    local secData = subSections[1].data
    if build.calcsTab:CheckFlag(secData, pActor) then
      local subs = {}
      for _, subSec in ipairs(subSections) do
        local rows = {}
        local subMatches = not needle or tostring(id):lower():find(needle, 1, true) or tostring(subSec.label or ''):lower():find(needle, 1, true)
        for _, rowData in ipairs(subSec.data) do
          if rowData.label and rowData[1] and rowData[1].format then
            local pVisible = build.calcsTab:CheckFlag(rowData, pActor)
            local cVisible = build.calcsTab:CheckFlag(rowData, cActor)
            if pVisible or cVisible then
              local keep = true
              if onlyDifferences and pVisible and cVisible then
                keep = not rowMatches(ct, rowData[1], pActor, cActor, entry)
              end
              local label = stripColourCodes(rowData.label)
              if keep and (subMatches or label:lower():find(needle, 1, true)) then
                table.insert(rows, { label = label, primary = fmt(rowData[1], pActor), compare = fmt(rowData[1], cActor) })
              end
            end
          end
        end
        local extraDiffers = not extraMatches(subSec.data, pActor, cActor)
        if #rows > 0 or (onlyDifferences and extraDiffers and subMatches) then
          local sub = { label = stripColourCodes(subSec.label), rows = rows }
          if subSec.data.extra then
            local okP, pExtra = pcall(formatCalcStr, subSec.data.extra, pActor)
            local okC, cExtra = pcall(formatCalcStr, subSec.data.extra, cActor)
            if okP and okC then sub.primaryExtra = stripColourCodes(pExtra); sub.compareExtra = stripColourCodes(cExtra) end
          end
          rowCount = rowCount + #rows
          table.insert(subs, sub)
        end
      end
      if #subs > 0 then table.insert(sections, { id = id, group = group, subSections = subs }) end
    end
  end
  local function skillLabel(b, env)
    local group = b.skillsTab.socketGroupList[b.calcsTab.input.skill_number]
    return group and socketGroupLabel(group, b.calcsTab.input.skill_number) or nil
  end
  return {
    primarySkill = skillLabel(build), compareSkill = skillLabel(entry),
    primaryBuffMode = build.calcsTab.input.misc_buffMode, compareBuffMode = entry.calcsTab.input.misc_buffMode,
    primaryShowsMinion = (build.calcsTab.input.showMinion and pEnv.minion) and true or false,
    compareShowsMinion = (entry.calcsTab.input.showMinion and cEnv.minion) and true or false,
    rowCount = rowCount, sections = sections,
  }
end

-- params: { index?, sections?: string[] (stats, tree, items, skills, config, calcs),
--           only_differences? (default true), items_expanded?, item_stat_changes?,
--           config_show_all?, calcs_filter? }
function M.compare_report(params)
  local ct, err = compareTab()
  if not ct then return nil, err end
  params = type(params) == 'table' and params or {}
  local entry, index = compareEntryAt(ct, params.index)
  if not entry then return nil, index end
  refreshPrimary()
  local onlyDifferences = params.only_differences ~= false
  local wanted = {}
  local list = type(params.sections) == 'table' and #params.sections > 0 and params.sections or { 'stats', 'tree', 'items', 'skills', 'config' }
  for _, s in ipairs(list) do wanted[tostring(s)] = true end
  local result = {
    primaryName = ct:GetShortBuildName(build.buildName),
    compareName = entry.label,
    index = index,
    onlyDifferences = onlyDifferences,
  }
  local runners = {
    stats = function() return compareStats(ct, entry, onlyDifferences) end,
    tree = function() return compareTree(ct, entry, onlyDifferences) end,
    items = function() return compareItems(ct, entry, onlyDifferences, params.items_expanded == true, params.item_stat_changes == true) end,
    skills = function() return compareSkills(ct, entry, onlyDifferences) end,
    config = function() return compareConfig(ct, entry, onlyDifferences, params.config_show_all == true) end,
    calcs = function() return compareCalcs(ct, entry, onlyDifferences, params.calcs_filter) end,
  }
  for name in pairs(wanted) do
    if not runners[name] then return nil, 'unknown section: ' .. name .. ' (stats, tree, items, skills, config, calcs)' end
  end
  for _, name in ipairs({ 'stats', 'tree', 'items', 'skills', 'config', 'calcs' }) do
    if wanted[name] then
      local ok, res, rerr = pcall(runners[name])
      if not ok then
        result[name] = { error = tostring(res) }
      elseif res == nil then
        result[name] = { error = rerr or 'failed' }
      else
        result[name] = res
      end
    end
  end
  return result
end

-- The metrics of the power report's dropdown (CompareTabClass:InitControls):
-- data.powerStatList entries with a stat that are not ignoreForNodes.
local function comparePowerStats()
  local list = {}
  for _, e in ipairs(data.powerStatList) do
    if e.stat and not e.ignoreForNodes then table.insert(list, e) end
  end
  return list
end

local POWER_SORT_COLUMNS = { category = 1, impact = 3, points = 4, per_point = 5 }

-- params: { index?, metric?: stat or label, categories?: { tree, items, skill_gems, support_gems, config },
--           sort_by?: category|impact|points|per_point, limit? }
-- CompareTabClass:ComparePowerBuilder, driven to completion the way
-- RunComparePowerReport resumes it each frame; rows sorted and formatted by
-- the tab's ComparePowerReportListControl (SetReport, ReSort, GetRowValue).
function M.compare_power_report(params)
  local ct, err = compareTab()
  if not ct then return nil, err end
  params = type(params) == 'table' and params or {}
  local metrics = comparePowerStats()
  local metricList = {}
  for _, e in ipairs(metrics) do table.insert(metricList, { stat = e.stat, label = e.label }) end
  if params.metric == nil or params.metric == '' then
    return { metrics = metricList, needsMetric = true }
  end
  local wantedMetric = tostring(params.metric):lower()
  local powerStat
  for _, e in ipairs(metrics) do
    if e.stat:lower() == wantedMetric or tostring(e.label):lower() == wantedMetric then powerStat = e break end
  end
  if not powerStat then return { metrics = metricList, unknownMetric = params.metric } end
  local sortCol = POWER_SORT_COLUMNS[tostring(params.sort_by or 'impact')]
  if not sortCol then return nil, 'sort_by must be category, impact, points or per_point' end
  local entry, index = compareEntryAt(ct, params.index)
  if not entry then return nil, index end
  refreshPrimary()
  local c = type(params.categories) == 'table' and params.categories or {}
  local function flag(v) return v ~= false end
  local categories = {
    treeNodes = flag(c.tree), items = flag(c.items), skillGems = flag(c.skill_gems),
    supportGems = flag(c.support_gems), config = flag(c.config),
  }
  ct.comparePowerStat = powerStat
  ct.comparePowerCategories = categories
  -- Keep the tab's metric dropdown and category checkboxes in step, so the
  -- window (when the tools run there) shows the report it holds.
  for i, v in ipairs(ct.controls.comparePowerStatSelect.list or {}) do
    if v == powerStat then ct.controls.comparePowerStatSelect.selIndex = i end
  end
  ct.controls.comparePowerTreeCheck.state = categories.treeNodes
  ct.controls.comparePowerItemsCheck.state = categories.items
  ct.controls.comparePowerGemsCheck.state = categories.skillGems
  ct.controls.comparePowerSupportGemsCheck.state = categories.supportGems
  ct.controls.comparePowerConfigCheck.state = categories.config
  ct.comparePowerCompareId = entry
  ct.comparePowerDirty = false
  ct.comparePowerResults = nil
  ct.comparePowerProgress = 0
  local co = coroutine.create(function() ct:ComparePowerBuilder(entry, powerStat, categories) end)
  local steps = 0
  while coroutine.status(co) ~= 'dead' do
    local ok, cerr = coroutine.resume(co)
    if not ok then
      build.buildFlag = true
      refreshPrimary()
      return nil, 'power report failed: ' .. tostring(cerr)
    end
    steps = steps + 1
  end
  ct.comparePowerCoroutine = nil
  ct.comparePowerListSynced = false
  -- The builder adds and removes skill groups and config values on the loaded
  -- build and leaves it flagged; recalculate so its output is current again.
  build.buildFlag = true
  refreshPrimary()
  local results = ct.comparePowerResults or {}
  local listControl = ct.controls.comparePowerReportList
  listControl:SetReport(powerStat, results)
  if sortCol ~= 3 then listControl:ReSort(sortCol) end
  local limit = tonumber(params.limit)
  local rows = {}
  for i, r in ipairs(listControl.list) do
    if limit and i > limit then break end
    table.insert(rows, {
      category = r.category,
      name = stripColourCodes(r.name),
      impact = r.impact,
      percent = r.impactPercent,
      impactText = stripColourCodes(listControl:GetRowValue(3, i, r)),
      points = r.pathDist,
      perPoint = r.perPoint,
      perPointText = r.perPointStr and stripColourCodes(r.perPointStr) or nil,
      nodeId = r.nodeId,
      slotName = r.slotName,
    })
  end
  return {
    metric = { stat = powerStat.stat, label = powerStat.label },
    categories = { tree = categories.treeNodes, items = categories.items, skill_gems = categories.skillGems, support_gems = categories.supportGems, config = categories.config },
    compareName = entry.label,
    index = index,
    total = #listControl.list,
    status = listControl.statusText,
    rows = rows,
    resumes = steps,
  }
end

-- Resolve a compared item for the Items view's Copy / Equip / Buy buttons:
-- a gear slot name, or a jewel socket ("Jewel <nodeId>" or its label).
local function compareItemForSlot(ct, entry, slot)
  if type(slot) ~= 'string' or slot == '' then return nil, 'slot is required (e.g. "Helmet", "Ring 1", "Jewel 26725")' end
  local cSlot = entry.itemsTab.slots[slot]
  if cSlot and not cSlot.nodeId then
    local item = entry.itemsTab.items[cSlot.selItemId]
    if not item then return nil, 'the compared build has no item in ' .. slot end
    return item, slot, slot
  end
  local wanted = slot:lower()
  for _, jEntry in ipairs(ct:GetJewelComparisonSlots(entry)) do
    if jEntry.pSlotName:lower() == wanted or stripColourCodes(jEntry.label):lower() == wanted or tostring(jEntry.nodeId) == slot then
      if not jEntry.cItem then return nil, 'the compared build has no jewel in ' .. slot end
      return jEntry.cItem, jEntry.cSlotName, jEntry.pSlotName
    end
  end
  return nil, 'unknown slot: ' .. slot
end

local REALM_DISPLAY = { pc = 'PC', sony = 'PS4', ps4 = 'PS4', xbox = 'Xbox' }
local LISTED_INDEX = { securable = 1, available = 2, online = 3, any = 4 }

-- params: { index?, slot, league?, realm?, listed?, use_base_type?, ilvl_min?, ilvl_max?,
--           mods?: 'all' | number[], mod_values?: { [index]: { min?, max? } },
--           defences?: 'all' | string[], defence_values?: { [label]: { min?, max? } } }
-- The Items view's "Buy" button: CompareBuySimilar.openPopup collects the mod
-- entries (CompareBuySimilar.addModEntries) and defence values, and its local
-- buildURL turns the popup's selections into the trade search URL. Here the
-- popup's controls are stand-ins holding the requested selections, with the
-- popup's defaults otherwise (nothing ticked, mod minimums prefilled with the
-- item's values, defence minimums with the floored defence values).
function M.compare_buy_similar(params)
  local ct, err = compareTab()
  if not ct then return nil, err end
  params = type(params) == 'table' and params or {}
  local entry, index = compareEntryAt(ct, params.index)
  if not entry then return nil, index end
  local buySimilar = pobUpvalue(ct.DrawItems, 'buySimilar')
  local buildURL = buySimilar and pobUpvalue(buySimilar.openPopup, 'buildURL')
  if not buySimilar or not buildURL then return nil, "CompareBuySimilar's URL builder not found" end
  local item, slotOrErr, equipSlotName = compareItemForSlot(ct, entry, params.slot)
  if not item then return nil, slotOrErr end
  local isUnique = item.rarity == 'UNIQUE' or item.rarity == 'RELIC'
  local modEntries = buySimilar.addModEntries(item, {
    { list = item.enchantModLines, type = 'enchant' },
    { list = item.implicitModLines, type = 'implicit' },
    { list = item.explicitModLines, type = 'explicit' },
    { list = item.scourgeModLines, type = 'scourge' },
  })
  local defenceEntries = {}
  if not isUnique and item.armourData and item.base and item.base.armour then
    for _, def in ipairs({
      { key = 'Armour', label = 'Armour', tradeKey = 'ar' },
      { key = 'Evasion', label = 'Evasion', tradeKey = 'ev' },
      { key = 'EnergyShield', label = 'Energy Shield', tradeKey = 'es' },
      { key = 'Ward', label = 'Ward', tradeKey = 'ward' },
    }) do
      local val = item.armourData[def.key]
      if val and val > 0 then table.insert(defenceEntries, { label = def.label, value = val, tradeKey = def.tradeKey }) end
    end
  end

  local realmKey = tostring(params.realm or 'pc'):lower()
  local realmDisplay = REALM_DISPLAY[realmKey]
  if not realmDisplay then return nil, 'realm must be pc, sony or xbox' end
  local league = (type(params.league) == 'string' and params.league ~= '') and params.league or 'Standard'
  local listedIndex = LISTED_INDEX[tostring(params.listed or 'securable'):lower()]
  if not listedIndex then return nil, 'listed must be securable, available, online or any' end
  local function edit(value) return { buf = value ~= nil and tostring(value) or '' } end
  local controls = {
    realmDrop = { GetSelValue = function() return realmDisplay end },
    leagueDrop = { GetSelValue = function() return league end },
    listedDrop = { selIndex = listedIndex },
  }
  if not isUnique then
    controls.baseTypeCheck = { state = params.use_base_type == true }
    controls.ilvlMin = edit(tonumber(params.ilvl_min))
    controls.ilvlMax = edit(tonumber(params.ilvl_max))
  end

  local wantAllMods = params.mods == 'all'
  local wantedMods = {}
  if type(params.mods) == 'table' then for _, i in ipairs(params.mods) do wantedMods[tonumber(i)] = true end end
  local modValues = type(params.mod_values) == 'table' and params.mod_values or {}
  local mods, skipped = {}, {}
  for i, e in ipairs(modEntries) do
    local prefix = 'mod' .. i
    local canSearch = #e.tradeIds > 0
    local checked = canSearch and (wantAllMods or wantedMods[i]) and true or false
    if (wantAllMods or wantedMods[i]) and not canSearch then table.insert(skipped, i) end
    controls[prefix .. 'Check'] = { state = checked }
    local hasRange = not (e.isOption or e.needsExactValue) and e.value ~= nil
    local override = modValues[tostring(i)] or modValues[i]
    local minDefault = (hasRange and e.value ~= 0) and e.value or nil
    local minVal, maxVal = minDefault, nil
    if type(override) == 'table' then
      if override.min ~= nil then minVal = tonumber(override.min) end
      if override.max ~= nil then maxVal = tonumber(override.max) end
    end
    controls[prefix .. 'Min'] = edit(minVal)
    controls[prefix .. 'Max'] = edit(maxVal)
    local lines = {}
    for _, l in ipairs(e.formattedLines) do table.insert(lines, stripColourCodes(l)) end
    table.insert(mods, {
      index = i, type = e.type, text = table.concat(lines, ' + '), searchable = canSearch, selected = checked,
      option = e.isOption or nil, tradeIds = e.tradeIds, value = e.value, min = hasRange and minVal or nil, max = hasRange and maxVal or nil,
    })
  end
  do
    for i in pairs(wantedMods) do
      if not modEntries[i] then return nil, string.format('mod %s not found (1-%d)', tostring(i), #modEntries) end
    end
  end

  local wantAllDef = params.defences == 'all'
  local wantedDef = {}
  if type(params.defences) == 'table' then for _, d in ipairs(params.defences) do wantedDef[tostring(d):lower()] = true end end
  local defValues = type(params.defence_values) == 'table' and params.defence_values or {}
  local defences = {}
  for i, def in ipairs(defenceEntries) do
    local prefix = 'def' .. i
    local checked = wantAllDef or wantedDef[def.label:lower()] or wantedDef[def.tradeKey] or false
    local minVal, maxVal = math.floor(def.value), nil
    local override = defValues[def.label] or defValues[def.tradeKey]
    if type(override) == 'table' then
      if override.min ~= nil then minVal = tonumber(override.min) end
      if override.max ~= nil then maxVal = tonumber(override.max) end
    end
    controls[prefix .. 'Check'] = { state = checked and true or false }
    controls[prefix .. 'Min'] = edit(minVal)
    controls[prefix .. 'Max'] = edit(maxVal)
    table.insert(defences, { label = def.label, tradeKey = def.tradeKey, value = def.value, selected = checked and true or false, min = minVal, max = maxVal })
  end

  local ok, url = pcall(buildURL, item, equipSlotName, controls, modEntries, defenceEntries, isUnique)
  if not ok then return nil, 'building the trade URL failed: ' .. tostring(url) end
  local tradeHelpers = compareTradeHelpers(ct)
  local category = tradeHelpers and tradeHelpers.getTradeCategory(equipSlotName, item)
  return {
    url = url,
    item = itemSummary(item),
    slot = equipSlotName,
    unique = isUnique,
    category = (not isUnique) and category or nil,
    categoryLabel = (not isUnique and tradeHelpers) and tradeHelpers.getTradeCategoryLabel(equipSlotName, item) or nil,
    realm = realmDisplay, league = league, listed = params.listed or 'securable',
    mods = mods, skippedMods = skipped, defences = defences,
    compareName = entry.label, index = index,
  }
end

-- params: { index?, what: 'tree'|'item'|'config', slot? (item), use?: boolean }
-- The tab's copy buttons: "Copy tree" / "Copy and use" (CopyCompareSpecToPrimary),
-- the Items view's "Copy" / "Equip" (CopyCompareItemToPrimary) and "Copy Config
-- from Compare Build" (CopyCompareConfig).
function M.compare_copy(params)
  local ct, err = compareTab()
  if not ct then return nil, err end
  params = type(params) == 'table' and params or {}
  local entry, index = compareEntryAt(ct, params.index)
  if not entry then return nil, index end
  local what = tostring(params.what or '')
  local use = params.use == true
  local result = { what = what, used = use, compareName = entry.label, index = index }
  if what == 'tree' then
    local source = entry.treeTab.specList[entry.treeTab.activeSpec]
    if not source then return nil, 'the compared build has no active tree' end
    local before = #build.treeTab.specList
    ct:CopyCompareSpecToPrimary(use)
    if #build.treeTab.specList == before then return nil, 'the tree was not copied' end
    result.specIndex = #build.treeTab.specList
    result.specTitle = stripColourCodes(build.treeTab.specList[result.specIndex].title)
    result.activeSpec = build.treeTab.activeSpec
  elseif what == 'item' then
    local item, copySlotName, equipSlotName = compareItemForSlot(ct, entry, params.slot)
    if not item then return nil, copySlotName end
    -- DrawItems passes slotMissing for Ring 3 when the loaded build has no
    -- third ring slot; that row shows "Missing slot" instead of Equip.
    local pEnv = build.calcsTab.mainEnv
    if use and equipSlotName == 'Ring 3' and not (pEnv and pEnv.modDB:Flag(nil, 'AdditionalRingSlot')) then
      return nil, 'the loaded build has no Ring 3 slot (PoB shows "Missing slot" there, no Equip); copy without use to add the item unequipped'
    end
    -- ItemsTab:AddItem takes the lowest free id, so the new item is the one
    -- whose id was not there before, not necessarily the highest.
    local idsBefore = {}
    for id in pairs(build.itemsTab.items) do idsBefore[id] = true end
    -- The Items view copies from copySlotName and equips into equipSlotName;
    -- for gear and jewel sockets both are the same slot name.
    ct:CopyCompareItemToPrimary(use and equipSlotName or copySlotName, entry, use)
    local newItem
    for id, it in pairs(build.itemsTab.items) do if not idsBefore[id] then newItem = it end end
    if not newItem then return nil, 'the item was not copied' end
    result.item = itemSummary(newItem)
    result.slot = equipSlotName
    local pSlot = build.itemsTab.slots[equipSlotName]
    result.equipped = pSlot and pSlot.selItemId == newItem.id or false
  elseif what == 'config' then
    ct:CopyCompareConfig()
    result.configSet = stripColourCodes((build.configTab.configSets[build.configTab.activeConfigSetId] or {}).title or 'Default')
  else
    return nil, "what must be 'tree', 'item' or 'config'"
  end
  M.advanceFrame()
  M.get_main_output()
  local out = build.calcsTab.mainOutput or {}
  result.stats = { Life = out.Life, EnergyShield = out.EnergyShield, TotalEHP = out.TotalEHP, CombinedDPS = out.CombinedDPS, FullDPS = out.FullDPS }
  return result
end

-- ===========================================================================
-- Skills tab, config tab and minions: gems ranked by PoB's DPS sort, skill
-- sets, config sets, the spectre library, the main skill's minion, and the
-- config tab's custom modifiers. Each function names the PoB code it mirrors.
-- ===========================================================================

-- SkillsTab.lua sortGemTypeList, defaultGemLevelList and showSupportGemTypeList.
local GEM_SORT_FIELDS = { FullDPS = true, CombinedDPS = true, TotalDPS = true, AverageDamage = true,
  TotalDot = true, BleedDPS = true, IgniteDPS = true, TotalPoisonDPS = true, TotalEHP = true }
local GEM_LEVEL_MODES = { normalMaximum = true, corruptedMaximum = true, awakenedMaximum = true,
  characterLevel = true, levelOne = true }
local SUPPORT_GEM_TYPES = { ALL = true, NORMAL = true, EXCEPTIONAL = true }
-- GemSelectControl:OnKeyDown: the "S" and "A" overlay buttons set sortGemsBy to these tags.
local GEM_TYPE_TAGS = { support = 'support', active = 'grants_active_skill', all = false }
-- The edit boxes of SkillSetListControl/ConfigSetListControl:RenameSet take at most 100 characters.
local SET_TITLE_MAX = 100

-- Ranks the gems PoB's gem dropdown offers for one gem slot of a socket group,
-- by the DPS PoB computes with each gem in that slot. This drives PoB's own
-- GemSelectControl the way the open dropdown does with "Sort gems by DPS" on:
-- UpdateSortCache (candidates, which supports can support the group's skills,
-- the misc calculator and base DPS), BuildList (filter and order), then the
-- DPSBuilder coroutine (CalcOutputWithThisGem per candidate), run to the end.
-- The DPS is PoB's for the field chosen (SkillsTab sortGemsByDPSField): for
-- every field but FullDPS that is the main skill's output, as in PoB, so a
-- support in another group only moves it when it reaches the main skill.
-- params: { groupIndex?, gemIndex?, dpsField?, gemType?: 'support'|'active'|'all',
--           search?, defaultGemLevel?, defaultGemQuality?, showSupportGemTypes?,
--           showLegacyGems?, includeUnevaluated?, limit? }
function M.rank_gems_by_dps(params)
  if not build or not build.skillsTab or not build.calcsTab then return nil, 'skills not initialized' end
  params = type(params) == 'table' and params or {}
  local skillsTab = build.skillsTab
  local groupList = skillsTab.socketGroupList or {}
  local groupIndex = tonumber(params.groupIndex) or build.mainSocketGroup or 1
  local group = groupList[groupIndex]
  if not group then
    return nil, string.format('socket group %s not found (valid range: 1-%d)', tostring(params.groupIndex or groupIndex), #groupList)
  end
  -- SkillsTab hides the gem slots of groups granted by items or passives.
  if group.source then return nil, 'socket group ' .. groupIndex .. ' is granted by an item or passive; PoB does not let you edit its gems' end
  local gemCount = #(group.gemList or {})
  local slotIndex = tonumber(params.gemIndex) or (gemCount + 1)
  if slotIndex < 1 or slotIndex > gemCount + 1 or slotIndex % 1 ~= 0 then
    return nil, string.format('gem index must be 1-%d (%d = a new gem slot)', gemCount + 1, gemCount + 1)
  end
  local dpsField = params.dpsField or skillsTab.sortGemsByDPSField or 'CombinedDPS'
  if not GEM_SORT_FIELDS[dpsField] then return nil, 'unknown DPS sort field: ' .. tostring(dpsField) end
  local gemType = params.gemType or 'support'
  if GEM_TYPE_TAGS[gemType] == nil then return nil, "gem type must be 'support', 'active' or 'all'" end
  if params.defaultGemLevel ~= nil and not GEM_LEVEL_MODES[params.defaultGemLevel] then
    return nil, 'unknown default gem level: ' .. tostring(params.defaultGemLevel)
  end
  if params.showSupportGemTypes ~= nil and not SUPPORT_GEM_TYPES[params.showSupportGemTypes] then
    return nil, 'support gem types must be ALL, NORMAL or EXCEPTIONAL'
  end
  local quality = params.defaultGemQuality ~= nil and tonumber(params.defaultGemQuality) or nil
  if params.defaultGemQuality ~= nil and (not quality or quality < 0 or quality > 23) then
    return nil, 'default gem quality must be 0-23'
  end
  local search = params.search ~= nil and tostring(params.search) or ''
  local limit = math.min(math.max(tonumber(params.limit) or 25, 1), 500)

  -- Fresh output, so the misc calculator UpdateSortCache takes describes the build as it is.
  M.get_main_output()
  local saved = {
    displayGroup = skillsTab.displayGroup, sortGemsByDPS = skillsTab.sortGemsByDPS,
    sortGemsByDPSField = skillsTab.sortGemsByDPSField, showSupportGemTypes = skillsTab.showSupportGemTypes,
    showLegacyGems = skillsTab.showLegacyGems, defaultGemLevel = skillsTab.defaultGemLevel,
    defaultGemQuality = skillsTab.defaultGemQuality,
  }
  -- CalcOutputWithThisGem puts each candidate into the slot's gem table and
  -- restores only gemData, level and displayEffect. The calculation also writes
  -- per-skill choices onto the instances it runs (skillPart, skillMinion, ...),
  -- so an active candidate leaves such fields on the gem it replaced. Keep the
  -- group, its gem list and every gem's fields, and put them back afterwards.
  local function fieldsOf(t) local copy = {} for k, v in pairs(t) do copy[k] = v end return copy end
  local function restoreFields(t, copy)
    for k in pairs(t) do if copy[k] == nil then t[k] = nil end end
    for k, v in pairs(copy) do t[k] = v end
  end
  local groupFields, gemTables, gemFields = fieldsOf(group), {}, {}
  for i, gem in ipairs(group.gemList) do gemTables[i], gemFields[i] = gem, fieldsOf(gem) end
  local ok, result = pcall(function()
    -- GemSelectControl reads the group from skillsTab.displayGroup (SetDisplayGroup
    -- sets it; the rest of SetDisplayGroup only refills the tab's edit boxes).
    skillsTab.displayGroup = group
    skillsTab.sortGemsByDPS = true
    skillsTab.sortGemsByDPSField = dpsField
    if params.showSupportGemTypes ~= nil then skillsTab.showSupportGemTypes = params.showSupportGemTypes end
    if params.showLegacyGems ~= nil then skillsTab.showLegacyGems = params.showLegacyGems == true end
    if params.defaultGemLevel ~= nil then skillsTab.defaultGemLevel = params.defaultGemLevel end
    if quality then skillsTab.defaultGemQuality = quality end

    local control = Compat.construct('GemSelectControl', nil, { 0, 0, 300, 20 }, skillsTab, slotIndex, function() end)
    control.sortGemsBy = GEM_TYPE_TAGS[gemType] or nil
    control:UpdateSortCache()
    control:BuildList(search)
    local sortCache = control.sortCache
    -- The open dropdown calculates every pending gem; with a search, only the
    -- gems the search lists are worth the time.
    if search ~= '' and sortCache.pendingGems then
      local listed = {}
      for _, gemId in ipairs(control.list) do listed[gemId] = true end
      local pending = {}
      for _, gemId in ipairs(sortCache.pendingGems) do
        if listed[gemId] then pending[#pending + 1] = gemId end
      end
      sortCache.pendingGems = pending
    end
    local evaluated, evaluatedCount = {}, 0
    for _, gemId in ipairs(sortCache.pendingGems or {}) do
      evaluated[gemId] = true
      evaluatedCount = evaluatedCount + 1
    end
    local builder = coroutine.create(control.DPSBuilder)
    repeat
      local resumed, err = coroutine.resume(builder, control)
      if not resumed then error(err, 0) end
    until coroutine.status(builder) == 'dead'
    -- Rebuild the list now every DPS is known, as the dropdown re-sorts on each draw.
    control:BuildList(search)

    local baseDPS = sortCache.baseDPS or 0
    local candidates, listedCount = {}, 0
    for position, gemId in ipairs(control.list) do
      local gemData = control.gems[gemId]
      if gemData then
        listedCount = listedCount + 1
        if (evaluated[gemId] or params.includeUnevaluated == true) and #candidates < limit then
          local dps = tonumber(sortCache.dps[gemId]) or baseDPS
          table.insert(candidates, {
            position = position,
            name = gemData.name,
            gemId = gemData.id,
            support = gemData.grantedEffect and gemData.grantedEffect.support == true or false,
            canSupport = sortCache.canSupport[gemId] == true,
            evaluated = evaluated[gemId] == true,
            level = skillsTab:ProcessGemLevel(gemData),
            dps = dps,
            delta = dps - baseDPS,
            percent = baseDPS ~= 0 and (dps - baseDPS) / baseDPS * 100 or nil,
          })
        end
      end
    end
    local replaced = group.gemList[slotIndex]
    local activeSkills = {}
    for _, activeSkill in ipairs(group.displaySkillList or {}) do
      local effect = activeSkill.activeEffect
      if effect and effect.grantedEffect then table.insert(activeSkills, effect.grantedEffect.name) end
    end
    return {
      groupIndex = groupIndex,
      groupLabel = group.displayLabel or group.label,
      activeSkills = activeSkills,
      mainSocketGroup = build.mainSocketGroup,
      gemIndex = slotIndex,
      replaces = replaced and (replaced.nameSpec or replaced.name) or nil,
      dpsField = dpsField,
      gemType = gemType,
      search = search,
      defaultGemLevel = skillsTab.defaultGemLevel,
      defaultGemQuality = skillsTab.defaultGemQuality or 0,
      baseDPS = baseDPS,
      evaluatedCount = evaluatedCount,
      listedCount = listedCount,
      candidates = candidates,
    }
  end)
  for key, value in pairs(saved) do skillsTab[key] = value end
  restoreFields(group, groupFields)
  for i = #group.gemList, 1, -1 do group.gemList[i] = nil end
  for i, gem in ipairs(gemTables) do
    restoreFields(gem, gemFields[i])
    group.gemList[i] = gem
  end
  if not ok then return nil, 'gem ranking failed: ' .. tostring(result) end
  return result
end

-- ---------------------------------------------------------------------------
-- Skill sets (SkillSetListControl, SkillsTab:NewSkillSet / SetActiveSkillSet)
-- ---------------------------------------------------------------------------

local function checkSetTitle(title)
  if type(title) ~= 'string' or not title:match('%S') then return nil, 'title must contain a non-space character' end
  if #title > SET_TITLE_MAX then return nil, 'title too long (max ' .. SET_TITLE_MAX .. ' characters)' end
  return title
end

local function orderIndexOf(list, id)
  for index, value in ipairs(list) do if value == id then return index end end
  return nil
end

function M.list_skill_sets()
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  local tab, sets = build.skillsTab, {}
  for index, id in ipairs(tab.skillSetOrderList or {}) do
    local set = tab.skillSets[id]
    if set then
      table.insert(sets, {
        index = index, id = id,
        -- SkillSetListControl:GetRowValue shows an untitled set as "Default".
        title = set.title or 'Default',
        active = id == tab.activeSkillSetId,
        socketGroups = #(set.socketGroupList or {}),
      })
    end
  end
  return { skillSets = sets, activeSkillSetId = tab.activeSkillSetId }
end

local function skillSetById(id)
  local tab = build.skillsTab
  id = tonumber(id)
  if not id or not tab.skillSets[id] or not orderIndexOf(tab.skillSetOrderList, id) then return nil end
  return tab.skillSets[id], id
end

-- SkillSetListControl:OnSelClick (double click): SetActiveSkillSet, AddUndoState.
function M.select_skill_set(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  local set, id = skillSetById(type(params) == 'table' and params.id)
  if not set then return nil, 'skill set id ' .. tostring(params and params.id) .. ' not found (see list_skill_sets)' end
  -- OnSelClick does nothing for the set already active.
  if id == build.skillsTab.activeSkillSetId then
    local list = M.list_skill_sets()
    list.unchanged = true
    return list
  end
  build.skillsTab:SetActiveSkillSet(id)
  build.skillsTab:AddUndoState()
  M.get_main_output()
  return M.list_skill_sets()
end

-- SkillSetListControl "New" (SkillsTab:NewSkillSet) and "Copy" (copyTable of the
-- set, each socket group and gem), then RenameSet's Save: title, modFlag, add
-- to the order list, AddUndoState, SyncLoadouts. PoB does not switch to it.
-- params: { title, copyFrom?: id, activate?: boolean }
function M.create_skill_set(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  params = type(params) == 'table' and params or {}
  local title, err = checkSetTitle(params.title)
  if not title then return nil, err end
  local tab = build.skillsTab
  local newSet
  if params.copyFrom ~= nil then
    local source = skillSetById(params.copyFrom)
    if not source then return nil, 'skill set id to copy ' .. tostring(params.copyFrom) .. ' not found' end
    newSet = copyTable(source, true)
    newSet.socketGroupList = {}
    for _, socketGroup in pairs(source.socketGroupList) do
      local newGroup = copyTable(socketGroup, true)
      newGroup.gemList = {}
      for gemIndex, gem in pairs(socketGroup.gemList) do newGroup.gemList[gemIndex] = copyTable(gem, true) end
      table.insert(newSet.socketGroupList, newGroup)
    end
    newSet.id = 1
    while tab.skillSets[newSet.id] do newSet.id = newSet.id + 1 end
    tab.skillSets[newSet.id] = newSet
  else
    newSet = tab:NewSkillSet()
  end
  newSet.title = title
  tab.modFlag = true
  table.insert(tab.skillSetOrderList, newSet.id)
  tab:AddUndoState()
  build:SyncLoadouts()
  if params.activate == true then
    tab:SetActiveSkillSet(newSet.id)
    tab:AddUndoState()
    M.get_main_output()
  end
  local list = M.list_skill_sets()
  list.created = newSet.id
  return list
end

-- SkillSetListControl:RenameSet's Save.
function M.rename_skill_set(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  params = type(params) == 'table' and params or {}
  local set = skillSetById(params.id)
  if not set then return nil, 'skill set id ' .. tostring(params.id) .. ' not found (see list_skill_sets)' end
  local title, err = checkSetTitle(params.title)
  if not title then return nil, err end
  set.title = title
  build.skillsTab.modFlag = true
  build.skillsTab:AddUndoState()
  build:SyncLoadouts()
  return M.list_skill_sets()
end

-- SkillSetListControl:OnSelDelete's confirm: remove from the order list and
-- the sets; a deleted active set hands over to the set above it.
function M.delete_skill_set(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  params = type(params) == 'table' and params or {}
  local tab = build.skillsTab
  local set, id = skillSetById(params.id)
  if not set then return nil, 'skill set id ' .. tostring(params.id) .. ' not found (see list_skill_sets)' end
  if #tab.skillSetOrderList <= 1 then return nil, 'cannot delete the only skill set' end
  local index = orderIndexOf(tab.skillSetOrderList, id)
  table.remove(tab.skillSetOrderList, index)
  tab.skillSets[id] = nil
  if id == tab.activeSkillSetId then
    tab:SetActiveSkillSet(tab.skillSetOrderList[math.max(1, index - 1)])
  end
  tab:AddUndoState()
  build:SyncLoadouts()
  M.get_main_output()
  local list = M.list_skill_sets()
  list.deleted = { id = id, title = set.title or 'Default' }
  return list
end

-- ---------------------------------------------------------------------------
-- Config sets (ConfigSetListControl, ConfigTab:NewConfigSet / SetActiveConfigSet)
-- ---------------------------------------------------------------------------

function M.list_config_sets()
  if not build or not build.configTab then return nil, 'config not initialized' end
  local tab, sets = build.configTab, {}
  for index, id in ipairs(tab.configSetOrderList or {}) do
    local set = tab.configSets[id]
    if set then
      table.insert(sets, {
        index = index, id = id,
        title = set.title or 'Default',
        active = id == tab.activeConfigSetId,
        customModGroups = #(set.customModsList or {}),
      })
    end
  end
  return { configSets = sets, activeConfigSetId = tab.activeConfigSetId }
end

local function configSetById(id)
  local tab = build.configTab
  id = tonumber(id)
  if not id or not tab.configSets[id] or not orderIndexOf(tab.configSetOrderList, id) then return nil end
  return tab.configSets[id], id
end

-- ConfigSetListControl:OnSelClick (double click).
function M.select_config_set(params)
  if not build or not build.configTab then return nil, 'config not initialized' end
  local set, id = configSetById(type(params) == 'table' and params.id)
  if not set then return nil, 'config set id ' .. tostring(params and params.id) .. ' not found (see list_config_sets)' end
  -- OnSelClick does nothing for the set already active.
  if id == build.configTab.activeConfigSetId then
    local list = M.list_config_sets()
    list.unchanged = true
    return list
  end
  build.configTab:SetActiveConfigSet(id)
  build.configTab:AddUndoState()
  M.get_main_output()
  return M.list_config_sets()
end

-- ConfigSetListControl "New" (ConfigTab:NewConfigSet) and "Copy" (copyTable of
-- the set), then RenameSet's Save. PoB does not switch to it.
-- params: { title, copyFrom?: id, activate?: boolean }
function M.create_config_set(params)
  if not build or not build.configTab then return nil, 'config not initialized' end
  params = type(params) == 'table' and params or {}
  local title, err = checkSetTitle(params.title)
  if not title then return nil, err end
  local tab = build.configTab
  local newSet
  if params.copyFrom ~= nil then
    local source = configSetById(params.copyFrom)
    if not source then return nil, 'config set id to copy ' .. tostring(params.copyFrom) .. ' not found' end
    newSet = copyTable(source)
    newSet.id = 1
    while tab.configSets[newSet.id] do newSet.id = newSet.id + 1 end
    tab.configSets[newSet.id] = newSet
  else
    newSet = tab:NewConfigSet()
  end
  newSet.title = title
  tab.modFlag = true
  table.insert(tab.configSetOrderList, newSet.id)
  tab:AddUndoState()
  build:SyncLoadouts()
  if params.activate == true then
    tab:SetActiveConfigSet(newSet.id)
    tab:AddUndoState()
    M.get_main_output()
  end
  local list = M.list_config_sets()
  list.created = newSet.id
  return list
end

-- ConfigSetListControl:RenameSet's Save.
function M.rename_config_set(params)
  if not build or not build.configTab then return nil, 'config not initialized' end
  params = type(params) == 'table' and params or {}
  local set = configSetById(params.id)
  if not set then return nil, 'config set id ' .. tostring(params.id) .. ' not found (see list_config_sets)' end
  local title, err = checkSetTitle(params.title)
  if not title then return nil, err end
  set.title = title
  build.configTab.modFlag = true
  build.configTab:AddUndoState()
  build:SyncLoadouts()
  return M.list_config_sets()
end

-- ConfigSetListControl:OnSelDelete's confirm.
function M.delete_config_set(params)
  if not build or not build.configTab then return nil, 'config not initialized' end
  params = type(params) == 'table' and params or {}
  local tab = build.configTab
  local set, id = configSetById(params.id)
  if not set then return nil, 'config set id ' .. tostring(params.id) .. ' not found (see list_config_sets)' end
  if #tab.configSetOrderList <= 1 then return nil, 'cannot delete the only config set' end
  local index = orderIndexOf(tab.configSetOrderList, id)
  table.remove(tab.configSetOrderList, index)
  tab.configSets[id] = nil
  if id == tab.activeConfigSetId then
    tab:SetActiveConfigSet(tab.configSetOrderList[math.max(1, index - 1)])
  end
  tab:AddUndoState()
  build:SyncLoadouts()
  M.get_main_output()
  local list = M.list_config_sets()
  list.deleted = { id = id, title = set.title or 'Default' }
  return list
end

-- ---------------------------------------------------------------------------
-- Spectre library (buildMode:OpenSpectreLibrary, MinionListControl,
-- MinionSearchListControl) and the main skill's minion (Build.lua and
-- CalcsTab's "Minion" / "Minion Skill" dropdowns)
-- ---------------------------------------------------------------------------

local SPECTRE_SEARCH_MODES = { names = 1, skills = 2, both = 3 }

local function describeMinion(id)
  local minion = build.data.minions[id]
  local skills = {}
  for _, skillId in ipairs(minion and minion.skillList or {}) do
    if build.data.skills[skillId] then table.insert(skills, build.data.skills[skillId].name) end
  end
  return { id = id, name = minion and minion.name or id, skills = skills }
end

-- OpenSpectreLibrary's source list: every spectre, by name then id.
local function spectreSourceList()
  local sourceList = {}
  for id in pairs(build.data.spectres or {}) do table.insert(sourceList, id) end
  table.sort(sourceList, function(a, b)
    if build.data.minions[a].name == build.data.minions[b].name then return a < b end
    return build.data.minions[a].name < build.data.minions[b].name
  end)
  return sourceList
end

-- params: { search?: string, searchMode?: 'names'|'skills'|'both', limit? }
function M.list_spectres(params)
  if not build or not build.data or not build.data.minions then return nil, 'build not initialized' end
  params = type(params) == 'table' and params or {}
  local inBuild = {}
  for index, id in ipairs(build.spectreList or {}) do
    local entry = describeMinion(id)
    entry.index = index
    table.insert(inBuild, entry)
  end
  local result = { spectres = inBuild }
  if params.search ~= nil then
    local mode = SPECTRE_SEARCH_MODES[params.searchMode or 'names']
    if not mode then return nil, "search mode must be 'names', 'skills' or 'both'" end
    local limit = math.min(math.max(tonumber(params.limit) or 50, 1), 1000)
    -- The library popup's own controls do the filtering.
    local dest = Compat.construct('MinionListControl', nil, { 0, 0, 265, 250 }, build.data, copyTable(build.spectreList or {}))
    local source = Compat.construct('MinionSearchListControl', nil, { 0, 0, 265, 230 }, build.data, spectreSourceList(), dest)
    source:ListFilterChanged(tostring(params.search), mode)
    local found = {}
    for _, id in ipairs(source.list) do
      if #found >= limit then break end
      local entry = describeMinion(id)
      entry.inBuild = isValueInArray(build.spectreList or {}, id) and true or false
      table.insert(found, entry)
    end
    result.library = { search = tostring(params.search), searchMode = params.searchMode or 'names', total = #source.list, results = found }
  end
  return result
end

-- A minion by id, or by its name when exactly one candidate carries it.
local function resolveMinion(ref, candidates)
  if type(ref) ~= 'string' or ref == '' then return nil, 'minion must be a non-empty id or name' end
  for _, id in ipairs(candidates) do if id == ref then return id end end
  local matches = {}
  for _, id in ipairs(candidates) do
    local minion = build.data.minions[id]
    if minion and (minion.name or ''):lower() == ref:lower() then table.insert(matches, id) end
  end
  if #matches == 1 then return matches[1] end
  if #matches > 1 then return nil, 'several minions are named "' .. ref .. '"; use an id: ' .. table.concat(matches, ', ') end
  return nil, 'no minion "' .. ref .. '"'
end

-- The library popup: Add (MinionListControl:AddSel, no duplicates), Remove
-- (OnSelDelete), then Save (spectreList = the edited copy, modFlag, buildFlag).
-- params: { add?: string[], remove?: string[] }
function M.set_spectres(params)
  if not build or not build.data or not build.data.spectres then return nil, 'build not initialized' end
  params = type(params) == 'table' and params or {}
  local add = type(params.add) == 'table' and params.add or {}
  local remove = type(params.remove) == 'table' and params.remove or {}
  if #add == 0 and #remove == 0 then return nil, 'nothing to change: give add and/or remove' end
  local destList = copyTable(build.spectreList or {})
  local added, removed, unchanged = {}, {}, {}
  for _, ref in ipairs(remove) do
    local id, err = resolveMinion(ref, destList)
    if not id then return nil, 'remove: ' .. err .. ' in the build' end
    table.remove(destList, isValueInArray(destList, id))
    table.insert(removed, id)
  end
  local sourceList = spectreSourceList()
  for _, ref in ipairs(add) do
    local id, err = resolveMinion(ref, sourceList)
    if not id then return nil, 'add: ' .. err .. ' in the spectre library' end
    if isValueInArray(destList, id) then
      table.insert(unchanged, id)
    else
      table.insert(destList, id)
      table.insert(added, id)
    end
  end
  build.spectreList = destList
  build.modFlag = true
  build.buildFlag = true
  M.get_main_output()
  local result = M.list_spectres({})
  result.added, result.removed, result.alreadyInBuild = added, removed, unchanged
  return result
end

-- The main skill of the sidebar (suffix '') or of the Calcs tab ('Calcs').
local function mainSkillFor(calcs)
  local suffix = calcs and 'Calcs' or ''
  local groupIndex = calcs and build.calcsTab.input.skill_number or build.mainSocketGroup
  local group = build.skillsTab.socketGroupList[groupIndex]
  if not group then return nil, 'no main socket group' end
  local displaySkillList = group['displaySkillList' .. suffix] or {}
  local activeSkill = displaySkillList[group['mainActiveSkill' .. suffix] or 1]
  if not activeSkill or not activeSkill.activeEffect then return nil, 'the main socket group has no active skill' end
  return { suffix = suffix, groupIndex = groupIndex, group = group, activeSkill = activeSkill, activeEffect = activeSkill.activeEffect }
end

local function hasMinionChoice(activeSkill, activeEffect)
  return not activeSkill.skillFlags.disable
    and (activeEffect.grantedEffect.minionList or (activeSkill.minionList and activeSkill.minionList[1])) and true or false
end

-- What buildMode:RefreshSkillSelectControls fills the Minion and Minion Skill
-- dropdowns with. params: { calcs?: boolean }
function M.get_minion_options(params)
  if not build or not build.skillsTab or not build.calcsTab then return nil, 'skills not initialized' end
  params = type(params) == 'table' and params or {}
  M.get_main_output()
  local ctx, err = mainSkillFor(params.calcs == true)
  if not ctx then return nil, err end
  local activeSkill, activeEffect, suffix = ctx.activeSkill, ctx.activeEffect, ctx.suffix
  local src = activeEffect.srcInstance or {}
  local result = {
    calcs = params.calcs == true,
    groupIndex = ctx.groupIndex,
    skill = activeEffect.grantedEffect.name,
    hasMinion = false,
  }
  if not hasMinionChoice(activeSkill, activeEffect) then return result end
  result.hasMinion = true
  local options = {}
  if activeEffect.grantedEffect.minionHasItemSet then
    result.selectsItemSet = true
    for _, itemSetId in ipairs(build.itemsTab.itemSetOrderList) do
      local itemSet = build.itemsTab.itemSets[itemSetId]
      table.insert(options, { itemSetId = itemSetId, label = itemSet.title or 'Default Item Set' })
    end
    result.selectedItemSetId = src['skillMinionItemSet' .. suffix] or 1
  else
    result.usesSpectreLibrary = (activeEffect.grantedEffect.minionList and not activeEffect.grantedEffect.minionList[1]) and true or false
    for _, minionId in ipairs(activeSkill.minionList or {}) do
      local minion = build.data.minions[minionId]
      table.insert(options, { minionId = minionId, label = minion and minion.name or minionId })
    end
    result.selectedMinion = src['skillMinion' .. suffix] or (options[1] and options[1].minionId)
  end
  result.options = options
  if activeSkill.minion then
    local skills = {}
    for index, minionSkill in ipairs(activeSkill.minion.activeSkillList or {}) do
      table.insert(skills, { index = index, name = minionSkill.activeEffect.grantedEffect.name })
    end
    result.minionSkills = skills
    result.selectedMinionSkill = src['skillMinionSkill' .. suffix] or 1
  else
    -- RefreshSkillSelectControls shows "<No spectres in build>" here.
    result.noSpectres = true
  end
  return result
end

-- The Minion dropdown (srcInstance.skillMinion / skillMinionItemSet, with the
-- Calcs suffix in the Calcs tab) and the Minion Skill dropdown (skillMinionSkill).
-- params: { calcs?, minion?: id or name, itemSetId?, minionSkill?: index or name }
function M.set_minion(params)
  if not build or not build.skillsTab or not build.calcsTab then return nil, 'skills not initialized' end
  params = type(params) == 'table' and params or {}
  if params.minion == nil and params.itemSetId == nil and params.minionSkill == nil then
    return nil, 'nothing to change: give a minion, an item set id or a minion skill'
  end
  local calcs = params.calcs == true
  M.get_main_output()
  local ctx, err = mainSkillFor(calcs)
  if not ctx then return nil, err end
  local activeSkill, activeEffect, suffix = ctx.activeSkill, ctx.activeEffect, ctx.suffix
  if not hasMinionChoice(activeSkill, activeEffect) then
    return nil, 'the main skill (' .. tostring(activeEffect.grantedEffect.name) .. ') has no minion to choose'
  end
  local src = activeEffect.srcInstance
  -- Check the minion (or item set) before writing anything.
  local field, value
  if params.minion ~= nil or params.itemSetId ~= nil then
    if activeEffect.grantedEffect.minionHasItemSet then
      if params.minion ~= nil then return nil, activeEffect.grantedEffect.name .. "'s minion is chosen by item set: give an item set id" end
      local itemSetId = tonumber(params.itemSetId)
      if not itemSetId or not build.itemsTab.itemSets[itemSetId] then return nil, 'item set id ' .. tostring(params.itemSetId) .. ' not found' end
      field, value = 'skillMinionItemSet' .. suffix, itemSetId
    else
      if params.itemSetId ~= nil then return nil, activeEffect.grantedEffect.name .. ' does not take an item set: give a minion' end
      local minionId, resolveErr = resolveMinion(tostring(params.minion), activeSkill.minionList or {})
      if not minionId then
        local ids = {}
        for _, id in ipairs(activeSkill.minionList or {}) do table.insert(ids, id) end
        return nil, (resolveErr or 'unknown minion') .. ' for this skill; options: ' .. (#ids > 0 and table.concat(ids, ', ') or 'none (add spectres with set_spectres)')
      end
      field, value = 'skillMinion' .. suffix, minionId
    end
  end
  -- The minion's skills depend on the minion chosen, so a minion skill can only
  -- be checked after the recalculation; a failed check puts everything back.
  local saved = {
    minion = src['skillMinion' .. suffix], itemSet = src['skillMinionItemSet' .. suffix],
    skill = src['skillMinionSkill' .. suffix], modFlag = build.modFlag, buildFlag = build.buildFlag,
  }
  local function fail(message)
    src['skillMinion' .. suffix], src['skillMinionItemSet' .. suffix] = saved.minion, saved.itemSet
    src['skillMinionSkill' .. suffix] = saved.skill
    M.get_main_output()
    build.modFlag, build.buildFlag = saved.modFlag, saved.buildFlag
    return nil, message
  end
  if field then
    src[field] = value
    M.get_main_output()
  end
  if params.minionSkill ~= nil then
    ctx = mainSkillFor(calcs)
    local minion = ctx and ctx.activeSkill.minion
    if not minion then return fail('the main skill has no minion yet (no spectres in the build?)') end
    local skills = minion.activeSkillList or {}
    local index = tonumber(params.minionSkill)
    if not index then
      for i, minionSkill in ipairs(skills) do
        if minionSkill.activeEffect.grantedEffect.name:lower() == tostring(params.minionSkill):lower() then index = i break end
      end
    end
    if not index or not skills[index] then
      local names = {}
      for i, minionSkill in ipairs(skills) do table.insert(names, i .. '=' .. minionSkill.activeEffect.grantedEffect.name) end
      return fail('minion skill ' .. tostring(params.minionSkill) .. ' not found; options: ' .. table.concat(names, ', '))
    end
    src['skillMinionSkill' .. suffix] = index
    M.get_main_output()
  end
  build.modFlag = true
  build.buildFlag = true
  return M.get_minion_options({ calcs = calcs })
end

-- ---------------------------------------------------------------------------
-- Config tab custom modifiers (ConfigTab's "Custom Modifiers" section: mod
-- groups of CustomModBlockControl, "Add Mod Group", each group's "Add Mod")
-- ---------------------------------------------------------------------------

-- ConfigTab:BuildModList reads each line this way; a line counts only when
-- modLib.parseMod parses all of it (the edit box shows the rest as unsupported).
local function parseCustomModLine(line)
  local stripped = StripEscapes(line):match('^%s*(.-)%s*$')
  local mods, extra = modLib.parseMod(stripped)
  return { text = stripped, supported = (mods and not extra) and true or false, unparsed = extra }
end

local function describeCustomMods(configSet)
  local groups = {}
  for index, block in ipairs(configSet.customModsList or {}) do
    local lines = {}
    for line in (block.text or ''):gmatch('([^\n]*)\n?') do
      if line:match('%S') then table.insert(lines, parseCustomModLine(line)) end
    end
    table.insert(groups, {
      index = index,
      title = block.title or 'Default',
      enabled = block.enabled ~= false,
      text = block.text or '',
      lines = lines,
    })
  end
  return groups
end

-- The "Add Mod" browser: ConfigTab:OpenAddModPopup builds and filters its list
-- in local functions, so open the popup on a scratch group, type the search
-- into its search box and read its list, then close it.
local function browseCustomMods(query, limit)
  if not (main and type(main.popups) == 'table') or not build.configTab.OpenAddModPopup then
    return nil, 'the mod browser is not available in this PoB version'
  end
  local before = #main.popups
  local scratch = { title = 'Default', enabled = true, text = '' }
  local opened, err = pcall(build.configTab.OpenAddModPopup, build.configTab, scratch)
  local popup = main.popups[1]
  if not opened or #main.popups ~= before + 1 or not popup or not popup.controls or not popup.controls.listControl then
    if #main.popups == before + 1 then main:ClosePopup() end
    return nil, 'mod browser did not open: ' .. tostring(err)
  end
  local ok, result = pcall(function()
    popup.controls.search:SetText(query, true)
    local results, total = {}, 0
    for _, modText in ipairs(popup.controls.listControl.list or {}) do
      if modText ~= 'No matching modifiers found' then
        total = total + 1
        if #results < limit then
          table.insert(results, { text = modText, supported = parseCustomModLine(modText).supported })
        end
      end
    end
    return { query = query, total = total, results = results }
  end)
  if main.popups[1] == popup then main:ClosePopup() end
  if not ok then return nil, 'mod browser failed: ' .. tostring(result) end
  return result
end

-- params: { search?: string, limit? }
function M.get_custom_mods(params)
  if not build or not build.configTab then return nil, 'config not initialized' end
  params = type(params) == 'table' and params or {}
  local tab = build.configTab
  local configSet = tab.configSets[tab.activeConfigSetId]
  if not configSet then return nil, 'active config set not found' end
  local result = {
    configSetId = tab.activeConfigSetId,
    configSetTitle = configSet.title or 'Default',
    groups = describeCustomMods(configSet),
  }
  if params.search ~= nil then
    local limit = math.min(math.max(tonumber(params.limit) or 50, 1), 1000)
    local browse, err = browseCustomMods(tostring(params.search), limit)
    if not browse then return nil, err end
    result.browser = browse
  end
  return result
end

-- A group's edit box keeps printable characters, tabs and newlines ("^%C\t\n").
local function cleanCustomModText(text)
  return (tostring(text):gsub('\r\n', '\n'):gsub('[^%C\t\n]', ''))
end

-- One change to the active config set's custom modifier groups, as the
-- section's controls make it: "Add Mod Group" (a group titled "Group N"), the
-- group's delete button (the last group gives way to an empty "Default"), its
-- title and text boxes, its enable box, and "Add Mod" (appends a line).
-- Each ends as they do: AddUndoState, BuildModList, buildFlag.
-- params: { groupIndex?, addGroup?, removeGroup?, title?, text?, appendMod?, enabled? }
function M.set_custom_mods(params)
  if not build or not build.configTab then return nil, 'config not initialized' end
  params = type(params) == 'table' and params or {}
  local tab = build.configTab
  local configSet = tab.configSets[tab.activeConfigSetId]
  if not configSet then return nil, 'active config set not found' end
  if params.addGroup == true and params.removeGroup == true then return nil, 'adding and removing a group cannot be combined' end
  local edits = params.title ~= nil or params.text ~= nil or params.appendMod ~= nil or params.enabled ~= nil
  if not (params.addGroup == true or params.removeGroup == true or edits) then
    return nil, 'nothing to change: add or remove a group, or give a title, text, a modifier to append, or enabled'
  end
  if params.removeGroup == true and edits then return nil, 'removing a group cannot be combined with edits' end
  local appendLine
  if params.appendMod ~= nil then
    appendLine = cleanCustomModText(params.appendMod):gsub('\n', ' ')
    if not appendLine:match('%S') then return nil, 'the modifier to append must be a non-empty line' end
  end
  -- ConfigTab:UpdateCustomModsControls never leaves a set without a group.
  configSet.customModsList = configSet.customModsList or {}
  local list = configSet.customModsList
  if #list == 0 then table.insert(list, { title = 'Default', enabled = true, text = '' }) end
  local index
  if params.addGroup == true then
    table.insert(list, { title = 'Group ' .. (#list + 1), enabled = true, text = '' })
    index = #list
  else
    index = tonumber(params.groupIndex) or (#list == 1 and 1 or nil)
    if not index or not list[index] then
      return nil, string.format('custom modifier group %s not found (valid range: 1-%d)', tostring(params.groupIndex), #list)
    end
  end
  local removed
  if params.removeGroup == true then
    removed = table.remove(list, index)
    if #list == 0 then table.insert(list, { title = 'Default', enabled = true, text = '' }) end
  else
    local block = list[index]
    if params.title ~= nil then block.title = tostring(params.title) end
    if params.text ~= nil then block.text = cleanCustomModText(params.text) end
    if appendLine then
      if block.text and #block.text > 0 and not block.text:match('\n$') then block.text = block.text .. '\n' end
      block.text = (block.text or '') .. appendLine
    end
    if params.enabled ~= nil then block.enabled = params.enabled == true end
  end
  if tab.UpdateCustomModsControls then tab:UpdateCustomModsControls() end
  tab:AddUndoState()
  tab:BuildModList()
  build.buildFlag = true
  M.get_main_output()
  local result = M.get_custom_mods({})
  if removed then
    result.removed = { index = index, title = removed.title or 'Default', text = removed.text or '' }
  else
    result.groupIndex = index
  end
  return result
end

-- ===========================================================================
-- Calcs tab breakdowns
-- ===========================================================================
-- The Calcs tab (Classes/CalcsTab.lua) lays its cells out from
-- Modules/CalcSections.lua into CalcSectionControl objects. Each cell
-- (colData) carries a display format plus a list of "section data" entries,
-- and hovering it hands that list to CalcBreakdownControl:SetBreakdownData,
-- which turns each entry into text lines and tables: the breakdown tables
-- Calcs wrote into actor.breakdown (AddBreakdownSection) and the modifier
-- tables tabulated from the mod store (AddModSection). The functions below
-- walk the same cells and run those two PoB methods, so every row comes from
-- PoB itself; only the drawing is left out.

-- The Calcs tab's actor: the minion when its "Show Minion Stats" box is set
-- (CalcBreakdownControl:AddBreakdownSection picks it the same way).
local function calcsActor(calcsTab)
  local env = calcsTab.calcsEnv
  if not env then return nil end
  return calcsTab.input.showMinion and env.minion or env.player
end

local function calcText(value)
  if value == nil then return nil end
  return (stripColourCodes(tostring(value)):gsub('^%s+', ''):gsub('%s+$', ''))
end

-- A subsection whose first row has no label is a column header row
-- (HitDamage's "Physical:", "Lightning:", ...; Maximum Hit Taken's types).
local function columnHeaders(subSec)
  local first = subSec.data and subSec.data[1]
  if not first or first.label then return nil end
  local headers = {}
  for i, cell in ipairs(first) do
    headers[i] = cell.format and (calcText(cell.format):gsub(':$', '')) or nil
  end
  return headers
end

-- buffModeDropList in CalcsTab.lua: the tab's "Calculation Mode".
local CALC_MODES = { UNBUFFED = true, BUFFED = true, COMBAT = true, EFFECTIVE = true }

-- Run fn with the Calcs tab showing the player or the minion (its "Show
-- Minion Stats" checkbox) in the given calculation mode (its "Calculation
-- Mode" dropdown), and put both back afterwards. Both are saved with the
-- build, so a read must not leave them changed.
-- The CALCS half of CalcsTab:BuildOutput: the Calcs tab's own environment
-- and the refresh of its pinned breakdown pane. The calculation mode is read
-- only for this pass (CalcSetup takes misc_buffMode when mode == "CALCS"),
-- so the MAIN output, the node and misc calculators and the power report
-- stay valid, and the power computation is not restarted.
local function rebuildCalcsEnv(calcsTab)
  calcsTab.calcsEnv = calcsTab.calcs.buildOutput(calcsTab.build, "CALCS")
  calcsTab.calcsOutput = calcsTab.calcsEnv.player.output
  if calcsTab.displayData and calcsTab.controls and calcsTab.controls.breakdown then
    calcsTab.controls.breakdown:SetBreakdownData()
    calcsTab.controls.breakdown:SetBreakdownData(calcsTab.displayData, calcsTab.displayPinned)
  end
end

local function withCalcsView(params, fn)
  local calcsTab = build.calcsTab
  local mode = params.mode and tostring(params.mode):upper() or nil
  if mode and not CALC_MODES[mode] then
    return nil, 'unknown calculation mode "' .. tostring(params.mode) .. '"; use UNBUFFED, BUFFED, COMBAT or EFFECTIVE'
  end
  local previousMinion, previousMode = calcsTab.input.showMinion, calcsTab.input.misc_buffMode
  local modeChanged = mode ~= nil and mode ~= previousMode
  -- Everything that changes the tab runs under pcall, so the mode, the
  -- minion box and calcsEnv are put back even when a calculation throws.
  local ok, a, b = pcall(function()
    if modeChanged then
      calcsTab.input.misc_buffMode = mode
      rebuildCalcsEnv(calcsTab)
    end
    calcsTab.input.showMinion = params.minion == true or nil
    if params.minion == true and not (calcsTab.calcsEnv and calcsTab.calcsEnv.minion) then
      error("the Calcs tab's skill has no minion, so there are no minion stats to show", 0)
    end
    return fn()
  end)
  calcsTab.input.showMinion = previousMinion
  if modeChanged then
    calcsTab.input.misc_buffMode = previousMode
    local restored, restoreErr = pcall(rebuildCalcsEnv, calcsTab)
    if not restored then
      return nil, 'the Calcs tab mode was put back, but recalculating it failed: ' .. tostring(restoreErr)
        .. (ok and '' or ('; the read itself failed: ' .. tostring(a)))
    end
  end
  if not ok then return nil, tostring(a) end
  return a, b
end

-- What the Calcs tab is showing: its mode, actor and the skill it details.
local function calcsViewInfo(calcsTab)
  local env = calcsTab.calcsEnv
  local skill = env and env.player and env.player.mainSkill
  local effect = skill and skill.activeEffect
  return {
    mode = calcsTab.input.misc_buffMode,
    actor = calcsTab.input.showMinion and 'minion' or 'player',
    haveMinion = env and env.minion ~= nil or false,
    skill = effect and effect.grantedEffect and effect.grantedEffect.name or nil,
  }
end

-- Every labelled cell of the Calcs tab, in the tab's order, with its
-- address, labels, the value it displays and whether the tab shows it for
-- this build (CalcSectionControl:UpdateSize's CheckFlag tests).
local function collectCalcCells(calcsTab, actor)
  local cells = {}
  for _, section in ipairs(calcsTab.sectionList or {}) do
    local sectionShown = calcsTab:CheckFlag(section)
    for subIndex, subSec in ipairs(section.subSection or {}) do
      local headers = columnHeaders(subSec)
      for rowIndex, rowData in ipairs(subSec.data or {}) do
        if rowData.label then
          local rowShown = sectionShown and calcsTab:CheckFlag(rowData)
          for colIndex, colData in ipairs(rowData) do
            if colData.format then
              local breakdowns = {}
              for _, sectionData in ipairs(colData) do
                if sectionData.breakdown then breakdowns[#breakdowns + 1] = sectionData.breakdown end
              end
              local shown = rowShown and calcsTab:CheckFlag(colData) or false
              local valueOk, value = pcall(formatCalcStr, colData.format, actor, colData)
              cells[#cells + 1] = {
                id = section.id .. '/' .. subIndex .. '/' .. rowIndex .. '/' .. colIndex,
                section = section.id,
                subsection = calcText(subSec.label),
                row = calcText(rowData.label),
                column = headers and headers[colIndex] or nil,
                value = shown and valueOk and calcText(value) or nil,
                outputKey = colData.format:match('{%d*:?output:([%a%.]+)}'),
                breakdowns = breakdowns,
                hasBreakdown = #colData > 0,
                shown = shown,
                colData = colData,
              }
            end
          end
        end
      end
    end
  end
  return cells
end

local function normaliseStatName(text)
  return (tostring(text or ''):lower():gsub('[^%w]', ''))
end

-- The names a caller may use for a cell, strongest first: its id; the
-- output key it displays; the breakdown keys it shows (a "Base from
-- Armours" cell shows the Armour breakdown too, but displays another
-- number); then its labels.
local function cellNames(cell)
  local tiers = { { cell.id }, {}, {}, {} }
  if cell.outputKey then
    table.insert(tiers[2], cell.outputKey)
    table.insert(tiers[2], (cell.outputKey:gsub('^%a+%.', '')))
  end
  for _, name in ipairs(cell.breakdowns) do
    table.insert(tiers[3], name)
    table.insert(tiers[3], (name:gsub('^%a+%.', '')))
  end
  local labels = tiers[4]
  local row, col, sub = cell.row or '', cell.column, cell.subsection or ''
  if col then
    table.insert(labels, row .. ' ' .. col)
    table.insert(labels, col .. ' ' .. row)
    table.insert(labels, sub .. ' ' .. row .. ' ' .. col)
  else
    table.insert(labels, row)
    table.insert(labels, sub .. ' ' .. row)
    table.insert(labels, cell.section .. ' ' .. row)
  end
  return tiers
end

local function publicCell(cell)
  return {
    id = cell.id, section = cell.section, subsection = cell.subsection, row = cell.row,
    column = cell.column, value = cell.value, outputKey = cell.outputKey,
    breakdowns = cell.breakdowns, hasBreakdown = cell.hasBreakdown, shown = cell.shown,
  }
end

-- Every word of the filter must appear in one of the cell's names, as the
-- Calcs tab's search box matches labels ("max hit" finds Maximum Hit Taken).
local function cellMatchesFilter(cell, filter)
  local terms = {}
  for term in tostring(filter):gmatch('%S+') do
    local t = normaliseStatName(term)
    if t ~= '' then terms[#terms + 1] = t end
  end
  if #terms == 0 then return true end
  for _, tier in ipairs(cellNames(cell)) do
    for _, name in ipairs(tier) do
      local n = normaliseStatName(name)
      local all = true
      for _, t in ipairs(terms) do
        if not n:find(t, 1, true) then all = false break end
      end
      if all then return true end
    end
  end
  return false
end

-- params: { filter?: string, minion?: boolean, mode?: string, includeHidden?: boolean }
function M.list_calc_breakdowns(params)
  params = params or {}
  local _, err = M.get_main_output()
  if err then return nil, err end
  return withCalcsView(params, function()
    local calcsTab = build.calcsTab
    local actor = calcsActor(calcsTab)
    if not actor then error('the Calcs tab has no calculation environment (no minion to show?)') end
    local filter = type(params.filter) == 'string' and params.filter or ''
    local list = {}
    for _, cell in ipairs(collectCalcCells(calcsTab, actor)) do
      if (cell.shown or params.includeHidden == true) and cellMatchesFilter(cell, filter) then
        list[#list + 1] = publicCell(cell)
      end
    end
    local result = calcsViewInfo(calcsTab)
    result.cells = list
    return result
  end)
end

-- CalcBreakdownControl's section list as plain data: text lines, tables
-- with the columns PoB draws (those with a value in some row, as
-- SetBreakdownData sizes them), and the radius of an area breakdown.
local function breakdownSectionsToData(sectionList)
  local out = {}
  for _, section in ipairs(sectionList) do
    if section.type == 'TEXT' then
      local lines = {}
      for _, line in ipairs(section.lines or {}) do lines[#lines + 1] = calcText(line) end
      out[#out + 1] = { type = 'text', lines = lines }
    elseif section.type == 'TABLE' then
      local columns, keys = {}, {}
      for _, col in ipairs(section.colList or {}) do
        for _, row in ipairs(section.rowList or {}) do
          if row[col.key] ~= nil then
            columns[#columns + 1] = calcText(col.label)
            keys[#keys + 1] = col.key
            break
          end
        end
      end
      local rows = {}
      for _, row in ipairs(section.rowList or {}) do
        local cells = {}
        for i, key in ipairs(keys) do cells[i] = row[key] ~= nil and calcText(row[key]) or '' end
        rows[#rows + 1] = cells
      end
      out[#out + 1] = { type = 'table', label = calcText(section.label), footer = calcText(section.footer), columns = columns, rows = rows }
    elseif section.type == 'RADIUS' then
      out[#out + 1] = { type = 'radius', radius = section.radius }
    end
  end
  return out
end

-- params: { stat: string, section?: string, minion?: boolean, mode?: string }
function M.get_calc_breakdown(params)
  params = params or {}
  if type(params.stat) ~= 'string' or params.stat == '' then return nil, 'stat is required' end
  local _, err = M.get_main_output()
  if err then return nil, err end
  local BreakdownClass = common and common.classes and common.classes.CalcBreakdownControl
  if not BreakdownClass then return nil, 'CalcBreakdownControl is not loaded' end
  return withCalcsView(params, function()
    local calcsTab = build.calcsTab
    local actor = calcsActor(calcsTab)
    if not actor then error('the Calcs tab has no calculation environment (no minion to show?)') end
    local cells = collectCalcCells(calcsTab, actor)
    local wanted = normaliseStatName(params.stat)
    local sectionFilter = params.section and normaliseStatName(params.section) or nil

    -- The strongest tier wins; within it, cells the tab shows for this build
    -- beat hidden ones, which have nothing to break down.
    local matches
    for tier = 1, 4 do
      local found = {}
      for _, cell in ipairs(cells) do
        local inSection = not sectionFilter or normaliseStatName(cell.section) == sectionFilter
          or normaliseStatName(cell.subsection) == sectionFilter
        if inSection then
          for _, name in ipairs(cellNames(cell)[tier]) do
            if normaliseStatName(name) == wanted then found[#found + 1] = cell break end
          end
        end
      end
      if #found > 0 then matches = found break end
    end
    if not matches then
      local close = {}
      for _, cell in ipairs(cells) do
        if cell.shown and #close < 15 and wanted ~= '' and cellMatchesFilter(cell, params.stat) then
          close[#close + 1] = publicCell(cell)
        end
      end
      return { found = false, candidates = close }
    end
    local shown = {}
    for _, cell in ipairs(matches) do if cell.shown then shown[#shown + 1] = cell end end
    local pool = #shown > 0 and shown or matches
    -- CalcSections repeats a row under exclusive flags (Skill DPS for
    -- triggered and other skills); hidden copies of one stat are one answer.
    if #shown == 0 and #pool > 1 then
      local key = function(cell) return tostring(cell.outputKey) .. '|' .. table.concat(cell.breakdowns, ',') end
      local same = true
      for _, cell in ipairs(pool) do if key(cell) ~= key(pool[1]) then same = false break end end
      if same then pool = { pool[1] } end
    end
    if #pool > 1 then
      local candidates = {}
      for i, cell in ipairs(pool) do if i <= 15 then candidates[i] = publicCell(cell) end end
      return { found = false, ambiguous = true, candidates = candidates }
    end
    local cell = pool[1]
    local result = publicCell(cell)
    for k, v in pairs(calcsViewInfo(calcsTab)) do result[k] = v end
    result.found = true
    result.sections = {}
    if not cell.shown then return result end
    -- CalcBreakdownControl:SetBreakdownData without the layout: the same
    -- CheckFlag filter, then AddBreakdownSection or AddModSection for each
    -- entry, run on a stand-in object so the tab's own pane is left alone.
    local proxy = setmetatable({ calcsTab = calcsTab, sectionList = {} }, { __index = BreakdownClass })
    for _, sectionData in ipairs(cell.colData) do
      if calcsTab:CheckFlag(sectionData) then
        if sectionData.breakdown then
          BreakdownClass.AddBreakdownSection(proxy, sectionData)
        elseif sectionData.modName then
          BreakdownClass.AddModSection(proxy, sectionData)
        end
      end
    end
    result.sections = breakdownSectionsToData(proxy.sectionList)
    return result
  end)
end

-- ===========================================================================
-- Party tab
-- ===========================================================================
-- Classes/PartyTab.lua keeps its import, append, clear, "Disable Party
-- Effects" and "Rebuild All" logic in closures behind its controls. These
-- operations set the controls as a user does (destination dropdown, Append
-- checkbox) and press the same buttons, so PoB's own code parses the
-- exported buffs into partyTab.actor, which CalcPerform reads as
-- env.partyMembers.

-- partyDestinations in PartyTab.lua.
local PARTY_DESTINATIONS = { 'All', 'Party Member Stats', 'Aura', 'Curse', 'Warcry Skills', 'Link Skills', 'EnemyConditions', 'EnemyMods' }

local function partyTabOrError()
  if not build or not build.partyTab or not build.partyTab.controls then return nil, 'party tab not initialized' end
  return build.partyTab
end

local function selectPartyDestination(partyTab, destination)
  destination = destination or 'All'
  for _, name in ipairs(PARTY_DESTINATIONS) do
    if name:lower() == tostring(destination):lower() then
      partyTab.controls.importCodeDestination:SelByValue(name)
      return name
    end
  end
  return nil, 'unknown destination "' .. tostring(destination) .. '"; use one of: ' .. table.concat(PARTY_DESTINATIONS, ', ')
end

local function recalcAfterPartyChange()
  build.buildFlag = true
  M.advanceFrame()
  M.get_main_output()
end

-- Entries of one of the party actor's buff lists (PartyTab:ParseBuffs keys
-- them by name, Vaal skills in a nested "Vaal" list), with their effect.
local function partyEffectList(list)
  local out = {}
  for name, entry in pairs(list or {}) do
    if type(entry) == 'table' and entry.effectMult == nil and name == 'Vaal' then
      for vaalName, vaalEntry in pairs(entry) do
        out[#out + 1] = { name = vaalName, effect = vaalEntry.effectMult, mods = vaalEntry.modList and #vaalEntry.modList or 0 }
      end
    elseif type(entry) == 'table' then
      out[#out + 1] = { name = name, effect = entry.effectMult, mods = entry.modList and #entry.modList or 0, isMark = entry.isMark or nil }
    end
  end
  table.sort(out, function(a, b) return tostring(a.name) < tostring(b.name) end)
  return out
end

function M.party_get()
  local partyTab, err = partyTabOrError()
  if not partyTab then return nil, err end
  local c = partyTab.controls
  local actor = partyTab.actor or {}
  local aura, curse, warcry, link = actor.Aura or {}, actor.Curse or {}, actor.Warcry or {}, actor.Link or {}
  local stats = {}
  for k, v in pairs(actor.output or {}) do
    if type(v) == 'number' then stats[k] = v
    elseif type(v) == 'table' then
      for k2, v2 in pairs(v) do if type(v2) == 'number' then stats[k .. '.' .. k2] = v2 end end
    end
  end
  local memberFlags = {}
  for name in pairs((actor.modDB and actor.modDB.mods) or {}) do memberFlags[#memberFlags + 1] = name end
  table.sort(memberFlags)
  local enemyMods = {}
  for _, mod in ipairs(partyTab.enemyModList or {}) do
    enemyMods[#enemyMods + 1] = { name = mod.name, type = mod.type, value = type(mod.value) ~= 'table' and mod.value or nil }
  end
  local otherEffects = {}
  for name, entry in pairs(aura.otherEffects or {}) do
    otherEffects[#otherEffects + 1] = { name = name, effect = entry.effectMult, mods = entry.modList and #entry.modList or 0 }
  end
  table.sort(otherEffects, function(a, b) return tostring(a.name) < tostring(b.name) end)
  local extraAura = aura.extraAura and aura.extraAura.extraAura
  local function text(control) return control and control.buf or '' end
  return {
    destination = c.importCodeDestination.list[c.importCodeDestination.selIndex],
    append = c.appendNotReplace.state == true,
    exportSupport = partyTab.enableExportBuffs == true,
    imported = {
      partyMemberStats = text(c.editPartyMemberStats),
      auras = text(c.editAuras),
      curses = text(c.editCurses),
      warcries = text(c.editWarcries),
      links = text(c.editLinks),
      enemyConditions = text(c.enemyCond),
      enemyMods = text(c.enemyMods),
    },
    active = {
      auras = partyEffectList(aura.Aura),
      auraDebuffs = partyEffectList(aura.AuraDebuff),
      extraAuraMods = extraAura and extraAura.modList and #extraAura.modList or 0,
      otherEffects = otherEffects,
      curses = partyEffectList(curse.Curse),
      curseLimit = curse.limit,
      warcries = partyEffectList(warcry.Warcry),
      links = partyEffectList(link.Link),
      partyMemberStats = stats,
      partyMemberFlags = memberFlags,
      enemyMods = enemyMods,
    },
  }
end

-- params: { xml: string, destination?: string, append?: boolean }
-- PartyTab's Import button once its code box has accepted a code; the XML
-- is that code decoded (decoding happens in TS, as for lua_import_code,
-- because the headless engine's Inflate may be a stub).
function M.party_import(params)
  local partyTab, err = partyTabOrError()
  if not partyTab then return nil, err end
  if type(params) ~= 'table' or type(params.xml) ~= 'string' or params.xml == '' then return nil, 'missing xml' end
  -- A build file saved on Windows has CRLF, which PoB never sees, as it
  -- reads files in text mode; ParseBuffs splits lines on LF and would
  -- keep the CR, filing every buff under a type name ending in it.
  local xmlText = params.xml:gsub('\r\n', '\n')
  -- finishImport reports a bad XML through launch:ShowErrMsg, which no
  -- caller sees; check what it needs first.
  local dbXML, parseErr = common.xml.ParseXML(xmlText)
  if not dbXML then return nil, 'the build XML does not parse: ' .. tostring(parseErr) end
  if not dbXML[1] or dbXML[1].elem ~= 'PathOfBuilding' then return nil, "the build XML has no 'PathOfBuilding' root element" end
  local exported = {}
  for _, tabNode in ipairs(dbXML[1]) do
    if type(tabNode) == 'table' and tabNode.elem == 'Party' then
      for _, node in ipairs(tabNode) do
        if type(node) == 'table' and node.elem == 'ExportedBuffs' and node.attrib and node.attrib.name then
          exported[#exported + 1] = node.attrib.name
        end
      end
      break
    end
  end
  if #exported == 0 then
    return nil, 'the build carries no party export: it must be saved or exported with "Export Support" enabled '
      .. '(PoB Import/Export tab, or party_set_export_support here)'
  end
  local destination, destErr = selectPartyDestination(partyTab, params.destination)
  if not destination then return nil, destErr end
  partyTab.controls.appendNotReplace.state = params.append == true
  -- The state importCodeHandle leaves for a valid code.
  partyTab.importCodeSite = nil
  partyTab.importCodeFetching = nil
  partyTab.importCodeXML = xmlText
  partyTab.importCodeValid = true
  partyTab.importCodeDetail = colorCodes.POSITIVE .. 'Code is valid'
  local clicked, clickErr = pcall(partyTab.controls.importCodeGo.onClick)
  -- Leave the code box state as an empty box has it (importCodeHandle("")),
  -- so the window does not show "Code is valid" with Import enabled for a
  -- code that was never typed into it.
  partyTab.importCodeXML = nil
  partyTab.importCodeValid = false
  partyTab.importCodeDetail = ''
  partyTab.importCodeSite = nil
  if not clicked then return nil, 'party import failed: ' .. tostring(clickErr) end
  recalcAfterPartyChange()
  local state = M.party_get()
  state.exportedSections = exported
  return state
end

-- params: { destination?: string } — PartyTab's Clear button.
function M.party_clear(params)
  local partyTab, err = partyTabOrError()
  if not partyTab then return nil, err end
  local destination, destErr = selectPartyDestination(partyTab, params and params.destination)
  if not destination then return nil, destErr end
  partyTab.controls.clear.onClick()
  recalcAfterPartyChange()
  return M.party_get()
end

-- PartyTab's "Disable Party Effects": drops the parsed effects, keeps the text.
function M.party_disable_effects()
  local partyTab, err = partyTabOrError()
  if not partyTab then return nil, err end
  partyTab.controls.removeEffects.onClick()
  recalcAfterPartyChange()
  return M.party_get()
end

-- PartyTab's "Rebuild All": parses every box again and applies the effects.
function M.party_rebuild()
  local partyTab, err = partyTabOrError()
  if not partyTab then return nil, err end
  partyTab.controls.rebuild.onClick()
  recalcAfterPartyChange()
  return M.party_get()
end

-- params: { enabled: boolean } — the Import/Export tab's "Export Support"
-- checkbox (ImportTab.lua). With it on, CalcPerform collects this build's
-- auras, curses, warcries, links and enemy modifiers, and PartyTab:Save
-- writes them as ExportedBuffs into the saved or exported build, for
-- another build's Party tab to import. The returned text is what
-- PartyTab:exportBuffs will write for each section.
function M.party_set_export_support(params)
  local partyTab, err = partyTabOrError()
  if not partyTab then return nil, err end
  if type(params) ~= 'table' or type(params.enabled) ~= 'boolean' then return nil, 'enabled must be true or false' end
  local checkbox = build.importTab and build.importTab.controls and build.importTab.controls.enablePartyExportBuffs
  if checkbox then
    checkbox.state = params.enabled
    checkbox.changeFunc(params.enabled)
  else
    partyTab.enableExportBuffs = params.enabled
  end
  recalcAfterPartyChange()
  local exports = {}
  -- PartyTab:Save's section names, keyed by the buffExports entry it reads.
  for _, pair in ipairs({ { 'PlayerMods', 'PartyMemberStats' }, { 'Aura', 'Aura' }, { 'Curse', 'Curse' },
      { 'Warcry', 'Warcry Skills' }, { 'Link', 'Link Skills' }, { 'EnemyConditions', 'EnemyConditions' }, { 'EnemyMods', 'EnemyMods' } }) do
    local ok, textOut = pcall(partyTab.exportBuffs, partyTab, pair[1])
    if ok and type(textOut) == 'string' and textOut ~= '' then exports[pair[2]] = textOut end
  end
  return { exportSupport = partyTab.enableExportBuffs == true, exports = exports }
end

-------------------------------------------------------------------------------
-- Passive tree features of PoB's Tree tab: the node power report, the timeless
-- jewel finder and tattoos. Each one runs the TreeTab / CalcsTab code behind
-- the desktop app's own buttons, so the numbers and lists are PoB's.
-------------------------------------------------------------------------------

local function treeReady()
  if not build or not build.spec or not build.treeTab or not build.calcsTab then
    return nil, 'build/tree not initialized'
  end
  return true
end

-- The timeless jewel finder and the tattoo editor live in PoB's popup dialogs
-- (TreeTab:FindTimelessJewel, TreeTab:ModifyNodePopup). They are opened, used
-- and closed within one call, so nothing is ever drawn. withDialog closes only
-- the dialogs it opened: one already open (in the desktop app, the user's) stays.
-- open() opens one PoB dialog, use(popup) works with it. Every dialog opened
-- here is closed afterwards, also on error (PoB's own buttons close theirs).
local function withDialog(open, use)
  local before = #main.popups
  local opened, openErr = pcall(open)
  if not opened then
    while #main.popups > before do main:ClosePopup() end
    return nil, tostring(openErr)
  end
  local popup = main.popups[1]
  if #main.popups <= before or not popup then return nil, 'PoB did not open its dialog' end
  local ok, res, err = pcall(use, popup)
  while #main.popups > before do main:ClosePopup() end
  if not ok then return nil, tostring(res) end
  return res, err
end

-- Pick an entry of a PoB dropdown the way a click does: set the index, then
-- run the control's selFunc (DropDownControl calls selFunc(index, value)).
local function pickDropDown(control, index)
  control.selIndex = index
  if control.selFunc then control.selFunc(index, control.list[index]) end
end

local function lowerText(value)
  return stripColourCodes(tostring(value or '')):lower()
end

-- Main output values reported before/after a tree change.
local TREE_CHANGE_STATS = { 'Life', 'EnergyShield', 'Mana', 'TotalEHP', 'CombinedDPS', 'FullDPS', 'Str', 'Dex', 'Int' }
local function treeChangeStats()
  local out = build.calcsTab and build.calcsTab.mainOutput or {}
  local stats = {}
  for _, key in ipairs(TREE_CHANGE_STATS) do
    if type(out[key]) == 'number' then stats[key] = out[key] end
  end
  return stats
end

---------------------------------------------------------------- Node power ---

-- TreeTab's "Show Node Power" stat dropdown offers data.powerStatList minus the
-- entries flagged ignoreForNodes (TreeTab.lua, self.powerStatList).
local function nodePowerStats()
  local list = {}
  for _, stat in ipairs(data.powerStatList) do
    if not stat.ignoreForNodes then table.insert(list, stat) end
  end
  return list
end

-- Run CalcsTab:PowerBuilder to completion. CalcsTab:BuildPower resumes the
-- same function as a coroutine over several frames (it yields every 100 ms
-- of GetTime); here its own coroutine is resumed until it finishes.
local function runPowerBuilder(calcsTab, stat, maxDepth)
  local savedStat, savedDepth = calcsTab.powerStat, calcsTab.nodePowerMaxDepth
  local savedProgress = build.powerBuilderProgressCallback
  calcsTab.powerStat = stat
  calcsTab.nodePowerMaxDepth = maxDepth
  -- The progress callback only feeds the Tree tab's toast, which this run has none of.
  build.powerBuilderProgressCallback = nil
  local started = os.clock()
  local co = coroutine.create(calcsTab.PowerBuilder)
  local resumes, ok, err = 0, true, nil
  while coroutine.status(co) ~= 'dead' do
    local resumed, msg = coroutine.resume(co, calcsTab)
    resumes = resumes + 1
    if not resumed then ok, err = false, msg break end
  end
  local seconds = os.clock() - started
  calcsTab.powerStat, calcsTab.nodePowerMaxDepth = savedStat, savedDepth
  build.powerBuilderProgressCallback = savedProgress
  -- node.power now holds this stat; a heat map shown in the desktop app
  -- rebuilds with its own stat on its next frame.
  calcsTab.powerBuildFlag = true
  return ok, err, seconds, resumes
end

-- params: { stat? (default CombinedDPS), maxDepth?, filter? ('unallocated'|'unallocated_and_clusters'|'allocated'),
--           showMasteries?, sortBy? ('power'|'per_point'|'points'|'type'), types?, limit? }
-- The report is TreeTab:BuildPowerReportList, filtered and sorted by PoB's
-- PowerReportListControl (ReList / ReSort), as the "Show Power Report" list.
function M.node_power(params)
  local ready, readyErr = treeReady()
  if not ready then return nil, readyErr end
  params = params or {}
  local wanted = lowerText(params.stat or 'CombinedDPS')
  local stat
  local choices = {}
  for _, entry in ipairs(nodePowerStats()) do
    if entry.stat then table.insert(choices, entry.stat .. ' (' .. entry.label .. ')') end
    if (entry.stat and entry.stat:lower() == wanted) or entry.label:lower() == wanted then stat = entry end
  end
  if not stat then
    return nil, 'unknown node power stat "' .. tostring(params.stat) .. '"; PoB offers: ' .. table.concat(choices, ', ')
  end
  if not stat.stat then
    -- PowerReportListControl:SetReport: the combined heat map has no report.
    return nil, '"' .. stat.label .. '" has no power report in PoB (only the heat map); choose a specific stat'
  end
  local maxDepth = params.maxDepth ~= nil and tonumber(params.maxDepth) or nil
  if maxDepth ~= nil and maxDepth < 1 then return nil, 'maxDepth must be at least 1' end
  local sortColumns = { type = 1, power = 3, points = 4, per_point = 5 }
  local sortBy = params.sortBy or 'power'
  if not sortColumns[sortBy] then return nil, 'sortBy must be power, per_point, points or type' end
  local filter = params.filter or 'unallocated'
  if filter ~= 'unallocated' and filter ~= 'unallocated_and_clusters' and filter ~= 'allocated' then
    return nil, 'filter must be unallocated, unallocated_and_clusters or allocated'
  end

  local output, outErr = M.get_main_output()
  if not output then return nil, outErr end
  local calcsTab = build.calcsTab
  local done, runErr, seconds, resumes = runPowerBuilder(calcsTab, stat, maxDepth)
  if not done then return nil, 'PoB power builder failed: ' .. tostring(runErr) end

  local report = build.treeTab:BuildPowerReportList(stat)
  local list = new('PowerReportListControl', nil, { 0, 0, 700, 170 }, nil)
  list:SetReport(stat, report)
  list.showClusters = filter == 'unallocated_and_clusters'
  list.allocated = filter == 'allocated'
  list.showMasteries = params.showMasteries ~= false
  list:ReList()
  list:ReSort(sortColumns[sortBy])

  local types
  if type(params.types) == 'table' and #params.types > 0 then
    types = {}
    for _, t in ipairs(params.types) do types[tostring(t):lower()] = true end
  end
  local limit = math.min(math.max(tonumber(params.limit) or 25, 1), 500)
  local nodes = {}
  for _, entry in ipairs(list.list) do
    if #nodes >= limit then break end
    if not types or types[tostring(entry.type or ''):lower()] then
      local specNode = build.spec.nodes[entry.id]
      local path
      if specNode and not entry.allocated and type(specNode.path) == 'table' then
        path = {}
        for _, pathNode in ipairs(specNode.path) do table.insert(path, pathNode.id) end
      end
      local statLines = {}
      for _, line in ipairs(entry.sd or {}) do table.insert(statLines, stripColourCodes(line)) end
      table.insert(nodes, {
        id = entry.id,
        name = stripColourCodes(entry.name),
        type = entry.type,
        power = entry.power,
        perPoint = entry.pathPower,
        -- PoB's "Points" column; 1000 is its "Anoint" (no path from the tree).
        points = entry.pathDist,
        allocated = entry.allocated and true or false,
        path = path,
        stats = statLines,
      })
    end
  end

  -- TreeTab:BuildPowerReportList scales percentage stats by 100 and formats
  -- with the matching sidebar entry of build.displayStats.
  local displayStat
  for _, ds in ipairs(build.displayStats or {}) do
    if ds.stat == stat.stat then displayStat = ds break end
  end
  -- CalcsTab:PowerBuilder compares every node against the misc calculator's base output.
  local _, calcBase = calcsTab:GetMiscCalculator()
  return {
    stat = stat.stat,
    label = stat.label,
    base = data.powerStatList.GetFromOutput(calcBase, stat),
    scale = (displayStat and (displayStat.pc or displayStat.mod)) and 100 or 1,
    fmt = displayStat and displayStat.fmt or '.1f',
    lowerIsBetter = displayStat and displayStat.lowerIsBetter or false,
    maxDepth = maxDepth,
    filter = filter,
    sortBy = sortBy,
    showMasteries = list.showMasteries,
    listed = #list.list,
    reportSize = #report,
    seconds = seconds,
    resumes = resumes,
    nodes = nodes,
  }
end

---------------------------------------------------------- Timeless jewels ---

-- Patch PoB functions for the length of fn(): OpenURL and Copy capture the
-- trade URL instead of opening a browser, and TradeQueryRequests:FetchLeagues
-- does nothing, so opening the finder fetches no league list (the league comes
-- from the caller).
local function withTradeStubs(fn)
  if not common.classes.TradeQueryRequests then LoadModule('Classes/TradeQueryRequests') end
  local requests = common.classes.TradeQueryRequests
  local savedOpen, savedCopy, savedFetch = OpenURL, Copy, requests.FetchLeagues
  local captured = {}
  OpenURL = function(url) table.insert(captured, url) end
  Copy = function() end
  requests.FetchLeagues = function() end
  local ok, res, err = pcall(fn, captured)
  OpenURL, Copy, requests.FetchLeagues = savedOpen, savedCopy, savedFetch
  if not ok then return nil, tostring(res) end
  return res, err
end

-- The finder stores its settings and results in build.timelessData, which PoB
-- saves with the build. A search through the MCP is a query: put it back.
local function withTimelessStateRestored(fn)
  local treeTab = build.treeTab
  local savedData = copyTable(build.timelessData)
  local savedTab = {
    tradeTypeIndex = treeTab.tradeTypeIndex,
    selectedRealmIndex = treeTab.selectedRealmIndex,
    timelessJewelLeagueSelect = treeTab.timelessJewelLeagueSelect,
    lastSearchMore = treeTab.lastSearchMore,
  }
  local savedModFlag, savedTreeModFlag = build.modFlag, treeTab.modFlag
  local ok, res, err = pcall(fn)
  local timelessData = build.timelessData
  wipeTable(timelessData)
  for k, v in pairs(savedData) do timelessData[k] = v end
  for k, v in pairs(savedTab) do treeTab[k] = v end
  build.modFlag, treeTab.modFlag = savedModFlag, savedTreeModFlag
  if not ok then return nil, tostring(res) end
  return res, err
end

local function matchListEntry(list, wanted, fields)
  if wanted == nil then return nil end
  if type(wanted) == 'number' or tonumber(wanted) then
    local n = tonumber(wanted)
    for i, entry in ipairs(list) do
      if entry.id == n then return i end
    end
  end
  local text = lowerText(wanted)
  for i, entry in ipairs(list) do
    for _, field in ipairs(fields) do
      if entry[field] ~= nil and lowerText(entry[field]) == text then return i end
    end
  end
  local found
  for i, entry in ipairs(list) do
    for _, field in ipairs(fields) do
      if entry[field] ~= nil and lowerText(entry[field]):find(text, 1, true) then
        if found and found ~= i then return nil, 'ambiguous' end
        found = i
      end
    end
  end
  return found
end

local function labelsOf(list)
  local labels = {}
  for _, entry in ipairs(list) do table.insert(labels, stripColourCodes(entry.label or tostring(entry))) end
  return labels
end

-- "Search for Node" entries (buildMods in TreeTab:FindTimelessJewel) are
-- labelled "<name>     <first stat line>"; the name is what precedes the gap.
local function timelessModName(entry)
  local label = stripColourCodes(entry.label or '')
  return (label:match('^(.-)%s%s%s') or label)
end

local function describeTimelessOptions(controls)
  local mods = {}
  for _, entry in ipairs(controls.nodeSelect.list) do
    if entry.id then
      table.insert(mods, { id = entry.id, name = timelessModName(entry), stats = entry.descriptions, totalMod = entry.totalMod or nil })
    end
  end
  local sockets = {}
  for _, entry in ipairs(controls.socketSelect.list) do
    table.insert(sockets, { id = entry.id, label = stripColourCodes(entry.label), keystone = entry.keystone, allocated = entry.label:sub(1, 2) == '# ' })
  end
  local function plain(list)
    local out = {}
    for i, entry in ipairs(list or {}) do out[i] = { id = entry.id, label = stripColourCodes(entry.label) } end
    return out
  end
  local fallback = {}
  for i, entry in ipairs(controls.fallbackWeightsList.list) do
    fallback[i] = { index = i, label = entry.label, stat = entry.stat }
  end
  local protect = {}
  for _, entry in ipairs(controls.protectAllocatedSelect.list or {}) do table.insert(protect, entry.label) end
  return {
    jewelTypes = plain(controls.jewelSelect.list),
    jewelType = plain({ controls.jewelSelect.list[controls.jewelSelect.selIndex] })[1],
    conquerors = plain(controls.conquerorSelect.list),
    sockets = sockets,
    devotionVariants = plain(controls.devotionSelect1.list),
    abyssAscendancyOutcomes = plain(controls.abyssAscendancySelect.list),
    fallbackWeightModes = fallback,
    protectableNodes = protect,
    mods = mods,
  }
end

local TRADE_TYPES = { securable = 1, available = 2, onlineleague = 3, online = 4, any = 5 }
local REALMS = { pc = 1, sony = 2, xbox = 3 }

-- Fill in the "Find a Timeless Jewel" dialog (TreeTab:FindTimelessJewel) as a
-- user would, then press its buttons. params:
--   jewelType (id 1-11, label or internal name), conqueror (id or label, default Any),
--   socketId (node id, or -1 / 'all' for PoB's "All Sockets"),
--   desired: [{ node (mod id or name), weight?, weight2?, minWeight?, required? }],
--   searchList / fallbackList (PoB's own "id, weight, weight2, minWeight" lines),
--   fallbackStat (fills the fallback list with PoB's "Generate" for that stat),
--   socketFilter, socketFilterDistance, devotion1, devotion2, totalMinimumWeight,
--   protectNodes [names], abyssAscendancy, maxResults, optionsOnly,
--   trade: { league, realm, tradeType, searchMore, pages, startRow }
local function runTimelessDialog(params)
  local treeTab = build.treeTab
  return withDialog(function() treeTab:FindTimelessJewel() end, function(popup)
    local controls = popup.controls

    if params.jewelType ~= nil then
      local idx = matchListEntry(controls.jewelSelect.list, params.jewelType, { 'label', 'name' })
      if not idx then error('unknown jewelType "' .. tostring(params.jewelType) .. '"; PoB offers: ' .. table.concat(labelsOf(controls.jewelSelect.list), ', '), 0) end
      pickDropDown(controls.jewelSelect, idx)
    end
    if params.optionsOnly then
      -- The protectable list only fills with "Filter Nodes" on (setAllocatedNodes).
      if params.socketId ~= nil then
        local sidx = matchListEntry(controls.socketSelect.list, params.socketId == 'all' and -1 or params.socketId, { 'label', 'keystone' })
        if sidx then pickDropDown(controls.socketSelect, sidx) end
        controls.socketFilter.state = true
        controls.socketFilter.changeFunc(true)
      end
      return describeTimelessOptions(controls)
    end

    local conqueror = params.conqueror
    if conqueror ~= nil then
      local idx, why = matchListEntry(controls.conquerorSelect.list, conqueror, { 'label' })
      if not idx then error((why == 'ambiguous' and 'ambiguous' or 'unknown') .. ' conqueror "' .. tostring(conqueror) .. '"; PoB offers: ' .. table.concat(labelsOf(controls.conquerorSelect.list), ', '), 0) end
      pickDropDown(controls.conquerorSelect, idx)
    else
      pickDropDown(controls.conquerorSelect, 1)
    end

    local socketWanted = params.socketId
    if socketWanted == nil then error('socketId is required (a jewel socket node id, or "all")', 0) end
    if socketWanted == 'all' then socketWanted = -1 end
    local sidx = matchListEntry(controls.socketSelect.list, socketWanted, {})
    if not sidx then error('node ' .. tostring(params.socketId) .. ' is not one of the jewel sockets PoB offers; list them with list_options', 0) end
    pickDropDown(controls.socketSelect, sidx)

    local filterOn = params.socketFilter == true
    controls.socketFilter.state = filterOn
    controls.socketFilter.changeFunc(filterOn)
    if filterOn and params.socketFilterDistance ~= nil then
      local distance = math.min(math.max(math.floor(tonumber(params.socketFilterDistance) or 0), 0), 10)
      controls.socketFilterAdditionalDistance:SetVal(distance / 10)
      build.timelessData.socketFilterDistance = distance
    end

    for key, control in pairs({ devotion1 = controls.devotionSelect1, devotion2 = controls.devotionSelect2 }) do
      if params[key] ~= nil then
        local idx = matchListEntry(control.list, params[key], { 'label' })
        if not idx then error('unknown ' .. key .. ' "' .. tostring(params[key]) .. '"; PoB offers: ' .. table.concat(labelsOf(control.list), ', '), 0) end
        pickDropDown(control, idx)
      end
    end

    -- Desired nodes: PoB's search list is lines of "id, weight, weight2, minWeight".
    local lines = {}
    if type(params.searchList) == 'string' and params.searchList ~= '' then table.insert(lines, params.searchList) end
    for _, want in ipairs(params.desired or {}) do
      local idx
      for i, entry in ipairs(controls.nodeSelect.list) do
        if entry.id and entry.id == want.node then idx = i end
      end
      if not idx then
        -- by name: the label's leading node name, then its stat lines
        local text = lowerText(want.node)
        local exact, partial = {}, {}
        for i, entry in ipairs(controls.nodeSelect.list) do
          if entry.id then
            local name = timelessModName(entry):lower()
            if name == text then table.insert(exact, i)
            elseif name:find(text, 1, true) or table.concat(entry.descriptions or {}, ' '):lower():find(text, 1, true) then table.insert(partial, i) end
          end
        end
        local hits = #exact > 0 and exact or partial
        if #hits == 1 then idx = hits[1]
        elseif #hits > 1 then
          local names = {}
          for i = 1, math.min(#hits, 15) do table.insert(names, controls.nodeSelect.list[hits[i]].id) end
          error('desired node "' .. tostring(want.node) .. '" matches several mods: ' .. table.concat(names, ', '), 0)
        else
          error('desired node "' .. tostring(want.node) .. '" is not a ' .. stripColourCodes(controls.jewelSelect.list[controls.jewelSelect.selIndex].label) .. ' mod; list them with list_options', 0)
        end
      end
      local id = controls.nodeSelect.list[idx].id
      local minWeight = want.required and 'required' or tostring(tonumber(want.minWeight) or 0)
      table.insert(lines, string.format('%s, %s, %s, %s', id, tostring(tonumber(want.weight) or 1), tostring(tonumber(want.weight2) or 1), minWeight))
    end
    controls.searchList:SetText(table.concat(lines, '\n'), true)
    controls.searchListFallback:SetText(type(params.fallbackList) == 'string' and params.fallbackList or '', true)
    if params.fallbackStat ~= nil then
      local idx = matchListEntry(controls.fallbackWeightsList.list, params.fallbackStat, { 'stat', 'label' })
      if not idx then
        for i, entry in ipairs(controls.fallbackWeightsList.list) do
          if entry.label:lower() == 'sort by ' .. lowerText(params.fallbackStat) then idx = i end
        end
      end
      if not idx then error('unknown fallbackStat "' .. tostring(params.fallbackStat) .. '"; PoB offers: ' .. table.concat(labelsOf(controls.fallbackWeightsList.list), ', '), 0) end
      pickDropDown(controls.fallbackWeightsList, idx)
      controls.fallbackWeightsButton.onClick()
    end
    controls.totalMinimumWeight:SetText(params.totalMinimumWeight ~= nil and tostring(math.floor(tonumber(params.totalMinimumWeight) or 0)) or '', true)

    if params.abyssAscendancy ~= nil then
      if not controls.abyssAscendancyLabel.shown then error('abyssAscendancy applies to Reclaimed Malevolence only', 0) end
      local idx = matchListEntry(controls.abyssAscendancySelect.list, params.abyssAscendancy, { 'label', 'id' })
      if not idx then error('unknown abyssAscendancy "' .. tostring(params.abyssAscendancy) .. '"; PoB offers: ' .. table.concat(labelsOf(controls.abyssAscendancySelect.list), ', '), 0) end
      pickDropDown(controls.abyssAscendancySelect, idx)
    end

    for _, name in ipairs(params.protectNodes or {}) do
      if not controls.protectAllocatedLabel.shown then error('protectNodes needs socketFilter and Militant Faith or Reclaimed Malevolence (as in PoB)', 0) end
      local idx = matchListEntry(controls.protectAllocatedSelect.list or {}, name, { 'label' })
      if not idx then error('"' .. tostring(name) .. '" is not an allocated notable PoB can protect here; PoB offers: ' .. table.concat(labelsOf(controls.protectAllocatedSelect.list or {}), ', '), 0) end
      controls.protectAllocatedSelect.selIndex = idx
      controls.protectAllocatedButtonAdd.onClick()
    end

    -- PoB's Search leaves both result tables alone when it finds nothing to
    -- search (Reclaimed Malevolence without a path to the class start): start
    -- from empty ones so no earlier results show under this search. The
    -- build's own results come back with the restored state.
    wipeTable(build.timelessData.searchResults)
    wipeTable(build.timelessData.sharedResults)
    local started = os.clock()
    controls.searchButton.onClick()
    local seconds = os.clock() - started

    local timelessData = build.timelessData
    local results = timelessData.searchResults or {}
    local shared = timelessData.sharedResults or {}
    local desiredList = {}
    for legionId, desired in pairs(shared.desiredNodes or {}) do
      table.insert(desiredList, { id = legionId, name = desired.displayName, index = desired.desiredIdx, weight = desired.nodeWeight, weight2 = desired.nodeWeight2 })
    end
    table.sort(desiredList, function(a, b) return a.index < b.index end)
    local maxResults = math.min(math.max(tonumber(params.maxResults) or 20, 1), 500)
    local rows = {}
    for i = 1, math.min(#results, maxResults) do
      local result = results[i]
      local matches = {}
      for _, desired in ipairs(desiredList) do
        local hit = result[desired.id]
        if hit then table.insert(matches, { id = desired.id, name = desired.name, nodes = hit.targetNodeNames }) end
      end
      table.insert(rows, {
        rank = i, seed = result.seed, total = result.total, socketId = result.socketId or (shared.socket and shared.socket.id),
        socket = result.socketLabel or (shared.socket and shared.socket.label), row = (stripColourCodes(result.label):gsub('%s+', ' ')), matches = matches,
      })
    end

    local trade
    if params.trade and #results > 0 then
      local t = params.trade
      if type(t.league) ~= 'string' or t.league == '' then error('trade.league is required', 0) end
      local realm = REALMS[lowerText(t.realm or 'pc')]
      if not realm then error('trade.realm must be pc, sony or xbox', 0) end
      local tradeType = TRADE_TYPES[lowerText(t.tradeType or 'securable')]
      if not tradeType then error('trade.tradeType must be securable, available, onlineleague, online or any', 0) end
      -- Realm and league are set without their selFuncs: those would fetch
      -- league lists. The URL reads both straight from the dropdowns.
      controls.realmSelection.selIndex = realm
      controls.searchTradeLeagueSelect.list = { t.league }
      controls.searchTradeLeagueSelect.selIndex = 1
      pickDropDown(controls.tradeTypeSelection, tradeType)
      controls.searchMore.state = t.searchMore == true
      if t.startRow ~= nil then
        controls.searchResults.selIndex = math.min(math.max(math.floor(tonumber(t.startRow) or 1), 1), #results)
      end
      local pages = math.min(math.max(math.floor(tonumber(t.pages) or 1), 1), 10)
      trade = { league = t.league, realm = controls.realmSelection.list[realm], tradeType = lowerText(t.tradeType or 'securable'), searchMore = controls.searchMore.state, urls = {} }
      local captured = params._captured
      for _ = 1, pages do
        local before = #captured
        controls.searchTradeButton.onClick()
        if #captured == before then break end
        local first = controls.searchResults.selIndex
        local last = math.min(controls.searchResults.highlightIndex or first, #results)
        local seeds = {}
        for r = first, last do table.insert(seeds, results[r].seed) end
        table.insert(trade.urls, { url = captured[#captured], fromRank = first, toRank = last, seeds = seeds })
      end
    end

    return {
      jewelType = stripColourCodes(timelessData.jewelType.label or ''),
      jewelTypeId = timelessData.jewelType.id,
      conqueror = stripColourCodes(timelessData.conquerorType.label or ''),
      socket = stripColourCodes(timelessData.jewelSocket.label or ''),
      socketId = timelessData.jewelSocket.id,
      searchList = timelessData.searchList,
      searchListFallback = timelessData.searchListFallback,
      desired = desiredList,
      resultCount = #results,
      seconds = seconds,
      results = rows,
      trade = trade,
    }
  end)
end

function M.find_timeless_jewel(params)
  local ready, readyErr = treeReady()
  if not ready then return nil, readyErr end
  params = params or {}
  if not build.calcsTab.mainEnv then M.get_main_output() end
  return withTimelessStateRestored(function()
    return withTradeStubs(function(captured)
      params._captured = captured
      local res, err = runTimelessDialog(params)
      params._captured = nil
      if res == nil then error(err, 0) end
      return res
    end)
  end)
end

------------------------------------------------------------------ Tattoos ---

-- PassiveTreeView:OnClick opens the tattoo editor (TreeTab:ModifyNodePopup)
-- on a right click on exactly these nodes.
local function tattooEditable(node)
  if node.expansionSkill then return false end
  if node.isTattoo or node.type == 'Keystone'
    or (node.type == 'Normal' and (node.dn == 'Strength' or node.dn == 'Dexterity' or node.dn == 'Intelligence'))
    or (node.type == 'Notable' and #(node.sd or {}) > 0 and (node.sd[1]:match('+30 to Dexterity') or node.sd[1]:match('+30 to Strength') or node.sd[1]:match('+30 to Intelligence'))) then
    return true
  end
  -- unallocated masteries take runegrafts through the same dialog
  return node.type == 'Mastery' and not node.alloc and node.masteryEffects ~= nil
end

local function tattooNode(params)
  local id = tonumber(params and params.nodeId)
  if not id then return nil, 'nodeId is required' end
  local node = build.spec.nodes[id]
  if not node then return nil, 'node ' .. id .. ' is not on this tree' end
  return node
end

local function currentTattoo(node)
  local override = build.spec.hashOverrides and build.spec.hashOverrides[node.id]
  if override and override.isTattoo then
    return { name = override.dn, stats = override.sd }
  end
end

-- Open PoB's tattoo editor on node and hand its controls to use(); the "Show
-- Legacy Tattoos" checkbox state is the Tree tab's (showLegacyTattoo).
--
-- The editor opens on modGroups[treeTab.defaultTattoo[nodeName] or 1], an
-- index its "Add" button stores per node name. An index taken from the longer
-- legacy list points past the end of the normal list, and PoB then fails to
-- open the editor for every node of that name (TreeTab.lua constructUI, also
-- on the user's own right click in the desktop app). So the open starts from
-- no stored index. keepPoBChoice: the call pressed Add or Reset Node, whose
-- stored value is kept when it fits the normal list (Add from the normal list,
-- or Reset's nil); otherwise the earlier value goes back.
local function withTattooDialog(node, includeLegacy, use, keepPoBChoice)
  local treeTab = build.treeTab
  local nodeName = build.spec.tree.nodes[node.id].dn
  local savedLegacy = treeTab.showLegacyTattoo
  local savedDefault = treeTab.defaultTattoo[nodeName]
  treeTab.showLegacyTattoo = includeLegacy == true
  treeTab.defaultTattoo[nodeName] = nil
  local res, err = withDialog(function() treeTab:ModifyNodePopup(node) end, function(popup)
    return use(popup.controls)
  end)
  treeTab.showLegacyTattoo = savedLegacy
  local choice = treeTab.defaultTattoo[nodeName]
  if not (res and keepPoBChoice) then
    treeTab.defaultTattoo[nodeName] = savedDefault
  elseif choice ~= nil and includeLegacy == true then
    treeTab.defaultTattoo[nodeName] = nil
  end
  return res, err
end

local function tattooOptions(controls)
  local nodes = build.spec.tree.tattoo.nodes
  local options = {}
  for _, entry in ipairs(controls.modSelect.list) do
    local tattoo = nodes[entry.id]
    table.insert(options, {
      id = entry.id,
      name = tattoo and tattoo.dn or timelessModName(entry),
      stats = entry.descriptions,
      targetType = tattoo and tattoo.targetType,
      minimumConnected = tattoo and tattoo.MinimumConnected,
      legacy = tattoo and tattoo.legacy or false,
    })
  end
  return options
end

-- The dialog's "Tattoo Count: N/50" button label is PoB's own count.
local function tattooCount(controls)
  return tonumber(stripColourCodes(controls.totalTattoos.label or ''):match('(%d+)/50'))
end

-- params: { nodeId, includeLegacy? }
function M.list_tattoos(params)
  local ready, readyErr = treeReady()
  if not ready then return nil, readyErr end
  local node, err = tattooNode(params)
  if not node then return nil, err end
  if not tattooEditable(node) then
    return nil, (node.dn or tostring(node.id)) .. ' (' .. tostring(node.type) .. ') cannot be tattooed in PoB: tattoos replace attribute smalls, +30 attribute notables and keystones; runegrafts go on unallocated masteries'
  end
  local res, dialogErr = withTattooDialog(node, params.includeLegacy, function(controls)
    return { options = tattooOptions(controls), count = tattooCount(controls) }
  end)
  if not res then return nil, 'PoB could not open its tattoo dialog for this node: ' .. tostring(dialogErr) end
  return {
    nodeId = node.id, node = build.spec.tree.nodes[node.id].dn, type = node.type, allocated = node.alloc and true or false,
    current = currentTattoo(node), tattooCount = res.count, tattooLimit = 50, options = res.options,
  }
end

-- params: { nodeId, tattoo (id or name), includeLegacy? }
-- Presses the dialog's "Add" button, as the desktop app does.
function M.apply_tattoo(params)
  local ready, readyErr = treeReady()
  if not ready then return nil, readyErr end
  local node, err = tattooNode(params)
  if not node then return nil, err end
  if not tattooEditable(node) then
    return nil, (node.dn or tostring(node.id)) .. ' (' .. tostring(node.type) .. ') cannot be tattooed in PoB'
  end
  if params.tattoo == nil or params.tattoo == '' then return nil, 'tattoo is required' end
  M.get_main_output()
  local before = treeChangeStats()
  local previous = currentTattoo(node)
  local nodeName = build.spec.tree.nodes[node.id].dn
  local res, dialogErr = withTattooDialog(node, params.includeLegacy, function(controls)
    local list = controls.modSelect.list
    local idx = matchListEntry(list, params.tattoo, { 'id' })
    if not idx then
      local text = lowerText(params.tattoo)
      local hits = {}
      for i, entry in ipairs(list) do
        local tattoo = build.spec.tree.tattoo.nodes[entry.id]
        if tattoo and lowerText(tattoo.dn) == text then hits = { i } break end
        if tattoo and lowerText(tattoo.dn):find(text, 1, true) then table.insert(hits, i) end
      end
      if #hits ~= 1 then
        local names = {}
        for _, option in ipairs(tattooOptions(controls)) do table.insert(names, option.name) end
        if #hits > 1 then
          names = {}
          for _, i in ipairs(hits) do table.insert(names, build.spec.tree.tattoo.nodes[list[i].id].dn) end
        end
        error((#hits > 1 and 'ambiguous' or 'unknown') .. ' tattoo "' .. tostring(params.tattoo) .. '" for ' .. tostring(nodeName) .. '; PoB offers: ' .. table.concat(names, ', '), 0)
      end
      idx = hits[1]
    end
    controls.modSelect.selIndex = idx
    controls.save.onClick()
    return { id = list[idx].id }
  end, true)
  if not res then return nil, tostring(dialogErr) end
  build.buildFlag = true
  M.advanceFrame()
  M.get_main_output()
  local countAfter = 0
  for _, override in pairs(build.spec.hashOverrides) do
    -- the dialog's count (getTattooCount): runegrafts are not tattoos
    if override.isTattoo and not tostring(override.dn):find('Runegraft') then countAfter = countAfter + 1 end
  end
  return {
    nodeId = node.id, node = nodeName, tattoo = res.id, applied = currentTattoo(build.spec.nodes[node.id]),
    allocated = build.spec.nodes[node.id].alloc and true or false,
    replaced = previous, tattooCount = countAfter, tattooLimit = 50, before = before, after = treeChangeStats(),
  }
end

-- params: { nodeId } presses the tattoo dialog's "Reset Node" button;
-- { all = true } presses "Remove All Tattoos" in the Tree tab's
-- "Reset Tree/Tattoos" dialog.
function M.remove_tattoos(params)
  local ready, readyErr = treeReady()
  if not ready then return nil, readyErr end
  params = params or {}
  M.get_main_output()
  local before = treeChangeStats()
  local removed = {}
  local function snapshot()
    local list = {}
    for id, override in pairs(build.spec.hashOverrides) do
      if override.isTattoo then list[id] = { nodeId = id, tattoo = override.dn, node = build.spec.tree.nodes[id] and build.spec.tree.nodes[id].dn } end
    end
    return list
  end
  local had = snapshot()
  if params.all then
    local res, err = withDialog(function() build.treeTab.controls.reset.onClick() end, function(popup)
      popup.controls.removeTattoo.onClick()
      return true
    end)
    if not res then return nil, tostring(err) end
  else
    local node, err = tattooNode(params)
    if not node then return nil, err end
    if not had[node.id] then return nil, 'node ' .. node.id .. ' has no tattoo' end
    local res, dialogErr = withTattooDialog(node, true, function(controls)
      controls.reset.onClick()
      return true
    end, true)
    if not res then return nil, tostring(dialogErr) end
  end
  local left = snapshot()
  for id, entry in pairs(had) do
    if not left[id] then table.insert(removed, entry) end
  end
  table.sort(removed, function(a, b) return a.nodeId < b.nodeId end)
  build.buildFlag = true
  M.advanceFrame()
  M.get_main_output()
  local remaining = 0
  for _ in pairs(left) do remaining = remaining + 1 end
  return { removed = removed, remaining = remaining, before = before, after = treeChangeStats() }
end

return M
