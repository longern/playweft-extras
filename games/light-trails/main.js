import { PlayweftBridge } from '../../src/playweft-client.js';

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');
const bridge = new PlayweftBridge();
const colors = ['#78e9e4', '#ff9b7e'];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let state = null, ownIndex = -1, lastReceived = 0, serverAtReceipt = 0;
let pulsePending = false, turnPending = false, rematchPending = false;
let boardPixels = 0, boardHeight = 0;
const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };

function serverNow() { return serverAtReceipt + performance.now() - lastReceived; }
function fresh() { return state && performance.now() - lastReceived < 1800; }
function canTurn() { return fresh() && ownIndex >= 0 && ['playing', 'countdown'].includes(state.phase); }

bridge.addEventListener('initialize', ({ detail }) => {
  if (detail.mode !== 'room') {
    setText('overlay-title', '无法开始游戏');
    setText('overlay-description', '请从双人房间进入。');
  }
});
bridge.addEventListener('state', ({ detail }) => {
  state = detail.state;
  $('game').classList.remove('title-screen');
  $('match-hud').hidden = false;
  $('launch').hidden = $('help').hidden = true;
  if (state.phase !== 'ended') setText('hint', '');
  lastReceived = performance.now();
  serverAtReceipt = detail.serverTime;
  ownIndex = state.players.findIndex((p) => p.id === bridge.context?.playerId);
  document.documentElement.style.setProperty('--accent', colors[Math.max(0, ownIndex)]);
  state.players.forEach((p, i) => {
    $(`player-${i + 1}`).classList.toggle('is-you', i === ownIndex);
    setText(`name-${i + 1}`, p.name);
    setText(`role-${i + 1}`, '你');
    $(`role-${i + 1}`).hidden = i !== ownIndex;
    setText(`score-${i + 1}`, String(p.score));
  });
  setText('round', `第 ${state.round} 局`);
  $('controls').hidden = ownIndex < 0;
  $('spectator').hidden = ownIndex >= 0;
});
bridge.addEventListener('error', () => {
  setText('connection', '连接中断');
  $('connection').hidden = false;
  $('connection').classList.add('bad');
});

async function action(type, extra = {}) {
  const result = await bridge.action({ type, round: state.round, ...extra });
  if (result?.accepted === false && result.error?.code !== 'STALE_ROUND') {
    throw new Error(result.error?.message || 'Action rejected');
  }
  return result;
}

// Both players send pulses; the server clock determines progress, never pulse count.
// One outstanding pulse bounds backpressure. Hidden tabs stop; the other side pauses.
setInterval(async () => {
  if (!state || ownIndex < 0 || document.hidden || pulsePending || ['ended', 'closed'].includes(state.phase)) return;
  pulsePending = true;
  try { await action('pulse'); } catch { /* The freshness indicator handles outages. */ }
  finally { pulsePending = false; }
}, 100);

async function turn(direction) {
  if (!canTurn() || turnPending) return;
  const button = $(direction < 0 ? 'left' : 'right');
  button.classList.add('flash');
  setTimeout(() => button.classList.remove('flash'), 120);
  turnPending = true;
  try { await action('turn', { direction }); } catch { /* Keep input recoverable. */ }
  finally { turnPending = false; }
}

for (const [id, direction] of [['left', -1], ['right', 1]]) {
  $(id).addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void turn(direction);
  });
  // Keyboard and assistive-technology activation generates a click with detail=0.
  $(id).addEventListener('click', (event) => { if (event.detail === 0) void turn(direction); });
}
window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  const key = event.key.toLowerCase();
  if (['arrowleft', 'a', 'arrowright', 'd'].includes(key)) {
    event.preventDefault();
    void turn(key === 'arrowleft' || key === 'a' ? -1 : 1);
  }
});
$('replay').addEventListener('click', async () => {
  if (rematchPending || ownIndex < 0 || state?.phase !== 'ended') return;
  rematchPending = true;
  setText('hint', '');
  try { await action('rematch'); }
  catch { setText('hint', '操作失败，请重试。'); }
  finally { rematchPending = false; }
});

new ResizeObserver(() => {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  boardPixels = rect.width;
  boardHeight = rect.height;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}).observe(canvas);

function renderBoard() {
  const width = state?.width || 48, height = state?.height || 27;
  const unit = boardPixels / width;
  ctx.clearRect(0, 0, boardPixels, boardHeight);
  ctx.strokeStyle = '#82bdb418';
  ctx.lineWidth = .5;
  ctx.beginPath();
  for (let x = 1; x < width; x++) {
    ctx.moveTo(x * unit, 0); ctx.lineTo(x * unit, boardHeight);
  }
  for (let y = 1; y < height; y++) {
    ctx.moveTo(0, y * unit); ctx.lineTo(boardPixels, y * unit);
  }
  ctx.stroke();
  // Quiet, static light paths frame the title screen before a room is connected.
  if (!state) {
    const paths = [
      [[0, 20], [8, 20], [8, 5], [18, 5], [18, 9]],
      [[48, 7], [40, 7], [40, 22], [30, 22], [30, 18]],
    ];
    paths.forEach((points, index) => {
      ctx.strokeStyle = colors[index]; ctx.globalAlpha = .45;
      ctx.lineWidth = unit * .55;
      ctx.beginPath();
      points.forEach(([x, y], i) => i ? ctx.lineTo(x * unit, y * unit) : ctx.moveTo(x * unit, y * unit));
      ctx.stroke();
      const [x, y] = points.at(-1);
      ctx.fillStyle = colors[index];
      ctx.fillRect((x - .4) * unit, (y - .4) * unit, unit * .8, unit * .8);
    });
    ctx.globalAlpha = 1;
    return;
  }
  const progress = !reducedMotion && state.phase === 'playing'
    ? Math.max(0, Math.min(1, (serverNow() - state.lastStepAt) / state.stepMs)) : 1;
  const point = (cell) => ({ x: ((cell - 1) % width + .5) * unit, y: (Math.floor((cell - 1) / width) + .5) * unit });
  state.players.forEach((player, index) => {
    const points = player.trail.map(point);
    let head = points.at(-1);
    if (!head) return;
    if (points.length > 1) {
      const previous = points.at(-2);
      head = { x: previous.x + (head.x - previous.x) * progress, y: previous.y + (head.y - previous.y) * progress };
    }
    ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
    ctx.lineWidth = unit * .7;
    ctx.strokeStyle = colors[index];
    ctx.globalAlpha = .72;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.lineTo(head.x, head.y); ctx.stroke();
    // A fine bright core keeps long trails legible without a costly full-board blur.
    ctx.lineWidth = Math.max(.7, unit * .16);
    ctx.strokeStyle = '#eafff5'; ctx.globalAlpha = .48; ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.shadowColor = colors[index]; ctx.shadowBlur = unit * 1.7;
    ctx.fillStyle = colors[index];
    ctx.fillRect(head.x - unit * .45, head.y - unit * .45, unit * .9, unit * .9);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#081416';
    ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(player.dir * Math.PI / 2);
    ctx.beginPath(); ctx.moveTo(unit * .25, 0); ctx.lineTo(-unit * .12, -unit * .21); ctx.lineTo(-unit * .12, unit * .21); ctx.fill(); ctx.restore();
    if (player.crashed) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(head.x, head.y, unit * 1.2, 0, Math.PI * 2); ctx.stroke();
    }
  });
}

function renderUI() {
  if (!state) return;
  const spectator = ownIndex < 0;
  const done = ['ended', 'closed'].includes(state.phase);
  const stale = !fresh() && !done;
  const seconds = Math.floor((state.tick || 0) * state.stepMs / 1000);
  setText('elapsed', `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
  $('connection').hidden = true;
  $('connection').classList.toggle('bad', stale);
  $('left').disabled = $('right').disabled = !canTurn();
  $('overlay').hidden = state.phase === 'playing' && !stale;
  $('overlay').classList.toggle('countdown', state.phase === 'countdown' && !stale);
  $('replay').hidden = state.phase !== 'ended' || spectator;
  $('replay').disabled = rematchPending || (ownIndex >= 0 && state.players[ownIndex].rematch);
  const ownName = spectator ? '观战中' : `你是${ownIndex === 0 ? '蓝方' : '橙方'}`;
  $('eyebrow').hidden = true;
  $('overlay').classList.toggle('result', state.phase === 'ended');
  if (state.phase === 'closed') {
    setText('overlay-title', '对局结束');
    setText('overlay-description', '对手已离开，请从菜单返回房间。');
  } else if (stale || state.phase === 'paused') {
    setText('overlay-title', '对局暂停');
    setText('overlay-description', '等待玩家重新连接。');
  } else if (state.phase === 'waiting') {
    setText('overlay-title', '等待玩家');
    setText('overlay-description', '');
  } else if (state.phase === 'countdown') {
    setText('overlay-title', String(Math.max(1, Math.ceil((state.startsAt - serverNow()) / 1000))));
    setText('overlay-description', ownName);
  } else if (state.phase === 'ended') {
    setText('overlay-title', state.winner === 0 ? '平局' : spectator ? `${state.winner === 1 ? '蓝方' : '橙方'}获胜` : state.winner === ownIndex + 1 ? '胜利' : '失败');
    setText('overlay-description', !spectator && state.players[1 - ownIndex].rematch && !state.players[ownIndex].rematch ? '对手请求再战' : '');
    const ready = ownIndex >= 0 && state.players[ownIndex].rematch;
    setText('replay-label', ready ? '等待对手' : rematchPending ? '提交中…' : '再来一局');
  }
}

if (window.parent === window) {
  $('game').classList.add('title-screen');
  setText('overlay-title', '光尾蛇');
  setText('overlay-description', '');
  $('eyebrow').hidden = false;
  $('help').hidden = false;
  $('launch').hidden = false;
  $('launch').href = `https://play.longern.com/?game=${encodeURIComponent(new URL('./playweft.json', location.href).href)}`;
}

function frame() {
  renderBoard(); renderUI(); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
