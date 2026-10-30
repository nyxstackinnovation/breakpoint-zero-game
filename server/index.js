// Breakpoint Zero server: static file host + WebSocket game server (default port 3001).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { decodeInputs, MSG_INPUT } from '../shared/protocol.js';
import { TICK_RATE, PROTOCOL_VERSION } from '../shared/constants.js';
import { sanitizeName } from '../shared/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

function resolveThree() {
  const candidates = [path.join(ROOT, 'node_modules', 'three'), path.join(ROOT, 'client', 'vendor', 'three')];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'build', 'three.module.js'))) return c;
  return candidates[0];
}

const MOUNTS = [
  ['/vendor/three/', resolveThree()],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/', path.join(ROOT, 'client')],
];

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (urlPath === '/') urlPath = '/index.html';
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const rel = urlPath.slice(prefix.length);
    const file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir))) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
      const ext = path.extname(file).toLowerCase();
      // Game files (code, models, sounds) change whenever the game is updated or the Blender assets are
      // rebuilt, so the browser must always check: an old cached props.glb drew the new cars and trees as
      // tiny boxes while their full-size collision stayed (invisible walls). Unchanged files cost a 304.
      const cache = prefix === '/vendor/three/' ? 'public, max-age=86400' : 'no-cache';
      const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache, etag, 'last-modified': st.mtime.toUTCString() };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, { ...headers, 'content-length': st.size });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  res.writeHead(404); res.end();
}

export function createServer({ port = Number(process.env.PORT) || 3001, host = process.env.HOST || '0.0.0.0', quiet = false } = {}) {
  const manager = new RoomManager();
  const server = http.createServer((req, res) => {
    if (req.url === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: PROTOCOL_VERSION, ...manager.stats() }));
      return;
    }
    serveStatic(req, res);
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024, perMessageDeflate: { threshold: 2048 } });

  wss.on('connection', (ws) => {
    const conn = {
      ws, room: null, player: null, name: 'Player', alive: true,
      send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
      sendBinary(buf) { if (ws.readyState === 1) ws.send(buf, { binary: true, compress: false }); },
    };
    conn.send({ t: 'hello', version: PROTOCOL_VERSION, tickRate: TICK_RATE });
    let msgCount = 0, msgWindow = Date.now();

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - msgWindow > 1000) { msgWindow = now; msgCount = 0; }
      if (++msgCount > 400) return; // flood guard
      try {
        if (isBinary) {
          const buf = data instanceof Buffer ? data : Buffer.from(data);
          if (buf[0] === MSG_INPUT && conn.player) {
            const inputs = decodeInputs(buf);
            if (inputs) {
              const p = conn.player;
              for (const inp of inputs) if (inp.seq > p.lastSeq && (!p.inputQueue.length || inp.seq > p.inputQueue[p.inputQueue.length - 1].seq)) p.inputQueue.push(inp);
            }
          }
          return;
        }
        const msg = JSON.parse(data.toString());
        handleMessage(manager, conn, msg);
      } catch (e) {
        if (!quiet) console.warn('bad message', e.message);
      }
    });
    ws.on('close', () => { manager.leave(conn); });
    ws.on('error', () => {});
    conn.pingTimer = setInterval(() => conn.send({ t: 'ping', s: Date.now() }), 2000);
    ws.on('close', () => clearInterval(conn.pingTimer));
  });

  // fixed-rate simulation loop shared by all rooms
  const stepMs = 1000 / TICK_RATE;
  let last = performance.now();
  let acc = 0;
  let running = true;
  const loop = () => {
    if (!running) return;
    const now = performance.now();
    acc += now - last;
    last = now;
    let steps = 0;
    // catch up after a stall of up to 0.25 s instead of silently losing that time
    while (acc >= stepMs && steps < 15) {
      try { manager.update(); } catch (e) { console.error('tick error', e); }
      acc -= stepMs;
      steps++;
    }
    if (acc > stepMs * 15) acc = 0;
    setTimeout(loop, Math.max(1, stepMs - acc - 0.5));
  };
  setTimeout(loop, stepMs);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      if (!quiet) {
        console.log(`\n  BREAKPOINT ZERO server running on port ${actual}`);
        console.log(`  Local:   http://localhost:${actual}`);
        for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || []) {
          if (i.family === 'IPv4' && !i.internal) console.log(`  Network: http://${i.address}:${actual}`);
        }
        console.log('');
      }
      resolve({
        server, wss, manager, port: actual,
        close: () => new Promise((r) => { running = false; for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }),
      });
    });
  });
}

function handleMessage(manager, conn, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  switch (msg.t) {
    case 'hello':
      conn.name = sanitizeName(msg.name);
      break;
    case 'quick':
      conn.name = sanitizeName(msg.name ?? conn.name);
      manager.quickMatch(conn, conn.name, typeof msg.difficulty === 'string' ? msg.difficulty : 'easy', typeof msg.map === 'string' ? msg.map : 'any');
      break;
    case 'create':
      conn.name = sanitizeName(msg.name ?? conn.name);
      manager.createPrivate(conn, conn.name);
      break;
    case 'join':
      conn.name = sanitizeName(msg.name ?? conn.name);
      manager.join(conn, conn.name, msg.code);
      break;
    case 'leave':
      manager.leave(conn);
      conn.send({ t: 'left' });
      break;
    case 'host':
      if (conn.room && conn.player) conn.room.hostAction(conn.player, msg);
      break;
    case 'ready':
      if (conn.room && conn.player && conn.room.game) conn.room.game.playerReady(conn.player);
      break;
    case 'resync':
      if (conn.room && conn.player && conn.room.game) conn.room.game.sendMap(conn.player);
      break;
    case 'pong':
      if (conn.player && Number.isFinite(msg.s)) conn.player.ping = Math.min(999, Date.now() - msg.s);
      break;
    case 'ping':
      conn.send({ t: 'pong', c: msg.c });
      break;
    case 'dev': {
      // test hooks, only when the server is started with BPZ_DEV=1 (never in normal play)
      if (process.env.BPZ_DEV !== '1' || !conn.room || !conn.room.game) break;
      const g = conn.room.game;
      if (!g.devLog) {
        // record who changes every voxel from now on
        g.devLog = new Map();
        const w = g.world, tag = (i, why) => { const l = g.devLog.get(i) || []; l.push(`${why}@${g.tick}`); g.devLog.set(i, l); };
        const ex = w.extract.bind(w); w.extract = (idx) => { for (const i of idx) tag(i, 'extract' + idx.length); return ex(idx); };
        const si = w.setIndex.bind(w); w.setIndex = (i, v) => { tag(i, `set${v}from${w.data[i]}g${w.ghost[w.data[i]]}:${new Error().stack.split('\n')[2].trim().slice(0, 60)}`); return si(i, v); };
        const em = g.emit.bind(g); g.emit = (ev) => { if (ev.t === 'boom' || ev.t === 'drop') g.devLog.set('ev' + g.tick, (g.devLog.get('ev' + g.tick) || 0) + 1); em(ev); };
      }
      if (msg.trace) conn.send({ t: 'devtrace', log: msg.trace.map((i) => `${i}: ${(g.devLog.get(i) || []).join(' ')}`) });
      if (Array.isArray(msg.boom)) g.explode(msg.boom[0], msg.boom[1], msg.boom[2], conn.player ? conn.player.id : 0, null, 0);
      if (msg.report) {
        const w = g.world, all = [];
        for (let i = 0; i < w.size; i++) { const v = w.data[i]; if (v && !w.ghost[v]) all.push(i); }
        let sum = 0; for (let i = 0; i < w.size; i++) sum = (sum * 31 + w.data[i]) >>> 0;
        if (msg.dump) conn.send({ t: 'devdump', data: Buffer.from(w.data).toString('base64') });
        conn.send({ t: 'devreport', floating: w.findFloatingClusters(all).map((c) => c.length), clusters: g.clusters.length, hash: sum });
      }
      break;
    }
    default:
      break;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createServer().catch((e) => { console.error(e); process.exit(1); });
}
