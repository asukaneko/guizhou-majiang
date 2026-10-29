'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../src/js/ai.js');
const R = require('../src/js/rules.js');
const { Game } = require('../src/js/game.js');

const win = () => [0, 1, 2, 3, 4, 5, 9, 10, 11, 18, 19, 20, 22, 22];
const junk = () => [0, 3, 6, 9, 12, 15, 18, 21, 24, 1, 10, 19, 22, 8];
const player = (hand, melds = []) => ({ hand, melds });

test('冲锋鸡估值：未听牌不预支鸡分，打出后听牌才考虑收分收益', () => {
  const context = { charges: [], discardSeq: 0, lookahead:false };
  const scattered = AI.analyzeDiscards(junk(), [], 'classic', context).find((r) => r.tile === R.YAOJI);
  assert.ok(scattered.shanten > 0);
  assert.equal(scattered.reward, 0);
  const hand = [0,1,2,3,4,5,12,13,14,18,19,20,22,9];
  const ready = AI.analyzeDiscards(hand, [], 'classic', context).find((r) => r.tile === R.YAOJI);
  assert.equal(ready.shanten, 0);
  assert.equal(ready.reward, 6);
});

test('冲锋鸡估值：第一轮内跟冲照样值钱，第一轮过后不再重复计价', () => {
  const hand = [0, 1, 2, 3, 4, 5, 12, 13, 14, 18, 19, 20, 22, 9];
  const pick = (context) => AI.analyzeDiscards(hand, [], 'classic', { ...context, lookahead: false })
    .find((r) => r.tile === R.YAOJI);
  assert.equal(pick({ charges: [], discardSeq: 0 }).reward, 6, '首张幺鸡：冲锋鸡 2 分 × 3 家');
  const charged = [{ p: 1, tile: R.YAOJI, follow: false, taken: false }];
  assert.equal(pick({ charges: charged, discardSeq: 2 }).reward, 6, '第一轮内跟冲双倍');
  assert.equal(pick({ charges: charged, discardSeq: 9 }).reward, 0, '第一轮过后只是普通鸡');
  assert.equal(pick({ charges: [{ p: 1, tile: R.WUGU, follow: false, taken: false }], discardSeq: 9 }).reward, 6,
    '八筒冲过不影响幺鸡自己冲');
});

test('向听数：普通胡、听牌、七对四归二及副露分别计算', () => {
  assert.equal(AI.shanten(win(), [], 'classic'), -1);
  assert.equal(AI.shanten(win().slice(0, -1), [], 'classic'), 0);
  const seven = [0, 0, 0, 0, 9, 9, 11, 11, 13, 13, 18, 18, 20, 20];
  assert.equal(AI.shanten(seven, [], 'classic'), -1);
  assert.equal(AI.shanten(seven.slice(0, -1), [], 'classic'), 0);
  const melds = [{ type: 'peng', tile: 0, tiles: [0, 0, 0] }];
  const concealed = [3, 4, 5, 9, 10, 11, 18, 19, 20, 22, 22];
  assert.equal(AI.shanten(concealed, melds, 'classic'), -1);
  assert.equal(AI.shanten(concealed.slice(0, -1), melds, 'classic'), 0);
});

test('财神：补顺子前张和七对，与实际胡牌判定一致', () => {
  const hand = [7, 8, 9, 10, 11, 12, 13, 14, 21, 22, 23, 2, 2, 18];
  assert.ok(R.winInfo(hand, [], 'yitong'), '财神补七万，形成七八九万');
  assert.equal(AI.shanten(hand, [], 'yitong'), -1);
  assert.equal(R.winInfo(hand, [], 'classic'), null);
  const seven = [0, 0, 9, 9, 11, 11, 13, 13, 20, 20, 22, 22, 25, 18];
  assert.ok(R.winInfo(seven, [], 'yitong'));
  assert.equal(AI.shanten(seven, [], 'yitong'), -1);
});

test('固定种子交叉验证：构造胡牌、删牌听牌及财神替牌都与规则引擎一致', () => {
  let seed = 76123;
  const random = (max) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  let checked = 0;
  for (let attempt = 0; checked < 100 && attempt < 2000; attempt++) {
    const hand = [];
    for (let i = 0; i < 4; i++) {
      const suit = random(3) * 9;
      if (random(2)) { const tile = suit + random(9); hand.push(tile, tile, tile); }
      else { const start = suit + random(7); hand.push(start, start + 1, start + 2); }
    }
    const pair = random(27); hand.push(pair, pair);
    if (R.counts(hand).some((n) => n > 4)) continue;
    assert.ok(R.winInfo(hand, [], 'classic'));
    assert.equal(AI.shanten(hand, [], 'classic'), -1);
    const rest = hand.slice(1);
    assert.ok(R.tenpaiTiles(rest, [], 'classic').length);
    assert.equal(AI.shanten(rest, [], 'classic'), 0);
    const wild = hand.slice(); wild[random(14)] = 18;
    if (R.counts(wild)[18] <= 4) {
      assert.ok(R.winInfo(wild, [], 'yitong'));
      assert.equal(AI.shanten(wild, [], 'yitong'), -1);
    }
    checked++;
  }
  assert.equal(checked, 100);
});

test('有效进张使用可见剩余张数，耗尽的听牌不计入进张', () => {
  const hand = win().slice(0, -1), seen = new Array(27).fill(0);
  seen[22] = 3;
  assert.equal(AI.evaluateHand(hand, [], 'classic', { seen }).ukeire, 1);
  seen[22] = 4;
  assert.equal(AI.evaluateHand(hand, [], 'classic', { seen }).ukeire, 0);
});

test('相同向听数选择活听口，避免选择已经耗尽的等待牌', () => {
  const hand = [0, 1, 2, 3, 4, 5, 9, 10, 11, 18, 19, 20, 21, 22];
  const seen = new Array(27).fill(0); seen[19] = seen[22] = 4;
  const rows = AI.analyzeDiscards(hand, [], 'classic', { seen });
  assert.equal(rows.find((r) => r.tile === 18).shanten, 0);
  assert.equal(rows.find((r) => r.tile === 18).ukeire, 0);
  assert.equal(rows[0].shanten, 0);
  assert.ok(rows[0].ukeire > 0);
});

test('碰杠保护七对进度：拒绝破坏听牌的碰牌、暗杠', () => {
  const seven = [0, 0, 9, 9, 11, 11, 13, 13, 18, 18, 20, 20, 22];
  assert.equal(AI.decideClaim(['peng'], player(seven), 0, 'classic'), null);
  const quad = [0, 0, 0, 0, 9, 9, 11, 11, 13, 13, 18, 18, 20, 22];
  assert.equal(AI.decideSelfGang({ angang: [0], bugang: [] }, player(quad), 'classic'), null);
});

test('碰杠比较操作前后牌效，接受改善向听数的碰和保留听口的杠', () => {
  const hand = [0, 0, 3, 4, 5, 9, 10, 11, 18, 19, 20, 24, 8];
  assert.equal(AI.shanten(hand, [], 'classic'), 1);
  assert.equal(AI.decideClaim(['peng'], player(hand), 0, 'classic'), 'peng');
  const quad = [0, 0, 0, 0, 3, 4, 5, 9, 10, 11, 18, 19, 20, 22];
  assert.deepEqual(AI.decideSelfGang({ angang: [0], bugang: [] }, player(quad), 'classic'), { type: 'angang', tile: 0 });
  assert.equal(AI.decideSelfGang({ angang: [0], bugang: [] }, player(quad), 'classic', { wallLeft: 0 }), null);
});

test('补杠考虑报听对手的抢杠风险；打过的牌仍保留风险估计', () => {
  const melds = [{ type: 'peng', tile: 4, tiles: [4, 4, 4] }];
  const hand = [4, 0, 1, 2, 9, 10, 11, 18, 19, 20, 22];
  const actions = { angang: [], bugang: [4] };
  assert.deepEqual(AI.decideSelfGang(actions, player(hand, melds), 'classic'), { type: 'bugang', tile: 4 });
  const context = { seat: 0, players: [{ id: 1, tingDeclared: true, discards: [3], melds: [] }] };
  assert.equal(AI.decideSelfGang(actions, player(hand, melds), 'classic', context), null);
  assert.ok(AI.analyzeDiscards(junk(), [], 'classic', context).find((r) => r.tile === 3).risk > 0);
});

test('有限前瞻展开有效摸牌，输出稳定且不修改传入状态', (t) => {
  const hand = junk(), context = { seen: R.counts(hand), chongCount: 0 };
  const before = JSON.stringify({ hand, context });
  t.mock.method(Math, 'random', () => { throw new Error('决策不能依赖随机概率'); });
  const rows = AI.analyzeDiscards(hand, [], 'classic', context);
  assert.ok(rows.some((r) => r.future > 0));
  assert.equal(AI.chooseDiscard(hand, [], 'classic', context), rows[0].tile);
  assert.equal(AI.chooseDiscard(hand, [], 'classic', context), rows[0].tile);
  assert.equal(JSON.stringify({ hand, context }), before);
});

test('幺筒冲分按收益比较，保留使手牌听牌的财神', () => {
  const hand = [0, 1, 2, 3, 4, 5, 19, 20, 22, 23, 17, 17, 18, 26];
  const rows = AI.analyzeDiscards(hand, [], 'yitong', { chongCount: 0 });
  assert.equal(rows[0].shanten, 0);
  assert.notEqual(rows[0].tile, 18);
  assert.equal(rows.find((r) => r.tile === 18).reward, 15);
  const cash = [10, 22, 20, 22, 26, 18, 24, 21, 3, 1, 13, 14, 3, 12];
  assert.equal(AI.chooseDiscard(cash, [], 'yitong', { chongCount: 0 }), 18, '散牌时可以用一步进度换取确定冲分');
  assert.notEqual(AI.chooseDiscard(cash, [], 'yitong', { chongCount: 2 }), 18, '没有冲分时保留财神的牌效');
});

test('公开信息边界：换掉其他玩家手牌、牌墙顺序及暗杠牌面不改变 AI 输入', () => {
  const g = new Game({ dealer: 0, mode: 'classic' });
  g.players[0].hand = junk();
  g.players[1].hand = win();
  g.players[2].melds = [{ type: 'angang', tile: 7, tiles: [7, 7, 7, 7] }];
  g.wall = [1, 2, 3];
  const first = g.aiContext(0);
  assert.ok(first.players.every((p) => !Object.hasOwn(p, 'hand')));
  assert.equal(first.players[2].melds[0].tile, null);
  assert.deepEqual(first.players[2].melds[0].tiles, []);
  g.players[1].hand = [26, 26];
  g.players[2].melds = [{ type: 'angang', tile: 8, tiles: [8, 8, 8, 8] }];
  g.wall.reverse();
  assert.deepEqual(g.aiContext(0), first);
});

test('碰、明杠转移弃牌归属，可见张数不重复计算', async () => {
  const g = new Game({ dealer: 0, speed: 100 }); g.phase = 'playing';
  g.players[0].hand = [0]; g.players[1].hand = [0, 0];
  g.discard(0, 0); g.doPeng(1, 0, 0);
  assert.deepEqual(g.players[0].discards, []);
  assert.equal(g.aiContext(1).seen[0], 3);
  g.players[0].hand = [2]; g.players[2].hand = [2, 2, 2];
  g.discard(0, 2); await g.doKong(2, 'minggang', 2, 0);
  assert.deepEqual(g.players[0].discards, []);
  assert.equal(g.aiContext(2).seen[2], 4);
  assert.equal(g.lastDiscard, null);
});
