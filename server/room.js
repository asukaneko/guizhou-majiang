/* 房间：座位管理、机器人、规则配置、对局编排 */
'use strict';

const path = require('path');
const R = require(path.join(__dirname, '..', 'src', 'js', 'rules.js'));
const { OnlineGame } = require('./online-game.js');
const { snapshot, rotateSeat } = require('./serialize.js');

const BOT_NAMES = ['阿贵', '小幺', '老陈', '顺子', '幺妹', '排骨', '茶客', '雀友'];

class Room {
  constructor(id, host) {
    this.id = id;                       // 房号（字符串）
    this.seats = [null, null, null, null]; // {uid, name, ws, bot}
    this.config = { mode: 'classic', totalRounds: 4 };
    this.game = null;
    this.fx = [];
    this.hostUid = host.uid;
    this.created = Date.now();
    this.add(host);
  }

  /* ---------------- 座位 ---------------- */

  seatOf(uid) {
    return this.seats.findIndex((s) => s && s.uid === uid);
  }

  add(player) {
    if (this.seatOf(player.uid) >= 0) return this.seatOf(player.uid);
    const idx = this.seats.findIndex((s) => s === null);
    if (idx < 0) throw new Error('房间已满');
    this.seats[idx] = { uid: player.uid, name: player.name, ws: player.ws, bot: false };
    return idx;
  }

  remove(uid) {
    const idx = this.seatOf(uid);
    if (idx < 0) return false;
    const wasHost = this.hostUid === uid;
    const seat = this.seats[idx];
    this.seats[idx] = null;
    if (this.game) {
      const pl = this.game.players[idx];
      pl.isHuman = false;            // 掉线转电脑代打
      if (pl.hand.length) pl.name = `${seat.name}(代打)`;
      this.game.dropPrompt(idx);
    }
    if (wasHost) {
      const next = this.seats.find((s) => s && !s.bot);
      if (next) this.hostUid = next.uid;
    }
    return true;
  }

  addBot() {
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
    if (this.game) return { ok: false, err: '对局中不能移除机器人' };
    this.seats[idx] = null;
    return { ok: true };
  }

  humans() {
    return this.seats.map((s, i) => (s && !s.bot ? i : -1)).filter((i) => i >= 0);
  }

  isHost(uid) { return this.hostUid === uid; }

  /* ---------------- 广播 ---------------- */

  publicState(forUid) {
    const seat = this.seatOf(forUid);
    return {
      id: this.id,
      host: this.isHost(forUid),
      config: { ...this.config },
      running: !!this.game && this.game.phase === 'playing',
      full: this.seats.every(Boolean),
      roundNo: this.game ? this.game.roundNo : 0,
      totalRounds: this.config.totalRounds,
      standings: this.game ? this.game.scores.slice() : [0, 0, 0, 0],
      seats: this.seats.map((s, i) => ({
        seat: i,
        name: s ? s.name : null,
        bot: s ? s.bot : false,
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

  rotateFx(forSeat) {
    const rotateOne = (f) => {
      const out = { ...f };
      if (out.p !== undefined && out.p !== null) out.p = rotateSeat(out.p, forSeat);
      if (out.to !== undefined && out.to !== null) out.to = rotateSeat(out.to, forSeat);
      return out;
    };
    const list = this.fx.map(rotateOne);
    return list;
  }

  broadcastGame() {
    if (!this.game) return;
    const fx = this.fx.splice(0, this.fx.length);
    for (let seat = 0; seat < 4; seat++) {
      const s = this.seats[seat];
      if (!s || s.bot || !s.ws || s.ws.readyState !== 1) continue;
      const snap = snapshot(this.game, seat);
      s.ws.send(JSON.stringify({ t: 'snapshot', snap, fx: this.rotateFx(seat) }));
    }
  }

  /* ---------------- 对局 ---------------- */

  start() {
    if (this.game && this.game.phase === 'playing') return { ok: false, err: '对局已经开始' };
    const empty = this.seats.findIndex((s) => s === null);
    if (empty >= 0) return { ok: false, err: '还有空位，先加机器人或等玩家加入' };

    const prev = this.game;
    const scores = prev ? prev.scores.slice() : [0, 0, 0, 0];
    const roundNo = prev ? prev.roundNo + 1 : 1;
    const dealer = prev ? (prev.nextDealer != null ? prev.nextDealer : prev.dealer) : 0;

    const seats = this.seats.map((s) => ({ type: s.bot ? 'bot' : 'human', uid: s.uid, name: s.name }));
    this.game = new OnlineGame({
      mode: this.config.mode,
      speed: 1.1,
      totalRounds: this.config.totalRounds,
      scores,
      roundNo,
      dealer,
      seats
    });
    this.fx = [];
    const game = this.game;
    game.on('discard', (d) => this.pushFx({ type: 'discard', p: d.p, tile: d.tile }));
    game.on('call', (c) => this.pushFx({ type: 'call', p: c.p, text: c.text, tile: c.tile }));
    game.on('chong', (e) => this.pushFx({ type: 'chong', p: e.p, points: e.points }));
    game.on('ting', (i) => this.pushFx({ type: 'ting', p: i.p, tianTing: !!i.tianTing }));
    game.on('blocked', () => this.pushFx({ type: 'blocked' }));
    game.on('message', (text) => this.pushFx({ type: 'msg', text }));
    game.on('state', () => this.broadcastGame());
    game.on('roundEnd', () => {
      this.broadcastGame();
      setTimeout(() => this.broadcastRoom(), 60);
    });
    game.startRound();
    this.broadcastRoom();
    return { ok: true };
  }

  nextRound(uid) {
    if (!this.isHost(uid)) return { ok: false, err: '只有房主能开下一局' };
    if (!this.game) return { ok: false, err: '对局还没开始' };
    if (this.game.phase === 'playing') return { ok: false, err: '这一局还没打完' };
    if (this.game.roundNo >= this.config.totalRounds) {
      return { ok: false, err: `已打满约定的 ${this.config.totalRounds} 局` };
    }
    return this.start();
  }

  action(uid, action) {
    if (!this.game) return { ok: false, err: '对局还没开始' };
    const seat = this.seatOf(uid);
    if (seat < 0) return { ok: false, err: '你不在房间里' };
    const res = this.game.remoteAction(seat, action);
    if (res.ok) this.broadcastGame();
    return res;
  }

  abort() {
    if (this.game) {
      this.game.abort();
      this.game = null;
      this.fx = [];
    }
  }

  setConfig(uid, cfg) {
    if (!this.isHost(uid)) return { ok: false, err: '只有房主能改规则' };
    if (this.game && this.game.phase === 'playing') return { ok: false, err: '对局中不能改规则' };
    if (cfg.mode && R.MODES[cfg.mode]) this.config.mode = cfg.mode;
    if (Number.isInteger(cfg.totalRounds) && cfg.totalRounds >= 1 && cfg.totalRounds <= 64) {
      this.config.totalRounds = cfg.totalRounds;
    }
    this.broadcastRoom();
    return { ok: true };
  }

  empty() {
    return this.seats.every((s) => !s || s.bot);
  }
}

module.exports = { Room, BOT_NAMES };
