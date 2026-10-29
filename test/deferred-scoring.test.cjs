'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/js/rules.js');
const { Game } = require('../src/js/game.js');
const { snapshot } = require('../server/serialize.js');

const ping = () => [0,1,2,3,4,5,6,7,8,9,10,11,22,22];
const junk = () => [0,3,6,9,12,15,18,21,24,1,10,19,22];
const ready10 = () => [3,4,5,12,13,14,18,19,20,22];
const junk10 = () => [2,5,8,10,13,16,19,21,24,26];
const zeros = () => [0,0,0,0];
const rotate = (arr, seat) => arr.slice(seat).concat(arr.slice(0, seat));
const zeroSum = (arr) => assert.equal(arr.reduce((a, b) => a + b, 0), 0);
const make = (mode = 'classic') => {
  const g = new Game({ mode, dealer:0, speed:100 });
  g.phase = 'playing'; g.players.forEach((p) => { p.hand = junk(); });
  return g;
};
async function kong(g, type, ready) {
  const p = g.players[0];
  p.hand = (ready ? ready10() : junk10()).concat(new Array(type === 'angang' ? 4 : type === 'minggang' ? 3 : 1).fill(0));
  if (type === 'bugang') p.melds = [{ type:'peng', tile:0, tiles:[0,0,0] }];
  assert.equal(await g.doKong(0, type, 0, 3), true);
  assert.deepEqual(g.scores, zeros());
  assert.deepEqual(g.roundDeltas, zeros());
}
function finish(g) {
  g.players[1].hand = ping();
  g.players[2].hand = ping().slice(0, -1);
  const res = g.settleWin([{ p:1, winTile:22 }], { selfDraw:true });
  zeroSum(res.scores); zeroSum(res.deltas);
  return res;
}

test('胡牌时：听牌的明杠向原放杠者收4，暗杠和补杠向三家各收4；两种模式一致', async () => {
  for (const mode of ['classic','yitong']) for (const type of ['minggang','angang','bugang']) {
    const g = make(mode); await kong(g, type, true);
    const res = finish(g);
    assert.equal(res.isTing[0], true, `${mode}/${type}`);
    assert.equal(g.players[0].tingDeclared, false, '自然听牌即可，不要求报听');
    const expected = type === 'minggang' ? [4,0,0,-4] : [12,-4,-4,-4];
    assert.deepEqual(res.kongDeltas, expected);
    assert.deepEqual(res.kongLog[0].deltas, expected);
    assert.equal(res.kongLog[0].settled, true);
    assert.equal(res.kongLog[0].reversed, false);
    assert.equal(res.kongLog[0].voided, false);
    const scores = g.scores.slice();
    assert.equal(g.settleWin([{ p:1, winTile:22 }], { selfDraw:true }), undefined);
    assert.equal(g.settleDraw(), undefined);
    assert.deepEqual(g.scores, scores, '重复结算不重复收款');
  }
});

test('胡牌时：未听者每种杠均向每位听牌者赔4，非胡家也收分，其他未听者不收', async () => {
  for (const mode of ['classic','yitong']) for (const type of ['minggang','angang','bugang']) {
    const g = make(mode); await kong(g, type, false);
    const res = finish(g);
    assert.deepEqual(res.isTing, [false,true,true,false], `${mode}/${type}`);
    assert.deepEqual(res.kongDeltas, [-8,4,4,0], '暗杠也按每家4分，不能将原三家12分逐家反赔');
    assert.equal(res.kongLog[0].reversed, true);
  }
});

test('多个杠：未听者有两个暗杠时向三位听牌者各赔8分', async () => {
  const g = make();
  g.players[0].hand = [0,0,0,0,8,8,8,2,5,10,13,16,21,26];
  await g.doKong(0, 'angang', 0);
  g.players[0].hand.push(8);
  await g.doKong(0, 'angang', 8);
  g.players[3].hand = ping().slice(0, -1);
  const res = finish(g);
  assert.deepEqual(res.isTing, [false,true,true,true]);
  assert.deepEqual(res.kongDeltas, [-24,8,8,8]);
});

test('责任鸡：拿牌者听牌时原出牌者付2分，未听时拿牌者向所有听牌者各赔2分', () => {
  for (const ready of [true,false]) {
    const g = make();
    g.players[0].hand = (ready ? ready10() : junk10()).concat(23,9,9);
    g.players[3].hand.push(9); g.discard(3, 9);
    g.doPeng(0, 9, 3); g.discard(0, 23);
    assert.equal(g.charges[0].taken, true);
    assert.equal(g.penaltyLog[0].points, 2);
    assert.equal(g.penaltyLog[0].settled, false);
    assert.deepEqual(g.scores, zeros());
    const res = finish(g);
    assert.equal(res.isTing[0], ready);
    assert.deepEqual(res.responsibilityDeltas, ready ? [2,0,0,-2] : [-4,2,2,0]);
    assert.equal(res.penaltyLog[0].reversed, !ready);
    assert.equal(res.penaltyLog[0].settled, true);
    zeroSum(res.chickenDeltas);
  }
});

test('明杠冲锋鸡：杠4和责任鸡2分别记账，听牌后分别结算', async () => {
  const g = make();
  g.players[0].hand = ready10().concat(9,9,9);
  g.players[3].hand.push(9); g.discard(3, 9);
  await g.doKong(0, 'minggang', 9, 3);
  assert.deepEqual(g.scores, zeros());
  const res = finish(g);
  assert.deepEqual(res.kongDeltas, [4,0,0,-4]);
  assert.deepEqual(res.responsibilityDeltas, [2,0,0,-2]);
  assert.deepEqual(res.charges, [], '被拿走的冲锋鸡不再翻倍');
});

test('黄庄：杠和责任鸡全部作废，普通鸡也不算，只按查叫收支', async () => {
  const g = make();
  g.players[0].hand = ready10().concat(9,9,9);
  g.players[1].hand = ping().slice(0, -1);
  g.players[3].hand.push(9); g.discard(3, 9);
  await g.doKong(0, 'minggang', 9, 3);
  g.scores = [20,-10,-5,-5];
  const res = g.settleDraw();
  assert.deepEqual(res.kongDeltas, zeros());
  assert.deepEqual(res.responsibilityDeltas, zeros());
  assert.deepEqual(res.deltas, [8,8,-8,-8]);
  assert.deepEqual(res.scores, [28,-2,-13,-13]);
  for (const entry of [...res.kongLog, ...res.penaltyLog]) {
    assert.equal(entry.voided, true);
    assert.equal(entry.settled, true);
    assert.deepEqual(entry.deltas, zeros());
  }
  zeroSum(res.scores);
});

test('幺筒黄庄：本局杠分作废，首冲幺筒三家各付5的流水继续保留', async () => {
  const g = make('yitong'); await kong(g, 'angang', true);
  g.players[1].hand = ping().slice(0, -1);
  g.players[2].hand.push(18); g.discard(2, 18);
  assert.deepEqual(g.scores, [-5,-5,15,-5]);
  const res = g.settleDraw();
  assert.deepEqual(res.deltas, [3,3,7,-13]);
  assert.deepEqual(res.kongDeltas, zeros());
  assert.equal(res.kongLog[0].voided, true);
  assert.equal(res.chongLog[0].points, 5);
  zeroSum(res.scores);
});

test('抢杠胡：补杠者移除被抢张后仍听牌，原来的杠正常收分', async () => {
  const g = make();
  g.players[3].hand = [0,0,0,0,8,8,12,13,14,18,19,20,22,26];
  await g.doKong(3, 'angang', 0);
  g.doPeng(3, 8, 1); g.discard(3, 26);
  assert.ok(R.tenpaiTiles(g.players[3].hand, g.players[3].melds, g.mode).length);
  g.players[3].hand.push(8);
  g.players[0].hand = [0,1,2,3,4,5,9,10,11,18,19,20,8];
  const res = g.settleWin([{ p:0, winTile:8 }], { selfDraw:false, from:3, robKong:true });
  assert.equal(res.isTing[3], true);
  assert.deepEqual(res.kongDeltas, [-4,-4,-4,12]);
  assert.equal(res.kongLog.length, 1);
  assert.equal(g.players[3].melds[1].type, 'peng');
  zeroSum(res.scores);
});

test('联机快照：待结杠不改比分；胡牌后各视角的杠、责任鸡收支及收款座位正确旋转', async () => {
  const g = make();
  g.players[0].hand = ready10().concat(9,9,9);
  g.players[3].hand.push(9); g.discard(3, 9);
  await g.doKong(0, 'minggang', 9, 3);
  for (let seat = 0; seat < 4; seat++) {
    const snap = snapshot(g, seat);
    assert.deepEqual(snap.scores, zeros());
    assert.deepEqual(snap.roundDeltas, zeros());
    assert.ok(snap.players.slice(1).every((p) => p.hand.length === 0));
  }
  const res = finish(g);
  for (let seat = 0; seat < 4; seat++) {
    const snap = snapshot(g, seat);
    assert.deepEqual(snap.result.kongDeltas, rotate(res.kongDeltas, seat));
    assert.deepEqual(snap.result.responsibilityDeltas, rotate(res.responsibilityDeltas, seat));
    assert.deepEqual(snap.result.kongLog[0].payers, [(3 - seat + 4) % 4]);
    assert.equal(snap.result.penaltyLog[0].to, (4 - seat) % 4);
    assert.equal(snap.result.kongLog[0].settled, true);
  }
});
