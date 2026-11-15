import { describe, it, expect, afterEach } from '@jest/globals';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { PoBGuiApiClient } from '../../src/pobGuiClient.js';
import { guiTargetConfig, LuaClientManager } from '../../src/server/luaClientManager.js';
import { describeTargetStatus } from '../../src/handlers/targetHandlers.js';

type Behaviour = (req: any, reply: (obj: unknown) => void, sock: net.Socket) => void;

/** A stand-in for the desktop app's socket server. */
async function fakeGui(token: string, behaviour: Behaviour) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = '';
    let authed = false;
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const req = JSON.parse(line);
        const reply = (obj: unknown) => sock.write(JSON.stringify(obj) + '\n');
        if (!authed) {
          if (req.action === 'hello' && req.token === token) { authed = true; reply({ ok: true, hello: true }); }
          else { reply({ ok: false, error: 'bad token' }); sock.end(); }
          continue;
        }
        behaviour(req, reply, sock);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pobgui-'));
  const tokenFile = path.join(dir, 'pob-mcp-token.txt');
  writeFileSync(tokenFile, token + '\n');
  return {
    port, tokenFile,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); });

describe('PoBGuiApiClient', () => {
  it('says hello with the token and runs bridge actions over the socket', async () => {
    const gui = await fakeGui('t0k', (req, reply) => {
      if (req.action === 'get_stats') reply({ ok: true, stats: { Life: 5447, fields: req.params.fields } });
      else if (req.action === 'gui_status') reply({ ok: true, status: { mode: 'BUILD' } });
      else reply({ ok: false, error: 'unknown' });
    });
    servers.push(gui);
    const client = new PoBGuiApiClient({ tokenFile: gui.tokenFile, port: gui.port });
    await client.start();
    expect(client.isAlive()).toBe(true);
    const stats = await client.getStats(['Life']);
    expect(stats.Life).toBe(5447);
    expect(await client.guiStatus()).toEqual({ mode: 'BUILD' });
    await client.stop();
    expect(client.isAlive()).toBe(false);
  });

  it('serialises concurrent requests so replies match their requests', async () => {
    const gui = await fakeGui('t', (req, reply) => {
      setTimeout(() => reply({ ok: true, stats: { Id: req.params.fields[0] } }), req.params.fields[0] === 'slow' ? 50 : 0);
    });
    servers.push(gui);
    const client = new PoBGuiApiClient({ tokenFile: gui.tokenFile, port: gui.port });
    await client.start();
    const [a, b] = await Promise.all([client.getStats(['slow']), client.getStats(['fast'])]);
    expect([a.Id, b.Id]).toEqual(['slow', 'fast']);
    await client.stop();
  });

  it('refuses to start when the token is wrong', async () => {
    const gui = await fakeGui('right', () => {});
    servers.push(gui);
    writeFileSync(gui.tokenFile, 'wrong');
    const client = new PoBGuiApiClient({ tokenFile: gui.tokenFile, port: gui.port });
    await expect(client.start()).rejects.toThrow(/refused the connection: bad token/);
    expect(client.isAlive()).toBe(false);
  });

  it('reports a missing token file clearly', async () => {
    const client = new PoBGuiApiClient({ tokenFile: path.join(os.tmpdir(), 'no-such-dir-xyz', 'pob-mcp-token.txt'), port: 1 });
    await expect(client.start()).rejects.toThrow(/token not found/);
  });

  it('times out like a minimised window, drops the connection and explains', async () => {
    const gui = await fakeGui('t', () => { /* never answers */ });
    servers.push(gui);
    const client = new PoBGuiApiClient({ tokenFile: gui.tokenFile, port: gui.port, timeoutMs: 200 });
    await client.start();
    await expect(client.getStats(['Life'])).rejects.toThrow(/did not answer "get_stats".*minimised/);
    expect(client.isAlive()).toBe(false);
    await expect(client.getStats(['Life'])).rejects.toThrow(/not connected/);
  });

  it('notices the window closing', async () => {
    const gui = await fakeGui('t', (_req, _reply, sock) => sock.destroy());
    servers.push(gui);
    const client = new PoBGuiApiClient({ tokenFile: gui.tokenFile, port: gui.port });
    await client.start();
    await expect(client.getStats(['Life'])).rejects.toThrow(/closed the connection|connection error/);
    expect(client.isAlive()).toBe(false);
  });

  it('drops the connection on a malformed reply', async () => {
    const gui = await fakeGui('t', (_req, _reply, sock) => sock.write('not json\n'));
    servers.push(gui);
    const client = new PoBGuiApiClient({ tokenFile: gui.tokenFile, port: gui.port });
    await client.start();
    await expect(client.getStats(['Life'])).rejects.toThrow(/malformed reply/);
    expect(client.isAlive()).toBe(false);
  });
});

describe('PoBGuiApiClient.saveBuild', () => {
  it('replaces a file only when it is the one open in the window', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pobsave-'));
    const openFile = path.join(dir, 'Open.xml');
    const otherFile = path.join(dir, 'Other.xml');
    writeFileSync(openFile, 'old open');
    writeFileSync(otherFile, 'old other');
    const gui = await fakeGui('t', (req, reply) => {
      if (req.action === 'gui_status') reply({ ok: true, status: { mode: 'BUILD', build: { name: 'Open', file: openFile } } });
      else if (req.action === 'save_build') { writeFileSync(req.params.path, '<PathOfBuilding/>'); reply({ ok: true, result: { path: req.params.path } }); }
    });
    servers.push(gui);
    const client = new PoBGuiApiClient({ tokenFile: gui.tokenFile, port: gui.port });
    await client.start();
    expect(client.getLoadedFilePath()).toBeUndefined();
    await expect(client.saveBuild(openFile)).resolves.toMatchObject({ size: 17 });
    expect(readFileSync(openFile, 'utf8')).toBe('<PathOfBuilding/>');
    await expect(client.saveBuild(otherFile)).rejects.toThrow(/not the build open in the Path of Building window/);
    expect(readFileSync(otherFile, 'utf8')).toBe('old other');
    await expect(client.saveBuild(otherFile, true)).resolves.toBeTruthy();
    await client.stop();
  });
});

describe('engine selection', () => {
  it('keeps the headless engine as the default even when the window is configured', async () => {
    const manager = new LuaClientManager(true, { POB_GUI_PATH: 'C:/PoB-gui' });
    expect((await manager.targetStatus()).preferred).toBe('headless');
  });

  it('does not restart when the requested engine is already in use', async () => {
    const gui = await fakeGui('t', (req, reply) => {
      if (req.action === 'gui_status') reply({ ok: true, status: { mode: 'BUILD' } });
    });
    servers.push(gui);
    const manager = new LuaClientManager(true, { POB_GUI_TOKEN_FILE: gui.tokenFile, POB_MCP_PORT: String(gui.port), POB_TARGET: 'gui' });
    await manager.ensureClient();
    const before = manager.getClient();
    const status = await manager.selectTarget('gui');
    expect(manager.getClient()).toBe(before);
    expect(status.active).toBe('gui');
    await manager.stopClient();
  });

  it('after losing the window under auto, retries the window instead of switching to headless', async () => {
    const gui = await fakeGui('t', (req, reply) => reply({ ok: true, stats: {} }));
    const manager = new LuaClientManager(true, { POB_GUI_TOKEN_FILE: gui.tokenFile, POB_MCP_PORT: String(gui.port), POB_TARGET: 'auto' });
    await manager.ensureClient();
    expect((await manager.targetStatus()).active).toBe('gui');
    await gui.close(); // window closed
    await expect(manager.getClient()!.getStats(['Life'])).rejects.toThrow();
    await expect(manager.ensureClient()).rejects.toThrow(/Failed to reach Path of Building desktop/);
  });

  it('stays headless-only when the desktop target is not configured', async () => {
    expect(guiTargetConfig({})).toBeNull();
    const manager = new LuaClientManager(true, { POB_TARGET: 'gui' });
    const status = await manager.targetStatus();
    expect(status).toEqual({ preferred: 'headless', active: null, guiConfigured: false });
    await expect(manager.selectTarget('gui')).rejects.toThrow(/not configured/);
  });

  it('derives the token path from POB_GUI_PATH and reads port and timeout', () => {
    expect(guiTargetConfig({ POB_GUI_PATH: 'C:/PoB-gui', POB_MCP_PORT: '5000', POB_GUI_TIMEOUT_MS: '9000' }))
      .toEqual({ tokenFile: path.join('C:/PoB-gui', 'src', 'pob-mcp-token.txt'), port: 5000, timeoutMs: 9000 });
  });

  it('uses the window when it answers (gui preference) and reports its status', async () => {
    const gui = await fakeGui('t', (req, reply) => {
      if (req.action === 'gui_status') reply({ ok: true, status: { mode: 'BUILD', version: '2.67.2', devMode: true, build: { name: 'RF atual', file: 'C:/b/RF atual.xml', unsaved: true, unsavedIn: ['configTab'] } } });
    });
    servers.push(gui);
    const manager = new LuaClientManager(true, { POB_GUI_TOKEN_FILE: gui.tokenFile, POB_MCP_PORT: String(gui.port), POB_TARGET: 'gui' });
    await manager.ensureClient();
    const status = await manager.targetStatus();
    expect(status.active).toBe('gui');
    expect(status.guiReachable).toBe(true);
    const text = describeTargetStatus(status);
    expect(text).toMatch(/Engine in use: Path of Building window/);
    expect(text).toMatch(/Open build: RF atual — C:\/b\/RF atual\.xml/);
    expect(text).toMatch(/Unsaved changes: yes \(configTab\)/);
    await manager.stopClient();
  });

  it('with gui preference, fails instead of falling back when the window is unreachable', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pobgui-'));
    const tokenFile = path.join(dir, 'pob-mcp-token.txt');
    writeFileSync(tokenFile, 'x');
    const manager = new LuaClientManager(true, { POB_GUI_TOKEN_FILE: tokenFile, POB_MCP_PORT: '1', POB_TARGET: 'gui' });
    await expect(manager.ensureClient()).rejects.toThrow(/Failed to reach Path of Building desktop/);
  });

  it('says loudly when the window connection is lost mid-session', async () => {
    let answer = true;
    const gui = await fakeGui('t', (req, reply) => { if (answer) reply({ ok: true, stats: {} }); });
    servers.push(gui);
    const manager = new LuaClientManager(true, { POB_GUI_TOKEN_FILE: gui.tokenFile, POB_MCP_PORT: String(gui.port), POB_TARGET: 'gui', POB_GUI_TIMEOUT_MS: '200' });
    await manager.ensureClient();
    answer = false;
    await expect(manager.getClient()!.getStats(['Life'])).rejects.toThrow(/did not answer/);
    answer = true;
    await expect(manager.ensureClient()).rejects.toThrow(/connection to the Path of Building window was lost.*Now using the gui engine again/);
    await manager.stopClient();
  });
});
