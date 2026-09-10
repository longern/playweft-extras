const EPS = 1e-9;
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const point = (cell, width) => ({ x: (cell - 1) % width + .5, y: Math.floor((cell - 1) / width) + .5 });

// One polyline owns both the body and the head, including partial grid segments.
export function displayPath(player, width) {
  if (player.path) return player.path;
  const path = (player.head ? player.trail.slice(0, -1) : player.trail).map(cell => point(cell, width));
  if (player.head) path.push({ ...player.head });
  return path.filter((p, i) => !i || distance(p, path[i - 1]) > EPS);
}

const length = path => path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0);

function sharedLength(a, b) {
  if (distance(a[0], b[0]) > EPS) return 0;
  let i = 1, j = 1, shared = 0, from = a[0];
  while (i < a.length && j < b.length) {
    const da = distance(from, a[i]), db = distance(from, b[j]);
    if (da < EPS) { i++; continue; }
    if (db < EPS) { j++; continue; }
    const ax = (a[i].x - from.x) / da, ay = (a[i].y - from.y) / da;
    const bx = (b[j].x - from.x) / db, by = (b[j].y - from.y) / db;
    if (Math.abs(ax - bx) > EPS || Math.abs(ay - by) > EPS) break;
    const step = Math.min(da, db);
    shared += step;
    from = { x: from.x + ax * step, y: from.y + ay * step };
    if (da <= db + EPS) i++;
    if (db <= da + EPS) j++;
  }
  return shared;
}

function prefix(path, travel) {
  const result = [path[0]];
  for (let i = 1; i < path.length && travel > EPS; i++) {
    const a = path[i - 1], b = path[i], segment = distance(a, b);
    if (segment <= EPS) continue;
    if (travel >= segment) result.push(b);
    else result.push({ x: a.x + (b.x - a.x) * travel / segment, y: a.y + (b.y - a.y) * travel / segment });
    travel -= segment;
  }
  return result;
}

export function correctionDistance(from, to) {
  return length(from) + length(to) - 2 * sharedLength(from, to);
}

// Retract an incorrect branch to its shared corner, then follow the new branch.
// Never interpolate x/y independently across a corner or leave body beyond head.
export function reconcilePath(from, to, progress) {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  const common = sharedLength(from, to), back = length(from) - common;
  const travel = (back + length(to) - common) * progress;
  return travel < back ? prefix(from, length(from) - travel) : prefix(to, common + travel - back);
}

export function withDisplayPath(player, path) {
  const head = path.at(-1), previous = path.at(-2);
  const dir = !previous ? player.dir : head.x > previous.x ? 0 : head.y > previous.y ? 1 : head.x < previous.x ? 2 : 3;
  return { ...player, path, head, dir };
}
