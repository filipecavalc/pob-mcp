-- pob-mcp
--
-- Class: MCP Tab
-- Shows the local MCP server (Modules/McpServer.lua): its status, the last
-- commands it ran, and a panel of text the MCP server sends with show_panel.
--
-- It is drawn as a layer over the tab area while `shown` is set, instead of
-- through build.viewMode, because PoB saves viewMode into the build file
-- (Build.lua) and a stock PoB would open such a file on an empty tab.
--
local t_insert = table.insert
local m_max = math.max

local LOG_HEIGHT = 196

local McpTabClass = newClass("McpTab", "ControlHost", "Control", function(self, build, server)
	self.ControlHost()
	self.Control()

	self.build = build
	self.server = server
	self.shown = false
	self.panelVersion = -1
	self.logVersion = -1

	self.controls.status = new("LabelControl", { "TOPLEFT", self, "TOPLEFT" }, { 8, 8, 0, 16 }, function()
		return self:StatusText()
	end)
	self.controls.clear = new("ButtonControl", { "TOPLEFT", self, "TOPLEFT" }, { 8, 32, 110, 20 }, "Clear panel", function()
		server:ClearPanel()
	end)
	self.controls.clear.enabled = function()
		return server.panel ~= nil
	end
	self.controls.panel = new("TextListControl", { "TOPLEFT", self, "TOPLEFT" }, { 8, 60, 0, 0 }, { { x = 4, align = "LEFT" } }, { })
	self.controls.panel.width = function()
		return self.width - 16
	end
	self.controls.panel.height = function()
		return m_max(80, self.height - 60 - 32 - LOG_HEIGHT - 8)
	end
	self.controls.logLabel = new("LabelControl", { "TOPLEFT", self.controls.panel, "BOTTOMLEFT" }, { 0, 8, 0, 16 }, "^7Recent MCP commands:")
	self.controls.log = new("TextListControl", { "TOPLEFT", self.controls.logLabel, "BOTTOMLEFT" }, { 0, 4, 0, LOG_HEIGHT },
		{ { x = 4, align = "LEFT" }, { x = 84, align = "LEFT" }, { x = 300, align = "LEFT" } }, { })
	self.controls.log.width = function()
		return self.width - 16
	end
end)

function McpTabClass:StatusText()
	local server = self.server
	local clients = server.clients and #server.clients or 0
	local last = server.lastRequestAt and os.date("%H:%M:%S", server.lastRequestAt) or "none yet"
	return string.format("^7MCP server on 127.0.0.1:%s  |  %d connection%s  |  last command: %s",
		tostring(server.port), clients, clients == 1 and "" or "s", last)
end

function McpTabClass:RefreshLists()
	local server = self.server
	if self.panelVersion ~= server.panelVersion then
		self.panelVersion = server.panelVersion
		local list = { }
		local panel = server.panel
		if panel then
			t_insert(list, { height = 22, font = "VAR BOLD", "^7" .. panel.title })
			t_insert(list, { height = 16, "^8sent " .. os.date("%H:%M:%S", panel.at) })
			t_insert(list, { height = 8, "" })
			for _, line in ipairs(panel.lines) do
				t_insert(list, { height = 16, "^7" .. line })
			end
		else
			t_insert(list, { height = 16, "^8Nothing sent yet. Content sent by the MCP server (pob_show) appears here." })
		end
		self.controls.panel.list = list
		self.controls.panel.controls.scrollBar:SetOffset(0)
	end
	if self.logVersion ~= server.logVersion then
		self.logVersion = server.logVersion
		local list = { }
		for i = #server.log, 1, -1 do
			local entry = server.log[i]
			t_insert(list, { height = 16,
				"^8" .. os.date("%H:%M:%S", entry.at),
				"^7" .. entry.action,
				entry.ok and "^2ok" or ("^1" .. (entry.error or "failed")),
			})
		end
		self.controls.log.list = list
	end
end

function McpTabClass:Draw(viewPort, inputEvents)
	self.x = viewPort.x
	self.y = viewPort.y
	self.width = viewPort.width
	self.height = viewPort.height
	-- Lets the server see that the Build.lua hook still draws this layer.
	self.drawnFrame = self.server.frame

	self:RefreshLists()
	self:ProcessControlsInput(inputEvents, viewPort)
	main:DrawBackground(viewPort)
	self:DrawControls(viewPort)
end
