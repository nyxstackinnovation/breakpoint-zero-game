// Touch controls for phones and tablets: a floating joystick on the left half of the screen, swipe-to-look
// everywhere else, and on-screen buttons for fire, rocket, jump, reload, the scoreboard and the pause menu.
// It feeds the same Input object the keyboard and mouse use, so the game code does not change.

import { BTN } from '/shared/constants.js';

export const isTouchDevice = () =>
  typeof window !== 'undefined' &&
  (('ontouchstart' in window) || navigator.maxTouchPoints > 0) &&
  (window.matchMedia?.('(pointer: coarse)').matches ?? true);

const LOOK_GAIN = 2.6;       // touch pixels -> mouse-equivalent pixels (about 180 deg per half-screen swipe)
const RESAMPLE_MS = 10;       // look is read from the finger path a few ms in the past, so it moves evenly every frame
const STICK_RADIUS = 46;     // px of finger travel for full deflection
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
        if (btn.dataset.btn === 'fire' && btn.dataset.side !== 'left') this.looks.set(t.identifier, this.newLook(t));
        continue;
      }
      if (!this.stick && t.clientX < window.innerWidth * 0.4) {
        this.stick = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY };
        this.updateStick();
      } else {
        this.looks.set(t.identifier, this.newLook(t));
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
      // record the finger path; lookDelta() turns it into an even per-frame turn
      l.samples.push({ t: performance.now(), x: t.clientX, y: t.clientY });
      if (l.samples.length > 64) l.samples.splice(0, l.samples.length - 64);
    }
  }

  newLook(t) {
    const now = performance.now();
    return { x: t.clientX, y: t.clientY, samples: [{ t: now, x: t.clientX, y: t.clientY }] };
  }

  // Finger position at time T, interpolated between the touch samples around it.
  pathAt(l, T) {
    const s = l.samples;
    if (T <= s[0].t) return s[0];
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1], b = s[i];
      if (T >= a.t && T <= b.t) {
        const k = b.t > a.t ? (T - a.t) / (b.t - a.t) : 1;
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
    }
    // no sample after T yet (events arrive in bursts): continue along the finger's recent velocity for
    // a short while instead of freezing, so the view doesn't hitch until the next burst lands
    const b = s[s.length - 1];
    let a = null;
    for (let i = s.length - 2; i >= 0; i--) if (b.t - s[i].t >= 6) { a = s[i]; break; }
    if (!a || b.t - a.t > 60) return b;
    const ahead = Math.min(T - b.t, 12);
    const k = ahead / (b.t - a.t);
    return { x: b.x + (b.x - a.x) * k, y: b.y + (b.y - a.y) * k };
  }

  // Called once per rendered frame. Touch events arrive at their own rate (60-240 Hz, often in bursts)
  // which never lines up with the screen's frames, so reading them directly makes the view step and
  // stutter. Instead the finger path is resampled at frame time (a few ms behind, so there is always a
  // sample on each side to interpolate between) and the difference since the last frame is the turn.
  // A gentle speed curve keeps slow drags precise for aiming and fast flicks quick for turning.
  lookDelta(now, dt) {
    let dx = 0, dy = 0;
    const T = now - RESAMPLE_MS;
    for (const l of this.looks.values()) {
      const p = this.pathAt(l, T);
      dx += p.x - l.x; dy += p.y - l.y;
      l.x = p.x; l.y = p.y;
      // drop samples that are no longer needed (keep the one just before T)
      let i = 0;
      while (i < l.samples.length - 2 && l.samples[i + 1].t <= T) i++;
      if (i) l.samples.splice(0, i);
    }
    // finger speed, smoothed (~70 ms) so the acceleration curve can't make the turn rate flicker
    const inst = (dx || dy) ? Math.hypot(dx, dy) / Math.max(0.004, dt) : 0; // px per second
    this.lookSpeed = (this.lookSpeed || 0) + (inst - (this.lookSpeed || 0)) * (1 - Math.exp(-dt / 0.07));
    if (!dx && !dy) return [0, 0];
    const speed = this.lookSpeed;
    const gain = LOOK_GAIN * (0.75 + 0.75 * Math.min(1, speed / 1200)); // fast flicks turn up to 2x faster
    return [dx * gain, dy * gain];
  }

  // a finger lifting: apply whatever part of its path was not turned yet
  flushLook(l) {
    const last = l.samples[l.samples.length - 1];
    const dx = last.x - l.x, dy = last.y - l.y;
    if (dx || dy) { this.input.tdx += dx * LOOK_GAIN * 0.75; this.input.tdy += dy * LOOK_GAIN * 0.75; }
  }

  end(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.stick && t.identifier === this.stick.id) { this.stick = null; this.move = 0; this.drawStick(); continue; }
      const l = this.looks.get(t.identifier);
      if (l) { if (this.input.locked) this.flushLook(l); this.looks.delete(t.identifier); }
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
    const still = [...this.buttons.values()];
    if (!still.includes(el)) el.classList.remove('down');
    if (el.dataset.btn === 'score' && !still.some((b) => b.dataset.btn === 'score')) this.onScoreboard?.(false);
    // held flags come from whatever buttons still have a finger on them (two FIRE buttons can be held)
    let h = 0;
    for (const b of still) {
      if (b.dataset.btn === 'fire') h |= BTN.FIRE;
      else if (b.dataset.btn === 'rocket') h |= BTN.ROCKET;
      else if (b.dataset.btn === 'jump') h |= BTN.JUMP;
    }
    this.held = h;
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
