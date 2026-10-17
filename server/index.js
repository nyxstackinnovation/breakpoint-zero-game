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
      const cache = ext === '.glb' || prefix === '/vendor/three/' ? 'public, max-age=86400' : 'no-cache';
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': st.size, 'cache-control': cache });
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
    while (acc >= stepMs && steps < 6) {
      try { manager.update(); } catch (e) { console.error('tick error', e); }
      acc -= stepMs;
      steps++;
    }
    if (acc > stepMs * 6) acc = 0;
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
      manager.quickMatch(conn, conn.name);
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
    default:
      break;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createServer().catch((e) => { console.error(e); process.exit(1); });
}
