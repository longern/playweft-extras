import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteMotion } from '../games/light-trails/remote-motion.js';

function straight(serverTime) {
  const tick = Math.floor(serverTime / 120);
  return { round:1, phase:'playing', tick, stepMs:120, lastStepAt:tick * 120, width:200, height:27,
    players:[{dir:0, trail:Array.from({length:tick + 1}, (_, i) => 201 + i)}, {dir:2, trail:[2001]}] };
}

// Replay identical packet arrivals through the previous formula and the new presenter.
function trace() {
  const motion = new RemoteMotion();
  const packets = [];
  for (let sent = 0; sent <= 7000; sent += 200) {
    const transit = 80 + [0, 90, 10, 60][sent / 200 % 4];
    packets.push({ arrived:sent + transit, state:straight(2400 + sent) });
  }
  let current, previousNew, previousOld, stopsNew = 0, stopsOld = 0, backwards = 0, maxJump = 0;
  for (let time = 0; time <= 6500; time += 10) {
    while (packets[0]?.arrived <= time) {
      current = packets.shift().state;
      motion.receive(current, time, 2400 + time);
    }
    if (!current) continue;
    const rendered = motion.project(0, time, 2400 + time);
    const x = rendered.head.x;
    const behind = Math.max(0, (current.lastStepAt - (2400 + time - 140)) / 120);
    const oldX = current.players[0].trail.length - .5 - behind;
    if (time >= 1500) {
      if (Math.abs(x - previousNew) < 1e-8) stopsNew++;
      if (Math.abs(oldX - previousOld) < 1e-8) stopsOld++;
      if (x < previousNew - 1e-8) backwards++;
      maxJump = Math.max(maxJump, Math.abs(x - previousNew));
    }
    previousNew = x; previousOld = oldX;
  }
  return {stopsNew, stopsOld, backwards, maxJump, delay:motion.delay};
}

test('remote straight movement stays continuous with 200 ms updates and jitter', t => {
  const result = trace();
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.stopsOld > 100, JSON.stringify(result));
  assert.equal(result.stopsNew, 0, JSON.stringify(result));
  assert.equal(result.backwards, 0);
  assert.ok(result.maxJump <= 10 / 120 * 1.151, JSON.stringify(result));
});

test('remote extrapolation is limited to one cell and stops at known walls or trails', () => {
  for (const obstacle of ['none', 'wall', 'trail']) {
    const motion = new RemoteMotion();
    const state = straight(2400);
    if (obstacle === 'wall') {
      state.width = 48;
      state.players[0].trail = Array.from({length:48}, (_, i) => 481 + i);
    }
    if (obstacle === 'trail') state.players[1].trail.push(222);
    motion.receive(state, 0, 2400);
    let frame;
    for (let time = 0; time <= 4000; time += 10) frame = motion.project(0, time, 2400 + time);
    if (obstacle === 'none') assert.equal(frame.head.x, 21.5);
    if (obstacle === 'trail') assert.equal(frame.head.x, 20.5);
    if (obstacle === 'wall') {
      assert.deepEqual(frame.head, {x:47.5,y:10.5});
      assert.equal(frame.trail.length, 48);
    }
    assert.equal(state.players[0].trail.length, obstacle === 'wall' ? 48 : 21, 'rendering must not add authoritative cells');
  }
});

test('buffer changes do not reset playback, duplicate-step packets do not reduce its cadence estimate', () => {
  const motion = new RemoteMotion();
  const state = straight(2400);
  motion.receive(state, 0, 2450);
  const before = motion.project(0, 80, 2530).head;
  for (let n = 0; n < 10; n++) motion.receive(state, 80, 2530);
  assert.equal(motion.gaps.length, 0);
  assert.deepEqual(motion.project(0, 80, 2530).head, before);
  state.phase = 'paused'; motion.receive(state, 100, 2550);
  assert.equal(motion.project(0, 100, 2550), null);
  const next = straight(0); next.round = 2;
  motion.receive(next, 200, 0);
  assert.deepEqual(motion.project(0, 200, 0).head, {x:.5,y:1.5});
});

test('both spectators see the same playhead and batched turns follow grid corners', () => {
  const motion = new RemoteMotion();
  const state = {round:1,phase:'playing',tick:2,stepMs:120,lastStepAt:240,width:48,height:27,
    players:[{dir:3,trail:[491,492,444]}, {dir:3,trail:[501,502,454]}]};
  motion.receive(state, 0, 240);
  let previous = motion.project(0, 0, 240).head;
  for (let time = 10; time <= 240; time += 10) {
    const a = motion.project(0, time, 240 + time);
    const b = motion.project(1, time, 240 + time);
    assert.ok(Math.abs(b.head.x - a.head.x - 10) < 1e-6);
    assert.equal(b.head.y, a.head.y);
    assert.ok(a.head.y === 10.5 || a.head.x === 11.5, 'never cut diagonally across the corner');
    assert.ok(Math.hypot(a.head.x - previous.x, a.head.y - previous.y) <= .096);
    previous = a.head;
  }
});
