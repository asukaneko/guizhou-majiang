'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { Game } = require('../src/js/game.js');
const AI = require('../src/js/ai.js');
const { OnlineGame } = require('../server/online-game.js');
const { snapshot } = require('../server/serialize.js');
const { createMahjongServer } = require('../server/index.js');

const junk = () => [0, 3, 6, 9, 12, 15, 18, 21, 24, 1, 10, 19, 22, 8];
const waiting = () => [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4];
function game(options = {}) {
  const g = new Game({ dealer: 0, speed: 100, ...options });
  g.phase = 'playing'; g.players[0].hand = junk();
  return g;
}

test('人机代打：未听牌的当前提示也由 AI 接管，保留真人身份', async () => {
  const g = game();
  const pending = g.askDiscard(0, g.selfActions(0));
  assert.equal(g.awaiting.auto, undefined);
  g.setAuto(true);
  const decision = await pending;
  assert.equal(decision.type, 'discard');
  assert.ok(g.players[0].hand.includes(decision.tile));
  assert.equal(g.players[0].isHuman, true);
  assert.equal(g.players[0].botPlay, true);
  g.abort();
});

test('人机代打：关闭尚未执行的代打后交回手动出牌', async () => {
  const g = game({ autoPlay: true });
  const pending = g.askDiscard(0, g.selfActions(0));
  assert.equal(g.awaiting.auto, true);
  g.setAuto(false);
  await Promise.resolve();
  assert.equal(g.awaiting.kind, 'discard');
  assert.equal(g.awaiting.auto, undefined);
  assert.equal(g.humanDiscard(8), true);
  assert.deepEqual(await pending, { type: 'discard', tile: 8 });
  g.abort();
});

test('人机代打：自摸、杠、吃炮、抢杠及已弹出的抢牌提示都可接管', async (t) => {
  const g = game({ autoPlay: true });
  const self = { hu: { name: '胡' }, angang: [], bugang: [] };
  assert.deepEqual(await g.askDiscard(0, self), { type: 'hu' });
  t.mock.method(AI, 'decideSelfGang', () => ({ type: 'angang', tile: 7 }));
  assert.deepEqual(await g.askDiscard(0, { hu: null, angang: [7], bugang: [] }), { type: 'gang', gangType: 'angang', tile: 7 });
  g.players[0].hand = waiting();
  let prompts = 0; g.on('prompt', () => prompts++);
  const claim = await g.resolveClaims(1, 4);
  assert.equal(claim.type, 'hu');
  assert.ok(claim.winners.some((w) => w.p === 0));
  assert.deepEqual(await g.resolveRobKong(1, 4), [{ p: 0, winTile: 4 }]);
  assert.equal(prompts, 0);
  g.setAuto(false);
  const pending = g.resolveClaims(1, 4);
  g.setAuto(true);
  assert.deepEqual((await pending).winners, [{ p: 0, winTile: 4 }], '提示中切换代打只能结算一次胡牌');
  g.setAuto(false);
  const pendingRob = g.resolveRobKong(1, 4);
  g.setAuto(true);
  assert.deepEqual(await pendingRob, [{ p: 0, winTile: 4 }], '抢杠提示中切换代打只计一个赢家');
  g.abort();
});

test('联机代打：按座位切换，校验参数，快照同步本人状态并可恢复手动', async () => {
  const g = new OnlineGame({ dealer: 0, speed: 100, seats: [0, 1, 2, 3].map(() => ({ type: 'human' })) });
  g.phase = 'playing'; g.players[1].hand = junk();
  const pending = g.askDiscard(1, g.selfActions(1));
  assert.equal(g.remoteAction(1, { type: 'autoplay', enabled: 'true' }).ok, false);
  assert.ok(g.prompts.has(1));
  assert.equal(g.remoteAction(1, { type: 'autoplay', enabled: true }).ok, true);
  assert.equal((await pending).type, 'discard');
  assert.equal(snapshot(g, 1).autoPlay, true);
  assert.equal(snapshot(g, 0).autoPlay, false);
  assert.equal(snapshot(g, 1).players[0].isHuman, true);
  assert.equal(g.remoteAction(1, { type: 'autoplay', enabled: false }).ok, true);
  const manual = g.askDiscard(1, g.selfActions(1));
  assert.ok(g.prompts.has(1));
  g.remoteAction(1, { type: 'discard', tile: 8 });
  assert.equal((await manual).tile, 8);
  g.abort();
});

test('联机代打：开启时完成当前抢牌，后续碰杠胡和抢杠自动处理', async () => {
  const g = new OnlineGame({ dealer: 0, speed: 100, seats: [0, 1, 2, 3].map(() => ({ type: 'human' })) });
  g.phase = 'playing'; g.players[1].hand = waiting();
  const pending = g.askClaim(4, 0, { p: 1, acts: ['hu'], rob: true });
  g.remoteAction(1, { type: 'autoplay', enabled: true });
  assert.equal(await pending, 'hu');
  assert.equal(g.prompts.size, 0);
  assert.equal((await g.resolveClaims(0, 4)).winners[0].p, 1);
  assert.deepEqual(await g.resolveRobKong(0, 4), [{ p: 1, winTile: 4 }]);
  g.abort();
});

test('真实 WS：开启服务端代打后连续两局无需客户端出牌，换局保留设置', { timeout: 15000 }, async (t) => {
  const app = createMahjongServer({ gameOptions: { speed: 100 } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}`);
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  let cursor = 0;
  async function next(type, predicate = () => true) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const idx = messages.findIndex((m, i) => i >= cursor && m.t === type && predicate(m));
      if (idx >= 0) { cursor = idx + 1; return messages[idx]; }
      assert.equal(messages.find((m) => m.t === 'error'), undefined);
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`未收到 ${type}`);
  }
  const send = (m) => ws.send(JSON.stringify(m));
  await next('welcome');
  send({ t: 'create', config: { totalRounds: 2 } }); await next('joined');
  for (let i = 0; i < 3; i++) send({ t: 'addbot' });
  await next('room', (m) => m.room.full);
  send({ t: 'start' }); await next('snapshot', (m) => m.snap.awaiting);
  send({ t: 'action', action: { type: 'autoplay', enabled: true } });
  const first = (await next('snapshot', (m) => m.snap.result)).snap;
  assert.equal(first.players[0].isHuman, true);
  assert.equal(first.autoPlay, true);
  send({ t: 'next' });
  const opening = (await next('snapshot', (m) => m.snap.roundNo === 2)).snap;
  assert.equal(opening.autoPlay, true);
  const second = (await next('snapshot', (m) => m.snap.roundNo === 2 && m.snap.result)).snap;
  assert.equal(second.scores.reduce((a, b) => a + b, 0), 0);
  send({ t: 'action', action: { type: 'autoplay', enabled: false } });
  await next('snapshot', (m) => !m.snap.autoPlay);
  assert.equal(messages.filter((m) => m.t === 'error').length, 0);
});
