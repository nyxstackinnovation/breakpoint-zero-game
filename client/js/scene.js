// Renderer, camera, sky dome, lighting, map backdrops and water.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeRng } from '/shared/util.js';

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FRAG = `
uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; uniform float time; uniform float cover;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, bottom, pow(clamp(-h, 0.0, 1.0), 0.4));
  float s = max(dot(d, normalize(sunDir)), 0.0);
  col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 40.0) * 0.35 + pow(s, 6.0) * 0.12);
  if (h > 0.02) {
    vec2 uv = d.xz / (h + 0.15) * 1.6 + vec2(time * 0.01, time * 0.004);
    float thr = 0.52 - cover * 0.3;
    float c = smoothstep(thr, thr + 0.33, fbm(uv));
    // heavier cover: greyer, darker cloud bodies with bright sun-lit gaps and rims
    vec3 cloudCol = mix(horizon * 1.05, vec3(1.0), 0.55 - cover * 0.3) * (1.0 - cover * 0.35 * c) + sunColor * pow(s, 8.0) * (0.4 + cover * 0.9);
    col = mix(col, cloudCol, c * (0.6 + cover * 0.3) * smoothstep(0.02, 0.2, h));
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class SceneManager {
  constructor(canvas, quality) {
    this.canvas = canvas;
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.5;
    this.camera = new THREE.PerspectiveCamera(90, 1, 0.05, 600);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.skyUniforms = {
      top: { value: new THREE.Color(0x3366cc) }, horizon: { value: new THREE.Color(0xaaccee) }, bottom: { value: new THREE.Color(0xccddee) },
      sunDir: { value: new THREE.Vector3(0.3, 0.7, 0.2) }, sunColor: { value: new THREE.Color(0xffffff) }, time: { value: 0 }, cover: { value: 0 },
    };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), new THREE.ShaderMaterial({
      uniforms: this.skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
    }));
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.sky = sky;
    this.scene.add(sky);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.1);
    this.scene.add(this.hemi);
    // flat fill so interiors and shadowed streets never go black
    this.fill = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(this.fill);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = quality.shadows;
    this.sun.shadow.mapSize.set(quality.shadowSize || 1024, quality.shadowSize || 1024);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.intensity = 0.72; // softer, readable shadows
    const sc = this.sun.shadow.camera;
    sc.left = -46; sc.right = 46; sc.top = 46; sc.bottom = -46; sc.near = 1; sc.far = 220;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.fog = new THREE.Fog(0xaaccee, 50, 150);

    this.backdrop = new THREE.Group();
    this.scene.add(this.backdrop);
    this.water = null;
    this.time = 0;

    // dynamic resolution: drops the render scale when the frame rate sags, restores it when it recovers
    this.scale = 1;
    this.perfT = 0; this.perfFrames = 0;
    this.shadowFrame = 0;
    this.renderer.shadowMap.autoUpdate = false;

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // called once per rendered frame
  adapt(dt) {
    const sm = this.renderer.shadowMap;
    const every = this.quality.shadowEvery || 0;
    if (sm.enabled && every > 0 && (this.shadowFrame++ % every) === 0) sm.needsUpdate = true;
    this.perfT += dt; this.perfFrames++;
    if (this.perfT < 1.5) return;
    const fps = this.perfFrames / this.perfT;
    this.perfT = 0; this.perfFrames = 0;
    let s = this.scale;
    if (fps < 50) s = Math.max(0.6, s - (fps < 35 ? 0.15 : 0.08));
    else if (fps > 58) s = Math.min(1, s + 0.05);
    if (s !== this.scale) { this.scale = s; this.resize(); }
  }

  setQuality(q) {
    this.quality = q;
    this.renderer.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    this.scale = 1;
    if (q.shadows) {
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    this.scene.traverse((o) => { if (o.material && o.material.needsUpdate !== undefined) o.material.needsUpdate = true; });
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio) * (this.scale || 1);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.onResize) this.onResize(w, h);
  }

  applyTheme(theme, size) {
    const t = theme;
    this.skyUniforms.top.value.setHex(t.skyTop);
    this.skyUniforms.horizon.value.setHex(t.skyHorizon);
    this.skyUniforms.bottom.value.setHex(t.skyBottom);
    const sd = new THREE.Vector3(...t.sunDir).normalize();
    this.skyUniforms.sunDir.value.copy(sd);
    this.skyUniforms.sunColor.value.setHex(t.sun);
    this.skyUniforms.cover.value = t.cloudCover ?? 0;
    this.hemi.color.setHex(t.hemiSky);
    this.hemi.groundColor.setHex(t.hemiGround);
    this.hemi.intensity = t.hemiIntensity;
    this.sun.color.setHex(t.sun);
    this.sun.intensity = t.sunIntensity;
    const cx = size[0] / 2, cz = size[2] / 2;
    this.center = new THREE.Vector3(cx, 0, cz);
    this.sun.position.set(cx + sd.x * 100, sd.y * 100, cz + sd.z * 100);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.target.updateMatrixWorld();
    this.scene.fog.color.setHex(t.fog);
    this.scene.fog.near = t.fogNear;
    this.scene.fog.far = t.fogFar + 60;
    this.buildBackdrop(t, size);
  }

  buildBackdrop(t, size) {
    for (const c of [...this.backdrop.children]) { c.geometry?.dispose(); this.backdrop.remove(c); }
    this.water = null;
    const cx = size[0] / 2, cz = size[2] / 2;
    const rng = makeRng(1337);
    const groundColor = new THREE.Color(t.fog).multiplyScalar(0.55);
    // far ground so the horizon never shows void
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), new THREE.MeshLambertMaterial({ color: groundColor }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, t.backdrop === 'sea' ? 0.5 : 1.95, cz);
    ground.receiveShadow = false;
    this.backdrop.add(ground);
    const geos = [];
    const col = new THREE.Color();
    const addBox = (x, z, w, d, h, color, y0 = 1.9) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y0 + h / 2, z);
      col.setHex(color);
      const n = g.attributes.position.count;
      const colors = new Float32Array(n * 3);
      const pos = g.attributes.position;
      for (let i = 0; i < n; i++) {
        const k = 0.75 + 0.25 * ((pos.getY(i) - y0) / h);
        colors[i * 3] = col.r * k; colors[i * 3 + 1] = col.g * k; colors[i * 3 + 2] = col.b * k;
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geos.push(g);
    };
    if (t.backdrop === 'city') {
      for (let i = 0; i < 140; i++) {
        const a = rng() * Math.PI * 2, r = 62 + rng() * 120;
        const w = 6 + rng() * 14, d = 6 + rng() * 14, h = 8 + rng() * (r > 120 ? 70 : 45);
        addBox(cx + Math.cos(a) * r, cz + Math.sin(a) * r, w, d, h, t.backdropColors[i % t.backdropColors.length]);
        if (rng() < 0.3) addBox(cx + Math.cos(a) * r, cz + Math.sin(a) * r, w * 0.5, d * 0.5, h + 6 + rng() * 10, t.backdropColors[(i + 1) % t.backdropColors.length]);
      }
    } else if (t.backdrop === 'ruins') {
      // a shelled town all around: blocks with ragged, broken tops and a few gutted towers
      for (let i = 0; i < 150; i++) {
        const a = rng() * Math.PI * 2, r = 64 + rng() * 120;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        const w = 6 + rng() * 12, d = 6 + rng() * 12, h = 5 + rng() * (r > 120 ? 22 : 14);
        const c = t.backdropColors[i % t.backdropColors.length];
        addBox(x, z, w, d, h, c);
        for (let k = 0; k < 3; k++) if (rng() < 0.75) addBox(x + (rng() - 0.5) * w * 0.6, z + (rng() - 0.5) * d * 0.6, w * (0.2 + rng() * 0.3), d * (0.2 + rng() * 0.3), h + 1 + rng() * 7, c);
        if (rng() < 0.08) { addBox(x, z, 2, 2, h + 14 + rng() * 10, c); addBox(x + 3, z, 2, 2, h + 9 + rng() * 8, c); }
      }
    } else if (t.backdrop === 'mesa') {
      for (let i = 0; i < 40; i++) {
        const a = rng() * Math.PI * 2, r = 80 + rng() * 150;
        const g = new THREE.CylinderGeometry(10 + rng() * 25, 18 + rng() * 30, 15 + rng() * 40, 7 + Math.floor(rng() * 4));
        const h = g.parameters.height;
        g.translate(cx + Math.cos(a) * r, 1.9 + h / 2, cz + Math.sin(a) * r);
        col.setHex(t.backdropColors[i % t.backdropColors.length]);
        const n = g.attributes.position.count;
        const colors = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) { const f = 0.8 + 0.2 * Math.random(); colors[k * 3] = col.r * f; colors[k * 3 + 1] = col.g * f; colors[k * 3 + 2] = col.b * f; }
        g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geos.push(g.toNonIndexed ? g : g);
      }
    } else if (t.backdrop === 'sea') {
      for (let i = 0; i < 18; i++) {
        const a = Math.PI * 0.5 + (rng() - 0.5) * 2.4, r = 140 + rng() * 120;
        addBox(cx + Math.cos(a) * r * -1, cz + Math.sin(a) * r, 20 + rng() * 40, 20 + rng() * 40, 6 + rng() * 18, t.backdropColors[i % t.backdropColors.length], 0.5);
      }
      // city behind the docks
      for (let i = 0; i < 50; i++) {
        const z = cz + (rng() - 0.5) * 300, x = size[0] + 30 + rng() * 120;
        addBox(x, z, 8 + rng() * 12, 8 + rng() * 12, 10 + rng() * 40, t.backdropColors[i % t.backdropColors.length]);
      }
    }
    if (geos.length) {
      const normalized = geos.map((g) => (g.index ? g.toNonIndexed() : g));
      for (const g of normalized) { if (g.attributes.uv) g.deleteAttribute('uv'); }
      const merged = mergeGeometries(normalized, false);
      const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
      this.backdrop.add(mesh);
    }
    if (t.water) {
      const x1 = t.water.maxX ?? cx + 700, x0 = cx - 700;
      const wg = new THREE.PlaneGeometry(x1 - x0, 1400, 1, 1);
      const wm = new THREE.MeshPhongMaterial({ color: t.water.color, specular: 0x88aacc, shininess: 90, transparent: true, opacity: 0.82, depthWrite: true });
      const water = new THREE.Mesh(wg, wm);
      water.rotation.x = -Math.PI / 2;
      water.position.set((x0 + x1) / 2, t.water.level, cz);
      water.receiveShadow = true;
      this.water = water;
      this.backdrop.add(water);
    }
  }

  update(dt) {
    this.time += dt;
    this.skyUniforms.time.value = this.time;
    this.sky.position.copy(this.camera.position);
  }
}
