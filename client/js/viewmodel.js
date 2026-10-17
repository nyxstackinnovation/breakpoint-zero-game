// First-person weapons: gloved arms holding a detailed rifle and rocket launcher, with sway,
// bob, spring recoil, a full magazine reload, launcher swap, muzzle flashes and ejected brass.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { buildRifle, buildLauncher, buildMagazine, weaponMaterials } from './weaponModels.js';
import { PLAYER_COLORS } from '/shared/constants.js';

class Spring {
  constructor(k = 120, d = 14) { this.x = 0; this.v = 0; this.k = k; this.d = d; this.target = 0; }
  update(dt) {
    // sub-stepped semi-implicit Euler stays stable even at very low frame rates
    const steps = Math.min(30, Math.max(1, Math.ceil(dt * 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = (this.target - this.x) * this.k - this.v * this.d;
      this.v += a * h;
      this.x += this.v * h;
    }
    if (!Number.isFinite(this.x)) { this.x = 0; this.v = 0; }
    return this.x;
  }
  kick(v) { this.v += v; }
}

function flashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.translate(64, 64);
  for (let i = 0; i < 7; i++) {
    g.rotate((Math.PI * 2) / 7);
    const grd = g.createLinearGradient(0, 0, 0, -60);
    grd.addColorStop(0, 'rgba(255,250,210,1)');
    grd.addColorStop(0.4, 'rgba(255,190,70,0.85)');
    grd.addColorStop(1, 'rgba(255,100,20,0)');
    g.fillStyle = grd;
    g.beginPath(); g.moveTo(-9, 0); g.lineTo(0, -40 - Math.random() * 22); g.lineTo(9, 0); g.fill();
  }
  const r = g.createRadialGradient(0, 0, 0, 0, 0, 30);
  r.addColorStop(0, 'rgba(255,255,240,1)'); r.addColorStop(1, 'rgba(255,170,60,0)');
  g.fillStyle = r; g.beginPath(); g.arc(0, 0, 30, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ViewModel {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a4036, 1.4));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(-0.6, 1, 0.5);
    this.scene.add(this.sun);
    this.fill = new THREE.DirectionalLight(0x9fb7ff, 0.6);
    this.fill.position.set(0.8, 0.2, 0.6);
    this.scene.add(this.fill);
    this.rig = new THREE.Group();
    this.scene.add(this.rig);

    this.gloveMat = new THREE.MeshStandardMaterial({ color: 0x2b2a28, roughness: 0.85 });
    this.sleeveMat = new THREE.MeshStandardMaterial({ color: 0x4d5440, roughness: 0.9 });
    this.bandMat = new THREE.MeshStandardMaterial({ color: 0xff3b5c, roughness: 0.6 });
    this.skinMat = new THREE.MeshStandardMaterial({ color: 0xc89474, roughness: 0.6 });

    // rifle
    this.rifleHolder = new THREE.Group();
    this.rifleBase = new THREE.Vector3(0.15, -0.175, -0.37);
    this.rifleHolder.position.copy(this.rifleBase);
    this.rig.add(this.rifleHolder);
    this.rifle = buildRifle({ detailed: true, noMag: true });
    this.rifleHolder.add(this.rifle);
    this.mag = buildMagazine();
    this.magBase = new THREE.Vector3(0, -0.035, -0.1);
    this.mag.position.copy(this.magBase);
    this.rifle.add(this.mag);
    this.rightArmR = this.buildArm(this.rifle.userData.grip, new THREE.Vector3(0.12, -0.32, 0.42), true);
    this.rifle.add(this.rightArmR);
    this.leftArmR = this.buildArm(this.rifle.userData.fore, new THREE.Vector3(-0.32, -0.3, 0.05), false);
    this.rifle.add(this.leftArmR);

    // launcher
    this.launcherHolder = new THREE.Group();
    this.launcherBase = new THREE.Vector3(0.25, -0.17, -0.34);
    this.launcherHolder.position.set(0.2, -0.7, -0.22);
    this.rig.add(this.launcherHolder);
    this.launcher = buildLauncher({ detailed: true });
    this.launcherHolder.add(this.launcher);
    this.launcherHolder.visible = false;
    this.launcher.add(this.buildArm(new THREE.Vector3(0, -0.07, 0.05), new THREE.Vector3(0.1, -0.35, 0.45), true));
    this.launcher.add(this.buildArm(new THREE.Vector3(0, -0.06, -0.32), new THREE.Vector3(-0.32, -0.32, -0.05), false));

    // muzzle flashes
    const ftex = flashTexture();
    this.flashMat = new THREE.MeshBasicMaterial({ map: ftex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.flash = new THREE.Group();
    const f1 = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), this.flashMat);
    const f2 = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.24), this.flashMat); f2.rotation.y = Math.PI / 2; f2.position.z = -0.08;
    const f3 = f2.clone(); f3.rotation.set(0, Math.PI / 2, Math.PI / 2);
    this.flash.add(f1, f2, f3);
    this.flash.position.copy(this.rifle.userData.muzzle);
    this.flash.visible = false;
    this.rifle.add(this.flash);
    this.rflash = this.flash.clone();
    this.rflash.scale.setScalar(2.2);
    this.rflash.position.copy(this.launcher.userData.muzzle);
    this.rflash.visible = false;
    this.launcher.add(this.rflash);
    this.backblast = this.flash.clone();
    this.backblast.scale.setScalar(2.5);
    this.backblast.position.copy(this.launcher.userData.rear);
    this.backblast.visible = false;
    this.launcher.add(this.backblast);

    // brass
    this.shells = [];
    const shellGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.022, 8);
    shellGeo.rotateZ(Math.PI / 2);
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(shellGeo, weaponMaterials().brass);
      m.visible = false;
      this.rig.add(m);
      this.shells.push({ mesh: m, v: new THREE.Vector3(), life: 0, spin: new THREE.Vector3() });
    }
    this.shellIndex = 0;

    this.kickZ = new Spring(180, 18);
    this.kickRX = new Spring(160, 16);
    this.kickRY = new Spring(140, 15);
    this.swayX = new Spring(60, 11);
    this.swayY = new Spring(60, 11);
    this.dip = new Spring(90, 12);
    this.bobPhase = 0;
    this.bobAmt = 0;
    this.flashT = 0;
    this.rflashT = 0;
    this.reloadT = -1;
    this.reloadDur = 1.7;
    this.launcherBlend = 0;
    this.launcherHold = 0;
    this.drawT = 0;
  }

  setColor(id) {
    this.bandMat.color.setHex(PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]);
  }

  setLighting(theme) {
    this.sun.color.setHex(theme.sun);
    this.scene.children[0].color.setHex(theme.hemiSky);
    this.scene.children[0].groundColor.setHex(theme.hemiGround);
  }

  // arm from hand position to elbow position (weapon-local), continuing off-screen
  buildArm(hand, elbow, right) {
    const g = new THREE.Group();
    const dir = elbow.clone().sub(hand);
    const len = dir.length();
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.05, len + 0.4, 12), this.sleeveMat);
    sleeve.position.copy(hand).addScaledVector(dir.clone().normalize(), (len + 0.4) / 2 + 0.06);
    sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    g.add(sleeve);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.039, 0.039, 0.04, 12), this.gloveMat);
    cuff.position.copy(hand).addScaledVector(dir.clone().normalize(), 0.075);
    cuff.quaternion.copy(sleeve.quaternion);
    g.add(cuff);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.035, 12), this.bandMat);
    band.position.copy(hand).addScaledVector(dir.clone().normalize(), 0.24);
    band.quaternion.copy(sleeve.quaternion);
    g.add(band);
    const palm = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.085, 0.075, 2, 0.015), this.gloveMat);
    palm.position.copy(hand);
    if (right) palm.position.x += 0.012;
    else palm.position.y -= 0.025;
    g.add(palm);
    // fingers wrapping the grip / handguard
    const fingerGeo = new THREE.CapsuleGeometry(0.0095, 0.03, 3, 6);
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(fingerGeo, this.gloveMat);
      if (right) {
        f.position.set(hand.x - 0.022, hand.y + 0.03 - i * 0.022, hand.z - 0.03);
        f.rotation.set(0, 0, Math.PI / 2);
      } else {
        f.position.set(hand.x - 0.028, hand.y + 0.005, hand.z - 0.02 - i * 0.022);
        f.rotation.set(0.2, 0, -0.35);
      }
      g.add(f);
    }
    const thumb = new THREE.Mesh(fingerGeo, this.gloveMat);
    if (right) { thumb.position.set(hand.x - 0.02, hand.y + 0.05, hand.z - 0.015); thumb.rotation.set(0.6, 0, 0.9); }
    else { thumb.position.set(hand.x + 0.03, hand.y + 0.01, hand.z - 0.03); thumb.rotation.set(1.3, 0, 0.3); }
    g.add(thumb);
    return g;
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }

  fire() {
    this.kickZ.kick(1.6 + Math.random() * 0.4);
    this.kickRX.kick(2.2 + Math.random() * 0.8);
    this.kickRY.kick((Math.random() - 0.5) * 1.2);
    this.flashT = 0.04;
    this.flash.rotation.z = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
    this.ejectShell();
  }

  fireRocket() {
    this.launcherHold = 0.75;
    this.kickZ.kick(4.2);
    this.kickRX.kick(5.5);
    this.rflashT = 0.07;
    this.launcher.userData.warhead.visible = false;
    setTimeout(() => { this.launcher.userData.warhead.visible = true; }, 650);
  }

  reload() { if (this.reloadT < 0) this.reloadT = 0; }
  cancelReload() { this.reloadT = -1; this.mag.position.copy(this.magBase); this.mag.visible = true; }

  land(speed) { this.dip.kick(-Math.min(1.5, speed * 0.12)); }

  draw() { this.drawT = 0.35; }

  ejectShell() {
    const s = this.shells[this.shellIndex++ % this.shells.length];
    const p = this.rifle.localToWorld(this.rifle.userData.eject.clone());
    this.rig.worldToLocal(p);
    s.mesh.position.copy(p);
    s.v.set(0.9 + Math.random() * 0.5, 0.9 + Math.random() * 0.5, 0.2 + Math.random() * 0.3);
    s.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
    s.life = 0.7;
    s.mesh.visible = true;
  }

  muzzleWorld(mainCamera, out, launcher = false) {
    const obj = launcher ? this.launcher : this.rifle;
    const p = obj.localToWorld((launcher ? obj.userData.muzzle : obj.userData.muzzle).clone());
    // rig space == camera space of the main camera
    this.rig.worldToLocal(p);
    p.z *= 0.9;
    return out.copy(p).applyMatrix4(mainCamera.matrixWorld);
  }

  update(dt, st) {
    // st: { speed, onGround, mouseDX, mouseDY, alive }
    this.swayX.target = Math.max(-0.08, Math.min(0.08, -st.mouseDX * 0.0009));
    this.swayY.target = Math.max(-0.08, Math.min(0.08, -st.mouseDY * 0.0009));
    const sx = this.swayX.update(dt), sy = this.swayY.update(dt);
    const moving = st.onGround ? Math.min(1, st.speed / 7) : 0;
    this.bobAmt += (moving - this.bobAmt) * Math.min(1, dt * 8);
    this.bobPhase += dt * (6 + st.speed * 0.9);
    const bx = Math.sin(this.bobPhase) * 0.011 * this.bobAmt;
    const by = -Math.abs(Math.cos(this.bobPhase)) * 0.012 * this.bobAmt;
    const kz = this.kickZ.update(dt), krx = this.kickRX.update(dt), kry = this.kickRY.update(dt);
    const dip = this.dip.update(dt);
    if (this.drawT > 0) this.drawT = Math.max(0, this.drawT - dt);
    const draw = this.drawT / 0.35;

    // launcher swap blend
    if (this.launcherHold > 0) this.launcherHold -= dt;
    const want = this.launcherHold > 0 ? 1 : 0;
    this.launcherBlend += (want - this.launcherBlend) * Math.min(1, dt * (want ? 22 : 9));
    const lb = this.launcherBlend;

    // rifle pose
    const R = this.rifleHolder;
    R.position.set(this.rifleBase.x + bx + sx * 0.2, this.rifleBase.y + by + sy * 0.2 + dip * 0.03 - lb * 0.45 - draw * 0.3, this.rifleBase.z + kz * 0.018);
    R.rotation.set(krx * 0.03 + sy - lb * 0.5 + draw * 0.8, 0.045 + sx + kry * 0.015, -sx * 0.6 + lb * 0.4);
    // reload animation
    if (this.reloadT >= 0) {
      this.reloadT += dt;
      const t = this.reloadT / this.reloadDur;
      const ease = (a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
      const tilt = Math.sin(Math.min(1, t) * Math.PI);
      R.rotation.z += tilt * 0.55;
      R.rotation.x += tilt * 0.22;
      R.position.y -= tilt * 0.04;
      const drop = ease(0.12, 0.35), insert = ease(0.5, 0.72);
      if (t < 0.5) {
        this.mag.position.set(this.magBase.x, this.magBase.y - drop * 0.35, this.magBase.z + drop * 0.05);
        this.mag.rotation.x = drop * 0.4;
        this.mag.visible = drop < 0.98;
        this.leftArmR.position.set(0, -drop * 0.08, drop * 0.18);
      } else {
        this.mag.visible = true;
        this.mag.position.set(this.magBase.x, this.magBase.y - (1 - insert) * 0.22, this.magBase.z + (1 - insert) * 0.04);
        this.mag.rotation.x = (1 - insert) * 0.25;
        this.leftArmR.position.set(0, -(1 - insert) * 0.1, (1 - insert) * 0.24);
      }
      if (t > 0.78 && t < 0.86) R.position.z += 0.015;
      if (t >= 1) { this.reloadT = -1; this.mag.position.copy(this.magBase); this.mag.rotation.x = 0; this.leftArmR.position.set(0, 0, 0); this.mag.visible = true; }
    }
    // launcher pose
    const L = this.launcherHolder;
    L.visible = lb > 0.02;
    L.position.set(this.launcherBase.x + bx + sx * 0.2, this.launcherBase.y - (1 - lb) * 0.55 + by + sy * 0.2, this.launcherBase.z + kz * 0.02);
    L.rotation.set(krx * 0.025 + sy - (1 - lb) * 0.6, 0.06 + sx, -sx * 0.5);

    // flashes
    if (this.flashT > 0) { this.flashT -= dt; this.flash.visible = true; } else this.flash.visible = false;
    if (this.rflashT > 0) { this.rflashT -= dt; this.rflash.visible = true; this.backblast.visible = true; } else { this.rflash.visible = false; this.backblast.visible = false; }

    // brass
    for (const s of this.shells) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.v.y -= 9 * dt;
      s.mesh.position.addScaledVector(s.v, dt);
      s.mesh.rotation.x += s.spin.x * dt; s.mesh.rotation.y += s.spin.y * dt;
      if (s.life <= 0) s.mesh.visible = false;
    }
    this.rig.visible = st.alive;
  }
}
