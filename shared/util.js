// Small deterministic helpers shared by server and client.

export function hash3(x, y, z, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177) ^ Math.imul(seed | 0, 1103515245);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// mulberry32 seeded PRNG
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  return rng;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;

export function bytesToBase64(bytes) {
  const parts = [];
  let chunk = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (chunk.length > 8192) { parts.push(chunk); chunk = ''; }
  }
  if (i < n) {
    const b0 = bytes[i], b1 = i + 1 < n ? bytes[i + 1] : 0;
    const v = (b0 << 16) | (b1 << 8);
    chunk += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (i + 1 < n ? B64[(v >> 6) & 63] : '=') + '=';
  }
  parts.push(chunk);
  return parts.join('');
}

export function base64ToBytes(str) {
  let len = str.length;
  while (len > 0 && str[len - 1] === '=') len--;
  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64_LOOKUP[str.charCodeAt(i)];
    const b = B64_LOOKUP[str.charCodeAt(i + 1)];
    const c = i + 2 < len ? B64_LOOKUP[str.charCodeAt(i + 2)] : 0;
    const d = i + 3 < len ? B64_LOOKUP[str.charCodeAt(i + 3)] : 0;
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < outLen) out[o++] = (v >> 16) & 255;
    if (o < outLen) out[o++] = (v >> 8) & 255;
    if (o < outLen) out[o++] = v & 255;
  }
  return out;
}

export function int32ToBase64(arr) {
  const a = arr instanceof Int32Array ? arr : Int32Array.from(arr);
  return bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
}

export function base64ToInt32(str) {
  const bytes = base64ToBytes(str);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Int32Array(copy.buffer, 0, copy.length >> 2);
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
export function lerpAngle(a, b, t) { return a + angleDiff(a, b) * t; }

export function dirFromYawPitch(yaw, pitch, out = [0, 0, 0]) {
  const cp = Math.cos(pitch);
  out[0] = -Math.sin(yaw) * cp;
  out[1] = Math.sin(pitch);
  out[2] = -Math.cos(yaw) * cp;
  return out;
}

export function sanitizeName(name) {
  const s = String(name ?? '').replace(/[^\p{L}\p{N} _\-\.]/gu, '').trim().slice(0, 16);
  return s || 'Player';
}
