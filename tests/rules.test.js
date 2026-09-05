import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../scripts/lua-runtime.mjs';

let runtime;
before(async () => { runtime = await createRuntime(); });
after(() => runtime.close());
const players = [{ id: 'p1', name: '蓝方' }, { id: 'p2', name: '橙方' }];
const clone = (value) => structuredClone(value);
async function setup() {
  return (await runtime.call('setup', { serverTime: 1000, match: { startedAt: 1000 }, players })).state;
}
async function act(state, index, time, type = 'pulse', extra = {}) {
  return runtime.call('on_action', state, { type, round: state.round, ...extra }, {
    actor: { id: `p${index}`, role: 'player' }, actionAt: time, serverTime: time,
  });
}
async function arena(a = [10, 10, 0], b = [30, 30, 2]) {
  const s = await setup();
  s.phase = 'playing'; s.lastStepAt = 5000;
  s.board = Array.from({ length: 40 }, () => '0'.repeat(40));
  [a, b].forEach(([x, y, dir], i) => {
    Object.assign(s.players[i], { x, y, dir, ready: true, lastSeen: 5000, trail: [y * 40 + x + 1] });
    s.board[y] = s.board[y].slice(0, x) + String(i + 1) + s.board[y].slice(x + 1);
  });
  return s;
}

test('waits for both clients, then starts a server-timed three-second countdown', async () => {
  let s = await setup();
  assert.equal(s.phase, 'waiting');
  s = (await act(s, 1, 1100)).state;
  assert.equal(s.phase, 'waiting');
  s = (await act(s, 2, 1200)).state;
  assert.equal(s.phase, 'countdown'); assert.equal(s.startsAt, 4200);
  for (let time = 1300; time <= 4200; time += 100) {
    s = (await act(s, 1, time)).state; s = (await act(s, 2, time)).state;
  }
  assert.equal(s.phase, 'playing'); assert.equal(s.tick, 0);
  s = (await act(s, 1, 4320)).state;
  assert.equal(s.tick, 1); assert.equal(s.players[0].x, 10); assert.equal(s.players[1].x, 29);
});

test('pulse flooding cannot advance the authoritative clock', async () => {
  let s = await arena();
  for (let i = 0; i < 30; i++) s = (await act(s, 1, 5119)).state;
  assert.equal(s.tick, 0);
  s = (await act(s, 2, 5120)).state;
  assert.equal(s.tick, 1);
});

test('left and right are relative quarter-turns; only one is queued per step', async () => {
  let s = await arena();
  s = (await act(s, 1, 5001, 'turn', { direction: -1 })).state;
  s = (await act(s, 1, 5002, 'turn', { direction: -1 })).state;
  s = (await act(s, 2, 5003, 'turn', { direction: 1 })).state;
  s = (await act(s, 1, 5120)).state;
  assert.equal(s.players[0].dir, 3); assert.equal(s.players[0].y, 9);
  assert.equal(s.players[1].dir, 3); assert.equal(s.players[1].y, 29);
  assert.equal(s.players[0].turn, 0);
});

test('an input arriving at the step deadline cannot rewrite an already-due move', async () => {
  let s = await arena();
  s = (await act(s, 1, 5120, 'turn', { direction: -1 })).state;
  assert.equal(s.players[0].x, 11); assert.equal(s.players[0].y, 10);
  s = (await act(s, 1, 5240)).state;
  assert.equal(s.players[0].x, 11); assert.equal(s.players[0].y, 9);
});

test('wall collision awards exactly one point; later pulses cannot rescore', async () => {
  let s = await arena([39, 10, 0]);
  s = (await act(s, 1, 5120)).state;
  assert.equal(s.phase, 'ended'); assert.equal(s.winner, 2);
  assert.equal(s.players[1].score, 1); assert.equal(s.players[0].crashed, true);
  s = (await act(s, 2, 5240)).state;
  assert.equal(s.players[1].score, 1);
});

test('simultaneous head-on arrival is a draw independent of acting seat', async () => {
  const s = await arena([10, 10, 0], [12, 10, 2]);
  for (const actor of [1, 2]) {
    const next = (await act(clone(s), actor, 5120)).state;
    assert.equal(next.winner, 0); assert.equal(next.phase, 'ended');
    assert.ok(next.players.every((p) => p.crashed && p.score === 0));
  }
});

test('head swaps and simultaneous separate wall crashes are draws', async () => {
  for (const pair of [[[10, 10, 0], [11, 10, 2]], [[39, 10, 0], [0, 30, 2]]]) {
    const s = (await act(await arena(...pair), 1, 5120)).state;
    assert.equal(s.winner, 0); assert.equal(s.phase, 'ended');
  }
});

test('own trail and opponent trail are both solid', async () => {
  for (const color of ['1', '2']) {
    let s = await arena();
    s.board[10] = s.board[10].slice(0, 11) + color + s.board[10].slice(12);
    s = (await act(s, 1, 5120)).state;
    assert.equal(s.winner, 2);
  }
});

test('rematch requires both players, clears the board and preserves scores', async () => {
  let s = (await act(await arena([39, 10, 0]), 1, 5120)).state;
  s = (await act(s, 1, 5200, 'rematch')).state;
  assert.equal(s.phase, 'ended'); assert.equal(s.players[0].rematch, true);
  s = (await act(s, 2, 5300, 'rematch')).state;
  assert.equal(s.phase, 'waiting'); assert.equal(s.round, 2);
  assert.equal(s.players[1].score, 1);
  assert.equal(s.board.join('').replaceAll('0', '').length, 2);
  assert.ok(s.players.every((p) => !p.ready && !p.rematch && p.trail.length === 1));
});

test('old-round actions, invalid directions and premature rematches are rejected', async () => {
  const s = await arena();
  assert.equal((await act(s, 1, 5001, 'pulse', { round: 0 })).error.code, 'STALE_ROUND');
  for (const direction of [0, 2, '1', null]) assert.equal((await act(s, 1, 5001, 'turn', { direction })).accepted, false);
  assert.equal((await act(s, 1, 5001, 'rematch')).error.code, 'ROUND_ACTIVE');
  assert.equal((await act(s, 1, 5001, 'set_position', { x: 39 })).accepted, false);
});

test('spectators and spoofed player IDs cannot control either snake', async () => {
  const s = await arena();
  for (const actor of [{ id: 'observer', role: 'spectator' }, { id: 'p1', role: 'spectator' }, { id: 'outsider', role: 'player' }]) {
    const result = await runtime.call('on_action', s, { type: 'turn', round: 1, direction: 1, playerId: 'p1' }, { actor, actionAt: 5001 });
    assert.equal(result.error.code, 'SPECTATOR');
  }
});

test('stale client pauses; a returning client cannot skip the resume countdown', async () => {
  let s = await arena();
  s.players[0].lastSeen = 6700;
  s = (await act(s, 1, 6900)).state;
  assert.equal(s.phase, 'paused'); assert.equal(s.tick, 0);
  s = (await act(s, 2, 7000)).state;
  assert.equal(s.phase, 'countdown'); assert.equal(s.startsAt, 10000); assert.equal(s.tick, 0);
});

test('a long gap with both clients recently present cannot trigger unbounded catch-up', async () => {
  const s = await arena();
  s.players.forEach((p) => p.lastSeen = 10000);
  const next = (await act(s, 1, 10000)).state;
  assert.equal(next.phase, 'countdown'); assert.equal(next.tick, 0);
});

test('up to eight overdue simulation steps stay inside the Lua instruction budget', async () => {
  const s = (await act(await arena([5, 5, 0], [35, 35, 2]), 1, 5960)).state;
  assert.equal(s.tick, 8); assert.equal(s.players[0].x, 13);
});

test('view hides presence bookkeeping, collision map and the opponent queued input', async () => {
  const s = await arena(); s.players[0].turn = -1; s.players[1].turn = 1;
  const v = (await runtime.call('view', s, {}, { viewer: { id: 'p1', role: 'player' } })).state;
  assert.equal(v.board, undefined); assert.equal(v.players[0].lastSeen, undefined);
  assert.equal(v.players[0].turn, -1); assert.equal(v.players[1].turn, 0);
  assert.deepEqual(v.players[0].trail, s.players[0].trail);
});

test('leaving closes the match and prevents rematch; spectators leaving do not', async () => {
  let s = await arena();
  const untouched = await runtime.call('on_player_left', s, { actor: { id: 'observer' } });
  assert.equal(untouched.state.phase, 'playing');
  s = (await runtime.call('on_player_left', s, { actor: { id: 'p1' } })).state;
  assert.equal(s.phase, 'closed'); assert.equal(s.winner, 2);
  assert.equal((await act(s, 2, 5200, 'rematch')).error.code, 'PLAYER_LEFT');
  assert.equal(await runtime.call('on_return_to_room', s, {}), true);
});

test('a nearly full board stays below the platform JSON and table limits', async () => {
  const s = await arena();
  s.players[0].trail = Array.from({ length: 800 }, (_, i) => i + 1);
  s.players[1].trail = Array.from({ length: 800 }, (_, i) => i + 801);
  const v = await runtime.call('view', s, {}, { viewer: { id: 'p1' } });
  assert.ok(Buffer.byteLength(JSON.stringify(s)) < 65536);
  assert.ok(Buffer.byteLength(JSON.stringify(v)) < 65536);
  function limits(value) {
    if (value && typeof value === 'object') {
      assert.ok(Object.keys(value).length <= 2048);
      Object.values(value).forEach(limits);
    }
  }
  limits(s); limits(v);
});
