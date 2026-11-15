/**
 * Client for the Path of Building desktop app's local socket server
 * (pob-gui/src/Modules/McpServer.lua). It speaks the same JSON-lines actions
 * as the headless stdio bridge, so it subclasses PoBLuaApiClient and swaps
 * only the transport: every tool works unchanged against the build open in
 * the window.
 *
 * The connection opens with { action: "hello", token }, the token the app
 * writes to its user folder at start. Requests are serialised. PoB runs no
 * frames while its window is minimised, so a request then gets no answer; on
 * timeout the connection is dropped (a late reply would answer the next
 * request) and the client reports itself dead.
 */
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { PoBLuaApiClient, type LuaRequest, type LuaResponse, type SavedBuild } from "./pobLuaBridge.js";
import { atomicWriteFile } from "./utils/atomicWrite.js";

const samePath = (a: string, b: string) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);

export interface PoBGuiClientOptions {
  /** Path of pob-mcp-token.txt in the PoB user folder (the checkout's src/ in Dev Mode). */
  tokenFile: string;
  host?: string;
  port?: number;
  /** Connect plus hello. */
  connectTimeoutMs?: number;
  /** Per request. */
  timeoutMs?: number;
}

export const DEFAULT_GUI_PORT = 49280;

export class PoBGuiApiClient extends PoBLuaApiClient {
  readonly target = "gui" as const;
  private readonly gui: Required<PoBGuiClientOptions>;
  private sock: net.Socket | null = null;
  private inbox = "";
  private alive = false;
  private waiter: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PoBGuiClientOptions) {
    super({});
    this.gui = {
      host: "127.0.0.1",
      port: DEFAULT_GUI_PORT,
      connectTimeoutMs: 1500,
      timeoutMs: 30000,
      ...options,
    };
  }

  override isAlive(): boolean {
    return this.alive;
  }

  override async start(): Promise<void> {
    this.drop();
    let token: string;
    try {
      token = (await readFile(this.gui.tokenFile, "utf8")).trim();
    } catch {
      throw new Error(`Path of Building desktop token not found at ${this.gui.tokenFile} (is the PoB window with the MCP server running?)`);
    }
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(this.gui.port, this.gui.host);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Path of Building desktop did not accept a connection on ${this.gui.host}:${this.gui.port} within ${this.gui.connectTimeoutMs} ms`));
      }, this.gui.connectTimeoutMs);
      sock.once("connect", () => { clearTimeout(timer); this.attach(sock); resolve(); });
      sock.once("error", (err) => { clearTimeout(timer); reject(new Error(`Path of Building desktop is not reachable: ${err.message}`)); });
    });
    this.alive = true;
    const hello = await this.exchange({ action: "hello", token } as unknown as LuaRequest, this.gui.connectTimeoutMs);
    if (!hello.ok) {
      this.drop();
      throw new Error(`Path of Building desktop refused the connection: ${hello.error ?? "unknown error"}`);
    }
  }

  override async stop(): Promise<void> {
    // Close the connection only: the window belongs to the user.
    this.drop();
  }

  /**
   * The user can open another build in the window at any time, so the file
   * this client last loaded says nothing about what is open now; report none,
   * and callers reload what they need.
   */
  override getLoadedFilePath(): string | undefined {
    return undefined;
  }

  /**
   * Same as the stdio client's save, except that replacing an existing file
   * without `overwrite` is allowed only when it is the file open in the window
   * right now, never the file this client happened to load earlier.
   */
  override async saveBuild(filePath: string, overwrite = false): Promise<SavedBuild> {
    const destination = path.resolve(filePath);
    let mayReplace = overwrite;
    if (!mayReplace) {
      const open = (await this.guiStatus()).build as { file?: unknown } | undefined;
      mayReplace = typeof open?.file === "string" && samePath(open.file, destination);
    }
    const temporary = path.join(path.dirname(destination), `.pob-save-${randomUUID()}.tmp`);
    try {
      const res = await this.send({ action: "save_build", params: { path: temporary } });
      if (!res.ok) throw new Error(res.error || "save_build failed");
      const xml = await readFile(temporary, "utf8");
      await atomicWriteFile(destination, xml, mayReplace);
      return { path: destination, size: xml.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite existing build "${destination}": it is not the build open in the Path of Building window. Pass overwrite: true to replace it, or choose a new name.`);
      }
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** Screen, open build, file, unsaved tabs, dialog state (gui_status action). */
  async guiStatus(): Promise<Record<string, unknown>> {
    const res = await this.send({ action: "gui_status" });
    if (!res.ok) throw new Error(res.error || "gui_status failed");
    return res.status as Record<string, unknown>;
  }

  /** Open a saved build file in the window as PoB's build list does (open_build action). */
  async openBuild(filePath: string, force = false): Promise<Record<string, unknown>> {
    const res = await this.send({ action: "open_build", params: { path: filePath, force } });
    if (!res.ok) throw new Error(res.error || "open_build failed");
    return res.status as Record<string, unknown>;
  }

  protected override send(obj: LuaRequest): Promise<LuaResponse> {
    const run = this.queue.then(() => this.exchange(obj, this.gui.timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.inbox = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.inbox += chunk;
      this.deliver();
    });
    const lost = (reason: string) => {
      if (this.sock !== sock) return; // an older connection closing late
      this.alive = false;
      this.sock = null;
      this.waiter?.reject(new Error(reason));
      this.waiter = null;
    };
    sock.on("close", () => lost("Path of Building desktop closed the connection (window closed or server stopped)"));
    sock.on("error", (err) => lost(`Path of Building desktop connection error: ${err.message}`));
  }

  private deliver(): void {
    const idx = this.inbox.indexOf("\n");
    if (idx < 0 || !this.waiter) return;
    const line = this.inbox.slice(0, idx);
    this.inbox = this.inbox.slice(idx + 1);
    const waiter = this.waiter;
    this.waiter = null;
    waiter.resolve(line);
  }

  private drop(): void {
    this.alive = false;
    const sock = this.sock;
    this.sock = null;
    if (sock) sock.destroy();
  }

  private exchange(obj: LuaRequest, timeoutMs: number): Promise<LuaResponse> {
    if (!this.alive || !this.sock) {
      return Promise.reject(new Error("Path of Building desktop is not connected"));
    }
    const sock = this.sock;
    return new Promise<LuaResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.drop();
        reject(new Error(
          `Path of Building desktop did not answer "${obj.action}" within ${Math.round(timeoutMs / 1000)} s. ` +
          "Either its window is minimised (PoB stops processing then: restore it and retry; a queued request " +
          "that expired is dropped, not run) or the action ran longer than POB_GUI_TIMEOUT_MS, in which case it " +
          "may still complete in the window. Check pob_target before retrying, or switch to the headless engine.",
        ));
      }, timeoutMs);
      this.waiter = {
        resolve: (line) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(line) as LuaResponse);
          } catch {
            this.drop();
            reject(new Error("Path of Building desktop sent a malformed reply; connection dropped"));
          }
        },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      // The deadline lets the app drop a request it reaches too late (window
      // restored after we gave up), so a change reported as failed never runs.
      sock.write(JSON.stringify({ ...obj, deadline: Date.now() + timeoutMs }) + "\n");
      this.deliver();
    });
  }
}
