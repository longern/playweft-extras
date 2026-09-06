const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const cellPoint = (cell, width) => ({ x: (cell - 1) % width + .5, y: Math.floor((cell - 1) / width) + .5 });

// Match the drawn .9-cell heads and .7-cell trails. This is presentation geometry,
// not a second collision rule: the authority supplies the fatal move and obstacle.
export function impactContact(state, index) {
  const player = state.players[index], impact = player.impact;
  if (!impact) return null;
  const from = { x: impact.fromX + .5, y: impact.fromY + .5 };
  const dx = impact.x - impact.fromX, dy = impact.y - impact.fromY;
  let fraction = impact.kind === 'wall' ? .05 : .2;
  if (impact.kind === 'head') {
    const other = state.players[impact.owner - 1]?.impact;
    if (other) {
      // Swept AABB contact for opposing, perpendicular and head-swap moves.
      let enter = 0, leave = 1;
      for (const [axis, origin] of [['x', 'fromX'], ['y', 'fromY']]) {
        const delta = impact[origin] - other[origin];
        const velocity = impact[axis] - impact[origin] - (other[axis] - other[origin]);
        if (velocity === 0) { if (Math.abs(delta) > .9) leave = -1; continue; }
        const a = (-.9 - delta) / velocity, b = (.9 - delta) / velocity;
        enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
      }
      if (enter <= leave) fraction = clamp(enter, 0, 1);
    }
  }
  const head = { x: from.x + dx * fraction, y: from.y + dy * fraction };
  return { head, point: { x: head.x + dx * .45, y: head.y + dy * .45 } };
}

export class CollisionPlayback {
  reset() { this.key = null; this.state = null; this.plans = []; this.finishAt = 0; }
  constructor() { this.reset(); }
  receive(state, rendered, now) {
    if (state.phase !== 'ended' || state.reason !== 'collision') { this.reset(); return; }
    const key = `${state.round}:${state.tick}`;
    if (key === this.key) return; // Rematch votes and duplicate packets cannot restart it.
    this.key = key; this.state = state; this.startedAt = now;
    this.plans = state.players.map((player, index) => {
      const trail = player.trail;
      const nodes = trail.map((cell, i) => ({ ...cellPoint(cell, state.width), count: i + 1 }));
      const contact = impactContact(state, index);
      if (contact) nodes.push({ ...contact.head, count: trail.length });
      const shown = rendered[index]?.head || cellPoint(rendered[index]?.trail.at(-1) || trail.at(-1), state.width);
      // Find the last displayed position on the final authoritative path. Correct a
      // mistaken extrapolation over the short approach, then follow every corner.
      let closest = { error: Infinity, segment: Math.max(0, nodes.length - 2), point: nodes.at(-1) };
      for (let i = Math.max(0, nodes.length - 9); i < nodes.length - 1; i++) {
        const a = nodes[i], b = nodes[i + 1], dx = b.x - a.x, dy = b.y - a.y;
        const t = clamp(((shown.x - a.x) * dx + (shown.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
        const point = { ...lerp(a, b, t), count: a.count };
        const error = distance(shown, point);
        if (error < closest.error) closest = { error, segment: i, point };
      }
      const start = { ...shown, count: closest.point.count };
      const route = [start, closest.point, ...nodes.slice(closest.segment + 1)];
      let total = 0;
      const lengths = route.slice(1).map((p, i) => { const d = distance(route[i], p); total += d; return d; });
      return { route, lengths, total, contact, duration: clamp(total * state.stepMs, 80, 300) };
    });
    this.impactAt = now + Math.max(...this.plans.map(p => p.duration));
    this.finishAt = this.impactAt + 200;
  }
  pending(now) { return this.state !== null && now < this.finishAt; }
  project(index, now) {
    if (!this.state) return null;
    const player = this.state.players[index], plan = this.plans[index];
    const progress = clamp((now - this.startedAt) / (this.impactAt - this.startedAt), 0, 1);
    let travel = plan.total * progress;
    let head = plan.route.at(-1), count = head.count, dir = player.dir;
    for (let i = 0; i < plan.lengths.length; i++) {
      const length = plan.lengths[i];
      if (length > 0 && travel < length) {
        const a = plan.route[i], b = plan.route[i + 1];
        head = lerp(a, b, travel / length); count = a.count;
        dir = b.x > a.x ? 0 : b.y > a.y ? 1 : b.x < a.x ? 2 : 3;
        break;
      }
      travel -= length;
    }
    const trail = player.trail.slice(0, count);
    trail.push(trail.at(-1)); // Let the renderer draw the final partial segment.
    return { ...player, trail, head: { x: head.x, y: head.y }, dir, crashed: player.crashed && progress === 1,
      impactPoint: progress === 1 ? plan.contact?.point : null };
  }
}
