import test from 'node:test';
import assert from 'node:assert/strict';
import { displayPath, reconcilePath, withDisplayPath } from '../games/light-trails/render-path.js';
import { CollisionPlayback } from '../games/light-trails/collision-playback.js';

const p = (x,y) => ({x:x+.5,y:y+.5});
const cell = (x,y) => y*48+x+1;
function orthogonal(path) {
  for (let i=1;i<path.length;i++) assert.ok(Math.abs(path[i].x-path[i-1].x)<1e-8 || Math.abs(path[i].y-path[i-1].y)<1e-8, 'every body segment follows a grid axis');
}

test('branch corrections preserve corners and clip the body exactly at the head on every frame',()=>{
  const from=[p(8,10),p(9,10),p(10,10),p(10,11),p(10.7,11)];
  const to=[p(8,10),p(9,10),p(9,9),p(10,9),p(10,8.3)];
  assert.deepEqual(reconcilePath(from,to,0),from);
  assert.deepEqual(reconcilePath(from,to,1),to);
  let previous=from.at(-1);
  for(let i=0;i<=100;i++){
    const path=reconcilePath(from,to,i/100), frame=withDisplayPath({dir:0},path);
    orthogonal(path);assert.deepEqual(path.at(-1),frame.head);
    assert.ok(Math.hypot(frame.head.x-previous.x,frame.head.y-previous.y)<.1);
    previous=frame.head;
  }
  const partial=reconcilePath(from,to,.2);
  assert.deepEqual(reconcilePath(partial,to,0),partial,'another snapshot starts from the currently displayed body');
  const straight=[p(8,10),p(10.2,10)], subdivided=[p(8,10),p(9,10),p(10,10),p(11,10)];
  assert.ok(reconcilePath(straight,subdivided,.5).at(-1).x>straight.at(-1).x,'shared partial segments continue forwards');
});

test('partial movement never includes its unvisited destination cell',()=>{
  const path=displayPath({trail:[cell(8,10),cell(9,10),cell(9,9)],head:p(9,9.7)},48);
  assert.deepEqual(path,[p(8,10),p(9,10),p(9,9.7)]);
});

test('collision playback retracts a mistaken displayed turn without diagonal body segments',()=>{
  const state={round:1,tick:3,phase:'ended',reason:'collision',stepMs:180,width:48,
    players:[{dir:3,crashed:true,trail:[cell(8,10),cell(9,10),cell(9,9)],
      impact:{fromX:9,fromY:9,x:9,y:8,kind:'trail',owner:2}},
      {dir:2,trail:[cell(20,20)]}]};
  const shown={trail:[cell(8,10),cell(9,10),cell(10,10),cell(10,11)],path:[p(8,10),p(9,10),p(10,10),p(10,10.4)],head:p(10,10.4)};
  const motion=new CollisionPlayback();motion.receive(state,[shown],0);
  assert.deepEqual(motion.project(0,0).path,shown.path);
  for(let time=0;time<=motion.finishAt;time++){
    const frame=motion.project(0,time);orthogonal(frame.path);
    assert.deepEqual(frame.path.at(-1),frame.head);
  }
});
