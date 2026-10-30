// Player movement shared by the authoritative server and client-side prediction.
// Axis-separated AABB vs voxel collision with automatic step-up and ground snapping.

import { PLAYER, VOXEL, BTN } from './constants.js';

const V = VOXEL;
const R = PLAYER.radius;
const H = PLAYER.height;
const EPS = 1e-4;
const MAX_SUBSTEP = 0.4;

export function createMoveState(x = 0, y = 0, z = 0) {
  return { x, y, z, vx: 0, vy: 0, vz: 0, onGround: false };
}

export function copyMoveState(dst, src) {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.onGround = src.onGround;
  return dst;
}

export function boxBlocked(world, minx, miny, minz, maxx, maxy, maxz) {
  const x0 = Math.floor(minx / V), x1 = Math.floor((maxx - EPS) / V);
  const y0 = Math.floor(miny / V), y1 = Math.floor((maxy - EPS) / V);
  const z0 = Math.floor(minz / V), z1 = Math.floor((maxz - EPS) / V);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        if (world.solidAt(x, y, z)) return true;
  return false;
}

export function overlapsAt(world, x, y, z) {
  return boxBlocked(world, x - R, y, z - R, x + R, y + H, z + R);
}

function columnBlockedX(world, cx, y, z) {
  const y0 = Math.floor(y / V), y1 = Math.floor((y + H - EPS) / V);
  const z0 = Math.floor((z - R) / V), z1 = Math.floor((z + R - EPS) / V);
  for (let yy = y0; yy <= y1; yy++) for (let zz = z0; zz <= z1; zz++) if (world.solidAt(cx, yy, zz)) return true;
  return false;
}
function columnBlockedZ(world, cz, y, x) {
  const y0 = Math.floor(y / V), y1 = Math.floor((y + H - EPS) / V);
  const x0 = Math.floor((x - R) / V), x1 = Math.floor((x + R - EPS) / V);
  for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) if (world.solidAt(xx, yy, cz)) return true;
  return false;
}
function rowBlockedY(world, cy, x, z) {
  const x0 = Math.floor((x - R) / V), x1 = Math.floor((x + R - EPS) / V);
  const z0 = Math.floor((z - R) / V), z1 = Math.floor((z + R - EPS) / V);
  for (let zz = z0; zz <= z1; zz++) for (let xx = x0; xx <= x1; xx++) if (world.solidAt(xx, cy, zz)) return true;
  return false;
}

function moveX(s, world, d) {
  const nx = s.x + d;
  if (d > 0) {
    const cx = Math.floor((nx + R) / V);
    if (cx !== Math.floor((s.x + R - EPS) / V) && columnBlockedX(world, cx, s.y, s.z)) { s.x = cx * V - R - EPS; return true; }
  } else if (d < 0) {
    const cx = Math.floor((nx - R) / V);
    if (cx !== Math.floor((s.x - R) / V) && columnBlockedX(world, cx, s.y, s.z)) { s.x = (cx + 1) * V + R + EPS; return true; }
  }
  s.x = nx;
  return false;
}
function moveZ(s, world, d) {
  const nz = s.z + d;
  if (d > 0) {
    const cz = Math.floor((nz + R) / V);
    if (cz !== Math.floor((s.z + R - EPS) / V) && columnBlockedZ(world, cz, s.y, s.x)) { s.z = cz * V - R - EPS; return true; }
  } else if (d < 0) {
    const cz = Math.floor((nz - R) / V);
    if (cz !== Math.floor((s.z - R) / V) && columnBlockedZ(world, cz, s.y, s.x)) { s.z = (cz + 1) * V + R + EPS; return true; }
  }
  s.z = nz;
  return false;
}
function moveY(s, world, d) {
  const ny = s.y + d;
  if (d > 0) {
    const cy = Math.floor((ny + H) / V);
    if (cy !== Math.floor((s.y + H - EPS) / V) && rowBlockedY(world, cy, s.x, s.z)) { s.y = cy * V - H - EPS; return true; }
  } else if (d < 0) {
    const cy = Math.floor(ny / V);
    if (cy !== Math.floor(s.y / V) && rowBlockedY(world, cy, s.x, s.z)) { s.y = (cy + 1) * V + EPS; return true; }
  }
  s.y = ny;
  return false;
}

function moveAxisSub(s, world, axis, d) {
  const steps = Math.max(1, Math.ceil(Math.abs(d) / MAX_SUBSTEP));
  const sd = d / steps;
  for (let i = 0; i < steps; i++) {
    const blocked = axis === 0 ? moveX(s, world, sd) : axis === 1 ? moveY(s, world, sd) : moveZ(s, world, sd);
    if (blocked) return true;
  }
  return false;
}

// Horizontal move with automatic step-up onto one-voxel ledges.
function moveHorizontal(s, world, axis, d, canStep, stepH = PLAYER.stepHeight) {
  if (d === 0) return false;
  const bx = s.x, by = s.y, bz = s.z;
  const blocked = moveAxisSub(s, world, axis, d);
  if (!blocked || !canStep) return blocked;
  const px = s.x, py = s.y, pz = s.z;
  const blockedProgress = axis === 0 ? Math.abs(px - bx) : Math.abs(pz - bz);
  s.x = bx; s.y = by; s.z = bz;
  if (!overlapsAt(world, bx, by + stepH, bz)) {
    s.y = by + stepH;
    const b2 = moveAxisSub(s, world, axis, d);
    const progress = axis === 0 ? Math.abs(s.x - bx) : Math.abs(s.z - bz);
    if (progress > blockedProgress + Math.min(0.01, Math.abs(d) * 0.5)) {
      moveAxisSub(s, world, 1, -stepH);
      return b2;
    }
  }
  s.x = px; s.y = py; s.z = pz;
  return true;
}

function unstuck(s, world) {
  if (!overlapsAt(world, s.x, s.y, s.z)) return;
  const base = Math.floor(s.y / V);
  for (let k = 1; k <= 16; k++) {
    const y = (base + k) * V + EPS;
    if (!overlapsAt(world, s.x, y, s.z)) { s.y = y; if (s.vy < 0) s.vy = 0; return; }
  }
}

function accelerate(s, wx, wz, wishSpeed, accel, dt) {
  const cur = s.vx * wx + s.vz * wz;
  const add = wishSpeed - cur;
  if (add <= 0) return;
  let as = accel * dt * wishSpeed;
  if (as > add) as = add;
  s.vx += as * wx;
  s.vz += as * wz;
}

function airAccelerate(s, wx, wz, wishSpeed, dt) {
  const capped = Math.min(wishSpeed, PLAYER.airSpeedCap);
  const cur = s.vx * wx + s.vz * wz;
  const add = capped - cur;
  if (add <= 0) return;
  let as = PLAYER.airAccel * wishSpeed * dt;
  if (as > add) as = add;
  s.vx += as * wx;
  s.vz += as * wz;
}

function applyFriction(s, dt) {
  const speed = Math.hypot(s.vx, s.vz);
  if (speed < 0.05) { s.vx = 0; s.vz = 0; return; }
  const control = speed < PLAYER.stopSpeed ? PLAYER.stopSpeed : speed;
  const drop = control * PLAYER.friction * dt;
  const ns = Math.max(speed - drop, 0) / speed;
  s.vx *= ns; s.vz *= ns;
}

export function wishDirection(buttons, yaw, out = [0, 0]) {
  const fm = ((buttons & BTN.FORWARD) ? 1 : 0) - ((buttons & BTN.BACK) ? 1 : 0);
  const sm = ((buttons & BTN.RIGHT) ? 1 : 0) - ((buttons & BTN.LEFT) ? 1 : 0);
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  let wx = -sin * fm + cos * sm;
  let wz = -cos * fm - sin * sm;
  const len = Math.hypot(wx, wz);
  if (len > 0) { wx /= len; wz /= len; }
  out[0] = wx; out[1] = wz;
  return out;
}

const _wish = [0, 0];

// Advance one fixed step. Mutates and returns s.
export function stepPlayer(s, buttons, yaw, world, dt) {
  unstuck(s, world);
  const wish = wishDirection(buttons, yaw, _wish);
  const hasWish = wish[0] !== 0 || wish[1] !== 0;
  let jumped = false;
  const wasGround = s.onGround;

  if (s.onGround && (buttons & BTN.JUMP)) {
    s.vy = PLAYER.jumpVelocity;
    s.onGround = false;
    jumped = true;
  }

  if (s.onGround) {
    applyFriction(s, dt);
    if (hasWish) accelerate(s, wish[0], wish[1], PLAYER.walkSpeed, PLAYER.groundAccel, dt);
  } else if (hasWish) {
    airAccelerate(s, wish[0], wish[1], PLAYER.walkSpeed, dt);
  }

  s.vy -= PLAYER.gravity * dt;
  if (s.vy < -PLAYER.maxFallSpeed) s.vy = -PLAYER.maxFallSpeed;

  // on the ground: walk up one-voxel steps. In the air (jump apex or falling): pull up over a ledge that is
  // at most ~0.6 m above the feet, so every crater, trench, pit or quay wall you can jump to is escapable.
  const groundStep = wasGround && !jumped;
  const mantle = !wasGround && s.vy < 2.5;
  const canStep = groundStep || mantle;
  const stepH = groundStep ? PLAYER.stepHeight : PLAYER.mantleHeight;
  if (moveHorizontal(s, world, 0, s.vx * dt, canStep, stepH)) s.vx = 0;
  if (moveHorizontal(s, world, 2, s.vz * dt, canStep, stepH)) s.vz = 0;

  const blockedY = moveAxisSub(s, world, 1, s.vy * dt);
  if (blockedY) {
    if (s.vy < 0) { s.onGround = true; }
    s.vy = 0;
  } else {
    s.onGround = false;
  }

  if (s.vy <= 0 && !s.onGround) {
    if (overlapsAt(world, s.x, s.y - 0.02, s.z)) {
      s.onGround = true; s.vy = 0;
    } else if (wasGround && !jumped && s.vy > -3) {
      // snap down small ledges (walking down stairs)
      const sy = s.y;
      if (moveAxisSub(s, world, 1, -PLAYER.stepHeight - 0.02)) { s.onGround = true; s.vy = 0; }
      else s.y = sy;
    }
  }
  return s;
}

// Apply an instantaneous velocity change (rocket blasts).
export function applyImpulse(s, ix, iy, iz) {
  s.vx += ix; s.vy += iy; s.vz += iz;
  if (s.vy > 0.5) s.onGround = false;
}
