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

-- params: { stat, maxDepth?, filter? ('unallocated'|'unallocated_and_clusters'|'allocated'),
--           showMasteries?, sortBy? ('power'|'per_point'|'points'|'type'), types?, limit? }
-- The report is TreeTab:BuildPowerReportList, filtered and sorted by PoB's
-- PowerReportListControl (ReList / ReSort), as the "Show Power Report" list.
function M.node_power(params)
  local ready, readyErr = treeReady()
  if not ready then return nil, readyErr end
  params = params or {}
  local wanted = lowerText(params.stat or 'FullDPS')
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
local function withTattooDialog(node, includeLegacy, use)
  local treeTab = build.treeTab
  local savedLegacy = treeTab.showLegacyTattoo
  treeTab.showLegacyTattoo = includeLegacy == true
  local res, err = withDialog(function() treeTab:ModifyNodePopup(node) end, function(popup)
    return use(popup.controls)
  end)
  treeTab.showLegacyTattoo = savedLegacy
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
  end)
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
    end)
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
