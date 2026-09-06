import test from 'node:test';
import assert from 'node:assert/strict';
import { Predictor } from '../games/light-trails/prediction.js';
import { createRuntime } from '../scripts/lua-runtime.mjs';

function snapshot() {
  return { round: 1, phase: 'playing', width: 48, height: 27, tick: 10, stepMs: 120, lastStepAt: 1000,
    players: [
      { x: 10, y: 10, dir: 0, trail: [491], inputSeq: 0, inputs: [] },
      { x: 30, y: 20, dir: 2, trail: [991], inputSeq: 0, inputs: [] },
    ] };
}

test('local inputs predict before acknowledgement, replay after snapshots and stop after two cells', () => {
  const p = new Predictor(), s = snapshot();
  p.receive(s, 0, 1000, 0);
  const up = p.enqueue(3, 0), left = p.enqueue(2, 1);
  assert.deepEqual([up.tick, left.tick], [11, 12]);
  const predicted = p.project(180);
  assert.deepEqual(predicted.head, { x: 10, y: 9.5 });
  assert.deepEqual(p.project(10000).head, { x: 9.5, y: 9.5 });
  assert.equal(s.players[0].trail.length, 1, 'prediction never edits authoritative trails');
  s.players[0].inputSeq = up.seq;
  s.players[0].inputs = [{ ...up, tick: 12 }]; // Server reschedules a late input.
  p.receive(s, 0, 1000, 0);
  assert.deepEqual(p.pending.map(i => i.seq), [left.seq]);
  assert.deepEqual(p.inputs().map(i => i.tick), [12, 13]);
  assert.equal(p.project(60).dir, 0, 'server schedule overrides the original prediction');
});

test('prediction respects walls, known trails, reversal rules, queue bound and pause resets', () => {
  const p = new Predictor(), s = snapshot();
  s.players[1].trail.push(492);
  p.receive(s, 0, 1000, 0);
  assert.deepEqual(p.project(180).head, { x: 10.7, y: 10.5 });
  assert.equal(p.project(180).crashed, undefined, "contact prediction cannot declare a loss");
  assert.equal(p.enqueue(2, 0), null);
  for (const dir of [3, 2, 1, 0, 3, 2]) assert.ok(p.enqueue(dir, 0));
  assert.equal(p.enqueue(1, 0), null);
  s.phase = 'paused'; p.receive(s, 0, 1100, 100);
  assert.equal(p.pending.length, 0); assert.equal(p.project(150), null);
});

test('Lua sequences rapid absolute turns, acknowledges receipt/execution, and hides opponent inputs', async () => {
  const runtime = await createRuntime();
  try {
    let s = (await runtime.call('setup', { serverTime: 1000, players: [{id:'p1'}, {id:'p2'}] })).state;
    s.phase = 'playing'; s.lastStepAt = 5000;
    s.players.forEach(p => { p.ready = true; p.lastSeen = 5000; });
    async function act(action, at = 5001) {
      return runtime.call('on_action', s, { round: 1, ...action }, { actor: {id:'p1', role:'player'}, actionAt:at });
    }
    const input = { type:'steer', seq:1, tick:1, heading:3 };
    s = (await act(input)).state;
    s = (await act(input)).state;
    assert.equal(s.players[0].inputs.length, 1, 'duplicate sequence must not turn twice');
    s = (await act({type:'steer',seq:2,tick:2,heading:2})).state;
    const view = (await runtime.call('view', s, {}, {viewer:{id:'p2'}})).state;
    assert.deepEqual(view.players[0].inputs, {});
    assert.equal(view.players[0].inputSeq, 0);
    const p = new Predictor();
    p.receive(s, 0, 5000, 0);
    const predicted = p.project(240);
    s = (await act({type:'pulse'}, 5240)).state;
    assert.equal(s.players[0].appliedSeq, 2);
    assert.deepEqual(s.players[0].trail, predicted.trail, 'client replay agrees with Lua on both queued turns');
    assert.equal(s.players[0].dir, predicted.dir);
    // A late request is scheduled forward, never applied retroactively.
    s = (await act({type:'steer',seq:3,tick:1,heading:1}, 5241)).state;
    assert.equal(s.players[0].inputs[0].tick, 3);
    // Queue has a bounded future window, including malicious far-future ticks.
    s = (await act({type:'steer',seq:4,tick:999999,heading:0},5242)).state;
    assert.equal(s.players[0].inputs[1].tick, s.tick + 6);
    assert.equal((await act({type:'steer',seq:5,tick:9,heading:3},5243)).error.code, 'INPUT_QUEUE_FULL');
    assert.equal((await act({type:'steer',seq:6,tick:9,heading:7},5243)).accepted, false);
    s.players[1].lastSeen = 1000;
    s = (await act({type:'pulse'},5300)).state;
    assert.equal(s.phase, 'paused'); assert.equal(s.players[0].inputs.length, undefined);
    assert.equal(s.players[0].appliedSeq, s.players[0].inputSeq);
  } finally { runtime.close(); }
});

test('a mid-cell turn preserves the moving segment and traverses the corner continuously', () => {
  const p = new Predictor(), s = snapshot();
  p.receive(s, 0, 1000, 0);
  const before = p.project(60).head;
  const input = p.enqueue(3, 60);
  assert.equal(input.tick, 12, 'the half-rendered tick 11 must not be rewritten');
  assert.deepEqual(p.project(60).head, before, 'input must not teleport the head');
  const near = p.project(119.99).head;
  const corner = p.project(120).head;
  const after = p.project(120.01).head;
  assert.deepEqual(corner, {x:11.5, y:10.5});
  assert.ok(Math.hypot(near.x - corner.x, near.y - corner.y) < .001);
  assert.ok(Math.hypot(after.x - corner.x, after.y - corner.y) < .001);
  assert.ok(after.y < corner.y);
});

test('jittered snapshots and latency changes slew the animation clock without rewinding it', () => {
  const p = new Predictor(), s = snapshot();
  p.receive(s, 0, 1000, 0);
  const before = p.project(90).head;
  p.receive(s, 0, 1000, 90); // Delayed duplicate-step snapshot.
  assert.deepEqual(p.project(90).head, before);
  let previous = p.now(90);
  for (let time = 100; time <= 190; time += 10) {
    const now = p.now(time);
    assert.ok(now - previous >= 8.99 && now - previous <= 11.01);
    previous = now;
  }
  p.rtt = 200;
  const atReceipt = p.now(200);
  p.receive(s, 0, 1200, 200);
  assert.equal(p.now(200), atReceipt, 'RTT update must not jump the presentation clock');
});

test('acknowledgement and executed-turn snapshots preserve an already correct prediction', () => {
  const p = new Predictor(), s = snapshot();
  p.receive(s, 0, 1000, 0);
  const input = p.enqueue(3, 60);
  const before = p.project(100).head;
  const ack = structuredClone(s);
  ack.players[0].inputSeq = input.seq;
  ack.players[0].inputs = [input];
  p.receive(ack, 0, 1100, 100);
  assert.deepEqual(p.project(100).head, before);
  const turned = p.project(240).head;
  const next = structuredClone(ack);
  next.tick = 12; next.lastStepAt = 1240;
  Object.assign(next.players[0], {x:11, y:9, dir:3, inputs:[], trail:[491,492,444]});
  p.receive(next, 0, 1240, 240);
  assert.deepEqual(p.project(240).head, turned);
});
