import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWeaponState, stepWeapons, FIRE_TICKS, RELOAD_TICKS, ROCKET_CD_TICKS, ROCKET_REGEN_TICKS, applySpread } from '../shared/weapons.js';
import { BTN, RIFLE, ROCKET } from '../shared/constants.js';

test('rifle fires at 600 rpm while the trigger is held', () => {
  const w = createWeaponState();
  let shots = 0;
  for (let t = 0; t < 60; t++) if (stepWeapons(w, BTN.FIRE) & 1) shots++;
  assert.equal(FIRE_TICKS, 6);
  assert.equal(shots, 10);
  assert.equal(w.ammo, RIFLE.magazine - 10);
});

test('an empty magazine reloads automatically', () => {
  const w = createWeaponState();
  let t = 0;
  while (w.ammo > 0 && t < 1000) { stepWeapons(w, BTN.FIRE); t++; }
  assert.equal(w.ammo, 0);
  assert.equal(w.reload, RELOAD_TICKS);
  for (let i = 0; i < RELOAD_TICKS - 1; i++) assert.equal(stepWeapons(w, BTN.FIRE) & 1, 0);
  // the reload completes and the next round fires on the same tick
  assert.equal(stepWeapons(w, BTN.FIRE) & 1, 1);
  assert.equal(w.ammo, RIFLE.magazine - 1);
});

test('manual reload only when the magazine is not full', () => {
  const w = createWeaponState();
  assert.equal(stepWeapons(w, BTN.RELOAD) & 4, 0);
  stepWeapons(w, BTN.FIRE);
  for (let i = 0; i < FIRE_TICKS; i++) stepWeapons(w, 0);
  assert.equal(stepWeapons(w, BTN.RELOAD) & 4, 4);
});

test('rockets respect cooldown, ammo and regeneration', () => {
  const w = createWeaponState();
  let fired = 0;
  for (let t = 0; t < ROCKET_CD_TICKS * ROCKET.maxAmmo + 5; t++) if (stepWeapons(w, BTN.ROCKET) & 2) fired++;
  // four loaded rockets plus one regenerated during the volley
  assert.equal(fired, ROCKET.maxAmmo + 1);
  assert.equal(w.rockets, 0);
  // holding the button never beats the cooldown
  const w2 = createWeaponState();
  assert.equal(stepWeapons(w2, BTN.ROCKET) & 2, 2);
  for (let t = 1; t < ROCKET_CD_TICKS; t++) assert.equal(stepWeapons(w2, BTN.ROCKET) & 2, 0);
  assert.equal(stepWeapons(w2, BTN.ROCKET) & 2, 2);
  const w3 = createWeaponState();
  w3.rockets = 0;
  for (let t = 0; t < ROCKET_REGEN_TICKS; t++) stepWeapons(w3, 0);
  assert.equal(w3.rockets, 1);
});

test('spread is deterministic and bounded by the cone', () => {
  const dir = [0, 0, -1];
  const a = applySpread(dir, 0.05, 3, 17), b = applySpread(dir, 0.05, 3, 17);
  assert.deepEqual(a, b);
  for (let i = 0; i < 200; i++) {
    const d = applySpread(dir, 0.05, 1, i);
    const ang = Math.acos(-d[2]);
    assert.ok(ang <= 0.0501, `angle ${ang}`);
    assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-9);
  }
});
