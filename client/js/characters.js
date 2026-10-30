// Realistic human soldier characters (rigged glTF model with skeletal animation),
// with procedural aiming, two-bone arm IK onto the rifle, directional legs, hit flashes
// and physical death falls / rocket flings. A procedural human is used if the model fails to load.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { buildRifle, buildLauncher } from './weaponModels.js';
import { PLAYER_COLORS, VOXEL } from '/shared/constants.js';
import { HumanCharacter, setFaceMap } from './human.js';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

// rotate a bone by a world-space rotation q (applied on top of its current pose)
function rotateBoneWorld(bone, q) {
  bone.parent.getWorldQuaternion(_q2);
  const inv = _q2.clone().invert();
  bone.quaternion.premultiply(inv.multiply(q).multiply(_q2));
  bone.updateMatrixWorld(true);
}

function aimBone(bone, child, targetPos) {
  bone.getWorldPosition(_v1);
  child.getWorldPosition(_v2);
  const cur = _v2.sub(_v1).normalize();
  const want = _v3.copy(targetPos).sub(_v1).normalize();
  _q1.setFromUnitVectors(cur, want);
  rotateBoneWorld(bone, _q1);
}

// Analytic two-bone IK: upper -> lower -> end, pulls end onto target with the elbow toward pole.
function solveTwoBone(upper, lower, end, target, pole) {
  const a = upper.getWorldPosition(new THREE.Vector3());
  const b = lower.getWorldPosition(new THREE.Vector3());
  const c = end.getWorldPosition(new THREE.Vector3());
  const la = a.distanceTo(b), lb = b.distanceTo(c);
  const toT = target.clone().sub(a);
  let d = toT.length();
  d = Math.min(Math.max(d, 0.05), la + lb - 1e-3);
  const dir = toT.normalize();
  const cosA = (la * la + d * d - lb * lb) / (2 * la * d);
  const angA = Math.acos(Math.min(1, Math.max(-1, cosA)));
  const perp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  const elbow = a.clone().add(dir.clone().multiplyScalar(Math.cos(angA) * la)).add(perp.multiplyScalar(Math.sin(angA) * la));
  aimBone(upper, lower, elbow);
  aimBone(lower, end, target);
}

function makeFlash() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,220,1)');
  grd.addColorStop(0.3, 'rgba(255,200,80,0.9)');
  grd.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(0.35);
  s.visible = false;
  return s;
}

export class CharacterFactory {
  constructor() {
    this.template = null;
    this.clips = {};
    this.ready = false;
    this.failed = false;
    this.scale = 1;
  }

  async load() {
    // 1st choice: the five Blender-built operators; then the older generic soldier; then Mixamo; else procedural
    for (const file of ['operators.glb', 'human_soldier.glb']) {
      try {
        const gltf = await new GLTFLoader().loadAsync(`/assets/models/${file}`);
        if (file === 'operators.glb') {
          // photographed faces from the reference sheets (UVs point into this atlas; everything else samples white)
          try {
            const tex = await new THREE.TextureLoader().loadAsync('/assets/textures/faces.png');
            tex.flipY = false;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = 4;
            setFaceMap(tex);
          } catch (e) { console.warn('faces.png unavailable', e); }
        }
        this.human = gltf.scene;
        this.humanClips = {};
        for (const clip of gltf.animations) this.humanClips[clip.name.replace(/\.\d+$/, '')] = clip;
        for (const [n, clip] of Object.entries(this.humanClips)) {
          if (n.startsWith('Death')) continue;
          clip.tracks = clip.tracks.filter((t) => !/^Root\.(position|quaternion)$/.test(t.name));
        }
        this.ready = true;
        this.kind = 'human';
        this.file = file;
        return;
      } catch (e) {
        console.warn(`${file} unavailable`, e);
      }
    }
    try {
      const gltf = await new GLTFLoader().loadAsync('/assets/models/soldier.glb');
      this.template = gltf.scene;
      for (const clip of gltf.animations) this.clips[clip.name.toLowerCase()] = clip;
      for (const clip of gltf.animations) {
        for (const track of clip.tracks) {
          if (track.name.endsWith('Hips.position')) {
            const v = track.values;
            const x0 = v[0], z0 = v[2];
            for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
          }
        }
      }
      this.template.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.template);
      const h = box.max.y - box.min.y;
      this.scale = h > 0.1 ? 1.8 / h : 1;
      this.footOffset = -box.min.y * this.scale;
      this.ready = true;
      this.kind = 'mixamo';
    } catch (e) {
      console.warn('Character model failed to load, using procedural humans', e);
      this.failed = true;
    }
  }

  create(id, name, quality) {
    if (this.kind === 'human') return new HumanCharacter(this.human, this.humanClips, id, name, quality);
    if (this.ready) return new SoldierCharacter(this, id, name, quality);
    return new ProceduralCharacter(id, name, quality);
  }
}

class BaseCharacter {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.root = new THREE.Group();
    this.root.name = `char-${id}`;
    this.aim = new THREE.Group();
    this.aim.position.set(0, 1.38, 0);
    this.root.add(this.aim);
    this.rifle = buildRifle({ detailed: false });
    this.rifle.rotation.y = Math.PI;
    this.rifle.position.set(-0.11, -0.06, 0.16);
    this.aim.add(this.rifle);
    this.launcher = buildLauncher({ detailed: false });
    this.launcher.rotation.y = Math.PI;
    this.launcher.position.set(-0.16, 0.12, 0.1);
    this.launcher.visible = false;
    this.aim.add(this.launcher);
    this.flash = makeFlash();
    this.flash.position.copy(this.rifle.userData.muzzle);
    this.rifle.add(this.flash);
    this.dead = false;
    this.deathT = 0;
    this.deathVel = new THREE.Vector3();
    this.deathSpin = 0;
    this.flashT = 0;
    this.hitT = 0;
    this.materials = [];
    this.visible = true;
    this.pitch = 0;
    this.yaw = 0;
    this.lastFootPhase = 0;
    this.onGroundPrev = true;
  }

  setVisible(v) { this.visible = v; this.root.visible = v; }

  fire() { this.flashT = 0.05; this.flash.material.rotation = Math.random() * 6.28; this.flash.scale.setScalar(0.25 + Math.random() * 0.2); }
  hit() { this.hitT = 0.18; }

  headWorld(out) { return out.set(this.root.position.x, this.root.position.y + 1.95, this.root.position.z); }
  muzzleWorld(out) {
    const obj = this.launcher.visible ? this.launcher : this.rifle;
    return obj.localToWorld(out.copy(obj.userData.muzzle));
  }

  die(force, world) {
    this.dead = true;
    this.deathT = 0;
    this.deathVel.set(force[0], force[1], force[2]);
    const sp = this.deathVel.length();
    this.flung = sp > 5;
    if (!this.flung) this.deathVel.multiplyScalar(0.4);
    this.deathSpin = (Math.random() < 0.5 ? -1 : 1) * (this.flung ? 6 + Math.random() * 6 : 0);
    this.fallSide = (Math.random() - 0.5) * 0.8;
    this.world = world;
    this.landed = false;
    this.tilt = 0;
    this.tiltVel = 0;
    this.restTilt = -Math.PI / 2 + (Math.random() - 0.5) * 0.2;
    this.launcher.visible = false;
    this.rifle.visible = false; // weapon is dropped on death
    this.flash.visible = false;
  }

  respawn() {
    this.dead = false;
    this.rifle.visible = true;
    this.root.rotation.set(0, 0, 0);
    this.root.visible = true;
    this.root.scale.setScalar(1);
  }

  groundAt(x, y, z) {
    const w = this.world;
    if (!w) return y;
    const vx = Math.floor(x / VOXEL), vz = Math.floor(z / VOXEL);
    let vy = Math.floor((y + 0.4) / VOXEL);
    for (let i = 0; i < 40 && vy >= 0; i++, vy--) if (w.solidAt(vx, vy, vz)) return (vy + 1) * VOXEL;
    return 0;
  }

  updateDeath(dt) {
    this.deathT += dt;
    const r = this.root;
    if (!this.landed) {
      this.deathVel.y -= 24 * dt;
      r.position.addScaledVector(this.deathVel, dt);
      const g = this.groundAt(r.position.x, r.position.y, r.position.z);
      if (r.position.y <= g && this.deathVel.y <= 0) {
        r.position.y = g;
        if (this.flung && Math.abs(this.deathVel.y) > 4) {
          this.deathVel.y *= -0.3; this.deathVel.x *= 0.5; this.deathVel.z *= 0.5;
        } else {
          this.landed = true;
        }
      }
    }
    // rotation: stiff fall around the feet, or a tumble when flung
    if (this.flung && !this.landed) {
      this.tilt += this.deathSpin * dt;
    } else {
      // spring toward lying on the back (sub-stepped for stability)
      const target = this.restTilt;
      const steps = Math.max(1, Math.ceil(dt * 120));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const acc = (target - this.tilt) * 60 - this.tiltVel * 9;
        this.tiltVel += acc * h;
        if (!this.flung) this.tiltVel += -9 * h * Math.cos(this.tilt);
        this.tilt += this.tiltVel * h;
        if (this.tilt < -Math.PI / 2 - 0.15) { this.tilt = -Math.PI / 2 - 0.15; this.tiltVel *= -0.25; }
      }
    }
    r.rotation.x = this.tilt;
    r.rotation.z = this.fallSide * Math.min(1, this.deathT * 2);
    if (this.deathT > 3.2) {
      const s = Math.max(0, 1 - (this.deathT - 3.2) / 0.8);
      r.position.y -= dt * 0.6;
      if (s <= 0) r.visible = false;
    }
  }

  updateEffects(dt) {
    if (this.flashT > 0) { this.flashT -= dt; this.flash.visible = this.flashT > 0; }
    if (this.hitT > 0) {
      this.hitT -= dt;
      const k = Math.max(0, this.hitT / 0.18);
      for (const m of this.materials) if (m.emissive) m.emissive.setRGB(k * 0.9, k * 0.05, k * 0.05);
    }
  }
}

class SoldierCharacter extends BaseCharacter {
  constructor(factory, id, name, quality) {
    super(id, name);
    this.model = cloneSkinned(factory.template);
    this.model.scale.setScalar(factory.scale);
    this.model.position.y = factory.footOffset;
    this.model.rotation.y = Math.PI; // the soldier model faces -Z; root space uses +Z as forward
    this.root.add(this.model);
    const tint = new THREE.Color(PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]);
    this.bones = {};
    this.model.traverse((o) => {
      if (o.isBone) this.bones[o.name.replace('mixamorig:', '').replace('mixamorig', '')] = o;
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = quality.characterShadows;
        o.receiveShadow = true;
        const m = o.material.clone();
        if (o.name.includes('visor')) {
          m.color = tint.clone().lerp(new THREE.Color(0xffffff), 0.25);
          m.emissive = tint.clone().multiplyScalar(0.35);
          m.roughness = 0.25;
          m.metalness = 0.4;
        } else {
          m.color = new THREE.Color(0xffffff).lerp(tint, 0.1);
          m.emissive = new THREE.Color(0, 0, 0);
        }
        o.material = m;
        this.materials.push(m);
      }
    });
    // team colour armband / chest marker for readability at range
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.07, 10), new THREE.MeshStandardMaterial({ color: tint, emissive: tint.clone().multiplyScalar(0.5), roughness: 0.5 }));
    this.band = band;
    this.materials.push(band.material);
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const n of ['idle', 'walk', 'run']) {
      const clip = factory.clips[n];
      if (!clip) continue;
      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(n === 'idle' ? 1 : 0);
      this.actions[n] = a;
    }
    const b = this.bones;
    this.chain = {
      hips: b.Hips, spine: b.Spine, spine1: b.Spine1, spine2: b.Spine2, neck: b.Neck, head: b.Head,
      rArm: b.RightArm, rFore: b.RightForeArm, rHand: b.RightHand, rFinger: b.RightHandMiddle1,
      lArm: b.LeftArm, lFore: b.LeftForeArm, lHand: b.LeftHand, lFinger: b.LeftHandMiddle1,
    };
    if (b.LeftArm) { b.LeftArm.add(band); band.position.set(0, 0.12 / factory.scale, 0); band.scale.setScalar(1 / factory.scale); }
    this.legYaw = 0;
    this.phase = 0;
  }

  update(dt, s) {
    // s: { x, y, z, yaw, pitch, vx, vy, vz, onGround, launcher, speed }
    this.updateEffects(dt);
    if (this.dead) { this.mixer.update(0); this.updateDeath(dt); return; }
    const r = this.root;
    r.position.set(s.x, s.y, s.z);
    r.rotation.set(0, s.yaw + Math.PI, 0);
    this.launcher.visible = !!s.launcher;
    this.rifle.visible = !s.launcher;
    this.aim.rotation.x = -s.pitch;

    // locomotion weights
    const sp = Math.hypot(s.vx, s.vz);
    const idleW = Math.max(0, 1 - sp / 1.8);
    const runW = Math.min(1, Math.max(0, (sp - 2.6) / 3));
    const walkW = Math.max(0, 1 - idleW - runW);
    const A = this.actions;
    // movement direction relative to facing (model faces +Z => forward vector (-sin yaw, -cos yaw))
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
    const fwd = sp > 0.3 ? (s.vx * fx + s.vz * fz) / sp : 1;
    const side = sp > 0.3 ? (s.vx * rx + s.vz * rz) / sp : 0;
    const backwards = fwd < -0.25;
    let legYaw = 0;
    if (sp > 0.6) {
      legYaw = Math.atan2(side, Math.abs(fwd)) * (backwards ? -1 : 1);
      legYaw = Math.max(-1.1, Math.min(1.1, legYaw));
    }
    this.legYaw += (legYaw - this.legYaw) * Math.min(1, dt * 10);
    const dir = backwards ? -1 : 1;
    if (A.idle) A.idle.setEffectiveWeight(s.onGround ? idleW : 0.2);
    if (A.walk) { A.walk.setEffectiveWeight(s.onGround ? walkW : 0.3); A.walk.timeScale = dir * Math.min(1.7, Math.max(0.7, sp / 1.7)); }
    if (A.run) { A.run.setEffectiveWeight(s.onGround ? runW : 0.5); A.run.timeScale = dir * Math.min(1.5, Math.max(0.7, sp / 5.5)); }
    if (!s.onGround) { if (A.walk) A.walk.timeScale *= 0.15; if (A.run) A.run.timeScale *= 0.15; }
    this.mixer.update(dt);
    this.model.updateMatrixWorld(true);

    const c = this.chain;
    if (!c.spine || !c.rArm) return;
    // lower body faces the movement direction, upper body counter-rotates to the aim
    if (Math.abs(this.legYaw) > 0.01) {
      _q1.setFromAxisAngle(UP, this.legYaw);
      rotateBoneWorld(c.hips, _q1);
      _q1.setFromAxisAngle(UP, -this.legYaw * 0.55);
      rotateBoneWorld(c.spine, _q1);
      _q1.setFromAxisAngle(UP, -this.legYaw * 0.45);
      rotateBoneWorld(c.spine1, _q1);
    }
    // straighten the upper body into a rifle stance, then pitch with the aim
    const right = _v4.set(rx, 0, rz);
    _q1.setFromAxisAngle(UP, 0.3);
    rotateBoneWorld(c.spine1, _q1);
    _q1.setFromAxisAngle(UP, -0.18);
    rotateBoneWorld(c.spine2, _q1);
    const pitch = s.pitch;
    _q1.setFromAxisAngle(right, -pitch * 0.25 - 0.06);
    rotateBoneWorld(c.spine1, _q1);
    _q1.setFromAxisAngle(right, -pitch * 0.25);
    rotateBoneWorld(c.spine2, _q1);
    if (c.head) {
      _q1.setFromAxisAngle(UP, -0.2);
      rotateBoneWorld(c.neck || c.head, _q1);
      _q1.setFromAxisAngle(right, -pitch * 0.45);
      rotateBoneWorld(c.head, _q1);
    }
    // arms: IK hands onto the rifle (or launcher)
    this.root.updateMatrixWorld(true);
    const weapon = s.launcher ? this.launcher : this.rifle;
    const gripLocal = s.launcher ? new THREE.Vector3(0, -0.07, 0.05) : weapon.userData.grip;
    const foreLocal = s.launcher ? new THREE.Vector3(0, -0.06, -0.32) : weapon.userData.fore;
    const gripW = weapon.localToWorld(_v1.copy(gripLocal)).clone();
    const foreW = weapon.localToWorld(_v1.copy(foreLocal)).clone();
    const down = new THREE.Vector3(0, -1, 0);
    const poleR = right.clone().multiplyScalar(0.8).add(down).add(_v2.set(-fx, 0, -fz).multiplyScalar(0.3)).normalize();
    const poleL = right.clone().multiplyScalar(-0.5).add(down).add(_v2.set(-fx, 0, -fz).multiplyScalar(0.1)).normalize();
    solveTwoBone(c.rArm, c.rFore, c.rHand, gripW, poleR);
    solveTwoBone(c.lArm, c.lFore, c.lHand, foreW, poleL);
    // orient hands along the weapon
    const wf = weapon.getWorldDirection(new THREE.Vector3()).negate(); // barrel direction (-Z local) in world
    const wUp = _v3.set(0, 1, 0).applyQuaternion(weapon.getWorldQuaternion(_q2));
    if (c.rFinger) {
      const rt = c.rHand.getWorldPosition(new THREE.Vector3()).add(wf.clone().multiplyScalar(0.25).addScaledVector(wUp, -0.75).addScaledVector(right, -0.45).normalize().multiplyScalar(0.1));
      aimBone(c.rHand, c.rFinger, rt);
    }
    if (c.lFinger) {
      const lt = c.lHand.getWorldPosition(new THREE.Vector3()).add(wf.clone().multiplyScalar(0.7).addScaledVector(wUp, 0.15).addScaledVector(right, 0.5).normalize().multiplyScalar(0.1));
      aimBone(c.lHand, c.lFinger, lt);
    }
    // footstep phase for audio
    this.phase += sp * dt;
  }

  dispose() {
    this.root.traverse((o) => { if (o.isMesh && o.material) o.material.dispose?.(); });
  }
}

// ------------------------------------------------------------------ procedural fallback

function capsule(r, len, mat) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat);
  m.castShadow = true;
  return m;
}

class ProceduralCharacter extends BaseCharacter {
  constructor(id, name, quality) {
    super(id, name);
    const tint = new THREE.Color(PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]);
    const skin = new THREE.MeshStandardMaterial({ color: [0xe0b18f, 0xc68c64, 0x8d5a3b, 0xf0c8a8][id % 4], roughness: 0.6, emissive: 0 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x4a5040, roughness: 0.9, emissive: 0 });
    const vest = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.7, emissive: 0 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1e2024, roughness: 0.8, emissive: 0 });
    this.materials.push(skin, cloth, vest, dark);
    const body = new THREE.Group();
    this.root.add(body);
    this.hips = new THREE.Group(); this.hips.position.y = 0.95; body.add(this.hips);
    const torso = capsule(0.17, 0.32, cloth); torso.scale.set(1, 1, 0.65); torso.position.y = 0.3; this.hips.add(torso);
    const vestM = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.36, 0.26), vest); vestM.position.y = 0.33; vestM.castShadow = true; this.hips.add(vestM);
    const head = new THREE.Group(); head.position.y = 0.7; this.hips.add(head); this.head = head;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), skin); skull.scale.set(0.9, 1.1, 1); head.add(skull);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), dark); helmet.position.y = 0.03; head.add(helmet);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.05), vest); visor.position.set(0, 0.03, 0.1); head.add(visor);
    const mkLeg = (side) => {
      const thigh = new THREE.Group(); thigh.position.set(side * 0.1, 0, 0); this.hips.add(thigh);
      const t = capsule(0.075, 0.3, cloth); t.position.y = -0.22; thigh.add(t);
      const knee = new THREE.Group(); knee.position.y = -0.44; thigh.add(knee);
      const sh = capsule(0.06, 0.32, cloth); sh.position.y = -0.22; knee.add(sh);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.24), dark); boot.position.set(0, -0.47, 0.05); boot.castShadow = true; knee.add(boot);
      return { thigh, knee };
    };
    this.legL = mkLeg(1); this.legR = mkLeg(-1);
    const mkArm = (side) => {
      const sh = new THREE.Group(); sh.position.set(side * 0.22, 0.5, 0); this.hips.add(sh);
      const u = capsule(0.05, 0.22, cloth); u.position.y = -0.15; sh.add(u);
      const el = new THREE.Group(); el.position.y = -0.3; sh.add(el);
      const f = capsule(0.045, 0.2, cloth); f.position.y = -0.13; el.add(f);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.05), dark); hand.position.y = -0.3; el.add(hand);
      return { sh, el };
    };
    this.armL = mkArm(1); this.armR = mkArm(-1);
    this.phase = 0;
  }

  update(dt, s) {
    this.updateEffects(dt);
    if (this.dead) { this.updateDeath(dt); return; }
    const r = this.root;
    r.position.set(s.x, s.y, s.z);
    r.rotation.set(0, s.yaw + Math.PI, 0);
    this.launcher.visible = !!s.launcher;
    this.rifle.visible = !s.launcher;
    this.aim.rotation.x = -s.pitch;
    const sp = Math.hypot(s.vx, s.vz);
    this.phase += dt * (2 + sp * 1.4);
    const amp = s.onGround ? Math.min(0.9, sp / 7) : 0.3;
    const sw = Math.sin(this.phase) * amp;
    this.legL.thigh.rotation.x = s.onGround ? sw : -0.6;
    this.legR.thigh.rotation.x = s.onGround ? -sw : -0.3;
    this.legL.knee.rotation.x = s.onGround ? Math.max(0, -Math.cos(this.phase)) * amp * 1.2 : 0.9;
    this.legR.knee.rotation.x = s.onGround ? Math.max(0, Math.cos(this.phase)) * amp * 1.2 : 0.7;
    this.hips.position.y = 0.95 + Math.abs(Math.cos(this.phase)) * amp * 0.04;
    // arms in a rifle hold that follows the aim pitch
    this.armR.sh.rotation.set(-1.1 - s.pitch, 0, 0.25);
    this.armR.el.rotation.set(-0.9, 0, 0);
    this.armL.sh.rotation.set(-1.35 - s.pitch, 0, -0.45);
    this.armL.el.rotation.set(-0.35, 0, 0);
    this.head.rotation.x = -s.pitch * 0.6;
    this.hips.children[0].rotation.x = -s.pitch * 0.2;
  }

  dispose() {}
}
