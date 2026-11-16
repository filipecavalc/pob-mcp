/**
 * Lua Client Manager
 *
 * Manages the lifecycle of the PoB Lua Bridge (stdio headless mode)
 */

import { PoBLuaApiClient } from '../pobLuaBridge.js';
import { DEFAULT_GUI_PORT, PoBGuiApiClient } from '../pobGuiClient.js';
import { noteIgnoredError } from '../utils/errorHandling.js';
import { BOOTSTRAP_BUILD_NAME } from './bootstrapBuild.js';
import path from 'node:path';

/**
 * Resolve a repo-owned file relative to this module, not process.cwd() —
 * MCP clients like Claude Desktop launch the server with an arbitrary cwd.
 *
 * Resolved on call and without the bare `import.meta` meta-property: it is a
 * hard compile error under the CommonJS ts-jest transform (TS1343), which made
 * this module — the bridge lifecycle — impossible to import in tests, and a
 * module-scope const would break importing the file even when unused.
 *
 * ESM fallback: a module URL must be constructed without process.cwd(), and
 * the only cwd-free options (import.meta, or eval'd meta-property) are either
 * a compile break in CJS or a new runtime dependency. So in ESM (the production
 * build) we resolve via the require cache of an anchor require built from the
 * entry module's wrapper directory — see the caller comment in index.ts: it
 * sets POB_REPO_ROOT at startup, which is the authoritative source; this
 * fallback exists only for library use without that env var.
 */
function repoPath(...segments: string[]): string {
  if (process.env.POB_REPO_ROOT) {
    return path.join(process.env.POB_REPO_ROOT, ...segments);
  }
  if (typeof require !== 'undefined' && typeof __dirname !== 'undefined') {
    return path.join(__dirname, '..', '..', ...segments);
  }
  throw new Error(
    'Cannot locate repo-owned Lua files: set POB_REPO_ROOT (the shipped server entry sets it automatically)',
  );
}

/** Which engine runs the bridge actions. */
export type PoBTarget = 'auto' | 'gui' | 'headless';
export type ActiveTarget = 'gui' | 'headless';

export interface GuiTargetConfig {
  tokenFile: string;
  port: number;
  timeoutMs: number;
}

/**
 * The desktop target is configured by POB_GUI_PATH (a PoB checkout with
 * scripts/pob-gui-apply.mjs applied; its token lives in src/) or directly by
 * POB_GUI_TOKEN_FILE. Without either, only the headless engine exists.
 */
export function guiTargetConfig(env: NodeJS.ProcessEnv = process.env): GuiTargetConfig | null {
  const tokenFile = env.POB_GUI_TOKEN_FILE
    || (env.POB_GUI_PATH ? path.join(env.POB_GUI_PATH, 'src', 'pob-mcp-token.txt') : '');
  if (!tokenFile) return null;
  return {
    tokenFile,
    port: Number(env.POB_MCP_PORT) || DEFAULT_GUI_PORT,
    timeoutMs: Number(env.POB_GUI_TIMEOUT_MS) || 30000,
  };
}

// The window is opt-in: tools that load builds (import_character, compare,
// the optimisers) replace what is open there, so it is used only when chosen.
function parseTarget(value: string | undefined): PoBTarget {
  return value === 'gui' || value === 'headless' || value === 'auto' ? value : 'headless';
}

export interface TargetStatus {
  preferred: PoBTarget;
  active: ActiveTarget | null;
  guiConfigured: boolean;
  guiReachable?: boolean;
  guiError?: string;
  gui?: Record<string, unknown>;
}

export class LuaClientManager {
  private client: PoBLuaApiClient | null = null;
  private enabled: boolean;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private preferred: PoBTarget;
  private active: ActiveTarget | null = null;
  private switching: Promise<TargetStatus> | null = null;
  private readonly guiConfig: GuiTargetConfig | null;

  constructor(enabled: boolean, env: NodeJS.ProcessEnv = process.env) {
    this.enabled = enabled;
    this.guiConfig = guiTargetConfig(env);
    this.preferred = this.guiConfig ? parseTarget(env.POB_TARGET) : 'headless';
  }

  /** Which engine is serving tool calls, and what the desktop app reports. */
  async targetStatus(): Promise<TargetStatus> {
    const status: TargetStatus = {
      preferred: this.preferred,
      active: this.client && this.client.isAlive() ? this.active : null,
      guiConfigured: !!this.guiConfig,
    };
    if (!this.guiConfig) return status;
    // Always a separate short-lived connection: the active client is untouched
    // and the status never waits behind a long request in its queue.
    const probe = new PoBGuiApiClient({ ...this.guiConfig, connectTimeoutMs: 1500, timeoutMs: 1500 });
    try {
      await probe.start();
      status.gui = await probe.guiStatus();
      status.guiReachable = true;
    } catch (e) {
      status.guiReachable = false;
      status.guiError = e instanceof Error ? e.message : String(e);
    } finally {
      await probe.stop();
    }
    return status;
  }

  /**
   * Show text in the window's MCP tab, whichever engine runs the tools: the
   * active connection when it is the window, else a short-lived one.
   */
  async showPanel(title: string, text: string, focus = true): Promise<{ lines: number; shown: boolean; truncated: boolean }> {
    if (!this.guiConfig) {
      throw new Error('The Path of Building desktop target is not configured: set POB_GUI_PATH (or POB_GUI_TOKEN_FILE) in the server env.');
    }
    if (this.client instanceof PoBGuiApiClient && this.client.isAlive()) {
      return this.client.showPanel(title, text, focus);
    }
    const once = new PoBGuiApiClient({ ...this.guiConfig, connectTimeoutMs: 1500 });
    try {
      await once.start();
      return await once.showPanel(title, text, focus);
    } finally {
      await once.stop();
    }
  }

  /**
   * Run something against the window, whichever engine runs the tools: the
   * active connection when it is the window, else a short-lived one.
   * Undefined when the window target is not configured.
   */
  async withGui<T>(fn: (gui: PoBGuiApiClient) => Promise<T>): Promise<T | undefined> {
    if (!this.guiConfig) return undefined;
    if (this.client instanceof PoBGuiApiClient && this.client.isAlive()) return fn(this.client);
    const once = new PoBGuiApiClient({ ...this.guiConfig, connectTimeoutMs: 1500 });
    try {
      await once.start();
      return await fn(once);
    } finally {
      await once.stop();
    }
  }

  /**
   * Switch engines explicitly. The build loaded in the old engine stays there:
   * the caller must load or open a build in the new one.
   */
  async selectTarget(target: PoBTarget): Promise<TargetStatus> {
    if (target !== 'headless' && !this.guiConfig) {
      throw new Error('The Path of Building desktop target is not configured: set POB_GUI_PATH (or POB_GUI_TOKEN_FILE) in the server env.');
    }
    if (this.switching) await this.switching.catch(() => {});
    const run = (async () => {
      const alreadyThere = this.client && this.client.isAlive()
        && (target === this.active || (target === 'auto' && this.preferred === 'auto'));
      if (alreadyThere) {
        this.preferred = target;
        return this.targetStatus();
      }
      const previous = this.preferred;
      // Set before stopping, so a tool call that races in starts the new engine.
      this.preferred = target;
      await this.stopClient();
      try {
        await this.ensureClient();
      } catch (error) {
        this.preferred = previous;
        throw new Error(`${error instanceof Error ? error.message : String(error)} (kept the ${previous} preference; the next call starts that engine again with a fresh build)`);
      }
      return this.targetStatus();
    })();
    this.switching = run;
    try {
      return await run;
    } finally {
      if (this.switching === run) this.switching = null;
    }
  }

  /**
   * Get the current client instance
   */
  getClient(): PoBLuaApiClient | null {
    return this.client;
  }

  /**
   * Ensure the Lua client is initialized and ready
   */
  async ensureClient(): Promise<void> {
    if (!this.enabled) {
      throw new Error('PoB Lua Bridge is not enabled. Set POB_LUA_ENABLED=true to use lua_* tools.');
    }

    // A stop is draining — join it before deciding anything. stopClient()
    // awaits the quit handshake BEFORE clearing this.client, so without this
    // a concurrent tool call saw the (already killing) client as healthy,
    // returned it, and the stop then killed it mid-use — or worse, raced a
    // fresh spawn against the kill.
    if (this.stopping) {
      await this.stopping.catch(() => {});
    }

    // A start is already in flight — join it instead of spawning a second process
    if (this.starting) {
      return this.starting;
    }

    if (this.client && this.client.isAlive()) {
      return; // Already initialized and healthy
    }

    let crashed = false;
    let deadClient: PoBLuaApiClient | null = null;
    const lostTarget = this.active;
    if (this.client) {
      // Process died — clean up the dead client so we restart below
      console.error('[Lua Bridge] Client process died, restarting...');
      crashed = true;
      deadClient = this.client;
      this.client = null;
    }

    // Reserve the starting slot SYNCHRONOUSLY before awaiting anything.
    // The old order (await dead.stop(), THEN set this.starting) let a second
    // concurrent ensureClient() — two tool calls in one stdio read batch —
    // see starting===null and a dead client, take the same path, and spawn a
    // second bridge whose process nothing could ever stop.
    const pending = (async () => {
      if (deadClient) {
        try { await deadClient.stop(); } catch (e) { noteIgnoredError("stop of crashed bridge before restart (process already gone)", e); }
      }
      // After a loss, restart the same engine: switching would answer the
      // next calls from a different build without anyone noticing.
      await this.initClient(crashed && lostTarget ? lostTarget : undefined);
      if (crashed && lostTarget === 'gui') {
        // Never switch engines silently: the next answers would come from a different build.
        throw new Error(`The connection to the Path of Building window was lost (closed, or minimised past the timeout). Now using the ${this.active} engine${this.active === 'gui' ? ' again' : ''}; check which build it has (pob_target, lua_get_build_info) before trusting results, then retry.`);
      }
      if (crashed) {
        // The restarted bridge holds only the init-test build; proceeding silently
        // would return blank-character stats as if they were the user's build.
        throw new Error('The PoB Lua bridge crashed and was restarted. The previously loaded build was lost — reload it with lua_load_build, then retry.');
      }
    })();
    this.starting = pending;
    try {
      await pending;
    } finally {
      if (this.starting === pending) {
        this.starting = null;
      }
    }
  }

  private async initClient(only?: ActiveTarget): Promise<void> {
    if (only === 'headless') {
      await this.initHeadlessClient();
      this.active = 'headless';
      return;
    }
    if (only === 'gui' || (this.preferred !== 'headless' && this.guiConfig)) {
      if (!this.guiConfig) throw new Error('The Path of Building desktop target is not configured');
      const gui = new PoBGuiApiClient(this.guiConfig);
      try {
        await gui.start();
        // No bootstrap build here: the window shows the user's build and stays as it is.
        this.client = gui;
        this.active = 'gui';
        console.error('[Lua Bridge] Using the Path of Building desktop window');
        return;
      } catch (error) {
        await gui.stop();
        if (this.preferred === 'gui' || only === 'gui') {
          throw new Error(`Failed to reach Path of Building desktop: ${error instanceof Error ? error.message : String(error)}`);
        }
        noteIgnoredError('desktop target unavailable, using the headless engine (POB_TARGET=auto)', error);
      }
    }
    await this.initHeadlessClient();
    this.active = 'headless';
  }

  private async initHeadlessClient(): Promise<void> {
    console.error('[Lua Bridge] Initializing client...');

    const stdioClient = new PoBLuaApiClient({
      cwd: process.env.POB_PATH || process.env.POB_FORK_PATH,
      cmd: process.env.POB_CMD,
      args: process.env.POB_ARGS ? process.env.POB_ARGS.split(/\s+/).filter(Boolean) : [repoPath('lua', 'vanilla_stdio_bridge.lua')],
      // The repo-owned adapter calls HeadlessWrapper as a library; nothing in
      // the PoB checkout may take over stdin/stdout first.
      env: { POB_API_STDIO: '0' },
      timeoutMs: process.env.POB_TIMEOUT_MS ? parseInt(process.env.POB_TIMEOUT_MS) : undefined,
    });

    try {
      await stdioClient.start();
      console.error('[Lua Bridge] Client initialized successfully');

      // Wait for HeadlessWrapper to be fully ready (loadBuildFromXML available)
      console.error('[Lua Bridge] Waiting for HeadlessWrapper to finish loading...');
      // Omitting targetVersion opens PoB's legacy conversion prompt and leaves initialization incomplete.
      const testXml = '<?xml version="1.0" encoding="UTF-8"?><PathOfBuilding><Build level="1" targetVersion="3_0" className="Witch"/></PathOfBuilding>';
      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        try {
          await stdioClient.loadBuildXml(testXml, BOOTSTRAP_BUILD_NAME);
          console.error('[Lua Bridge] HeadlessWrapper fully initialized');
          break;
        } catch (loadError) {
          attempts++;
          if (attempts >= maxAttempts) {
            throw new Error(`HeadlessWrapper did not initialize after ${maxAttempts} attempts. Error: ${loadError instanceof Error ? loadError.message : String(loadError)}`);
          }
          console.error(`[Lua Bridge] HeadlessWrapper not ready (attempt ${attempts}/${maxAttempts}), waiting 2s...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Only expose the client once it has proven it can load a build
      this.client = stdioClient;
    } catch (error) {
      // Don't leak a half-initialized process, and don't let a later
      // ensureClient() treat this unverified client as healthy
      try { await stdioClient.stop(); } catch (e) { noteIgnoredError("stop of half-initialized bridge (start is what failed)", e); }
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[Lua Bridge] Failed to initialize:', errorMsg);
      throw new Error(`Failed to start PoB Lua Bridge: ${errorMsg}`);
    }
  }

  /**
   * Stop the Lua client
   */
  async stopClient(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    // Reserve the stopping slot SYNCHRONOUSLY (the starting slot lesson): the
    // quit handshake yields, and anything that races in must see the stop,
    // not a live client. A start already in flight gets joined first — the
    // bridge being spawned is then stopped, never orphaned.
    const pending = (async () => {
      if (this.starting) {
        await this.starting.catch(() => {});
      }
      if (this.client) {
        console.error('[Lua Bridge] Stopping client...');
        try {
          await this.client.stop();
        } catch (error) {
          console.error('[Lua Bridge] Error stopping client:', error);
        }
        this.client = null;
      }
    })();
    this.stopping = pending;
    try {
      await pending;
    } finally {
      if (this.stopping === pending) {
        this.stopping = null;
      }
    }
  }

  /**
   * Check if Lua bridge is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}
