import fs from "fs/promises";
import { createHash } from "crypto";
import { wrapHandler } from "../utils/errorHandling.js";
import { buildFileName, resolveBuildFile } from "../utils/pathSanitizer.js";
import { decodeBuildCode, encodeBuildCode } from "../utils/buildCode.js";
import { buildPostLoadSummary, type LuaHandlerContext } from "./luaHandlers.js";
import { sharedBuildSiteClient, type BuildSite, type BuildSiteClient } from "../services/buildSiteClient.js";

export interface BuildSourceDeps {
  siteClient?: Pick<BuildSiteClient, 'download' | 'uploadBuild'>;
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

export interface ShareBuildArgs {
  site?: string;
  /** The hash a preview reported; the upload goes ahead only while the code still has it. */
  confirmCodeHash?: string;
}

/** Short fingerprint of a build code, shown by the preview and required to upload. */
export function codeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 12);
}

const xmlAttr = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/**
 * What the code carries besides the build itself: the Import section
 * ImportTab:Save writes (realm, league, account and character hashes, import
 * link), the notes and the item set names.
 */
export function describeSharedData(xml: string): string[] {
  const lines: string[] = [];
  const importAttrs = xml.match(/<Import\b([^>]*)>/)?.[1] ?? '';
  const present: string[] = [];
  const realm = xmlAttr(importAttrs, 'lastRealm');
  const league = xmlAttr(importAttrs, 'lastLeague');
  const link = xmlAttr(importAttrs, 'importLink');
  if (realm) present.push(`realm ${realm}`);
  if (league) present.push(`league ${league}`);
  if (xmlAttr(importAttrs, 'lastAccountHash')) present.push('account name hash');
  if (xmlAttr(importAttrs, 'lastCharacterHash')) present.push('character name hash');
  if (link) present.push(`import link ${link}`);
  lines.push(`- Import section: ${present.length ? present.join(', ') : 'nothing recorded'}`);
  const notes = xml.match(/<Notes>([\s\S]*?)<\/Notes>/)?.[1]?.trim() ?? '';
  lines.push(`- Notes: ${notes ? `${notes.length} characters` : 'none'}`);
  const setTitles = [...xml.matchAll(/<ItemSet\b[^>]*\btitle="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  lines.push(`- Item set names: ${setTitles.length ? setTitles.join(', ') : 'none'}`);
  return lines;
}

/**
 * Import/Export tab, "Generate" then "Share": the loaded build's code is
 * uploaded to the chosen site (buildSites.UploadBuild) and the link shown.
 * Without confirm_code_hash it only previews, reporting the code's hash; the
 * upload needs that hash and is refused when the build changed since.
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
    const hash = codeHash(code);
    const info = await luaClient.getBuildInfo().catch(() => undefined);
    const what = `the loaded build${info?.name ? ` "${info.name}"` : ''}`;

    const confirm = args.confirmCodeHash?.trim().toLowerCase();
    if (!confirm) {
      return {
        content: [{
          type: "text" as const,
          text: [
            `Not uploaded. share_build would publish ${what} to ${site.label}: a POST of its build code (${code.length} characters) to ${site.postUrl}.`,
            'Anyone with the resulting link can open the whole build file, including:',
            ...describeSharedData(xml),
            `Code hash: ${hash}. To upload exactly this code, call share_build again with confirm_code_hash: "${hash}".`,
          ].join('\n'),
        }],
      };
    }
    if (confirm !== hash) {
      throw new Error(`confirm_code_hash "${args.confirmCodeHash}" does not match the loaded build's code (now ${hash}); the build changed since the preview or the hash is wrong. Nothing was uploaded; preview again.`);
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
