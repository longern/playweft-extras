import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../scripts/lua-runtime.mjs';
import { GameSync, sampleCommitted, committedLimit } from '../games/light-trails/sync.js';

const clone = v => structuredClone(v);
async function arena(runtime) {
  const s=(await runtime.call('setup',{serverTime:1000,players:[{id:'p1'},{id:'p2'}]})).state;
  s.phase='playing'; s.startsAt=5000; s.lastStepAt=5000; s.sealedUntil=5240;
  s.players.forEach(p=>{p.ready=true;p.lastSeen=5000;});
  return s;
}
const act = (r,s,at,who,extra={type:'pulse'}) => r.call('on_action',s,{round:s.round,...extra},{actor:{id:who,role:'player'},actionAt:at});

test('server seals future segments, broadcasts both schedules and ignores client target ticks',async()=>{
  const r=await createRuntime();
  try {
    let s=await arena(r);
    const result=await act(r,s,5001,'p1',{type:'steer',seq:1,heading:3,tick:1});s=result.state;
    const input=s.players[0].inputs[0];
    assert.equal(input.tick,3);
    assert.ok(s.lastStepAt+(input.tick-s.tick-1)*s.stepMs>=5240,'cannot change any previously sealed segment');
    for(const who of ['p1','p2','viewer']) {
      const v=(await r.call('view',s,{}, {viewer:{id:who}})).state;
      assert.deepEqual(v.players[0].inputs,[input]);
      assert.equal(v.sealedUntil,5241);assert.equal(v.stepMs,180);
      if(who!=='p1') assert.equal(v.players[0].inputSeq,0);
    }
    s=(await act(r,s,5002,'p1',{type:'steer',seq:1,heading:3})).state;
    assert.equal(s.players[0].inputs.length,1);
    s=(await act(r,s,5003,'p1',{type:'steer',seq:2,heading:2,tick:999999})).state;
    assert.equal(s.players[0].inputs[1].tick,4,'client cannot defer or advance execution');
    assert.equal((await act(r,s,5004,'p1',{type:'steer',seq:3,heading:0})).accepted,false);
    for(const [seq,heading] of [[3,1],[4,0],[5,3],[6,2]]) s=(await act(r,s,5004,'p1',{type:'steer',seq,heading})).state;
    assert.equal((await act(r,s,5005,'p1',{type:'steer',seq:7,heading:1})).error.code,'INPUT_QUEUE_FULL');
    assert.equal((await act(r,s,5005,'p1',{type:'steer',seq:7,heading:9})).accepted,false);
    s=(await act(r,s,5360,'p2')).state;
    const before=sampleCommitted(s,5500);
    s=(await act(r,s,5370,'p2',{type:'steer',seq:1,heading:1})).state;
    const after=sampleCommitted(s,5500);
    assert.deepEqual(before.map(p=>p.head),after.map(p=>p.head),'new actions cannot rewrite already published movement');
  }finally{r.close();}
});

test('local button input never changes either path before server acknowledgement; clock corrections cannot rewind it',()=>{
  const s={round:1,timeline:1,phase:'playing',width:48,height:27,stepMs:180,tick:0,lastStepAt:5000,startsAt:5000,sealedUntil:5240,
    players:[{x:11,y:12,dir:0,trail:[588],inputs:[],inputSeq:0},{x:36,y:14,dir:2,trail:[709],inputs:[],inputSeq:0}]};
  const a=new GameSync(),b=new GameSync();
  a.receive(s,0,5000,0);b.receive(s,1,5000,0);
  const before=a.project(80);
  const input=a.enqueue(3);
  assert.deepEqual(a.project(80),before);
  assert.deepEqual(a.project(80).map(p=>p.head),b.project(80).map(p=>p.head));
  assert.equal(input.tick,undefined);
  const ack=clone(s);ack.players[0].inputs=[{...input,tick:3}];ack.players[0].inputSeq=input.seq;
  a.receive(ack,0,5080,80);assert.equal(a.pending.length,0);
  assert.deepEqual(a.project(80).map(p=>p.head),before.map(p=>p.head));
  let previous=a.now(80);a.rtt=240;a.receive(ack,0,5080,90);
  for(let t=100;t<=200;t+=10){const n=a.now(t);assert.ok(n>=previous);previous=n;}
});

test('exhausting the committed window freezes both snakes, then resumes without jumping',()=>{
  const s={round:1,timeline:1,phase:'playing',width:48,height:27,stepMs:180,tick:0,lastStepAt:5000,startsAt:5000,sealedUntil:5240,
    players:[{x:11,y:12,dir:0,trail:[588],inputs:[]},{x:36,y:14,dir:2,trail:[709],inputs:[]}]};
  const sync=new GameSync();sync.receive(s,0,5000,0);
  let shown;for(let t=0;t<=1000;t+=10) shown=sync.project(t);
  assert.equal(sync.waiting,true);assert.equal(sync.cursor,5360);
  assert.deepEqual(sync.project(1200).map(p=>p.head),shown.map(p=>p.head));
  const next=clone(s);next.sealedUntil=6480;
  sync.receive(next,0,6240,1240);
  const resumed=sync.project(1240);
  assert.ok(Math.abs(resumed[0].head.x-shown[0].head.x)<=40*1.15/180+.00001);
  const paused={...next,phase:'paused'};sync.receive(paused,0,6250,1250);assert.equal(sync.project(1250),null);
  const resumedState={...next,phase:'countdown',timeline:2,startsAt:9500};sync.receive(resumedState,0,6500,1500);
  assert.equal(sync.cursor,null);assert.equal(sync.pending.length,0);
});

test('200 ms RTT plus jitter: repeated turns stay on Lua paths with no packet-boundary teleports',async t=>{
  const r=await createRuntime();
  try {
    let s=await arena(r);const packets=[];
    const commands=new Map([[20,['p1',3]],[90,['p1',0]],[600,['p2',1]],[670,['p2',2]],
      [1100,['p1',3]],[1170,['p1',0]],[1700,['p2',1]],[1770,['p2',2]],
      [2200,['p1',3]],[2270,['p1',0]],[2800,['p2',1]],[2870,['p2',2]]]);
    const seq={p1:0,p2:0};
    for(let at=0;at<=3600;at+=10){
      const command=commands.get(at);
      if(at%100!==0&&!command) continue;
      const who=command?.[0]||(at%200===0?'p1':'p2');
      const action=command?{type:'steer',seq:++seq[who],heading:command[1]}:{type:'pulse'};
      const result=await act(r,s,5000+at,who,action);assert.equal(result.accepted,true);s=result.state;
      assert.equal(s.phase,'playing');
      packets.push({at,state:clone(s)});
    }
    // Lua has now independently executed the complete ground-truth trajectories.
    const actual=s.players.map(p=>p.trail);
    let maxJump=0,receipts=0,stalls=0;
    for(const own of [0,1,-1]){
      const sync=new GameSync();sync.rtt=200;
      let lastArrival=0;
      const incoming=packets.map((p,i)=>{
        const jitter=[0,30,-20,40,-10][(i+own+1)%5];
        lastArrival=Math.max(lastArrival,p.at+100+jitter);
        return {...p,arrival:lastArrival};
      });
      let previous;
      for(let time=0;time<=3500;time+=10){
        while(incoming[0]?.arrival<=time){
          const packet=incoming.shift();
          const before=sync.project(time);
          sync.receive(packet.state,own,5000+packet.at,time);
          const after=sync.project(time);
          if(before){
            for(let i=0;i<2;i++)assert.ok(Math.hypot(after[i].head.x-before[i].head.x,after[i].head.y-before[i].head.y)<1e-7,'receiving a turn must not change the current displayed position');
            receipts++;
          }
        }
        const frame=sync.project(time);if(!frame)continue;
        if(sync.waiting)stalls++;
        for(let i=0;i<2;i++){
          const d=Math.max(0,(sync.cursor-5000)/180),k=Math.floor(d),f=d-k;
          const decode=c=>({x:(c-1)%48+.5,y:Math.floor((c-1)/48)+.5});
          const a=decode(actual[i][k]),b=decode(actual[i][k+1]);
          assert.ok(Math.abs(frame[i].head.x-(a.x+(b.x-a.x)*f))<1e-6);
          assert.ok(Math.abs(frame[i].head.y-(a.y+(b.y-a.y)*f))<1e-6);
          if(previous)maxJump=Math.max(maxJump,Math.hypot(frame[i].head.x-previous[i].head.x,frame[i].head.y-previous[i].head.y));
        }
        previous=frame;
      }
    }
    assert.equal(stalls,0);assert.ok(receipts>80);assert.ok(maxJump<=10*1.15/180+1e-6);
    t.diagnostic(JSON.stringify({receipts,maxJump,stalls}));
  }finally{r.close();}
});

test('a sealed segment can finish without another packet, and later inputs cannot change that endpoint',async()=>{
  const r=await createRuntime();
  try{
    const s=await arena(r);
    assert.equal(committedLimit(s),5360);
    const sync=new GameSync();sync.receive(s,0,5000,0);
    let frame;for(let time=0;time<=410;time+=10)frame=sync.project(time);
    assert.ok(sync.cursor>5240,'do not freeze halfway through an already committed segment');
    assert.equal(sync.waiting,false);
    const endpoint=sampleCommitted(s,5360).map(p=>p.head);
    for(const at of [5001,5100,5239]){
      const next=(await act(r,clone(s),at,'p1',{type:'steer',seq:1,heading:3})).state;
      assert.deepEqual(sampleCommitted(next,5360).map(p=>p.head),endpoint,'safe completion cannot hide a later turn');
    }
    const authoritative=(await act(r,clone(s),5360,'p2')).state;
    assert.deepEqual(endpoint,authoritative.players.map(p=>({x:p.x+.5,y:p.y+.5})));
  }finally{r.close();}
});
