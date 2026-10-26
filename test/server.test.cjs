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
