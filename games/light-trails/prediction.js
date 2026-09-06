// Rendering prediction only. Lua remains authoritative for every collision/result.
export class Predictor {
  state = null;
  own = -1;
  pending = [];
  seq = 0;
  rtt = 0;
  receivedAt = 0;
  receive(state, own, serverTime, now) {
    const reset = this.state?.round !== state.round || this.own !== own;
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
  now(time) { return this.serverTime + Math.min(this.rtt / 2, 240) + time - this.receivedAt; }
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
    const estimate = state.tick + Math.max(0, Math.floor((this.now(time) - state.lastStepAt) / state.stepMs));
    const tick = Math.max(state.tick + 1, (last?.tick || 0) + 1, Math.min(estimate + 1, state.tick + 6));
    if (tick > state.tick + 6) return null;
    const input = { seq: ++this.seq, tick, heading };
    this.pending.push(input);
    return input;
  }
  reject(seq) { this.pending = this.pending.filter(input => input.seq !== seq); }
  project(time) {
    const state = this.state, player = state?.players[this.own];
    if (!player || state.phase !== 'playing') return null;
    // At most two cells beyond the latest authoritative state; never extrapolate an outage.
    const ahead = Math.max(0, Math.min(2, (this.now(time) - state.lastStepAt) / state.stepMs));
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
      if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height || occupied.has(cell)) break;
      const fraction = Math.min(1, ahead - step);
      head = { x: x + .5 + (nx - x) * fraction, y: y + .5 + (ny - y) * fraction };
      trail.push(cell); occupied.add(cell);
      x = nx; y = ny;
    }
    return { ...player, trail, dir, head };
  }
}
