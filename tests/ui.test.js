import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { GameSync } from '../games/light-trails/sync.js';
import { CollisionPlayback } from '../games/light-trails/collision-playback.js';

// Exercise the shipped client with room snapshots, without a browser or a network.
// Missing HTML IDs and broken render/input paths fail just as they do in the page.
async function mount({ standalone = false, deferred = false } = {}) {
  const html = await readFile(new URL('../games/light-trails/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const classes = new Set();
    return [id, {
      textContent: '', hidden: /\bhidden\b/.test(tag), disabled: /\bdisabled\b/.test(tag),
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c), contains: c => classes.has(c) },
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    }];
  }));
  let onFrame, bridge, onPulse, now = 1000;
  const actions = [], replies = [];
  class Bridge extends EventTarget {
    context = { playerId: 'blue' };
    constructor() { super(); bridge = this; }
    async action(action) { actions.push(action); if (deferred) return new Promise(resolve => replies.push(resolve)); return { accepted: true }; }
  }
  const canvas = elements.get('board');
  canvas.getBoundingClientRect = () => ({ width: 480, height: 270 });
  canvas.getContext = () => new Proxy({}, { get: (target, prop) => target[prop] ?? (() => {}) });
  const scope = {
    PlayweftBridge: Bridge, GameSync, CollisionPlayback,
    document: { hidden: false, getElementById: id => elements.get(id), documentElement: { style: { setProperty() {} } } },
    window: { parent: {}, addEventListener() {} },
    matchMedia: () => ({ matches: true }), performance: { now: () => now },
    devicePixelRatio: 1, ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } },
    setInterval(fn) { onPulse = fn; }, setTimeout() {}, requestAnimationFrame(fn) { onFrame = fn; },
  };
  if (standalone) scope.window.parent = scope.window;
  scope.URL = URL;
  scope.location = { href: 'https://games.example/light-trails/' };
  const script = (await readFile(new URL('../games/light-trails/main.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/gm, '');
  vm.runInNewContext(script, scope);
  function snapshot(phase, extra = {}) {
    const state = { width: 48, height: 27, stepMs: 180, tick: 333, lastStepAt: 60000, sealedUntil:60240, startsAt: 0, round: 2, phase,
      players: [
        { id: 'blue', name: '蓝方', score: 2, x: 16, y: 8, dir: 0, trail: [401, 402], rematch: false },
        { id: 'orange', name: '橙方', score: 1, x: 31, y: 16, dir: 2, trail: [800, 799], rematch: false },
      ], ...(phase === 'countdown' ? {startsAt:63000} : {}), ...extra };
    const event = new Event('state');
    event.detail = { state, serverTime: 60000 };
    bridge.dispatchEvent(event); onFrame(); return state;
  }
  return { elements, bridge, actions, replies, snapshot, pulse: () => onPulse(), frame: (elapsed = 0) => { now += elapsed; onFrame(); } };
}

test('landscape UI handles play, pause, results and rematch without losing its controls', async () => {
  const ui = await mount();
  const el = id => ui.elements.get(id);
  ui.snapshot('playing');
  assert.equal(el('overlay').hidden, true);
  assert.equal(el('left').disabled, false);
  assert.equal(el('player-1').classList.contains('is-you'), true);
  assert.equal(el('elapsed').textContent, '00:59');
  await el('up').listeners.pointerdown({ button: 0, preventDefault() {} });
  assert.equal(ui.actions.at(-1).heading, 3);
  ui.snapshot('paused');
  assert.equal(el('overlay').hidden, false);
  assert.equal(el('left').disabled, true);
  ui.snapshot('ended', { winner: 1 });
  assert.equal(el('overlay-title').textContent, '胜利');
  assert.equal(el('replay').hidden, false);
  await el('replay').listeners.click();
  assert.equal(ui.actions.at(-1).type, 'rematch');
  const state = ui.snapshot('ended', { winner: 1 });
  state.players[0].rematch = true;
  ui.snapshot('ended', state);
  assert.equal(el('replay-label').textContent, '等待对手');
  assert.equal(el('replay').disabled, true);
  ui.snapshot('countdown');
  assert.equal(el('overlay-title').textContent, '3');
  assert.equal(el('replay').hidden, true);
  assert.equal(el('left').disabled, false);
});

test('spectators see the arena and result but cannot turn or rematch', async () => {
  const ui = await mount();
  ui.bridge.context.playerId = 'spectator';
  ui.snapshot('playing');
  assert.equal(ui.elements.get('controls').hidden, true);
  assert.equal(ui.elements.get('spectator').hidden, false);
  ui.snapshot('ended', { winner: 2 });
  assert.equal(ui.elements.get('overlay-title').textContent, '橙方获胜');
  assert.equal(ui.elements.get('replay').hidden, true);
  assert.equal(ui.actions.length, 0);
});


test('standalone title screen shows a launch menu without inactive match controls', async () => {
  const ui = await mount({ standalone: true });
  ui.frame();
  const el = id => ui.elements.get(id);
  assert.equal(el('overlay-title').textContent, '光尾蛇');
  assert.equal(el('game').classList.contains('title-screen'), true);
  assert.equal(el('match-hud').hidden, true);
  assert.equal(el('controls').hidden, true);
  assert.equal(el('launch').hidden, false);
  assert.equal(el('help').hidden, false);
  assert.equal(new URL(el('launch').href).searchParams.get('game'), 'https://games.example/light-trails/playweft.json');
  ui.snapshot('playing');
  assert.equal(el('game').classList.contains('title-screen'), false);
  assert.equal(el('match-hud').hidden, false);
  assert.equal(el('launch').hidden, true);
  assert.equal(el('help').hidden, true);
});


test('D-pad accepts consecutive turns without waiting for network replies, with bounded concurrency', async () => {
  const ui = await mount({ deferred: true });
  ui.snapshot('playing');
  for (const id of ['up', 'left', 'down', 'right', 'up']) {
    ui.elements.get(id).listeners.pointerdown({ button: 0, preventDefault() {} });
  }
  assert.deepEqual(ui.actions.map(a => a.heading), [3, 2, 1, 0]);
  assert.deepEqual(ui.actions.map(a => a.seq), [1, 2, 3, 4]);
  ui.replies[0]({ accepted: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.actions.length, 5);
  assert.equal(ui.actions[4].heading, 3);
  ui.snapshot('paused');
  ui.elements.get('down').listeners.pointerdown({ button: 0, preventDefault() {} });
  assert.equal(ui.actions.length, 5);
  for (const resolve of ui.replies) resolve({ accepted: true });
});


test('heartbeats keep a bounded pipeline during delayed replies and reserve room for steering', async () => {
  const ui = await mount({deferred:true});
  ui.snapshot('playing');
  const pulses = Array.from({length:8}, () => ui.pulse());
  assert.equal(ui.actions.length, 3);
  assert.ok(ui.actions.every(a => a.type === 'pulse'));
  for (const id of ['up', 'left', 'down', 'right']) {
    ui.elements.get(id).listeners.pointerdown({button:0,preventDefault() {}});
  }
  assert.equal(ui.actions.length, 7);
  assert.equal(ui.actions.filter(a => a.type === 'steer').length, 4);
  ui.replies[0]({accepted:true});
  await new Promise(resolve => setImmediate(resolve));
  pulses.push(ui.pulse());
  assert.equal(ui.actions.length, 8, 'a freed pulse slot is used at the next cadence');
  for (const resolve of ui.replies) resolve({accepted:true});
  await Promise.all(pulses);
});

test('collision approach and hold finish before scores/results; duplicates cannot postpone them', async () => {
  const ui = await mount();
  const el = id => ui.elements.get(id);
  const playing = ui.snapshot('playing');
  const ended = structuredClone(playing);
  ended.tick++; ended.reason = 'collision'; ended.winner = 2;
  ended.players[1].score++;
  Object.assign(ended.players[0], {crashed:true, impact:{tick:ended.tick,at:60120,fromX:17,fromY:8,x:18,y:8,kind:'trail',owner:2}});
  ui.snapshot('ended', {...ended,phase:'ended'});
  assert.equal(el('overlay').hidden, true);
  assert.equal(el('replay').hidden, true);
  assert.equal(el('score-2').textContent, '1');
  assert.equal(el('up').disabled, true);
  await el('replay').listeners.click();
  assert.equal(ui.actions.length, 0, 'cannot rematch during impact presentation');
  ui.frame(100);
  ui.snapshot('ended', {...ended,phase:'ended'});
  ui.frame(401);
  assert.equal(el('overlay').hidden, false);
  assert.equal(el('overlay-title').textContent, '失败');
  assert.equal(el('score-2').textContent, '2');
  assert.equal(el('replay').hidden, false);
  ui.snapshot('countdown', {round:3});
  assert.equal(el('overlay-title').textContent, '3');
});

test('buffer starvation never covers the board or drops turn inputs; only prolonged jitter gets a corner notice', async () => {
  const ui=await mount();
  ui.snapshot('playing');
  for(let i=0;i<60;i++)ui.frame(10);
  assert.equal(ui.elements.get('overlay').hidden,true);
  assert.equal(ui.elements.get('connection').hidden,true,'short jitter stays quiet');
  assert.equal(ui.elements.get('up').disabled,false);
  ui.elements.get('up').listeners.pointerdown({button:0,preventDefault(){}});
  assert.equal(ui.actions.length,1);
  assert.equal(ui.actions[0].heading,3,'a press during buffer starvation still reaches the server');
  for(let i=0;i<50;i++)ui.frame(10);
  assert.equal(ui.elements.get('overlay').hidden,true);
  assert.equal(ui.elements.get('connection').hidden,false);
  assert.equal(ui.elements.get('connection').textContent,'网络波动');
  ui.snapshot('playing',{sealedUntil:62000});
  ui.frame(10);
  assert.equal(ui.elements.get('connection').hidden,true);
  assert.equal(ui.elements.get('up').disabled,false);
  for(let i=0;i<200;i++)ui.frame(10);
  assert.equal(ui.elements.get('overlay').hidden,true,'even a stale connection leaves the board visible');
  assert.equal(ui.elements.get('connection').textContent,'连接中断');
});
