// Binary encodings for the two high-frequency messages: client inputs and server snapshots.
// Everything else (lobby, events, map data) is JSON.

export const MSG_SNAPSHOT = 1;
export const MSG_INPUT = 2;

export const PF = {
  ALIVE: 1,
  GROUND: 2,
  FIRING: 4,
  ROCKET: 8,
  RELOADING: 16,
  PROTECTED: 32,
  BOT: 64,
};

const TWO_PI = Math.PI * 2;
const INPUT_SIZE = 17;
const PLAYER_SIZE = 37;
const ROCKET_SIZE = 21;

export function encodeInputs(inputs) {
  const n = Math.min(inputs.length, 255);
  const buf = new ArrayBuffer(2 + n * INPUT_SIZE);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG_INPUT);
  dv.setUint8(1, n);
  let o = 2;
  for (let i = inputs.length - n; i < inputs.length; i++) {
    const inp = inputs[i];
    dv.setUint32(o, inp.seq >>> 0, true); o += 4;
    dv.setUint8(o, inp.buttons & 255); o += 1;
    dv.setFloat32(o, inp.yaw, true); o += 4;
    dv.setFloat32(o, inp.pitch, true); o += 4;
    dv.setUint32(o, Math.max(0, inp.renderTick | 0) >>> 0, true); o += 4;
  }
  return buf;
}

export function decodeInputs(buffer) {
  const dv = toDataView(buffer);
  if (dv.byteLength < 2 || dv.getUint8(0) !== MSG_INPUT) return null;
  const n = dv.getUint8(1);
  if (dv.byteLength < 2 + n * INPUT_SIZE) return null;
  const out = [];
  let o = 2;
  for (let i = 0; i < n; i++) {
    const seq = dv.getUint32(o, true); o += 4;
    const buttons = dv.getUint8(o); o += 1;
    const yaw = dv.getFloat32(o, true); o += 4;
    const pitch = dv.getFloat32(o, true); o += 4;
    const renderTick = dv.getUint32(o, true); o += 4;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) continue;
    out.push({ seq, buttons, yaw, pitch: Math.max(-1.55, Math.min(1.55, pitch)), renderTick });
  }
  return out;
}

const clampI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
const clampU8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

export function encodeSnapshot(snap) {
  const players = snap.players, rockets = snap.rockets || [];
  const size = 1 + 4 + 1 + players.length * PLAYER_SIZE + 1 + rockets.length * ROCKET_SIZE;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o, MSG_SNAPSHOT); o += 1;
  dv.setUint32(o, snap.tick >>> 0, true); o += 4;
  dv.setUint8(o, players.length); o += 1;
  for (const p of players) {
    dv.setUint8(o, p.id); o += 1;
    dv.setUint8(o, p.flags); o += 1;
    dv.setFloat32(o, p.x, true); o += 4;
    dv.setFloat32(o, p.y, true); o += 4;
    dv.setFloat32(o, p.z, true); o += 4;
    dv.setInt16(o, clampI16(p.vx * 100), true); o += 2;
    dv.setInt16(o, clampI16(p.vy * 100), true); o += 2;
    dv.setInt16(o, clampI16(p.vz * 100), true); o += 2;
    let yaw = p.yaw % TWO_PI; if (yaw < 0) yaw += TWO_PI;
    dv.setUint16(o, Math.round((yaw / TWO_PI) * 65535) & 0xffff, true); o += 2;
    dv.setInt16(o, clampI16(p.pitch * 10000), true); o += 2;
    dv.setUint8(o, clampU8(p.health)); o += 1;
    dv.setUint32(o, p.lastSeq >>> 0, true); o += 4;
    dv.setUint8(o, clampU8(p.ammo)); o += 1;
    dv.setUint8(o, clampU8(p.rockets)); o += 1;
    dv.setUint8(o, clampU8(p.reload)); o += 1;
    dv.setUint8(o, clampU8(p.rocketRegen)); o += 1;
    dv.setUint8(o, clampU8(p.rocketCd)); o += 1;
    dv.setUint8(o, clampU8(p.fireCd)); o += 1;
    dv.setUint16(o, Math.max(0, Math.min(65535, Math.round(p.spread * 100000))), true); o += 2;
  }
  dv.setUint8(o, rockets.length); o += 1;
  for (const r of rockets) {
    dv.setUint16(o, r.id & 0xffff, true); o += 2;
    dv.setUint8(o, r.owner); o += 1;
    dv.setFloat32(o, r.x, true); o += 4;
    dv.setFloat32(o, r.y, true); o += 4;
    dv.setFloat32(o, r.z, true); o += 4;
    dv.setInt16(o, clampI16(r.vx * 100), true); o += 2;
    dv.setInt16(o, clampI16(r.vy * 100), true); o += 2;
    dv.setInt16(o, clampI16(r.vz * 100), true); o += 2;
  }
  return buf;
}

export function decodeSnapshot(buffer) {
  const dv = toDataView(buffer);
  let o = 0;
  if (dv.getUint8(o) !== MSG_SNAPSHOT) return null; o += 1;
  const tick = dv.getUint32(o, true); o += 4;
  const np = dv.getUint8(o); o += 1;
  const players = [];
  for (let i = 0; i < np; i++) {
    const p = {};
    p.id = dv.getUint8(o); o += 1;
    p.flags = dv.getUint8(o); o += 1;
    p.x = dv.getFloat32(o, true); o += 4;
    p.y = dv.getFloat32(o, true); o += 4;
    p.z = dv.getFloat32(o, true); o += 4;
    p.vx = dv.getInt16(o, true) / 100; o += 2;
    p.vy = dv.getInt16(o, true) / 100; o += 2;
    p.vz = dv.getInt16(o, true) / 100; o += 2;
    p.yaw = (dv.getUint16(o, true) / 65535) * TWO_PI; o += 2;
    p.pitch = dv.getInt16(o, true) / 10000; o += 2;
    p.health = dv.getUint8(o); o += 1;
    p.lastSeq = dv.getUint32(o, true); o += 4;
    p.ammo = dv.getUint8(o); o += 1;
    p.rockets = dv.getUint8(o); o += 1;
    p.reload = dv.getUint8(o); o += 1;
    p.rocketRegen = dv.getUint8(o); o += 1;
    p.rocketCd = dv.getUint8(o); o += 1;
    p.fireCd = dv.getUint8(o); o += 1;
    p.spread = dv.getUint16(o, true) / 100000; o += 2;
    players.push(p);
  }
  const nr = dv.getUint8(o); o += 1;
  const rockets = [];
  for (let i = 0; i < nr; i++) {
    const r = {};
    r.id = dv.getUint16(o, true); o += 2;
    r.owner = dv.getUint8(o); o += 1;
    r.x = dv.getFloat32(o, true); o += 4;
    r.y = dv.getFloat32(o, true); o += 4;
    r.z = dv.getFloat32(o, true); o += 4;
    r.vx = dv.getInt16(o, true) / 100; o += 2;
    r.vy = dv.getInt16(o, true) / 100; o += 2;
    r.vz = dv.getInt16(o, true) / 100; o += 2;
    rockets.push(r);
  }
  return { tick, players, rockets };
}

function toDataView(buffer) {
  if (buffer instanceof DataView) return buffer;
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  // Node Buffer / typed array
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
