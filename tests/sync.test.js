import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../scripts/lua-runtime.mjs';
import { GameSync, sampleMotion } from '../games/light-trails/sync.js';
const clone=v=>structuredClone(v);
async function arena(r){
 const s=(await r.call('setup',{serverTime:1000,players:[{id:'p1'},{id:'p2'}]})).state;
 s.phase='playing';s.startsAt=5000;s.lastStepAt=5000;
 s.players.forEach(p=>{p.ready=true;p.lastSeen=5000;});return s;
}
const act=(r,s,at,extra)=>r.call('on_action',s,{round:s.round,...extra},{actor:{id:'p1',role:'player'},actionAt:at});

test('200 ms RTT: every input phase turns locally within one cell, before the reply, and agrees with Lua',async t=>{
 const r=await createRuntime();let worst=0;
 try{
  for(let phase=0;phase<180;phase+=10){
   const initial=await arena(r),sync=new GameSync();sync.rtt=200;
   sync.receive(initial,0,5000,100); // Snapshot travels 100 ms from server to client.
   const pressed=phase<100?phase+180:phase;
   for(let time=100;time<=pressed;time+=5)sync.project(time);
   const before=sync.project(pressed)[0].head;
   const input=sync.enqueue(3,pressed);
   assert.ok(input);assert.deepEqual(sync.project(pressed)[0].head,before,'press must not teleport');
   let response;
   for(let time=pressed+1;time<=pressed+181;time++){
    const p=sync.project(time)[0];
    if(p.head.y<before.y-1e-6){response=time-pressed;break;}
   }
   assert.ok(response<=181,`phase ${phase}: ${response}`);worst=Math.max(worst,response);
   const accepted=await act(r,clone(initial),5000+pressed+100,{type:'steer',...input});
   assert.equal(accepted.accepted,true);
   assert.equal(accepted.state.players[0].inputs[0].tick,input.tick,'normal 200 ms RTT must not reschedule the predicted turn');
   const at=5000+input.tick*180;
   const end=(await act(r,accepted.state,at,{type:'pulse'})).state;
   const predicted=sampleMotion({...initial,players:initial.players.map((p,i)=>i===0?{...p,inputs:[input]}:p)},at,0)[0];
   assert.deepEqual(predicted.trail,end.players[0].trail);
  }
  t.diagnostic(`Worst input-to-turn response: ${worst} ms across 18 grid phases, without any acknowledgement`);
 }finally{r.close();}
});

test('server accepts public turns promptly, bounds queues and clamps late or far-future ticks',async()=>{
 const r=await createRuntime();try{
  let s=await arena(r);
  s=(await act(r,s,5001,{type:'steer',seq:1,heading:3,tick:1})).state;
  assert.equal(s.players[0].inputs[0].tick,1);
  const v=(await r.call('view',s,{}, {viewer:{id:'p2'}})).state;
  assert.deepEqual(v.players[0].inputs,s.players[0].inputs);
  s=(await act(r,s,5002,{type:'steer',seq:1,heading:3,tick:1})).state;
  assert.equal(s.players[0].inputs.length,1);
  assert.equal((await act(r,s,5003,{type:'steer',seq:2,heading:1,tick:2})).accepted,false);
  s=(await act(r,s,5003,{type:'steer',seq:2,heading:2,tick:2})).state;
  assert.equal((await act(r,s,5004,{type:'steer',seq:3,heading:1,tick:3})).error.code,'INPUT_QUEUE_FULL');
  s=(await act(r,s,5360,{type:'pulse'})).state;
  s=(await act(r,s,5361,{type:'steer',seq:3,heading:1,tick:1})).state;
  assert.equal(s.players[0].inputs[0].tick,3,'late input cannot rewrite an executed move');
  s=(await act(r,s,5362,{type:'steer',seq:4,heading:0,tick:999999})).state;
  assert.equal(s.players[0].inputs[1].tick,s.tick+4);
  assert.equal((await act(r,s,5363,{type:'steer',seq:5,heading:3,tick:'x'})).accepted,false);
 }finally{r.close();}
});

test('acknowledgement and an executed snapshot preserve a correct locally predicted corner',async()=>{
 const r=await createRuntime();try{
  const s=await arena(r),sync=new GameSync();sync.rtt=200;sync.receive(s,0,4900,0);
  sync.project(0);sync.project(60);const input=sync.enqueue(3,60);
  const accepted=(await act(r,clone(s),5160,{type:'steer',...input})).state;
  for(let t=70;t<=260;t+=10)sync.project(t);
  const before=sync.project(260)[0].head;sync.receive(accepted,0,5160,260);
  assert.deepEqual(sync.project(260)[0].head,before);
  const end=(await act(r,accepted,5360,{type:'pulse'})).state;
  for(let t=270;t<=460;t+=10)sync.project(t);
  const beforeEnd=sync.project(460)[0].head;sync.receive(end,0,5360,460);
  assert.deepEqual(sync.project(460)[0].head,beforeEnd);
  assert.equal(sync.pending.length,0);
 }finally{r.close();}
});

test('late opponent turns reconcile positions over time instead of teleporting on receipt',async()=>{
 const r=await createRuntime();try{
  const s=await arena(r),sync=new GameSync();sync.rtt=200;sync.receive(s,-1,4900,0);
  for(let time=0;time<=280;time+=10)sync.project(time);
  let turned=(await act(r,clone(s),5001,{type:'steer',seq:1,heading:3,tick:1})).state;
  turned=(await act(r,turned,5180,{type:'pulse'})).state;
  const before=sync.project(280);
  sync.receive(turned,-1,5180,280);
  assert.deepEqual(sync.project(280).map(p=>p.head),before.map(p=>p.head));
  let previous=before[0].head,max=0;
  for(let time=290;time<=400;time+=10){const head=sync.project(time)[0].head;max=Math.max(max,Math.hypot(head.x-previous.x,head.y-previous.y));previous=head;}
  assert.ok(max<.25,'one-frame correction stays below a quarter cell for this late turn');
 }finally{r.close();}
});

test('prediction is bounded, respects known solids, and does not invent a remote collision',async()=>{
 const r=await createRuntime();try{
  const s=await arena(r),sync=new GameSync();sync.receive(s,0,5000,0);
  const one=sync.enqueue(3,0),two=sync.enqueue(2,0);assert.ok(one&&two);assert.equal(sync.enqueue(1,0),null);
  for(let t=0;t<=2000;t+=10)sync.project(t);
  const stopped=sync.project(2000);assert.equal(sync.waiting,true);
  assert.deepEqual(sync.project(2200).map(p=>p.head),stopped.map(p=>p.head));
  sync.reject(two.seq);assert.equal(sync.pending.length,1);
  const paused={...s,phase:'paused'};sync.receive(paused,0,7300,2300);
  assert.equal(sync.project(2300),null);assert.equal(sync.pending.length,0);
  sync.receive({...s,timeline:1},0,7400,2400);assert.equal(sync.pending.length,0);
  const wall=clone(s);Object.assign(wall.players[0],{x:47,y:12,trail:[624]});
  const blocked=sampleMotion(wall,5180,0)[0];assert.equal(blocked.head.x,47.55);assert.equal(blocked.crashed,false);
  const crossing=clone(s);Object.assign(crossing.players[1],{x:13,y:10,dir:1,trail:[494]});
  const predicted=sampleMotion(crossing,5540,0)[0];
  assert.equal(predicted.head.x,14.5,'unknown future opponent trails cannot stop local prediction');
 }finally{r.close();}
});
