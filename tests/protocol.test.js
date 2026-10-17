import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeInputs, decodeInputs, encodeSnapshot, decodeSnapshot, PF } from '../shared/protocol.js';

test('input packets round trip', () => {
  const inputs = [
    { seq: 1, buttons: 0b1010101, yaw: 1.25, pitch: -0.5, renderTick: 1000 },
    { seq: 4294967295, buttons: 255, yaw: -3.1, pitch: 1.5, renderTick: 0 },
  ];
  const out = decodeInputs(Buffer.from(encodeInputs(inputs)));
  assert.equal(out.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(out[i].seq, inputs[i].seq);
    assert.equal(out[i].buttons, inputs[i].buttons);
    assert.ok(Math.abs(out[i].yaw - inputs[i].yaw) < 1e-6);
    assert.ok(Math.abs(out[i].pitch - inputs[i].pitch) < 1e-6);
    assert.equal(out[i].renderTick, inputs[i].renderTick);
  }
});

test('malformed input packets are rejected safely', () => {
  assert.equal(decodeInputs(new Uint8Array([2, 5, 1, 2])), null);
  assert.equal(decodeInputs(new Uint8Array([9])), null);
  const bad = new DataView(encodeInputs([{ seq: 1, buttons: 0, yaw: 0, pitch: 0, renderTick: 0 }]));
  bad.setFloat32(7, NaN, true);
  assert.equal(decodeInputs(bad).length, 0);
});

test('snapshots round trip with sensible precision', () => {
  const snap = {
    tick: 123456,
    players: [{ id: 7, flags: PF.ALIVE | PF.GROUND, x: 12.345, y: 2.5, z: 40.75, vx: 3.21, vy: -9.87, vz: 0.5, yaw: 4.5, pitch: -0.3, health: 87, lastSeq: 999, ammo: 17, rockets: 3, reload: 40, rocketRegen: 100, rocketCd: 12, fireCd: 3, spread: 0.0234 }],
    rockets: [{ id: 65000, owner: 7, x: 1, y: 2, z: 3, vx: 30, vy: -1, vz: 2 }],
  };
  const out = decodeSnapshot(encodeSnapshot(snap));
  assert.equal(out.tick, snap.tick);
  const p = out.players[0], q = snap.players[0];
  assert.equal(p.id, 7);
  assert.equal(p.flags, q.flags);
  assert.ok(Math.abs(p.x - q.x) < 1e-4 && Math.abs(p.z - q.z) < 1e-4);
  assert.ok(Math.abs(p.vy - q.vy) < 0.01);
  assert.ok(Math.abs(p.yaw - q.yaw) < 1e-3);
  assert.ok(Math.abs(p.pitch - q.pitch) < 1e-3);
  assert.equal(p.health, 87);
  assert.equal(p.lastSeq, 999);
  assert.equal(p.ammo, 17);
  assert.equal(p.rockets, 3);
  assert.ok(Math.abs(p.spread - q.spread) < 1e-4);
  assert.equal(out.rockets[0].id, 65000);
  assert.equal(out.rockets[0].owner, 7);
});

test('a full 8-player snapshot stays small', () => {
  const players = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, flags: 1, x: i, y: 2, z: i, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, health: 100, lastSeq: 1, ammo: 30, rockets: 4, reload: 0, rocketRegen: 0, rocketCd: 0, fireCd: 0, spread: 0 }));
  const bytes = encodeSnapshot({ tick: 1, players, rockets: [] }).byteLength;
  assert.ok(bytes < 320, `${bytes} bytes`);
});
