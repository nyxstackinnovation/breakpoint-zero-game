// Procedural spatial audio. Every sound is synthesised with WebAudio, positioned with
// HRTF panners relative to the camera so gunfire and explosions read directionally.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.voices = 0;
    this.lastFoot = 0;
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // brown noise for rumbles
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  updateListener(pos, fwd, up) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos.x, t); l.positionY.setValueAtTime(pos.y, t); l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t); l.forwardY.setValueAtTime(fwd.y, t); l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(up.x, t); l.upY.setValueAtTime(up.y, t); l.upZ.setValueAtTime(up.z, t);
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  // output node: spatial panner when a position is given
  out(pos, ref = 3, gain = 1) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (pos) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = ref;
      p.maxDistance = 200;
      p.rolloffFactor = 1.15;
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
      else p.setPosition(pos.x, pos.y, pos.z);
      g.connect(p);
      p.connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  ok() { return this.ctx && this.ctx.state === 'running' && this.voices < 56; }

  noiseSrc(buffer = this.noise) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.loopStart = Math.random();
    return s;
  }

  track(node, dur) {
    this.voices++;
    setTimeout(() => { this.voices--; }, dur * 1000 + 50);
    return node;
  }

  env(param, t, attack, peak, decay, end = 0.0001) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(end, t + attack + decay);
  }

  burst(dest, t, { type = 'bandpass', freq = 1000, q = 1, attack = 0.002, decay = 0.1, peak = 1, buffer, sweepTo } = {}) {
    const ctx = this.ctx;
    const src = this.noiseSrc(buffer);
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + decay);
    const g = ctx.createGain();
    this.env(g.gain, t, attack, peak, decay);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t); src.stop(t + attack + decay + 0.05);
  }

  tone(dest, t, { type = 'sine', from = 200, to = from, attack = 0.002, decay = 0.1, peak = 0.6 } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + attack + decay);
    const g = ctx.createGain();
    this.env(g.gain, t, attack, peak, decay);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + attack + decay + 0.05);
  }

  // ---------------------------------------------------------------- sounds

  rifle(pos, local = false) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(local ? null : pos, 6, local ? 0.55 : 1.0);
    const v = 0.9 + Math.random() * 0.2;
    this.burst(d, t, { type: 'bandpass', freq: 2400 * v, q: 0.8, decay: 0.07, peak: 1.0 });
    this.burst(d, t, { type: 'lowpass', freq: 900, decay: 0.22, peak: 0.6 });
    this.tone(d, t, { from: 160 * v, to: 45, decay: 0.12, peak: 0.9 });
    this.burst(d, t + 0.02, { type: 'highpass', freq: 5000, decay: 0.05, peak: 0.25 });
    this.track(d, 0.3);
  }

  rocketLaunch(pos, local = false) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(local ? null : pos, 6, local ? 0.6 : 1);
    this.burst(d, t, { type: 'lowpass', freq: 300, sweepTo: 2600, attack: 0.02, decay: 0.55, peak: 0.9 });
    this.tone(d, t, { from: 90, to: 40, decay: 0.25, peak: 0.8 });
    this.burst(d, t, { type: 'bandpass', freq: 700, q: 2, decay: 0.12, peak: 0.6 });
    this.track(d, 0.7);
  }

  explosion(pos, dist) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(pos, 10, 1.5);
    const far = Math.min(1, dist / 60);
    this.tone(d, t, { from: 75, to: 24, attack: 0.005, decay: 1.1, peak: 1.0 });
    this.burst(d, t, { type: 'lowpass', freq: 1400 * (1 - far * 0.7), sweepTo: 120, attack: 0.004, decay: 1.6, peak: 1.0, buffer: this.noise });
    this.burst(d, t, { type: 'lowpass', freq: 220, attack: 0.01, decay: 2.2, peak: 0.9, buffer: this.brown });
    if (far < 0.6) this.burst(d, t + 0.03, { type: 'highpass', freq: 3500, decay: 0.25, peak: 0.35 });
    this.track(d, 2.4);
  }

  crumble(pos, size = 1) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(pos, 8, Math.min(1.4, 0.5 + size * 0.15));
    this.burst(d, t, { type: 'lowpass', freq: 380, attack: 0.05, decay: 1.6 + size * 0.2, peak: 0.9, buffer: this.brown });
    for (let i = 0; i < 6; i++) this.burst(d, t + Math.random() * 0.9, { type: 'bandpass', freq: 500 + Math.random() * 1500, q: 3, decay: 0.08, peak: 0.35 });
    this.tone(d, t, { from: 55, to: 30, attack: 0.04, decay: 1.2, peak: 0.6 });
    this.track(d, 2.2);
  }

  impact(pos) {
    if (!this.ok() || Math.random() < 0.3) return;
    const t = this.ctx.currentTime;
    const d = this.out(pos, 2, 0.4);
    this.burst(d, t, { type: 'bandpass', freq: 2500 + Math.random() * 2500, q: 2, decay: 0.04, peak: 0.6 });
    this.track(d, 0.1);
  }

  flesh(pos) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(pos, 3, 0.6);
    this.tone(d, t, { from: 220, to: 90, decay: 0.07, peak: 0.6 });
    this.burst(d, t, { type: 'lowpass', freq: 800, decay: 0.06, peak: 0.5 });
    this.track(d, 0.12);
  }

  hitmarker(kind = 0) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(null, 1, 0.35);
    if (kind === 2) {
      this.tone(d, t, { type: 'triangle', from: 880, decay: 0.12, peak: 0.6 });
      this.tone(d, t + 0.09, { type: 'triangle', from: 1320, decay: 0.22, peak: 0.6 });
    } else {
      this.tone(d, t, { type: 'square', from: kind === 1 ? 2100 : 1500, decay: 0.045, peak: 0.25 });
    }
    this.track(d, 0.35);
  }

  footstep(pos, local = false) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(local ? null : pos, 2, local ? 0.12 : 0.35);
    this.burst(d, t, { type: 'lowpass', freq: 500 + Math.random() * 300, decay: 0.07, peak: 0.8 });
    this.track(d, 0.12);
  }

  land(local = true, pos = null) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(local ? null : pos, 2, local ? 0.3 : 0.4);
    this.burst(d, t, { type: 'lowpass', freq: 300, decay: 0.12, peak: 0.9 });
    this.tone(d, t, { from: 110, to: 60, decay: 0.08, peak: 0.4 });
    this.track(d, 0.2);
  }

  jump() {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(null, 1, 0.12);
    this.burst(d, t, { type: 'bandpass', freq: 900, q: 1.5, decay: 0.06, peak: 0.6 });
    this.track(d, 0.1);
  }

  hurt() {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(null, 1, 0.45);
    this.tone(d, t, { type: 'sawtooth', from: 180, to: 80, decay: 0.16, peak: 0.25 });
    this.burst(d, t, { type: 'lowpass', freq: 600, decay: 0.12, peak: 0.6 });
    this.track(d, 0.2);
  }

  reload() {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(null, 1, 0.3);
    this.burst(d, t + 0.15, { type: 'bandpass', freq: 1800, q: 4, decay: 0.04, peak: 0.8 });
    this.burst(d, t + 0.75, { type: 'bandpass', freq: 1200, q: 4, decay: 0.05, peak: 0.9 });
    this.burst(d, t + 1.3, { type: 'bandpass', freq: 2600, q: 5, decay: 0.03, peak: 0.9 });
    this.burst(d, t + 1.42, { type: 'bandpass', freq: 2000, q: 5, decay: 0.03, peak: 0.8 });
    this.track(d, 1.6);
  }

  heal() {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(null, 1, 0.25);
    this.tone(d, t, { type: 'triangle', from: 660, to: 990, decay: 0.25, peak: 0.5 });
    this.track(d, 0.3);
  }

  spawn() {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(null, 1, 0.22);
    this.tone(d, t, { type: 'sawtooth', from: 220, to: 880, attack: 0.01, decay: 0.35, peak: 0.25 });
    this.track(d, 0.4);
  }

  roundEnd() {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(null, 1, 0.3);
    [523, 659, 784, 1046].forEach((f, i) => this.tone(d, t + i * 0.12, { type: 'triangle', from: f, decay: 0.6, peak: 0.4 }));
    this.track(d, 1.2);
  }

  ui() {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    const d = this.out(null, 1, 0.15);
    this.tone(d, t, { type: 'square', from: 900, to: 1300, decay: 0.05, peak: 0.3 });
    this.track(d, 0.1);
  }
}
