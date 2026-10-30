// Blender-built human soldiers (tools/blender/build_characters.py -> human_soldier.glb).
// Per-player look (skin tone, hair, beard, headgear, team colour), 8-way locomotion blending,
// aim pitch through the spine, muzzle flashes, hit flashes and authored death animations
// (shot in the back / front / head) combined with a physical fling for explosions.

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER_COLORS, VOXEL, WEAPON } from '/shared/constants.js';
import { hash3 } from '/shared/util.js';
import { operatorFor } from './operators.js';

let faceMap = null;
export function setFaceMap(t) { faceMap = t; }

const SKIN_TONES = [0xf1c8a8, 0xe0ac86, 0xc68c64, 0xa86f4c, 0x8d5a3b, 0x6b4229];
const HAIR_COLORS = [0x2a1d14, 0x1a1512, 0x4a3020, 0x7a5a3a, 0x9a8a70, 0x3a2a20];
const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3();

function rotateBoneWorld(bone, axis, angle) {
  bone.parent.getWorldQuaternion(_q2);
  _q.setFromAxisAngle(axis, angle);
  const inv = _q2.clone().invert();
  bone.quaternion.premultiply(inv.multiply(_q).multiply(_q2));
}

function flashSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,220,1)');
  grd.addColorStop(0.3, 'rgba(255,200,80,0.9)');
  grd.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
  s.scale.setScalar(0.4);
  s.visible = false;
  return s;
}

export class HumanCharacter {
  constructor(template, clips, id, name, quality) {
    this.id = id;
    this.name = name;
    this.root = new THREE.Group();
    this.root.name = `human-${id}`;
    this.model = cloneSkinned(template);
    this.root.add(this.model);
    // operators.glb holds five operator meshes on one skeleton: keep this player's, drop the others
    this.operator = operatorFor(id);
    const opNodes = [];
    this.model.traverse((o) => { if (/^Op_[A-Za-z]+$/.test(o.name)) opNodes.push(o); });
    if (opNodes.length) {
      const want = `Op_${this.operator.name}`;
      const keep = opNodes.find((o) => o.name === want) || opNodes[0];
      for (const o of opNodes) if (o !== keep) o.parent.remove(o);
    }
    this.materials = [];
    const tint = new THREE.Color(PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]);
    const h = (k) => hash3(id, k, 31, 7);
    const skin = new THREE.Color(SKIN_TONES[Math.floor(h(1) * SKIN_TONES.length)]);
    const hair = new THREE.Color(HAIR_COLORS[Math.floor(h(2) * HAIR_COLORS.length)]);
    // look variants
    const hairVar = h(3) < 0.55 ? 'Var_HairShort' : 'Var_HairBuzz';
    const r = h(4);
    const gear = r < 0.45 ? 'Var_Helmet' : r < 0.65 ? 'Var_Cap' : r < 0.82 ? 'Var_Beanie' : null;
    const beard = h(5) < 0.4;
    const headset = gear !== 'Var_Beanie' && h(6) < 0.35;
    // short hair would poke through a helmet or beanie, so those get the buzz cut
    const hairName = gear === 'Var_Helmet' || gear === 'Var_Beanie' ? 'Var_HairBuzz' : hairVar;
    const matCache = new Map();
    const cloneMat = (m) => {
      if (matCache.has(m)) return matCache.get(m);
      const c = m.clone();
      if (c.emissive === undefined) c.emissive = new THREE.Color(0, 0, 0);
      if (m.name === 'Skin') c.color.copy(skin);
      if (m.name === 'Lips') c.color.copy(skin).multiplyScalar(0.78).lerp(new THREE.Color(0xa0504a), 0.4);
      if (m.name === 'Hair') c.color.copy(hair);
      if (m.name === 'TeamAccent') { c.color.copy(tint); c.emissive = tint.clone().multiplyScalar(0.5); }
      if (m.name === 'Operator' && faceMap) { c.map = faceMap; c.needsUpdate = true; }
      this.materials.push(c);
      matCache.set(m, c);
      return c;
    };
    this.bones = {};
    this.model.traverse((o) => {
      if (o.isBone) this.bones[o.name.replace(/[.\s]/g, '')] = o;
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = quality.characterShadows;
        o.receiveShadow = true;
        o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material);
      }
      if (o.name.startsWith('Var_')) {
        const n = o.name.replace(/_\d+$/, '');
        o.visible = n === hairName || n === gear || (beard && n === 'Var_Beard') || (headset && n === 'Var_Headset');
      }
    });
    this.rifle = this.model.getObjectByName('Rifle3P');
    this.launcher = this.model.getObjectByName('Launcher3P');
    if (this.launcher) this.launcher.visible = false;
    this.flash = flashSprite();
    this.flash.position.set(0, 0.09, 0.74);
    if (this.rifle) this.rifle.add(this.flash);
    this.muzzleLocal = new THREE.Vector3(0, 0.09, 0.74);
    this.launcherMuzzle = new THREE.Vector3(0, 0.2, 0.6);
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const [n, clip] of Object.entries(clips)) {
      const a = this.mixer.clipAction(clip);
      if (n.startsWith('Death')) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
        a.enabled = false;
      } else {
        a.play();
        a.setEffectiveWeight(n === 'Idle' ? 1 : 0);
      }
      this.actions[n] = a;
    }
    const rb = this.bones.Root;
    this.rootRest = rb ? { p: rb.position.clone(), q: rb.quaternion.clone() } : null;
    this.weights = { Idle: 1, Walk: 0, Run: 0, Back: 0, StrafeL: 0, StrafeR: 0, Jump: 0 };
    this.dead = false;
    this.flashT = 0;
    this.hitT = 0;
    this.visible = true;
    this.deathVel = new THREE.Vector3();
  }

  setVisible(v) { this.visible = v; this.root.visible = v; }

  fire() {
    this.flashT = 0.05;
    this.flash.material.rotation = Math.random() * 6.28;
    this.flash.scale.setScalar(0.3 + Math.random() * 0.25);
  }

  hit() { this.hitT = 0.2; }

  muzzleWorld(out) {
    if (this.launcher && this.launcher.visible) return this.launcher.localToWorld(out.copy(this.launcherMuzzle));
    if (this.rifle) return this.rifle.localToWorld(out.copy(this.muzzleLocal));
    return out.copy(this.root.position).add(_v.set(0, 1.4, 0));
  }

  headWorld(out) {
    const hb = this.bones.Head;
    if (hb) return hb.getWorldPosition(out).add(_v.set(0, 0.35, 0));
    return out.copy(this.root.position).add(_v.set(0, 2.1, 0));
  }

  // info: { weapon, head, from: Vector3 (attacker position) }
  die(force, world, info = {}) {
    if (this.dead) return;
    this.restoreAim();
    this.aimBase = null;
    this.dead = true;
    this.deathT = 0;
    this.world = world;
    this.deathVel.set(force[0] || 0, force[1] || 0, force[2] || 0);
    const explosive = info.weapon === WEAPON.ROCKET || info.weapon === WEAPON.CRUSH || this.deathVel.length() > 6;
    this.flung = explosive && this.deathVel.length() > 3;
    if (!this.flung) this.deathVel.multiplyScalar(0.3);
    this.landed = !this.flung;
    // which way did the shot come from, relative to facing?
    let clip = 'DeathBack';
    if (info.head && Math.random() < 0.8) clip = 'DeathHead';
    else if (info.from) {
      const fx = -Math.sin(this.yawNow || 0), fz = -Math.cos(this.yawNow || 0);
      const dx = info.from.x - this.root.position.x, dz = info.from.z - this.root.position.z;
      const inFront = dx * fx + dz * fz > 0;
      clip = inFront ? 'DeathBack' : 'DeathFront';
    } else if (Math.random() < 0.4) clip = 'DeathFront';
    if (this.flung) clip = Math.random() < 0.5 ? 'DeathBack' : 'DeathFront';
    for (const [n, a] of Object.entries(this.actions)) {
      if (n.startsWith('Death')) continue;
      a.setEffectiveWeight(0);
    }
    const a = this.actions[clip];
    if (a) {
      a.enabled = true;
      a.reset();
      a.setEffectiveWeight(1);
      a.timeScale = this.flung ? 0.8 : 1;
      a.play();
    }
    this.deathClip = clip;
    if (this.rifle) this.rifle.visible = false;
    if (this.launcher) this.launcher.visible = false;
    this.flash.visible = false;
    this.spin = this.flung ? (Math.random() - 0.5) * 6 : 0;
    return clip;
  }

  respawn() {
    if (!this.dead) return;
    this.dead = false;
    this.aimBase = null;
    for (const [n, a] of Object.entries(this.actions)) {
      if (n.startsWith('Death')) { a.stop(); a.enabled = false; }
      else { a.enabled = true; a.play(); }
    }
    if (this.rifle) this.rifle.visible = true;
    if (this.rootRest) { this.bones.Root.position.copy(this.rootRest.p); this.bones.Root.quaternion.copy(this.rootRest.q); }
    this.root.rotation.set(0, 0, 0);
    this.model.position.set(0, 0, 0);
    this.root.visible = true;
  }

  groundAt(x, y, z) {
    const w = this.world;
    if (!w) return y;
    const vx = Math.floor(x / VOXEL), vz = Math.floor(z / VOXEL);
    let vy = Math.floor((y + 0.4) / VOXEL);
    for (let i = 0; i < 60 && vy >= 0; i++, vy--) if (w.solidAt(vx, vy, vz)) return (vy + 1) * VOXEL;
    return 0;
  }

  updateDeath(dt) {
    this.deathT += dt;
    const r = this.root;
    if (!this.landed) {
      this.deathVel.y -= 24 * dt;
      r.position.addScaledVector(this.deathVel, dt);
      r.rotation.y += this.spin * dt;
      const g = this.groundAt(r.position.x, r.position.y, r.position.z);
      if (r.position.y <= g && this.deathVel.y <= 0) {
        r.position.y = g;
        if (Math.abs(this.deathVel.y) > 5) { this.deathVel.y *= -0.25; this.deathVel.x *= 0.5; this.deathVel.z *= 0.5; }
        else this.landed = true;
      }
    } else {
      // settle onto whatever is below (rubble, a collapsed floor)
      const g = this.groundAt(r.position.x, r.position.y + 0.2, r.position.z);
      if (r.position.y > g + 0.02) r.position.y = Math.max(g, r.position.y - dt * 6);
    }
    this.mixer.update(dt);
    if (this.deathT > 4.0) {
      r.position.y -= dt * 0.5;
      if (this.deathT > 5.2) r.visible = false;
    }
  }

  updateEffects(dt) {
    if (this.flashT > 0) { this.flashT -= dt; this.flash.visible = this.flashT > 0 && !this.dead; }
    if (this.hitT > 0) {
      this.hitT -= dt;
      const k = Math.max(0, this.hitT / 0.2);
      for (const m of this.materials) if (m.emissive && m.name !== 'TeamAccent') m.emissive.setRGB(k * 0.8, k * 0.06, k * 0.04);
    }
  }

  // Undo last frame's aim bend. The mixer only writes a bone when its animated value changes, so on a
  // still pose (standing idle) the bend would otherwise pile up frame after frame and spin the torso.
  restoreAim() {
    if (!this.aimBase) return;
    for (const [bone, q] of this.aimBase) bone.quaternion.copy(q);
  }

  update(dt, s) {
    this.updateEffects(dt);
    this.restoreAim();
    if (this.dead) { this.updateDeath(dt); return; }
    const r = this.root;
    r.position.set(s.x, s.y, s.z);
    r.rotation.set(0, s.yaw + Math.PI, 0);
    this.yawNow = s.yaw;
    if (this.launcher) this.launcher.visible = !!s.launcher;
    if (this.rifle) this.rifle.visible = !s.launcher;

    // locomotion: blend directional clips by local velocity
    const sp = Math.hypot(s.vx, s.vz);
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
    const fwd = s.vx * fx + s.vz * fz, side = s.vx * rx + s.vz * rz;
    const W = { Idle: 0, Walk: 0, Run: 0, Back: 0, StrafeL: 0, StrafeR: 0, Jump: 0 };
    if (!s.onGround) W.Jump = 1;
    else if (sp < 0.4) W.Idle = 1;
    else {
      const move = Math.min(1, sp / 1.5);
      W.Idle = 1 - move;
      const nf = fwd / sp, ns = side / sp;
      const wF = Math.max(0, nf), wB = Math.max(0, -nf), wR = Math.max(0, ns), wL = Math.max(0, -ns);
      const tot = wF + wB + wR + wL || 1;
      const run = Math.min(1, Math.max(0, (sp - 3) / 2.5));
      W.Walk = move * (wF / tot) * (1 - run);
      W.Run = move * (wF / tot) * run;
      W.Back = move * (wB / tot);
      W.StrafeR = move * (wR / tot);
      W.StrafeL = move * (wL / tot);
    }
    const k = Math.min(1, dt * 12);
    for (const n of Object.keys(W)) {
      this.weights[n] += (W[n] - this.weights[n]) * k;
      const a = this.actions[n];
      if (a) a.setEffectiveWeight(this.weights[n]);
    }
    const A = this.actions;
    if (A.Walk) A.Walk.timeScale = Math.min(2.2, Math.max(0.6, sp / 1.6));
    if (A.Run) A.Run.timeScale = Math.min(2.0, Math.max(0.8, sp / 3.4));
    if (A.Back) A.Back.timeScale = Math.min(2.4, Math.max(0.6, sp / 1.85));
    if (A.StrafeL) A.StrafeL.timeScale = Math.min(2.4, Math.max(0.6, sp / 2.2));
    if (A.StrafeR) A.StrafeR.timeScale = Math.min(2.4, Math.max(0.6, sp / 2.2));
    this.mixer.update(dt);

    // aim pitch through the spine; the weapon bone hangs off the upper chest
    const b = this.bones;
    if (b.Spine && b.Chest && b.UpperChest) {
      this.model.updateMatrixWorld(true);
      const right = _v.set(rx, 0, rz).clone();
      const p = Math.max(-1.3, Math.min(1.3, s.pitch));
      if (!this.aimBase) this.aimBase = [b.Spine, b.Chest, b.UpperChest, b.Neck].filter(Boolean).map((bone) => [bone, new THREE.Quaternion()]);
      for (const [bone, q] of this.aimBase) q.copy(bone.quaternion);
      rotateBoneWorld(b.Spine, right, p * 0.2);
      rotateBoneWorld(b.Chest, right, p * 0.3);
      rotateBoneWorld(b.UpperChest, right, p * 0.5);
      if (b.Neck) rotateBoneWorld(b.Neck, right, -p * 0.15);
    }
    this.phase = (this.phase || 0) + sp * dt;
  }

  dispose() {
    for (const m of this.materials) m.dispose();
  }
}
