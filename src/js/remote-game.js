/* RemoteGame：把服务端快照包装成和本地 Game 一样的接口，让 ui.js 原样复用。
 * 关键差异：桌面转了一圈，你永远坐 0 号位；出牌/碰杠胡/报听都改成发消息。
 */
(function (root) {
  'use strict';

  const R = root.GZRules;

  class RemoteGame {
    constructor() {
      this.state = null;
      this.mode = R.MODES.classic;
      this.isRemote = true;
      this.handlers = {};
      this.phase = 'idle';
      this.roundNo = 1;
      this.dealer = 0;
      this.turn = 0;
      this.scores = [0, 0, 0, 0];
      this.roundDeltas = [0, 0, 0, 0];
      this.wallLeft = 55;
      this.players = [];
      this.awaiting = null;
      this.lastDiscard = null;
      this.result = null;
      this.autoPlay = false;
      this.totalRounds = 0;
      this.roundIndex = 0;   // 已打完的局数
      this.resultKey = null;
    }

    on(ev, fn) {
      (this.handlers[ev] = this.handlers[ev] || []).push(fn);
      return this;
    }

    emit(ev, data) {
      const list = this.handlers[ev];
      if (list) for (const fn of list) fn(data, this);
      return this;
    }

    applySnapshot(snap) {
      this.state = snap;
      this.mode = R.MODES[snap.mode] || R.MODES.classic;
      this.phase = snap.phase;
      this.roundNo = snap.roundNo;
      this.dealer = snap.dealer;
      this.turn = snap.turn;
      this.scores = snap.scores;
      this.roundDeltas = snap.roundDeltas;
      this.wallLeft = snap.wallLeft;
      this.players = snap.players;
      this.awaiting = snap.awaiting;
      this.lastDiscard = snap.lastDiscard;
      this.discardSeq = snap.discardSeq;
      this.discardHot = snap.discardHot;
      this.chongCount = snap.chongCount;
      this.firstChicken = snap.firstChicken;
      this.totalRounds = snap.totalRounds || this.totalRounds;
      const newResult = snap.result;
      const resultKey = snap.roundId || `${snap.roomId || ''}:${snap.roundNo}`;
      const changedResult = !!newResult && this.resultKey !== resultKey;
      this.result = newResult;
      this.emit('state', this);
      // 一局结束：result 从无到有（或换局后更新）即触发一次
      if (changedResult) {
        this.resultKey = resultKey;
        this.emit('roundEnd', newResult);
      }
    }

    /* ---------------- UI 依赖的只读接口 ---------------- */

    get wall() { return { length: this.wallLeft }; }

    tingOf(p) {
      const pl = this.players[p];
      if (!pl || !pl.hand) return null;
      if (pl.hand.length !== 13 - pl.melds.length * 3) return null;
      const t = R.tingValue(pl.hand, pl.melds, this.mode);
      return t.tiles.length ? t : null;
    }

    seenCounts(p) {
      const pl = this.players[p];
      if (!pl || !pl.hand) return new Array(27).fill(0);
      return R.seenCountsOf(pl.hand, this.players);
    }

    bestTingDiscard(p) {
      const pl = this.players[p];
      if (!pl || !pl.hand) return null;
      return R.bestTingOf(pl.hand, pl.melds, this.seenCounts(p), pl.justDrawn, this.mode);
    }

    canTing(p) {
      const pl = this.players[p];
      return !!pl && !pl.tingDeclared && this.bestTingDiscard(p) != null;
    }

    autoDecision(p, self) {
      const pl = this.players[p];
      if (!pl || !pl.hand || pl.hand.length !== 14 - pl.melds.length * 3) return null;
      if (self && self.hu) return { type: 'hu' };
      const tile = this.bestTingDiscard(p);
      return tile == null ? null : { type: 'discard', tile };
    }

    /* ---------------- 操作 → 发消息 ---------------- */

    send(action) {
      return root.GZNet.send({ t: 'action', action: { ...action, promptId: this.awaiting && this.awaiting.id } });
    }

    humanDiscard(tile) {
      if (!this.awaiting || this.awaiting.player !== 0) return false;
      return this.send({ type: 'discard', tile });
    }

    humanGang(type, tile) {
      if (!this.awaiting || this.awaiting.player !== 0) return false;
      return this.send({ type: 'gang', gangType: type, tile });
    }

    humanHu() {
      if (!this.awaiting || this.awaiting.player !== 0) return false;
      return this.send({ type: 'hu' });
    }

    humanTing() {
      if (!this.awaiting || this.awaiting.player !== 0) return false;
      return this.send({ type: 'ting' });
    }

    humanRespond(act) {
      if (!this.awaiting || this.awaiting.kind !== 'claim') return false;
      return this.send(act === 'pass' ? { type: 'pass' } : { type: 'claim', act });
    }
  }

  root.GZRemoteGame = { RemoteGame };
})(typeof window !== 'undefined' ? window : globalThis);
