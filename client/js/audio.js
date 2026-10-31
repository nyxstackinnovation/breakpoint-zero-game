// Spatial audio. Recorded samples (client/assets/sounds: rifle shots and the rocket launch / blast, cut
// from the recordings in that folder) layered with synthesised sounds, all routed through:
//   source -> per-voice filter (distance air absorption + wall occlusion) -> HRTF panner
//          -> dry bus + reverb send (generated impulse response) -> compressor -> speakers
// Distant gunfire and explosions arrive late (speed of sound) and muffled.

const SPEED_OF_SOUND = 343;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.voices = 0;
    this.listener = { x: 0, y: 0, z: 0 };
    this.loops = new Map();
    this.occlusion = null; // (pos) => true when a wall blocks the line to the listener
    this.reverbAmount = 0.25;
    this.samples = {};
    this.voiceSets = { localRifle: [], remoteRifle: [], booms: [] };
    this.lastByShooter = new Map();
  }

  // recorded samples; until they load (or if they fail) the synthesised versions play on their own
  async loadSamples() {
    const files = { rifle1: 'rifle_1.wav', rifle2: 'rifle_2.wav', rifle3: 'rifle_3.wav', launch: 'rocket_launch.wav', boom: 'rocket_boom.wav',
      killHead: 'kill_headshot.mp3', killNormal: 'kill_normal.mp3', killRocket: 'kill_rocket.mp3',
      died: 'player_killed.mp3', win: 'win.mp3' };
    await Promise.all(Object.entries(files).map(async ([k, f]) => {
      try {
        const res = await fetch(`/assets/sounds/${f}`);
        if (!res.ok) return;
        this.samples[k] = await this.ctx.decodeAudioData(await res.arrayBuffer());
      } catch { /* keep the synth fallback */ }
    }));
  }

  play(buffer, dest, t, { gain = 1, rate = 1, offset = 0 } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    src.connect(g);
    g.connect(dest);
    src.start(t, offset);
    const end = t + buffer.duration / rate;
    // fade this voice out from time `at` (used to cut tails when the next shot or a newer sound comes)
    const fade = (at, len = 0.06) => {
      at = Math.max(at, this.ctx.currentTime);
      if (at >= end) return;
      g.gain.cancelScheduledValues(at);
      g.gain.setValueAtTime(gain, at);
      g.gain.linearRampToValueAtTime(0.0001, at + len);
      try { src.stop(at + len + 0.01); } catch { /* already stopped */ }
    };
    return { src, g, start: t, end, fade };
  }

  // Keep at most `max` voices of one kind (oldest fade out) and drop finished ones.
  limit(list, max, at) {
    const now = this.ctx.currentTime;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].end < now) list.splice(i, 1);
    while (list.length >= max) list.shift().fade(at, 0.05);
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    // A slightly bigger output buffer (~60 ms instead of ~10 ms): with the smallest buffer, any moment the
    // laptop is busy (explosions, collapsing buildings, debris) the sound card runs dry and the audio
    // crackles or cuts out. 60 ms is still too short to notice on a gunshot.
    let ctx;
    try { ctx = new AC({ latencyHint: 0.06 }); } catch { ctx = new AC({ latencyHint: 'balanced' }); }
    this.ctx = ctx;
    // Final stage is only a safety limiter with headroom in front of it. It used to be a bus compressor that
    // every sound fed: a close rocket blast (launch + boom) pushed it down hard and your rifle went quiet
    // until the boom's tail died away. Blasts now have their own compressor (fx bus) and are tamed there,
    // so the rifle bus never gets ducked by them.
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -2; lim.knee.value = 2; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.05;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const headroom = ctx.createGain();
    headroom.gain.value = 0.9;
    this.master.connect(headroom);
    headroom.connect(lim);
    lim.connect(ctx.destination);
    this.limiter = lim;
    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    const fxComp = ctx.createDynamicsCompressor();
    fxComp.threshold.value = -16; fxComp.knee.value = 8; fxComp.ratio.value = 6; fxComp.attack.value = 0.004; fxComp.release.value = 0.25;
    this.fx = ctx.createGain();
    this.fx.connect(fxComp);
    fxComp.connect(this.master);
    this.fxComp = fxComp;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(1.3, 2.6);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.55;
    this.reverb.connect(this.wet);
    this.wet.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    // soft clipper used to give gunshots a punchy, saturated crack
    const curves = new Map();   // one curve per drive amount (building a fresh curve per burst cost CPU in big fights)
    this.shaper = (amount) => {
      const ws = ctx.createWaveShaper();
      let curve = curves.get(amount);
      if (!curve) {
        const n = 1024;
        curve = new Float32Array(n);
        for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * amount) / Math.tanh(amount); }
        curves.set(amount, curve);
      }
      ws.curve = curve;
      return ws;
    };
    this.loadSamples();
  }

  // stereo impulse response: exponentially decaying noise with early reflections
  impulse(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      for (let r = 0; r < 6; r++) {
        const at = Math.floor(rate * (0.012 + r * 0.019 + Math.random() * 0.01));
        if (at < len) data[at] += (Math.random() < 0.5 ? -1 : 1) * (0.7 - r * 0.1);
      }
    }
    return buf;
  }

  setEnvironment(theme) {
    if (!this.ctx) { this.pendingEnv = theme; return; }
    const open = theme?.backdrop === 'mesa' || theme?.backdrop === 'sea';
    // short reverb tails: the convolution runs on the audio thread for every sound, long ones cost the most
    this.reverb.buffer = open ? this.impulse(1.1, 3.4) : this.impulse(1.4, 2.6);
    this.reverbAmount = open ? 0.18 : 0.3;
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; if (this.killBus) this.killBus.gain.value = this.killLevel(); }

  // kill clips sit well above the game: full level from about 60% master volume up, but still silent at 0
  killLevel() { return Math.min(1, this.volume * 1.7); }

  // Kill confirmation clips (headshot / rocket / normal), played at full level: straight to the output
  // (only the master volume slider applies), not through the compressor and limiter, so the gunfire
  // around them can't squash them. The game mix dips briefly underneath so the clip stands out.
  // Returns false when the clip isn't loaded, so the caller can fall back to the synth sting.
  // Win music: starts with the HONORABLE banner and keeps playing until the next match starts
  // (stopMusic is called then), fading out instead of cutting off.
  winMusic() {
    const buf = this.samples.win;
    if (!this.ctx || !buf) return false;
    const ctx = this.ctx, t = ctx.currentTime;
    this.stopMusic(0.05);
    if (!this.killBus) { this.killBus = ctx.createGain(); this.killBus.gain.value = this.killLevel(); this.killBus.connect(ctx.destination); }
    // a kill clip still ringing out gives way to the music
    if (this.killSrc) { try { this.killGain.gain.setTargetAtTime(0, t, 0.05); this.killSrc.stop(t + 0.3); } catch { /* ended */ } this.killSrc = null; }
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf;
    src.loop = true; // a long intermission (or the host waiting) just keeps the music going
    g.gain.value = 1;
    src.connect(g); g.connect(this.killBus);
    src.start(t);
    this.music = { src, g };
    // game sounds dip while the banner plays, then come back under the music
    const m = this.master.gain;
    m.cancelScheduledValues(t);
    m.setValueAtTime(m.value, t);
    m.linearRampToValueAtTime(this.volume * 0.15, t + 0.05);
    m.setValueAtTime(this.volume * 0.15, t + 2.8);
    m.linearRampToValueAtTime(this.volume * 0.6, t + 3.4);
    return true;
  }

  stopMusic(fade = 0.8) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.music) {
      const { src, g } = this.music;
      this.music = null;
      try { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + fade); src.stop(t + fade + 0.05); } catch { /* ended */ }
    }
    if (this.master) {
      const m = this.master.gain;
      m.cancelScheduledValues(t); m.setValueAtTime(m.value, t); m.linearRampToValueAtTime(this.volume, t + Math.max(0.05, fade));
    }
  }

  killSound(kind) {
    const buf = this.samples[{ head: 'killHead', rocket: 'killRocket', died: 'died', win: 'win' }[kind] || 'killNormal'];
    if (!this.ctx || !buf) return false;
    const ctx = this.ctx, t = ctx.currentTime;
    if (!this.killBus) { this.killBus = ctx.createGain(); this.killBus.gain.value = this.killLevel(); this.killBus.connect(ctx.destination); }
    // one clip at a time: a double kill restarts it instead of stacking two at full level
    if (this.killSrc) { try { this.killSrc.stop(t + 0.03); this.killGain.gain.setTargetAtTime(0, t, 0.01); } catch { /* already ended */ } }
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf;
    g.gain.value = 1;
    src.connect(g); g.connect(this.killBus);
    src.start(t);
    this.killSrc = src; this.killGain = g;
    src.onended = () => { if (this.killSrc === src) this.killSrc = null; };
    // duck the rest of the game under the clip
    const m = this.master.gain, d = buf.duration;
    m.cancelScheduledValues(t);
    m.setValueAtTime(m.value, t);
    m.linearRampToValueAtTime(this.volume * 0.15, t + 0.03);
    m.setValueAtTime(this.volume * 0.15, t + Math.max(0.05, d - 0.3));
    m.linearRampToValueAtTime(this.volume, t + d + 0.1);
    return true;
  }

  updateListener(pos, fwd, up) {
    this.listener.x = pos.x; this.listener.y = pos.y; this.listener.z = pos.z;
    if (!this.ctx) return;
    // the browser / OS can suspend or interrupt the audio device mid-game (Windows audio glitches, Bluetooth
    // headsets, another app grabbing the device): bring it straight back instead of staying silent
    if (this.ctx.state !== 'running' && this.ctx.state !== 'closed' && !this.resuming) {
      this.resuming = true;
      this.ctx.resume().catch(() => {}).finally(() => { this.resuming = false; });
    }
    if (this.pendingEnv) { this.setEnvironment(this.pendingEnv); this.pendingEnv = null; }
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

  dist(pos) { return pos ? Math.hypot(pos.x - this.listener.x, pos.y - this.listener.y, pos.z - this.listener.z) : 0; }

  // Output node for a voice. Positional voices get air absorption, optional occlusion, HRTF panning
  // and a reverb send that grows with distance.
  out(pos, { ref = 3, gain = 1, reverb = 1, occlude = true, fx = false } = {}) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = gain;
    const bus = fx ? this.fx : this.dry;
    if (!pos) {
      g.connect(bus);
      if (reverb > 0) {
        const s = ctx.createGain();
        s.gain.value = this.reverbAmount * 0.35 * reverb;
        g.connect(s); s.connect(this.reverb);
      }
      return g;
    }
    const d = this.dist(pos);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    let cutoff = 18000 * Math.exp(-d / 55);
    let occ = false;
    if (occlude && this.occlusion && d > 2) occ = this.occlusion(pos);
    if (occ) { cutoff = Math.min(cutoff, 1100); g.gain.value *= 0.6; }
    lp.frequency.value = Math.max(700, cutoff);
    const p = ctx.createPanner();
    // equal-power panning: HRTF convolves every voice and, with dozens of gunshots alive at once, could
    // overload the audio thread on slower PCs (sound dropping out and coming back)
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.maxDistance = 250;
    p.rolloffFactor = 1.1;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
    else p.setPosition(pos.x, pos.y, pos.z);
    g.connect(lp); lp.connect(p); p.connect(bus);
    if (reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = this.reverbAmount * reverb * Math.min(1.6, 0.4 + d / 30) * (occ ? 1.3 : 1);
      lp.connect(s); s.connect(this.reverb);
    }
    g._panner = p;
    return g;
  }

  // Voice budget: a busy fight (your rifle at 10 shots/s, five bots shooting, impacts, footsteps,
  // shells) easily has 60+ sounds alive. Low-priority sounds give way first; your own gun, hits, kills
  // and damage always play.
  ok(budget = 64) { return this.ctx && this.ctx.state === 'running' && this.voices < budget; }

  // Rate cap per kind of sound (sliding 0.25 s window). In a rush dozens of impacts, shells, whizzes and
  // crumbles arrive at once; each one builds several audio nodes, and the audio thread falling behind is
  // what made the whole mix crackle and drop out. Extra copies of the same kind add nothing you can hear.
  rate(kind, perSec) {
    if (!this.ctx || this.ctx.state !== 'running') return false;
    const now = this.ctx.currentTime;
    this.rates = this.rates || new Map();
    let r = this.rates.get(kind);
    if (!r || now - r.t0 > 0.25) { r = { t0: now, n: 0 }; this.rates.set(kind, r); }
    if (r.n >= Math.max(1, perSec * 0.25)) return false;
    r.n++;
    return true;
  }

  now(pos, travel = false) {
    const t = this.ctx.currentTime + 0.005;
    return travel && pos ? t + Math.min(0.6, this.dist(pos) / SPEED_OF_SOUND) : t;
  }

  noiseSrc(buffer = this.noise) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.loopStart = Math.random();
    return s;
  }

  track(dur) { this.voices++; setTimeout(() => { this.voices--; }, dur * 1000 + 80); }

  env(param, t, attack, peak, decay, end = 0.0001) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    param.exponentialRampToValueAtTime(end, t + attack + decay);
  }

  burst(dest, t, { type = 'bandpass', freq = 1000, q = 1, attack = 0.002, decay = 0.1, peak = 1, buffer, sweepTo, drive = 0 } = {}) {
    const ctx = this.ctx;
    const src = this.noiseSrc(buffer);
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + decay);
    const g = ctx.createGain();
    this.env(g.gain, t, attack, peak, decay);
    src.connect(f);
    if (drive) { const ws = this.shaper(drive); f.connect(ws); ws.connect(g); } else f.connect(g);
    g.connect(dest);
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

  // ---------------------------------------------------------------- weapons

  rifle(pos, local = false, shooter = 0) {
    if (!this.ok(1e9) || (!local && !this.rate('rifleRemote', 40))) return;
    const d = local ? 0 : this.dist(pos);
    const far = Math.min(1, d / 70);
    let t = this.now(pos, !local);
    // When a frame runs late the game fires 2-3 shots in that one frame. Played at the same instant they
    // stack into one huge peak, the limiter clamps down and the gun goes quiet for a moment. Keep the
    // rifle's own rhythm instead: each shot at least one fire interval after the previous one.
    this.lastShot = this.lastShot || new Map();
    const key = local ? -1 : shooter;
    const prev = this.lastShot.get(key) ?? 0;
    if (t < prev + 0.085) t = prev + 0.085;
    if (t - this.ctx.currentTime > 0.3) return; // too far behind: drop it rather than lag
    this.lastShot.set(key, t);
    const o = this.out(local ? null : pos, { ref: 7, gain: local ? 0.62 : 1.15, reverb: local ? 0.9 : 1.4 });
    const v = 0.92 + Math.random() * 0.16;
    const shots = [this.samples.rifle1, this.samples.rifle2, this.samples.rifle3].filter(Boolean);
    if (shots.length) {
      // recorded shot (random take, slight pitch/level variation so bursts don't sound like a loop) with a
      // little synthesised punch underneath; distance and walls are handled by the output chain
      const buf = shots[(Math.random() * shots.length) | 0];
      // each gun keeps its newest shot crisp: the previous shot's tail fades as the next one fires, so a
      // burst stays a clean rattle instead of piling up into mush; only a few enemy guns sound at once
      const prevShot = this.lastByShooter.get(key);
      if (prevShot) prevShot.fade(t + 0.03, 0.07);
      const set = local ? this.voiceSets.localRifle : this.voiceSets.remoteRifle;
      this.limit(set, local ? 4 : 6, t);
      const h = this.play(buf, o, t, { gain: (local ? 0.9 : 0.95) * (0.9 + Math.random() * 0.2), rate: 0.95 + Math.random() * 0.1 });
      set.push(h);
      this.lastByShooter.set(key, h);
      if (local) this.tone(o, t, { from: 130 * v, to: 45, decay: 0.08, peak: 0.4 });
      else if (far > 0.4) this.burst(o, t + 0.01, { type: 'lowpass', freq: 500, attack: 0.01, decay: 0.5, peak: 0.2 * far, buffer: this.brown });
      this.track(0.8);
      return;
    }
    // synthesised fallback
    this.burst(o, t, { type: 'highpass', freq: 4200, decay: 0.012, peak: (local ? 0.5 : 0.3) * (1 - far) });
    this.burst(o, t, { type: 'bandpass', freq: 2300 * v, q: 0.7, decay: 0.055, peak: 1.0 * (1 - far * 0.8), drive: 3 });
    this.tone(o, t, { from: 150 * v, to: 48, decay: 0.11, peak: 0.95 });
    this.burst(o, t, { type: 'lowpass', freq: 1100, decay: 0.16, peak: 0.55 });
    this.burst(o, t + 0.01, { type: 'lowpass', freq: 700 - far * 300, attack: 0.01, decay: 0.45 + far * 0.4, peak: 0.28 + far * 0.25, buffer: this.brown });
    if (local) this.burst(o, t + 0.05, { type: 'bandpass', freq: 5200, q: 6, decay: 0.03, peak: 0.08 });
    this.track(0.9);
  }

  // trigger pulled on an empty magazine
  dryFire() {
    if (!this.ok(1e9)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.5, reverb: 0.2 });
    this.burst(o, t, { type: 'highpass', freq: 3500, decay: 0.015, peak: 0.6 });
    this.burst(o, t + 0.035, { type: 'bandpass', freq: 1800, q: 4, decay: 0.02, peak: 0.35 });
    this.track(0.1);
  }

  // bullet passing close to the listener
  whiz(pos, close) {
    if (!this.ok(60) || !this.rate('whiz', 8)) return;
    const t = this.now();
    const o = this.out(pos, { ref: 1.5, gain: 0.9, reverb: 0.3, occlude: false });
    this.burst(o, t, { type: 'bandpass', freq: 4200, q: 3, sweepTo: 1300, attack: 0.01, decay: 0.13, peak: 0.55 });
    if (close) this.burst(o, t, { type: 'highpass', freq: 3000, decay: 0.02, peak: 0.7, drive: 2 });
    this.track(0.2);
  }

  rocketLaunch(pos, local = false) {
    if (!this.ok(1e9) || (!local && !this.rate('launchRemote', 6))) return;
    const t = this.now(pos, !local);
    const o = this.out(local ? null : pos, { ref: 7, gain: local ? 0.7 : 1.1, reverb: 1.2, fx: true });
    if (this.samples.launch) {
      this.play(this.samples.launch, o, t, { gain: local ? 1.25 : 1.3, rate: 0.96 + Math.random() * 0.08 });
      this.burst(o, t + 0.02, { type: 'lowpass', freq: 300, sweepTo: 2600, attack: 0.03, decay: 0.55, peak: 0.45 });
      this.track(0.9);
      return;
    }
    this.burst(o, t, { type: 'lowpass', freq: 300, sweepTo: 3000, attack: 0.02, decay: 0.6, peak: 0.95 });
    this.tone(o, t, { from: 95, to: 38, decay: 0.3, peak: 0.85 });
    this.burst(o, t, { type: 'bandpass', freq: 700, q: 2, decay: 0.14, peak: 0.6, drive: 2 });
    this.burst(o, t + 0.03, { type: 'highpass', freq: 2500, decay: 0.35, peak: 0.2 });
    this.track(0.8);
  }

  // looping hiss attached to a rocket in flight; call loopMove every frame and loopStop on impact
  loopStart(id, pos) {
    if (!this.ok(80) || this.loops.has(id)) return;
    const ctx = this.ctx;
    const src = this.noiseSrc();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.8;
    const o = this.out(pos, { ref: 4, gain: 0.0001, reverb: 0.4, occlude: false, fx: true });
    src.connect(f); f.connect(o);
    o.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.08);
    src.start();
    this.loops.set(id, { src, o, f });
  }

  loopMove(id, pos, speedToward = 0) {
    const l = this.loops.get(id);
    if (!l || !l.o._panner) return;
    const p = l.o._panner, t = this.ctx.currentTime;
    if (p.positionX) { p.positionX.setTargetAtTime(pos.x, t, 0.02); p.positionY.setTargetAtTime(pos.y, t, 0.02); p.positionZ.setTargetAtTime(pos.z, t, 0.02); }
    else p.setPosition(pos.x, pos.y, pos.z);
    // crude doppler on the filter centre
    l.f.frequency.setTargetAtTime(1400 * (1 + Math.max(-0.4, Math.min(0.4, speedToward / 120))), t, 0.05);
  }

  loopStop(id) {
    const l = this.loops.get(id);
    if (!l) return;
    const t = this.ctx.currentTime;
    l.o.gain.cancelScheduledValues(t);
    l.o.gain.setValueAtTime(Math.max(0.0001, l.o.gain.value), t);
    l.o.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    l.src.stop(t + 0.1);
    this.loops.delete(id);
  }

  explosion(pos, dist) {
    if (!this.ok(1e9) || !this.rate('boom', 8)) return;
    const t = this.now(pos, true);
    const far = Math.min(1, dist / 70);
    const o = this.out(pos, { ref: 12, gain: 1.4, reverb: 1.4, fx: true });
    if (this.samples.boom) {
      // recorded blast, pitched down a little at range; the synth layers below add debris and the crack
      this.limit(this.voiceSets.booms, 3, t);
      this.voiceSets.booms.push(this.play(this.samples.boom, o, t, { gain: 1.3, rate: (0.92 + Math.random() * 0.1) * (1 - far * 0.12) }));
      this.burst(o, t, { type: 'lowpass', freq: 1400 * (1 - far * 0.7), sweepTo: 110, attack: 0.003, decay: 1.2, peak: 0.55, drive: 2.5 });
      if (far < 0.7) this.burst(o, t, { type: 'highpass', freq: 3200, decay: 0.2, peak: 0.4, drive: 2 });
      for (let i = 0; i < (this.voiceSets.booms.length > 1 ? 3 : 8); i++) {
        const tt = t + 0.25 + Math.random() * 1.4;
        this.burst(o, tt, { type: 'bandpass', freq: 900 + Math.random() * 2400, q: 4, decay: 0.05 + Math.random() * 0.05, peak: 0.15 * (1 - far) });
      }
      this.track(2.4);
      return;
    }
    this.tone(o, t, { from: 70, to: 22, attack: 0.004, decay: 1.3, peak: 1.0 });
    this.burst(o, t, { type: 'lowpass', freq: 1600 * (1 - far * 0.7), sweepTo: 110, attack: 0.003, decay: 1.7, peak: 1.0, drive: 2.5 });
    this.burst(o, t, { type: 'lowpass', freq: 240, attack: 0.01, decay: 2.6, peak: 0.95, buffer: this.brown });
    if (far < 0.7) this.burst(o, t, { type: 'highpass', freq: 3200, decay: 0.2, peak: 0.45, drive: 2 });
    // falling debris rattle
    for (let i = 0; i < 10; i++) {
      const tt = t + 0.25 + Math.random() * 1.4;
      this.burst(o, tt, { type: 'bandpass', freq: 900 + Math.random() * 2400, q: 4, decay: 0.05 + Math.random() * 0.05, peak: 0.15 * (1 - far) });
    }
    this.track(3);
  }

  crumble(pos, size = 1) {
    if (!this.ok(90) || !this.rate('crumble', 6)) return;
    const t = this.now(pos, true);
    const o = this.out(pos, { ref: 9, gain: Math.min(1.5, 0.55 + size * 0.14), reverb: 1.5, fx: true });
    this.burst(o, t, { type: 'lowpass', freq: 420, attack: 0.06, decay: 1.8 + size * 0.2, peak: 0.95, buffer: this.brown });
    this.tone(o, t, { from: 60, to: 28, attack: 0.05, decay: 1.4, peak: 0.6 });
    for (let i = 0; i < 12; i++) this.burst(o, t + Math.random() * 1.4, { type: 'bandpass', freq: 400 + Math.random() * 1800, q: 3, decay: 0.07 + Math.random() * 0.08, peak: 0.3 });
    this.track(2.6);
  }

  // bullet hitting a surface: concrete, metal, wood, dirt, foliage
  impact(pos, cls = 'concrete') {
    if (!this.ok(60) || !this.rate('impact', 16)) return;
    const t = this.now();
    const o = this.out(pos, { ref: 2.5, gain: 0.55, reverb: 0.8 });
    if (cls === 'metal') {
      this.tone(o, t, { type: 'triangle', from: 1700 + Math.random() * 600, decay: 0.22, peak: 0.25 });
      this.tone(o, t, { type: 'sine', from: 2900 + Math.random() * 500, decay: 0.15, peak: 0.15 });
      this.burst(o, t, { type: 'highpass', freq: 3500, decay: 0.02, peak: 0.6 });
      if (Math.random() < 0.25) this.tone(o, t + 0.02, { type: 'sine', from: 3600, to: 1400, decay: 0.32, peak: 0.12 });
    } else if (cls === 'wood') {
      this.burst(o, t, { type: 'bandpass', freq: 650, q: 2, decay: 0.07, peak: 0.8 });
      this.tone(o, t, { from: 240, to: 160, decay: 0.06, peak: 0.4 });
    } else if (cls === 'dirt') {
      this.burst(o, t, { type: 'lowpass', freq: 500, decay: 0.09, peak: 0.8 });
      this.burst(o, t + 0.01, { type: 'highpass', freq: 2000, decay: 0.12, peak: 0.12 });
    } else if (cls === 'foliage') {
      this.burst(o, t, { type: 'highpass', freq: 2500, attack: 0.01, decay: 0.16, peak: 0.25 });
    } else {
      this.burst(o, t, { type: 'bandpass', freq: 2800 + Math.random() * 1800, q: 2, decay: 0.04, peak: 0.7, drive: 1.5 });
      this.burst(o, t, { type: 'lowpass', freq: 700, decay: 0.05, peak: 0.35 });
    }
    this.track(0.4);
  }

  flesh(pos) {
    if (!this.ok(60)) return;
    const t = this.now();
    const o = this.out(pos, { ref: 3, gain: 0.7, reverb: 0.4 });
    this.tone(o, t, { from: 210, to: 85, decay: 0.08, peak: 0.6 });
    this.burst(o, t, { type: 'lowpass', freq: 900, decay: 0.07, peak: 0.6 });
    this.track(0.15);
  }

  // ---------------------------------------------------------------- feedback

  hitmarker(kind = 0) {
    if (!this.ok(1e9)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.36, reverb: 0 });
    if (kind === 2) {
      // kill confirm: punchy thunk + bright two-note chime
      this.tone(o, t, { type: 'sine', from: 180, to: 70, decay: 0.12, peak: 0.6 });
      this.tone(o, t + 0.01, { type: 'triangle', from: 988, decay: 0.16, peak: 0.55 });
      this.tone(o, t + 0.1, { type: 'triangle', from: 1480, decay: 0.32, peak: 0.55 });
      this.tone(o, t + 0.1, { type: 'sine', from: 2960, decay: 0.2, peak: 0.12 });
    } else if (kind === 1) {
      // headshot "dink"
      this.tone(o, t, { type: 'sine', from: 2600, decay: 0.16, peak: 0.45 });
      this.tone(o, t, { type: 'sine', from: 3900, decay: 0.1, peak: 0.25 });
      this.burst(o, t, { type: 'highpass', freq: 5000, decay: 0.02, peak: 0.4 });
    } else {
      this.tone(o, t, { type: 'square', from: 1600, decay: 0.035, peak: 0.22 });
      this.burst(o, t, { type: 'highpass', freq: 3500, decay: 0.015, peak: 0.3 });
    }
    this.track(0.5);
  }

  // whoosh + bass hit for the kill banner
  elimination(streak = 1) {
    if (!this.ok(1e9)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.32, reverb: 0.6 });
    this.burst(o, t, { type: 'bandpass', freq: 500, q: 0.8, sweepTo: 3500, attack: 0.08, decay: 0.18, peak: 0.6 });
    this.tone(o, t + 0.12, { type: 'sine', from: 90, to: 45, decay: 0.35, peak: 0.8 });
    if (streak > 1) [0, 4, 7, 12].slice(0, Math.min(4, streak + 1)).forEach((st, i) => this.tone(o, t + 0.15 + i * 0.07, { type: 'triangle', from: 523 * 2 ** (st / 12), decay: 0.25, peak: 0.3 }));
    this.track(0.8);
  }

  footstep(pos, local = false, cls = 'concrete') {
    if (!this.ok(local ? 90 : 34)) return;
    const t = this.now();
    const o = this.out(local ? null : pos, { ref: 2, gain: local ? 0.14 : 0.42, reverb: 0.3 });
    const f = { concrete: 520, metal: 900, wood: 380, dirt: 300, foliage: 1800 }[cls] || 520;
    this.burst(o, t, { type: 'lowpass', freq: f + Math.random() * 200, decay: 0.07, peak: 0.85 });
    if (cls === 'metal') this.tone(o, t, { type: 'triangle', from: 420 + Math.random() * 80, decay: 0.08, peak: 0.15 });
    if (cls === 'dirt' || cls === 'foliage') this.burst(o, t + 0.01, { type: 'highpass', freq: 2500, decay: 0.08, peak: 0.12 });
    this.track(0.15);
  }

  land(local = true, pos = null) {
    if (!this.ok(90)) return;
    const t = this.now();
    const o = this.out(local ? null : pos, { ref: 2, gain: local ? 0.32 : 0.45, reverb: 0.4 });
    this.burst(o, t, { type: 'lowpass', freq: 320, decay: 0.13, peak: 0.9 });
    this.tone(o, t, { from: 110, to: 55, decay: 0.09, peak: 0.45 });
    this.burst(o, t + 0.02, { type: 'bandpass', freq: 1800, q: 3, decay: 0.04, peak: 0.15 });
    this.track(0.25);
  }

  jump() {
    if (!this.ok(90)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.12, reverb: 0.2 });
    this.burst(o, t, { type: 'bandpass', freq: 900, q: 1.5, decay: 0.06, peak: 0.6 });
    this.track(0.12);
  }

  hurt(heavy = false) {
    if (!this.ok(1e9)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.5, reverb: 0.2 });
    this.tone(o, t, { type: 'sine', from: heavy ? 120 : 160, to: 55, decay: 0.2, peak: 0.6 });
    this.burst(o, t, { type: 'lowpass', freq: 650, decay: 0.14, peak: 0.6 });
    this.burst(o, t, { type: 'bandpass', freq: 2200, q: 3, decay: 0.05, peak: 0.15 });
    this.track(0.3);
  }

  heartbeat() {
    if (!this.ok(1e9)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.35, reverb: 0 });
    this.tone(o, t, { from: 62, to: 40, decay: 0.12, peak: 0.8 });
    this.tone(o, t + 0.18, { from: 55, to: 36, decay: 0.14, peak: 0.6 });
    this.track(0.4);
  }

  reload() {
    if (!this.ok(1e9)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.32, reverb: 0.4 });
    this.burst(o, t + 0.15, { type: 'bandpass', freq: 1800, q: 4, decay: 0.04, peak: 0.8 });   // mag release
    this.burst(o, t + 0.32, { type: 'lowpass', freq: 600, decay: 0.08, peak: 0.4 });          // mag drops
    this.burst(o, t + 0.75, { type: 'bandpass', freq: 1200, q: 4, decay: 0.05, peak: 0.9 });   // mag seated
    this.tone(o, t + 0.75, { from: 220, to: 140, decay: 0.05, peak: 0.3 });
    this.burst(o, t + 1.3, { type: 'bandpass', freq: 2600, q: 5, decay: 0.03, peak: 0.9 });    // bolt back
    this.burst(o, t + 1.42, { type: 'bandpass', freq: 2000, q: 5, decay: 0.035, peak: 0.85 }); // bolt home
    this.track(1.6);
  }

  shell() {
    if (!this.ok(60) || Math.random() < 0.5 || !this.rate('shell', 5)) return;
    const t = this.now() + 0.35 + Math.random() * 0.15;
    const o = this.out(null, { gain: 0.06, reverb: 0.3 });
    this.tone(o, t, { type: 'triangle', from: 3800 + Math.random() * 900, decay: 0.08, peak: 0.4 });
    this.tone(o, t + 0.07, { type: 'triangle', from: 4200 + Math.random() * 900, decay: 0.05, peak: 0.25 });
    this.track(0.7);
  }

  heal() {
    if (!this.ok(1e9)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.25, reverb: 0.5 });
    this.tone(o, t, { type: 'triangle', from: 660, to: 990, decay: 0.25, peak: 0.5 });
    this.tone(o, t + 0.08, { type: 'sine', from: 1320, decay: 0.25, peak: 0.2 });
    this.track(0.4);
  }

  spawn() {
    if (!this.ok(1e9)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.22, reverb: 0.6 });
    this.tone(o, t, { type: 'sawtooth', from: 220, to: 880, attack: 0.01, decay: 0.35, peak: 0.22 });
    this.burst(o, t, { type: 'bandpass', freq: 800, sweepTo: 4000, attack: 0.05, decay: 0.3, peak: 0.25 });
    this.track(0.5);
  }

  roundEnd() {
    if (!this.ok(1e9)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.3, reverb: 0.8 });
    [523, 659, 784, 1046].forEach((f, i) => this.tone(o, t + i * 0.12, { type: 'triangle', from: f, decay: 0.7, peak: 0.4 }));
    this.track(1.4);
  }

  ui() {
    if (!this.ok(1e9)) return;
    const t = this.now();
    const o = this.out(null, { gain: 0.15, reverb: 0 });
    this.tone(o, t, { type: 'square', from: 900, to: 1300, decay: 0.05, peak: 0.3 });
    this.track(0.1);
  }
}
