// Persistent user settings (localStorage, with safe fallbacks).

const KEY = 'bpz.settings.v1';

// Integrated / software GPUs start on Low; everyone else on Medium. Players can change it in Settings.
function defaultQuality() {
  // phones and tablets: small GPUs, hot batteries; start on Low
  try { if (window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0) return 'low'; } catch { /* ignore */ }
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    if (/intel|uhd|iris|swiftshader|llvmpipe|mali|adreno|powervr|apple gpu/i.test(name) && !/arc/i.test(name)) return 'low';
  } catch { /* ignore */ }
  return 'medium';
}
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
  botSkill: 'easy',   // Quick Match bot difficulty
  quickMap: 'any',    // Quick Match map ('any' = rotation)
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return { ...DEFAULTS, quality: defaultQuality() };
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
  // shadowEvery: re-render the shadow map every N frames; lights: dynamic muzzle/explosion lights
  low: { pixelRatio: 0.85, shadows: false, shadowSize: 0, particles: 0.5, debris: 250, antialias: false, characterShadows: false, shadowEvery: 0, lights: 0 },
  medium: { pixelRatio: 1, shadows: true, shadowSize: 1024, particles: 0.75, debris: 500, antialias: false, characterShadows: true, shadowEvery: 2, lights: 1 },
  high: { pixelRatio: 1.5, shadows: true, shadowSize: 2048, particles: 1, debris: 1000, antialias: true, characterShadows: true, shadowEvery: 1, lights: 3 },
};
