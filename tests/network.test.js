import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

test('two real WebSocket clients and a spectator complete, rematch, pause and reconnect', { timeout: 18000 }, async () => {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const clients = [];
  try {
    const address = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Dev server exited ${code}: ${errors}`)));
      child.stdout.on('data', (data) => {
        const port = String(data).match(/localhost:(\d+)/)?.[1];
        if (port) resolve(`http://127.0.0.1:${port}`);
      });
    });
    const manifest = await fetch(`${address}/light-trails/playweft.json`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('access-control-allow-origin'), '*');
    assert.equal((await manifest.json()).modes.room.server.persistence, 'live');
    for (const path of ['/', '/light-trails/', '/light-trails/main.js', '/src/playweft-client.js', '/light-trails/styles.css', '/light-trails/game.lua', '/light-trails/help.html', '/__dev/', '/__dev/host.js']) {
      assert.equal((await fetch(`${address}${path}`)).status, 200, path);
    }
    function connect(seat) {
      const ws = new WebSocket(`${address.replace('http', 'ws')}/__dev/socket?seat=${seat}`);
      const client = { ws, snapshot: null, nextId: 0, waiting: new Map() };
      clients.push(client);
      ws.on('message', (data) => {
        const m = JSON.parse(String(data));
        if (m.type === 'state') client.snapshot = m.params;
        if (m.type === 'result') { client.waiting.get(m.id)?.(m); client.waiting.delete(m.id); }
      });
      client.action = (type, extra = {}) => new Promise((resolve) => {
        const id = String(++client.nextId);
        client.waiting.set(id, resolve);
        ws.send(JSON.stringify({ id, action: { type, round: client.snapshot.state.round, ...extra } }));
      });
      if (seat > 0) client.pulse = setInterval(() => {
        if (ws.readyState === 1 && client.snapshot && !['ended', 'closed'].includes(client.snapshot.state.phase) && client.waiting.size < 2) void client.action('pulse');
      }, 100);
      return client;
    }
    async function until(predicate, limit = 9000) {
      const end = Date.now() + limit;
      while (!predicate()) {
        if (Date.now() > end) throw new Error(`Timed out; server errors: ${errors}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const blue = connect(1), orange = connect(2), viewer = connect(0);
    await until(() => clients.every((c) => c.snapshot?.state.phase === 'countdown'));
    assert.equal((await viewer.action('turn', { direction: 1 })).result.error.code, 'SPECTATOR');
    await blue.action('turn', { direction: -1 });
    await orange.action('turn', { direction: 1 });
    await until(() => clients.every((c) => c.snapshot?.state.phase === 'ended'));
    assert.equal(blue.snapshot.state.winner, 2);
    assert.deepEqual(blue.snapshot.state.players.map((p) => p.trail), orange.snapshot.state.players.map((p) => p.trail));
    assert.equal(viewer.snapshot.version, blue.snapshot.version);
    await blue.action('rematch');
    assert.equal(blue.snapshot.state.phase, 'ended');
    await orange.action('rematch');
    await until(() => blue.snapshot.state.round === 2 && blue.snapshot.state.phase === 'countdown');
    assert.equal(blue.snapshot.state.players[1].score, 1);
    clearInterval(orange.pulse); orange.ws.close();
    await until(() => blue.snapshot.state.phase === 'paused', 4000);
    const rejoined = connect(2);
    await until(() => rejoined.snapshot?.state.phase === 'countdown' && blue.snapshot.state.phase === 'countdown');
    assert.equal(rejoined.snapshot.state.round, 2);
    assert.equal(errors, '');
  } finally {
    for (const client of clients) { clearInterval(client.pulse); client.ws.terminate(); }
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
});
