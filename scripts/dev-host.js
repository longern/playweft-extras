const iframe = document.getElementById('game');
const seat = new URLSearchParams(location.search).get('seat') || '1';
let port, playerId, latest, socket, initializeId;
const waiting = new Map();
function send(message) { port?.postMessage({ jsonrpc: '2.0', ...message }); }
function initialize() {
  if (!initializeId || !playerId) return;
  send({ id: initializeId, result: { mode: 'room', protocolVersion: 1, playerId, capabilities: [] } });
  initializeId = null;
  if (latest) send({ method: 'game.state', params: latest });
}
function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/__dev/socket?seat=${seat}`);
  socket.addEventListener('open', () => { document.getElementById('status').textContent = '已连接'; });
  socket.addEventListener('close', () => {
    document.getElementById('status').textContent = '连接恢复中';
    for (const id of waiting.keys()) send({ id, error: { code: -32000, message: 'Disconnected' } });
    waiting.clear();
    setTimeout(connect, 500);
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'identity') { playerId = message.playerId; initialize(); return; }
    if (message.type === 'state') { latest = message.params; send({ method: 'game.state', params: latest }); }
    if (message.type === 'result') {
      waiting.delete(message.id);
      send({ id: message.id, ...(message.error ? { error: message.error } : { result: message.result }) });
    }
  });
}
connect();
window.addEventListener('message', (event) => {
  if (event.source !== iframe.contentWindow || event.origin !== location.origin || event.data?.type !== 'playweft:bridge-ready' || port) return;
  const channel = new MessageChannel();
  port = channel.port1;
  port.onmessage = ({ data: message }) => {
    if (message.method === 'game.initialize') {
      initializeId = message.id;
      initialize();
    } else if (message.method === 'room.action') {
      if (socket.readyState !== WebSocket.OPEN) { send({ id: message.id, error: { code: -32000, message: 'Disconnected' } }); return; }
      waiting.set(message.id, true);
      socket.send(JSON.stringify({ id: message.id, action: message.params.action }));
    }
  };
  port.start();
  iframe.contentWindow.postMessage({ type: 'playweft:bridge', version: 1 }, location.origin, [channel.port2]);
});
document.getElementById('reset').addEventListener('click', () => fetch('/__dev/reset', { method: 'POST' }));
