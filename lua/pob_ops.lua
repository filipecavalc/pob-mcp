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
  M.import_from_node_list(build.spec, classId, ascendId, secondaryId, nodes, {}, mastery, treeVersion)
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
  M.import_from_node_list(build.spec, tonumber(classId) or 0, tonumber(ascendId) or 0, tonumber(secId) or 0, nodes, {}, params and params.masteryEffects, tv)
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
  -- CalcOutputWithThisGem puts each candidate into the slot and puts the old
  -- gem back after the calculation; keep what was there in case one fails.
  local gemSnapshot, slotGem = {}, group.gemList[slotIndex]
  for i, gem in ipairs(group.gemList) do gemSnapshot[i] = gem end
  local slotState = slotGem and { gemData = slotGem.gemData, level = slotGem.level, displayEffect = slotGem.displayEffect }
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
  if not ok then
    for i = #group.gemList, 1, -1 do group.gemList[i] = nil end
    for i, gem in ipairs(gemSnapshot) do group.gemList[i] = gem end
    if slotGem then slotGem.gemData, slotGem.level, slotGem.displayEffect = slotState.gemData, slotState.level, slotState.displayEffect end
    return nil, 'gem ranking failed: ' .. tostring(result)
  end
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
  if params.minion ~= nil or params.itemSetId ~= nil then
    if activeEffect.grantedEffect.minionHasItemSet then
      if params.minion ~= nil then return nil, activeEffect.grantedEffect.name .. "'s minion is chosen by item set: give an item set id" end
      local itemSetId = tonumber(params.itemSetId)
      if not itemSetId or not build.itemsTab.itemSets[itemSetId] then return nil, 'item set id ' .. tostring(params.itemSetId) .. ' not found' end
      src['skillMinionItemSet' .. suffix] = itemSetId
    else
      if params.itemSetId ~= nil then return nil, activeEffect.grantedEffect.name .. ' does not take an item set: give a minion' end
      local minionId, resolveErr = resolveMinion(tostring(params.minion), activeSkill.minionList or {})
      if not minionId then
        local ids = {}
        for _, id in ipairs(activeSkill.minionList or {}) do table.insert(ids, id) end
        return nil, (resolveErr or 'unknown minion') .. ' for this skill; options: ' .. (#ids > 0 and table.concat(ids, ', ') or 'none (add spectres with set_spectres)')
      end
      src['skillMinion' .. suffix] = minionId
    end
    build.modFlag = true
    build.buildFlag = true
    M.get_main_output()
  end
  if params.minionSkill ~= nil then
    -- The minion's skills depend on the minion just chosen, so read them after the recalculation.
    ctx = mainSkillFor(calcs)
    local minion = ctx and ctx.activeSkill.minion
    if not minion then return nil, 'the main skill has no minion yet (no spectres in the build?)' end
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
      return nil, 'minion skill ' .. tostring(params.minionSkill) .. ' not found; options: ' .. table.concat(names, ', ')
    end
    ctx.activeEffect.srcInstance['skillMinionSkill' .. suffix] = index
    build.modFlag = true
    build.buildFlag = true
    M.get_main_output()
  end
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

return M
