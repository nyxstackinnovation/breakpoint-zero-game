// Combat effects: GPU point particles (fire, smoke, sparks, dust, blood), instanced voxel
// debris with world collision, bullet tracers, impact decals, rockets in flight and explosions.

import * as THREE from 'three';
import { VOXEL } from '/shared/constants.js';
import { buildRocketProjectile } from './weaponModels.js';

const PVERT = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor; attribute float aSoft;
varying float vAlpha; varying vec3 vColor; varying float vSoft; varying float vFog;
uniform float uScale; uniform float uFogNear; uniform float uFogFar;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  vAlpha = aAlpha; vColor = aColor; vSoft = aSoft;
  vFog = smoothstep(uFogNear, uFogFar, -mv.z);
}`;
const PFRAG = `
varying float vAlpha; varying vec3 vColor; varying float vSoft; varying float vFog;
uniform vec3 uFogColor; uniform float uAdditive;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float a = mix(1.0 - smoothstep(0.75, 1.0, d), pow(1.0 - d, 1.6), vSoft);
  float n = fract(sin(dot(floor(gl_PointCoord * 6.0), vec2(12.9, 78.2))) * 4375.5);
  a *= mix(1.0, 0.75 + 0.25 * n, vSoft);
  vec3 col = vColor;
  if (uAdditive > 0.5) { col *= (1.0 - vFog); }
  else { col = mix(col, uFogColor, vFog * 0.85); }
  gl_FragColor = vec4(col, a * vAlpha);
}`;

class Particles {
  constructor(scene, max, additive) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col0 = new Float32Array(max * 3);
    this.col1 = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.soft = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aSoft = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aAlpha', this.aAlpha);
    g.setAttribute('aSoft', this.aSoft);
    g.setDrawRange(0, 0);
    this.uniforms = {
      uScale: { value: 600 }, uFogNear: { value: 50 }, uFogFar: { value: 180 }, uFogColor: { value: new THREE.Color() }, uAdditive: { value: additive ? 1 : 0 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: PVERT, fragmentShader: PFRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, alpha = 1, drag = 0, grav = 0, soft = 1) {
    if (this.count >= this.max) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col0[i3] = c0[0]; this.col0[i3 + 1] = c0[1]; this.col0[i3 + 2] = c0[2];
    this.col1[i3] = c1[0]; this.col1[i3 + 1] = c1[1]; this.col1[i3 + 2] = c1[2];
    this.life[i] = life; this.maxLife[i] = life;
    this.size0[i] = s0; this.size1[i] = s1; this.alpha0[i] = alpha;
    this.drag[i] = drag; this.grav[i] = grav; this.soft[i] = soft;
  }

  update(dt, fog, pixelScale) {
    this.uniforms.uScale.value = pixelScale;
    if (fog) { this.uniforms.uFogNear.value = fog.near; this.uniforms.uFogFar.value = fog.far; this.uniforms.uFogColor.value.copy(fog.color); }
    let n = this.count;
    const P = this.aPos.array, C = this.aCol.array, S = this.aSize.array, A = this.aAlpha.array, SO = this.aSoft.array;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        n--;
        if (i !== n) this.move(n, i);
        i--;
        continue;
      }
      const i3 = i * 3;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= dr; this.vel[i3 + 1] = this.vel[i3 + 1] * dr - this.grav[i] * dt; this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      P[i3] = this.pos[i3]; P[i3 + 1] = this.pos[i3 + 1]; P[i3 + 2] = this.pos[i3 + 2];
      C[i3] = this.col0[i3] + (this.col1[i3] - this.col0[i3]) * t;
      C[i3 + 1] = this.col0[i3 + 1] + (this.col1[i3 + 1] - this.col0[i3 + 1]) * t;
      C[i3 + 2] = this.col0[i3 + 2] + (this.col1[i3 + 2] - this.col0[i3 + 2]) * t;
      S[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      A[i] = this.alpha0[i] * (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
      SO[i] = this.soft[i];
    }
    this.count = n;
    this.points.geometry.setDrawRange(0, n);
    this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aSize.needsUpdate = true; this.aAlpha.needsUpdate = true; this.aSoft.needsUpdate = true;
  }

  move(from, to) {
    const f3 = from * 3, t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k]; this.vel[t3 + k] = this.vel[f3 + k];
      this.col0[t3 + k] = this.col0[f3 + k]; this.col1[t3 + k] = this.col1[f3 + k];
    }
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.size0[to] = this.size0[from]; this.size1[to] = this.size1[from]; this.alpha0[to] = this.alpha0[from];
    this.drag[to] = this.drag[from]; this.grav[to] = this.grav[from]; this.soft[to] = this.soft[from];
  }

  clear() { this.count = 0; this.points.geometry.setDrawRange(0, 0); }
}

class Debris {
  constructor(scene, max) {
    this.max = max;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.items = [];
    this.m4 = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
    this.s = new THREE.Vector3();
    this.p = new THREE.Vector3();
    this.world = null;
  }

  spawn(x, y, z, vx, vy, vz, size, color, life = 3 + Math.random() * 2) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ x, y, z, vx, vy, vz, rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6, ax: (Math.random() - 0.5) * 14, ay: (Math.random() - 0.5) * 14, az: (Math.random() - 0.5) * 14, size, color, life, max: life, rest: false });
  }

  solid(x, y, z) {
    const w = this.world;
    if (!w) return y < 0;
    return w.solidAt(Math.floor(x / VOXEL), Math.floor(y / VOXEL), Math.floor(z / VOXEL));
  }

  update(dt) {
    const items = this.items;
    let w = 0;
    const c = new THREE.Color();
    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      d.life -= dt;
      if (d.life <= 0) continue;
      if (!d.rest) {
        d.vy -= 22 * dt;
        const nx = d.x + d.vx * dt, ny = d.y + d.vy * dt, nz = d.z + d.vz * dt;
        const h = d.size * 0.5;
        if (this.solid(d.x, ny - h, d.z) && d.vy < 0) {
          d.y = Math.floor((ny - h) / VOXEL + 1) * VOXEL + h;
          d.vy *= -0.28; d.vx *= 0.6; d.vz *= 0.6; d.ax *= 0.5; d.az *= 0.5;
          if (Math.abs(d.vy) < 0.8 && Math.hypot(d.vx, d.vz) < 0.4) d.rest = true;
        } else d.y = ny;
        if (this.solid(nx, d.y, d.z)) d.vx *= -0.35; else d.x = nx;
        if (this.solid(d.x, d.y, nz)) d.vz *= -0.35; else d.z = nz;
        d.rx += d.ax * dt; d.ry += d.ay * dt; d.rz += d.az * dt;
      } else if (!this.solid(d.x, d.y - d.size * 0.5 - 0.05, d.z)) d.rest = false;
      const fade = Math.min(1, d.life / 0.6);
      this.p.set(d.x, d.y, d.z);
      this.e.set(d.rx, d.ry, d.rz);
      this.q.setFromEuler(this.e);
      this.s.setScalar(d.size * fade);
      this.m4.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(w, this.m4);
      c.setRGB(d.color[0], d.color[1], d.color[2]);
      this.mesh.setColorAt(w, c);
      items[w++] = d;
    }
    items.length = w;
    this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() { this.items.length = 0; this.mesh.count = 0; }
}

class Tracers {
  constructor(scene, max = 64) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, -0.5);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.items = [];
    this.max = max;
    this.m4 = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3();
    this.fwd = new THREE.Vector3(0, 0, -1);
  }

  add(start, end, speed = 300, len = 4) {
    const dir = end.clone().sub(start);
    const dist = dir.length();
    if (dist < 0.5) return;
    dir.divideScalar(dist);
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ start: start.clone(), dir, dist, t: 0, speed, len: Math.min(len, dist) });
  }

  update(dt) {
    let w = 0;
    for (const it of this.items) {
      it.t += dt;
      const head = Math.min(it.dist, it.t * it.speed);
      const tail = Math.max(0, head - it.len);
      if (tail >= it.dist - 0.01) continue;
      const l = head - tail;
      this.p.copy(it.start).addScaledVector(it.dir, head);
      this.q.setFromUnitVectors(this.fwd, it.dir);
      this.s.set(0.022, 0.022, Math.max(0.01, l));
      this.m4.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(w, this.m4);
      this.items[w++] = it;
    }
    this.items.length = w;
    this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() { this.items.length = 0; this.mesh.count = 0; }
}

class Decals {
  constructor(scene, max = 180) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grd.addColorStop(0, 'rgba(10,10,10,1)'); grd.addColorStop(0.35, 'rgba(25,22,20,0.9)'); grd.addColorStop(1, 'rgba(30,25,20,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    const geo = new THREE.PlaneGeometry(0.14, 0.14);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }), max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.items = [];
    this.max = max;
    this.m4 = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.checkT = 0;
  }

  add(p, n, voxel) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ p: p.clone().addScaledVector(n, 0.012), n: n.clone(), voxel, rot: Math.random() * 6.28, s: 0.7 + Math.random() * 0.6 });
    this.rebuild();
  }

  rebuild() {
    const z = new THREE.Vector3(0, 0, 1);
    const s = new THREE.Vector3();
    const rq = new THREE.Quaternion();
    this.items.forEach((it, i) => {
      this.q.setFromUnitVectors(z, it.n);
      rq.setFromAxisAngle(z, it.rot);
      this.q.multiply(rq);
      s.setScalar(it.s);
      this.m4.compose(it.p, this.q, s);
      this.mesh.setMatrixAt(i, this.m4);
    });
    this.mesh.count = this.items.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt, world) {
    this.checkT -= dt;
    if (this.checkT > 0 || !world) return;
    this.checkT = 0.5;
    const before = this.items.length;
    this.items = this.items.filter((it) => world.data[it.voxel] !== 0);
    if (this.items.length !== before) this.rebuild();
  }

  clear() { this.items.length = 0; this.mesh.count = 0; }
}

export class Effects {
  constructor(scene, quality) {
    this.scene = scene;
    this.q = quality;
    this.fire = new Particles(scene, 2500, true);
    this.smoke = new Particles(scene, 2500, false);
    this.debris = new Debris(scene, 1400);
    this.tracers = new Tracers(scene);
    this.decals = new Decals(scene);
    this.lights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffa040, 0, 18, 1.6);
      l.userData.t = 0;
      scene.add(l);
      this.lights.push(l);
    }
    this.lightIndex = 0;
    this.rockets = new Map();
    this.rocketTemplate = buildRocketProjectile();
    this.flashSpheres = [];
    const sm = new THREE.MeshBasicMaterial({ color: 0xffcf80, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const rm = new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), sm.clone());
      s.visible = false;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), rm.clone());
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      scene.add(s, ring);
      this.flashSpheres.push({ s, ring, t: 1 });
    }
    this.flashIndex = 0;
    this.shake = 0;
    this.world = null;
    this.pixelScale = 600;
  }

  setQuality(q) { this.q = q; this.debris.max = q.debris; }
  setWorld(world) { this.world = world; this.debris.world = world; this.clear(); }

  pc(n) { return Math.max(1, Math.round(n * this.q.particles)); }

  flashLight(pos, color, intensity, dur, dist = 18) {
    const l = this.lights[this.lightIndex++ % this.lights.length];
    l.position.copy(pos);
    l.color.setHex(color);
    l.userData.peak = intensity;
    l.userData.t = dur;
    l.userData.dur = dur;
    l.distance = dist;
    l.intensity = intensity;
  }

  muzzle(pos, local) {
    this.flashLight(pos, 0xffb050, local ? 6 : 10, 0.05, 8);
    for (let i = 0; i < (local ? 2 : 4); i++) {
      this.smoke.spawn(pos.x, pos.y, pos.z, (Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.4, (Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.4, 0.15, 0.6, [0.6, 0.6, 0.62], [0.5, 0.5, 0.52], 0.22, 1.5, -0.2);
    }
  }

  tracer(start, end) { this.tracers.add(start, end); }

  impact(p, n, color, voxelIndex) {
    const c = color || [0.7, 0.7, 0.7];
    for (let i = 0; i < this.pc(6); i++) {
      const sp = 3 + Math.random() * 6;
      this.fire.spawn(p.x, p.y, p.z, n.x * sp + (Math.random() - 0.5) * 4, n.y * sp + Math.random() * 3, n.z * sp + (Math.random() - 0.5) * 4, 0.15 + Math.random() * 0.2, 0.06, 0.02, [1, 0.85, 0.4], [1, 0.4, 0.1], 1, 2, 12, 0);
    }
    for (let i = 0; i < this.pc(3); i++) {
      this.smoke.spawn(p.x + n.x * 0.05, p.y + n.y * 0.05, p.z + n.z * 0.05, n.x * 1.2 + (Math.random() - 0.5), n.y * 1.2 + Math.random() * 0.6, n.z * 1.2 + (Math.random() - 0.5), 0.6 + Math.random() * 0.5, 0.15, 0.7, [c[0] * 0.9 + 0.1, c[1] * 0.9 + 0.1, c[2] * 0.9 + 0.1], [c[0] * 0.6 + 0.25, c[1] * 0.6 + 0.25, c[2] * 0.6 + 0.25], 0.55, 3, 0.5);
    }
    for (let i = 0; i < 2; i++) this.debris.spawn(p.x + n.x * 0.06, p.y + n.y * 0.06, p.z + n.z * 0.06, n.x * 3 + (Math.random() - 0.5) * 3, 2 + Math.random() * 3, n.z * 3 + (Math.random() - 0.5) * 3, 0.05 + Math.random() * 0.05, c, 1.2 + Math.random());
    if (voxelIndex !== undefined) this.decals.add(p, n, voxelIndex);
  }

  blood(p, dir) {
    for (let i = 0; i < this.pc(10); i++) {
      const sp = 1 + Math.random() * 4;
      this.smoke.spawn(p.x, p.y, p.z, dir.x * sp + (Math.random() - 0.5) * 2, dir.y * sp + Math.random() * 2, dir.z * sp + (Math.random() - 0.5) * 2, 0.35 + Math.random() * 0.3, 0.12, 0.3, [0.6, 0.02, 0.03], [0.35, 0.01, 0.02], 0.9, 1, 9, 0.3);
    }
  }

  explosion(p, removedColors = []) {
    this.flashLight(p, 0xff9a40, 60, 0.45, 26);
    const f = this.flashSpheres[this.flashIndex++ % this.flashSpheres.length];
    f.s.position.copy(p); f.ring.position.copy(p); f.t = 0; f.s.visible = true; f.ring.visible = true;
    for (let i = 0; i < this.pc(26); i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const sp = 2 + Math.random() * 7;
      const dx = Math.sin(ph) * Math.cos(th), dy = Math.cos(ph), dz = Math.sin(ph) * Math.sin(th);
      this.fire.spawn(p.x + dx * 0.3, p.y + dy * 0.3, p.z + dz * 0.3, dx * sp, dy * sp + 1.5, dz * sp, 0.35 + Math.random() * 0.35, 1.0 + Math.random(), 3 + Math.random() * 2.5, [1, 0.9, 0.55], [0.9, 0.25, 0.05], 1, 4.5, -1, 1);
    }
    for (let i = 0; i < this.pc(40); i++) {
      const sp = 9 + Math.random() * 18;
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      this.fire.spawn(p.x, p.y, p.z, Math.sin(ph) * Math.cos(th) * sp, Math.abs(Math.cos(ph)) * sp * 0.8 + 2, Math.sin(ph) * Math.sin(th) * sp, 0.4 + Math.random() * 0.6, 0.12, 0.04, [1, 0.9, 0.5], [1, 0.35, 0.05], 1, 1.5, 18, 0);
    }
    for (let i = 0; i < this.pc(22); i++) {
      const th = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 3.5;
      const g = 0.18 + Math.random() * 0.15;
      this.smoke.spawn(p.x + (Math.random() - 0.5), p.y + (Math.random() - 0.5), p.z + (Math.random() - 0.5), Math.cos(th) * sp, 1.2 + Math.random() * 2.2, Math.sin(th) * sp, 1.8 + Math.random() * 1.8, 1.5 + Math.random(), 5 + Math.random() * 3, [g * 1.4, g * 1.25, g * 1.1], [0.42, 0.4, 0.38], 0.8, 1.2, -0.25, 1);
    }
    // voxel debris from the removed material
    const n = Math.min(removedColors.length, this.pc(70));
    for (let i = 0; i < n; i++) {
      const rc = removedColors[(Math.random() * removedColors.length) | 0];
      const dx = rc.x - p.x, dy = rc.y - p.y, dz = rc.z - p.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      const sp = 5 + Math.random() * 9;
      this.debris.spawn(rc.x, rc.y, rc.z, dx / l * sp + (Math.random() - 0.5) * 3, dy / l * sp + 4 + Math.random() * 5, dz / l * sp + (Math.random() - 0.5) * 3, 0.12 + Math.random() * 0.26, rc.c);
    }
  }

  collapseDust(minX, maxX, y, minZ, maxZ, count, colors) {
    for (let i = 0; i < this.pc(count); i++) {
      const x = minX + Math.random() * (maxX - minX), z = minZ + Math.random() * (maxZ - minZ);
      const g = 0.55 + Math.random() * 0.15;
      this.smoke.spawn(x, y + Math.random() * 0.5, z, (Math.random() - 0.5) * 6, 0.5 + Math.random() * 2, (Math.random() - 0.5) * 6, 2 + Math.random() * 2.5, 1.2, 4.5 + Math.random() * 2, [g, g * 0.95, g * 0.88], [0.62, 0.6, 0.57], 0.6, 1.4, -0.1, 1);
    }
    for (const c of colors) this.debris.spawn(c.x, c.y, c.z, (Math.random() - 0.5) * 7, 2 + Math.random() * 6, (Math.random() - 0.5) * 7, 0.15 + Math.random() * 0.3, c.c);
  }

  spawnRocket(id, pos, vel, owner) {
    if (this.rockets.has(id)) return;
    const mesh = this.rocketTemplate.clone();
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffb060, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    glow.scale.setScalar(0.5);
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

  update(dt, camera, fog) {
    const h = window.innerHeight * Math.min(window.devicePixelRatio || 1, 2);
    this.pixelScale = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.fire.update(dt, fog, this.pixelScale);
    this.smoke.update(dt, fog, this.pixelScale);
    this.debris.update(dt);
    this.tracers.update(dt);
    this.decals.update(dt, this.world);
    for (const l of this.lights) {
      if (l.userData.t > 0) {
        l.userData.t -= dt;
        l.intensity = l.userData.peak * Math.max(0, l.userData.t / l.userData.dur);
      } else l.intensity = 0;
    }
    for (const f of this.flashSpheres) {
      if (f.t >= 1) continue;
      f.t += dt / 0.35;
      const k = Math.min(1, f.t);
      f.s.scale.setScalar(0.5 + k * 3.2);
      f.s.material.opacity = (1 - k) * 0.85;
      f.ring.scale.setScalar(0.5 + k * 7);
      f.ring.material.opacity = (1 - k) * 0.6;
      if (k >= 1) { f.s.visible = false; f.ring.visible = false; }
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
        this.smoke.spawn(tx, ty, tz, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6 + 0.3, (Math.random() - 0.5) * 0.6, 1.0 + Math.random() * 0.8, 0.25, 1.4, [0.85, 0.85, 0.85], [0.6, 0.6, 0.6], 0.45, 1.5, -0.3, 1);
        this.fire.spawn(tx, ty, tz, -fwd.x * 3, -fwd.y * 3, -fwd.z * 3, 0.08, 0.35, 0.1, [1, 0.85, 0.5], [1, 0.4, 0.1], 1, 0, 0, 1);
      }
      if (r.age > 7) this.removeRocket(id);
    }
  }

  clear() {
    this.fire.clear(); this.smoke.clear(); this.debris.clear(); this.tracers.clear(); this.decals.clear();
    for (const id of [...this.rockets.keys()]) this.removeRocket(id);
  }
}
