// Touch controls for phones and tablets: a floating joystick on the left half of the screen, swipe-to-look
// everywhere else, and on-screen buttons for fire, rocket, jump, reload, the scoreboard and the pause menu.
// It feeds the same Input object the keyboard and mouse use, so the game code does not change.

import { BTN } from '/shared/constants.js';

export const isTouchDevice = () =>
  typeof window !== 'undefined' &&
  (('ontouchstart' in window) || navigator.maxTouchPoints > 0) &&
  (window.matchMedia?.('(pointer: coarse)').matches ?? true);

const LOOK_GAIN = 1.7;       // touch pixels -> mouse-equivalent pixels
const STICK_RADIUS = 56;     // px of finger travel for full deflection
const DEAD = 0.28;           // dead zone before a direction is pressed

export class TouchControls {
  constructor(input, root, { onPause, onScoreboard } = {}) {
    this.input = input;
    this.root = root;
    this.onPause = onPause;
    this.onScoreboard = onScoreboard;
    this.stick = null;          // { id, ox, oy, x, y }
    this.looks = new Map();     // touch id -> { x, y }
    this.buttons = new Map();   // touch id -> button element
    this.held = 0;              // BTN flags held by on-screen buttons
    this.move = 0;              // BTN flags from the joystick
    this.base = root.querySelector('.tc-stick');
    this.knob = root.querySelector('.tc-knob');

    const opts = { passive: false };
    root.addEventListener('touchstart', (e) => this.start(e), opts);
    root.addEventListener('touchmove', (e) => this.moveEv(e), opts);
    root.addEventListener('touchend', (e) => this.end(e), opts);
    root.addEventListener('touchcancel', (e) => this.end(e), opts);
    window.addEventListener('blur', () => this.reset());
  }

  reset() {
    this.stick = null;
    this.looks.clear();
    for (const el of this.buttons.values()) el.classList.remove('down');
    this.buttons.clear();
    this.held = 0;
    this.move = 0;
    this.drawStick();
  }

  start(e) {
    e.preventDefault();
    this.input.lastTouch = performance.now();
    for (const t of e.changedTouches) {
      const btn = t.target.closest?.('[data-btn]');
      if (btn) {
        this.press(t.identifier, btn);
        // the fire thumb can be rolled across the screen to keep aiming while shooting
        if (btn.dataset.btn === 'fire') this.looks.set(t.identifier, { x: t.clientX, y: t.clientY });
        continue;
      }
      if (!this.stick && t.clientX < window.innerWidth * 0.42) {
        this.stick = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY };
        this.updateStick();
      } else {
        this.looks.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
    }
  }

  moveEv(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.stick && t.identifier === this.stick.id) {
        this.stick.x = t.clientX; this.stick.y = t.clientY;
        this.updateStick();
        continue;
      }
      const l = this.looks.get(t.identifier);
      if (!l) continue;
      const dx = t.clientX - l.x, dy = t.clientY - l.y;
      l.x = t.clientX; l.y = t.clientY;
      if (this.input.locked) { this.input.dx += dx * LOOK_GAIN; this.input.dy += dy * LOOK_GAIN; }
    }
  }

  end(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.stick && t.identifier === this.stick.id) { this.stick = null; this.move = 0; this.drawStick(); continue; }
      this.looks.delete(t.identifier);
      const btn = this.buttons.get(t.identifier);
      if (btn) { this.release(t.identifier, btn); }
    }
  }

  press(id, el) {
    this.buttons.set(id, el);
    el.classList.add('down');
    const kind = el.dataset.btn;
    const input = this.input;
    switch (kind) {
      case 'fire': this.held |= BTN.FIRE; input.latch |= BTN.FIRE; break;
      case 'rocket': this.held |= BTN.ROCKET; input.latch |= BTN.ROCKET; break;
      case 'jump': this.held |= BTN.JUMP; input.latch |= BTN.JUMP; break;
      case 'reload': input.latch |= BTN.RELOAD; break;
      case 'pause': this.onPause?.(); break;
      case 'score': this.onScoreboard?.(true); break;
    }
  }

  release(id, el) {
    this.buttons.delete(id);
    const kind = el.dataset.btn;
    // another finger may still be on the same button
    if ([...this.buttons.values()].includes(el)) return;
    el.classList.remove('down');
    if (kind === 'fire') this.held &= ~BTN.FIRE;
    if (kind === 'rocket') this.held &= ~BTN.ROCKET;
    if (kind === 'jump') this.held &= ~BTN.JUMP;
    if (kind === 'score') this.onScoreboard?.(false);
  }

  updateStick() {
    const s = this.stick;
    let dx = s.x - s.ox, dy = s.y - s.oy;
    const len = Math.hypot(dx, dy);
    // the base follows a finger dragged past the rim, so the stick never "runs out"
    if (len > STICK_RADIUS * 1.25) {
      const k = (len - STICK_RADIUS * 1.25) / len;
      s.ox += dx * k; s.oy += dy * k;
      dx = s.x - s.ox; dy = s.y - s.oy;
    }
    const nx = dx / STICK_RADIUS, ny = dy / STICK_RADIUS;
    const mag = Math.min(1, Math.hypot(nx, ny));
    let m = 0;
    if (mag > DEAD) {
      const a = Math.atan2(ny, nx); // 0 = right, +pi/2 = down
      const c = Math.cos(a), sn = Math.sin(a);
      // 8-way: a diagonal presses both keys (22.5 degree sectors around each axis)
      if (c > 0.38) m |= BTN.RIGHT;
      if (c < -0.38) m |= BTN.LEFT;
      if (sn < -0.38) m |= BTN.FORWARD;
      if (sn > 0.38) m |= BTN.BACK;
    }
    this.move = m;
    this.drawStick();
  }

  drawStick() {
    if (!this.base) return;
    if (!this.stick) {
      this.base.classList.remove('active');
      this.base.style.transform = '';
      this.knob.style.transform = '';
      return;
    }
    const s = this.stick;
    const dx = s.x - s.ox, dy = s.y - s.oy;
    const len = Math.hypot(dx, dy), k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
    this.base.classList.add('active');
    if (!s.rest) {
      // resting centre of the base, measured once per touch with no offset applied
      this.base.style.transform = '';
      const r = this.base.getBoundingClientRect();
      s.rest = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    const tx = s.ox - s.rest.x, ty = s.oy - s.rest.y;
    this.base.style.transform = `translate(${tx}px, ${ty}px)`;
    this.knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
  }

  flags() { return this.held | this.move; }
}
