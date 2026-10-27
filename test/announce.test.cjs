'use strict';
/* 对局播报：game.note() 发出的 message 事件是单机与联机共用的提示来源。
   单机由 ui.js 的 wireGame 订阅、联机由 server/room.js 转成 msg 特效，
   两边都弹 toast，且同一个事件只弹一条。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/js/rules.js');
const { Game } = require('../src/js/game.js');

const W = 0, TI = 1, P = 2;
const c = (s, n) => s * 9 + (n - 1);
const handOf = (list) => list.map(([s, n]) => c(s, n));
const JUNK13 = handOf([
  [W, 1], [W, 4], [W, 7], [TI, 2], [TI, 5], [TI, 8],
  [P, 2], [P, 5], [P, 8], [W, 2], [TI, 3], [P, 3], [P, 9]
]);

function make(mode = 'classic') {
  const g = new Game({ mode, dealer: 0, speed: 100 });
  g.phase = 'playing';
  g.wall = [];
  g.players.forEach((p) => { p.hand = JUNK13.slice(); });
  return g;
}

/** 收集 message 旁白（客户端 toast 的唯一数据源） */
function collect(g) {
  const out = [];
  g.on('message', (text) => out.push(text));
  return out;
}

test('冲锋鸡：旁白点名打牌者与鸡的类别，并说明双倍计分', () => {
  for (const [tile, name] of [[c(TI, 1), '幺鸡'], [c(P, 8), '乌骨鸡']]) {
    const g = make();
    g.players[2].hand = JUNK13.concat([tile]);
    const notes = collect(g);
    g.discard(2, tile);
    assert.equal(notes.length, 1, '只发一条旁白');
    assert.match(notes[0], new RegExp(`冲锋鸡：对家 打出 ${name}`));
    assert.match(notes[0], /双倍/);
    assert.equal(g.log.at(-1), notes[0], '旁白同时留在本局日志里');
  }
});

test('冲幺筒：一条旁白点名打牌者与分数，分数递减，第三张后不再收分', () => {
  const g = make('yitong');
  const wild = g.mode.wild;
  const notes = collect(g);
  const chong = [];
  g.on('chong', (e) => chong.push(e));

  g.players[1].hand = JUNK13.concat([wild]);
  g.discard(1, wild);
  assert.equal(chong.length, 1, '音效事件独立于旁白');
  assert.equal(chong[0].points, R.CHONG_POINTS[0]);
  assert.equal(notes.filter((t) => t.includes('冲幺筒')).length, 1, '同一事件不重复播报');
  assert.match(notes.at(-1), /下家 打出幺筒/);
  assert.match(notes.at(-1), new RegExp(`${R.CHONG_POINTS[0]} 分`));

  for (const seat of [2, 3]) {
    g.players[seat].hand = JUNK13.concat([wild]);
    g.discard(seat, wild);
  }
  const all = notes.filter((t) => t.includes('幺筒'));
  assert.match(all[1], new RegExp(`${R.CHONG_POINTS[1]} 分`), '第二张降到 3 分');
  assert.match(all[2], /没有任何冲分|没有冲分/, '第三张只提示不再收分');
  assert.equal(chong.length, 2, '第三张不再产生收分事件');
});

test('碰、明杠、责任鸡都进旁白，且点名双方', () => {
  const g = make();
  const notes = collect(g);
  g.players[0].hand = JUNK13.concat([c(W, 3), c(W, 3)]);
  g.players[3].discards = [c(W, 3)];
  g.doPeng(0, c(W, 3), 3);
  assert.match(notes.at(-1), /你 碰 三万/);

  g.players[2].hand = JUNK13.concat([c(P, 6), c(P, 6), c(P, 6)]);
  g.players[1].discards = [c(P, 6)];
  g.phase = 'playing';
  return g.doKong(2, 'minggang', c(P, 6), 1).then(() => {
    assert.match(notes.at(-1), /对家 明杠 六筒（每份 4 分/);

    const h = make();
    const hNotes = collect(h);
    h.players[0].hand = JUNK13.concat([c(TI, 1)]);
    h.discard(0, c(TI, 1));                       // 冲锋鸡落在牌河
    h.players[1].hand = JUNK13.concat([c(TI, 1), c(TI, 1)]);
    h.doPeng(1, c(TI, 1), 0);                     // 被下家碰走 → 责任鸡
    const duty = hNotes.find((t) => t.includes('责任鸡'));
    assert.ok(duty, '责任鸡有旁白');
    assert.match(duty, /下家 拿走 你 的冲锋鸡/);
    assert.match(duty, new RegExp(`${R.RESPONSIBILITY_POINT} 分`));
  });
});

test('报听 / 天听旁白写明加成，不会和 ting 特效重复播报', () => {
  const g = new Game({ dealer: 0, speed: 100 });
  const pl = g.players[0];
  pl.hand = R.sortHand(handOf([
    [W, 1], [W, 2], [W, 3], [W, 4], [W, 5], [W, 6], [W, 7], [W, 8], [W, 9],
    [TI, 1], [TI, 2], [TI, 3], [P, 5], [TI, 9]
  ]));
  pl.justDrawn = c(TI, 9);
  pl.tingAtDeal = true;
  const notes = collect(g);
  const ting = [];
  g.on('ting', (info) => ting.push(info));
  g.awaiting = { kind: 'discard', player: 0, self: { hu: null, angang: [], bugang: [] }, resolve() {} };
  assert.equal(g.humanTing(), true);
  assert.equal(ting.length, 1);
  assert.equal(notes.length, 1, '报听只播一条');
  assert.match(notes[0], new RegExp(`天听.*\\+${R.BONUS.tianting}`));
});

test('客户端：单机订阅 message 弹 toast，冲幺筒/报听不再由特效重复弹', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/js/ui.js'), 'utf8');
  const single = src.slice(src.indexOf('function wireGame()'), src.indexOf('function recordRound('));
  assert.match(single, /on\('message', \(text\) => \{[\s\S]{0,160}?toast\(text/, '单机：旁白 → toast');
  assert.doesNotMatch(src, /toast\(`冲幺筒：向其他三家各收/, '冲幺筒提示改由旁白下发，不再重复弹');
  assert.doesNotMatch(src, /toast\(f\.tianTing \? `天听！起手就听牌/, '报听提示同上');
  assert.match(src, /const TOAST_MAX = \d+/, '密集播报时有条数上限');
});
