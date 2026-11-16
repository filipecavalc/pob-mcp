-- Run by tests/smoke/build-sites.mjs with cwd = PoB's src (no network).
-- resolve_build_link swaps buildSites.DownloadBuild and launch.DownloadPage
-- while PoB's code runs; this checks they are put back after a success and
-- after PoB's code raises, which no input can make it do through the bridge.
local LUA_DIR = (arg and arg[0] or ''):gsub('[^/\\]*$', '') .. '../../lua/'

if not GetVirtualScreenSize then
  function GetVirtualScreenSize() return 1920, 1080 end
end
local Compat = dofile(LUA_DIR .. 'pob_compat.lua')
Compat.accept_launcher_headers()
dofile('HeadlessWrapper.lua')
local BuildOps = assert(loadfile(LUA_DIR .. 'pob_ops.lua'))(Compat)
local json = require('dkjson')

local results = {}
local function check(name, ok, detail)
  table.insert(results, { name = name, ok = ok and true or false, detail = detail and tostring(detail) or nil })
end

local origDownloadBuild = buildSites.DownloadBuild
local origRawDownloadPage = rawget(launch, 'DownloadPage')
local origImportBuild = ImportBuild
local origParseUri = buildSites.ParseImportLinkFromURI
local function restored(label)
  check(label .. ': buildSites.DownloadBuild restored', buildSites.DownloadBuild == origDownloadBuild)
  check(label .. ': launch.DownloadPage restored', rawget(launch, 'DownloadPage') == origRawDownloadPage)
end

local res, err = BuildOps.resolve_build_link({ link = 'https://pobb.in/abc' })
check('success resolves', res and res.downloadUrl == 'https://pobb.in/pob/abc', err)
restored('after success')

ImportBuild = function() error('injected failure in ImportBuild') end
res, err = BuildOps.resolve_build_link({ link = 'https://pobb.in/abc' })
ImportBuild = origImportBuild
check('https error is reported', res == nil and tostring(err):find('injected failure in ImportBuild', 1, true), err)
restored('after an error in ImportBuild')

buildSites.ParseImportLinkFromURI = function() error('injected failure in ParseImportLinkFromURI') end
res, err = BuildOps.resolve_build_link({ link = 'pob://pobbin/abc' })
buildSites.ParseImportLinkFromURI = origParseUri
check('pob:// error is reported', res == nil and tostring(err):find('injected failure in ParseImportLinkFromURI', 1, true), err)
restored('after an error in ParseImportLinkFromURI')

res, err = BuildOps.resolve_build_link({ link = 'pob://nosuch/abc' })
check('unknown pob:// site is an error', res == nil and tostring(err):find('Download information not found', 1, true), err)
restored('after an unknown pob:// site')

res, err = BuildOps.resolve_build_link({ link = 'https://pobb.in/again' })
check('resolving works again afterwards', res and res.downloadUrl == 'https://pobb.in/pob/again', err)

io.write('SMOKE-RESULT ', json.encode(results), '\n')
