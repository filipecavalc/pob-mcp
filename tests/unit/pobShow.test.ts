import { describe, it, expect, afterEach } from '@jest/globals';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { LuaClientManager } from '../../src/server/luaClientManager.js';
import { handlePobShow } from '../../src/handlers/targetHandlers.js';

/** Minimal stand-in for the desktop app's socket server, recording show_panel calls. */
async function fakeGui(onPanel: (params: any) => any) {
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    connections++;
    sockets.add(sock);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        const reply = (o: unknown) => sock.write(JSON.stringify(o) + '\n');
        if (req.action === 'hello') reply({ ok: true, hello: true });
        else if (req.action === 'show_panel') reply(onPanel(req.params));
        else if (req.action === 'gui_status') reply({ ok: true, status: { mode: 'BUILD' } });
        else reply({ ok: true, stats: {} });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pobshow-'));
  const tokenFile = path.join(dir, 'pob-mcp-token.txt');
  writeFileSync(tokenFile, 't');
  return {
    port: (server.address() as net.AddressInfo).port,
    tokenFile,
    connections: () => connections,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });

describe('pob_show', () => {
  it('sends title, text and focus over a short-lived connection while headless is the engine', async () => {
    const seen: any[] = [];
    const gui = await fakeGui((params) => { seen.push(params); return { ok: true, lines: 3, shown: true }; });
    open.push(gui);
    const manager = new LuaClientManager(true, { POB_GUI_TOKEN_FILE: gui.tokenFile, POB_MCP_PORT: String(gui.port) });
    const result = await handlePobShow({
      targetStatus: () => manager.targetStatus(),
      selectTarget: (t) => manager.selectTarget(t),
      showPanel: (title, text, focus) => manager.showPanel(title, text, focus),
    }, { title: 'Upgrades', text: 'a\nb\nc' });
    expect(seen).toEqual([{ title: 'Upgrades', text: 'a\nb\nc', focus: true }]);
    expect(result.content[0].text).toBe('Sent 3 lines to the MCP tab in Path of Building and opened the MCP tab.');
    expect(manager.getClient()).toBeNull(); // the engine was not started or switched
  });

  it('reuses the window connection when the window is the engine', async () => {
    const gui = await fakeGui(() => ({ ok: true, lines: 1, shown: false }));
    open.push(gui);
    const manager = new LuaClientManager(true, { POB_GUI_TOKEN_FILE: gui.tokenFile, POB_MCP_PORT: String(gui.port), POB_TARGET: 'gui' });
    await manager.ensureClient();
    const before = gui.connections();
    await manager.showPanel('T', 'x', false);
    expect(gui.connections()).toBe(before);
    await manager.stopClient();
  });

  it('requires text and a configured window', async () => {
    const manager = new LuaClientManager(true, {});
    const ctx = {
      targetStatus: () => manager.targetStatus(),
      selectTarget: (t: any) => manager.selectTarget(t),
      showPanel: (title: string, text: string, focus?: boolean) => manager.showPanel(title, text, focus),
    };
    await expect(handlePobShow(ctx, { text: '  ' })).rejects.toThrow(/text is required/);
    await expect(handlePobShow(ctx, { text: 'hi' })).rejects.toThrow(/not configured/);
  });

  it('passes the window\'s refusal through', async () => {
    const gui = await fakeGui(() => ({ ok: false, error: 'text too long (max 262144 bytes)' }));
    open.push(gui);
    const manager = new LuaClientManager(true, { POB_GUI_TOKEN_FILE: gui.tokenFile, POB_MCP_PORT: String(gui.port) });
    await expect(manager.showPanel('T', 'x')).rejects.toThrow(/text too long/);
  });
});
