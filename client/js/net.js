// WebSocket client with automatic reconnection and typed handlers.

import { decodeSnapshot, MSG_SNAPSHOT } from '/shared/protocol.js';

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.connected = false;
    this.retry = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.rtt = 0;
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  connect() {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url());
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.retry = 0;
        this.emit('open');
        resolve(true);
      };
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        this.emit('close', was);
        const delay = Math.min(5000, 500 * 2 ** this.retry++);
        setTimeout(() => this.connect(), delay);
        resolve(false);
      };
      ws.onerror = () => {};
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          this.bytesIn += e.data.length;
          let msg;
          try { msg = JSON.parse(e.data); } catch { return; }
          if (msg.t === 'ping') { this.send({ t: 'pong', s: msg.s }); return; }
          if (msg.t === 'pong') { this.rtt = performance.now() - msg.c; return; }
          this.emit(msg.t, msg);
        } else {
          this.bytesIn += e.data.byteLength;
          const view = new DataView(e.data);
          if (view.getUint8(0) === MSG_SNAPSHOT) this.emit('snapshot', decodeSnapshot(view));
        }
      };
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  emit(type, data) {
    const set = this.handlers.get(type);
    if (set) for (const fn of set) fn(data);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      const s = JSON.stringify(obj);
      this.bytesOut += s.length;
      this.ws.send(s);
    }
  }

  sendBinary(buf) {
    if (this.ws && this.ws.readyState === 1) {
      this.bytesOut += buf.byteLength;
      this.ws.send(buf);
    }
  }

  measureRtt() { this.send({ t: 'ping', c: performance.now() }); }
}
