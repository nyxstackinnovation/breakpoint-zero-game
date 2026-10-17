import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, QUICK_BOTS } from '../server/rooms.js';
import { MAX_PLAYERS } from '../shared/constants.js';

function fakeConn() {
  const c = { sent: [], room: null, player: null };
  c.send = (m) => c.sent.push(m);
  c.sendBinary = () => {};
  c.last = (t) => [...c.sent].reverse().find((m) => m.t === t);
  return c;
}

test('quick match creates a running public room filled with bots', () => {
  const mgr = new RoomManager();
  const a = fakeConn();
  const room = mgr.quickMatch(a, 'Alice');
  assert.equal(room.isPublic, true);
  assert.equal(room.state, 'game');
  assert.equal(room.bots().length, QUICK_BOTS);
  assert.ok(a.last('map'), 'map was sent');
  assert.equal(a.last('joined').id, a.player.id);
});

test('quick match puts players together and swaps bots out when full', () => {
  const mgr = new RoomManager();
  const conns = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const c = fakeConn();
    mgr.quickMatch(c, `P${i}`);
    conns.push(c);
  }
  const room = conns[0].room;
  assert.ok(conns.every((c) => c.room === room));
  assert.equal(room.humans().length, MAX_PLAYERS);
  assert.equal(room.bots().length, 0);
  assert.equal(room.players.size, MAX_PLAYERS);
  // the ninth player gets a fresh room
  const extra = fakeConn();
  mgr.quickMatch(extra, 'Late');
  assert.notEqual(extra.room, room);
  assert.equal(mgr.rooms.size, 2);
});

test('private rooms: codes, host-only controls, kicking and host migration', () => {
  const mgr = new RoomManager();
  const host = fakeConn(), guest = fakeConn(), third = fakeConn();
  const room = mgr.createPrivate(host, 'Host');
  assert.match(room.code, /^[A-Z2-9]{5}$/);
  assert.equal(room.state, 'lobby');
  mgr.join(guest, 'Guest', room.code.toLowerCase());
  mgr.join(third, 'Third', room.code);
  assert.equal(room.humans().length, 3);
  // guests cannot change settings or start
  room.hostAction(guest.player, { action: 'settings', settings: { map: 'quarry' } });
  assert.equal(room.settings.map, 'skyline');
  assert.match(guest.last('error').msg, /host/i);
  room.hostAction(host.player, { action: 'settings', settings: { map: 'quarry', bots: 2, difficulty: 'hard', rotation: false } });
  assert.deepEqual(room.settings, { map: 'quarry', bots: 2, difficulty: 'hard', rotation: false });
  // kick
  room.hostAction(host.player, { action: 'kick', id: third.player.id });
  assert.ok(third.last('kicked'));
  assert.equal(room.humans().length, 2);
  // start
  room.hostAction(host.player, { action: 'start' });
  assert.equal(room.state, 'game');
  assert.equal(room.game.mapName, 'quarry');
  assert.equal(room.bots().length, 2);
  assert.ok(guest.last('map'));
  // host leaves -> guest becomes host
  mgr.leave(host);
  assert.equal(room.hostId, guest.player.id);
  // back to lobby
  room.hostAction(guest.player, { action: 'lobby' });
  assert.equal(room.state, 'lobby');
  assert.equal(room.bots().length, 0);
  // last human leaves -> room destroyed
  mgr.leave(guest);
  assert.equal(mgr.rooms.has(room.code), false);
});

test('joining an unknown or full room fails cleanly', () => {
  const mgr = new RoomManager();
  const c = fakeConn();
  assert.equal(mgr.join(c, 'X', 'ZZZZZ'), null);
  assert.match(c.last('error').msg, /not found/);
  const host = fakeConn();
  const room = mgr.createPrivate(host, 'H');
  for (let i = 1; i < MAX_PLAYERS; i++) mgr.join(fakeConn(), `G${i}`, room.code);
  const late = fakeConn();
  assert.equal(mgr.join(late, 'Late', room.code), null);
  assert.match(late.last('error').msg, /full/);
});

test('bot count is capped so humans + bots never exceed eight', () => {
  const mgr = new RoomManager();
  const host = fakeConn();
  const room = mgr.createPrivate(host, 'H');
  room.hostAction(host.player, { action: 'settings', settings: { bots: 7 } });
  room.hostAction(host.player, { action: 'start' });
  assert.equal(room.players.size, MAX_PLAYERS);
  const g1 = fakeConn();
  mgr.join(g1, 'G1', room.code);
  assert.equal(room.players.size, MAX_PLAYERS);
  assert.equal(room.bots().length, MAX_PLAYERS - 2);
  // game keeps ticking
  for (let i = 0; i < 120; i++) mgr.update();
  assert.ok(room.game.tick >= 120);
});

test('names are sanitised and made unique', () => {
  const mgr = new RoomManager();
  const a = fakeConn(), b = fakeConn();
  const room = mgr.createPrivate(a, '<b>Ace</b>');
  mgr.join(b, '<b>Ace</b>', room.code);
  assert.equal(a.player.name, 'bAceb');
  assert.notEqual(a.player.name, b.player.name);
});
