import { displayPath, correctionDistance, reconcilePath, withDisplayPath } from './render-path.js';
import { impactContact } from './collision-playback.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const point = (cell, width) => ({x:(cell - 1) % width + .5, y:Math.floor((cell - 1) / width) + .5});
const array = v => Array.isArray(v) ? v : [];

// Own inputs respond at the next grid corner without awaiting acknowledgement.
// Remote motion uses a short delayed path and accepted turns, never three blind cells.
export class GameSync {
  rtt = 0;
  reset() {
    this.state = null; this.own = -1; this.pending = []; this.seq = 0;
    this.offset = null; this.targetOffset = 0; this.clockAt = 0;
    this.cursor = null; this.localCursor = null; this.frameAt = null; this.waiting = false;
    this.corrections = []; this.correctedAt = 0;
  }
  constructor() { this.reset(); }
  now(time) {
    if (this.offset === null) return time;
    const dt = Math.max(0, time - this.clockAt);
    this.offset += clamp(this.targetOffset - this.offset, -dt * .1, dt * .1);
    this.clockAt = Math.max(this.clockAt, time);
    return time + this.offset;
  }
  receive(state, own, serverTime, time) {
    const restart = !this.state || state.round !== this.state.round || state.timeline !== this.state.timeline || own !== this.own;
    const before = restart ? null : this.project(time);
    if (restart) this.reset();
    else this.now(time);
    this.targetOffset = serverTime + Math.min(this.rtt / 2, 500) - time;
    if (this.offset === null) this.offset = this.targetOffset;
    this.clockAt = time; this.state = state; this.own = own;
    this.seq = Math.max(this.seq, state.players[own]?.inputSeq || 0);
    this.pending = this.pending.filter(i => i.seq > (state.players[own]?.inputSeq || 0));
    if (!['playing', 'countdown'].includes(state.phase)) this.pending = [];
    const after = this.raw(time);
    this.corrections = after?.map((p,i) => {
      if (!before?.[i]) return null;
      const path = displayPath(before[i], state.width);
      const distance = correctionDistance(path, displayPath(p, state.width));
      return distance > 1e-8 ? { path, distance, duration: clamp(distance * 80, 100, 240) } : null;
    }) || [];
    this.correctedAt = time;
  }
  inputs() {
    let tick = this.state?.tick || 0;
    return [...array(this.state?.players[this.own]?.inputs), ...this.pending].map(i => {
      tick = Math.max(tick+1,i.tick); return {...i,tick};
    });
  }
  enqueue(heading, time = this.clockAt) {
    const state = this.state, p = state?.players[this.own];
    if (!p || !['playing','countdown'].includes(state.phase)) return null;
    const inputs = this.inputs(), direction = inputs.at(-1)?.heading ?? p.dir;
    if (inputs.length >= 2 || heading === direction || (heading - direction + 4) % 4 === 2) return null;
    // Finish the segment already visible; start turning at the next corner.
    this.raw(time);
    const current = this.localCursor ?? this.now(time);
    const started = Math.max(0, Math.ceil((current-state.lastStepAt)/state.stepMs - 1e-7));
    const tick = Math.max(state.tick+started+1,(inputs.at(-1)?.tick || 0)+1);
    const input = {seq:++this.seq,heading,tick}; this.pending.push(input); return input;
  }
  reject(seq) { this.pending = this.pending.filter(i => i.seq !== seq); }
  raw(time) {
    const state = this.state;
    if (!state || state.phase !== 'playing') {this.waiting=false;return null;}
    const serverTime = Math.max(state.startsAt || 0,this.now(time));
    const remoteTime = Math.max(state.startsAt || 0,serverTime-clamp(this.rtt/2+80,100,220));
    const dt = Math.min(100,Math.max(0,time-(this.frameAt ?? time)));this.frameAt=time;
    const remoteLimit=state.lastStepAt+state.stepMs;
    const ownLimit=state.lastStepAt+state.stepMs*Math.min(4,Math.max(2,Math.ceil(this.rtt/state.stepMs)+1));
    this.cursor ??= Math.min(remoteTime,remoteLimit);
    this.localCursor ??= Math.min(serverTime,ownLimit);
    this.cursor = Math.min(remoteLimit,this.cursor+dt*(1+clamp((remoteTime-this.cursor)/400,-.1,.15)));
    this.localCursor = Math.min(ownLimit,this.localCursor+dt*(1+clamp((serverTime-this.localCursor)/400,-.1,.15)));
    this.waiting=serverTime>ownLimit+30;
    const rendered=sampleMotion(state,this.cursor);
    if(this.own>=0){
      const predicted={...state,players:state.players.map((p,i)=>i===this.own?{...p,inputs:this.inputs()}:p)};
      rendered[this.own]=sampleMotion(predicted,this.localCursor,this.own)[this.own];
    }
    return rendered;
  }
  project(time) {
    const rendered=this.raw(time);if(!rendered)return null;
    return rendered.map((p,i) => {
      const path = displayPath(p, this.state.width), correction = this.corrections[i];
      const progress = correction ? clamp((time - this.correctedAt) / correction.duration, 0, 1) : 1;
      if (progress >= 1) return withDisplayPath(p, path);
      const distance = correctionDistance(correction.path, path);
      const travel = distance > 1e-8 ? clamp(1 - correction.distance * (1 - progress) / distance, 0, 1) : 1;
      return withDisplayPath(p, reconcilePath(correction.path, path, travel));
    });
  }
}

export function sampleMotion(state, time, localOnly = -1) {
  const {stepMs,width,height}=state;
  if (time <= state.lastStepAt) {
    const behind = Math.max(0, (state.lastStepAt - Math.max(time, state.startsAt || 0)) / stepMs);
    return state.players.map(p => {
      const d = Math.max(0,p.trail.length - 1 - behind), i = Math.floor(d), f = d - i;
      const a = point(p.trail[i],width), b = point(p.trail[Math.min(i+1,p.trail.length-1)],width);
      const dir = b.x > a.x ? 0 : b.y > a.y ? 1 : b.x < a.x ? 2 : b.y < a.y ? 3 : p.dir;
      const trail = p.trail.slice(0,i+1); trail.push(trail.at(-1));
      return {...p,dir,trail,head:{x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f}};
    });
  }
  const players = state.players.map(p => ({...p,trail:[...p.trail],inputs:[...array(p.inputs)],head:point(p.trail.at(-1),width)}));
  const occupied = new Map();
  players.forEach((p,i) => p.trail.forEach(c => occupied.set(c,i+1)));
  const ahead = (time - state.lastStepAt) / stepMs;
  for (let n=0;n<Math.ceil(ahead);n++) {
    const tick = state.tick+n+1;
    const moves = players.map((p,i) => {
      if(localOnly>=0 && i!==localOnly)return {x:p.x,y:p.y,cell:p.y*width+p.x+1,hit:false,frozen:true};
      const input = p.inputs[0];
      if (input && input.tick <= tick) { p.inputs.shift(); if ((input.heading-p.dir+4)%4 !== 2) p.dir=input.heading; }
      const x=p.x+[1,0,-1,0][p.dir],y=p.y+[0,1,0,-1][p.dir],cell=y*width+x+1;
      const wall=x<0||y<0||x>=width||y>=height,owner=occupied.get(cell)||0;
      return {x,y,cell,hit:wall||owner!==0,kind:wall?'wall':'trail',owner};
    });
    if (localOnly<0 && ((moves[0].x===moves[1].x && moves[0].y===moves[1].y) || (moves[0].x===players[1].x && moves[0].y===players[1].y && moves[1].x===players[0].x && moves[1].y===players[0].y))) {
      moves.forEach((m,i) => {m.hit=true;m.kind='head';m.owner=2-i;});
    }
    players.forEach((p,i) => {
      const m=moves[i];
      p.impact=m.hit?{fromX:p.x,fromY:p.y,x:m.x,y:m.y,kind:m.kind,owner:m.owner}:null;
    });
    const contacts=players.map((p,i)=>moves[i].hit?impactContact({players},i):null);
    const fraction=Math.min(1,ahead-n);
    players.forEach((p,i) => {
      const m=moves[i],from={x:p.x+.5,y:p.y+.5};
      if(m.frozen)return;
      const contact=contacts[i];
      const cap=contact?Math.abs(contact.head.x-from.x)+Math.abs(contact.head.y-from.y):1;
      const f=Math.min(fraction,cap);
      p.head={x:from.x+(m.x-p.x)*f,y:from.y+(m.y-p.y)*f};
      p.trail.push(m.hit?p.trail.at(-1):m.cell);
      if (!m.hit) {p.x=m.x;p.y=m.y;}
      p.impact=null; // Presentation must wait for the authoritative terminal event.
    });
    if (moves.some(m=>m.hit)) break;
    moves.forEach((m,i)=>occupied.set(m.cell,i+1));
  }
  return players;
}
