import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { GameSync } from '../games/light-trails/sync.js';
import { CollisionPlayback } from '../games/light-trails/collision-playback.js';

for (const impaired of [false, true]) test(`two real WebSocket clients and a spectator complete, rematch, pause and reconnect${impaired ? ' with 160–360 ms RTT and jitter' : ''}`, { timeout: 26000 }, async () => {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const clients = [], timers = new Set();
  function later(fn, delay) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, Math.max(0, delay));
    timers.add(timer);
  }
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
      const client = { ws, snapshot: null, nextId: 0, waiting: new Map(),
        sync:new GameSync(), ending:new CollisionPlayback(), rendered:[], arrivalAt:0, departureAt:0, packet:0 };
      client.sync.rtt = impaired ? 260 : 0;
      clients.push(client);
      ws.on('message', (data) => {
        const m = JSON.parse(String(data));
        const delay = impaired ? 80 + [0,100,30,70][client.packet++ % 4] : 0;
        // TCP preserves order but can deliver several delayed messages in a burst.
        client.arrivalAt = Math.max(client.arrivalAt, Date.now() + delay);
        later(() => {
          if (m.type === 'state') {
            client.snapshot = m.params;
            const now = performance.now(), state = m.params.state;
            client.ending.receive(state,client.rendered,now);
            client.sync.receive(state,seat-1,m.params.serverTime,now);
          }
          if (m.type === 'result') { client.waiting.get(m.id)?.(m); client.waiting.delete(m.id); }
        }, client.arrivalAt - Date.now());
      });
      client.action = (type, extra = {}) => new Promise((resolve) => {
        const id = String(++client.nextId);
        client.waiting.set(id, resolve);
        const message = JSON.stringify({ id, action: { type, round: client.snapshot.state.round, ...extra } });
        client.departureAt = Math.max(client.departureAt, Date.now() + (impaired ? 80 + [0,100,30,70][client.nextId % 4] : 0));
        later(() => { if (ws.readyState === 1) ws.send(message); }, client.departureAt - Date.now());
      });
      if (seat > 0) client.pulse = setInterval(() => {
        if (ws.readyState === 1 && client.snapshot && !['ended', 'closed'].includes(client.snapshot.state.phase) && client.waiting.size < 3) void client.action('pulse');
      }, 100);
      client.frames = setInterval(() => {
        if (!client.snapshot) return;
        const now = performance.now(), state = client.snapshot.state;
        const projected=client.sync.project(now);
        client.rendered = state.players.map((p,i) => client.ending.project(i,now) || projected?.[i] || p);
      }, 10);
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
    await until(() => viewer.snapshot.version === blue.snapshot.version);
    assert.deepEqual(blue.snapshot.state.players.map(p => p.impact),orange.snapshot.state.players.map(p => p.impact));
    await until(() => clients.every(c => !c.ending.pending(performance.now())));
    assert.ok(clients.every(c => c.rendered[0].crashed && c.rendered[0].impactPoint), 'each client displays confirmed impact before rematch');
    assert.deepEqual(blue.rendered[0].head,orange.rendered[0].head);
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
    await until(() => blue.snapshot.state.phase === 'playing' && rejoined.snapshot.state.phase === 'playing');
    // Exercise the actual prediction/input schedule during movement, not only a
    // countdown turn. Both remote and local views must settle on the accepted move.
    const inputs = [blue.sync.enqueue(3,performance.now()),rejoined.sync.enqueue(1,performance.now())];
    assert.ok(inputs.every(Boolean));
    const replies = await Promise.all([blue.action('steer',inputs[0]),rejoined.action('steer',inputs[1])]);
    assert.ok(replies.every(r => r.result.accepted));
    await until(() => blue.snapshot.state.players[0].appliedSeq === inputs[0].seq && rejoined.snapshot.state.players[1].appliedSeq === inputs[1].seq);
    assert.equal(blue.snapshot.state.players[0].dir,3);
    assert.equal(rejoined.snapshot.state.players[1].dir,1);
    assert.equal(blue.sync.pending.length,0);
    assert.equal(rejoined.sync.pending.length,0);
    assert.equal(errors, '');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const client of clients) { clearInterval(client.pulse); clearInterval(client.frames); client.ws.terminate(); }
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
});
