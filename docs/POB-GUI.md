# Path of Building desktop integration

pob-mcp can drive the Path of Building window itself, not only its headless
engine: run the tools against the build you see, and show results in an
**MCP** tab inside PoB. PoB is not forked. A checkout of the official PoB
repository runs from source, and this repo's additions are applied to it by a
script.

## What is installed

The three folders sit side by side (the update script assumes this layout;
set `POB_HEADLESS_DIR` and `POB_GUI_PATH` if yours differs):

| Folder | What it is |
|---|---|
| `PathOfBuilding/` | Official PoB checkout at a release tag. The MCP's headless engine (`POB_PATH` points at its `src`). |
| `PathOfBuilding-gui/` | A git worktree of the same checkout, run from source, with the additions applied (`POB_GUI_PATH`). |
| `pob-mcp/pob-gui/src/` | The additions: `Modules/McpServer.lua` (local server) and `Classes/McpTab.lua` (the tab). The hooks live in `scripts/lib/pob-gui-hooks.mjs`. |

`scripts/pob-gui-apply.mjs` copies the additions and the bridge's shared Lua
(`lua/pob_ops.lua`, `lua/bridge_handlers.lua`, `lua/pob_compat.lua`) into
`PathOfBuilding-gui/src`, and adds two small hooks, idempotently: the server
start/poll in `main:OnFrame` (`Modules/Main.lua`) and one line of the tab
dispatch in `Modules/Build.lua`. It writes nothing if PoB's code no longer
matches what it expects.

## Starting it

Run `PathOfBuilding-gui\runtime\Path{space}of{space}Building.exe` (make a
desktop shortcut to it: right-click, Send to, Desktop). It shows "Dev Mode":
that is PoB's own mode for running from source; auto-update is off in it.
Its settings live in `PathOfBuilding-gui\src`, apart from the installed PoB;
point its build folder at your usual one in Options if you like.

The **MCP** button sits next to Compare. The tab shows the server's status,
recent commands, and panels the MCP sends with `pob_show`.

## Using it from the MCP

- `pob_target`: which engine runs the tools, and what the window has open.
  `pob_target gui` switches the tools to the window; `headless` switches back.
  The window is opt-in because tools that load builds (`import_character`,
  `compare_builds`, the optimisers) replace what is open in it.
- `pob_show`: put text in the MCP tab (ASCII; PoB colour codes like `^2` work).

Server env: `POB_GUI_PATH` (the desktop checkout), optional `POB_TARGET`
(`headless` default, `gui`, `auto`), `POB_MCP_PORT` (49280),
`POB_GUI_TIMEOUT_MS` (30000).

## Safety

- The server listens on 127.0.0.1 only and needs a token from
  `PathOfBuilding-gui\src\pob-mcp-token.txt`, so a web page cannot drive it.
- It never replaces a build with unsaved changes made in the UI, or while a
  dialog is open; changes it makes mark the build unsaved, so PoB asks before
  closing.
- Dev Mode normally writes a closing build back to its file unasked; the
  server turns that off (PoB's own "Disable Dev AutoSave" option).
- Saving without `overwrite` may replace only the file open in the window.
- Requests carry a deadline: a request that waited too long (window
  minimised) is dropped, not run late.

## Updating to a new PoB release

When the installed PoB updates itself, bring both checkouts to the same
version so the numbers match:

1. Close the PoB window with the MCP tab, and stop the MCP server: quit the
   client app that runs it, or call the `lua_stop` tool. Both keep PoB's
   runtime files open, and Windows will not let git replace them.
2. `node scripts/pob-gui-update.mjs --check` (shows the plan), then
   `node scripts/pob-gui-update.mjs`.
   It reads the installed PoB's version (or `--to vX.Y.Z`), fetches that tag,
   checks it out in both checkouts, and re-applies the additions.
3. Start the PoB window again, and start the MCP server again (restart its
   client app, or call `lua_start`) so the headless engine loads the release.

It refuses to run while the window answers on its port, while any runtime
file in either checkout is in use, when the headless checkout has local
changes, or when the desktop checkout has changes other than exactly the
MCP hooks; it never discards such edits. After each checkout it confirms the
checkout really switched, and says how to recover if not. If a release
changes the code the hooks rely on, the update stops after checking out the
release and says so: the desktop copy then runs as plain PoB until
`scripts/lib/pob-gui-hooks.mjs` is updated.

## Troubleshooting

- **Tools time out with the window target:** PoB was busy or minimised past
  `POB_GUI_TIMEOUT_MS`. The server keeps answering in the background, so this
  usually means a long action. `pob_target` shows the state.
- **"not reachable":** the window is not running, or another program holds
  port 49280.
- **The MCP button is missing:** the build screen is not open (it appears
  once a build is), or the additions are not applied; re-run
  `node scripts/pob-gui-apply.mjs ..\PathOfBuilding-gui` from the pob-mcp
  folder, then restart the window.
- **Background CPU:** about 5% of one core while idle, measured minimised;
  it waits in `socket.select` when nobody is using the window.
