import { wrapHandler } from "../utils/errorHandling.js";
import type { PoBTarget, TargetStatus } from "../server/luaClientManager.js";

export interface TargetContext {
  targetStatus: () => Promise<TargetStatus>;
  selectTarget: (target: PoBTarget) => Promise<TargetStatus>;
}

const label = (t: string | null | undefined) =>
  t === 'gui' ? 'Path of Building window' : t === 'headless' ? 'headless engine' : 'none started yet';

export function describeTargetStatus(status: TargetStatus): string {
  const lines = [
    `Engine in use: ${label(status.active)}`,
    `Preference: ${status.preferred}${status.preferred === 'auto' ? ' (the PoB window when it answers at start, else headless; never switches by itself afterwards)' : ''}`,
  ];
  if (!status.guiConfigured) {
    lines.push('Path of Building window: not configured (set POB_GUI_PATH to a PoB checkout with scripts/pob-gui-apply.mjs applied).');
    return lines.join('\n');
  }
  if (!status.guiReachable) {
    lines.push(`Path of Building window: not reachable${status.guiError ? ` (${status.guiError})` : ''}.`);
    return lines.join('\n');
  }
  const gui = status.gui ?? {};
  const build = gui.build as { name?: string; file?: string; unsaved?: boolean; unsavedIn?: string[] } | undefined;
  lines.push(`Path of Building window: reachable (PoB ${String(gui.version ?? '?')}${gui.devMode ? ', Dev Mode' : ''}, screen ${String(gui.mode ?? '?')})`);
  if (build) {
    const unsavedIn = Array.isArray(build.unsavedIn) ? build.unsavedIn : [];
    lines.push(`  Open build: ${build.name ?? '?'}${build.file ? ` — ${build.file}` : ' (not saved to a file)'}`);
    lines.push(`  Unsaved changes: ${build.unsaved ? `yes (${unsavedIn.join(', ')})` : 'no'}`);
  }
  if (gui.dialogOpen) lines.push('  A dialog is open in PoB: commands that change or replace the build wait until it is closed.');
  return lines.join('\n');
}

export async function handlePobTarget(context: TargetContext, target?: PoBTarget) {
  return wrapHandler('select PoB engine', async () => {
    const status = target ? await context.selectTarget(target) : await context.targetStatus();
    const prefix = target
      ? `Switched preference to ${target}. The new engine has its own build: open or load one before trusting results.\n\n`
      : '';
    return { content: [{ type: "text" as const, text: prefix + describeTargetStatus(status) }] };
  });
}
