import fs from "fs/promises";
import { wrapHandler } from "../utils/errorHandling.js";
import { buildFileName, resolveBuildFile } from "../utils/pathSanitizer.js";
import { buildPostLoadSummary, type LuaHandlerContext } from "./luaHandlers.js";
import {
  decodeBuildCode,
  encodeBuildCode,
  sharedBuildSiteClient,
  type ArchiveBuild,
  type BuildSite,
  type BuildSiteClient,
} from "../services/buildSiteClient.js";

export interface BuildSourceDeps {
  siteClient?: Pick<BuildSiteClient, 'download' | 'post' | 'uploadBuild'>;
  fileExists?: (filePath: string) => Promise<boolean>;
}

function requireLuaClient(context: LuaHandlerContext) {
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua client not initialized');
  return luaClient;
}

const siteNames = (sites: BuildSite[]) => sites.map((s) => `${s.label} (${s.id})`).join(', ');

export interface ImportBuildLinkArgs {
  /** A link from a site in PoB's list, a pob:// link, or a build code. */
  link?: string;
  name?: string;
  saveAs?: string;
  overwrite?: boolean;
}

/**
 * Import/Export tab, "To import a build, enter URL or code here" followed by
 * Import to a new build: PoB's ImportBuild (Modules/Common.lua) recognises
 * the link, buildSites.DownloadBuild fetches the code (here in TS), and the
 * build opens as "Imported build" with the link stored as its import link.
 */
export async function handleImportBuildLink(context: LuaHandlerContext, args: ImportBuildLinkArgs, deps: BuildSourceDeps = {}) {
  return wrapHandler('import build from link', async () => {
    const input = args.link?.trim();
    if (!input) throw new Error('link is required: a build link (pobb.in, poe.ninja, Maxroll, ...) or a build code');
    const fileExists = deps.fileExists ?? (async (p: string) => fs.access(p).then(() => true, () => false));
    const savePath = args.saveAs ? resolveBuildFile(args.saveAs, context.pobDirectory) : undefined;
    // Checked before anything is downloaded or loaded.
    if (savePath && !args.overwrite && await fileExists(savePath)) {
      throw new Error(`"${buildFileName(args.saveAs!)}" already exists; pass overwrite: true to replace it, or choose another save_as.`);
    }

    await context.ensureLuaClient();
    const luaClient = requireLuaClient(context);
    const resolved = await luaClient.resolveBuildLink(input);

    let xml: string;
    let source: string;
    let importLink: string | undefined;
    if (resolved.kind === 'link') {
      const client = deps.siteClient ?? sharedBuildSiteClient();
      const siteLabel = resolved.site?.label ?? 'the site';
      const code = await client.download(resolved.downloadUrl);
      try {
        xml = decodeBuildCode(code);
      } catch (e) {
        throw new Error(`${siteLabel} answered ${resolved.downloadUrl} with something that is not a build code: ${e instanceof Error ? e.message : String(e)}`);
      }
      source = `${resolved.link} (${siteLabel}, downloaded from ${resolved.downloadUrl})`;
      importLink = resolved.link;
    } else {
      try {
        xml = decodeBuildCode(input);
      } catch (e) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
          const sites = await luaClient.listBuildSites().catch(() => [] as BuildSite[]);
          throw new Error(`no site in Path of Building's list matches this link. PoB imports links from: ${siteNames(sites)}.`);
        }
        throw new Error(`the input is neither a link PoB recognises nor a build code: ${e instanceof Error ? e.message : String(e)}`);
      }
      source = 'build code';
    }

    // ImportTab.lua, "Import to a new build": build:Init(false, "Imported build", xml, false, link).
    const name = args.name?.trim() || 'Imported build';
    await luaClient.loadImportedBuild(xml, name, importLink);
    const summary = await buildPostLoadSummary(context, luaClient, name);

    const lines = [`✅ Build "${name}" imported from ${source}.${summary}`];
    if (savePath && args.saveAs) {
      const saved = await luaClient.saveBuild(savePath, args.overwrite === true);
      context.buildService?.invalidateBuild(args.saveAs);
      lines.push('', `Saved to "${buildFileName(args.saveAs)}" (${saved.size} bytes).`);
    } else {
      lines.push('', 'Not saved; use lua_save_build to keep it.');
    }
    return { content: [{ type: "text" as const, text: lines.join('\n') }] };
  });
}

export interface ListArchiveBuildsArgs {
  /** trending or latest (PoB's build list), or similar (Similar Builds of the loaded build). */
  list?: string;
  limit?: number;
}

const formatNumber = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '?';
};

export function formatArchiveBuild(build: ArchiveBuild, index: number): string[] {
  const lines = [`[${index}] ${build.buildName ?? '(untitled)'}${build.author ? ` by ${build.author}` : ''}`];
  const who = [build.ascendancy ?? build.class, build.mainSkill].filter((v) => v !== undefined && v !== '');
  if (who.length || build.version) lines.push(`    ${who.join(' | ')}${build.version ? `${who.length ? ' | ' : ''}tree ${build.version}` : ''}`);
  const stats = [`DPS ${formatNumber(build.dps ?? 0)}`, `Life ${formatNumber(build.life ?? 0)}`, `ES ${formatNumber(build.es ?? 0)}`, `EHP ${formatNumber(build.ehp ?? 0)}`];
  for (const meta of build.metadata ?? []) stats.push(`${meta.key} ${String(meta.value)}`);
  lines.push(`    ${stats.join(' | ')}`);
  if (build.buildLink) lines.push(`    Link: ${build.buildLink}`);
  if (build.previewLink) lines.push(`    Preview: ${build.previewLink}`);
  return lines;
}

/**
 * PoB Archives (pobarchives.com) as PoB shows it: the build list's Trending
 * and Latest tabs (Modules/BuildList.lua) and the build's Similar Builds
 * popup (Modules/Build.lua OpenSimilarPopup), which posts the loaded build's
 * import code. URLs and parsing come from PoBArchivesProvider in Lua.
 */
export async function handleListArchiveBuilds(context: LuaHandlerContext, args: ListArchiveBuildsArgs, deps: BuildSourceDeps = {}) {
  return wrapHandler('list PoB Archives builds', async () => {
    const list = (args.list ?? 'trending').trim().toLowerCase();
    if (!['trending', 'latest', 'similar'].includes(list)) throw new Error('list must be trending, latest or similar');
    const mode = list === 'similar' ? 'similar' as const : 'builds' as const;

    await context.ensureLuaClient();
    const luaClient = requireLuaClient(context);
    const client = deps.siteClient ?? sharedBuildSiteClient();
    const request = await luaClient.archivesRequest(mode, mode === 'builds' ? list : undefined);

    let body: string;
    let about = '';
    if (request.method === 'POST') {
      // Build.lua: SetImportCode(common.base64.encode(Deflate(self:SaveDB("code"))):gsub(...)).
      const xml = await luaClient.exportBuildXml();
      const info = await luaClient.getBuildInfo().catch(() => undefined);
      body = await client.post(request.url, (request.postField ?? 'importCode=') + encodeBuildCode(xml), false);
      about = ` for the loaded build${info?.name ? ` "${info.name}"` : ''}`;
    } else {
      body = await client.download(request.url);
    }

    const parsed = await luaClient.archivesParse(mode, body);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 20), 1), 100);
    const lines = [`PoB Archives, ${request.list}${about}:`];
    if (parsed.builds.length === 0) {
      lines.push(parsed.statusMsg ?? 'No builds found.');
    } else {
      parsed.builds.slice(0, limit).forEach((build, i) => lines.push(...formatArchiveBuild(build, i + 1)));
      if (parsed.builds.length > limit) lines.push(`... ${parsed.builds.length - limit} more (raise limit to see them).`);
      lines.push('', 'Import one with import_build_link and its Link.');
    }
    if (request.pageUrl) lines.push(`Full list on the site: ${request.pageUrl}`);
    return { content: [{ type: "text" as const, text: lines.join('\n') }] };
  });
}

export interface ShareBuildArgs {
  site?: string;
  confirm?: boolean;
}

/**
 * Import/Export tab, "Generate" then "Share": the loaded build's code is
 * uploaded to the chosen site (buildSites.UploadBuild) and the link shown.
 * Uploads only with confirm: true; without it, reports what would be sent.
 */
export async function handleShareBuild(context: LuaHandlerContext, args: ShareBuildArgs, deps: BuildSourceDeps = {}) {
  return wrapHandler('share build', async () => {
    await context.ensureLuaClient();
    const luaClient = requireLuaClient(context);
    // ImportTab.lua getExportSitesFromImportList.
    const sites = (await luaClient.listBuildSites()).filter((s) => s.canShare);
    const wanted = args.site?.trim().toLowerCase();
    if (!wanted) throw new Error(`site is required. Path of Building shares to: ${siteNames(sites)}.`);
    const site = sites.find((s) => s.id.toLowerCase() === wanted || s.label.toLowerCase() === wanted);
    if (!site) throw new Error(`"${args.site}" is not a site Path of Building shares to. Choose one of: ${siteNames(sites)}.`);

    const xml = await luaClient.exportBuildXml();
    const code = encodeBuildCode(xml);
    const info = await luaClient.getBuildInfo().catch(() => undefined);
    const what = `the loaded build${info?.name ? ` "${info.name}"` : ''}`;

    if (args.confirm !== true) {
      return {
        content: [{
          type: "text" as const,
          text: [
            `Not uploaded. share_build would publish ${what} to ${site.label}: a POST of its build code (${code.length} characters) to ${site.postUrl}.`,
            'Anyone with the resulting link can open the build, including its notes and item set names.',
            'Call share_build again with confirm: true to upload it.',
          ].join('\n'),
        }],
      };
    }

    const client = deps.siteClient ?? sharedBuildSiteClient();
    const link = await client.uploadBuild(site, code);
    return {
      content: [{
        type: "text" as const,
        text: `✅ Shared ${what} on ${site.label}: ${link}\nIt can be imported again with import_build_link.`,
      }],
    };
  });
}
