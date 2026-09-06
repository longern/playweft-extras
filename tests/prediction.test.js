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
  assert.deepEqual(p.project(180).head, { x: 10.5, y: 10.5 });
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
