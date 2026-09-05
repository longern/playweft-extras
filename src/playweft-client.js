/** Playweft bridge v1. All networking and identity stay in the parent platform. */
export class PlayweftBridge extends EventTarget {
  port = null;
  pending = new Map();
  matchId = null;
  version = -1;
  context = null;
  latest = null;

  constructor() {
    super();
    this.onWindowMessage = (event) => {
      if (this.port || event.source !== window.parent ||
          event.data?.type !== 'playweft:bridge' || event.data?.version !== 1 || !event.ports[0]) return;
      this.port = event.ports[0];
      clearInterval(this.probe);
      this.port.onmessage = (event) => this.receive(event.data);
      this.port.start();
      this.call('game.initialize').then((context) => {
        this.context = context;
        this.emit('initialize', context);
        if (this.latest) this.emit('state', this.latest);
      }).catch((error) => this.emit('error', error));
    };
    window.addEventListener('message', this.onWindowMessage);
    const announce = () => window.parent.postMessage({ type: 'playweft:bridge-ready', version: 1 }, '*');
    if (window.parent !== window) {
      this.probe = setInterval(announce, 500);
      announce();
    }
    window.addEventListener('pagehide', () => this.close(), { once: true });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  receive(message) {
    if (message?.jsonrpc !== '2.0') return;
    if (Object.hasOwn(message, 'id')) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), { data: message.error.data }));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'game.state') {
      const next = message.params;
      if (!next?.state || !Number.isInteger(next.version)) return;
      if (next.matchId !== this.matchId) { this.matchId = next.matchId; this.version = -1; }
      if (next.version <= this.version) return;
      this.version = next.version;
      this.latest = next;
      if (this.context) this.emit('state', next);
    } else if (message.method === 'platform.latency') {
      this.emit('latency', message.params);
    } else if (message.method === 'platform.error') {
      this.emit('error', new Error(message.params?.error?.message || 'Connection unavailable'));
    }
  }

  call(method, params) {
    if (!this.port) return Promise.reject(new Error('Bridge not connected'));
    // Bounded even when a parent disappears without closing the MessagePort.
    if (this.pending.size >= 8) return Promise.reject(new Error('Too many pending actions'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Connection timed out'));
      }, 2500);
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  action(action) { return this.call('room.action', { action }); }

  close() {
    clearInterval(this.probe);
    window.removeEventListener('message', this.onWindowMessage);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Game closed')); }
    this.pending.clear();
    this.port?.close();
  }
}
