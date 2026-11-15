-- Local JSON-lines server inside the Path of Building desktop app, so the
-- MCP server can read and drive the build open in the window.
--
-- Listens on 127.0.0.1 only (POB_MCP_PORT, default 49280). Each request is
-- one JSON object per line, { "action": ..., "params": {...} }, answered with
-- one JSON line. The actions are the headless stdio bridge's own
-- (Modules/PobMcp/bridge_handlers.lua, copied from pob-mcp's lua/ folder by
-- scripts/pob-gui-apply.mjs), plus a few that only make sense with a window.
--
-- A connection must open with { "action": "hello", "token": ... }, the token
-- this server writes to <PoB user path>/pob-mcp-token.txt at start. A web page
-- can send bytes to a localhost port but cannot read that file, so it cannot
-- get past the hello; any line that is not a JSON object closes the connection.
--
-- Sockets are non-blocking and polled from main:OnFrame, so commands run on
-- PoB's main thread between frames and never stall the UI. While the window
-- is minimised PoB runs no frames, so requests wait until it is restored.
local socket = require("socket")
local json = require("dkjson")

local DEFAULT_PORT = 49280
local MAX_LINE = 16 * 1024 * 1024
local ADAPTER = "gui-socket-v1"
local TOKEN_FILE = "pob-mcp-token.txt"

-- Actions that replace the open build: refused while it has unsaved changes,
-- because switching builds this way skips PoB's "save changes?" prompt.
local REPLACES_BUILD = { new_build = true, load_build_xml = true, open_build = true }
-- Actions that change the open build. The bridge edits PoB's objects
-- directly, so they set no tab's modFlag; marking the build modified makes
-- PoB show it as unsaved and ask before closing, as an edit in the UI would.
local MODIFIES_BUILD = {
  set_config = true, add_item_text = true, set_tree = true, update_tree_delta = true, set_main_selection = true,
  set_level = true, set_flask_active = true, set_gem_level = true, set_gem_quality = true, set_gem_enabled = true,
  remove_skill = true, remove_gem = true, create_socket_group = true, add_gem = true, select_spec = true,
  create_spec = true, delete_spec = true, rename_spec = true, select_item_set = true,
  set_socket_group_enabled = true, import_character = true,
}
-- Actions that work without a build open.
local NO_BUILD_NEEDED = { ping = true, version = true, get_capabilities = true, gui_status = true,
  new_build = true, load_build_xml = true, open_build = true }

local Server = {}
Server.__index = Server

local function encode(value)
  local ok, encoded = pcall(json.encode, value)
  if not ok then encoded = json.encode({ ok = false, error = "response could not be serialised: " .. tostring(encoded) }) end
  return encoded .. "\n"
end

-- Mirrors the mode switch at the top of main:OnFrame (Modules/Main.lua), so a
-- build replaced by a command is fully initialised before the reply is sent.
local function applyModeChange(main)
  while main.newMode do
    if main.mode then main:CallMode("Shutdown") end
    main.mode = main.newMode
    main.newMode = nil
    main:CallMode("Init", unpack(main.newModeArgs))
    if main.newModeChangeToTree then main.modes[main.mode].viewMode = "TREE" end
    main.newModeChangeToTree = false
  end
end

local function openBuild(main)
  if main.mode ~= "BUILD" then return nil end
  return main.modes["BUILD"]
end

-- Which tabs hold unsaved changes (Build.lua computes `unsaved` from these flags).
local function unsavedFlags(build)
  local flags = {}
  if build.modFlag then flags[#flags + 1] = "build" end
  for _, tab in ipairs({ "notesTab", "partyTab", "configTab", "treeTab", "skillsTab", "itemsTab", "calcsTab" }) do
    if build[tab] and build[tab].modFlag then flags[#flags + 1] = tab end
  end
  if build.treeTab and build.treeTab.searchFlag then flags[#flags + 1] = "treeTab.search" end
  if build.spec and build.spec.modFlag then flags[#flags + 1] = "spec" end
  return flags
end

local function guiStatus(main)
  local build = openBuild(main)
  local status = { mode = main.mode, devMode = launch.devMode == true, version = launch.versionNumber,
    dialogOpen = main.popups[1] ~= nil }
  if build then
    local flags = unsavedFlags(build)
    status.build = {
      name = build.buildName,
      file = build.dbFileName or nil,
      viewMode = build.viewMode,
      unsaved = #flags > 0,
      unsavedIn = flags,
    }
  end
  return status
end

local function newToken()
  local entropy = math.floor(socket.gettime() * 1000000) + (tonumber(tostring({}):match("(%x+)$") or "0", 16) or 0)
  math.randomseed(entropy % 2147483647)
  local t = {}
  for i = 1, 32 do t[i] = string.format("%x", math.random(0, 15)) end
  return table.concat(t)
end

function Server:Handle(request)
  local main = self.main
  local action, params = request.action, request.params or {}
  local build = openBuild(main)

  if (REPLACES_BUILD[action] or MODIFIES_BUILD[action]) and main.popups[1] then
    return { ok = false, error = "a dialog is open in Path of Building; finish or close it first" }
  end
  if REPLACES_BUILD[action] and build and #unsavedFlags(build) > 0 and params.force ~= true then
    return { ok = false, error = "the build open in Path of Building has unsaved changes (" .. table.concat(unsavedFlags(build), ", ")
      .. "); save it in PoB first, or pass force: true to discard them" }
  end
  if not build and not NO_BUILD_NEEDED[action] then
    return { ok = false, error = "no build is open in Path of Building (screen: " .. tostring(main.mode) .. ")" }
  end

  if action == "gui_status" then
    return { ok = true, status = guiStatus(main) }
  elseif action == "open_build" then
    -- Opens a saved build as PoB's own build list does: with only the file path,
    -- PoB reads the file itself and the build opens clean (Build.lua marks a
    -- build given as XML text as unsaved), and saving in PoB writes back to it.
    if type(params.path) ~= "string" then return { ok = false, error = "missing path" } end
    local f = io.open(params.path, "rb")
    if not f then return { ok = false, error = "cannot read " .. params.path } end
    f:close()
    local name = params.path:match("([^/\\]+)%.[xX][mM][lL]$") or "Build"
    main:SetMode("BUILD", params.path, name)
    applyModeChange(main)
    _G.build = openBuild(main)
    if not _G.build or not _G.build.savers then return { ok = false, error = "PoB did not open the build" } end
    return { ok = true, status = guiStatus(main) }
  end

  -- Shared bridge actions read the global `build`, as in the headless bridge.
  _G.build = build
  local handler = self.handlers[action]
  if not handler then return { ok = false, error = "unknown action: " .. tostring(action) } end
  local popupsBefore = #main.popups
  local res = handler(params)
  -- TradeQueryGenerator opens a "Please Wait" popup that only its normal finish
  -- closes; drop any popup a command left behind so the window stays usable.
  while #main.popups > popupsBefore do main:ClosePopup() end
  _G.build = openBuild(main)
  local changed = MODIFIES_BUILD[action] or (action == "new_build" and (params.className or params.ascendancy))
  if changed and type(res) == "table" and res.ok and _G.build then
    _G.build.modFlag = true
  end
  return res
end

function Server:Drop(i)
  pcall(function() self.clients[i].sock:close() end)
  table.remove(self.clients, i)
end

-- Answer one line; returns false when the connection must be closed.
function Server:OnLine(c, line)
  local request = json.decode(line)
  if type(request) ~= "table" then
    c.out = c.out .. encode({ ok = false, error = "invalid request: expected a JSON object; closing" })
    return false
  end
  if not c.authed then
    if request.action == "hello" and request.token == self.token then
      c.authed = true
      c.out = c.out .. encode({ ok = true, hello = true, adapter = ADAPTER })
      return true
    end
    c.out = c.out .. encode({ ok = false, error = "send { action: 'hello', token } first (token in " .. TOKEN_FILE .. ")" })
    return false
  end
  local ok, res = pcall(self.Handle, self, request)
  if not ok then res = { ok = false, error = tostring(res) } end
  if type(res) ~= "table" then res = { ok = false, error = "handler returned no response" } end
  c.out = c.out .. encode(res)
  return true
end

-- Send what fits; keep the rest for the next frame.
local function flush(c)
  if c.out == "" then return true end
  local sent, err, partialIndex = c.sock:send(c.out)
  if sent then
    c.out = ""
    return true
  end
  if err == "timeout" then
    c.out = c.out:sub((partialIndex or 0) + 1)
    return true
  end
  return false
end

function Server:Poll()
  while true do
    local client = self.listener:accept()
    if not client then break end
    client:settimeout(0)
    table.insert(self.clients, { sock = client, partial = "", out = "", authed = false })
  end
  -- A build switch the user started last frame is still pending: let PoB
  -- finish it before running commands against the build.
  local busy = self.main.newMode ~= nil
  for i = #self.clients, 1, -1 do
    local c = self.clients[i]
    local keep = flush(c)
    while keep and not busy and c.out == "" do
      local line, err, partial = c.sock:receive("*l", c.partial)
      if line then
        c.partial = ""
        keep = self:OnLine(c, line)
        keep = flush(c) and keep
      else
        c.partial = partial or ""
        if err ~= "timeout" or #c.partial > MAX_LINE then keep = false end
        break
      end
    end
    if not keep then
      flush(c)
      self:Drop(i)
    end
  end
end

local M = {}

function M.start(main)
  -- Run from source, PoB is in Dev Mode, where closing a build saves it to its
  -- file without asking (buildMode:Shutdown in Build.lua). A command that
  -- replaces the open build would then write whatever that build held over
  -- the user's file. Turn that off with PoB's own "Disable Dev AutoSave"
  -- option, so builds are only written when someone saves.
  main.disableDevAutoSave = true

  local Compat = LoadModule("Modules/PobMcp/pob_compat")
  local BuildOps = LoadModule("Modules/PobMcp/pob_ops", Compat)
  -- The headless bridge advances PoB a frame with runCallback after an import;
  -- here PoB is already inside a frame, and get_main_output recalculates.
  BuildOps.advanceFrame = function() end
  local handlers = LoadModule("Modules/PobMcp/bridge_handlers")(BuildOps, Compat, {
    mode = "gui",
    adapter = ADAPTER,
    newBuild = function()
      main:SetMode("BUILD", false, "Unnamed build")
      applyModeChange(main)
      _G.build = openBuild(main)
    end,
    loadBuildFromXML = function(xml, name)
      main:SetMode("BUILD", false, name or "MCP Build", xml)
      applyModeChange(main)
      _G.build = openBuild(main)
    end,
  })
  local capabilities = handlers.get_capabilities
  handlers.get_capabilities = function(params)
    local res = capabilities(params)
    for _, extra in ipairs({ "gui_status", "open_build" }) do table.insert(res.capabilities.actions, extra) end
    table.sort(res.capabilities.actions)
    return res
  end

  local port = tonumber(os.getenv("POB_MCP_PORT") or "") or DEFAULT_PORT
  local listener = socket.tcp()
  local ok, err = listener:bind("127.0.0.1", port)
  if not ok then
    ConPrintf("MCP server: cannot listen on 127.0.0.1:%d (%s)", port, tostring(err))
    listener:close()
    return nil
  end
  listener:listen(8)
  listener:settimeout(0)

  local token = newToken()
  local tokenPath = (main.userPath or "") .. TOKEN_FILE
  local f = io.open(tokenPath, "w")
  if not f then
    ConPrintf("MCP server: cannot write %s; not listening", tokenPath)
    listener:close()
    return nil
  end
  f:write(token)
  f:close()
  ConPrintf("MCP server: listening on 127.0.0.1:%d (token in %s)", port, tokenPath)
  return setmetatable({ main = main, listener = listener, clients = {}, port = port, handlers = handlers, token = token }, Server)
end

return M
