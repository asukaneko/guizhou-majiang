'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { Room } = require('../server/room.js');
const { OnlineGame } = require('../server/online-game.js');
const { createMahjongServer } = require('../server/index.js');

function player(uid) {
  return { uid, name:uid, ws:{ readyState:1, messages:[], send(raw) { this.messages.push(JSON.parse(raw)); } } };
}
function endedRoom(t, humans = 2, rounds = 3) {
  const people = ['甲','乙','丙','丁'].slice(0, humans).map(player);
  const room = new Room('4321', people[0], { speed:100 });
  people.slice(1).forEach((p) => room.add(p)); while (!room.seats.every(Boolean)) room.addBot();
  room.config.totalRounds = rounds;
  room.game = new OnlineGame({ mode:'classic', dealer:0, totalRounds:rounds, roundNo:1, speed:100 });
  room.game.phase = 'ended'; room.game.scores = [12,-8,-4,0];
  t.after(() => room.abort());
  return { room, people, prepare: (uid, ready = true) => room.setReady(uid, ready, room.game.roundId, room.readyId) };
}

test('准备：三位非房主全部确认后才能换局，重复准备幂等，可取消，start和next共用校验', (t) => {
  const { room, people, prepare } = endedRoom(t, 4);
  const previous = room.game;
  assert.equal(room.allReady(), false);
  assert.match(room.start().err, /未准备/); assert.match(room.nextRound(people[0].uid).err, /未准备/);
  assert.match(prepare(people[0].uid).err, /房主无需/);
  assert.equal(prepare(people[1].uid).ok, true); assert.equal(prepare(people[1].uid).ok, true);
  assert.equal(prepare(people[2].uid).ok, true); assert.equal(room.allReady(), false);
  assert.equal(room.game, previous, '未准备时保留当前结算');
  assert.equal(prepare(people[3].uid).ok, true); assert.equal(room.allReady(), true);
  assert.equal(prepare(people[1].uid, false).ok, true); assert.equal(room.allReady(), false);
  assert.match(room.start().err, /未准备/);
  assert.equal(prepare(people[1].uid).ok, true);
  const oldReadyId = room.readyId;
  assert.equal(room.nextRound(people[0].uid).ok, true);
  assert.notEqual(room.readyId, oldReadyId); assert.equal(room.game.roundNo, 2);
  assert.deepEqual(room.game.scores, [12,-8,-4,0]);
  assert.ok(room.seats.slice(1).every((s) => s.ready === false));
  room.game.settleDraw();
  assert.ok(room.seats.slice(1).every((s) => s.ready === false));
  assert.equal(room.allReady(), false, '下一次结算也需要重新准备');
});

test('准备：首桌可直接开始，机器人自动就绪，人机代打的真人仍需准备；原房新桌同样等待', (t) => {
  const { room, people, prepare } = endedRoom(t, 2, 1);
  room.abort(); room.seats[1].botPlay = true;
  assert.equal(room.start().ok, true, '首次建桌不要求结算准备');
  room.game.settleDraw();
  assert.equal(room.tableFinished(), true);
  assert.deepEqual(room.publicState(people[0].uid).seats.map((s) => s.ready), [true,false,true,true]);
  assert.match(room.newTable(people[0].uid).err, /未准备/);
  assert.equal(prepare(people[1].uid).ok, true);
  assert.equal(room.newTable(people[0].uid).ok, true);
  assert.equal(room.game.roundNo, 1); assert.equal(room.seats[1].ready, false);
});

test('准备：修改玩法局数或难度后重新确认，调速及相同配置保留准备，旧结算和旧配置消息被拒', (t) => {
  const { room, people, prepare } = endedRoom(t, 2, 1);
  const uid = people[1].uid;
  assert.equal(prepare(uid).ok, true);
  let id = room.readyId;
  room.setConfig(people[0].uid, { botSpeed:'fast' }); assert.equal(room.readyId, id); assert.equal(room.allReady(), true);
  room.setConfig(people[0].uid, { mode:'classic' }); assert.equal(room.readyId, id);
  for (const cfg of [{ mode:'yitong' }, { totalRounds:4 }, { aiDifficulty:'hard' }]) {
    const old = room.readyId;
    assert.equal(room.setConfig(people[0].uid, cfg).ok, true);
    assert.notEqual(room.readyId, old); assert.equal(room.allReady(), false);
    assert.match(room.setReady(uid, true, room.game.roundId, old).err, /过期/);
    assert.equal(prepare(uid).ok, true);
  }
  const oldRound = room.game.roundId; id = room.readyId;
  assert.equal(room.newTable(people[0].uid).ok, true); room.game.settleDraw();
  assert.match(room.setReady(uid, true, oldRound, id).err, /过期/);
  assert.equal(room.seats[1].ready, false);
  assert.match(room.setReady(uid, 'true', room.game.roundId, room.readyId).err, /布尔/);
});

test('准备：断线保留已确认状态但阻止开局，房主转移后原房主作为普通玩家准备，离开后机器人补位', (t) => {
  const { room, people, prepare } = endedRoom(t);
  const [host, guest] = people;
  prepare(guest.uid); room.disconnect(guest.uid);
  assert.equal(room.seats[1].ready, true); assert.equal(room.allReady(), false);
  assert.match(room.nextRound(host.uid).err, /重连/);
  room.reconnect(guest); assert.equal(room.allReady(), true);
  room.disconnect(host.uid);
  assert.equal(room.hostUid, guest.uid); assert.equal(room.allReady(), false);
  room.reconnect(host); assert.equal(room.allReady(), false, '原房主恢复为普通玩家后需要确认');
  assert.equal(prepare(host.uid).ok, true); assert.equal(room.allReady(), true);
  room.remove(host.uid); assert.equal(room.seats[0].bot, true); assert.equal(room.allReady(), true);
});

async function client(url) {
  const ws = new WebSocket(url), messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw))); await once(ws, 'open');
  let cursor = 0;
  const c = { ws, send: (m) => ws.send(JSON.stringify(m)) };
  c.next = async (type, predicate = () => true) => {
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      const i = messages.findIndex((m, i) => i >= cursor && m.t === type && predicate(m));
      if (i >= 0) { cursor = i + 1; return messages[i]; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`未收到 ${type}: ${JSON.stringify(messages.slice(-3))}`);
  };
  c.welcome = await c.next('welcome'); return c;
}

test('真实 WS：准备和取消同步两端，房主不能绕过准备，跨房伪造和旧准备消息不改变状态', async (t) => {
  const app = createMahjongServer({ gameOptions:{ speed:100 } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  const url = `ws://127.0.0.1:${app.server.address().port}`;
  const host = await client(url), guest = await client(url), outsider = await client(url);
  host.send({ t:'create', config:{ totalRounds:3 } }); const id = (await host.next('joined')).room.id;
  guest.send({ t:'join', room:id }); await guest.next('joined');
  host.send({ t:'addbot' }); host.send({ t:'addbot' }); await host.next('room', (m) => m.room.full);
  guest.send({ t:'ready', ready:true }); await guest.next('error', (m) => m.err.includes('结算后'));
  host.send({ t:'start' }); await host.next('snapshot', (m) => m.snap.awaiting);
  const room = app.rooms.get(id), old = room.game;
  old.settleDraw(); old.abort(); const ended = (await host.next('room', (m) => !m.room.running && m.room.roundNo === 1)).room;
  const ready = { t:'ready', ready:true, roundId:ended.roundId, readyId:ended.readyId };
  host.send({ t:'next' }); await host.next('error', (m) => m.err.includes('未准备'));
  host.send({ t:'start' }); await host.next('error', (m) => m.err.includes('未准备'));
  outsider.send({ ...ready, uid:guest.welcome.uid, room:id }); await outsider.next('error', (m) => m.err.includes('进房间'));
  assert.equal(room.allReady(), false);
  guest.send(ready);
  for (const c of [host, guest]) {
    const state = (await c.next('room', (m) => m.room.allReady)).room;
    assert.equal(state.seats[1].ready, true);
  }
  guest.send({ ...ready, ready:false }); await host.next('room', (m) => !m.room.allReady);
  host.send({ t:'next' }); await host.next('error', (m) => m.err.includes('未准备'));
  guest.send(ready); await host.next('room', (m) => m.room.allReady);
  host.send({ t:'next' }); await host.next('snapshot', (m) => m.snap.roundNo === 2 && m.snap.phase === 'dealing');
  assert.equal(room.seats[1].ready, false);
  room.game.settleDraw(); room.game.abort(); await host.next('room', (m) => m.room.roundNo === 2 && !m.room.running);
  guest.send(ready); await guest.next('error', (m) => m.err.includes('过期'));
  assert.equal(room.allReady(), false);
});
