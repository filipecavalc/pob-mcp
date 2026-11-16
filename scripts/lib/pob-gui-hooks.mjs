// The two hooks scripts/pob-gui-apply.mjs adds to a Path of Building
// checkout, shared with scripts/pob-gui-update.mjs so it can tell a file that
// holds only these hooks from one with other edits.

const MAIN_HOOK = [
  '\t-- pob-mcp: begin',
  '\tif not self.mcpServerTried then',
  '\t\tself.mcpServerTried = true',
  '\t\tlocal ok, mod = pcall(LoadModule, "Modules/McpServer")',
  '\t\tif ok and mod then self.mcpServer = mod.start(self) else ConPrintf("MCP server: %s", tostring(mod)) end',
  '\tend',
  '\tif self.mcpServer then self.mcpServer:Poll() end',
  '\t-- pob-mcp: end',
];
const MAIN_ANCHOR = /^function main:OnFrame\(\)\r?\n/m;
const MAIN_EXISTING = /\t-- pob-mcp: begin[\s\S]*?-- pob-mcp: end\r?\n/;

const DISPATCH_MARK = 'self.mcpTab:Draw(tabViewPort, inputEvents) -- pob-mcp';
const DISPATCH_ANCHOR = /^\tif self\.viewMode == "IMPORT" then\r?\n/gm;

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

/** Modules/Main.lua: start and poll the server at the top of main:OnFrame. */
export function patchMain(text) {
  if (!MAIN_ANCHOR.test(text)) {
    return { error: 'could not find "function main:OnFrame()" in Modules/Main.lua' };
  }
  const eol = eolOf(text);
  return { text: text.replace(MAIN_EXISTING, '').replace(MAIN_ANCHOR, (m) => m + MAIN_HOOK.join(eol) + eol) };
}

/**
 * Modules/Build.lua: draw the MCP tab while it is shown, ahead of PoB's own
 * viewMode branches (the tab never sets viewMode, which PoB saves into build
 * files).
 */
export function patchBuild(text) {
  if (text.includes(DISPATCH_MARK)) return { text };
  const matches = text.match(DISPATCH_ANCHOR) || [];
  if (matches.length !== 1) {
    return { error: `expected one 'if self.viewMode == "IMPORT" then' line in Modules/Build.lua, found ${matches.length}` };
  }
  const eol = eolOf(text);
  return {
    text: text.replace(DISPATCH_ANCHOR, [
      '\tif self.mcpTab and self.mcpTab.shown then -- pob-mcp',
      `\t\t${DISPATCH_MARK}`,
      '\telseif self.viewMode == "IMPORT" then',
      '',
    ].join(eol)),
  };
}

/** Repo-relative path -> patch function, for every tracked file the additions change. */
export const HOOKED_FILES = {
  'src/Modules/Main.lua': patchMain,
  'src/Modules/Build.lua': patchBuild,
};
