'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const AI = require('../src/js/ai.js');
const { Game } = require('../src/js/game.js');
const { Room } = require('../server/room.js');
const { createMahjongServer } = require('../server/index.js');
const junk = () => [0, 3, 6, 9, 12, 15, 18, 21, 24, 1, 10, 19, 22, 8];
const fake = (uid) => ({ uid, name: uid, ws: { readyState: 1, send() {} } });

test('人机难度：简单基础评分、普通当前策略、困难扩大搜索，实际选择有差异且出牌合法稳定', () => {
  const hand = junk(), original = hand.slice();
  const rows = Object.fromEntries(Object.keys(AI.DIFFICULTIES).map((difficulty) => [difficulty, AI.analyzeDiscards(hand, [], 'classic', { difficulty })]));
  assert.ok(rows.easy.every((r) => r.future === 0));
  assert.equal(rows.normal.filter((r) => r.future > 0).length, 3);
  assert.equal(rows.hard.filter((r) => r.future > 0).length, 5);
  assert.notEqual(rows.easy[0].tile, rows.normal[0].tile);
  assert.notEqual(rows.normal[0].tile, rows.hard[0].tile);
  for (const difficulty of Object.keys(AI.DIFFICULTIES)) {
    assert.ok(hand.includes(rows[difficulty][0].tile));
    assert.equal(AI.chooseDiscard(hand, [], 'classic', { difficulty }), rows[difficulty][0].tile);
  }
  assert.equal(AI.chooseDiscard(hand, [], 'classic'), rows.normal[0].tile, '默认普通保留已有选择');
  assert.deepEqual(hand, original);
});

test('不同难度仍遵守胡牌、报听锁牌和财神禁碰杠；碰杠策略有区分', async () => {
  const seven = { hand: [0, 0, 9, 9, 11, 11, 13, 13, 18, 18, 20, 20, 22], melds: [] };
  assert.equal(AI.decideClaim(['peng'], seven, 0, 'classic', { difficulty: 'easy' }), 'peng');
  assert.equal(AI.decideClaim(['peng'], seven, 0, 'classic', { difficulty: 'hard' }), null);
  for (const difficulty of Object.keys(AI.DIFFICULTIES)) {
    const g = new Game({ dealer: 0, speed: 100, aiDifficulty: difficulty });
    g.phase = 'playing'; g.players[0].hand = junk(); g.players[0].justDrawn = 8; g.players[0].tingDeclared = true;
    assert.equal(g.aiContext(0).difficulty, difficulty);
    assert.deepEqual(await g.askDiscard(0, {}), { type: 'discard', tile: 8 });
    assert.equal(AI.decideClaim(['hu', 'peng'], seven, 0, 'classic', { difficulty }), 'hu');
    assert.equal(AI.decideClaim(['peng'], { ...seven, tingDeclared: true }, 0, 'classic', { difficulty }), null);
    assert.equal(AI.decideClaim(['peng', 'gang'], { hand: [18, 18, 18], melds: [] }, 18, 'yitong', { difficulty }), null);
    g.abort();
  }
});

test('房间配置：严格校验难度和速度，拒绝非房主及混合非法修改', () => {
  const host = fake('甲'), guest = fake('乙'), room = new Room('1234', host);
  room.add(guest);
  const initial = { ...room.config };
  for (const invalid of ['__proto__', '', null, 1, ['hard'], {}]) {
    assert.equal(room.setConfig(host.uid, { aiDifficulty: invalid, botSpeed: 'fast' }).ok, false);
    assert.equal(room.setConfig(host.uid, { aiDifficulty: 'hard', botSpeed: invalid }).ok, false);
    assert.deepEqual(room.config, initial);
  }
  assert.equal(room.setConfig(guest.uid, { botSpeed: 'fast' }).ok, false);
  assert.equal(room.setConfig(host.uid, { aiDifficulty: 'hard', botSpeed: 'slow' }).ok, true);
  assert.equal(new Game({ aiDifficulty: ['hard'], botSpeed: ['fast'] }).aiDifficulty, 'normal');
});

async function client(url) {
  const ws = new WebSocket(url), messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  await once(ws, 'open');
  let cursor = 0;
  const c = { ws, send: (m) => ws.send(JSON.stringify(m)) };
  c.next = async (type, predicate = () => true) => {
    const end = Date.now() + 3500;
    while (Date.now() < end) {
      const i = messages.findIndex((m, i) => i >= cursor && m.t === type && predicate(m));
      if (i >= 0) { cursor = i + 1; return messages[i]; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`未收到 ${type}: ${JSON.stringify(messages.slice(-3))}`);
  };
  c.welcome = await c.next('welcome'); return c;
}

test('真实 WS：房主开局选难度，局中调速同步两端且不变更待办，重连和跨桌保留', async (t) => {
  const app = createMahjongServer(); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close()); const url = `ws://127.0.0.1:${app.server.address().port}`;
  const host = await client(url), guest = await client(url);
  host.send({ t: 'create', config: { mode: 'classic', totalRounds: 1, aiDifficulty: 'easy', botSpeed: 'slow' } });
  const initial = (await host.next('joined')).room;
  guest.send({ t: 'join', room: initial.id }); await guest.next('joined');
  host.send({ t: 'addbot' }); host.send({ t: 'addbot' }); await host.next('room', (m) => m.room.full);
  host.send({ t: 'start' }); const opening = (await host.next('snapshot', (m) => m.snap.awaiting)).snap;
  assert.equal(opening.aiDifficulty, 'easy'); assert.equal(opening.botSpeed, 'slow');
  const room = app.rooms.get(initial.id), game = room.game, pending = game.prompts.get(0);
  assert.equal(game.speed, AI.BOT_SPEEDS.slow.value);
  host.send({ t: 'config', config: { botSpeed: 'fast' } });
  for (const c of [host, guest]) {
    const state = (await c.next('room', (m) => m.room.config.botSpeed === 'fast')).room;
    assert.equal(state.config.aiDifficulty, 'easy');
    assert.equal((await c.next('snapshot', (m) => m.snap.botSpeed === 'fast')).snap.aiDifficulty, 'easy');
  }
  assert.equal(game.speed, AI.BOT_SPEEDS.fast.value);
  assert.equal(game.prompts.get(0), pending); assert.equal(game.discardTimeout, 60000);
  guest.send({ t: 'config', config: { botSpeed: 'slow' } }); await guest.next('error', (m) => m.err.includes('房主'));
  host.send({ t: 'config', config: { aiDifficulty: 'hard', botSpeed: 'slow' } }); await host.next('error', (m) => m.err.includes('对局中'));
  assert.equal(game.aiDifficulty, 'easy'); assert.equal(game.botSpeed, 'fast');
  game.abort(); game.roundNo = game.totalRounds; room.broadcastRoom();
  await guest.next('room', (m) => m.room.finished);
  host.ws.terminate(); await guest.next('room', (m) => m.room.seats[0].offline);
  const resumed = await client(url); resumed.send({ t: 'resume', token: host.welcome.resumeToken });
  const restored = (await resumed.next('joined')).room;
  assert.equal(restored.config.aiDifficulty, 'easy'); assert.equal(restored.config.botSpeed, 'fast');
  await guest.next('room', (m) => !m.room.seats[0].offline);
  guest.send({ t: 'config', config: { aiDifficulty: 'hard' } }); await guest.next('room', (m) => m.room.config.aiDifficulty === 'hard');
  resumed.send({ t: 'ready', ready: true, roundId: room.game.roundId, readyId: room.readyId });
  await guest.next('room', (m) => m.room.allReady);
  guest.send({ t: 'newtable' }); const fresh = (await guest.next('snapshot', (m) => m.snap.phase === 'dealing')).snap;
  assert.equal(fresh.aiDifficulty, 'hard'); assert.equal(fresh.botSpeed, 'fast'); assert.equal(fresh.roundNo, 1);
  assert.equal(room.game.speed, AI.BOT_SPEEDS.fast.value);
});

test('六种组合完整对局：三档难度分别运行经典和幺筒，均可结束且分数零和', async () => {
  for (const mode of ['classic', 'yitong']) for (const aiDifficulty of Object.keys(AI.DIFFICULTIES)) {
    const game = new Game({ mode, aiDifficulty, speed: 100, dealer: 0 });
    game.players.forEach((p) => { p.isHuman = false; });
    const done = new Promise((resolve, reject) => { game.on('roundEnd', resolve); game.on('error', reject); });
    game.startRound(); const result = await done;
    assert.equal(game.phase, 'ended', `${mode}/${aiDifficulty}`);
    assert.equal(result.scores.reduce((a, b) => a + b, 0), 0);
    assert.equal(result.deltas.reduce((a, b) => a + b, 0), 0);
    game.abort();
  }
});
