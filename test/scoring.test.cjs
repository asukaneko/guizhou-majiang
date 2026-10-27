'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const R = require('../src/js/rules.js');
const { Game } = require('../src/js/game.js');
const { OnlineGame } = require('../server/online-game.js');
const { snapshot } = require('../server/serialize.js');
const repeat = (tile, n) => new Array(n).fill(tile);
const ping = () => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 22];
const ready = () => ping().slice(0, -1).concat(26);
const triplets = () => [0, 0, 0, 10, 10, 10, 20, 20, 20, 3, 3, 3, 22, 22];
const junk = () => [0, 3, 6, 9, 12, 15, 18, 21, 24, 1, 10, 19, 22];
const make = (mode = 'classic') => { const g = new Game({ mode, dealer: 0, speed: 100 }); g.phase = 'playing'; return g; };
const zero = (values) => assert.equal(values.reduce((a, b) => a + b, 0), 0);

test('计分表：12种牌型在两种模式下均取指定总分，胡牌底分已包含且只取最高牌型', () => {
  const cases = [
    ['平胡', 4, ping()],
    ['大对子', 14, triplets()],
    ['七对', 24, [0,0,1,1,11,11,21,21,22,22,14,14,24,24]],
    ['龙七对', 44, [0,0,0,0,1,1,11,11,21,21,22,22,14,14]],
    ['双龙七对', 64, [...repeat(0,4),...repeat(9,4),11,11,21,21,22,22]],
    ['三龙七对', 84, [...repeat(0,4),...repeat(9,4),...repeat(20,4),22,22]],
    ['清一色', 24, [0,1,2,3,4,5,6,7,8,0,1,2,4,4]],
    ['清大对', 34, [0,0,0,1,1,1,2,2,2,3,3,3,4,4]],
    ['清七对', 44, [0,0,1,1,2,2,3,3,4,4,5,5,6,6]],
    ['清龙七对', 64, [...repeat(0,4),2,2,3,3,4,4,6,6,8,8]],
    ['清双龙七对', 84, [...repeat(0,4),...repeat(2,4),4,4,6,6,8,8]],
    ['清三龙七对', 104, [...repeat(0,4),...repeat(2,4),...repeat(4,4),6,6]]
  ];
  for (const mode of ['classic', 'yitong']) for (const [name, points, hand] of cases) {
    assert.ok(R.counts(hand).every((n) => n <= 4));
    const info = R.winInfo(hand, [], mode);
    assert.equal(info?.name, name, mode);
    assert.equal(info.points, points, `${mode}/${name}`);
  }
});

test('龙七对：财神可补对子，双龙三龙按实牌四张组数识别，副露后不算七对', () => {
  const hand = [...repeat(0,4),...repeat(9,4),...repeat(20,4),18,22];
  assert.equal(R.winInfo(hand, [], 'classic'), null);
  const soft = R.winInfo(hand, [], 'yitong');
  assert.equal(soft.name, '三龙七对'); assert.equal(soft.points, 84);
  assert.equal(soft.joker, 1); assert.equal(soft.hardBonus, 0);
  const exposed = R.winInfo([0,0,0,2,2,2,4,4,4,6,6], [{ type:'peng', tile:8, tiles:[8,8,8] }], 'classic');
  assert.equal(exposed.name, '清大对'); assert.equal(exposed.points, 34);
});

test('胡牌附加：报听20、天听40、天胡60、地胡30、热炮20，天听替代报听且自摸分不变', () => {
  const cases = [
    [{ selfDraw:true }, {}, 5],
    [{ selfDraw:true, gangFlower:true }, {}, 6],
    [{ selfDraw:true }, { tingDeclared:true }, 25],
    [{ selfDraw:true }, { tingDeclared:true, tianTing:true }, 45],
    [{ selfDraw:true, tianhu:true }, {}, 65],
    [{ selfDraw:true, dihu:true }, {}, 35]
  ];
  for (const [options, state, points] of cases) {
    const g = make(); Object.assign(g.players[0], state, { hand:ping() });
    const result = g.settleWin([{ p:0, winTile:22 }], options);
    assert.equal(result.winners[0].points, points);
    assert.deepEqual(result.winDeltas, [points * 3, -points, -points, -points]);
    zero(result.deltas);
  }
  const hot = make(); hot.players[0].hand = triplets().slice(0, -1);
  const result = hot.settleWin([{ p:0, winTile:22 }], { selfDraw:false, from:1, repao:true });
  assert.equal(result.winners[0].points, 34); assert.deepEqual(result.winDeltas, [34,-34,0,0]);
});

test('抢杠多响：抢杠同样看吃炮门槛，平胡抢不了、清一色能抢，补杠不收豆分', async () => {
  const g = make();
  // 1 号平胡（听 4）：低于 14 分，抢不了杠
  g.players[1].hand = [0,1,2,3,5,9,10,11,18,19,20,22,22];
  // 2 号清一色（也听 4）：24 分，够门槛，可以抢
  g.players[2].hand = [0,1,2,3,5,6,7,8,0,1,2,8,8];
  g.players[3].hand = [4]; g.players[3].melds = [{ type:'peng', tile:4, tiles:[4,4,4] }];
  const plainInfo = R.winInfo(g.players[1].hand.concat(4), [], 'classic');
  assert.equal(plainInfo.name, '平胡');
  assert.equal(R.canChiPao(plainInfo), false);
  assert.equal(R.canChiPao(R.winInfo(g.players[2].hand.concat(4), [], 'classic')), true);
  assert.equal(await g.doKong(3, 'bugang', 4), false);
  // 只有清一色那家抢到：24 + 抢杠 20 = 44，补杠者(3 号)付一份，平胡那家不参与。
  assert.deepEqual(g.result.winners.map((w) => w.p), [2]);
  assert.deepEqual(g.result.winners.map((w) => w.points), [44]);
  assert.deepEqual(g.result.winDeltas, [0,0,44,-44]);
  assert.equal(g.kongLog.length, 0); assert.equal(g.players[3].melds[0].type, 'peng');
  zero(g.result.deltas);
});

test('首轮报听：首次出牌前无副露可声明，出牌被碰走后仍禁止；联机、快照和客户端一致', async () => {
  const g = make(); g.players[0].hand = ready();
  assert.equal(g.canTing(0), true);
  g.discard(0, 26); g.players[1].hand = [26,26]; g.doPeng(1, 26, 0);
  assert.deepEqual(g.players[0].discards, []); assert.equal(g.players[0].discardCount, 1);
  g.players[0].hand = ready();
  let resolved = false;
  g.awaiting = { kind:'discard', player:0, self:g.selfActions(0), resolve() { resolved = true; } };
  assert.equal(g.canTing(0), false); assert.equal(g.humanTing(), false); assert.equal(resolved, false);

  const online = new OnlineGame({ mode:'classic', dealer:0, speed:100, seats:[{ type:'human' }] }); online.phase = 'playing';
  online.players[0].hand = ready(); online.players[0].discardCount = 1;
  const pending = online.waitRemoteDiscard(0, online.selfActions(0));
  const prompt = online.prompts.get(0);
  assert.match(online.remoteAction(0, { type:'ting', promptId:prompt.id }).err, /首次出牌/);
  assert.equal(online.prompts.get(0), prompt);
  const snap = snapshot(online, 0); assert.equal(snap.players[0].discardCount, 1);
  const ctx = vm.createContext({ GZRules:R, GZNet:{ send:() => true } }); ctx.window = ctx;
  vm.runInContext(fs.readFileSync(require.resolve('../src/js/remote-game.js'), 'utf8'), ctx);
  const remote = new ctx.GZRemoteGame.RemoteGame(); remote.applySnapshot(snap);
  assert.equal(remote.canTing(0), false);
  online.abort(); await pending;
  online.players[0].discardCount = 0;
  online.phase = 'playing'; const first = online.waitRemoteDiscard(0, online.selfActions(0));
  assert.equal(online.remoteAction(0, { type:'ting' }).ok, true);
  assert.equal((await first).type, 'discard'); assert.equal(online.players[0].tianTing, false);
  assert.equal(online.players[0].tingDeclared, true);
  online.abort(); g.abort();
});

test('联机报听与本地同口径：只有庄家起手听牌算天听，快照只给本人带起手听牌状态', async () => {
  const run = async (dealer) => {
    const g = new OnlineGame({ mode:'classic', dealer, speed:100, seats:[{ type:'human' }] });
    g.phase = 'playing';
    const me = g.players[0];
    me.hand = ready(); me.justDrawn = 26;
    me.tingAtDeal = true;                    // 配完 13 张就听牌
    g.players[1].tingAtDeal = true;           // 别人也起手听牌，但不下发
    const notes = [];
    g.on('message', (t) => notes.push(t));
    const pending = g.waitRemoteDiscard(0, g.selfActions(0));
    const prompt = g.prompts.get(0);
    assert.equal(g.remoteAction(0, { type:'ting', promptId: prompt.id }).ok, true);
    const snap = snapshot(g, 0);
    assert.equal((await pending).type, 'discard');
    g.abort();
    return { me, notes, snap };
  };

  const host = await run(0);                  // 自己是庄家
  assert.equal(host.me.tingDeclared, true);
  assert.equal(host.me.tianTing, true, '庄家起手听 = 天听');
  assert.match(host.notes.at(-1), /天听/);
  assert.equal(host.snap.players[0].tingAtDeal, true);
  assert.equal(host.snap.players[1].tingAtDeal, false, '别人的起手听牌状态不下发');

  const guest = await run(1);                 // 庄家是下家
  assert.equal(guest.me.tianTing, false, '非庄家起手听只算报听');
  assert.match(guest.notes.at(-1), /报听/);
});

test('杠与责任鸡：杠每份4、责任鸡2分，操作时只记账不扣分', async () => {
  for (const type of ['minggang','angang','bugang']) {
    const g = make();
    g.players[0].hand = repeat(0, type === 'angang' ? 4 : type === 'minggang' ? 3 : 1);
    if (type === 'bugang') g.players[0].melds = [{ type:'peng', tile:0, tiles:[0,0,0] }];
    assert.equal(await g.doKong(0, type, 0, 1), true);
    assert.deepEqual(g.scores, [0,0,0,0]);
    assert.deepEqual(g.roundDeltas, [0,0,0,0]);
    assert.equal(g.kongLog[0].points, 4);
    assert.equal(g.kongLog[0].settled, false);
    assert.deepEqual(g.kongLog[0].payers, type === 'minggang' ? [1] : [1,2,3]);
    g.abort();
  }
  const g = make(); g.players[0].hand = [9,9,9]; g.players[1].hand = [9];
  g.discard(1, 9); await g.doKong(0, 'minggang', 9, 1);
  assert.deepEqual(g.kongLog[0].deltas, [0,0,0,0]);
  assert.equal(g.penaltyLog[0].points, 2); assert.deepEqual(g.scores, [0,0,0,0]);
  g.abort();
});

test('吃炮门槛：没豆要 14 分边界，有豆是通行证（平胡也能点炮）；报听、硬胡加分不算', () => {
  assert.equal(R.canChiPao({ points:13, kongs:0 }), false);
  assert.equal(R.canChiPao({ points:14, kongs:0 }), true);
  assert.equal(R.canChiPao({ points:4, kongs:0 }), false, '没豆的平胡不能点炮');
  assert.equal(R.canChiPao({ points:4, kongs:1 }), true, '有豆的平胡可以点炮');
  assert.equal(R.canChiPao({ points:4, kongs:2, hardBonus:5 }), true, '豆按杠数算，硬胡加成不影响');
  assert.equal(R.canChiPao(null), false);
});

test('有豆的平胡：普通点炮能胡，没豆的平胡胡不了', () => {
  // 有 1 个豆（杠）的平胡：手上 10 张，等 22（三万）
  const kongInfo = R.winInfo(
    [0,1,2,3,4,5,9,10,11,22].concat(22),
    [{ type:'gang', tile:26, tiles:[26,26,26,26], from:0 }],
    'classic'
  );
  assert.equal(kongInfo.name, '平胡');
  assert.equal(kongInfo.kongs, 1);
  assert.equal(R.canChiPao(kongInfo), true, '有豆的平胡过门槛，可以点炮');

  // 没豆的平胡：手上 13 张，同样等 22
  const plainInfo = R.winInfo([0,1,2,3,4,5,9,10,11,18,19,20,22].concat(22), [], 'classic');
  assert.equal(plainInfo.name, '平胡');
  assert.equal(plainInfo.kongs, 0);
  assert.equal(R.canChiPao(plainInfo), false, '没豆的平胡不过门槛');
});

test('黄庄：按最高牌型分查叫，清三龙七对104分，忽略报听硬胡加分', () => {
  for (const mode of ['classic','yitong']) {
    const g = make(mode);
    g.players[0].hand = [...repeat(0,4),...repeat(2,4),...repeat(4,4),6];
    g.players[0].tingDeclared = true; g.players[0].tianTing = true;
    g.players[1].hand = ping().slice(0, -1);
    g.players[2].hand = junk(); g.players[3].hand = junk();
    assert.equal(R.tenpaiTiles(junk(), [], mode).length, 0);
    const result = g.settleDraw();
    assert.equal(result.ting[0].points, 104); assert.equal(result.ting[1].points, 4);
    assert.deepEqual(result.deltas, [208,8,-108,-108]); zero(result.scores);
  }
});
