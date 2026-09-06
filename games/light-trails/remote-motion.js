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
    this.delay = 180;
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
      const target = clamp(percentile(this.ages) + Math.max(state.stepMs, percentile(this.gaps)) + 20, state.stepMs * 1.5, 480);
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
    this.cursor = Math.min(this.cursor + Math.min(dt, 100) * speed, state.lastStepAt + state.stepMs);
    const trail = player.trail;
    const cellPoint = cell => ({ x: (cell - 1) % state.width + .5, y: Math.floor((cell - 1) / state.width) + .5 });
    const latest = cellPoint(trail.at(-1));
    if (this.cursor > state.lastStepAt) {
      // Only one straight cell, and never through a wall or a known trail.
      const fraction = clamp((this.cursor - state.lastStepAt) / state.stepMs, 0, 1);
      const dx = [1, 0, -1, 0][player.dir], dy = [0, 1, 0, -1][player.dir];
      const x = Math.floor(latest.x) + dx, y = Math.floor(latest.y) + dy;
      const cell = y * state.width + x + 1;
      const blocked = x < 0 || y < 0 || x >= state.width || y >= state.height || state.players.some(p => p.trail.includes(cell));
      if (blocked) return { ...player, trail, head: latest };
      return { ...player, trail: [...trail, cell], head: { x: latest.x + dx * fraction, y: latest.y + dy * fraction } };
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
