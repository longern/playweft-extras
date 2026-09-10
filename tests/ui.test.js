import { displayPath } from '../games/light-trails/render-path.js';
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
  const draws = [];
  let path = [];
  const context = {
    beginPath() { path = []; }, moveTo(x,y) { path.push({x,y}); }, lineTo(x,y) { path.push({x,y}); },
    stroke() { draws.push({type:'stroke',color:this.strokeStyle,path:[...path]}); },
    fillRect(x,y,w,h) { if(this.shadowBlur>0) draws.push({type:'head',x:x+w/2,y:y+h/2}); },
  };
  const canvas = elements.get('board');
  canvas.getBoundingClientRect = () => ({ width: 480, height: 270 });
  canvas.getContext = () => new Proxy(context, { get: (target, prop) => target[prop] ?? (() => {}) });
  const scope = {
    PlayweftBridge: Bridge, GameSync, CollisionPlayback, displayPath,
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
    const state = { width: 48, height: 27, stepMs: 180, tick: 333, lastStepAt: 60000, startsAt: 0, round: 2, phase,
      players: [
        { id: 'blue', name: '蓝方', score: 2, x: 16, y: 8, dir: 0, trail: [401, 402], rematch: false },
        { id: 'orange', name: '橙方', score: 1, x: 31, y: 16, dir: 2, trail: [800, 799], rematch: false },
      ], ...(phase === 'countdown' ? {startsAt:63000} : {}), ...extra };
    const event = new Event('state');
    event.detail = { state, serverTime: 60000 };
    bridge.dispatchEvent(event); onFrame(); return state;
  }
  return { elements, bridge, actions, replies, draws, snapshot, pulse: () => onPulse(), frame: (elapsed = 0) => { now += elapsed; onFrame(); } };
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

test('platform latency is shown in the viewport corner', async () => {
  const ui = await mount();
  const latency = ui.elements.get('latency');
  assert.equal(latency.hidden, true);
  const event = new Event('latency');
  event.detail = { rttMs: 42.4 };
  ui.bridge.dispatchEvent(event);
  assert.equal(latency.hidden, false);
  assert.equal(latency.textContent, '延迟 42 ms');
  const invalid = new Event('latency');
  invalid.detail = { rttMs: -1 };
  ui.bridge.dispatchEvent(invalid);
  assert.equal(latency.textContent, '延迟 42 ms');
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


test('D-pad responds before replies and bounds the pending turn queue to two', async () => {
  const ui = await mount({ deferred: true });
  ui.snapshot('playing');
  for (const id of ['up', 'left', 'down', 'right', 'up']) {
    ui.elements.get(id).listeners.pointerdown({ button: 0, preventDefault() {} });
  }
  assert.deepEqual(ui.actions.map(a => a.heading), [3, 2]);
  assert.deepEqual(ui.actions.map(a => a.seq), [1, 2]);
  ui.replies[0]({ accepted: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.actions.length, 2, 'transport reply alone does not free the unexecuted turn queue');
  ui.snapshot('paused');
  ui.elements.get('down').listeners.pointerdown({ button: 0, preventDefault() {} });
  assert.equal(ui.actions.length, 2);
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
  assert.equal(ui.actions.length, 5);
  assert.equal(ui.actions.filter(a => a.type === 'steer').length, 2);
  ui.replies[0]({accepted:true});
  await new Promise(resolve => setImmediate(resolve));
  pulses.push(ui.pulse());
  assert.equal(ui.actions.length, 6, 'a freed pulse slot is used at the next cadence');
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
  ui.snapshot('playing',{lastStepAt:61080,tick:339});
  ui.frame(10);
  assert.equal(ui.elements.get('connection').hidden,true);
  assert.equal(ui.elements.get('up').disabled,false);
  for(let i=0;i<200;i++)ui.frame(10);
  assert.equal(ui.elements.get('overlay').hidden,true,'even a stale connection leaves the board visible');
  assert.equal(ui.elements.get('connection').textContent,'连接中断');
});


test('canvas draws one body per snake, ending at its buffered head with no solid trail ahead', async () => {
  const ui=await mount();ui.snapshot('playing');
  for(let i=0;i<20;i++){
    ui.draws.length=0;ui.frame(10);
    const bodies=ui.draws.filter(d=>d.type==='stroke' && ['#78e9e4','#ff9b7e'].includes(d.color));
    const heads=ui.draws.filter(d=>d.type==='head');
    assert.equal(bodies.length,2,'no extra authoritative body over the buffered body');
    assert.equal(heads.length,2);
    bodies.forEach((body,index)=>{
      const end=body.path.at(-1),head=heads[index];
      assert.ok(Math.abs(end.x-head.x)<1e-8 && Math.abs(end.y-head.y)<1e-8);
      for(let j=1;j<body.path.length;j++)assert.ok(body.path[j].x===body.path[j-1].x || body.path[j].y===body.path[j-1].y);
    });
  }
});
