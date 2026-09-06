import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../scripts/lua-runtime.mjs';
import { CollisionPlayback, impactContact } from '../games/light-trails/collision-playback.js';

const cell = (x,y) => y * 48 + x + 1;
async function fatal(runtime, positions, obstacle) {
  let s = (await runtime.call('setup', {serverTime:1000, players:[{id:'p1'},{id:'p2'}]})).state;
  s.phase = 'playing'; s.lastStepAt = 5000;
  s.board = Array.from({length:27}, () => '0'.repeat(48));
  function paint(x,y,owner) { s.board[y] = s.board[y].slice(0,x) + owner + s.board[y].slice(x+1); }
  positions.forEach(([x,y,dir],i) => {
    Object.assign(s.players[i], {x,y,dir,trail:[cell(x,y)],ready:true,lastSeen:5000}); paint(x,y,i+1);
  });
  if (obstacle) { const [x,y,owner] = obstacle; paint(x,y,owner); s.players[owner-1].trail.unshift(cell(x,y)); }
  const old = structuredClone(s);
  s = (await runtime.call('on_action', s, {type:'pulse',round:1}, {actor:{id:'p1',role:'player'},actionAt:5120})).state;
  const v = (await runtime.call('view', s, {}, {viewer:{id:'p1'}})).state;
  return {state:v, old, raw:s};
}

test('real Lua fatal moves identify wall, trail owner and simultaneous heads at the authoritative tick', async () => {
  const runtime = await createRuntime();
  try {
    const cases = [
      {p:[[47,10,0],[36,22,2]],kind:'wall',owner:0},
      {p:[[10,10,0],[36,22,2]],kind:'trail',owner:1,obstacle:[11,10,1]},
      {p:[[10,10,0],[36,22,2]],kind:'trail',owner:2,obstacle:[11,10,2]},
      {p:[[10,10,0],[12,10,2]],kind:'head',owner:2},
      {p:[[10,10,0],[11,10,2]],kind:'head',owner:2},
      {p:[[10,10,0],[11,9,1]],kind:'head',owner:2},
    ];
    for (const c of cases) {
      const {state:s,old,raw} = await fatal(runtime,c.p,c.obstacle);
      assert.equal(s.reason,'collision');
      assert.equal(s.players[0].impact.kind,c.kind);
      assert.equal(s.players[0].impact.owner,c.owner);
      assert.equal(s.players[0].impact.tick,s.tick);
      assert.equal(s.players[0].impact.at,s.lastStepAt);
      assert.equal(s.players[0].trail.at(-1),old.players[0].trail.at(-1),'fatal cell never enters solid trail');
      const motion = new CollisionPlayback();
      motion.receive(s,old.players,0);
      assert.equal(motion.pending(0),true);
      assert.equal(motion.project(0,0).crashed,false);
      const hit = motion.project(0,motion.impactAt);
      assert.equal(hit.crashed,true);
      assert.equal(motion.pending(motion.impactAt + 199),true);
      assert.equal(motion.pending(motion.impactAt + 200),false);
      if (c.kind === 'wall') assert.ok(Math.abs(hit.head.x + .45 - 48) < 1e-9);
      if (c.kind === 'trail') assert.ok(Math.abs(hit.head.x + .45 - (11.5 - .35)) < 1e-9);
      if (c.kind === 'head') {
        const other = motion.project(1,motion.impactAt);
        assert.ok(Math.abs(Math.max(Math.abs(hit.head.x-other.head.x),Math.abs(hit.head.y-other.head.y)) - .9) < 1e-9);
        assert.equal(s.winner,0);
      }
      const end = motion.finishAt;
      motion.receive(structuredClone(s),[],100);
      assert.equal(motion.finishAt,end);
      // The next round must not inherit the fatal move.
      let next = (await runtime.call('on_action', raw, {type:'rematch',round:1}, {actor:{id:'p1',role:'player'},actionAt:5200})).state;
      next = (await runtime.call('on_action', next, {type:'rematch',round:1}, {actor:{id:'p2',role:'player'},actionAt:5300})).state;
      assert.ok(next.players.every(p => !p.impact));
      motion.receive(next,[],end+1); assert.equal(motion.project(0,end+1),null);
    }
  } finally { runtime.close(); }
});

test('terminal playback preserves displayed position, traverses late corners and freezes exactly at contact', () => {
  const s = {round:1,tick:3,phase:'ended',reason:'collision',stepMs:120,width:48,
    players:[{dir:3,crashed:true,trail:[cell(10,10),cell(11,10),cell(11,9)],
      impact:{fromX:11,fromY:9,x:11,y:8,kind:'trail',owner:2}},
    {dir:2,trail:[cell(20,20)]}]};
  const motion = new CollisionPlayback();
  const shown = {x:10.8,y:10.5};
  motion.receive(s,[{head:shown}],1000);
  assert.deepEqual(motion.project(0,1000).head,shown);
  let previous = shown;
  for (let t=1010;t<=1600;t+=10) {
    const frame = motion.project(0,t);
    assert.ok(frame.head.y === 10.5 || frame.head.x === 11.5,'no diagonal shortcuts on the confirmed path');
    assert.ok(Math.hypot(frame.head.x-previous.x,frame.head.y-previous.y)<.15);
    previous = frame.head;
  }
  assert.deepEqual(previous,impactContact(s,0).head);
});
