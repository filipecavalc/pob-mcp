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
-- Items tab: crafting, the unique and rare template databases, item set
-- management and the shared item lists.
--
-- Each operation drives the PoB code behind the matching Items tab control,
-- as a user would: the popups ItemsTab opens (CraftItem, EditDisplayItemText,
-- AddCustomModifierToDisplayItem, AddImplicitToDisplayItem,
-- CorruptDisplayItem, EnchantDisplayItem in Classes/ItemsTab.lua) are opened
-- for real, their own dropdowns are set and their own buttons pressed, and a
-- throwaway ItemDBControl / ItemSetListControl runs the database filters and
-- the item set buttons. The mod pools, labels, sort orders and the item text
-- are therefore PoB's own. Crafting works on item text in and item text out:
-- the given item becomes the tab's display item for the call, and the tab's
-- previous display item comes back afterwards.
-- ===========================================================================

-- Rarity dropdown order of ItemsTab.lua (rarityDropList).
local CRAFT_RARITIES = { 'NORMAL', 'MAGIC', 'RARE', 'UNIQUE', 'RELIC' }
-- Boolean modLine fields worth reporting (ItemClass:ParseRaw and the ItemsTab popups).
local MOD_LINE_FLAGS = { 'crafted', 'custom', 'fractured', 'scourge', 'crucible', 'mutated', 'exarch', 'eater',
  'synthesis', 'prefix', 'suffix' }
local DEFAULT_OPTION_LIMIT = 50
local MAX_OPTION_LIMIT = 500

local function itemsTabReady()
  if not build or not build.itemsTab then return nil, 'build/itemsTab not initialized' end
  if not main or not main.popups then return nil, 'PoB main module not available' end
  return build.itemsTab
end

local function cleanText(text)
  if type(text) ~= 'string' then return text end
  return stripColourCodes(text)
end

-- error() from inside a pcall'd closure carries "file:line: "; callers want the message.
local function cleanError(err)
  return (tostring(err):gsub('^[^\n]-%.lua:%d+: ', ''))
end

local function copyLines(mod)
  local lines = {}
  for i, line in ipairs(mod or {}) do lines[i] = line end
  return lines
end

-- A PoB mod table (data.itemMods, ModMaster, ModVeiled, essences ...).
local function describeMod(mod)
  if type(mod) ~= 'table' then return nil end
  local tags = {}
  for i, tag in ipairs(mod.modTags or {}) do tags[i] = tag end
  return { lines = copyLines(mod), type = mod.type, affix = mod.affix ~= '' and mod.affix or nil, level = mod.level, group = mod.group,
    tags = #tags > 0 and tags or nil }
end

local function describeModLines(item, lines)
  local out = {}
  for _, modLine in ipairs(lines or {}) do
    if not item.CheckModLineVariant or item:CheckModLineVariant(modLine) then
      local text = itemLib.formatModLine(modLine)
      if text then
        local entry = { text = cleanText(text) }
        for _, flag in ipairs(MOD_LINE_FLAGS) do
          if modLine[flag] then entry[flag] = true end
        end
        if modLine.extra then entry.unsupported = true end
        if modLine.disabled then entry.disabled = true end
        if type(modLine.range) == 'number' then entry.range = modLine.range end
        if type(modLine.corruptedRange) == 'number' then entry.corruptedRange = modLine.corruptedRange end
        table.insert(out, entry)
      end
    end
  end
  return out
end

local function describeAffixSlots(item, list)
  local out = {}
  for i = 1, (list.limit or ((item.affixLimit or 0) / 2)) do
    local affix = list[i]
    local mod = affix and item.affixes and item.affixes[affix.modId]
    if mod then
      table.insert(out, { modId = affix.modId, affix = mod.affix, lines = copyLines(mod), level = mod.level,
        range = type(affix.range) == 'number' and affix.range or nil, fractured = affix.fractured or nil })
    else
      table.insert(out, { modId = 'None' })
    end
  end
  return out
end

-- What a caller needs to read or reuse an item: PoB's own text (ItemClass:BuildRaw)
-- plus the parsed parts.
local function describeItem(item)
  if not item then return nil end
  local influences = {}
  for _, info in ipairs(itemLib.influenceInfo.all) do
    if item[info.key] then table.insert(influences, info.display) end
  end
  local okSlot, primarySlot = pcall(item.GetPrimarySlot, item)
  local result = {
    text = item:BuildRaw(),
    name = item.name, title = item.title, baseName = item.baseName, type = item.type, rarity = item.rarity,
    primarySlot = okSlot and primarySlot or nil,
    quality = item.quality, itemLevel = item.itemLevel,
    levelRequirement = item.requirements and item.requirements.level or nil,
    corrupted = item.corrupted == true, crafted = item.crafted == true,
    influences = influences,
    catalyst = item.catalyst, catalystQuality = item.catalystQuality,
    enchants = describeModLines(item, item.enchantModLines),
    scourge = describeModLines(item, item.scourgeModLines),
    implicits = describeModLines(item, item.implicitModLines),
    explicits = describeModLines(item, item.explicitModLines),
    crucible = describeModLines(item, item.crucibleModLines),
  }
  if item.crafted and item.prefixes and item.suffixes and item.affixLimit then
    result.affixLimit = item.affixLimit
    result.prefixes = describeAffixSlots(item, item.prefixes)
    result.suffixes = describeAffixSlots(item, item.suffixes)
  end
  return result
end

local function parseItemText(text)
  if type(text) ~= 'string' or not text:match('%S') then return nil, 'item text is required' end
  if #text > MAX_ITEM_TEXT_LENGTH then
    return nil, string.format('item text too long (max %d bytes)', MAX_ITEM_TEXT_LENGTH)
  end
  local ok, item = pcall(Compat.construct, 'Item', (text:gsub('\r\n', '\n')))
  if not ok then return nil, 'invalid item text: ' .. tostring(item) end
  if not item or not item.base then
    return nil, 'PoB does not recognise this item text (the first lines must be the name and a known base type)'
  end
  return item
end

-- Runs fn(tab) with `item` as the Items tab's display item (ItemsTab:SetDisplayItem,
-- as double-clicking an item does), then closes any popup the call left open and
-- puts the previous display item back, as evaluate_anoint_candidates does.
local function withDisplayItem(item, fn)
  local tab, err = itemsTabReady()
  if not tab then return nil, err end
  local previous = tab.displayItem
  local popupsBefore = #main.popups
  local ok, res, ferr = pcall(function()
    tab:SetDisplayItem(item)
    return fn(tab)
  end)
  while #main.popups > popupsBefore do main:ClosePopup() end
  if not pcall(tab.SetDisplayItem, tab, previous) then tab.displayItem = previous end
  if not ok then return nil, cleanError(res) end
  return res, ferr
end

-- Calls the ItemsTab method behind a button and returns the popup's controls.
local function openTabPopup(tab, method, ...)
  local before = #main.popups
  tab[method](tab, ...)
  if #main.popups ~= before + 1 or not main.popups[1] then
    error('ItemsTab:' .. method .. ' opened no popup')
  end
  return main.popups[1].controls
end

local function entryLabel(entry)
  if type(entry) == 'table' then return entry.label end
  return entry
end

-- Finds `want` in a dropdown list: a 1-based index, or text compared with each
-- entry's label without colour codes, exactly (ignoring case) and then as a
-- unique substring. extraMatch(entry, want) can accept an entry by other keys.
local function pickFromList(list, want, what, extraMatch)
  if want == nil then return nil, what .. ' is required' end
  local n = tonumber(want)
  if type(want) == 'number' or (n and tostring(want):match('^%s*%d+%s*$')) then
    if list[n] then return n end
    return nil, string.format('%s index %s out of range (1-%d)', what, tostring(want), #list)
  end
  local needle = tostring(want):lower()
  local matches = {}
  for i, entry in ipairs(list) do
    if extraMatch and extraMatch(entry, want) then return i end
    local label = tostring(cleanText(entryLabel(entry)) or ''):lower()
    if label == needle then return i end
    if label:find(needle, 1, true) then table.insert(matches, i) end
  end
  if #matches == 1 then return matches[1] end
  if #matches == 0 then return nil, string.format('no %s matches "%s"', what, tostring(want)) end
  local names = {}
  for k = 1, math.min(#matches, 10) do
    names[k] = string.format('%d: %s', matches[k], tostring(cleanText(entryLabel(list[matches[k]]))))
  end
  return nil, string.format('%d %s entries match "%s"; pass a more specific text or the index (%s%s)', #matches, what,
    tostring(want), table.concat(names, ' | '), #matches > 10 and ' | ...' or '')
end

-- Selects an entry of a dropdown as a click does (selIndex, then its selFunc).
local function selectEntry(control, index)
  control.selIndex = index
  if control.selFunc then control.selFunc(index, control.list[index]) end
end

local function labelsOf(list)
  local out = {}
  for i, entry in ipairs(list or {}) do out[i] = cleanText(entryLabel(entry)) end
  return out
end

-- The popups' "Sort by" dropdowns hold data.powerStatList entries; match a stat
-- key (FullDPS, Life) or a label (Full DPS).
local function selectSort(control, sortBy)
  if sortBy == nil or sortBy == '' then return true end
  local want = tostring(sortBy):lower()
  for i, entry in ipairs(control.list) do
    if (entry.stat and entry.stat:lower() == want) or (entry.label and entry.label:lower() == want) then
      selectEntry(control, i)
      return entry
    end
  end
  local names = {}
  for _, entry in ipairs(control.list) do if entry.stat then table.insert(names, entry.stat) end end
  return nil, 'unknown sort_by "' .. tostring(sortBy) .. '"; use one of: ' .. table.concat(names, ', ')
end

local function optionLimit(params)
  return math.min(math.max(tonumber(params.limit) or DEFAULT_OPTION_LIMIT, 1), MAX_OPTION_LIMIT)
end

-- Lists dropdown entries as options { index, label, ...describe(entry, index) },
-- filtered by params.search (label or mod lines, ignoring case) and capped.
local function listOptions(list, params, describe)
  local search = type(params.search) == 'string' and params.search:lower() or nil
  local options, matched = {}, 0
  local limit = optionLimit(params)
  for i, entry in ipairs(list or {}) do
    local label = cleanText(entryLabel(entry))
    local option = describe and describe(entry, i) or {}
    local hay = tostring(label or ''):lower()
    if option.lines then hay = hay .. '\n' .. table.concat(option.lines, '\n'):lower() end
    if not search or hay:find(search, 1, true) then
      matched = matched + 1
      if #options < limit then
        option.index = i
        option.label = label
        table.insert(options, option)
      end
    end
  end
  return options, matched
end

local function sourcesOf(list)
  local out = {}
  for i, s in ipairs(list) do out[i] = { label = s.label, id = s.sourceId } end
  return out
end

-- params: { type?: string, search?: string, limit?: number }
-- The "Craft item..." popup's Type and Base dropdowns (data.itemBaseTypeList and
-- data.itemBaseLists, built in Modules/Data.lua).
function M.item_craft_bases(params)
  params = type(params) == 'table' and params or {}
  local typeName = params.type
  if typeName ~= nil then
    local found
    for _, name in ipairs(data.itemBaseTypeList) do
      if name:lower() == tostring(typeName):lower() then found = name end
    end
    if not found then return nil, 'unknown base type "' .. tostring(typeName) .. '"; types: ' .. table.concat(data.itemBaseTypeList, ', ') end
    typeName = found
  end
  if not typeName and not params.search then
    local types = {}
    for _, name in ipairs(data.itemBaseTypeList) do
      table.insert(types, { name = name, count = #data.itemBaseLists[name] })
    end
    return { types = types }
  end
  local search = params.search and tostring(params.search):lower()
  local limit = math.min(math.max(tonumber(params.limit) or 100, 1), 1000)
  local bases, matched = {}, 0
  for _, name in ipairs(typeName and { typeName } or data.itemBaseTypeList) do
    for _, entry in ipairs(data.itemBaseLists[name]) do
      if not search or entry.name:lower():find(search, 1, true) then
        matched = matched + 1
        if #bases < limit then
          local base = entry.base
          table.insert(bases, { name = entry.name, label = entry.label, type = name,
            level = base.req and base.req.level or nil, implicit = base.implicit,
            influenceable = base.influenceTags ~= nil or nil })
        end
      end
    end
  end
  return { type = typeName, bases = bases, matched = matched }
end

-- params: { base?: string, rarity?: string, title?: string, text?: string }
-- With base: the "Craft item..." popup (ItemsTab:CraftItem): its Rarity, Name,
-- Type and Base dropdowns, then "Create". With text: "Create custom..."
-- (ItemsTab:EditDisplayItemText), whose "Create" applies PoB's normalisation
-- (ItemsTab:CreateDisplayItemFromRaw).
function M.item_craft_create(params)
  params = type(params) == 'table' and params or {}
  local tab, err = itemsTabReady()
  if not tab then return nil, err end
  local rarityIndex
  if params.rarity ~= nil then
    for i, rarity in ipairs(CRAFT_RARITIES) do
      if rarity == tostring(params.rarity):upper() then rarityIndex = i end
    end
    if not rarityIndex then return nil, 'rarity must be one of ' .. table.concat(CRAFT_RARITIES, ', ') end
  end
  if type(params.text) == 'string' and params.text:match('%S') then
    if #params.text > MAX_ITEM_TEXT_LENGTH then
      return nil, string.format('item text too long (max %d bytes)', MAX_ITEM_TEXT_LENGTH)
    end
    return withDisplayItem(nil, function()
      local controls = openTabPopup(tab, 'EditDisplayItemText')
      if rarityIndex then controls.rarity.selIndex = rarityIndex end
      controls.edit:SetText((params.text:gsub('\r\n', '\n')))
      if not controls.save:IsEnabled() then
        error('PoB cannot read this item text: for rare and unique items the first two lines must be the name and the base type; for normal and magic items the base type must be in the first line')
      end
      controls.save.onClick()
      return { item = describeItem(tab.displayItem), source = 'Create custom' }
    end)
  end
  if type(params.base) ~= 'string' or not params.base:match('%S') then return nil, 'base or text is required' end
  local baseName = params.base
  local base = data.itemBases[baseName]
  if not base then
    for name, candidate in pairs(data.itemBases) do
      if name:lower() == baseName:lower() then base, baseName = candidate, name end
    end
  end
  if not base or base.hidden then return nil, 'unknown item base "' .. params.base .. '"; craft_item_bases lists them' end
  local typeName = base.type .. (base.subType and (': ' .. base.subType) or '')
  -- CraftItem remembers the last rarity, type and base for the next popup; this
  -- call is not the user's, so keep theirs.
  local remembered = { tab.lastCraftRaritySel, tab.lastCraftTypeSel, tab.lastCraftBaseSel }
  local res, ferr = withDisplayItem(nil, function()
    local controls = openTabPopup(tab, 'CraftItem')
    if rarityIndex then controls.rarity.selIndex = rarityIndex end
    if params.title ~= nil then controls.title:SetText(tostring(params.title)) end
    local typeIndex = isValueInArray(controls.type.list, typeName)
    if not typeIndex then error('PoB lists no base type "' .. typeName .. '"') end
    selectEntry(controls.type, typeIndex)
    local baseIndex
    for i, entry in ipairs(controls.base.list) do
      if entry.name == baseName then baseIndex = i end
    end
    if not baseIndex then error('PoB lists no base "' .. baseName .. '" under ' .. typeName) end
    controls.base.selIndex = baseIndex
    controls.save.onClick()
    if not tab.displayItem then error('PoB created no item') end
    local result = { item = describeItem(tab.displayItem), source = 'Craft item' }
    if not tab.displayItem.crafted and tab.displayItem.rarity ~= 'NORMAL' then
      result.note = 'For this rarity PoB opens its item text editor next: edit the text and pass it to the other tools, or use craft_item_create with text'
    end
    return result
  end)
  tab.lastCraftRaritySel, tab.lastCraftTypeSel, tab.lastCraftBaseSel = remembered[1], remembered[2], remembered[3]
  return res, ferr
end

-- The affix dropdown (displayItemAffix<n>, ItemsTab:UpdateAffixControls) for a
-- prefix or suffix index; without an index, the first empty one.
local function affixControlFor(tab, item, affixType, index)
  local prefixLimit = item.prefixes.limit or (item.affixLimit / 2)
  local suffixLimit = item.suffixes.limit or (item.affixLimit / 2)
  local kind = tostring(affixType or ''):lower()
  if kind ~= 'prefix' and kind ~= 'suffix' then return nil, 'type must be prefix or suffix' end
  local isPrefix = kind == 'prefix'
  local count = isPrefix and prefixLimit or suffixLimit
  if index == nil then
    local list = isPrefix and item.prefixes or item.suffixes
    for i = 1, count do
      if not list[i] or list[i].modId == 'None' then index = i break end
    end
    if index == nil then return nil, 'no empty ' .. kind .. ' slot; pass index to replace one' end
  end
  index = tonumber(index)
  if not index or index < 1 or index > count then
    return nil, string.format('%s index must be 1-%d', kind, count)
  end
  local control = tab.controls['displayItemAffix' .. (isPrefix and index or prefixLimit + index)]
  if not control or control.outputTable ~= (isPrefix and 'prefixes' or 'suffixes') then
    return nil, 'PoB has no ' .. kind .. ' dropdown ' .. index .. ' for this item'
  end
  return control, nil, index, isPrefix
end

local function describeAffixGroup(item)
  return function(entry)
    if type(entry) ~= 'table' or not entry.modList then return { none = true } end
    local tiers = {}
    for k, modId in ipairs(entry.modList) do
      local mod = item.affixes[modId]
      -- The slider tooltip in ItemsTab numbers tiers as #modList - index + 1.
      table.insert(tiers, 1, { tier = #entry.modList - k + 1, modId = modId, affix = mod and mod.affix,
        level = mod and mod.level, lines = mod and copyLines(mod) })
    end
    return { tiers = tiers }
  end
end

-- params: { text, changes?: [{ type: 'prefix'|'suffix', index?, modifier?, tier?, roll?, clear? }],
--           list?: 'prefix'|'suffix', listIndex?, sortBy?, search?, limit? }
-- The Prefix/Suffix dropdowns and roll sliders of an item made with "Craft
-- item..." as magic or rare (ItemsTab:UpdateAffixControl and the dropdown and
-- slider handlers in the ItemsTab constructor).
function M.item_craft_affixes(params)
  params = type(params) == 'table' and params or {}
  local item, err = parseItemText(params.text)
  if not item then return nil, err end
  if not item.crafted then
    return nil, 'only items crafted in PoB (craft_item_create with a base, as magic or rare) have prefix and suffix dropdowns; use craft_item_add_modifier for other items'
  end
  local tab = build.itemsTab
  local sortControl = tab.controls.craftingSorting
  local previousSort = sortControl and sortControl.selIndex
  local res, ferr = withDisplayItem(item, function()
    if params.sortBy ~= nil then
      local ok, serr = selectSort(sortControl, params.sortBy)
      if not ok then error(serr) end
    end
    local applied = {}
    for n, change in ipairs(type(params.changes) == 'table' and params.changes or {}) do
      local current = tab.displayItem
      local control, cerr, index, isPrefix = affixControlFor(tab, current, change.type, change.index)
      if not control then error(string.format('change %d: %s', n, cerr)) end
      local kind = isPrefix and 'prefix' or 'suffix'
      if change.clear then
        selectEntry(control, 1)
        table.insert(applied, { type = kind, index = index, modId = 'None' })
      else
        local wantedModId
        local groupIndex, gerr = pickFromList(control.list, change.modifier, 'modifier', function(entry, want)
          if type(entry) ~= 'table' or not entry.modList then return false end
          for _, modId in ipairs(entry.modList) do
            if modId == want then wantedModId = modId return true end
          end
          return false
        end)
        if not groupIndex then error(string.format('change %d: %s', n, gerr)) end
        local entry = control.list[groupIndex]
        if type(entry) ~= 'table' or not entry.modList then
          selectEntry(control, 1)
          table.insert(applied, { type = kind, index = index, modId = 'None' })
        else
          local count = #entry.modList
          if change.tier ~= nil or change.roll ~= nil or wantedModId then
            -- Position the roll slider as UpdateAffixControl does for a tier and
            -- roll; tier 1 is the best (last) entry, as in the slider tooltip.
            local k
            if wantedModId then
              k = isValueInArray(entry.modList, wantedModId)
            else
              local tier = tonumber(change.tier) or 1
              if tier < 1 or tier > count then error(string.format('change %d: tier must be 1-%d for this modifier', n, count)) end
              k = count - tier + 1
            end
            local roll = tonumber(change.roll) or main.defaultItemAffixQuality or 0.5
            roll = math.min(math.max(roll, 0), 1)
            if roll == 0 and k > 1 then roll = 1e-4 end
            control.slider.val = (k - 1 + roll) / count
          end
          selectEntry(control, groupIndex)
          local affix = current[control.outputTable][control.outputIndex]
          local mod = affix and current.affixes[affix.modId]
          local k = affix and isValueInArray(entry.modList, affix.modId)
          table.insert(applied, { type = kind, index = index, modId = affix and affix.modId, affix = mod and mod.affix,
            lines = mod and copyLines(mod), range = affix and affix.range, tier = k and (count - k + 1) or nil })
        end
      end
    end
    local result = { item = describeItem(tab.displayItem), applied = applied }
    if params.list ~= nil then
      local control, cerr, index, isPrefix = affixControlFor(tab, tab.displayItem, params.list, params.listIndex or 1)
      if not control then error(cerr) end
      local options, matched = listOptions(control.list, params, describeAffixGroup(tab.displayItem))
      result.options = options
      result.matched = matched
      result.listed = { type = isPrefix and 'prefix' or 'suffix', index = index, selected = control.selIndex }
      local sortEntry = sortControl and sortControl.list[sortControl.selIndex]
      result.sortBy = sortEntry and sortEntry.stat and sortEntry.label or nil
    end
    return result
  end)
  if sortControl and previousSort then sortControl.selIndex = previousSort end
  return res, ferr
end

-- The "Remove" buttons ItemsTab:UpdateCustomControls made for the display item.
-- Their labels are cut to the drawn width, so the full line comes from the mod
-- lines, enumerated in the same order as that function does.
local function removableModifiers(c, item)
  local lines = {}
  for _, modLine in ipairs(item.explicitModLines or {}) do table.insert(lines, modLine) end
  for _, modLine in ipairs(item.crucibleModLines or {}) do table.insert(lines, modLine) end
  local out = {}
  for _, modLine in ipairs(lines) do
    if modLine.custom or modLine.crafted or modLine.crucible then
      local text = itemLib.formatModLine(modLine)
      local i = #out + 1
      local button = c['displayItemCustomModifierRemove' .. i]
      if text and button and button.shown then
        table.insert(out, { label = cleanText(text),
          kind = modLine.crafted and 'crafted' or modLine.crucible and 'crucible' or 'custom', button = button })
      end
    end
  end
  return out
end

-- params: { text, influences?: string[], quality?, catalyst?, catalystQuality?, clusterSkill?,
--           clusterNodeCount?, ranges?: [{ line, roll }], removeModifiers?: (number|string)[] }
-- The display item's own controls (ItemsTab constructor): the two Influence
-- dropdowns, Quality, Catalyst and its quality, a crafted cluster jewel's skill
-- and passive count, the range line dropdown and slider, and the "Remove"
-- buttons of crafted and custom modifiers (ItemsTab:UpdateCustomControls).
function M.item_craft_properties(params)
  params = type(params) == 'table' and params or {}
  local item, err = parseItemText(params.text)
  if not item then return nil, err end
  return withDisplayItem(item, function(tab)
    local c = tab.controls
    local applied = {}
    if params.influences ~= nil then
      if type(params.influences) ~= 'table' or #params.influences > 2 then error('influences must be a list of up to two names') end
      if not c.displayItemInfluence:GetProperty('shown') then error('PoB offers no influence for this item') end
      local picks = { 1, 1 }
      for k, name in ipairs(params.influences) do
        local index, ierr = pickFromList(c.displayItemInfluence.list, name, 'influence')
        if not index or index == 1 then error(ierr or 'name an influence, not the placeholder') end
        picks[k] = index
      end
      c.displayItemInfluence2.selIndex = picks[2]
      selectEntry(c.displayItemInfluence, picks[1])
      applied.influences = params.influences
    end
    if params.quality ~= nil then
      if not c.displayItemQualityEdit:GetProperty('shown') then error('this item has no quality in PoB') end
      c.displayItemQualityEdit:SetText(tostring(math.floor(tonumber(params.quality) or 0)), true)
      applied.quality = tab.displayItem.quality
    end
    if params.catalyst ~= nil then
      if not c.displayItemCatalyst:GetProperty('shown') then error('PoB offers catalysts only for crafted or tagged amulets, rings and belts') end
      local index, cerr = pickFromList(c.displayItemCatalyst.list, params.catalyst, 'catalyst')
      if not index then error(cerr) end
      selectEntry(c.displayItemCatalyst, index)
      applied.catalyst = cleanText(c.displayItemCatalyst.list[index])
    end
    if params.catalystQuality ~= nil then
      if not c.displayItemCatalystQualityEdit:GetProperty('shown') then error('set a catalyst first') end
      c.displayItemCatalystQualityEdit:SetText(tostring(math.floor(tonumber(params.catalystQuality) or 0)), true)
      applied.catalystQuality = tab.displayItem.catalystQuality
    end
    if params.clusterSkill ~= nil or params.clusterNodeCount ~= nil then
      -- Crafted cluster jewels: the skill dropdown and "Added Passives" slider
      -- (ItemsTab:UpdateClusterJewelControls / CraftClusterJewel).
      if not c.displayItemClusterJewelSkill:GetProperty('shown') then error('cluster settings apply to cluster jewels crafted in PoB') end
      if params.clusterSkill ~= nil then
        local index, kerr = pickFromList(c.displayItemClusterJewelSkill.list, params.clusterSkill, 'cluster jewel skill')
        if not index then error(kerr) end
        selectEntry(c.displayItemClusterJewelSkill, index)
      end
      if params.clusterNodeCount ~= nil then
        local cluster = tab.displayItem.clusterJewel
        local count = tonumber(params.clusterNodeCount)
        if not count or count < cluster.minNodes or count > cluster.maxNodes then
          error(string.format('clusterNodeCount must be %d-%d', cluster.minNodes, cluster.maxNodes))
        end
        local slider = c.displayItemClusterJewelNodeCount
        slider.val = -1
        slider:SetVal((count - cluster.minNodes) / (cluster.maxNodes - cluster.minNodes))
      end
    end
    for n, change in ipairs(type(params.ranges) == 'table' and params.ranges or {}) do
      local lineControl = c.displayItemRangeLine
      local index, rerr = pickFromList(lineControl.list, change.line, 'range line')
      if not index then error(string.format('ranges %d: %s', n, rerr)) end
      selectEntry(lineControl, index)
      local roll = tonumber(change.roll)
      if not roll or roll < 0 or roll > 1 then error(string.format('ranges %d: roll must be 0-1', n)) end
      -- SetVal runs the slider's handler only on a change.
      c.displayItemRangeSlider.val = -1
      c.displayItemRangeSlider:SetVal(roll)
    end
    for n, want in ipairs(type(params.removeModifiers) == 'table' and params.removeModifiers or {}) do
      local buttons = removableModifiers(c, tab.displayItem)
      local index, merr = pickFromList(buttons, want, 'removable modifier')
      if not index then error(string.format('removeModifiers %d: %s', n, merr)) end
      buttons[index].button.onClick()
    end
    local current = tab.displayItem
    local rangeLines, removable = {}, {}
    for i, entry in ipairs(c.displayItemRangeLine.list or {}) do
      table.insert(rangeLines, { index = i, line = cleanText(entry.label), roll = entry.modLine and entry.modLine.range })
    end
    for i, entry in ipairs(removableModifiers(c, current)) do
      table.insert(removable, { index = i, line = entry.label, kind = entry.kind })
    end
    return {
      item = describeItem(current), applied = applied,
      influenceOptions = c.displayItemInfluence:GetProperty('shown') and labelsOf(c.displayItemInfluence.list) or nil,
      catalystOptions = c.displayItemCatalyst:GetProperty('shown') and labelsOf(c.displayItemCatalyst.list) or nil,
      rangeLines = current.rangeLineList and current.rangeLineList[1] and rangeLines or nil,
      removableModifiers = removable,
      clusterSkills = c.displayItemClusterJewelSkill:GetProperty('shown') and labelsOf(c.displayItemClusterJewelSkill.list) or nil,
      clusterNodeCount = current.crafted and current.clusterJewel and {
        value = current.clusterJewelNodeCount, min = current.clusterJewel.minNodes, max = current.clusterJewel.maxNodes } or nil,
    }
  end)
end

local function describeListMod(listMod)
  local option = describeMod(listMod.mod) or {}
  option.sortValue = listMod.sortValue
  if listMod.essence then option.essence = listMod.essence.name end
  return option
end

-- params: { text, source?, modifier?, custom?, sortBy?, search?, limit? }
-- The "Add modifier..." popup (ItemsTab:AddCustomModifierToDisplayItem).
function M.item_add_modifier(params)
  params = type(params) == 'table' and params or {}
  local item, err = parseItemText(params.text)
  if not item then return nil, err end
  return withDisplayItem(item, function(tab)
    if not tab.controls.displayItemAddCustom:GetProperty('shown') then
      error('PoB offers "Add modifier..." only for magic and rare items (and rare-like uniques); this item is ' .. tostring(item.rarity))
    end
    local controls = openTabPopup(tab, 'AddCustomModifierToDisplayItem')
    local sources = controls.source.list
    if params.source ~= nil then
      local index, serr = pickFromList(sources, params.source, 'source', function(entry, want)
        return entry.sourceId and entry.sourceId:lower() == tostring(want):lower()
      end)
      if not index then error(serr) end
      if index ~= controls.source.selIndex then selectEntry(controls.source, index) end
    end
    local source = sources[controls.source.selIndex]
    local sort
    if params.sortBy ~= nil and source.sourceId ~= 'CUSTOM' then
      local ok, serr = selectSort(controls.sort, params.sortBy)
      if not ok then error(serr) end
      sort = ok.label
    end
    if source.sourceId == 'CUSTOM' then
      if type(params.custom) ~= 'string' or not params.custom:match('%S') then
        return { sources = sourcesOf(sources), source = source.sourceId, note = 'pass custom with the modifier line to add' }
      end
      controls.custom:SetText(params.custom)
      controls.save.onClick()
      return { item = describeItem(tab.displayItem), source = source.sourceId, added = { lines = { params.custom } } }
    end
    if params.modifier == nil then
      local options, matched = listOptions(controls.modSelect.list, params, describeListMod)
      return { sources = sourcesOf(sources), source = source.sourceId, sortBy = sort, options = options, matched = matched }
    end
    local index, merr = pickFromList(controls.modSelect.list, params.modifier, 'modifier')
    if not index then error(merr) end
    controls.modSelect.selIndex = index
    local listMod = controls.modSelect.list[index]
    controls.save.onClick()
    return { item = describeItem(tab.displayItem), source = source.sourceId,
      added = describeMod(listMod.mod), addedLabel = cleanText(listMod.label) }
  end)
end

-- params: { text, source?, group?, modifier?, custom?, sortBy?, search?, limit? }
-- The "Add Implicit..." popup (ItemsTab:AddImplicitToDisplayItem): Searing
-- Exarch and Eater of Worlds implicits (PoB offers them once the item has that
-- influence), Delve implicits, and custom lines.
function M.item_add_implicit(params)
  params = type(params) == 'table' and params or {}
  local item, err = parseItemText(params.text)
  if not item then return nil, err end
  return withDisplayItem(item, function(tab)
    if not tab.controls.displayItemAddImplicit:GetProperty('shown') then
      error('PoB offers "Add Implicit..." only for normal, magic and rare items other than flasks, jewels, tinctures and grafts, or corruptible items whose implicits can change')
    end
    local controls = openTabPopup(tab, 'AddImplicitToDisplayItem')
    local sources = controls.source.list
    if params.source ~= nil then
      local index, serr = pickFromList(sources, params.source, 'source', function(entry, want)
        local id = tostring(want):lower()
        return entry.sourceId ~= nil and (entry.sourceId:lower() == id or (id == 'delve' and entry.sourceId == 'DelveImplicit'))
      end)
      if not index then error(serr) end
      if index ~= controls.source.selIndex then selectEntry(controls.source, index) end
    end
    local source = sources[controls.source.selIndex]
    local sort
    if params.sortBy ~= nil and source.sourceId ~= 'CUSTOM' then
      local ok, serr = selectSort(controls.sort, params.sortBy)
      if not ok then error(serr) end
      sort = ok.label
    end
    if source.sourceId == 'CUSTOM' then
      if type(params.custom) ~= 'string' or not params.custom:match('%S') then
        return { sources = sourcesOf(sources), source = source.sourceId, note = 'pass custom with the implicit line to add' }
      end
      controls.custom:SetText(params.custom)
      controls.save.onClick()
      return { item = describeItem(tab.displayItem), source = source.sourceId, added = { lines = { params.custom } } }
    end
    local groups = controls.modGroupSelect.list
    if params.group == nil then
      -- The Type dropdown; each type's Modifier dropdown is listed with group.
      local options, matched = listOptions(groups, params, function(group, i)
        selectEntry(controls.modGroupSelect, i)
        return { modifierCount = #(controls.modSelect.list or {}), sortValue = group.sortValue }
      end)
      return { sources = sourcesOf(sources), source = source.sourceId, sortBy = sort, groups = options, matched = matched }
    end
    local groupIndex, gerr = pickFromList(groups, params.group, 'implicit type')
    if not groupIndex then error(gerr) end
    selectEntry(controls.modGroupSelect, groupIndex)
    if params.modifier == nil then
      local options, matched = listOptions(controls.modSelect.list, params, describeListMod)
      return { sources = sourcesOf(sources), source = source.sourceId, sortBy = sort,
        group = cleanText(groups[groupIndex].label), options = options, matched = matched }
    end
    local index, merr = pickFromList(controls.modSelect.list, params.modifier, 'modifier')
    if not index then error(merr) end
    controls.modSelect.selIndex = index
    local listMod = controls.modSelect.list[index]
    controls.save.onClick()
    return { item = describeItem(tab.displayItem), source = source.sourceId,
      added = describeMod(listMod.mod), addedLabel = cleanText(listMod.label) }
  end)
end

-- params: { text, source?: 'Corrupted'|'Scourge', implicits?: (number|string)[],
--           rolls?: [{ line, value }], sortBy?, search?, limit?, list?: boolean }
-- The "Corrupt..." popup (ItemsTab:CorruptDisplayItem): up to two corruption
-- implicits, or with the Scourge source upsides (implicits 1-2) and downsides
-- (3-4); for uniques its "Roll Ranges" view sets each line's corrupted range
-- (0.78-1.22). The Items tab's own "Scourge..." button is disabled in this PoB
-- version; the popup's Source dropdown is how Scourge is reached.
function M.item_corrupt(params)
  params = type(params) == 'table' and params or {}
  local item, err = parseItemText(params.text)
  if not item then return nil, err end
  return withDisplayItem(item, function(tab)
    if not tab.controls.displayItemCorrupt:GetProperty('shown') then error('PoB cannot corrupt this item') end
    local controls = openTabPopup(tab, 'CorruptDisplayItem', 'Corrupted')
    if params.source ~= nil then
      local index, serr = pickFromList(controls.source.list, params.source, 'source')
      if not index then error(serr) end
      if index ~= controls.source.selIndex then selectEntry(controls.source, index) end
    end
    local sourceName = controls.source.list[controls.source.selIndex]
    local sort
    if params.sortBy ~= nil then
      local ok, serr = selectSort(controls.sort, params.sortBy)
      if not ok then error(serr) end
      sort = ok.label
    end
    local slots = {}
    for i = 1, 4 do
      if controls['implicit' .. i] and controls['implicit' .. i].shown == true then table.insert(slots, i) end
    end
    local rollLines = {}
    for i = 1, #item.explicitModLines do
      if controls['rollRangeSlider' .. i] then
        table.insert(rollLines, { index = i, label = cleanText(controls['rollRangeLabel' .. i].label) })
      end
    end
    local wantsRolls = type(params.rolls) == 'table' and #params.rolls > 0
    local wantsImplicits = type(params.implicits) == 'table' and #params.implicits > 0
    if params.list then
      local lists = {}
      for _, i in ipairs(slots) do
        local options, matched = listOptions(controls['implicit' .. i].list, params, function(entry)
          return entry.mod and describeMod(entry.mod) or { none = true }
        end)
        table.insert(lists, { slot = i, kind = sourceName == 'Scourge' and (i <= 2 and 'upside' or 'downside') or 'implicit',
          options = options, matched = matched })
      end
      local rolls = {}
      for k, line in ipairs(rollLines) do rolls[k] = { index = k, line = line.label } end
      return { sources = labelsOf(controls.source.list), source = sourceName, sortBy = sort, implicitSlots = lists,
        implicitsCannotBeChanged = item.implicitsCannotBeChanged or nil, rollLines = #rolls > 0 and rolls or nil }
    end
    if wantsRolls and wantsImplicits then error('pass implicits or rolls, not both: PoB corrupts with one or the other') end
    if wantsRolls then
      if #rollLines == 0 then error('PoB offers roll ranges only for unique and relic items with scalable lines') end
      controls.rolls.onClick()
      for n, roll in ipairs(params.rolls) do
        local index, rerr = pickFromList(rollLines, roll.line, 'roll line')
        if not index then error(string.format('rolls %d: %s', n, rerr)) end
        local value = tonumber(roll.value)
        if not value or value < 0.78 or value > 1.22 then error(string.format('rolls %d: value must be 0.78-1.22', n)) end
        local slider = controls['rollRangeSlider' .. rollLines[index].index]
        slider.val = -1
        slider:SetVal((value - 0.78) / 0.44)
      end
    elseif wantsImplicits then
      if #slots == 0 then error('PoB cannot change the implicits of this item') end
      for n, want in ipairs(params.implicits) do
        local slot = slots[n]
        if not slot then error(string.format('implicits %d: PoB shows %d implicit slot(s) for %s', n, #slots, sourceName)) end
        if want ~= '' and want ~= 'None' and want ~= 0 and want ~= 1 then
          local control = controls['implicit' .. slot]
          local index, ierr = pickFromList(control.list, want, 'implicit')
          if not index then error(string.format('implicits %d: %s', n, ierr)) end
          control.selIndex = index
          control.selFunc()
        end
      end
    end
    controls.save.onClick()
    return { item = describeItem(tab.displayItem), source = sourceName }
  end)
end

-- params: { text, slot?: 1|2, skill?, allSkills?, source?, enchantment?, remove?, sortBy?, search?, limit? }
-- The "Change Enchantment..." popups (ItemsTab:EnchantDisplayItem).
function M.item_enchant(params)
  params = type(params) == 'table' and params or {}
  local item, err = parseItemText(params.text)
  if not item then return nil, err end
  local slot = tonumber(params.slot) or 1
  if slot ~= 1 and slot ~= 2 then return nil, 'slot must be 1 or 2' end
  return withDisplayItem(item, function(tab)
    local button = slot == 1 and tab.controls.displayItemEnchant or tab.controls.displayItemEnchant2
    if not button:GetProperty('shown') then
      error(slot == 1 and 'PoB has no enchantments for this item' or 'a second enchantment needs an item that can have two and already has one')
    end
    local controls = openTabPopup(tab, 'EnchantDisplayItem', slot)
    if params.remove then
      controls.remove.onClick()
      return { item = describeItem(tab.displayItem), slot = slot, removed = true }
    end
    local skills
    if controls.skill then
      if params.allSkills and controls.allSkills:IsEnabled() then
        controls.allSkills.state = true
        controls.allSkills.changeFunc(true)
      end
      if params.skill ~= nil then
        local index, kerr = pickFromList(controls.skill.list, params.skill, 'skill')
        if not index then error(kerr) end
        selectEntry(controls.skill, index)
      end
      skills = labelsOf(controls.skill.list)
    end
    if params.source ~= nil then
      local index, serr = pickFromList(controls.enchantmentSource.list, params.source, 'source', function(entry, want)
        return entry.name ~= nil and entry.name:lower() == tostring(want):lower()
      end)
      if not index then error(serr) end
      selectEntry(controls.enchantmentSource, index)
    end
    local sort
    if params.sortBy ~= nil then
      local ok, serr = selectSort(controls.sort, params.sortBy)
      if not ok then error(serr) end
      sort = ok.label
    end
    local sources = {}
    for i, s in ipairs(controls.enchantmentSource.list) do sources[i] = { label = s.label, id = s.name } end
    local sourceEntry = controls.enchantmentSource.list[controls.enchantmentSource.selIndex]
    local skillName = controls.skill and cleanText(controls.skill.list[controls.skill.selIndex]) or nil
    if params.enchantment == nil then
      local options, matched = listOptions(controls.enchantment.list, params, function(entry)
        return { lines = { entry.line }, sortValue = entry.sortValue }
      end)
      return { slot = slot, skills = skills, sources = sources, skill = skillName, source = sourceEntry and sourceEntry.label,
        sortBy = sort, options = options, matched = matched }
    end
    local index, eerr = pickFromList(controls.enchantment.list, params.enchantment, 'enchantment')
    if not index then error(eerr) end
    controls.enchantment.selIndex = index
    local line = controls.enchantment.list[index].line
    controls.save.onClick()
    return { item = describeItem(tab.displayItem), slot = slot, skill = skillName, source = sourceEntry and sourceEntry.label, added = line }
  end)
end

-- Main:Init loads the unique and rare databases in a coroutine advanced once per
-- frame (onFrameFuncs.LoadItems); finish it when a search comes first.
local function itemDbLoaded(db)
  local guard = 0
  while db.loading and main.onFrameFuncs and main.onFrameFuncs.LoadItems and guard < 100000 do
    main.onFrameFuncs.LoadItems()
    guard = guard + 1
  end
  return not db.loading
end

local function describeDbItem(dbItem, withText)
  local entry = { name = dbItem.name, type = dbItem.type, baseName = dbItem.baseName, rarity = dbItem.rarity,
    league = dbItem.league, source = dbItem.source,
    levelRequirement = dbItem.requirements and dbItem.requirements.level or nil }
  if type(dbItem.measuredPower) == 'number' and dbItem.measuredPower > -math.huge then entry.measuredPower = dbItem.measuredPower end
  local okSlot, slotName = pcall(dbItem.GetPrimarySlot, dbItem)
  if okSlot then entry.primarySlot = slotName end
  if dbItem.variantList and #dbItem.variantList > 1 then entry.variants = dbItem.variantList end
  if dbItem.versionList and #dbItem.versionList > 1 then entry.versions = dbItem.versionList end
  if withText then entry.text = dbItem.raw end
  return entry
end

-- params: { db: 'unique'|'rare', name?, variant?, slot?, type?, league?, requirement?, obtainable?,
--           search?, searchMode?, sortBy?, limit?, offset?, includeText? }
-- The Items tab's "Uniques" and "Rare Templates" lists (ItemDBControl): its own
-- filter dropdowns, search box and sort, on a throwaway control.
function M.search_item_db(params)
  params = type(params) == 'table' and params or {}
  local tab, err = itemsTabReady()
  if not tab then return nil, err end
  local dbType = tostring(params.db or 'unique'):upper()
  if dbType == 'RARES' or dbType == 'RARE_TEMPLATES' or dbType == 'TEMPLATES' then dbType = 'RARE' end
  if dbType == 'UNIQUES' then dbType = 'UNIQUE' end
  if dbType ~= 'UNIQUE' and dbType ~= 'RARE' then return nil, 'db must be unique or rare' end
  local db = dbType == 'UNIQUE' and main.uniqueDB or main.rareDB
  if not db or not itemDbLoaded(db) then return nil, 'the item database is still loading' end

  if params.name ~= nil then
    -- Database keys are "Title, Base"; a bare title can name several bases.
    local want = tostring(params.name):lower()
    local found = {}
    for name, candidate in pairs(db.list) do
      if name:lower() == want then found = { candidate } break end
      if candidate.title and candidate.title:lower() == want then table.insert(found, candidate) end
    end
    if #found == 0 then return nil, 'no item named "' .. tostring(params.name) .. '" in the ' .. dbType:lower() .. ' database' end
    table.sort(found, function(a, b) return a.name < b.name end)
    if #found > 1 then
      if params.variant ~= nil then return nil, 'several items have that name; pass the full name ("Title, Base") with variant' end
      local entries = {}
      for i, dbItem in ipairs(found) do entries[i] = describeDbItem(dbItem, true) end
      return { db = dbType:lower(), items = entries, matched = #entries }
    end
    local dbItem = found[1]
    local entry = describeDbItem(dbItem, true)
    if params.variant ~= nil then
      -- ItemsTab:SelectDisplayItemVariant (legacy variants) on a fresh copy.
      local copy = Compat.construct('Item', dbItem.raw)
      local v = tonumber(params.variant)
      if copy.usesVariantGroups then return nil, 'this item uses version and variant groups; edit its text instead' end
      if not copy.variantList or not v or not copy.variantList[v] then
        return nil, string.format('variant must be 1-%d', copy.variantList and #copy.variantList or 0)
      end
      copy.variant = v
      copy:BuildAndParseRaw()
      entry.text = copy:BuildRaw()
      entry.selectedVariant = copy.variantList[v]
    end
    return { db = dbType:lower(), items = { entry }, matched = 1 }
  end

  local control = Compat.construct('ItemDBControl', nil, { 0, 0, 360, 300 }, tab, db, dbType)
  control:LoadLeaguesAndTypes()
  local c = control.controls
  local function choose(dropdown, value, what)
    if value == nil then return end
    if not dropdown then error(what .. ' is not a filter of the ' .. dbType:lower() .. ' database') end
    local index, derr = pickFromList(dropdown.list, value, what)
    if not index then error(derr .. '; options: ' .. table.concat(labelsOf(dropdown.list), ', ')) end
    dropdown.selIndex = index
  end
  local ok, perr = pcall(function()
    choose(c.slot, params.slot, 'slot')
    choose(c.type, params.type, 'type')
    choose(c.league, params.league, 'league')
    choose(c.requirement, params.requirement, 'requirement')
    choose(c.obtainable, params.obtainable, 'obtainable')
    choose(c.searchMode, params.searchMode, 'searchMode')
    if params.sortBy ~= nil then
      if not c.sort then error('sortBy is not available for the rare database') end
      local want = tostring(params.sortBy):lower()
      local found
      for _, entry in ipairs(control.sortDropList) do
        if (entry.stat and entry.stat:lower() == want) or (entry.sortMode and tostring(entry.sortMode):lower() == want)
          or entry.label:lower() == want or entry.label:lower() == 'sort by ' .. want then found = entry end
      end
      if not found then
        local names = {}
        for _, entry in ipairs(control.sortDropList) do table.insert(names, tostring(entry.sortMode)) end
        error('unknown sortBy; options: ' .. table.concat(names, ', '))
      end
      control:SetSortMode(found.sortMode)
    end
    if params.search ~= nil then c.search:SetText(tostring(params.search)) end
  end)
  if not ok then return nil, cleanError(perr) end
  -- ItemDBControl:Draw runs ListBuilder as a coroutine across frames; run it to the end.
  local co = coroutine.create(control.ListBuilder)
  local guard = 0
  repeat
    local okRun, runErr = coroutine.resume(co, control)
    if not okRun then return nil, 'item database search failed: ' .. tostring(runErr) end
    guard = guard + 1
  until coroutine.status(co) == 'dead' or guard > 100000
  local list = control.list or {}
  local offset = math.max(math.floor(tonumber(params.offset) or 0), 0)
  local limit = math.min(math.max(tonumber(params.limit) or 25, 1), 500)
  local items = {}
  for i = offset + 1, math.min(#list, offset + limit) do
    table.insert(items, describeDbItem(list[i], params.includeText == true))
  end
  return {
    db = dbType:lower(), items = items, matched = #list, offset = offset,
    sortBy = control.sortDetail and control.sortDetail.stat and control.sortDetail.label or nil,
    filters = {
      slot = labelsOf(control.slotList), type = labelsOf(control.typeList),
      league = c.league and labelsOf(control.leagueList) or nil,
      requirement = c.requirement and labelsOf(c.requirement.list) or nil,
      obtainable = c.obtainable and labelsOf(c.obtainable.list) or nil,
      searchMode = labelsOf(c.searchMode.list),
    },
  }
end

-- params: { action: 'create'|'copy'|'rename'|'delete', id?, title?, confirm? }
-- The Manage Item Sets popup's list (ItemSetListControl): New, Copy, Rename and
-- Delete with their name and confirmation popups, on a throwaway control over
-- the tab's own set order list.
function M.item_set_manage(params)
  params = type(params) == 'table' and params or {}
  local tab, err = itemsTabReady()
  if not tab then return nil, err end
  local action = tostring(params.action or '')
  local control = Compat.construct('ItemSetListControl', nil, { 0, 0, 300, 200 }, tab)
  local function selectSet()
    local id = tonumber(params.id)
    local index = id and isValueInArray(control.list, id)
    if not index then error(string.format('item set id %s not found', tostring(params.id))) end
    control.selIndex, control.selValue = index, id
    return id, index
  end
  local function nameAndSave(title)
    local popup = main.popups[1]
    if not popup or not popup.controls.edit then error('PoB opened no name popup') end
    local text = title ~= nil and tostring(title) or popup.controls.edit.buf
    if not tostring(text):match('%S') then error('title must not be blank') end
    popup.controls.edit:SetText(text, true)
    popup.controls.save.onClick()
  end
  local popupsBefore = #main.popups
  local ok, res = pcall(function()
    if action == 'create' then
      if params.title == nil then error('title is required') end
      control.controls.new.onClick()
      nameAndSave(params.title)
      return control.selValue
    elseif action == 'copy' then
      selectSet()
      control.controls.copy.onClick()
      nameAndSave(params.title)
      return control.selValue
    elseif action == 'rename' then
      if params.title == nil then error('title is required') end
      local id = selectSet()
      control.controls.rename.onClick()
      nameAndSave(params.title)
      return id
    elseif action == 'delete' then
      if params.confirm ~= true then error('deleting an item set needs confirm: true') end
      local id, index = selectSet()
      if #control.list <= 1 then error('cannot delete the only item set') end
      control:OnSelDelete(index, id)
      local popup = main.popups[1]
      if not popup or not popup.controls.confirm then error('PoB opened no confirmation') end
      popup.controls.confirm.onClick()
      if tab.itemSets[id] then error('PoB did not delete the item set') end
      return id
    end
    error('action must be create, copy, rename or delete')
  end)
  while #main.popups > popupsBefore do main:ClosePopup() end
  if not ok then return nil, cleanError(res) end
  M.get_main_output()
  local result = M.list_item_sets()
  result.action = action
  result.id = res
  return result
end

-- params: { includeText? }
-- The shared item and shared item set lists (SharedItemListControl,
-- SharedItemSetListControl): main.sharedItemList and main.sharedItemSetList,
-- which PoB keeps in its Settings.xml for every build. Read only.
function M.list_shared_items(params)
  params = type(params) == 'table' and params or {}
  if not main then return nil, 'PoB main module not available' end
  local items, sets = {}, {}
  for i, item in ipairs(main.sharedItemList or {}) do
    table.insert(items, { index = i, name = item.name, rarity = item.rarity, type = item.type, baseName = item.baseName,
      text = params.includeText and item.raw or nil })
  end
  for i, set in ipairs(main.sharedItemSetList or {}) do
    local slots = {}
    for slotName, item in pairs(set.slots or {}) do
      slots[slotName] = params.includeText and { name = item.name, text = item.raw } or item.name
    end
    table.insert(sets, { index = i, title = set.title or 'Default', slots = slots })
  end
  return { items = items, itemSets = sets }
end

return M
