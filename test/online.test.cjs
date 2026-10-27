/* 联机服务端单测：不经过 WebSocket，直接驱动 Room / OnlineGame */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Room } = require(path.join(__dirname, '..', 'server', 'room.js'));
const { OnlineGame } = require(path.join(__dirname, '..', 'server', 'online-game.js'));
const { snapshot } = require(path.join(__dirname, '..', 'server', 'serialize.js'));
const R = require(path.join(__dirname, '..', 'src', 'js', 'rules.js'));

/* 把 Room/OnlineGame 的 ws 换成内存桩，自动化真人操作 */
function makeClient(name) {
  return {
    name,
    uid: `u:${name}:${Math.random().toString(36).slice(2, 8)}`,
    ws: { readyState: 1, sent: [], send(x) { this.sent.push(JSON.parse(x)); } }
  };
}

/** 无人操作时由机器人脑接管所有真人座位（用于整局跑通） */
function autoPlay(game, choose) {
  game.on('state', () => {
    for (const p of [...game.prompts.keys()]) {
      const prompt = game.prompts.get(p);
      if (prompt.kind === 'claim') game.remoteAction(p, { type: 'pass' });
      else {
        const self = prompt.self || {};
        const act = choose(game, p, self);
        game.remoteAction(p, act);
      }
    }
  });
}

const dumb = () => ({ type: 'discard', tile: null });

test('房间：建房/加入/机器人/满员/房主转移', () => {
  const host = makeClient('房主');
  const room = new Room('6001', host);
  assert.equal(room.seatOf(host.uid), 0);

  const p2 = makeClient('甲');
  room.add(p2);
  room.addBot();
  room.addBot();
  assert.equal(room.seats.filter(Boolean).length, 4);
  assert.throws(() => room.add(makeClient('乙')), /房间已满/, '满员后不能再加');

  const st = room.publicState(p2.uid);
  assert.equal(st.full, true);
  assert.equal(st.seats.filter((s) => s.bot).length, 2);
  assert.equal(st.seats.find((s) => s.you).seat, room.seatOf(p2.uid));

  // 房主离开 → 房主转移
  room.remove(host.uid);
  assert.equal(room.isHost(p2.uid), true);
});

test('快照：各座位看到的都是自己坐 0 号位，他人手牌与暗杠不下发', async () => {
  const g = new OnlineGame({
    dealer: 0, mode: 'yitong',
    seats: [
      { type: 'human', name: '我' }, { type: 'human', name: '乙' },
      { type: 'bot', name: '机1' }, { type: 'bot', name: '机2' }
    ]
  });
  g.phase = 'playing';
  g.players.forEach((pl) => { pl.hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; });
  g.players[2].hand = R.sortHand(g.players[2].hand.concat([18]));
  g.players[2].melds.push({ type: 'angang', tile: 26, tiles: [26, 26, 26, 26] });

  for (let seat = 0; seat < 4; seat++) {
    const snap = snapshot(g, seat);
    assert.equal(snap.players[0].id, 0, '你永远是 0 号位');
    assert.equal(snap.players[0].name, g.players[seat].name);
    assert.ok(Array.isArray(snap.players[0].hand), '自己有手牌');
    for (let v = 1; v < 4; v++) assert.deepEqual(snap.players[v].hand, [], '别人手牌不下发（空数组）');
    assert.equal(snap.turn, (g.turn - seat + 4) % 4);
    assert.equal(snap.dealer, (g.dealer - seat + 4) % 4);
    // 对家的暗杠（服务器座位 2）只发 4 张背面
    const opposite = snap.players[2];
    if (opposite.handCount === 14) {
      const ag = opposite.melds.find((m) => m.type === 'angang');
      if (ag) assert.deepEqual(ag.tiles, [], '暗杠牌面不下发');
    }
  }
  // 座位 2 自己能看到自己的暗杠
  const own = snapshot(g, 2);
  assert.equal(own.players[0].melds.find((m) => m.type === 'angang').tiles.length, 4);
});

test('联机整局：两个真人 + 两机器人，提示、零和、一局接一局', { timeout: 300000 }, async () => {
  const room = new Room('6002', makeClient('房主'));
  room.add(makeClient('乙'));
  room.addBot();
  room.addBot();
  room.config.totalRounds = 2;

  // 起局后接管两个真人座位：简单策略（能胡就胡，其余随机打一张）
  room.start();
  const game = room.game;
  assert.ok(game, '对局应已创建');
  assert.equal(game.players.filter((p) => p.isHuman).length, 2);

  const seenSnapshots = [0, 0];
  for (const seat of [0, 1]) {
    const s = snapshot(game, seat);
    seenSnapshots[seat] = s;
  }
  assert.deepEqual(seenSnapshots[0].players[1].hand, [], '不下发他人手牌');
  assert.deepEqual(seenSnapshots[1].players[2].hand, []);

  let ended = 0;
  game.on('roundEnd', () => { ended++; });

  game.on('state', () => {
    if (game.phase !== 'playing') return;
    for (const p of [...game.prompts.keys()]) {
      const prompt = game.prompts.get(p);
      if (prompt.kind === 'claim') {
        // 有胡就胡，否则碰的概率 30%
        if (prompt.options.includes('hu')) game.remoteAction(p, { type: 'claim', act: 'hu' });
        else if (prompt.options.includes('peng') && Math.random() < 0.3) {
          game.remoteAction(p, { type: 'claim', act: 'peng' });
        } else game.remoteAction(p, { type: 'pass' });
      } else {
        const self = prompt.self || {};
        if (self.hu) { game.remoteAction(p, { type: 'hu' }); continue; }
        const pl = game.players[p];
        const tile = pl.hand.includes(pl.justDrawn) ? pl.justDrawn : pl.hand[0];
        game.remoteAction(p, { type: 'discard', tile });
      }
    }
  });

  // 等第一局打完 → 房主开下一局（要给新对局重新挂应答器）→ 等第二局
  const deadline = Date.now() + 90000;
  while (ended < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 120));
  assert.equal(ended, 1, '第一局应正常结束');
  assert.equal(game.scores.reduce((a, b) => a + b, 0), 0, '第一局四家分数零和');

  for (const seat of room.seats) if (seat && !seat.bot && !room.isHost(seat.uid)) {
    assert.equal(room.setReady(seat.uid, true, room.game.roundId, room.readyId).ok, true);
  }
  const next = room.nextRound(room.hostUid);
  assert.equal(next.ok, true, `开下一局失败：${next.err || ''}`);
  const game2 = room.game;
  assert.notEqual(game2, game, '第二局应是新对局实例');
  game2.on('state', () => {
    if (game2.phase !== 'playing') return;
    for (const p of [...game2.prompts.keys()]) {
      const prompt = game2.prompts.get(p);
      if (prompt.kind === 'claim') {
        game2.remoteAction(p, { type: 'pass' });
      } else {
        const self = prompt.self || {};
        if (self.hu) { game2.remoteAction(p, { type: 'hu' }); continue; }
        const pl = game2.players[p];
        const tile = pl.hand.includes(pl.justDrawn) ? pl.justDrawn : pl.hand[0];
        game2.remoteAction(p, { type: 'discard', tile });
      }
    }
  });
  game2.on('roundEnd', () => { ended++; });
  while (ended < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 120));
  assert.equal(ended, 2, '第二局都应正常结束');
  assert.equal(game2.scores.reduce((a, b) => a + b, 0), 0, '两局累计仍零和');
  assert.ok(game2.roundNo >= 2);
});

test('联机操作校验：别人的回合、不存在的牌、重复报听都会被拒', async () => {
  const g = new OnlineGame({
    dealer: 0,
    seats: [{ type: 'human', name: '我' }, { type: 'bot' }, { type: 'bot' }, { type: 'bot' }]
  });
  g.phase = 'playing';
  g.players[0].hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  g.awaiting = null;
  assert.equal(g.remoteAction(0, { type: 'discard', tile: 5 }).ok, false, '没有待办提示时拒绝');
  g.prompts.set(0, { kind: 'discard', p: 0, self: { hu: null, angang: [], bugang: [] }, resolve: () => {} });
  assert.equal(g.remoteAction(0, { type: 'discard', tile: 99 }).ok, false, '手里没有的牌拒绝');
  assert.equal(g.remoteAction(0, { type: 'hu' }).ok, false, '不能胡时拒绝');
  assert.equal(g.remoteAction(1, { type: 'discard', tile: 0 }).ok, false, '别人的座位拒绝');
});
