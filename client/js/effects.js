// Combat effects: textured GPU particles (smoke, fire, dust, flashes), velocity-aligned streaks
// (sparks and glowing tracers), instanced physical debris and splinters, atlas decals (bullet holes
// per material, blood, scorch), dynamic lights, explosions, rockets and elimination bursts.

import * as THREE from 'three';
import { VOXEL } from '/shared/constants.js';
import { MAT_CLASS } from '/shared/materials.js';
import { buildRocketProjectile } from './weaponModels.js';
import { loadTexture } from './textures.js';

// ---------------------------------------------------------------- textured point particles

const PVERT = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor; attribute float aTile; attribute float aRot;
varying float vAlpha; varying vec3 vColor; varying float vTile; varying float vRot; varying float vFog;
uniform float uScale; uniform float uFogNear; uniform float uFogFar;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * uScale / max(0.1, -mv.z), 1024.0);
  vAlpha = aAlpha; vColor = aColor; vTile = aTile; vRot = aRot;
  vFog = smoothstep(uFogNear, uFogFar, -mv.z);
}`;
const PFRAG = `
uniform sampler2D uSprites; uniform vec3 uFogColor; uniform float uAdditive;
varying float vAlpha; varying vec3 vColor; varying float vTile; varying float vRot; varying float vFog;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float s = sin(vRot), co = cos(vRot);
  c = vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5;
  if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0) discard;
  vec4 t = texture2D(uSprites, vec2((vTile + c.x) * 0.25, 1.0 - c.y));
  float a = t.a * vAlpha;
  if (a < 0.003) discard;
  vec3 col = vColor * t.rgb;
  if (uAdditive > 0.5) col *= (1.0 - vFog);
  else col = mix(col, uFogColor, vFog * 0.85);
  gl_FragColor = vec4(col, a);
}`;

const TILE = { SMOKE: 0, SPARK: 1, FLASH: 2, DUST: 3 };

class Particles {
  constructor(scene, max, additive, sprites) {
    this.max = max;
    this.count = 0;
    const F = (n) => new Float32Array(max * n);
    Object.assign(this, { pos: F(3), vel: F(3), col0: F(3), col1: F(3), life: F(1), maxLife: F(1), size0: F(1), size1: F(1), alpha0: F(1), drag: F(1), grav: F(1), tile: F(1), rot: F(1), spin: F(1) });
    const g = new THREE.BufferGeometry();
    const A = (n) => new THREE.BufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = A(3); this.aCol = A(3); this.aSize = A(1); this.aAlpha = A(1); this.aTile = A(1); this.aRot = A(1);
    g.setAttribute('position', this.aPos); g.setAttribute('aColor', this.aCol); g.setAttribute('aSize', this.aSize);
    g.setAttribute('aAlpha', this.aAlpha); g.setAttribute('aTile', this.aTile); g.setAttribute('aRot', this.aRot);
    g.setDrawRange(0, 0);
    this.uniforms = {
      uScale: { value: 600 }, uFogNear: { value: 50 }, uFogFar: { value: 180 }, uFogColor: { value: new THREE.Color() },
      uAdditive: { value: additive ? 1 : 0 }, uSprites: { value: sprites },
    };
    this.mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: PVERT, fragmentShader: PFRAG, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, alpha = 1, drag = 0, grav = 0, tile = TILE.SMOKE, spin = 0) {
    if (this.count >= this.max) return;
    const i = this.count++, i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col0[i3] = c0[0]; this.col0[i3 + 1] = c0[1]; this.col0[i3 + 2] = c0[2];
    this.col1[i3] = c1[0]; this.col1[i3 + 1] = c1[1]; this.col1[i3 + 2] = c1[2];
    this.life[i] = life; this.maxLife[i] = life; this.size0[i] = s0; this.size1[i] = s1; this.alpha0[i] = alpha;
    this.drag[i] = drag; this.grav[i] = grav; this.tile[i] = tile; this.rot[i] = Math.random() * 6.28; this.spin[i] = spin || (Math.random() - 0.5) * 1.5;
  }

  update(dt, fog, scale) {
    this.uniforms.uScale.value = scale;
    if (fog) { this.uniforms.uFogNear.value = fog.near; this.uniforms.uFogFar.value = fog.far; this.uniforms.uFogColor.value.copy(fog.color); }
    let n = this.count;
    const P = this.aPos.array, C = this.aCol.array, S = this.aSize.array, AL = this.aAlpha.array, T = this.aTile.array, R = this.aRot.array;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { n--; if (i !== n) this.move(n, i); i--; continue; }
      const i3 = i * 3;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= dr; this.vel[i3 + 1] = this.vel[i3 + 1] * dr - this.grav[i] * dt; this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.rot[i] += this.spin[i] * dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      P[i3] = this.pos[i3]; P[i3 + 1] = this.pos[i3 + 1]; P[i3 + 2] = this.pos[i3 + 2];
      for (let k = 0; k < 3; k++) C[i3 + k] = this.col0[i3 + k] + (this.col1[i3 + k] - this.col0[i3 + k]) * t;
      S[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * (1 - (1 - t) * (1 - t));
      AL[i] = this.alpha0[i] * (t < 0.08 ? t / 0.08 : 1 - (t - 0.08) / 0.92);
      T[i] = this.tile[i]; R[i] = this.rot[i];
    }
    this.count = n;
    this.points.geometry.setDrawRange(0, n);
    for (const a of [this.aPos, this.aCol, this.aSize, this.aAlpha, this.aTile, this.aRot]) a.needsUpdate = true;
  }

  move(from, to) {
    const f3 = from * 3, t3 = to * 3;
    for (let k = 0; k < 3; k++) { this.pos[t3 + k] = this.pos[f3 + k]; this.vel[t3 + k] = this.vel[f3 + k]; this.col0[t3 + k] = this.col0[f3 + k]; this.col1[t3 + k] = this.col1[f3 + k]; }
    for (const key of ['life', 'maxLife', 'size0', 'size1', 'alpha0', 'drag', 'grav', 'tile', 'rot', 'spin']) this[key][to] = this[key][from];
  }

  clear() { this.count = 0; this.points.geometry.setDrawRange(0, 0); }
}

// ---------------------------------------------------------------- velocity aligned streaks (sparks, tracers)

const SVERT = `
attribute vec3 iPos; attribute vec3 iDir; attribute vec2 iSize; attribute vec4 iColor;
varying vec2 vUv; varying vec4 vColor;
void main() {
  vec3 axis = normalize(iDir + vec3(1e-5));
  vec3 toCam = normalize(cameraPosition - iPos);
  vec3 side = normalize(cross(axis, toCam));
  vec3 p = iPos - axis * (uv.y * iSize.x) + side * ((uv.x - 0.5) * iSize.y);
  vUv = uv; vColor = iColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const SFRAG = `
varying vec2 vUv; varying vec4 vColor;
void main() {
  float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
  float along = pow(1.0 - vUv.y, 1.5);
  float a = smoothstep(0.0, 0.6, across) * along * vColor.a;
  vec3 core = mix(vColor.rgb, vec3(1.0), smoothstep(0.55, 1.0, across) * 0.7);
  gl_FragColor = vec4(core * a, a);
}`;

class Streaks {
  constructor(scene, max) {
    this.max = max;
    const base = new THREE.PlaneGeometry(1, 1);
    base.translate(0.5, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('uv', base.attributes.uv);
    const IA = (n) => new THREE.InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage);
    this.iPos = IA(3); this.iDir = IA(3); this.iSize = IA(2); this.iColor = IA(4);
    g.setAttribute('iPos', this.iPos); g.setAttribute('iDir', this.iDir); g.setAttribute('iSize', this.iSize); g.setAttribute('iColor', this.iColor);
    g.instanceCount = 0;
    this.geo = g;
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: SVERT, fragmentShader: SFRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
    this.items = [];
  }

  // spark: moves with gravity, length follows speed
  spark(p, v, life, width, color) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ kind: 0, p: p.clone(), v: v.clone(), life, max: life, width, color });
  }

  // tracer: a glowing segment that travels from start to end
  tracer(start, end, speed = 340, len = 7, width = 0.045, color = [1, 0.82, 0.45, 1]) {
    const dir = end.clone().sub(start);
    const dist = dir.length();
    if (dist < 0.5) return;
    dir.divideScalar(dist);
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ kind: 1, start: start.clone(), dir, dist, t: 0, speed, len: Math.min(len, dist), width, color });
  }

  update(dt) {
    let w = 0;
    const P = this.iPos.array, D = this.iDir.array, S = this.iSize.array, C = this.iColor.array;
    for (const it of this.items) {
      let px, py, pz, dx, dy, dz, len, alpha;
      if (it.kind === 0) {
        it.life -= dt;
        if (it.life <= 0) continue;
        it.v.y -= 14 * dt;
        it.v.multiplyScalar(Math.max(0, 1 - 1.5 * dt));
        it.p.addScaledVector(it.v, dt);
        const sp = it.v.length();
        px = it.p.x; py = it.p.y; pz = it.p.z;
        dx = it.v.x; dy = it.v.y; dz = it.v.z;
        len = Math.min(0.5, sp * 0.025 + 0.03);
        alpha = it.life / it.max;
      } else {
        it.t += dt;
        // the streak keeps flying past the end point, so its tail always reaches the target
        const front = it.t * it.speed;
        const head = Math.min(it.dist, front);
        const tail = Math.max(0, front - it.len);
        if (tail >= it.dist - 0.01 || it.t > 3) continue;
        px = it.start.x + it.dir.x * head; py = it.start.y + it.dir.y * head; pz = it.start.z + it.dir.z * head;
        dx = it.dir.x; dy = it.dir.y; dz = it.dir.z;
        len = head - tail;
        alpha = 1;
      }
      const i3 = w * 3;
      P[i3] = px; P[i3 + 1] = py; P[i3 + 2] = pz;
      D[i3] = dx; D[i3 + 1] = dy; D[i3 + 2] = dz;
      S[w * 2] = len; S[w * 2 + 1] = it.width;
      C[w * 4] = it.color[0]; C[w * 4 + 1] = it.color[1]; C[w * 4 + 2] = it.color[2]; C[w * 4 + 3] = (it.color[3] ?? 1) * alpha;
      this.items[w++] = it;
    }
    this.items.length = w;
    this.geo.instanceCount = w;
    for (const a of [this.iPos, this.iDir, this.iSize, this.iColor]) a.needsUpdate = true;
  }

  clear() { this.items.length = 0; this.geo.instanceCount = 0; }
}

// ---------------------------------------------------------------- debris

class Debris {
  constructor(scene, max) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.items = [];
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(); this.s = new THREE.Vector3(); this.p = new THREE.Vector3();
    this.c = new THREE.Color();
    this.world = null;
  }

  spawn(x, y, z, vx, vy, vz, size, color, life = 3 + Math.random() * 2, stretch = 1) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ x, y, z, vx, vy, vz, rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6, ax: (Math.random() - 0.5) * 16, ay: (Math.random() - 0.5) * 16, az: (Math.random() - 0.5) * 16, size, stretch, color, life, rest: false });
  }

  solid(x, y, z) {
    const w = this.world;
    if (!w) return y < 0;
    return w.solidAt(Math.floor(x / VOXEL), Math.floor(y / VOXEL), Math.floor(z / VOXEL));
  }

  update(dtFrame) {
    // real time even at a low frame rate, in small steps so pieces don't tunnel through floors
    for (let rem = dtFrame; rem > 1e-4; rem -= 0.04) this.step(Math.min(rem, 0.04));
    this.draw();
  }

  step(dt) {
    for (const d of this.items) {
      d.life -= dt;
      if (d.life <= 0) continue;
      if (!d.rest) {
        d.air = (d.air || 0) + dt;
        if (d.air > 2.0) d.life = Math.min(d.life, 0.4);
        d.vy -= 22 * dt;
        const nx = d.x + d.vx * dt, ny = d.y + d.vy * dt, nz = d.z + d.vz * dt;
        const h = d.size * 0.5;
        if (d.vy < 0 && this.solid(d.x, ny - h, d.z)) {
          d.y = Math.floor((ny - h) / VOXEL + 1) * VOXEL + h;
          d.vy *= -0.28; d.vx *= 0.6; d.vz *= 0.6; d.ax *= 0.5; d.az *= 0.5;
          if (Math.abs(d.vy) < 0.8 && Math.hypot(d.vx, d.vz) < 0.4) d.rest = true;
        } else d.y = ny;
        if (this.solid(nx, d.y, d.z)) d.vx *= -0.35; else d.x = nx;
        if (this.solid(d.x, d.y, nz)) d.vz *= -0.35; else d.z = nz;
        d.rx += d.ax * dt; d.ry += d.ay * dt; d.rz += d.az * dt;
      } else if (!this.solid(d.x, d.y - d.size * 0.5 - 0.05, d.z)) d.rest = false;
    }
  }

  draw() {
    let w = 0;
    for (const d of this.items) {
      if (d.life <= 0) continue;
      const fade = Math.min(1, d.life / 0.6);
      this.p.set(d.x, d.y, d.z);
      this.e.set(d.rx, d.ry, d.rz);
      this.q.setFromEuler(this.e);
      this.s.set(d.size * fade, d.size * fade, d.size * d.stretch * fade);
      this.m4.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(w, this.m4);
      this.c.setRGB(d.color[0], d.color[1], d.color[2]);
      this.mesh.setColorAt(w, this.c);
      this.items[w++] = d;
    }
    this.items.length = w;
    this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  clear() { this.items.length = 0; this.mesh.count = 0; }
}

// ---------------------------------------------------------------- decals

export const DECAL = { CONCRETE: 0, METAL: 1, WOOD: 2, SOFT: 3, BLOOD1: 4, BLOOD2: 5, SCORCH: 6, CRACK: 7 };

class Decals {
  constructor(scene, max = 260) {
    const geo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
    this.aTile = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTile', this.aTile);
    const tex = loadTexture('/assets/textures/decals.png');
    const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aTile;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n{ float tx = mod(aTile, 4.0); float ty = floor(aTile / 4.0); vMapUv = vec2((uv.x + tx) * 0.25, 1.0 - ((1.0 - uv.y) + ty) * 0.5); }\n#endif');
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
    this.items = [];
    this.max = max;
    this.dirty = false;
    this.checkT = 0;
  }

  add(p, n, tile, size, voxel) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ p: p.clone().addScaledVector(n, 0.01), n: n.clone(), tile, size, voxel, rot: Math.random() * 6.28 });
    this.dirty = true;
  }

  rebuild() {
    const z = new THREE.Vector3(0, 0, 1), q = new THREE.Quaternion(), rq = new THREE.Quaternion(), s = new THREE.Vector3(), m4 = new THREE.Matrix4();
    this.items.forEach((it, i) => {
      q.setFromUnitVectors(z, it.n);
      rq.setFromAxisAngle(z, it.rot);
      q.multiply(rq);
      s.set(it.size, it.size, 1);
      m4.compose(it.p, q, s);
      this.mesh.setMatrixAt(i, m4);
      this.aTile.array[i] = it.tile;
    });
    this.mesh.count = this.items.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aTile.needsUpdate = true;
    this.dirty = false;
  }

  update(dt, world) {
    this.checkT -= dt;
    if (this.checkT <= 0 && world) {
      this.checkT = 0.4;
      const before = this.items.length;
      this.items = this.items.filter((it) => it.voxel === undefined || world.data[it.voxel] !== 0);
      if (this.items.length !== before) this.dirty = true;
    }
    if (this.dirty) this.rebuild();
  }

  clear() { this.items.length = 0; this.mesh.count = 0; }
}

// ---------------------------------------------------------------- effects facade

const IMPACT_DECAL = { concrete: DECAL.CONCRETE, metal: DECAL.METAL, wood: DECAL.WOOD, dirt: DECAL.SOFT, foliage: -1 };

export class Effects {
  constructor(scene, quality) {
    this.scene = scene;
    this.q = quality;
    const sprites = loadTexture('/assets/textures/sprites.png');
    this.fire = new Particles(scene, 3000, true, sprites);
    this.smoke = new Particles(scene, 3000, false, sprites);
    this.streaks = new Streaks(scene, 900);
    this.debris = new Debris(scene, 1600);
    this.decals = new Decals(scene);
    this.lights = [];
    this.setLightCount(quality.lights ?? 3);
    this.lightIndex = 0;
    this.rockets = new Map();
    this.rocketTemplate = buildRocketProjectile();
    this.rings = [];
    const rm = new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), rm.clone());
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffd28a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      flash.visible = false;
      scene.add(ring, flash);
      this.rings.push({ ring, flash, t: 1, size: 1 });
    }
    this.ringIndex = 0;
    this.world = null;
    this.pixelScale = 600;
  }

  setQuality(q) { this.q = q; this.debris.max = q.debris; this.setLightCount(q.lights ?? 3); }

  // every extra point light costs shading time on every pixel, so low-end settings use fewer
  setLightCount(n) {
    while (this.lights.length > n) this.scene.remove(this.lights.pop());
    while (this.lights.length < n) {
      const l = new THREE.PointLight(0xffa040, 0, 18, 1.6);
      l.userData.t = 0;
      this.scene.add(l);
      this.lights.push(l);
    }
  }
  setWorld(world) { this.world = world; this.debris.world = world; this.clear(); }

  // burning wrecks and distant smoke columns that keep going for the whole round
  setAmbient(fires, plumes) { this.ambient = { fires: fires || [], plumes: plumes || [], acc: 0 }; }

  updateAmbient(dt) {
    const a = this.ambient;
    if (!a || (!a.fires.length && !a.plumes.length)) return;
    a.acc = Math.min(a.acc + dt, 0.5);
    const step = 1 / 30, q = this.q.particles ?? 1;
    const wx = 0.5, wz = 0.25; // light breeze
    while (a.acc >= step) {
      a.acc -= step;
      for (const [x, y, z, s] of a.fires) {
        if (Math.random() < 0.7 * q) this.fire.spawn(x + (Math.random() - 0.5) * s, y + Math.random() * 0.2, z + (Math.random() - 0.5) * s, (Math.random() - 0.5) * 0.4, 1.2 + Math.random() * 1.4, (Math.random() - 0.5) * 0.4, 0.5 + Math.random() * 0.45, 0.9 * s, 0.25 * s, [1, 0.78, 0.38], [0.9, 0.22, 0.04], 0.9, 0.5, -0.8, TILE.SMOKE);
        if (Math.random() < 0.22 * q) {
          const g = 0.12 + Math.random() * 0.08;
          this.smoke.spawn(x, y + 0.8 * s, z, wx * 0.4 + (Math.random() - 0.5) * 0.5, 1.4 + Math.random() * 0.8, wz * 0.4 + (Math.random() - 0.5) * 0.5, 6 + Math.random() * 3, 1.2 * s, 7 * s, [g, g * 0.95, g * 0.9], [0.36, 0.34, 0.32], 0.7, 0.05, -0.05, TILE.SMOKE);
        }
      }
      for (const [x, z, s] of a.plumes) {
        if (Math.random() < 0.16 * Math.max(0.5, q)) {
          const g = 0.14 + Math.random() * 0.1;
          this.smoke.spawn(x + (Math.random() - 0.5) * 3, 2 + Math.random() * 2, z + (Math.random() - 0.5) * 3, wx * 2, 3.2 + Math.random() * 1.5, wz * 2, 16 + Math.random() * 6, 9 * s, 34 * s, [g, g * 0.93, g * 0.88], [0.42, 0.4, 0.38], 0.85, 0.02, -0.02, TILE.SMOKE);
        }
        if (Math.random() < 0.3 * Math.max(0.5, q)) this.fire.spawn(x + (Math.random() - 0.5) * 4, 2.5, z + (Math.random() - 0.5) * 4, 0, 2 + Math.random() * 2, 0, 0.8, 7 * s, 2 * s, [1, 0.7, 0.3], [0.8, 0.2, 0.03], 0.8, 0.3, -0.5, TILE.SMOKE);
      }
    }
  }
  pc(n) { return Math.max(1, Math.round(n * this.q.particles)); }

  flashLight(pos, color, intensity, dur, dist = 18) {
    if (!this.lights.length) return;
    // with a single light, keep the brightest recent flash instead of letting muzzle flashes steal it
    let l = this.lights[this.lightIndex++ % this.lights.length];
    if (this.lights.length === 1 && l.intensity > intensity * 1.5) return;
    l.position.copy(pos);
    l.color.setHex(color);
    l.userData.peak = intensity; l.userData.t = dur; l.userData.dur = dur;
    l.distance = dist;
    l.intensity = intensity;
  }

  muzzle(pos, dir, local) {
    this.flashLight(pos, 0xffb050, local ? 5 : 12, 0.05, 9);
    this.fire.spawn(pos.x, pos.y, pos.z, 0, 0, 0, 0.05, local ? 0.25 : 0.55, local ? 0.35 : 0.8, [1, 0.85, 0.5], [1, 0.5, 0.15], 1, 0, 0, TILE.FLASH);
    for (let i = 0; i < (local ? 1 : 3); i++) {
      this.smoke.spawn(pos.x, pos.y, pos.z, dir.x * 0.8 + (Math.random() - 0.5) * 0.5, 0.4 + Math.random() * 0.4, dir.z * 0.8 + (Math.random() - 0.5) * 0.5, 0.7 + Math.random() * 0.5, 0.15, 0.7, [0.75, 0.75, 0.78], [0.6, 0.6, 0.62], 0.25, 1.6, -0.25, TILE.SMOKE);
    }
    if (!local && Math.random() < 0.5) this.streaks.spark(pos, dir.clone().multiplyScalar(8).add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3)), 0.15, 0.015, [1, 0.7, 0.3, 1]);
  }

  tracer(start, end, local = false) {
    this.streaks.tracer(start, end, local ? 420 : 320, local ? 5 : 8, local ? 0.03 : 0.05, local ? [1, 0.85, 0.55, 0.8] : [1, 0.78, 0.4, 1]);
  }

  // material-aware bullet impact
  impact(p, n, color, voxelIndex, matIndex = 1) {
    const cls = MAT_CLASS[matIndex] || 'concrete';
    const c = color || [0.7, 0.7, 0.7];
    const N = new THREE.Vector3(n.x, n.y, n.z);
    const P = new THREE.Vector3(p.x, p.y, p.z);
    const rand = (s) => (Math.random() - 0.5) * s;
    this.fire.spawn(P.x + N.x * 0.03, P.y + N.y * 0.03, P.z + N.z * 0.03, 0, 0, 0, 0.06, 0.18, 0.28, [1, 0.9, 0.7], [1, 0.6, 0.3], cls === 'metal' ? 1 : 0.5, 0, 0, TILE.FLASH);
    if (cls === 'metal') {
      for (let i = 0; i < this.pc(10); i++) {
        const v = N.clone().multiplyScalar(3 + Math.random() * 6).add(new THREE.Vector3(rand(8), Math.random() * 5, rand(8)));
        this.streaks.spark(P, v, 0.25 + Math.random() * 0.35, 0.012 + Math.random() * 0.01, [1, 0.75, 0.35, 1]);
      }
      this.smoke.spawn(P.x, P.y, P.z, N.x * 0.5, 0.3, N.z * 0.5, 0.5, 0.1, 0.35, [0.7, 0.7, 0.72], [0.55, 0.55, 0.58], 0.3, 2, -0.2, TILE.SMOKE);
    } else if (cls === 'wood') {
      for (let i = 0; i < 4; i++) this.debris.spawn(P.x + N.x * 0.05, P.y + N.y * 0.05, P.z + N.z * 0.05, N.x * 3 + rand(3), 2 + Math.random() * 3, N.z * 3 + rand(3), 0.025 + Math.random() * 0.02, [c[0] * 1.2, c[1] * 1.1, c[2]], 1.2 + Math.random(), 4 + Math.random() * 3);
      for (let i = 0; i < this.pc(3); i++) this.smoke.spawn(P.x, P.y, P.z, N.x * 1.2 + rand(1), N.y * 1.2 + Math.random() * 0.6, N.z * 1.2 + rand(1), 0.6, 0.12, 0.5, [0.75, 0.62, 0.45], [0.6, 0.52, 0.42], 0.5, 3, 0.4, TILE.DUST);
    } else if (cls === 'dirt') {
      for (let i = 0; i < this.pc(6); i++) this.smoke.spawn(P.x, P.y, P.z, N.x * 2 + rand(1.5), N.y * 2.5 + Math.random() * 2, N.z * 2 + rand(1.5), 0.5 + Math.random() * 0.4, 0.12, 0.55, [c[0] * 0.8, c[1] * 0.75, c[2] * 0.7], [c[0] * 0.7, c[1] * 0.7, c[2] * 0.68], 0.8, 2.5, 4, TILE.DUST);
      for (let i = 0; i < 3; i++) this.debris.spawn(P.x, P.y, P.z, N.x * 2 + rand(3), 2 + Math.random() * 3, N.z * 2 + rand(3), 0.04 + Math.random() * 0.03, [c[0] * 0.7, c[1] * 0.65, c[2] * 0.6], 0.8 + Math.random());
    } else if (cls === 'foliage') {
      for (let i = 0; i < 6; i++) this.debris.spawn(P.x, P.y, P.z, rand(3), 1 + Math.random() * 2, rand(3), 0.05, [c[0], c[1] * 1.1, c[2]], 1.5 + Math.random(), 0.15);
    } else {
      for (let i = 0; i < this.pc(4); i++) {
        const v = N.clone().multiplyScalar(2 + Math.random() * 4).add(new THREE.Vector3(rand(4), Math.random() * 3, rand(4)));
        this.streaks.spark(P, v, 0.12 + Math.random() * 0.12, 0.01, [1, 0.85, 0.55, 0.9]);
      }
      for (let i = 0; i < this.pc(5); i++) {
        this.smoke.spawn(P.x + N.x * 0.05, P.y + N.y * 0.05, P.z + N.z * 0.05, N.x * (0.8 + Math.random()) + rand(0.8), N.y * 1.2 + Math.random() * 0.6, N.z * (0.8 + Math.random()) + rand(0.8), 0.8 + Math.random() * 0.6, 0.15, 0.8, [c[0] * 0.8 + 0.18, c[1] * 0.8 + 0.18, c[2] * 0.8 + 0.18], [c[0] * 0.6 + 0.3, c[1] * 0.6 + 0.3, c[2] * 0.6 + 0.3], 0.6, 2.5, 0.3, TILE.DUST);
      }
      for (let i = 0; i < 3; i++) this.debris.spawn(P.x + N.x * 0.06, P.y + N.y * 0.06, P.z + N.z * 0.06, N.x * 3 + rand(3), 2 + Math.random() * 3, N.z * 3 + rand(3), 0.04 + Math.random() * 0.05, c, 1.2 + Math.random());
    }
    const tile = IMPACT_DECAL[cls];
    if (tile >= 0 && voxelIndex !== undefined) this.decals.add(P, N, tile, 0.16 + Math.random() * 0.06, voxelIndex);
  }

  blood(p, dir, heavy = false, world = null) {
    const rand = (s) => (Math.random() - 0.5) * s;
    for (let i = 0; i < this.pc(heavy ? 18 : 10); i++) {
      const sp = 1 + Math.random() * 4;
      this.smoke.spawn(p.x, p.y, p.z, dir.x * sp + rand(2), dir.y * sp + Math.random() * 1.5, dir.z * sp + rand(2), 0.35 + Math.random() * 0.35, 0.1, heavy ? 0.6 : 0.4, [0.55, 0.02, 0.03], [0.3, 0.01, 0.02], 0.85, 1.2, 6, TILE.DUST);
    }
    for (let i = 0; i < (heavy ? 8 : 4); i++) this.debris.spawn(p.x, p.y, p.z, dir.x * 4 + rand(3), 1 + Math.random() * 3, dir.z * 4 + rand(3), 0.025, [0.45, 0.02, 0.02], 0.6 + Math.random() * 0.4);
    // splat on a surface behind the victim
    const w = world || this.world;
    if (w) {
      const d = dir.clone().normalize();
      const hit = w.raycast(p.x, p.y, p.z, d.x, d.y - 0.3, d.z, 3);
      const hit2 = hit || w.raycast(p.x, p.y, p.z, 0, -1, 0, 2.5);
      if (hit2) this.decals.add(new THREE.Vector3(hit2.px, hit2.py, hit2.pz), new THREE.Vector3(hit2.nx, hit2.ny, hit2.nz), Math.random() < 0.5 ? DECAL.BLOOD1 : DECAL.BLOOD2, heavy ? 1.1 : 0.7, w.index(hit2.x, hit2.y, hit2.z));
    }
  }

  // stylised burst when a player is eliminated
  eliminationBurst(p, color) {
    const c = [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
    this.flashLight(p, color, 14, 0.35, 8);
    for (let i = 0; i < this.pc(26); i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(4 + Math.random() * 7);
      this.streaks.spark(p, v, 0.35 + Math.random() * 0.35, 0.025, [c[0] * 0.7 + 0.3, c[1] * 0.7 + 0.3, c[2] * 0.7 + 0.3, 1]);
    }
    for (let i = 0; i < this.pc(10); i++) this.fire.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2, 0.4 + Math.random() * 0.3, 0.3, 1.2, [c[0], c[1], c[2]], [c[0] * 0.3, c[1] * 0.3, c[2] * 0.3], 0.8, 2, -1, TILE.FLASH);
    const r = this.rings[this.ringIndex++ % this.rings.length];
    r.ring.position.set(p.x, p.y - 0.8, p.z);
    r.ring.material.color.setRGB(c[0], c[1], c[2]);
    r.flash.visible = false;
    r.ring.visible = true; r.t = 0; r.size = 2.5; r.noFlash = true;
  }

  explosion(p, removedColors = [], normalUp = true) {
    const rand = (s) => (Math.random() - 0.5) * s;
    this.flashLight(p, 0xff9a40, 70, 0.5, 28);
    const r = this.rings[this.ringIndex++ % this.rings.length];
    r.ring.position.copy(p); r.flash.position.copy(p); r.ring.material.color.setHex(0xfff0d0);
    r.t = 0; r.size = 7; r.noFlash = false; r.ring.visible = true; r.flash.visible = true;
    // fireball core
    for (let i = 0; i < this.pc(30); i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const sp = 2 + Math.random() * 7;
      const dx = Math.sin(ph) * Math.cos(th), dy = Math.cos(ph), dz = Math.sin(ph) * Math.sin(th);
      this.fire.spawn(p.x + dx * 0.3, p.y + dy * 0.3, p.z + dz * 0.3, dx * sp, dy * sp + 1.5, dz * sp, 0.35 + Math.random() * 0.4, 1.2 + Math.random(), 3.5 + Math.random() * 2.5, [1, 0.92, 0.6], [0.95, 0.28, 0.05], 1, 4.5, -1, TILE.SMOKE);
    }
    for (let i = 0; i < this.pc(4); i++) this.fire.spawn(p.x, p.y, p.z, 0, 0, 0, 0.12, 3, 6, [1, 0.95, 0.8], [1, 0.6, 0.2], 1, 0, 0, TILE.FLASH);
    // sparks
    for (let i = 0; i < this.pc(36); i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.1, Math.random() - 0.5).normalize().multiplyScalar(10 + Math.random() * 20);
      this.streaks.spark(p, v, 0.5 + Math.random() * 0.7, 0.02 + Math.random() * 0.015, [1, 0.7, 0.3, 1]);
    }
    // smoke column and ground dust ring
    for (let i = 0; i < this.pc(26); i++) {
      const th = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 3.5;
      const g = 0.16 + Math.random() * 0.14;
      this.smoke.spawn(p.x + rand(1), p.y + rand(1), p.z + rand(1), Math.cos(th) * sp, 1.4 + Math.random() * 2.4, Math.sin(th) * sp, 2.2 + Math.random() * 2.2, 1.6 + Math.random(), 6 + Math.random() * 3, [g * 1.3, g * 1.2, g * 1.1], [0.42, 0.4, 0.38], 0.85, 1.1, -0.3, TILE.SMOKE);
    }
    for (let i = 0; i < this.pc(16); i++) {
      const th = (i / 16) * Math.PI * 2;
      this.smoke.spawn(p.x, p.y - 0.4, p.z, Math.cos(th) * 7, 0.3, Math.sin(th) * 7, 1.4, 0.8, 3, [0.62, 0.58, 0.52], [0.58, 0.56, 0.52], 0.5, 2.2, 0, TILE.DUST);
    }
    const n = Math.min(removedColors.length, this.pc(80));
    for (let i = 0; i < n; i++) {
      const rc = removedColors[(Math.random() * removedColors.length) | 0];
      const dx = rc.x - p.x, dy = rc.y - p.y, dz = rc.z - p.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      const sp = 5 + Math.random() * 10;
      this.debris.spawn(rc.x, rc.y, rc.z, dx / l * sp + rand(3), dy / l * sp + 4 + Math.random() * 5, dz / l * sp + rand(3), 0.1 + Math.random() * 0.28, rc.c);
    }
    // scorch on the nearest surface below / around
    if (this.world) {
      const hit = this.world.raycast(p.x, p.y + 0.2, p.z, 0, -1, 0, 3);
      if (hit) this.decals.add(new THREE.Vector3(hit.px, hit.py, hit.pz), new THREE.Vector3(hit.nx, hit.ny, hit.nz), DECAL.SCORCH, 3.2, undefined);
    }
  }

  propBreak(pos, color) {
    for (let i = 0; i < this.pc(12); i++) this.debris.spawn(pos.x + (Math.random() - 0.5) * 0.6, pos.y + 0.3 + Math.random() * 0.6, pos.z + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 6, 2 + Math.random() * 5, (Math.random() - 0.5) * 6, 0.06 + Math.random() * 0.14, color, 3);
    for (let i = 0; i < this.pc(6); i++) this.smoke.spawn(pos.x, pos.y + 0.4, pos.z, (Math.random() - 0.5) * 2, 0.6 + Math.random(), (Math.random() - 0.5) * 2, 1, 0.4, 1.4, [0.7, 0.68, 0.64], [0.65, 0.64, 0.62], 0.5, 2, 0, TILE.DUST);
  }

  collapseDust(minX, maxX, y, minZ, maxZ, count, colors) {
    for (let i = 0; i < this.pc(count); i++) {
      const x = minX + Math.random() * (maxX - minX), z = minZ + Math.random() * (maxZ - minZ);
      const g = 0.55 + Math.random() * 0.15;
      this.smoke.spawn(x, y + Math.random() * 0.5, z, (Math.random() - 0.5) * 6, 0.5 + Math.random() * 2, (Math.random() - 0.5) * 6, 2.5 + Math.random() * 2.5, 1.4, 5.5 + Math.random() * 2, [g, g * 0.95, g * 0.88], [0.62, 0.6, 0.57], 0.65, 1.3, -0.1, TILE.DUST);
    }
    for (const c of colors) this.debris.spawn(c.x, c.y, c.z, (Math.random() - 0.5) * 7, 2 + Math.random() * 6, (Math.random() - 0.5) * 7, 0.15 + Math.random() * 0.3, c.c);
  }

  spawnRocket(id, pos, vel, owner) {
    if (this.rockets.has(id)) return;
    const mesh = this.rocketTemplate.clone();
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffb060, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    glow.scale.setScalar(0.6);
    glow.position.z = 0.25;
    mesh.add(glow);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.rockets.set(id, { mesh, pos: pos.clone(), vel: vel.clone(), owner, age: 0, trail: 0 });
  }

  removeRocket(id) {
    const r = this.rockets.get(id);
    if (!r) return null;
    this.scene.remove(r.mesh);
    this.rockets.delete(id);
    return r;
  }

  update(dt, camera, fog, realDt = dt) {
    const h = window.innerHeight * Math.min(window.devicePixelRatio || 1, 2);
    this.pixelScale = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.updateAmbient(dt);
    this.fire.update(dt, fog, this.pixelScale);
    this.smoke.update(dt, fog, this.pixelScale);
    this.streaks.update(dt);
    this.debris.update(realDt);
    this.decals.update(dt, this.world);
    for (const l of this.lights) {
      if (l.userData.t > 0) { l.userData.t -= dt; l.intensity = l.userData.peak * Math.max(0, l.userData.t / l.userData.dur) ** 1.5; } else l.intensity = 0;
    }
    for (const r of this.rings) {
      if (r.t >= 1) continue;
      r.t += dt / 0.4;
      const k = Math.min(1, r.t);
      const e = 1 - (1 - k) * (1 - k);
      r.ring.scale.setScalar(0.5 + e * r.size);
      r.ring.material.opacity = (1 - k) * 0.7;
      if (!r.noFlash) { r.flash.scale.setScalar(0.5 + e * 3.4); r.flash.material.opacity = (1 - k) ** 2 * 0.9; }
      if (k >= 1) { r.ring.visible = false; r.flash.visible = false; }
    }
    const fwd = new THREE.Vector3();
    for (const [id, r] of this.rockets) {
      r.age += dt;
      r.pos.addScaledVector(r.vel, dt);
      r.mesh.position.copy(r.pos);
      fwd.copy(r.vel).normalize();
      r.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), fwd);
      r.trail += dt;
      while (r.trail > 0.012) {
        r.trail -= 0.012;
        const tx = r.pos.x - fwd.x * 0.3, ty = r.pos.y - fwd.y * 0.3, tz = r.pos.z - fwd.z * 0.3;
        this.smoke.spawn(tx, ty, tz, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6 + 0.3, (Math.random() - 0.5) * 0.6, 1.2 + Math.random() * 0.8, 0.3, 1.6, [0.88, 0.88, 0.88], [0.62, 0.62, 0.62], 0.5, 1.5, -0.3, TILE.SMOKE);
        this.fire.spawn(tx, ty, tz, -fwd.x * 3, -fwd.y * 3, -fwd.z * 3, 0.08, 0.45, 0.1, [1, 0.85, 0.5], [1, 0.4, 0.1], 1, 0, 0, TILE.FLASH);
      }
      if (r.age > 7) this.removeRocket(id);
    }
  }

  clear() {
    this.fire.clear(); this.smoke.clear(); this.streaks.clear(); this.debris.clear(); this.decals.clear();
    for (const id of [...this.rockets.keys()]) this.removeRocket(id);
  }
}
