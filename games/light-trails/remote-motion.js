const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Each authoritative snapshot contains the full trail, so it already acts as a
// compact history buffer. Keep a separate, monotonic playhead through that history.
export class RemoteMotion {
  reset() {
    this.state = null;
    this.cursor = null;
    this.frameAt = null;
    this.advanceAt = null;
    this.gaps = [];
    this.ages = [];
    this.delay = 60;
  }
  constructor() { this.reset(); }
  receive(state, now, serverNow) {
    const old = this.state;
    if (!old || old.round !== state.round || state.tick < old.tick || old.phase !== 'playing' || state.phase !== 'playing') {
      this.reset();
    }
    if (state.phase === 'playing') {
      if (this.advanceAt !== null && old?.tick < state.tick) {
        this.gaps.push(clamp(now - this.advanceAt, 1, 1000));
        if (this.gaps.length > 24) this.gaps.shift();
      }
      if (this.advanceAt === null || old?.tick < state.tick) {
        this.advanceAt = now;
        this.ages.push(clamp(serverNow - state.lastStepAt, 0, 1000));
        if (this.ages.length > 24) this.ages.shift();
      }
      const percentile = values => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * .9)] || 0;
      // Use actual advancing-snapshot cadence, not RTT alone. Duplicate-step
      // acknowledgements do not pretend that fresh movement has arrived.
      // Buffer only jitter, not network age plus a whole packet interval. Straight
      // extrapolation covers transit time; a deep buffer hides solid obstacles.
      const lowGap = [...this.gaps].sort((a, b) => a - b)[Math.floor((this.gaps.length - 1) * .1)] || state.stepMs;
      const target = clamp((percentile(this.gaps) - lowGap) / 2, 60, 120);
      this.delay = target > this.delay ? target : Math.max(target, this.delay - 2);
    }
    this.state = state;
    if (this.cursor === null) {
      this.cursor = serverNow - this.delay;
      this.frameAt = now;
    }
  }
  project(index, now, serverNow) {
    const state = this.state;
    if (!state || state.phase !== 'playing') return null;
    const player = state.players[index];
    if (!player?.trail.length) return null;
    const dt = Math.max(0, now - this.frameAt);
    this.frameAt = now;
    const target = serverNow - this.delay;
    // Changing buffer depth changes playback speed slightly, never its position.
    const speed = 1 + clamp((target - this.cursor) / (state.stepMs * 4), -.15, .15);
    this.cursor = Math.min(this.cursor + Math.min(dt, 100) * speed, state.lastStepAt + state.stepMs * 3);
    const trail = player.trail;
    const cellPoint = cell => ({ x: (cell - 1) % state.width + .5, y: Math.floor((cell - 1) / state.width) + .5 });
    const latest = cellPoint(trail.at(-1));
    if (this.cursor > state.lastStepAt) {
      // At most three straight cells. Never invent a turn or cross a known solid.
      const ahead = clamp((this.cursor - state.lastStepAt) / state.stepMs, 0, 3);
      const dx = [1, 0, -1, 0][player.dir], dy = [0, 1, 0, -1][player.dir];
      const extended = [...trail], occupied = new Set(state.players.flatMap(p => p.trail));
      let head = latest;
      for (let step = 0; step < Math.ceil(ahead); step++) {
        const x = Math.floor(latest.x) + dx * (step + 1), y = Math.floor(latest.y) + dy * (step + 1);
        const cell = y * state.width + x + 1;
        const wall = x < 0 || y < 0 || x >= state.width || y >= state.height;
        const blocked = wall || occupied.has(cell);
        const fraction = Math.min(ahead - step, blocked ? (wall ? .05 : .2) : 1);
        head = { x: latest.x + dx * (step + fraction), y: latest.y + dy * (step + fraction) };
        // Duplicate endpoint is a render sentinel, never an authoritative cell.
        extended.push(blocked ? extended.at(-1) : cell);
        if (blocked) break;
      }
      return { ...player, trail: extended, head };
    }
    const distance = Math.max(0, trail.length - 1 - (state.lastStepAt - this.cursor) / state.stepMs);
    const start = Math.floor(distance), fraction = distance - start;
    const a = cellPoint(trail[start]), b = cellPoint(trail[Math.min(start + 1, trail.length - 1)]);
    const dir = b.x > a.x ? 0 : b.y > a.y ? 1 : b.x < a.x ? 2 : b.y < a.y ? 3 : player.dir;
    // Keep the final point as the interpolation endpoint, even on exact corners.
    return { ...player, dir, trail: trail.slice(0, Math.min(start + 2, trail.length)),
      head: { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction } };
  }
}
