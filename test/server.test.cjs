'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createMahjongServer } = require('../server/index.js');
const { Room } = require('../server/room.js');
const { OnlineGame } = require('../server/online-game.js');
const { snapshot } = require('../server/serialize.js');
const R = require('../src/js/rules.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fake(name = '房主') {
  return { uid: name, name, ws: { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } } };
}
function game(mode = 'classic') {
  const g = new OnlineGame({ mode, dealer: 0, speed: 100, seats: [0, 1, 2, 3].map(() => ({ type: 'human' })) });
  g.phase = 'playing';
  return g;
}
async function server(t, options) {
  const app = createMahjongServer(options);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  app.url = `ws://127.0.0.1:${app.server.address().port}`;
  return app;
}
async function client(app) {
  const ws = new WebSocket(app.url);
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  const c = { ws, messages, cursor: 0, send: (data) => ws.send(JSON.stringify(data)) };
  c.wait = async (type, predicate = () => true) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const idx = messages.findIndex((m, i) => i >= c.cursor && m.t === type && predicate(m));
      if (idx >= 0) { c.cursor = idx + 1; return messages[idx]; }
      await sleep(5);
    }
    assert.fail(`未收到 ${type}: ${JSON.stringify(messages.slice(-4))}`);
  };
  c.welcome = await c.wait('welcome');
  return c;
}

test('真实 WS：进房失败和非法建房保留原房间；重复加入同房间不退出', async (t) => {
  const app = await server(t);
  const host = await client(app);
  host.send({ t: 'create' });
  const { room } = await host.wait('joined');
  host.send({ t: 'join', room: '不存在' });
  await host.wait('error');
  assert.equal(app.players.get(host.welcome.uid).room.id, room.id);
  host.send({ t: 'create', config: { mode: '__proto__', totalRounds: 1 } });
  await host.wait('error');
  assert.equal(app.rooms.size, 1);
  host.send({ t: 'join', room: room.id });
  assert.equal((await host.wait('joined')).room.id, room.id);
  assert.equal(app.rooms.get(room.id).humans().length, 1);
  host.send({ t: 'addbot' });
  const state = (await host.wait('room', (m) => m.room.seats.some((s) => s.bot))).room;
  const bot = state.seats.find((s) => s.bot);
  assert.ok(bot.uid);
  host.send({ t: 'removebot', uid: bot.uid });
  await host.wait('room', (m) => !m.room.seats.some((s) => s.bot));
});

test('真实 WS：掉线保留原座位、房主转移、凭会话恢复同一局', async (t) => {
  const app = await server(t);
  const a = await client(app), b = await client(app);
  a.send({ t: 'create' });
  const id = (await a.wait('joined')).room.id;
  b.send({ t: 'join', room: id }); await b.wait('joined');
  a.send({ t: 'addbot' }); a.send({ t: 'addbot' });
  await a.wait('room', (m) => m.room.full);
  a.send({ t: 'start' }); await a.wait('snapshot', (m) => m.snap.phase === 'playing');
  const room = app.rooms.get(id), original = room.game;
  a.ws.terminate();
  await b.wait('room', (m) => m.room.seats[0].offline);
  assert.equal(room.seatOf(a.welcome.uid), 0);
  assert.equal(room.game.players[0].isHuman, false);
  assert.equal(room.hostUid, b.welcome.uid);
  const c = await client(app);
  c.send({ t: 'join', room: id }); await c.wait('error', (m) => m.err.includes('对局中'));
  const restored = await client(app);
  restored.send({ t: 'resume', token: a.welcome.resumeToken });
  assert.equal((await restored.wait('resumed')).uid, a.welcome.uid);
  const state = (await restored.wait('joined')).room;
  assert.equal(state.seats[0].you, true);
  assert.equal(state.seats[0].offline, false);
  const snap = (await restored.wait('snapshot')).snap;
  assert.equal(snap.players[0].isHuman, true);
  assert.equal(room.game, original);
  assert.equal(snap.players[0].hand.length, original.players[0].hand.length);
  assert.ok(snap.players.slice(1).every((p) => p.hand.length === 0));
});

test('真实 WS：旧连接关闭不踢走恢复的新连接；会话过期清理房间', async (t) => {
  const app = await server(t, { reconnectGrace: 60 });
  const a = await client(app);
  a.send({ t: 'create' }); const id = (await a.wait('joined')).room.id;
  const b = await client(app);
  b.send({ t: 'resume', token: a.welcome.resumeToken });
  await b.wait('joined');
  await sleep(90);
  assert.ok(app.rooms.has(id));
  assert.equal(app.rooms.get(id).seats[0].ws.readyState, 1);
  b.ws.terminate();
  await sleep(120);
  assert.equal(app.rooms.has(id), false);
  const c = await client(app);
  c.send({ t: 'resume', token: a.welcome.resumeToken });
  await c.wait('resume-failed');
});

test('真实 WS：心跳检测半断开连接，代打并在宽限期后清理', async (t) => {
  const app = await server(t, { heartbeatInterval: 40, reconnectGrace: 40 });
  const ws = new WebSocket(app.url, { autoPong: false });
  await once(ws, 'open');
  await once(ws, 'close');
  await sleep(80);
  assert.equal(app.players.size, 0);
});

test('HTTP：坏 URL 不导致进程退出，路径穿越被拒，网页及脚本可读取', async (t) => {
  const app = await server(t);
  const request = (url) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: app.server.address().port, path: url }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  assert.equal(await request('/%E0%A4%A'), 400);
  assert.equal(await request('/../src-extra/secret'), 403);
  assert.equal(await request('/'), 200);
  assert.equal(await request('/js/viewport.js'), 200);
  const c = await client(app);
  c.ws.send('null'); await c.wait('error');
  c.send({ t: 'ping' }); await c.wait('pong');
});

test('换局：start 与 next 都受总局数限制，机器人可在局间移除', () => {
  const host = fake(), room = new Room('6001', host);
  room.addBot(); room.addBot(); room.addBot();
  room.config.totalRounds = 2;
  room.game = game();
  room.game.phase = 'ended'; room.game.roundNo = 2;
  assert.match(room.start().err, /已打满/);
  assert.match(room.nextRound(host.uid).err, /已打满/);
  const botUid = room.seats[1].uid;
  assert.equal(room.removeBot(botUid).ok, true);
  room.abort();
});

test('真实 WS：原房配置新桌继承累计分，移除机器人立即广播并沿用房号和座位', async (t) => {
  const app = await server(t, { gameOptions: { speed: 100 } });
  const host = await client(app), guest = await client(app);
  host.send({ t: 'create', config: { mode: 'classic', totalRounds: 1 } });
  const id = (await host.wait('joined')).room.id;
  guest.send({ t: 'join', room: id }); await guest.wait('joined');
  host.send({ t: 'newtable' }); await host.wait('error', (m) => m.err.includes('还没打完'));
  host.send({ t: 'addbot' }); host.send({ t: 'addbot' });
  const seats = (await host.wait('room', (m) => m.room.full)).room.seats;
  host.send({ t: 'start' });
  await host.wait('snapshot', (m) => m.snap.awaiting);
  const room = app.rooms.get(id), previous = room.game;
  host.send({ t: 'newtable' }); await host.wait('error', (m) => m.err.includes('已经开始'));
  guest.send({ t: 'newtable' }); await guest.wait('error', (m) => m.err.includes('只有房主'));

  previous.scores = [12, -12, 0, 0];
  previous.settleDraw(); previous.abort();
  await host.wait('room', (m) => m.room.finished);
  host.send({ t: 'removebot', uid: seats[2].uid });
  for (const c of [host, guest]) {
    const state = (await c.wait('room', (m) => m.room.finished && !m.room.seats[2].uid)).room;
    assert.equal(state.full, false);
  }
  host.send({ t: 'config', config: { mode: 'yitong', totalRounds: 4 } });
  const configured = (await host.wait('room', (m) => m.room.config.mode === 'yitong')).room;
  assert.equal(configured.finished, true, '增加新桌局数也不能延长已结束的上一桌');
  assert.equal(configured.totalRounds, 1);
  assert.equal(configured.config.totalRounds, 4);
  host.send({ t: 'next' }); await host.wait('error', (m) => m.err.includes('已打满'));
  host.send({ t: 'start' }); await host.wait('error', (m) => m.err.includes('已打满'));
  host.send({ t: 'newtable' }); await host.wait('error', (m) => m.err.includes('空位'));
  assert.equal(room.game, previous, '开桌校验失败保留上一桌结算');
  assert.deepEqual(room.game.scores, [12, -12, 0, 0]);
  host.send({ t: 'addbot' }); await host.wait('room', (m) => m.room.full);
  guest.send({ t: 'ready', ready: true, roundId: room.game.roundId, readyId: room.readyId });
  await host.wait('room', (m) => m.room.allReady);
  host.send({ t: 'newtable' });
  for (const c of [host, guest]) {
    const opening = (await c.wait('snapshot', (m) => m.snap.roundId !== previous.roundId && m.snap.phase === 'dealing')).snap;
    assert.equal(opening.roomId, id);
    assert.equal(opening.roundNo, 1);
    assert.equal(opening.totalRounds, 4);
    assert.equal(opening.mode, 'yitong');
    assert.deepEqual(opening.scores, c === host ? [12, -12, 0, 0] : [-12, 0, 0, 12]);
    assert.equal(opening.result, null);
    const state = (await c.wait('room', (m) => m.room.running)).room;
    assert.equal(state.finished, false);
    assert.equal(state.seats[0].uid, seats[0].uid);
    assert.equal(state.seats[1].uid, seats[1].uid);
    assert.equal(state.seats[3].uid, seats[3].uid);
    assert.notEqual(state.seats[2].uid, seats[2].uid);
  }
  assert.equal(room.game.dealer, 0);
  assert.equal(room.hostUid, host.welcome.uid);
  assert.equal(previous.prompts.size, 0);
  host.send({ t: 'newtable' }); await host.wait('error', (m) => m.err.includes('已经开始'));
  room.game.abort();
  room.game.roundNo = room.game.totalRounds;
  room.game.scores = [20, -8, -4, -8];
  room.broadcastRoom();
  await guest.wait('room', (m) => m.room.finished);
  host.send({ t: 'leave' }); await host.wait('left');
  const transferred = (await guest.wait('room', (m) => m.room.host)).room;
  assert.equal(transferred.resetScoresOnNewTable, true);
  assert.deepEqual(transferred.standings, [20, -8, -4, -8], '房主退房后仍保留当前桌的结算');
  guest.send({ t: 'newtable' });
  const fresh = (await guest.wait('snapshot', (m) => m.snap.phase === 'dealing')).snap;
  assert.deepEqual(fresh.scores, [0, 0, 0, 0], '房主主动退房后下一桌重新计分');
  assert.equal(fresh.roomId, id);
  assert.equal(room.resetScoresOnNewTable, false);
});

test('跨桌累计分：断线恢复、会话过期及普通玩家退房保留，房主主动退房后下一桌重新计分', (t) => {
  for (const scenario of ['reconnect', 'expire', 'guest-leave', 'host-leave']) {
    const host = fake('甲'), guest = fake('乙');
    const room = new Room('7001', host, { speed: 100 });
    t.after(() => room.abort());
    room.add(guest); room.addBot(); room.addBot();
    room.config.totalRounds = 1;
    room.game = game();
    room.game.phase = 'ended'; room.game.roundNo = 1; room.game.totalRounds = 1;
    room.game.scores = [12, -7, -3, -2];
    if (scenario === 'reconnect' || scenario === 'expire') {
      room.disconnect(host.uid);
      if (scenario === 'reconnect') room.reconnect(host);
      else room.remove(host.uid);
    } else if (scenario === 'guest-leave') room.remove(guest.uid, true);
    else room.remove(host.uid, true);
    assert.equal(room.resetScoresOnNewTable, scenario === 'host-leave', scenario);
    for (const seat of room.seats) if (seat && !seat.bot && !room.isHost(seat.uid)) {
      assert.equal(room.setReady(seat.uid, true, room.game.roundId, room.readyId).ok, true);
    }
    assert.equal(room.newTable(room.hostUid).ok, true, scenario);
    assert.deepEqual(room.game.scores, scenario === 'host-leave' ? [0, 0, 0, 0] : [12, -7, -3, -2], scenario);
  }
});

test('快照特效：四家按视角收到一次；单人 sync 不消费待广播特效', () => {
  const clients = [fake('甲'), fake('乙'), fake('丙'), fake('丁')];
  const room = new Room('6002', clients[0]); clients.slice(1).forEach((c) => room.add(c));
  room.game = game();
  room.pushFx({ type: 'discard', p: 1, tile: 3 });
  room.sendSnapshotTo(0);
  assert.deepEqual(clients[0].ws.sent.at(-1).fx, []);
  room.broadcastGame();
  clients.forEach((c, i) => assert.deepEqual(c.ws.sent.at(-1).fx, [{ type: 'discard', p: (1 - i + 4) % 4, tile: 3 }]));
  room.broadcastGame();
  clients.forEach((c) => assert.deepEqual(c.ws.sent.at(-1).fx, []));
});

test('非法杠和过期提示不能变更状态；掉线、超时能胡时自动胡', async () => {
  const g = game();
  g.players[0].hand = [0, 1, 2, 3, 4, 5, 18, 19, 20, 18, 19, 20, 17, 17];
  const pending = g.waitRemoteDiscard(0, g.selfActions(0));
  const id = g.prompts.get(0).id;
  assert.equal(g.remoteAction(0, { type: 'gang', gangType: 'minggang', tile: 0 }).ok, false);
  assert.equal(g.remoteAction(0, { type: 'discard', tile: 0, promptId: 'old' }).ok, false);
  assert.equal(g.prompts.get(0).id, id);
  g.dropPrompt(0);
  assert.equal((await pending).type, 'hu');
  g.discardTimeout = 5;
  assert.equal((await g.waitRemoteDiscard(0, g.selfActions(0))).type, 'hu');
  g.abort();
});

test('多房间模式隔离：交替创建后，胡牌、叫牌、结算仍使用各房规则', () => {
  const soft = [0, 1, 2, 3, 4, 5, 18, 19, 20, 22, 23, 18, 17, 17];
  const yitong = game('yitong'), classic = game('classic');
  yitong.players[0].hand = soft.slice(); classic.players[0].hand = soft.slice();
  assert.ok(yitong.selfActions(0).hu);
  assert.equal(classic.selfActions(0).hu, null);
  R.setMode('yitong');
  assert.equal(classic.selfActions(0).hu, null);
  yitong.settleWin([{ p: 0, winTile: 18 }], { selfDraw: true });
  assert.equal(yitong.result.winners[0].hard, false);
  const waiting = soft.filter((_, i) => i !== 11);
  classic.players[0].hand = waiting;
  assert.deepEqual(classic.tingOf(0)?.tiles || [], R.tenpaiTiles(waiting, [], 'classic'));
  R.setMode('classic');
});

test('掉线报听玩家仍摸打锁牌；AI 出牌前恢复连接立即交回真人', async () => {
  const g = game();
  g.players[0].hand = [0, 1, 2, 3, 4, 5, 18, 19, 20, 18, 19, 20, 17, 26];
  g.players[0].justDrawn = 26;
  g.players[0].tingDeclared = true;
  g.players[0].isHuman = false;
  g.aiDiscard = () => { throw new Error('报听后不能让 AI 改手牌'); };
  assert.deepEqual(await g.askDiscard(0, {}), { type: 'discard', tile: 26 });
  g.players[0].tingDeclared = false;
  let finishDelay;
  g.delay = () => new Promise((resolve) => { finishDelay = resolve; });
  const pending = g.askDiscard(0, {});
  g.players[0].isHuman = true; finishDelay();
  await Promise.resolve();
  assert.equal(g.prompts.get(0).kind, 'discard');
  g.remoteAction(0, { type: 'discard', tile: 26 });
  assert.deepEqual(await pending, { type: 'discard', tile: 26 });
  g.abort();
});

test('暗杠信息从牌面字段、特效和旁白隐藏；终止后不再增加抢牌提示', async () => {
  const g = game();
  g.players[1].hand = [7, 7, 7, 7];
  const calls = [], notes = [];
  g.on('call', (e) => calls.push(e)); g.on('message', (e) => notes.push(e));
  await g.doKong(1, 'angang', 7);
  const snap = snapshot(g, 0);
  assert.equal(snap.players[1].melds[0].tile, null);
  assert.deepEqual(snap.players[1].melds[0].tiles, []);
  assert.ok(notes.every((n) => !n.includes(R.tileName(7))));
  const room = new Room('6003', fake());
  assert.equal(room.rotateFx(0, [{ type: 'call', ...calls[0] }])[0].tile, null);
  g.players[0].hand = [0, 0]; g.players[2].hand = [0, 0];
  const claims = g.resolveClaims(3, 0);
  g.abort(); await claims;
  assert.equal(g.prompts.size, 0);
});

test('在线人数：welcome 首推、连接/断开/恢复广播 stats', async (t) => {
  const app = await server(t);
  const a = await client(app);
  assert.equal(a.welcome.online, 1, 'welcome 首推在线人数');
  assert.equal(a.welcome.rooms, 0);
  const firstStats = await a.wait('stats');
  assert.deepEqual(firstStats, { t: 'stats', online: 1, rooms: 0 });

  const b = await client(app);
  const joined = await a.wait('stats');
  assert.equal(joined.online, 2);

  // b 断开后有 60s 宽限期，但 ws 已不在 → online 应回落
  b.ws.close();
  const afterClose = await a.wait('stats', (m) => m.online === 1);
  assert.equal(afterClose.online, 1);

  // resume：新建连接恢复 b 的会话，online 回到 2
  const b2 = new WebSocket(app.url);
  const b2msgs = [];
  b2.on('message', (raw) => b2msgs.push(JSON.parse(raw.toString())));
  await once(b2, 'open');
  b2.send(JSON.stringify({ t: 'resume', token: b.welcome.resumeToken }));
  const resumed = await (async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const m = b2msgs.find((x) => x.t === 'resumed');
      if (m) return m;
      await sleep(5);
    }
    assert.fail('未收到 resumed');
  })();
  assert.equal(resumed.uid, b.welcome.uid);
  await a.wait('stats', (m) => m.online === 2);
  b2.close(); a.ws.close();
});

test('HTTP /stats 返回在线人数与房间数（无需 WS 会话）', async (t) => {
  const app = await server(t);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const res = await fetch(base + '/stats');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { online: 0, rooms: 0 });
  const c = await client(app);
  c.send({ t: 'create' });
  await c.wait('joined');
  const res2 = await fetch(base + '/stats');
  assert.deepEqual(await res2.json(), { online: 1, rooms: 1 });
  c.ws.close();
});

test('房间内改名：hello 更新本人座位并广播给同桌', async (t) => {
  const app = await server(t);
  const host = await client(app);
  host.send({ t: 'create' });
  const { room } = await host.wait('joined');
  const guest = await client(app);
  guest.send({ t: 'join', room: room.id });
  await guest.wait('joined');
  host.send({ t: 'hello', name: '新昵称' });
  await host.wait('hello-ok', (m) => m.name === '新昵称');
  const update = await guest.wait('room', (m) => m.room.seats.some((s) => s.uid === host.welcome.uid && s.name === '新昵称'));
  assert.equal(update.room.seats.find((s) => s.uid === host.welcome.uid).name, '新昵称');
  assert.equal(app.rooms.get(room.id).game, null);
  host.ws.close(); guest.ws.close();
});
