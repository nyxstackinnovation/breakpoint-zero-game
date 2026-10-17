// Persistent user settings (localStorage, with safe fallbacks).

const KEY = 'bpz.settings.v1';
const DEFAULTS = {
  name: '',
  sensitivity: 1.0,
  fov: 90,
  volume: 0.7,
  quality: 'medium',
  invertY: false,
  showNames: true,
  showFps: false,
  shake: true,
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return { ...DEFAULTS };
}

class Settings {
  constructor() {
    this.values = load();
    this.listeners = new Set();
  }
  get(k) { return this.values[k]; }
  set(k, v) {
    this.values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* ignore */ }
    for (const fn of this.listeners) fn(k, v);
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

export const settings = new Settings();

export const QUALITY = {
  low: { pixelRatio: 0.75, shadows: false, shadowSize: 0, particles: 0.5, debris: 300, antialias: false, characterShadows: false },
  medium: { pixelRatio: 1, shadows: true, shadowSize: 1024, particles: 0.8, debris: 700, antialias: false, characterShadows: true },
  high: { pixelRatio: 2, shadows: true, shadowSize: 2048, particles: 1, debris: 1200, antialias: true, characterShadows: true },
};
