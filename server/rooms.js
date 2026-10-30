// Room management: Quick Match (public, auto-running), private rooms with codes,
// host-controlled lobbies, bot filling and the per-room game instance.

import { MAX_PLAYERS, MAP_ROTATION, BOT_DIFFICULTY } from '../shared/constants.js';
import { MAP_INFO } from '../shared/maps.js';
import { sanitizeName } from '../shared/util.js';
import { Game, createPlayer } from './game.js';
import { BotBrain, BOT_NAMES } from './bot.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const QUICK_BOTS = 5;

export class Room {
  constructor(manager, { isPublic, code }) {
    this.manager = manager;
    this.isPublic = isPublic;
    this.code = code;
    this.players = new Map();
    this.hostId = 0;
    this.state = 'lobby';
    this.settings = { map: 'skyline', bots: isPublic ? QUICK_BOTS : 3, difficulty: isPublic ? 'easy' : 'medium', rotation: true };
    this.game = null;
    this.createdAt = Date.now();
    this.botNameIndex = Math.floor(Math.random() * BOT_NAMES.length);
  }

  humans() { return [...this.players.values()].filter((p) => !p.isBot); }
  bots() { return [...this.players.values()].filter((p) => p.isBot); }

  allocId() {
    for (let id = 1; id < 250; id++) if (!this.players.has(id)) return id;
    return 0;
  }

  addHuman(conn, name) {
    if (this.humans().length >= MAX_PLAYERS) return null;
    // make room by removing a bot if needed
    if (this.players.size >= MAX_PLAYERS) {
      const bot = this.bots().pop();
      if (bot) this.removePlayer(bot, true);
    }
    const id = this.allocId();
    const p = createPlayer(id, uniqueName(this, sanitizeName(name)), false, conn);
    this.players.set(id, p);
    conn.player = p;
    conn.room = this;
    if (!this.hostId || !this.players.has(this.hostId)) this.hostId = id;
    conn.send({ t: 'joined', id, room: this.info() });
    if (this.state === 'game' && this.game) this.game.addPlayer(p);
    this.broadcastRoom();
    return p;
  }

  addBot() {
    if (this.players.size >= MAX_PLAYERS) return null;
    const id = this.allocId();
    const name = BOT_NAMES[this.botNameIndex++ % BOT_NAMES.length];
    const p = createPlayer(id, uniqueName(this, name), true, null);
    this.players.set(id, p);
    if (this.game) {
      p.brain = new BotBrain(this.game, p, this.settings.difficulty);
      this.game.addPlayer(p);
    }
    return p;
  }

  removePlayer(p, quiet = false) {
    if (!this.players.has(p.id)) return;
    this.players.delete(p.id);
    if (p.conn) { p.conn.player = null; p.conn.room = null; }
    if (this.game) this.game.removePlayer(p);
    if (p.id === this.hostId) {
      const next = this.humans()[0];
      this.hostId = next ? next.id : 0;
    }
    if (!this.humans().length) { this.manager.destroyRoom(this); return; }
    if (!quiet) {
      this.syncBots();
      this.broadcastRoom();
    }
  }

  // keep bot count at the configured level without exceeding the player cap
  syncBots() {
    if (this.state !== 'game') return;
    const target = Math.max(0, Math.min(this.settings.bots, MAX_PLAYERS - this.humans().length));
    let bots = this.bots();
    while (bots.length > target) { this.removePlayer(bots.pop(), true); bots = this.bots(); }
    while (this.bots().length < target) if (!this.addBot()) break;
    for (const b of this.bots()) if (b.brain) b.brain.setDifficulty(this.settings.difficulty);
    if (this.game) this.game.emitRoster();
  }

  start() {
    if (this.state === 'game') return;
    this.state = 'game';
    this.game = new Game(this);
    this.game.clock = () => performance.now();
    for (const p of this.players.values()) p.state = 'idle';
    this.game.loadMap(this.settings.map);
    this.syncBots();
    this.broadcastRoom();
  }

  backToLobby() {
    if (this.state !== 'game') return;
    for (const b of this.bots()) this.players.delete(b.id);
    this.state = 'lobby';
    this.game = null;
    for (const p of this.players.values()) { p.state = 'idle'; p.kills = 0; p.deaths = 0; }
    this.broadcastRoom();
  }

  hostAction(p, msg) {
    if (this.isPublic) return this.err(p, 'Quick Match rooms have no host controls.');
    if (p.id !== this.hostId) return this.err(p, 'Only the host can do that.');
    switch (msg.action) {
      case 'start':
        this.start();
        break;
      case 'settings': {
        const s = msg.settings || {};
        if (typeof s.map === 'string' && MAP_INFO[s.map]) this.settings.map = s.map;
        if (Number.isFinite(s.bots)) this.settings.bots = Math.max(0, Math.min(MAX_PLAYERS - 1, Math.round(s.bots)));
        if (typeof s.difficulty === 'string' && BOT_DIFFICULTY[s.difficulty]) this.settings.difficulty = s.difficulty;
        if (typeof s.rotation === 'boolean') this.settings.rotation = s.rotation;
        this.syncBots();
        this.broadcastRoom();
        break;
      }
      case 'kick': {
        const target = this.players.get(msg.id);
        if (!target || target === p) break;
        if (target.conn) target.conn.send({ t: 'kicked' });
        this.removePlayer(target);
        break;
      }
      case 'lobby':
        this.backToLobby();
        break;
      case 'skip':
        if (this.game && this.game.state === 'playing') this.game.endRound();
        break;
      default:
        break;
    }
  }

  err(p, msg) { if (p.conn) p.conn.send({ t: 'error', msg }); }

  info() {
    return {
      code: this.code,
      public: this.isPublic,
      host: this.hostId,
      state: this.state,
      settings: { ...this.settings },
      maps: MAP_ROTATION.map((m) => ({ id: m, name: MAP_INFO[m].display, blurb: MAP_INFO[m].blurb })),
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, bot: p.isBot, color: p.color, ping: p.ping | 0 })),
      max: MAX_PLAYERS,
    };
  }

  broadcastRoom() {
    const msg = { t: 'room', room: this.info() };
    for (const p of this.players.values()) if (p.conn) p.conn.send(msg);
  }

  update() {
    if (this.state === 'game' && this.game) this.game.update();
  }
}

function uniqueName(room, name) {
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100; i++) {
    const n = `${name.slice(0, 13)}${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return name;
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  makeCode() {
    for (let tries = 0; tries < 1000; tries++) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('could not allocate room code');
  }

  quickMatch(conn, name, difficulty = 'easy', map = 'any') {
    this.leave(conn);
    // one set of public rooms per bot skill: players who picked Hard only meet Hard bots
    if (!BOT_DIFFICULTY[difficulty]) difficulty = 'easy';
    // a chosen map only joins rooms locked to that map; "any" joins whichever room is busiest
    if (!MAP_INFO[map]) map = 'any';
    let best = null;
    for (const r of this.rooms.values()) {
      if (!r.isPublic || r.settings.difficulty !== difficulty) continue;
      if (map !== 'any' && r.settings.quickMap !== map) continue;
      const h = r.humans().length;
      if (h >= MAX_PLAYERS) continue;
      if (!best || h > best.humans().length) best = r;
    }
    if (!best) {
      best = new Room(this, { isPublic: true, code: this.makeCode() });
      best.settings.map = map !== 'any' ? map : MAP_ROTATION[Math.floor(Math.random() * MAP_ROTATION.length)];
      best.settings.difficulty = difficulty;
      best.settings.quickMap = map;
      best.settings.rotation = map === 'any'; // a picked map stays on that map round after round
      this.rooms.set(best.code, best);
      best.addHuman(conn, name);
      best.start();
      return best;
    }
    best.addHuman(conn, name);
    best.syncBots();
    return best;
  }

  createPrivate(conn, name) {
    this.leave(conn);
    const r = new Room(this, { isPublic: false, code: this.makeCode() });
    this.rooms.set(r.code, r);
    r.addHuman(conn, name);
    return r;
  }

  join(conn, name, code) {
    const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const r = this.rooms.get(c);
    if (!r) { conn.send({ t: 'error', msg: `Room ${c || '?'} not found.` }); return null; }
    if (r.humans().length >= MAX_PLAYERS) { conn.send({ t: 'error', msg: 'Room is full.' }); return null; }
    this.leave(conn);
    r.addHuman(conn, name);
    r.syncBots();
    return r;
  }

  leave(conn) {
    if (conn.room && conn.player) conn.room.removePlayer(conn.player);
    conn.room = null; conn.player = null;
  }

  destroyRoom(r) {
    this.rooms.delete(r.code);
    r.game = null;
  }

  update() {
    for (const r of [...this.rooms.values()]) r.update();
  }

  stats() {
    let players = 0, bots = 0;
    for (const r of this.rooms.values()) { players += r.humans().length; bots += r.bots().length; }
    return { rooms: this.rooms.size, players, bots };
  }
}
