// End-to-end: real HTTP + WebSocket server on an ephemeral port, two clients, quick match,
// map download, readiness, binary snapshots and authoritative movement from inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';
import { encodeInputs, decodeSnapshot, MSG_SNAPSHOT, PF } from '../shared/protocol.js';
import { BTN } from '../shared/constants.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c = { ws, msgs: [], snaps: [], waiters: [] };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(data);
      if (buf[0] === MSG_SNAPSHOT) c.snaps.push(decodeSnapshot(buf));
    } else {
      const m = JSON.parse(data.toString());
      if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', s: m.s }));
      c.msgs.push(m);
    }
    for (const w of [...c.waiters]) if (w.check()) { c.waiters.splice(c.waiters.indexOf(w), 1); w.resolve(); }
  });
  c.open = new Promise((r) => ws.on('open', r));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.until = (fn, ms = 8000) => new Promise((resolve, reject) => {
    if (fn()) return resolve();
    const w = { check: fn, resolve };
    c.waiters.push(w);
    setTimeout(() => reject(new Error('timeout waiting for condition')), ms);
  });
  c.find = (t) => c.msgs.find((m) => m.t === t);
  return c;
}

test('static files and the status endpoint are served', async () => {
  const srv = await createServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /BREAKPOINT/);
    for (const p of ['/js/main.js', '/shared/physics.js', '/css/style.css', '/vendor/three/build/three.module.js', '/assets/models/soldier.glb']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      await r.arrayBuffer();
    }
    assert.equal((await fetch(`${base}/../package.json`)).status === 200 ? 'leak' : 'ok', 'ok');
    const st = await (await fetch(`${base}/api/status`)).json();
    assert.equal(st.ok, true);
  } finally {
    await srv.close();
  }
});

test('two clients quick-match into the same room and the server simulates their inputs', async () => {
  const srv = await createServer({ port: 0, host: '127.0.0.1', quiet: true });
  const a = client(srv.port), b = client(srv.port);
  try {
    await Promise.all([a.open, b.open]);
    a.send({ t: 'quick', name: 'Alpha' });
    await a.until(() => a.find('map'));
    b.send({ t: 'quick', name: 'Bravo' });
    await b.until(() => b.find('map'));
    const ja = a.find('joined'), jb = b.find('joined');
    assert.equal(ja.room.code, jb.room.code, 'same room');
    const map = a.find('map');
    assert.ok(map.grid.length > 1000);
    assert.equal(map.size.length, 3);
    a.send({ t: 'ready' }); b.send({ t: 'ready' });
    await a.until(() => a.snaps.some((s) => s.players.some((p) => p.id === ja.id && (p.flags & PF.ALIVE))));
    await a.until(() => a.snaps.some((s) => s.players.some((p) => p.id === jb.id && (p.flags & PF.ALIVE))));
    const startSnap = a.snaps[a.snaps.length - 1];
    const me0 = startSnap.players.find((p) => p.id === ja.id);
    // walk for ~1.5 s worth of inputs, sent in real time, turning a quarter each half second so a wall
    // right in front of the spawn point cannot hide that the server is moving us
    let seq = 1, moved = 0;
    for (let i = 0; i < 18; i++) {
      const batch = [];
      const yaw = me0.yaw + Math.floor(i / 6) * (Math.PI / 2);
      for (let k = 0; k < 5; k++) batch.push({ seq: seq++, buttons: BTN.FORWARD, yaw, pitch: 0, renderTick: startSnap.tick });
      a.ws.send(Buffer.from(encodeInputs(batch)));
      await new Promise((r) => setTimeout(r, 80));
      const s = a.snaps[a.snaps.length - 1], p = s && s.players.find((q) => q.id === ja.id);
      if (p) moved = Math.max(moved, Math.hypot(p.x - me0.x, p.z - me0.z));
    }
    await a.until(() => { const s = a.snaps[a.snaps.length - 1]; const p = s.players.find((q) => q.id === ja.id); return p && p.lastSeq >= seq - 1; }, 5000);
    const me1 = a.snaps[a.snaps.length - 1].players.find((p) => p.id === ja.id);
    moved = Math.max(moved, Math.hypot(me1.x - me0.x, me1.z - me0.z));
    assert.ok(moved > 1.0 || !(me1.flags & PF.ALIVE), `moved ${moved.toFixed(2)} m`);
    // both clients see the same players, including bots
    const lastB = b.snaps[b.snaps.length - 1];
    assert.ok(lastB.players.length >= 2);
    assert.ok(a.msgs.some((m) => m.t === 'scores'));
    assert.ok(a.msgs.some((m) => m.t === 'roster'));
  } finally {
    a.ws.close(); b.ws.close();
    await srv.close();
  }
});

test('private room flow over the wire: create, join by code, host starts', async () => {
  const srv = await createServer({ port: 0, host: '127.0.0.1', quiet: true });
  const h = client(srv.port), g = client(srv.port);
  try {
    await Promise.all([h.open, g.open]);
    h.send({ t: 'create', name: 'Host' });
    await h.until(() => h.find('joined'));
    const code = h.find('joined').room.code;
    g.send({ t: 'join', name: 'Guest', code });
    await g.until(() => g.find('joined'));
    g.send({ t: 'host', action: 'start' });
    await g.until(() => g.find('error'));
    h.send({ t: 'host', action: 'settings', settings: { map: 'harbor', bots: 1, difficulty: 'easy' } });
    h.send({ t: 'host', action: 'start' });
    await g.until(() => g.find('map'));
    assert.equal(g.find('map').name, 'harbor');
  } finally {
    h.ws.close(); g.ws.close();
    await srv.close();
  }
});
