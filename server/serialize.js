/* 按座位下发的对局快照。
 *
 * 关键点：客户端 UI 永远把「你」当作 0 号位，所以序列化时把整桌按
 * 观战者旋转一圈；手牌、暗杠牌面只发给本人，其余座位只发张数。
 */
'use strict';

const rotateSeat = (seat, forSeat) => (seat - forSeat + 4) % 4;

const rotateArray = (arr, forSeat) =>
  Array.isArray(arr) ? arr.slice(forSeat).concat(arr.slice(0, forSeat)) : arr;

const optSeat = (seat, forSeat) =>
  seat === undefined || seat === null ? seat : rotateSeat(seat, forSeat);

function meldView(meld, mine, forSeat) {
  return {
    type: meld.type,
    tile: mine || meld.type !== 'angang' ? meld.tile : null,
    from: optSeat(meld.from, forSeat),
    // 暗杠只发给杠家本人，别人只看到 4 张背面
    tiles: mine || meld.type !== 'angang' ? meld.tiles.slice() : []
  };
}

function penaltyView(list, forSeat) {
  return (list || []).map((k) => ({
    kind: k.kind,
    p: rotateSeat(k.p, forSeat),
    to: optSeat(k.to, forSeat),
    points: k.points,
    seq: k.seq,
    label: k.label,
    deltas: rotateArray(k.deltas, forSeat)
  }));
}

function kongView(list, forSeat) {
  return (list || []).map((k) => ({
    p: rotateSeat(k.p, forSeat), type: k.type, tile: k.tile, deltas: rotateArray(k.deltas, forSeat)
  }));
}

function publicResult(game, forSeat) {
  const res = game.result;
  if (!res) return null;
  const out = {
    draw: !!res.draw,
    mode: res.mode,
    dealer: rotateSeat(game.dealer, forSeat)
  };
  if (res.draw) {
    out.ting = rotateArray(res.ting, forSeat).map((t) => ({
      tiles: t.tiles.slice(), points: t.points
    }));
    out.deltas = rotateArray(res.deltas, forSeat);
    out.scores = rotateArray(res.scores, forSeat);
    out.kongLog = kongView(res.kongLog, forSeat);
    out.penaltyLog = penaltyView(res.penaltyLog, forSeat);
    out.chongLog = (res.chongLog || []).map((k) => ({
      kind: k.kind, p: rotateSeat(k.p, forSeat), points: k.points, seq: k.seq, label: k.label
    }));
    return out;
  }

  out.winners = (res.winners || []).map((w) => ({
    p: rotateSeat(w.p, forSeat),
    winTile: w.winTile,
    selfDraw: !!w.selfDraw,
    from: optSeat(w.from, forSeat),
    hand: w.hand.slice(),
    melds: w.melds.map((m) => ({ type: m.type, tile: m.tile, from: optSeat(m.from, forSeat), tiles: m.tiles.slice() })),
    info: w.info,
    points: w.points,
    extra: (w.extra || []).slice(),
    hard: w.hard,
    joker: w.joker
  }));
  out.robKong = !!res.robKong;
  out.winTile = res.winTile;
  out.winDeltas = rotateArray(res.winDeltas, forSeat);
  out.flip = res.flip !== undefined ? res.flip : null;
  out.chickens = (res.chickens || []).map((c) => ({ tile: c.tile, rate: c.rate, kind: c.kind }));
  out.chickenCount = rotateArray(res.chickenCount, forSeat);
  out.chickenDeltas = rotateArray(res.chickenDeltas, forSeat);
  out.chongLog = (res.chongLog || []).map((k) => ({
    kind: k.kind, p: rotateSeat(k.p, forSeat), points: k.points, seq: k.seq, label: k.label
  }));
  out.charge = res.charge ? { p: rotateSeat(res.charge.p, forSeat), tile: res.charge.tile } : null;
  out.baoji = (res.baoji || []).map((b) => ({
    p: rotateSeat(b.p, forSeat), to: rotateSeat(b.to, forSeat), points: b.points
  }));
  out.isTing = rotateArray(res.isTing, forSeat);
  out.kongLog = kongView(res.kongLog, forSeat);
  out.penaltyLog = penaltyView(res.penaltyLog, forSeat);
  out.deltas = rotateArray(res.deltas, forSeat);
  out.scores = rotateArray(res.scores, forSeat);
  return out;
}

/**
 * @param {object} game OnlineGame 实例（含 prompts / totalRounds）
 * @param {number} forSeat 服务器侧真实座位号
 */
function snapshot(game, forSeat) {
  const players = game.players.map((p, i) => {
    const mine = i === forSeat;
    return {
      id: rotateSeat(i, forSeat),
      name: p.name,
      isHuman: !!p.isHuman,
      botPlay: !!p.botPlay,
      isBot: !p.isHuman,
      hand: mine ? p.hand.slice() : [],
      handCount: p.hand.length,
      melds: p.melds.map((m) => meldView(m, mine, forSeat)),
      discards: p.discards.slice(),
      discardCount: p.discardCount,
      said: p.said,
      tingDeclared: !!p.tingDeclared,
      tianTing: !!p.tianTing,
      justDrawn: mine ? p.justDrawn : null
    };
  }).sort((a, b) => a.id - b.id);

  const prompt = game.prompts ? game.prompts.get(forSeat) : null;
  let awaiting = null;
  if (prompt) {
    awaiting = {
      id: prompt.id,
      kind: prompt.kind,
      player: 0,
      self: prompt.self || null,
      options: prompt.options || null,
      tile: prompt.tile !== undefined ? prompt.tile : null,
      from: optSeat(prompt.from, forSeat),
      info: prompt.info || null,
      rob: !!prompt.rob
    };
  } else if (game.awaiting && game.awaiting.auto && game.awaiting.player === forSeat) {
    // 报听锁牌和人机代打：向本人展示即将执行的操作。
    const a = game.awaiting;
    awaiting = {
      kind: 'discard', player: 0, auto: true, ting: !!a.ting,
      autoTile: a.autoTile !== undefined ? a.autoTile : null,
      autoAction: a.autoAction, autoGangType: a.autoGangType,
      self: a.self || { hu: null, angang: [], bugang: [] }
    };
  }

  return {
    phase: game.phase,
    mode: game.mode.id,
    aiDifficulty: game.aiDifficulty,
    botSpeed: game.botSpeed,
    roundNo: game.roundNo,
    roundId: game.roundId,
    dealer: rotateSeat(game.dealer, forSeat),
    turn: rotateSeat(game.turn, forSeat),
    wallLeft: game.wall.length,
    scores: rotateArray(game.scores, forSeat),
    roundDeltas: rotateArray(game.roundDeltas, forSeat),
    lastDiscard: game.lastDiscard
      ? { p: rotateSeat(game.lastDiscard.p, forSeat), tile: game.lastDiscard.tile }
      : null,
    discardSeq: game.discardSeq,
    discardHot: !!game.discardHot,
    chongCount: game.chongCount || 0,
    firstChicken: game.firstChicken
      ? { p: rotateSeat(game.firstChicken.p, forSeat), tile: game.firstChicken.tile, taken: !!game.firstChicken.taken }
      : null,
    players,
    awaiting,
    autoPlay: !!game.players[forSeat].botPlay,
    result: publicResult(game, forSeat),
    totalRounds: game.totalRounds || 0
  };
}

module.exports = { snapshot, rotateSeat, rotateArray };
