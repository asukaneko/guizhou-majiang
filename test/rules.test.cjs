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
  assert.equal(info.points, 1);
});

test('清一色：整副同一门', () => {
  const h = handOf([[W,1],[W,2],[W,3],[W,4],[W,5],[W,6],[W,7],[W,8],[W,9],[W,1],[W,2],[W,3],[W,5],[W,5]]);
  const info = R.winInfo(h, []);
  assert.equal(info.name, '清一色');
  assert.equal(info.points, 10);
});

test('大对子 / 清大对', () => {
  const mixed = handOf([[W,1],[W,1],[W,1],[TI,2],[TI,2],[TI,2],[P,3],[P,3],[P,3],[W,4],[W,4],[W,4],[P,5],[P,5]]);
  assert.equal(R.winInfo(mixed, []).name, '大对子');
  assert.equal(R.winInfo(mixed, []).points, 5);
  const pure = handOf([[W,1],[W,1],[W,1],[W,2],[W,2],[W,2],[W,3],[W,3],[W,3],[W,4],[W,4],[W,4],[W,5],[W,5]]);
  assert.equal(R.winInfo(pure, []).name, '清大对');
  assert.equal(R.winInfo(pure, []).points, 15);
});

test('七对 / 龙七对 / 清七对', () => {
  const seven = handOf([[W,1],[W,1],[W,2],[W,2],[TI,3],[TI,3],[P,4],[P,4],[P,5],[P,5],[TI,6],[TI,6],[P,7],[P,7]]);
  assert.equal(R.winInfo(seven, []).name, '七对');
  assert.equal(R.winInfo(seven, []).points, 7);

  const dragon = handOf([[W,1],[W,1],[W,1],[W,1],[W,2],[W,2],[TI,3],[TI,3],[P,4],[P,4],[P,5],[P,5],[TI,6],[TI,6]]);
  assert.equal(R.winInfo(dragon, []).name, '龙七对');
  assert.equal(R.winInfo(dragon, []).points, 10);

  const pure = handOf([[W,1],[W,1],[W,2],[W,2],[W,3],[W,3],[W,4],[W,4],[W,5],[W,5],[W,6],[W,6],[W,7],[W,7]]);
  assert.equal(R.winInfo(pure, []).name, '清七对');
  assert.equal(R.winInfo(pure, []).points, 17);
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
  assert.equal(R.tingValue(h, []).points, 1);
});

test('吃炮通行证', () => {
  const ping = { points: 1, kongs: 0 };
  const duizi = { points: 5, kongs: 0 };
  const withKong = { points: 1, kongs: 1 };
  assert.equal(R.canChiPao(ping), false);
  assert.equal(R.canChiPao(duizi), true);
  assert.equal(R.canChiPao(withKong), true);
});

test('鸡：幺鸡 / 乌骨鸡 / 翻牌鸡 / 金鸡', () => {
  const set = R.chickenSet(c(W,5));
  assert.deepEqual(set.map((x) => x.tile).sort((a, b) => a - b), [c(W,6), R.YAOJI, R.WUGU].sort((a, b) => a - b));
  assert.ok(set.every((x) => x.rate === 1));

  const golden = R.chickenSet(c(TI,9)); // 翻 9 条 → 幺鸡为鸡，金鸡 2 分
  const yao = golden.find((x) => x.tile === R.YAOJI);
  assert.equal(yao.rate, 2);

  const pts = R.chickenPoints(
    [R.YAOJI, R.YAOJI, c(P,1)],
    [{ type: 'peng', tile: R.YAOJI, tiles: [R.YAOJI, R.YAOJI, R.YAOJI] }],
    [R.WUGU],
    R.chickenSet(c(W,5))
  );
  // 幺鸡：手牌 2 + 副露 3 = 5；乌骨鸡：牌河 1 → 共 6
  assert.equal(pts, 6);
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
