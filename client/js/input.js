// Keyboard / mouse input with pointer lock.

import { BTN } from '/shared/constants.js';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouse = { left: false, right: false };
    this.latch = 0; // presses shorter than one simulation tick are still delivered
    this.dx = 0;
    this.dy = 0;
    this.locked = false;
    this.enabled = false;
    this.onLockChange = null;
    this.onKey = null;

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Tab') e.preventDefault();
      if (this.enabled && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
      this.keys.add(e.code);
      if (this.locked) {
        if (e.code === 'Space') this.latch |= BTN.JUMP;
        if (e.code === 'KeyQ') this.latch |= BTN.ROCKET;
        if (e.code === 'KeyR') this.latch |= BTN.RELOAD;
      }
      if (this.onKey) this.onKey(e.code, true, e);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (this.onKey) this.onKey(e.code, false, e);
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mouse.left = true; this.latch |= BTN.FIRE; }
      if (e.button === 2) { this.mouse.right = true; this.latch |= BTN.ROCKET; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    window.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // clamp absurd deltas some browsers emit on lock
      if (Math.abs(e.movementX) > 600 || Math.abs(e.movementY) > 600) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.mouse.left = this.mouse.right = false; }
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  lock() {
    if (this.locked) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { this.canvas.requestPointerLock(); } catch { /* ignore */ } });
    } catch {
      try { this.canvas.requestPointerLock(); } catch { /* ignore */ }
    }
  }

  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  consumeMouse() {
    const d = [this.dx, this.dy];
    this.dx = 0; this.dy = 0;
    return d;
  }

  buttons() {
    if (!this.locked) { this.latch = 0; return 0; }
    const k = this.keys;
    let b = this.latch;
    this.latch = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) b |= BTN.FORWARD;
    if (k.has('KeyS') || k.has('ArrowDown')) b |= BTN.BACK;
    if (k.has('KeyA') || k.has('ArrowLeft')) b |= BTN.LEFT;
    if (k.has('KeyD') || k.has('ArrowRight')) b |= BTN.RIGHT;
    if (k.has('Space')) b |= BTN.JUMP;
    if (k.has('KeyR')) b |= BTN.RELOAD;
    if (this.mouse.left) b |= BTN.FIRE;
    if (this.mouse.right || k.has('KeyQ')) b |= BTN.ROCKET;
    return b;
  }
}
