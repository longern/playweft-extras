// Rendering prediction only. Lua remains authoritative for every collision/result.
export class Predictor {
  state = null;
  own = -1;
  pending = [];
  seq = 0;
  rtt = 0;
  receivedAt = 0;
  clockOffset = null;
  clockTarget = 0;
  clockAt = 0;
  receive(state, own, serverTime, now) {
    const reset = this.state?.round !== state.round || this.own !== own;
    const restartClock = reset || this.state?.phase === 'paused' || this.state?.phase === 'waiting';
    if (!restartClock && this.clockOffset !== null) this.now(now);
    this.clockTarget = serverTime + Math.min(this.rtt / 2, 240) - now;
    if (restartClock || this.clockOffset === null) this.clockOffset = this.clockTarget;
    this.clockAt = now;
    this.state = state; this.own = own;
    this.receivedAt = now;
    this.serverTime = serverTime;
    const player = state.players[own];
    if (reset) { this.pending = []; this.seq = player?.inputSeq || 0; }
    const acknowledged = player?.inputSeq || 0;
    this.seq = Math.max(this.seq, acknowledged);
    this.pending = this.pending.filter(input => input.seq > acknowledged);
    if (!['playing', 'countdown'].includes(state.phase)) this.pending = [];
  }
  now(time) {
    // Slew clock corrections rather than resetting animation phase on each packet.
    // At most 10% speed adjustment, so even a delayed snapshot cannot rewind time.
    const elapsed = Math.max(0, time - this.clockAt);
    const adjustment = Math.max(-elapsed * .1, Math.min(elapsed * .1, this.clockTarget - this.clockOffset));
    this.clockOffset += adjustment;
    this.clockAt = Math.max(this.clockAt, time);
    return time + this.clockOffset;
  }
  inputs() {
    const player = this.state?.players[this.own];
    const confirmed = Array.isArray(player?.inputs) ? player.inputs : [];
    let lastTick = this.state?.tick || 0;
    return [...confirmed, ...this.pending].map(input => {
      lastTick = Math.max(lastTick + 1, input.tick);
      return { ...input, tick: lastTick };
    });
  }
  enqueue(heading, time) {
    const state = this.state, player = state?.players[this.own];
    if (!player || !['playing', 'countdown'].includes(state.phase)) return null;
    const inputs = this.inputs();
    if (inputs.length >= 6) return null;
    const last = inputs.at(-1);
    const direction = last?.heading ?? player.dir;
    if (heading === direction || (heading - direction + 4) % 4 === 2) return null;
    const serverNow = this.now(time);
    // A segment already visible on screen must finish before a new turn can begin.
    const started = Math.max(0, Math.ceil((serverNow - state.lastStepAt) / state.stepMs - 1e-7));
    // Leave enough time for the request to reach the server, reducing late rescheduling.
    const arrival = serverNow + Math.min(this.rtt / 2, 240) + 16;
    const arrivalStep = Math.max(0, Math.floor((arrival - state.lastStepAt) / state.stepMs));
    const tick = Math.max(state.tick + 1, (last?.tick || 0) + 1, state.tick + started + 1, state.tick + arrivalStep + 1);
    if (tick > state.tick + 6) return null;
    const input = { seq: ++this.seq, tick, heading };
    this.pending.push(input);
    return input;
  }
  reject(seq) { this.pending = this.pending.filter(input => input.seq !== seq); }
  project(time) {
    const state = this.state, player = state?.players[this.own];
    if (!player || state.phase !== 'playing') return null;
    // Short, latency-aware horizon avoids repeatedly hitting a two-cell stop on slower links.
    const horizon = Math.min(4, Math.max(2, Math.ceil(this.rtt / state.stepMs) + 1));
    const ahead = Math.max(0, Math.min(horizon, (this.now(time) - state.lastStepAt) / state.stepMs));
    const occupied = new Set(state.players.flatMap(p => p.trail));
    const trail = [...player.trail], inputs = this.inputs();
    let { x, y, dir } = player;
    let tick = state.tick;
    let head = { x: x + .5, y: y + .5 };
    for (let step = 0; step < Math.ceil(ahead); step++) {
      tick++;
      const input = inputs[0];
      if (input && input.tick <= tick) {
        inputs.shift();
        if ((input.heading - dir + 4) % 4 !== 2) dir = input.heading;
      }
      const nx = x + [1, 0, -1, 0][dir], ny = y + [0, 1, 0, -1][dir];
      const cell = ny * state.width + nx + 1;
      const wall = nx < 0 || ny < 0 || nx >= state.width || ny >= state.height;
      const blocked = wall || occupied.has(cell);
      const fraction = Math.min(blocked ? (wall ? .05 : .2) : 1, ahead - step);
      head = { x: x + .5 + (nx - x) * fraction, y: y + .5 + (ny - y) * fraction };
      trail.push(blocked ? trail.at(-1) : cell);
      if (blocked) break; // Wait visibly at contact; only the server can declare defeat.
      occupied.add(cell);
      x = nx; y = ny;
    }
    return { ...player, trail, dir, head };
  }
}
