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
-- Compare tab: copying a tree, item or config from a compared build changes the
-- open build. The other compare_* actions change only the Compare tab's list.
MODIFIES_BUILD.compare_copy = true
-- Actions that work without a build open.
local NO_BUILD_NEEDED = { ping = true, version = true, get_capabilities = true, gui_status = true,
  new_build = true, load_build_xml = true, open_build = true, show_panel = true,
  poe_api_status = true, poe_api_character = true }
-- Build sites: listing sites and resolving links need no build;
-- loading a downloaded build replaces the open one.
REPLACES_BUILD.load_imported_build = true
for _, action in ipairs({ "list_build_sites", "resolve_build_link", "load_imported_build" }) do
  NO_BUILD_NEEDED[action] = true
end
-- Realm codes PoB's own login import uses (realmList in Classes/ImportTab.lua).
local POE_API_REALMS = { pc = true, xbox = true, sony = true }
-- A deferred reply that never comes (a download PoB lost) must not block the connection forever.
local DEFERRED_TIMEOUT_S = 60

local LOG_SIZE = 60
-- TextListControl draws every line each frame (clipped, not culled), so keep panels modest.
local MAX_PANEL_BYTES = 64 * 1024
local MAX_PANEL_LINES = 1000
-- Status polling is not worth a line in the recent-commands list.
local NOT_LOGGED = { ping = true, version = true, get_capabilities = true, gui_status = true, poe_api_status = true }
-- Build.lua switches tabs on these Ctrl shortcuts by setting viewMode only.
local TAB_SHORTCUTS = { ["1"] = true, ["2"] = true, ["3"] = true, ["4"] = true, ["5"] = true, ["6"] = true,
  ["7"] = true, i = true }
local TAB_BUTTONS = { "modeImport", "modeNotes", "modeConfig", "modeTree", "modeSkills", "modeItems",
  "modeCalcs", "modeParty", "modeCompare" }

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

local NOT_LOGGED_IN = "Path of Building is not logged in to Path of Exile: in PoB (MCP), Import/Export, click \"Authorize with Path of Exile\""

-- PoB creates its API client only when an Import tab or trade query is built
-- (ImportTab.lua, TradeQuery.lua), from the login saved in its settings.
local function ensureApi(main)
  if not main.api then
    main.api = new("PoEAPI", main.lastToken, main.lastRefreshToken, main.tokenExpiry)
  end
  return main.api
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

-- The tabs whose own unsaved flag is set: { tabName = true }.
local function tabFlags(build)
  local set = {}
  for _, tab in ipairs({ "notesTab", "partyTab", "configTab", "treeTab", "skillsTab", "itemsTab", "calcsTab" }) do
    if build[tab] and build[tab].modFlag then set[tab] = true end
  end
  -- The active spec has its own flag (Build.lua computes `unsaved` from it too).
  if build.spec and build.spec.modFlag then set.spec = true end
  return set
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

-- A build this server loaded from XML or created is born unsaved (Build.lua
-- sets modFlag for XML loads) and its later bridge edits only raise the same
-- build-level flag. Those are this server's own, so they must not block the
-- next load. Its tabs are recreated by every build Init, so the treeTab
-- object identifies "the build we loaded" until anything opens another one.
function Server:Owns(build)
  return build ~= nil and self.ownedTab ~= nil and build.treeTab == self.ownedTab
end

-- Unsaved changes that may be someone else's: everything when the user
-- opened the build, the per-tab flags (UI edits) when this server loaded it.
function Server:UserChanges(build)
  local flags = unsavedFlags(build)
  if not self:Owns(build) then return flags end
  local others = {}
  for _, f in ipairs(flags) do if f ~= "build" then others[#others + 1] = f end end
  return others
end

function Server:Handle(request)
  local main = self.main
  local action, params = request.action, request.params or {}
  local build = openBuild(main)

  if (REPLACES_BUILD[action] or MODIFIES_BUILD[action]) and main.popups[1] then
    return { ok = false, error = "a dialog is open in Path of Building; finish or close it first" }
  end
  if REPLACES_BUILD[action] and build and params.force ~= true then
    local blocking = self:UserChanges(build)
    if #blocking > 0 then
      return { ok = false, error = "the build open in Path of Building has unsaved changes (" .. table.concat(blocking, ", ")
        .. "); save it in PoB first, or pass force: true to discard them" }
    end
  end
  if not build and not NO_BUILD_NEEDED[action] then
    return { ok = false, error = "no build is open in Path of Building (screen: " .. tostring(main.mode) .. ")" }
  end

  if action == "show_panel" then
    -- Text for the MCP tab; PoB colour codes (^7, ^xRRGGBB) work in it.
    if params.text ~= nil and type(params.text) ~= "string" then return { ok = false, error = "text must be a string" } end
    local text = params.text or ""
    if #text > MAX_PANEL_BYTES then return { ok = false, error = "text too long (max " .. MAX_PANEL_BYTES .. " bytes)" } end
    local lines, truncated = {}, false
    for line in (text .. "\n"):gmatch("([^\n]*)\n") do
      if #lines >= MAX_PANEL_LINES then truncated = true break end
      lines[#lines + 1] = (line:gsub("\r$", ""):gsub("\t", "    "))
    end
    self.panel = { title = type(params.title) == "string" and params.title ~= "" and params.title or "MCP", lines = lines, at = os.time() }
    self.panelVersion = self.panelVersion + 1
    local shown = false
    if params.focus ~= false then shown = self:ShowTab(build) end
    return { ok = true, lines = #lines, truncated = truncated, shown = shown }
  elseif action == "gui_status" then
    local status = guiStatus(main)
    if status.build then status.build.loadedByMcp = self:Owns(build) end
    return { ok = true, status = status }
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
    self.ownedTab = nil
    _G.build = openBuild(main)
    if not _G.build or not _G.build.savers then return { ok = false, error = "PoB did not open the build" } end
    return { ok = true, status = guiStatus(main) }
  elseif action == "poe_api_status" then
    -- Whether PoB holds a Path of Exile login (Import/Export, "Authorize with
    -- Path of Exile"). Only the fact and the expiry leave PoB, never a token.
    local api = ensureApi(main)
    return { ok = true, authenticated = api ~= nil and api.authToken ~= nil,
      tokenExpiry = api and api.authToken and tonumber(api.tokenExpiry) or nil }
  elseif action == "poe_api_character" then
    -- Download one character through PoB's own login, exactly as its "Import
    -- From Your Account" buttons do (PoEAPI:DownloadCharacter: token refresh,
    -- PoB's rate limiter). Returns GGG's character object as is; the token
    -- stays in PoB. PoB answers asynchronously, so the reply is deferred.
    local realm = params.realm or "pc"
    if not POE_API_REALMS[realm] then return { ok = false, error = "realm must be pc, xbox or sony" } end
    -- PoB puts the name into the URL path unescaped; refuse anything that could change the path.
    if type(params.name) ~= "string" or not params.name:match("^[%w_]+$") then
      return { ok = false, error = "name must be a character name (letters, digits, underscore)" }
    end
    local api = ensureApi(main)
    if not api.authToken then
      return { ok = false, error = NOT_LOGGED_IN }
    end
    return { deferred = function(reply)
      api:DownloadCharacter(realm, params.name, function(body, err, timeNext)
        if type(body) == "table" and type(body.character) == "table" then
          reply({ ok = true, character = body.character })
        elseif err == "Response code: 429" then
          local wait = timeNext and math.max(0, timeNext - os.time()) or nil
          reply({ ok = false, error = "rate limited by pathofexile.com" .. (wait and string.format("; retry in %d s", wait) or ""), retryAfter = wait })
        elseif not api.authToken or (err and err:match("401")) then
          -- PoEAPI wipes the login (ResetDetails) when a token refresh fails.
          reply({ ok = false, error = "the Path of Exile login in PoB is no longer valid (" .. tostring(err) .. "); log in again in Import/Export" })
        elseif err and err:match("404") then
          reply({ ok = false, notFound = true, error = "pathofexile.com has no character \"" .. params.name
            .. "\" on the account logged in to PoB (" .. err .. "); the login only reaches that account's characters, and the name must match exactly" })
        else
          reply({ ok = false, error = "pathofexile.com: " .. tostring(err or "no character in the response") })
        end
      end)
    end }
  end

  -- Shared bridge actions read the global `build`, as in the headless bridge.
  _G.build = build
  local handler = self.handlers[action]
  if not handler then return { ok = false, error = "unknown action: " .. tostring(action) } end
  local popupsBefore = #main.popups
  local tabFlagsBefore = build and tabFlags(build) or {}
  local res = handler(params)
  -- TradeQueryGenerator opens a "Please Wait" popup that only its normal finish
  -- closes; drop any popup a command left behind so the window stays usable.
  while #main.popups > popupsBefore do main:ClosePopup() end
  _G.build = openBuild(main)
  local changed = MODIFIES_BUILD[action] or (action == "new_build" and (params.className or params.ascendancy))
  if changed and type(res) == "table" and res.ok and _G.build then
    _G.build.modFlag = true
  end
  -- PoB's own edit functions (AddUndoState) raise the per-tab flags that
  -- UserChanges reads as edits made in the UI. On a build this server loaded,
  -- move the flags this command raised to the build-level flag: the build
  -- still shows as unsaved, and a later edit in the UI raises its tab's flag
  -- again, so it still blocks the next load.
  if _G.build and _G.build == build and self:Owns(build) then
    for tab in pairs(tabFlags(build)) do
      if not tabFlagsBefore[tab] then
        build[tab].modFlag = false
        build.modFlag = true
      end
    end
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
  -- The client gives up after its timeout (e.g. while the window was
  -- minimised) and reports failure; running the request after that would
  -- apply a change the caller was told did not happen. Same machine, same clock.
  if type(request.deadline) == "number" and socket.gettime() * 1000 > request.deadline then
    c.out = c.out .. encode({ ok = false, error = "request expired before Path of Building could run it" })
    return c.authed
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
  if type(res.deferred) == "function" then
    -- The connection reads nothing more until this request is answered, so
    -- replies stay in request order.
    local answered = false
    local function reply(final)
      if answered then return end
      answered = true
      c.pending = nil
      if type(final) ~= "table" then final = { ok = false, error = "handler returned no response" } end
      self:Log(request.action, final.ok == true, final.error)
      c.out = c.out .. encode(final)
    end
    -- Answer before the client gives up (its deadline), so it gets this
    -- error rather than a timeout that drops the connection.
    local limit = DEFERRED_TIMEOUT_S
    if type(request.deadline) == "number" then
      limit = math.min(limit, request.deadline / 1000 - socket.gettime() - 1)
    end
    c.pending = { since = socket.gettime(), limit = math.max(0, limit), reply = reply }
    local started, err = pcall(res.deferred, reply)
    if not started then reply({ ok = false, error = tostring(err) }) end
    return true
  end
  if not NOT_LOGGED[request.action] then self:Log(request.action, res.ok == true, res.error) end
  c.out = c.out .. encode(res)
  return true
end

-- Recent commands, shown in the MCP tab.
function Server:Log(action, ok, err)
  self.lastRequestAt = os.time()
  table.insert(self.log, { at = self.lastRequestAt, action = tostring(action), ok = ok,
    error = err and tostring(err):sub(1, 160) or nil })
  while #self.log > LOG_SIZE do table.remove(self.log, 1) end
  self.logVersion = self.logVersion + 1
end

function Server:ClearPanel()
  self.panel = nil
  self.panelVersion = self.panelVersion + 1
end

-- Returns whether the layer is now up. EnsureTab runs first, so a build
-- switched earlier in this same frame gets its own tab before it is shown.
function Server:ShowTab(build)
  pcall(self.EnsureTab, self)
  build = openBuild(self.main)
  if build and build.mcpTab and build.mcpTab.owner == build.treeTab then
    build.mcpTab.shown = true
    build.mcpTab.shownOver = build.viewMode
    build.mcpTab.shownFrame = self.frame
    return true
  end
  return false
end

-- Give the open build an MCP tab and a sidebar button next to Compare. PoB
-- recreates a build's controls on every Init (Build.lua wipes them), so this
-- runs each frame and adds them again when missing. The other tab buttons
-- are wrapped so that choosing them hides the MCP layer, and they show as
-- unselected while it is up.
function Server:EnsureTab()
  local build = openBuild(self.main)
  if not build or not build.controls or not build.controls.modeCompare then return end
  if not build.mcpTab or build.mcpTab.owner ~= build.treeTab then
    build.mcpTab = new("McpTab", build, self)
    build.mcpTab.owner = build.treeTab
  end
  local tab = build.mcpTab
  if not build.controls.modeMcp then
    build.controls.modeMcp = new("ButtonControl", { "LEFT", build.controls.modeCompare, "RIGHT" }, { 4, 0, 72, 20 }, "MCP", function()
      self:ShowTab(build)
    end)
    build.controls.modeMcp.locked = function() return tab.shown end
    for _, name in ipairs(TAB_BUTTONS) do
      local button = build.controls[name]
      if button then
        local onClick, locked = button.onClick, button.locked
        button.onClick = function(...)
          tab.shown = false
          return onClick(...)
        end
        button.locked = function()
          if tab.shown then return false end
          if type(locked) == "function" then return locked() end
          return locked
        end
      end
    end
  end
  if not tab.shown then return end
  -- Anything else that switched tabs hides the layer: a command changing
  -- viewMode, or a Ctrl shortcut (seen here, before Build.lua handles it,
  -- which matters when it names the tab already under the layer).
  if build.viewMode ~= tab.shownOver then tab.shown = false return end
  if IsKeyDown("CTRL") then
    for _, event in ipairs(self.main.inputEvents or {}) do
      if event.type == "KeyDown" and TAB_SHORTCUTS[event.key] then tab.shown = false return end
    end
  end
  -- The layer is drawn by a hook in Build.lua. If that file was replaced (a
  -- PoB update) the hook is gone: drop the layer rather than leave every tab
  -- button looking unselected.
  if (tab.drawnFrame or tab.shownFrame or 0) < self.frame - 3 then tab.shown = false end
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

-- Whether someone is using the window: a key, click or wheel event, or the
-- cursor moving inside the window's area, within the last two seconds.
-- SimpleGraphic's own hover test (cursorInWindow) is not exposed to Lua, and
-- a cursor resting inside the area may be over another window covering PoB,
-- so only movement counts. Used only to decide whether Poll may wait.
local IDLE_AFTER_MS = 2000
local IDLE_WAIT_S = 0.25
function Server:UserActive()
  local main = self.main
  local now = GetTime()
  if main.inputEvents and main.inputEvents[1] then self.lastInput = now end
  local x, y = GetCursorPos()
  local w, h = main.screenW, main.screenH
  local inside = x and y and w and h and x >= 0 and y >= 0 and x < w and y < h
  if inside and (x ~= self.lastCursorX or y ~= self.lastCursorY) then self.lastInput = now end
  self.lastCursorX, self.lastCursorY = x, y
  return now - (self.lastInput or 0) < IDLE_AFTER_MS
end

-- PoB runs its own long jobs (item database load, power builder, trade query
-- generator) as coroutines at full frame rate; waiting would slow them down.
function Server:OtherWorkRunning()
  for co in pairs(coroutine._list()) do
    if co ~= self.keepAlive and coroutine.status(co) == "suspended" then return true end
  end
  for _, c in ipairs(self.clients) do
    if c.out ~= "" then return true end -- a reply still being sent
    if c.pending then return true end -- a download PoB is running for a request
  end
  return false
end

function Server:Poll()
  -- The keep-alive coroutine makes SimpleGraphic run frames even when the
  -- window is unfocused or minimised (it otherwise skips OnFrame then: see
  -- ui_main.cpp, Frame). With nobody using the window and nothing else to
  -- do, wait for a request instead of spinning: select wakes at once when
  -- one arrives.
  self.frame = (self.frame or 0) + 1
  local tabOk, tabErr = pcall(self.EnsureTab, self)
  if not tabOk and not self.tabErrorShown then
    self.tabErrorShown = true
    ConPrintf("MCP server: could not add the MCP tab: %s", tostring(tabErr))
  end
  if not self:UserActive() and not self:OtherWorkRunning() then
    local watch = { self.listener }
    for _, c in ipairs(self.clients) do watch[#watch + 1] = c.sock end
    socket.select(watch, nil, IDLE_WAIT_S)
  end
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
    if c.pending and socket.gettime() - c.pending.since > c.pending.limit then
      c.pending.reply({ ok = false, error = string.format("pathofexile.com did not answer within %d s", math.floor(c.pending.limit)) })
    end
    local keep = flush(c)
    while keep and not busy and c.out == "" and not c.pending do
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
  local server = setmetatable({ main = main, clients = {}, log = {}, logVersion = 0, panelVersion = 0 }, Server)
  local function loaded()
    _G.build = openBuild(main)
    server.ownedTab = _G.build and _G.build.treeTab or nil
  end
  local handlers = LoadModule("Modules/PobMcp/bridge_handlers")(BuildOps, Compat, {
    mode = "gui",
    adapter = ADAPTER,
    newBuild = function()
      main:SetMode("BUILD", false, "Unnamed build")
      applyModeChange(main)
      loaded()
    end,
    loadBuildFromXML = function(xml, name)
      main:SetMode("BUILD", false, name or "MCP Build", xml)
      applyModeChange(main)
      loaded()
    end,
  })
  local capabilities = handlers.get_capabilities
  handlers.get_capabilities = function(params)
    local res = capabilities(params)
    for _, extra in ipairs({ "gui_status", "open_build", "show_panel", "poe_api_status", "poe_api_character" }) do table.insert(res.capabilities.actions, extra) end
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
  server.listener, server.port, server.handlers, server.token = listener, port, handlers, token

  -- SimpleGraphic runs OnFrame for an unfocused or minimised window only while
  -- a coroutine is suspended (it scans coroutine._list(), Common.lua, after
  -- every call). Keep one suspended for the server's lifetime; nothing else
  -- resumes it, and Poll throttles itself while the window is idle.
  server.keepAlive = coroutine.create(function() while true do coroutine.yield() end end)
  coroutine.resume(server.keepAlive)
  return server
end

return M
