import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped client with room snapshots, without a browser or a network.
// Missing HTML IDs and broken render/input paths fail just as they do in the page.
async function mount() {
  const html = await readFile(new URL('../games/light-trails/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const classes = new Set();
    return [id, {
      textContent: '', hidden: /\bhidden\b/.test(tag), disabled: /\bdisabled\b/.test(tag),
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c), contains: c => classes.has(c) },
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    }];
  }));
  let onFrame, bridge;
  const actions = [];
  class Bridge extends EventTarget {
    context = { playerId: 'blue' };
    constructor() { super(); bridge = this; }
    async action(action) { actions.push(action); return { accepted: true }; }
  }
  const canvas = elements.get('board');
  canvas.getBoundingClientRect = () => ({ width: 480, height: 270 });
  canvas.getContext = () => new Proxy({}, { get: (target, prop) => target[prop] ?? (() => {}) });
  const scope = {
    PlayweftBridge: Bridge,
    document: { hidden: false, getElementById: id => elements.get(id), documentElement: { style: { setProperty() {} } } },
    window: { parent: {}, addEventListener() {} },
    matchMedia: () => ({ matches: true }), performance: { now: () => 1000 },
    devicePixelRatio: 1, ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } },
    setInterval() {}, setTimeout() {}, requestAnimationFrame(fn) { onFrame = fn; },
  };
  const script = (await readFile(new URL('../games/light-trails/main.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
  vm.runInNewContext(script, scope);
  function snapshot(phase, extra = {}) {
    const state = { width: 48, height: 27, stepMs: 120, tick: 500, lastStepAt: 60000, startsAt: 63000, round: 2, phase,
      players: [
        { id: 'blue', name: '蓝方', score: 2, dir: 0, trail: [401, 402], rematch: false },
        { id: 'orange', name: '橙方', score: 1, dir: 2, trail: [800, 799], rematch: false },
      ], ...extra };
    const event = new Event('state');
    event.detail = { state, serverTime: 60000 };
    bridge.dispatchEvent(event); onFrame(); return state;
  }
  return { elements, bridge, actions, snapshot, frame: () => onFrame() };
}

test('landscape UI handles play, pause, results and rematch without losing its controls', async () => {
  const ui = await mount();
  const el = id => ui.elements.get(id);
  ui.snapshot('playing');
  assert.equal(el('overlay').hidden, true);
  assert.equal(el('left').disabled, false);
  assert.equal(el('player-1').classList.contains('is-you'), true);
  assert.equal(el('elapsed').textContent, '01:00');
  await el('left').listeners.pointerdown({ button: 0, preventDefault() {} });
  assert.equal(ui.actions.at(-1).direction, -1);
  ui.snapshot('paused');
  assert.equal(el('overlay').hidden, false);
  assert.equal(el('left').disabled, true);
  ui.snapshot('ended', { winner: 1 });
  assert.equal(el('overlay-title').textContent, '你赢了！');
  assert.equal(el('replay').hidden, false);
  await el('replay').listeners.click();
  assert.equal(ui.actions.at(-1).type, 'rematch');
  const state = ui.snapshot('ended', { winner: 1 });
  state.players[0].rematch = true;
  ui.snapshot('ended', state);
  assert.equal(el('replay-label').textContent, '等待好友确认');
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
