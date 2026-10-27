/* 房间：座位管理、机器人、规则配置、对局编排 */
'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const R = require(path.join(__dirname, '..', 'src', 'js', 'rules.js'));
const { OnlineGame } = require('./online-game.js');
const { snapshot, rotateSeat } = require('./serialize.js');

const BOT_NAMES = ['阿贵', '小幺', '老陈', '顺子', '幺妹', '排骨', '茶客', '雀友'];

class Room {
  constructor(id, host, gameOptions = {}) {
    this.id = id;                       // 房号（字符串）
    this.seats = [null, null, null, null]; // {uid, name, ws, bot}
    this.config = { mode: 'classic', totalRounds: 4 };
    this.game = null;
    this.resetScoresOnNewTable = false;
    this.fx = [];
    this.hostUid = host.uid;
    this.created = Date.now();
    this.gameOptions = gameOptions;
    this.add(host);
  }

  /* ---------------- 座位 ---------------- */

  seatOf(uid) {
    return this.seats.findIndex((s) => s && s.uid === uid);
  }

  add(player) {
    if (this.seatOf(player.uid) >= 0) return this.seatOf(player.uid);
    if (this.game && ['dealing', 'playing'].includes(this.game.phase)) throw new Error('对局中不能加入，请等本局结束');
    const idx = this.seats.findIndex((s) => s === null);
    if (idx < 0) throw new Error('房间已满');
    this.seats[idx] = { uid: player.uid, name: player.name, ws: player.ws, bot: false, offline: false };
    return idx;
  }

  remove(uid, voluntary = false) {
    const idx = this.seatOf(uid);
    if (idx < 0) return false;
    const wasHost = this.hostUid === uid;
    if (wasHost && voluntary) this.resetScoresOnNewTable = true;
    const seat = this.seats[idx];
    this.seats[idx] = this.game ? {
      uid: `bot:${randomUUID()}`, name: `${seat.name}(代打)`, ws: null, bot: true
    } : null;
    if (this.game) {
      const pl = this.game.players[idx];
      pl.isHuman = false;            // 掉线转电脑代打
      pl.name = `${seat.name}(代打)`;
      this.game.dropPrompt(idx);
    }
    if (wasHost) {
      const next = this.seats.find((s) => s && !s.bot && !s.offline);
      if (next) this.hostUid = next.uid;
    }
    return true;
  }

  addBot() {
    if (this.game && ['dealing', 'playing'].includes(this.game.phase)) return { ok: false, err: '对局中不能添加机器人' };
    const idx = this.seats.findIndex((s) => s === null);
    if (idx < 0) return { ok: false, err: '房间已满' };
    const used = this.seats.filter(Boolean).map((s) => s.name);
    const name = BOT_NAMES.find((n) => !used.includes(n)) || `机器人${idx + 1}`;
    this.seats[idx] = { uid: `bot:${idx}:${Date.now()}`, name, ws: null, bot: true };
    return { ok: true };
  }

  removeBot(uid) {
    const idx = this.seatOf(uid);
    if (idx < 0 || !this.seats[idx].bot) return { ok: false, err: '不是机器人' };
    if (this.game && ['dealing', 'playing'].includes(this.game.phase)) return { ok: false, err: '对局中不能移除机器人' };
    this.seats[idx] = null;
    return { ok: true };
  }

  humans() {
    return this.seats.map((s, i) => (s && !s.bot ? i : -1)).filter((i) => i >= 0);
  }

  isHost(uid) { return this.hostUid === uid; }

  tableFinished() {
    return !!this.game && this.game.phase === 'ended' &&
      this.game.roundNo >= (this.game.totalRounds || this.config.totalRounds);
  }

  disconnect(uid) {
    const idx = this.seatOf(uid);
    if (idx < 0) return;
    const seat = this.seats[idx];
    seat.ws = null;
    seat.offline = true;
    if (this.game) {
      this.game.players[idx].isHuman = false;
      this.game.players[idx].name = `${seat.name}(代打)`;
      this.game.dropPrompt(idx);
    }
    if (this.isHost(uid)) {
      const next = this.seats.find((s) => s && !s.bot && !s.offline);
      if (next) this.hostUid = next.uid;
    }
  }

  reconnect(player) {
    const idx = this.seatOf(player.uid);
    if (idx < 0) return false;
    Object.assign(this.seats[idx], { ws: player.ws, name: player.name, offline: false });
    if (this.game) {
      Object.assign(this.game.players[idx], { isHuman: true, name: player.name });
    }
    const host = this.seats.find((s) => s && s.uid === this.hostUid && !s.bot && !s.offline);
    if (!host) this.hostUid = player.uid;
    return true;
  }

  rename(uid, name) {
    const idx = this.seatOf(uid);
    if (idx < 0) return;
    this.seats[idx].name = name;
    if (this.game) this.game.players[idx].name = name;
  }

  /* ---------------- 广播 ---------------- */

  publicState(forUid) {
    const seat = this.seatOf(forUid);
    return {
      id: this.id,
      host: this.isHost(forUid),
      config: { ...this.config },
      running: !!this.game && this.game.phase === 'playing',
      finished: this.tableFinished(),
      resetScoresOnNewTable: this.resetScoresOnNewTable,
      full: this.seats.every(Boolean),
      roundNo: this.game ? this.game.roundNo : 0,
      totalRounds: this.game ? (this.game.totalRounds || this.config.totalRounds) : this.config.totalRounds,
      standings: this.game ? this.game.scores.slice() : [0, 0, 0, 0],
      seats: this.seats.map((s, i) => ({
        uid: s ? s.uid : null,
        seat: i,
        name: s ? s.name : null,
        bot: s ? s.bot : false,
        offline: !!(s && s.offline),
        host: s ? s.uid === this.hostUid : false,
        you: i === seat
      }))
    };
  }

  broadcastRoom() {
    for (const s of this.seats) {
      if (s && !s.bot && s.ws && s.ws.readyState === 1) {
        s.ws.send(JSON.stringify({ t: 'room', room: this.publicState(s.uid) }));
      }
    }
  }

  pushFx(fx) { this.fx.push(fx); }

  rotateFx(forSeat, effects = this.fx) {
    const rotateOne = (f) => {
      const out = { ...f };
      if (out.type === 'call' && out.text === '暗杠' && out.p !== forSeat) out.tile = null;
      if (out.p !== undefined && out.p !== null) out.p = rotateSeat(out.p, forSeat);
      if (out.to !== undefined && out.to !== null) out.to = rotateSeat(out.to, forSeat);
      return out;
    };
    const list = effects.map(rotateOne);
    return list;
  }

  broadcastGame() {
    if (!this.game) return;
    this.sendSnapshotTo(null);
  }

  /** 给某个座位（或全部真人座位）补发一份带全部未播 fx 的快照 */
  sendSnapshotTo(seat) {
    if (!this.game) return;
    // 单人同步不能消费所有人的广播事件，也不重放已经播过的特效。
    const fx = seat === null ? this.fx.splice(0) : [];
    for (let s = 0; s < 4; s++) {
      if (seat !== null && s !== seat) continue;
      const pl = this.seats[s];
      if (!pl || pl.bot || !pl.ws || pl.ws.readyState !== 1) continue;
      const snap = snapshot(this.game, s);
      snap.roomId = this.id;
      pl.ws.send(JSON.stringify({ t: 'snapshot', snap, fx: this.rotateFx(s, fx) }));
    }
  }

  /* ---------------- 对局 ---------------- */

  start(newTable = false) {
    if (this.game && ['dealing', 'playing'].includes(this.game.phase)) return { ok: false, err: '对局已经开始' };
    if (newTable && !this.tableFinished()) return { ok: false, err: '本桌还没打完' };
    if (!newTable && this.tableFinished()) {
      return { ok: false, err: `已打满约定的 ${this.game.totalRounds || this.config.totalRounds} 局，请在房间开启新的一桌` };
    }
    const empty = this.seats.findIndex((s) => s === null);
    if (empty >= 0) return { ok: false, err: '还有空位，先加机器人或等玩家加入' };
    if (this.seats.some((s) => !s.bot && s.offline)) return { ok: false, err: '有玩家正在重连，请等待或稍后补位' };

    const previousGame = this.game;
    const prev = newTable ? null : previousGame;
    const scores = previousGame && !(newTable && this.resetScoresOnNewTable) ? previousGame.scores.slice() : [0, 0, 0, 0];
    const roundNo = prev ? prev.roundNo + 1 : 1;
    const dealer = prev ? (prev.nextDealer != null ? prev.nextDealer : prev.dealer) : 0;

    const seats = this.seats.map((s) => ({ type: s.bot || s.offline ? 'bot' : 'human', uid: s.uid, name: s.name, botPlay: !!s.botPlay }));
    this.game = new OnlineGame({
      mode: this.config.mode,
      speed: 1.1,
      ...this.gameOptions,
      totalRounds: this.config.totalRounds,
      scores,
      roundNo,
      dealer,
      seats
    });
    if (newTable) this.resetScoresOnNewTable = false;
    if (previousGame) previousGame.abort();
    this.fx = [];
    const game = this.game;
    game.on('discard', (d) => this.pushFx({ type: 'discard', p: d.p, tile: d.tile }));
    game.on('call', (c) => this.pushFx({ type: 'call', p: c.p, text: c.text, tile: c.tile }));
    game.on('chong', (e) => this.pushFx({ type: 'chong', p: e.p, points: e.points }));
    game.on('ting', (i) => this.pushFx({ type: 'ting', p: i.p, tianTing: !!i.tianTing }));
    game.on('blocked', () => this.pushFx({ type: 'blocked' }));
    game.on('message', (text) => this.pushFx({ type: 'msg', text }));
    game.on('state', () => { if (this.game === game) this.broadcastGame(); });
    game.on('roundEnd', () => {
      if (this.game !== game) return;
      this.broadcastGame();
      this.broadcastRoom();
    });
    game.on('error', () => {
      game.abort();
      this.broadcastRoom();
      for (const s of this.seats) {
        if (s && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ t: 'error', err: '对局异常，已停止本局，请重新建房' }));
      }
    });
    game.startRound();
    this.broadcastRoom();
    this.sendSnapshotTo(null);   // 立刻给所有真人补发发牌快照（含刚进场的玩家）
    return { ok: true };
  }

  nextRound(uid) {
    if (!this.isHost(uid)) return { ok: false, err: '只有房主能开下一局' };
    if (!this.game) return { ok: false, err: '对局还没开始' };
    if (this.game.phase === 'playing') return { ok: false, err: '这一局还没打完' };
    return this.start();
  }

  newTable(uid) {
    if (!this.isHost(uid)) return { ok: false, err: '只有房主能开启新的一桌' };
    return this.start(true);
  }

  action(uid, action) {
    if (!this.game) return { ok: false, err: '对局还没开始' };
    const seat = this.seatOf(uid);
    if (seat < 0) return { ok: false, err: '你不在房间里' };
    const res = this.game.remoteAction(seat, action);
    if (res.ok && action.type === 'autoplay') this.seats[seat].botPlay = action.enabled;
    if (res.ok) this.broadcastGame();
    return res;
  }

  abort() {
    if (this.game) {
      const game = this.game;
      this.game = null;
      game.abort();
      this.fx = [];
    }
  }

  setConfig(uid, cfg, broadcast = true) {
    if (!this.isHost(uid)) return { ok: false, err: '只有房主能改规则' };
    if (this.game && ['dealing', 'playing'].includes(this.game.phase)) return { ok: false, err: '对局中不能改规则' };
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, err: '规则格式不正确' };
    if (cfg.mode !== undefined && !Object.hasOwn(R.MODES, cfg.mode)) return { ok: false, err: '未知玩法' };
    if (cfg.totalRounds !== undefined && (!Number.isInteger(cfg.totalRounds) || cfg.totalRounds < 1 || cfg.totalRounds > 64)) {
      return { ok: false, err: '局数必须为 1–64 的整数' };
    }
    const finished = this.tableFinished();
    if (cfg.mode !== undefined) this.config.mode = cfg.mode;
    if (cfg.totalRounds !== undefined) this.config.totalRounds = cfg.totalRounds;
    // 完桌后修改的是下一桌配置，上一桌的结束状态和约定局数保持不变。
    if (this.game && !finished) this.game.totalRounds = this.config.totalRounds;
    if (broadcast) this.broadcastRoom();
    return { ok: true };
  }

  empty() {
    return this.seats.every((s) => !s || s.bot);
  }
}

module.exports = { Room, BOT_NAMES };
