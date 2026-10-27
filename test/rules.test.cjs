const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/js/rules.js');
const { Game } = require('../src/js/game.js');

const W = 0, TI = 1, P = 2;
const c = (s, n) => s * 9 + (n - 1);
const handOf = (list) => list.map(([s, n]) => c(s, n));

test('平胡：4 面子 + 1 将', () => {
  const h = handOf([[W,1],[W,2],[W,3],[W,4],[W,5],[W,6],[W,7],[W,8],[W,9],[TI,1],[TI,2],[TI,3],[P,5],[P,5]]);
  const info = R.winInfo(h, []);
  assert.ok(info);
  assert.equal(info.name, '平胡');
  assert.equal(info.points, 4);
});

test('清一色：整副同一门', () => {
  const h = handOf([[W,1],[W,2],[W,3],[W,4],[W,5],[W,6],[W,7],[W,8],[W,9],[W,1],[W,2],[W,3],[W,5],[W,5]]);
  const info = R.winInfo(h, []);
  assert.equal(info.name, '清一色');
  assert.equal(info.points, 24);
});

test('大对子 / 清大对', () => {
  const mixed = handOf([[W,1],[W,1],[W,1],[TI,2],[TI,2],[TI,2],[P,3],[P,3],[P,3],[W,4],[W,4],[W,4],[P,5],[P,5]]);
  assert.equal(R.winInfo(mixed, []).name, '大对子');
  assert.equal(R.winInfo(mixed, []).points, 14);
  const pure = handOf([[W,1],[W,1],[W,1],[W,2],[W,2],[W,2],[W,3],[W,3],[W,3],[W,4],[W,4],[W,4],[W,5],[W,5]]);
  assert.equal(R.winInfo(pure, []).name, '清大对');
  assert.equal(R.winInfo(pure, []).points, 34);
});

test('七对 / 龙七对 / 清七对', () => {
  const seven = handOf([[W,1],[W,1],[W,2],[W,2],[TI,3],[TI,3],[P,4],[P,4],[P,5],[P,5],[TI,6],[TI,6],[P,7],[P,7]]);
  assert.equal(R.winInfo(seven, []).name, '七对');
  assert.equal(R.winInfo(seven, []).points, 24);

  const dragon = handOf([[W,1],[W,1],[W,1],[W,1],[W,2],[W,2],[TI,3],[TI,3],[P,4],[P,4],[P,5],[P,5],[TI,6],[TI,6]]);
  assert.equal(R.winInfo(dragon, []).name, '龙七对');
  assert.equal(R.winInfo(dragon, []).points, 44);

  const pure = handOf([[W,1],[W,1],[W,2],[W,2],[W,3],[W,3],[W,4],[W,4],[W,5],[W,5],[W,6],[W,6],[W,7],[W,7]]);
  assert.equal(R.winInfo(pure, []).name, '清七对');
  assert.equal(R.winInfo(pure, []).points, 44);
});

test('副露参与判定', () => {
  const melds = [{ type: 'peng', tile: c(W,1), tiles: [c(W,1), c(W,1), c(W,1)] }];
  const h = handOf([[W,2],[W,3],[W,4],[W,5],[W,6],[W,7],[TI,1],[TI,2],[TI,3],[P,5],[P,5]]);
  const info = R.winInfo(h, melds);
  assert.ok(info);
  assert.equal(info.kongs, 0);
});

test('副露后不能算七对', () => {
  const melds = [{ type: 'peng', tile: c(W,1), tiles: [c(W,1), c(W,1), c(W,1)] }];
  const h = handOf([[W,2],[W,2],[W,3],[W,3],[W,4],[W,4],[W,5],[W,5],[W,6],[W,6],[W,7]]);
  assert.equal(R.winInfo(h, melds), null);
});

test('听牌判定', () => {
  const h = handOf([[W,1],[W,2],[W,3],[W,4],[W,5],[W,6],[W,7],[W,8],[W,9],[TI,1],[TI,2],[TI,3],[P,5]]);
  const waits = R.tenpaiTiles(h, []);
  assert.deepEqual(waits, [c(P,5)]);
  assert.equal(R.tingValue(h, []).points, 4);
});

test('吃炮通行证', () => {
  const ping = { points: 4, kongs: 0 };
  const duizi = { points: 14, kongs: 0 };
  const withKong = { points: 4, kongs: 1 };
  assert.equal(R.canChiPao(ping), false);
  assert.equal(R.canChiPao(duizi), true);
  assert.equal(R.canChiPao(withKong), false);
});

test('鸡：幺鸡 / 乌骨鸡 / 翻牌鸡 / 金鸡', () => {
  const set = R.chickenSet(c(W,5));
  assert.deepEqual(set.map((x) => x.tile).sort((a, b) => a - b), [c(W,6), R.YAOJI, R.WUGU].sort((a, b) => a - b));
  assert.equal(set.find((x) => x.tile === R.YAOJI).rate, 2);
  assert.equal(set.find((x) => x.tile === R.WUGU).rate, 2);
  assert.equal(set.find((x) => x.tile === c(W,6)).rate, 1);

  const golden = R.chickenSet(c(TI,9)); // 翻 9 条，金鸡一条每张 4 分
  const yao = golden.find((x) => x.tile === R.YAOJI);
  assert.equal(yao.kind, '金鸡');
  assert.equal(yao.rate, 4);

  const goldenWu = R.chickenSet(c(P,7)); // 翻 7 筒 → 翻牌鸡是八筒，金鸡 4 分
  assert.equal(goldenWu.find((x) => x.tile === R.WUGU).rate, 4);

  const pts = R.chickenPoints(
    [R.YAOJI, R.YAOJI, c(P,1)],
    [{ type: 'peng', tile: R.YAOJI, tiles: [R.YAOJI, R.YAOJI, R.YAOJI] }],
    [R.WUGU],
    R.chickenSet(c(W,5))
  );
  // 幺鸡五张各 2 分，乌骨鸡一张 2 分，共 12 分。
  assert.equal(pts, 12);
});

test('Game 可从本地存档恢复四家累计分数', () => {
  const saved = [18, -7, 0, 5];
  const g = new Game({ scores: saved, roundNo: 6, dealer: 2 });
  assert.deepEqual(g.scores, saved);
  assert.equal(g.roundNo, 6);
  assert.equal(g.dealer, 2);
});

test('庄家开局只首摸一次，手牌为14张', { timeout: 10000 }, async () => {
  const g = new Game({ speed: 80, dealer: 0 });
  const firstTurn = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('庄家没有收到首轮出牌提示')), 5000);
    g.on('prompt', (a) => {
      if (a.kind !== 'discard' || a.player !== 0) return;
      clearTimeout(timer);
      const state = { hand: g.players[0].hand.length, wall: g.wall.length };
      g.phase = 'ended';
      g.humanDiscard(g.players[0].hand[0]);
      resolve(state);
    });
  });
  g.startRound();
  const state = await firstTurn;
  assert.equal(state.hand, 14);
  assert.equal(state.wall, 55);
});

test('整局模拟：流程可跑通且分数零和', { timeout: 120000 }, async () => {
  const g = new Game({ speed: 80, dealer: 0 });
  const errors = [];
  g.on('error', (e) => errors.push(e));
  g.on('prompt', (a) => {
    setTimeout(() => {
      if (g.awaiting !== a) return;
      if (a.kind === 'discard') g.humanDiscard(g.players[0].hand[0]);
      else g.humanRespond('pass');
    }, 0);
  });
  let resolveEnd = null;
  g.on('roundEnd', () => { if (resolveEnd) { const r = resolveEnd; resolveEnd = null; r(); } });

  for (let i = 0; i < 8; i++) {
    const done = new Promise((r) => { resolveEnd = r; });
    g.startRound();
    await done;
    const total = g.scores.reduce((a, b) => a + b, 0);
    assert.equal(total, 0, `第 ${i + 1} 局后总分应守恒`);
    assert.equal(g.result.deltas.reduce((a, b) => a + b, 0), 0);
    assert.equal(errors.length, 0);
    if (g.result.draw) assert.ok(g.result.ting.length === 4);
    g.nextDealer = (g.dealer + 1) % 4;
  }
});

test('玩家侧吃碰杠胡路径', { timeout: 120000 }, async () => {
  const AI = require('../src/js/ai.js');
  const g = new Game({ speed: 90, dealer: 0 });
  const errors = [];
  const stats = { hu: 0, gang: 0, peng: 0 };
  g.on('error', (e) => errors.push(e));
  g.on('roundEnd', (res) => { if (!res.draw && res.winner === 0) stats.hu++; });

  g.on('prompt', (a) => {
    setTimeout(() => {
      if (g.awaiting !== a) return;
      if (a.kind === 'claim') {
        if (a.options.includes('hu')) { stats.hu++; g.humanRespond('hu'); return; }
        if (a.options.includes('gang')) { stats.gang++; g.humanRespond('gang'); return; }
        if (a.options.includes('peng') && Math.random() < 0.5) { stats.peng++; g.humanRespond('peng'); return; }
        g.humanRespond('pass');
        return;
      }
      const self = a.self || {};
      if (self.hu) { g.humanHu(); return; }
      if (self.angang.length) { stats.gang++; g.humanGang('angang', self.angang[0]); return; }
      if (self.bugang.length) { stats.gang++; g.humanGang('bugang', self.bugang[0]); return; }
      g.humanDiscard(AI.chooseDiscard(g.players[0].hand, g.players[0].melds));
    }, 0);
  });

  let resolveEnd = null;
  g.on('roundEnd', () => { if (resolveEnd) { const r = resolveEnd; resolveEnd = null; r(); } });

  for (let i = 0; i < 6; i++) {
    const done = new Promise((r) => { resolveEnd = r; });
    g.startRound();
    await done;
    assert.equal(g.scores.reduce((a, b) => a + b, 0), 0);
    assert.equal(errors.length, 0, '不应出现对局异常');
    g.nextDealer = (g.dealer + 1) % 4;
  }
  console.log('玩家侧动作统计', stats);
});

test('听牌策略：优先刚摸到的那张，仍保持听牌', () => {
  const g = new Game({ autoPlay: true });
  const pl = g.players[0];
  pl.hand = handOf([
    [W, 1], [W, 2], [W, 3], [W, 4], [W, 5], [W, 6], [W, 7], [W, 8], [W, 9],
    [P, 5], [P, 5], [P, 7], [P, 8],
    [TI, 1]
  ]);
  pl.hand = R.sortHand(pl.hand);
  pl.justDrawn = c(TI, 1);
  const decision = g.autoDecision(0, { hu: null });
  assert.equal(decision.type, 'discard');
  assert.equal(decision.tile, c(TI, 1), '应该打掉没用的刚摸牌');
  const rest = pl.hand.filter((t) => t !== decision.tile);
  assert.deepEqual(R.tenpaiTiles(rest, []).sort((a, b) => a - b), [c(P, 6), c(P, 9)]);
});

test('听牌策略：能自摸就直接胡', () => {
  const g = new Game({ autoPlay: true });
  const pl = g.players[0];
  pl.hand = handOf([
    [W, 1], [W, 2], [W, 3], [W, 4], [W, 5], [W, 6], [W, 7], [W, 8], [W, 9],
    [P, 5], [P, 5], [P, 6], [P, 7], [P, 8]
  ]);
  pl.hand = R.sortHand(pl.hand);
  pl.justDrawn = c(P, 8);
  const info = R.winInfo(pl.hand, []);
  assert.ok(info);
  assert.deepEqual(g.autoDecision(0, { hu: info }), { type: 'hu' });
});

test('听牌策略：散牌返回空结果', () => {
  const g = new Game({ autoPlay: true });
  const pl = g.players[0];
  pl.hand = handOf([
    [W, 1], [W, 4], [W, 7], [TI, 1], [TI, 4], [TI, 7],
    [P, 1], [P, 4], [P, 7], [W, 2], [TI, 2], [P, 2], [P, 5],
    [W, 9]
  ]);
  pl.hand = R.sortHand(pl.hand);
  pl.justDrawn = c(W, 9);
  assert.equal(g.autoDecision(0, { hu: null }), null);
});

test('人机代打：连续四局自动完成，手动提示次数为零', { timeout: 120000 }, async () => {
  const g = new Game({ speed: 90, dealer: 0, autoPlay: true });
  const errors = [];
  let manual = 0;
  g.on('error', (e) => errors.push(e));
  g.on('prompt', (a) => {
    manual++;
    setTimeout(() => {
      if (g.awaiting !== a) return;
      if (a.kind === 'discard') g.humanDiscard(g.players[0].hand[0]);
      else g.humanRespond('pass');
    }, 0);
  });
  let resolveEnd = null;
  g.on('roundEnd', () => { if (resolveEnd) { const r = resolveEnd; resolveEnd = null; r(); } });

  for (let i = 0; i < 4; i++) {
    const done = new Promise((r) => { resolveEnd = r; });
    g.startRound();
    await done;
    assert.equal(g.scores.reduce((a, b) => a + b, 0), 0);
    assert.equal(errors.length, 0, '不应出现对局异常');
    g.nextDealer = (g.dealer + 1) % 4;
  }
  assert.equal(manual, 0, '人机代打应接管整局的所有操作');
});

/* ---------------- 报听 / 天听 / 天胡 / 地胡 / 抢杠 / 热炮 / 一炮多响 / 鸡 ---------------- */

const WIN14 = () => handOf([
  [W, 1], [W, 2], [W, 3], [W, 4], [W, 5], [W, 6], [W, 7], [W, 8], [W, 9],
  [TI, 1], [TI, 2], [TI, 3], [P, 5], [P, 5]
]);

const READY14 = () => handOf([
  [W, 1], [W, 2], [W, 3], [W, 4], [W, 5], [W, 6], [W, 7], [W, 8], [W, 9],
  [TI, 1], [TI, 2], [TI, 3], [P, 5], [TI, 9]
]);

test('报听：锁牌、天听判定，出张就是保持听牌的那张', () => {
  const g = new Game({ dealer: 0 });
  const pl = g.players[0];
  pl.hand = R.sortHand(READY14());
  pl.justDrawn = c(TI, 9);
  pl.tingAtDeal = true; // 起手 13 张就听牌
  let resolved = null;
  g.awaiting = {
    kind: 'discard', player: 0, self: { hu: null, angang: [], bugang: [] },
    resolve: (d) => { resolved = d; }
  };
  assert.equal(g.canTing(0), true);
  assert.equal(g.humanTing(), true);
  assert.equal(pl.tingDeclared, true);
  assert.equal(pl.tianTing, true, '起手听牌 + 第一巡报听 = 天听');
  assert.equal(resolved.type, 'discard');
  assert.equal(resolved.tile, c(TI, 9), '应该打掉刚摸的那张 ');
  // 报听后不能再杠
  g.players[0].hand = handOf([[W, 5], [W, 5], [W, 5], [W, 5]]).concat(handOf([[TI, 1], [TI, 1], [TI, 1]]));
  pl.melds = [];
  assert.deepEqual(g.selfActions(0).angang, []);
});

test('报听 / 天听 / 天胡 / 热炮 / 抢杠 的加分', () => {
  const g = new Game({ dealer: 0 });
  g.phase = 'playing';
  g.wall = [];
  g.players[0].hand = WIN14();
  const res = g.settleWin([{ p: 0, winTile: null }], { selfDraw: true });
  // 平胡 4 + 自摸 1 = 5。
  assert.equal(res.winners[0].points, 5);

  const g2 = new Game({ dealer: 0 });
  g2.phase = 'playing';
  g2.wall = [];
  g2.players[0].hand = WIN14();
  g2.players[0].tingDeclared = true;
  const baoting = g2.settleWin([{ p: 0, winTile: null }], { selfDraw: true });
  assert.equal(baoting.winners[0].points, 25); // 4 + 自摸1 + 报听20
  assert.ok(baoting.winners[0].extra.includes('报听 +20'));

  const g3 = new Game({ dealer: 0 });
  g3.phase = 'playing';
  g3.wall = [];
  g3.players[0].hand = WIN14();
  g3.players[0].tingDeclared = true;
  g3.players[0].tianTing = true;
  const tianting = g3.settleWin([{ p: 0, winTile: null }], { selfDraw: true });
  assert.equal(tianting.winners[0].points, 45); // 4 + 自摸1 + 天听40
  assert.ok(tianting.winners[0].extra.includes('天听 +40'));

  const g4 = new Game({ dealer: 0 });
  g4.phase = 'playing';
  g4.wall = [];
  g4.players[0].hand = WIN14();
  const tianhu = g4.settleWin([{ p: 0, winTile: null }], { selfDraw: true, tianhu: true });
  assert.equal(tianhu.winners[0].points, 65); // 4 + 自摸1 + 天胡60

  const g5 = new Game({ dealer: 0 });
  g5.phase = 'playing';
  g5.wall = [];
  g5.players[0].hand = WIN14();
  const repao = g5.settleWin([{ p: 0, winTile: null }], { selfDraw: false, from: 2, repao: true });
  assert.equal(repao.winners[0].points, 24); // 4 + 热炮20
  assert.ok(repao.winners[0].extra.includes('热炮 +20'));
  assert.equal(repao.winDeltas[2], -24);
});

test('天胡 / 地胡 的判定条件', () => {
  const g = new Game({ dealer: 0 });
  g.phase = 'playing';
  assert.equal(g.isTianHu(0), true);
  assert.equal(g.isTianHu(1), false);
  g.players[2].discards = [c(W, 1)];
  assert.equal(g.isTianHu(0), false, '别人打过牌就不算天胡');

  const d = new Game({ dealer: 0 });
  d.phase = 'playing';
  d.discardSeq = 1;
  assert.equal(d.isDiHu(1, true), true, '下家第一摸自摸 = 地胡');
  assert.equal(d.isDiHu(1, false, 0), true, '下家胡庄家首张 = 地胡');
  assert.equal(d.isDiHu(2, true), false, '只有下家赶得上第一巡');
  d.discardSeq = 2;
  assert.equal(d.isDiHu(1, true), false);
});

test('抢杠胡：杠不成立，补杠者向胡家付一份', async () => {
  const g = new Game({ speed: 90, dealer: 0 });
  g.phase = 'playing';
  g.wall = [];
  const kong = c(W, 5);
  // 杠家（下家）：碰过五万，手里还有一张五万
  g.players[1].hand = handOf([
    [W, 1], [W, 2], [W, 3], [TI, 1], [TI, 2], [TI, 3], [P, 1], [P, 2], [P, 3], [W, 5]
  ]);
  g.players[1].melds = [{ type: 'peng', tile: kong, tiles: [kong, kong, kong], from: 0 }];
  // 对家：听五万
  g.players[2].hand = handOf([
    [W, 1], [W, 2], [W, 3], [W, 4], [W, 6], [TI, 1], [TI, 2], [TI, 3],
    [P, 1], [P, 2], [P, 3], [P, 8], [P, 8]
  ]);

  const ok = await g.doKong(1, 'bugang', kong);
  assert.equal(ok, false, '被抢杠时杠不成立');
  assert.equal(g.players[1].melds[0].type, 'peng');
  assert.equal(g.result.robKong, true);
  assert.equal(g.result.winner, 2);
  // 平胡 4 + 抢杠 20 = 24，补杠者只向该胡家付一份。
  assert.equal(g.result.winners[0].points, 24);
  assert.equal(g.result.winDeltas[1], -24);
  assert.equal(g.result.winDeltas[2], 24);
  assert.equal(g.kongLog.length, 0, '抢杠时豆不成立');
});

test('热炮：杠后打出的牌被别人胡', () => {
  const g = new Game({ dealer: 0 });
  g.phase = 'playing';
  g.players[2].hand = handOf([[W, 1], [W, 2], [W, 3], [TI, 1], [TI, 2], [TI, 3], [P, 1], [P, 2], [P, 3], [W, 5], [W, 5], [P, 9], [P, 9]]);
  g.lastKongBy = 2;
  g.discard(2, c(P, 9));
  assert.equal(g.discardHot, true);
  assert.equal(g.lastKongBy, -1);
  // 下一张普通出牌不算热炮
  g.players[2].hand = handOf([[W, 1], [W, 2], [W, 3], [TI, 1], [TI, 2], [TI, 3], [P, 1], [P, 2], [P, 3], [W, 5], [W, 5], [P, 9], [P, 9]]);
  g.discard(2, c(W, 1));
  assert.equal(g.discardHot, false);
});

test('一炮多响：一张牌两家胡，点炮者各赔一份', async () => {
  const g = new Game({ speed: 90, dealer: 0 });
  g.phase = 'playing';
  g.wall = [];
  const tile = c(W, 5);
  for (const p of [1, 2]) {
    g.players[p].hand = handOf([[W, p], [W, p], [W, p], [TI, p + 1], [TI, p + 1], [TI, p + 1], [P, p + 4], [P, p + 4], [P, p + 4], [W, 5]]);
    const kong = c(P, p === 1 ? 9 : 8);
    g.players[p].melds = [{ type: 'gang', tile: kong, tiles: [kong, kong, kong, kong], from: 3 }];
  }
  // 上家打出五万
  g.players[3].hand = handOf([[W, 5], [W, 7], [TI, 4], [TI, 5], [TI, 6], [P, 1], [P, 3], [P, 4], [P, 6], [P, 7], [P, 9], [W, 9], [TI, 9]]);
  g.discard(3, tile);

  const claim = await g.resolveClaims(3, tile);
  assert.equal(claim.type, 'hu');
  assert.deepEqual(claim.winners.map((w) => w.p), [1, 2]);

  const res = g.settleWin(claim.winners, { selfDraw: false, from: 3 });
  assert.equal(res.winners.length, 2);
  assert.equal(res.winDeltas[3], -28, '点炮者向两位大对子胡家各付14分');
  assert.equal(res.winDeltas[1], 14);
  assert.equal(res.winDeltas[2], 14);
});

test('冲锋鸡：本局第一张打出的幺鸡算双倍', () => {
  const g = new Game({ dealer: 0 });
  g.phase = 'playing';
  g.wall = [];
  // 玩家 3 打出幺鸡，手里还剩一张幺鸡
  g.players[3].hand = handOf([
    [W, 1], [W, 2], [W, 3], [TI, 1], [TI, 2], [TI, 3], [P, 1], [P, 2], [P, 3], [P, 5], [P, 5], [W, 9], [TI, 9], [TI, 1]
  ]);
  g.discard(3, c(TI, 1));
  assert.ok(g.firstChicken);
  assert.equal(g.firstChicken.p, 3);
  assert.equal(g.firstChicken.taken, false);

  // 玩家 3 的鸡：手里一张 2 分，牌河冲锋鸡 4 分，共 6 分。
  g.players[1].hand = WIN14();
  const res = g.settleWin([{ p: 1, winTile: null }], { selfDraw: true });
  assert.equal(res.chickenCount[3], 6);
  assert.equal(res.charge.p, 3);
});

test('责任鸡：冲锋鸡被碰走只记2分，胡牌时再结算', () => {
  const g = new Game({ dealer: 0 });
  g.phase = 'playing';
  g.players[0].hand = handOf([
    [W, 1], [W, 2], [W, 3], [TI, 1], [TI, 2], [TI, 3], [P, 1], [P, 2], [P, 3], [P, 5], [P, 5], [W, 9], [TI, 9], [TI, 1]
  ]);
  g.players[1].hand = handOf([
    [TI, 1], [TI, 1], [W, 4], [W, 5], [W, 6], [P, 1], [P, 4], [P, 7], [P, 9], [W, 8], [W, 9], [TI, 5], [TI, 7]
  ]);
  g.discard(0, c(TI, 1));
  const before = g.scores.slice();
  g.doPeng(1, c(TI, 1), 0);
  assert.equal(g.firstChicken.taken, true);
  assert.deepEqual(g.scores, before, '碰牌时不改变总分');
  assert.equal(g.penaltyLog.length, 1);
  assert.equal(g.penaltyLog[0].kind, '责任鸡');
  assert.equal(g.penaltyLog[0].points, 2);
  assert.equal(g.penaltyLog[0].settled, false);
  assert.deepEqual(g.penaltyLog[0].deltas, [0,0,0,0]);
});

test('包鸡：未听者向所有听牌者赔自己的鸡，未胡的听牌者也收分', () => {
  const g = new Game({ dealer: 0 });
  g.phase = 'playing';
  g.wall = [];
  // 玩家 1 胡牌；玩家 2 叫牌（听牌）；玩家 3 没叫，手里 2 张八筒 = 4 分
  g.players[1].hand = WIN14();
  g.players[2].hand = WIN14().slice(0, -1);
  g.players[3].hand = handOf([[W, 4], [W, 6], [W, 8], [TI, 4], [TI, 6], [TI, 8], [P, 8], [P, 8], [P, 4], [P, 6], [W, 2], [TI, 2], [P, 2]]);

  const res = g.settleWin([{ p: 1, winTile: null }], { selfDraw: true });
  assert.equal(res.isTing[3], false);
  assert.equal(res.chickenCount[3], 4);
  assert.ok(res.baoji.some((b) => b.p === 3 && b.to === 1 && b.points === 4));
  assert.equal(res.isTing[2], true);
  assert.ok(res.baoji.some((b) => b.p === 3 && b.to === 2 && b.points === 4));
  // 玩家 3 既要付玩家 1 / 2 的鸡，也把自己的4分分别赔给两位听牌者。
  assert.ok(res.chickenDeltas[3] < 0);
  assert.equal(res.chickenDeltas.reduce((a, b) => a + b, 0), 0);
});

test('整局模拟（含新规则）：分数仍为零和', { timeout: 120000 }, async () => {
  const AI = require('../src/js/ai.js');
  const g = new Game({ speed: 90, dealer: 0 });
  const errors = [];
  g.on('error', (e) => errors.push(e));
  g.on('prompt', (a) => {
    setTimeout(() => {
      if (g.awaiting !== a) return;
      if (a.kind === 'claim') {
        if (a.options.includes('hu')) { g.humanRespond('hu'); return; }
        g.humanRespond('pass');
        return;
      }
      if (a.self && a.self.hu) { g.humanHu(); return; }
      g.humanDiscard(AI.chooseDiscard(g.players[0].hand, g.players[0].melds));
    }, 0);
  });
  let resolveEnd = null;
  g.on('roundEnd', () => { if (resolveEnd) { const r = resolveEnd; resolveEnd = null; r(); } });

  for (let i = 0; i < 6; i++) {
    const done = new Promise((r) => { resolveEnd = r; });
    g.startRound();
    await done;
    const total = g.scores.reduce((a, b) => a + b, 0);
    assert.equal(total, 0, `第 ${i + 1} 局后总分守恒`);
    assert.equal(errors.length, 0, '不应出现对局异常');
    if (!g.result.draw) {
      assert.ok(Array.isArray(g.result.winners) && g.result.winners.length >= 1);
      assert.equal(g.result.winDeltas.reduce((a, b) => a + b, 0), 0);
    }
    g.nextDealer = (g.dealer + 1) % 4;
  }
});

test('报听之后整局不再要求手动出牌（锁牌自动摸打）', { timeout: 120000 }, async () => {
  const AI = require('../src/js/ai.js');
  const g = new Game({ speed: 90, dealer: 0 });
  let declared = false;
  let promptsAfter = 0;
  const errors = [];
  g.on('error', (e) => errors.push(e));
  g.on('ting', () => { declared = true; });
  g.on('deal', () => {
    // 构造合法的起手听牌牌墙，确保首次出牌前即可报听。
    const opening = READY14(), rest = R.createWall();
    for (const tile of opening) rest.splice(rest.indexOf(tile), 1);
    g.players[0].hand = R.sortHand(opening.slice(0, 13));
    g.players[0].tingAtDeal = true;
    for (let p = 1; p < 4; p++) {
      g.players[p].hand = R.sortHand(rest.splice(0, 13));
      g.players[p].tingAtDeal = R.tenpaiTiles(g.players[p].hand, [], g.mode).length > 0;
    }
    g.wall = [opening[13], ...rest];
  });

  g.on('prompt', (a) => {
    setTimeout(() => {
      if (g.awaiting !== a) return;
      if (a.kind === 'claim') {
        if (a.options.includes('hu')) { g.humanRespond('hu'); return; }
        g.humanRespond('pass');
        return;
      }
      if (!declared && g.canTing(0)) { g.humanTing(); return; }
      if (declared) promptsAfter++;
      if (a.self && a.self.hu) { g.humanHu(); return; }
      g.humanDiscard(AI.chooseDiscard(g.players[0].hand, g.players[0].melds));
    }, 0);
  });

  let resolveEnd = null;
  g.on('roundEnd', () => { if (resolveEnd) { const r = resolveEnd; resolveEnd = null; r(); } });

  const done = new Promise((r) => { resolveEnd = r; });
  g.startRound();
  await done;
  assert.equal(errors.length, 0, '不应出现对局异常');
  assert.equal(declared, true, '起手听牌在首次出牌前成功报听');
  assert.equal(promptsAfter, 0, '报听后不该再弹手动出牌提示');
});

/* ---------------- 幺筒麻将（一筒作财神） ---------------- */

const YT = c(P, 1);   // 一筒 / 幺筒 = 18

/** 13 张互不搭的散牌，加一张财神也胡不了（用来测「不能碰杠」） */
const junk13 = () => handOf([
  [W, 1], [W, 3], [W, 5], [W, 7], [W, 9],
  [TI, 2], [TI, 4], [TI, 6], [TI, 8],
  [P, 1], [P, 3], [P, 5], [P, 7]
]);

// 一筒替七筒，凑成五六七筒
const SOFT14 = () => handOf([
  [W, 1], [W, 2], [W, 3], [W, 4], [W, 5], [W, 6],
  [P, 1], [P, 2], [P, 3], [P, 5], [P, 6], [P, 1],
  [TI, 9], [TI, 9]
]);

// 一筒全当真一筒用：123万 456万 123筒 123筒 99条
const HARD14 = () => handOf([
  [W, 1], [W, 2], [W, 3], [W, 4], [W, 5], [W, 6],
  [P, 1], [P, 2], [P, 3], [P, 1], [P, 2], [P, 3],
  [TI, 9], [TI, 9]
]);

test('幺筒模式：一筒能替任意牌，经典模式不能', () => {
  const soft = R.winInfo(SOFT14(), [], 'yitong');
  assert.ok(soft, '幺筒模式应该能胡');
  assert.equal(soft.hard, false);
  assert.equal(soft.joker, 1);
  assert.equal(soft.hardBonus, 0);
  assert.equal(R.winInfo(SOFT14(), [], 'classic'), null, '经典模式不吃替身');

  const hard = R.winInfo(HARD14(), [], 'yitong');
  assert.ok(hard);
  assert.equal(hard.hard, true);
  assert.equal(hard.points, 4);
  assert.equal(hard.hardBonus, R.BONUS.hardHu);
  R.setMode('classic');
});

test('幺筒模式：听牌会多出一筒（替身补张），经典模式不会', () => {
  const h = handOf([
    [W, 1], [W, 2], [W, 3], [W, 4], [W, 5], [W, 6],
    [P, 1], [P, 2], [P, 3], [P, 5], [P, 6], [TI, 9], [TI, 9]
  ]);
  assert.deepEqual(R.tenpaiTiles(h, [], 'classic'), [c(P, 4), c(P, 7)]);
  const waits = R.tenpaiTiles(h, [], 'yitong');
  assert.deepEqual(waits, [YT, c(P, 4), c(P, 7)]);
  assert.ok(R.tingValue(h, [], 'yitong').points > 0);
  R.setMode('classic');
});

test('幺筒不能碰、不能杠', async () => {
  const g = new Game({ dealer: 0, mode: 'yitong' });
  g.phase = 'playing';
  // 手里四张一筒也不弹暗杠
  g.players[0].hand = R.sortHand(junk13().slice(0, 10).concat([YT, YT, YT, YT]));
  const self = g.selfActions(0);
  assert.equal(self.angang.length, 0, '幺筒不能暗杠');

  // 别人打出幺筒，手里两张也不能碰
  g.players[1].hand = R.sortHand(junk13().slice(2, 13).concat([YT, YT]));
  const claim = await g.resolveClaims(0, YT);
  assert.equal(claim, null, '幺筒既不能碰也不能杠');
  R.setMode('classic');
});

test('冲幺筒：第一张向三家各收 5 分，第二张各收 3 分，第三张不再收', () => {
  const g = new Game({ dealer: 0, mode: 'yitong' });
  g.phase = 'playing';
  g.players[1].hand = R.sortHand(junk13().slice(0, 10).concat([YT, YT, YT]));
  g.discard(1, YT);
  assert.deepEqual(g.scores, [-5, 15, -5, -5]);
  g.discard(1, YT);
  assert.deepEqual(g.scores, [-8, 24, -8, -8]);
  g.discard(1, YT);
  assert.deepEqual(g.scores, [-8, 24, -8, -8], '第三张没有冲分了');
  assert.equal(g.penaltyLog.length, 2);
  assert.equal(g.penaltyLog[0].kind, '冲幺筒');
  assert.equal(g.penaltyLog[0].points, 5);
  assert.equal(g.penaltyLog[1].points, 3);
  assert.equal(g.scores.reduce((a, b) => a + b, 0), 0, '冲幺筒零和');
  R.setMode('classic');
});

test('幺筒结算：硬胡 +5 进总分，本模式不捉鸡', () => {
  const g = new Game({ dealer: 0, mode: 'yitong' });
  g.phase = 'playing';
  g.wall = [];
  g.players[0].hand = R.sortHand(HARD14());
  const res = g.settleWin(0, { selfDraw: true, winTile: null });
  assert.equal(res.mode, 'yitong');
  assert.equal(res.chickens.length, 0, '没有鸡');
  assert.equal(res.winners[0].hard, true);
  // 平胡 4 + 自摸 1 + 硬胡 5。
  assert.equal(res.winners[0].points, 4 + 1 + R.BONUS.hardHu);
  assert.equal(res.winDeltas.reduce((a, b) => a + b, 0), 0);
  assert.equal(g.scores[0], (4 + 1 + R.BONUS.hardHu) * 3);
  assert.equal(res.chickenDeltas.reduce((a, b) => a + b, 0), 0);
  R.setMode('classic');
});

test('玩法切换：两套规则各算各的', () => {
  const g1 = new Game({ dealer: 0, mode: 'yitong' });
  assert.equal(g1.mode.id, 'yitong');
  assert.equal(R.currentMode().id, 'yitong');
  assert.equal(R.chickenSet(0).length, 0, '幺筒模式没有鸡');

  const g2 = new Game({ dealer: 0 });
  assert.equal(g2.mode.id, 'classic');
  assert.equal(R.currentMode().id, 'classic');
  assert.equal(R.chickenSet(0).length, 3, '经典模式：幺鸡 + 乌骨鸡 + 翻牌鸡');
  assert.ok(R.MODES.classic && R.MODES.yitong && R.MODE_ORDER.length === 2);
});

