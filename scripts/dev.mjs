import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRuntime } from './lua-runtime.mjs';

// Explicit development-only bridge harness. Not included in dist/.
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const runtime = await createRuntime();
let state, version = 0, match = 0;
let tail = Promise.resolve();
const enqueue = (fn) => { const result = tail.then(fn); tail = result.catch(console.error); return result; };
const players = [{ id: 'dev-blue', name: '蓝方', seat: 1 }, { id: 'dev-orange', name: '橙方', seat: 2 }];
async function reset() {
  match++; version = 0;
  state = (await runtime.call('setup', { serverTime: Date.now(), match: { startedAt: Date.now() }, players })).state;
}
await reset();
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.lua': 'text/plain' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (url.pathname === '/__dev/reset' && req.method === 'POST') {
      await enqueue(async () => { await reset(); await broadcast(); });
      res.writeHead(204); res.end(); return;
    }
    let path;
    if (url.pathname === '/__dev/' || url.pathname === '/__dev') path = new URL('./dev-host.html', import.meta.url);
    else if (url.pathname === '/__dev/host.js') path = new URL('./dev-host.js', import.meta.url);
    else {
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';
      else if (pathname === '/light-trails' || pathname === '/light-trails/') pathname = '/games/light-trails/index.html';
      else if (pathname.startsWith('/light-trails/')) pathname = '/games' + pathname;
      else if (pathname === '/light-trails.svg') pathname = '/public/light-trails.svg';
      else if (pathname === '/featured-games.json') pathname = '/public/featured-games.json';
      if (!['/index.html', '/games/', '/src/', '/public/'].some(prefix => pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) throw new Error('Invalid path');
      path = resolve(root, '.' + pathname);
      if (!path.startsWith(root + sep)) throw new Error('Invalid path');
    }
    const body = await readFile(path);
    res.setHeader('Content-Type', `${mime[extname(String(path))] || 'application/octet-stream'}; charset=utf-8`);
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
const sockets = new WebSocketServer({ server, path: '/__dev/socket' });
async function snapshot(ws) {
  if (ws.readyState !== 1) return;
  const result = await runtime.call('view', state, {}, { viewer: ws.actor, serverTime: Date.now() });
  ws.send(JSON.stringify({ type: 'state', params: { phase: 'playing', state: result.state, events: [], matchId: `dev-${match}`, version, serverTime: Date.now() } }));
}
async function broadcast() { for (const ws of sockets.clients) await snapshot(ws); }
sockets.on('connection', (ws, req) => {
  const seat = new URL(req.url, 'http://localhost').searchParams.get('seat');
  ws.actor = seat === '1' ? { ...players[0], role: 'player' } : seat === '2' ? { ...players[1], role: 'player' } : { id: 'dev-spectator', role: 'spectator' };
  ws.send(JSON.stringify({ type: 'identity', playerId: ws.actor.id }));
  enqueue(() => snapshot(ws));
  ws.on('message', (data) => {
    const actionAt = Date.now();
    enqueue(async () => {
      let message;
      try {
        message = JSON.parse(String(data));
        const result = await runtime.call('on_action', state, message.action, { actor: ws.actor, actionAt, serverTime: Date.now() });
        if (result.accepted) { state = result.state; version++; await broadcast(); }
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'result', id: message.id, result: { accepted: result.accepted, error: result.error } }));
      } catch (error) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'result', id: message?.id, error: { code: -32603, message: error.message } }));
      }
    });
  });
});
const port = Number(process.env.PORT || 9139);
server.listen(port, '0.0.0.0', () => console.log(`Light Trails: http://localhost:${server.address().port}/__dev/?seat=1 and ?seat=2. Manifest: /light-trails/playweft.json`));
