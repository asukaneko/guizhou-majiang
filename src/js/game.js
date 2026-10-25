/* 一局贵州麻将（贵阳捉鸡）的对局流程 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rules.js'), require('./ai.js'));
  } else {
    root.GZGame = factory(root.GZRules, root.GZAI);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (R, AI) {
  'use strict';

  const SEAT_NAMES = ['你', '下家', '对家', '上家'];
  const KONG_POINT = 3;

  const removeTiles = (hand, tile, n) => {
    const out = hand.slice();
    for (let i = 0; i < n; i++) {
      const idx = out.indexOf(tile);
      if (idx < 0) break;
      out.splice(idx, 1);
    }
    return out;
  };

  class Game {
    constructor(opts) {
      opts = opts || {};
      this.speed = opts.speed || 1;
      this.handlers = {};
      this.roundNo = opts.roundNo || 1;
      this.dealer = opts.dealer != null ? opts.dealer : ((Math.random() * 4) | 0);
      this.scores = opts.scores ? opts.scores.slice() : [0, 0, 0, 0];
      this.players = [0, 1, 2, 3].map((i) => ({
        id: i,
        name: SEAT_NAMES[i],
        isHuman: i === 0,
        hand: [],
        melds: [],
        discards: [],
        said: '',
        mustDiscard: false
      }));
      this.phase = 'idle';
      this.awaiting = null;
      this.kongLog = [];
      this.roundDeltas = [0, 0, 0, 0];
      this.wall = [];
      this.turn = this.dealer;
      this.lastDiscard = null;
      this.result = null;
      this.log = [];
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

    emitState() { this.emit('state', this); }

    delay(ms) {
      if (this.speed >= 50) return Promise.resolve();
      return new Promise((r) => setTimeout(r, ms / this.speed));
    }

    note(text) {
      this.log.push(text);
      this.emit('message', text);
    }

    startRound() {
      this.phase = 'dealing';
      this.result = null;
      this.awaiting = null;
      this.kongLog = [];
      this.roundDeltas = [0, 0, 0, 0];
      this.lastDiscard = null;
      this.log = [];
      this.wall = R.shuffle(R.createWall());
      for (const p of this.players) {
        p.hand = []; p.melds = []; p.discards = []; p.said = '';
        p.mustDiscard = false; p.justDrawn = null;
      }
      for (let k = 0; k < 13; k++) {
        for (let i = 0; i < 4; i++) {
          this.players[(this.dealer + i) % 4].hand.push(this.wall.shift());
        }
      }
      // 四家先各发 13 张；庄家首摸由 playLoop 统一完成，避免庄家多摸一张。
      for (const p of this.players) p.hand = R.sortHand(p.hand);
      this.turn = this.dealer;
      this.emitState();
      this.emit('deal', this);
      this.playLoop().catch((err) => {
        console.error('[game] 对局异常', err);
        this.emit('error', err);
      });
    }

    /* ---------------- 主循环 ---------------- */

    async playLoop() {
      this.phase = 'playing';
      let cur = this.dealer;
      let needDraw = true;
      let gangFlower = false;

      while (this.phase === 'playing') {
        if (needDraw) {
          if (!this.wall.length) return this.settleDraw();
          const tile = this.wall.shift();
          const pl = this.players[cur];
          pl.hand.push(tile);
          pl.hand = R.sortHand(pl.hand);
          pl.justDrawn = tile;
          this.turn = cur;
          this.lastDraw = tile;
          this.emitState();
          await this.delay(200);

          if (!pl.isHuman) {
            const self = this.selfActions(cur);
            if (self.hu) return this.settleWin(cur, { selfDraw: true, winTile: tile, gangFlower });
            const gang = AI.decideSelfGang(self);
            if (gang) {
              await this.doKong(cur, gang.type, gang.tile);
              needDraw = true; gangFlower = true;
              continue;
            }
          }
          needDraw = false;
        }

        cur = this.turn;
        const self = this.selfActions(cur);
        const decision = await this.askDiscard(cur, self);
        if (decision.type === 'none' || this.phase !== 'playing') return;

        if (decision.type === 'hu') {
          return this.settleWin(cur, {
            selfDraw: true,
            winTile: this.players[cur].justDrawn != null ? this.players[cur].justDrawn : null,
            gangFlower
          });
        }
        if (decision.type === 'gang') {
          await this.doKong(cur, decision.gangType, decision.tile);
          needDraw = true; gangFlower = true;
          continue;
        }

        const tile = decision.tile;
        this.discard(cur, tile);
        await this.delay(240);

        const claim = await this.resolveClaims(cur, tile);
        if (!claim) {
          cur = (cur + 1) % 4;
          needDraw = true; gangFlower = false;
          continue;
        }
        if (claim.type === 'hu') {
          return this.settleWin(claim.p, { selfDraw: false, from: cur, winTile: tile });
        }
        if (claim.type === 'peng') {
          this.doPeng(claim.p, tile, cur);
          cur = claim.p; needDraw = false; gangFlower = false;
          continue;
        }
        if (claim.type === 'gang') {
          await this.doKong(claim.p, 'minggang', tile, cur);
          cur = claim.p; needDraw = true; gangFlower = true;
          continue;
        }
      }
    }

    discard(p, tile) {
      const pl = this.players[p];
      pl.hand = removeTiles(pl.hand, tile, 1);
      pl.discards.push(tile);
      pl.justDrawn = null;
      pl.mustDiscard = false;
      pl.said = '';
      this.lastDiscard = { p, tile };
      this.emit('discard', { p, tile });
      this.emitState();
    }

    /* ---------------- 可选动作 ---------------- */

    selfActions(p) {
      const pl = this.players[p];
      const ready = pl.hand.length === 14 - pl.melds.length * 3;
      const info = ready && !pl.mustDiscard ? R.winInfo(pl.hand, pl.melds) : null;
      const c = R.counts(pl.hand);
      const angang = [];
      const bugang = [];
      for (let t = 0; t < 27; t++) if (c[t] === 4) angang.push(t);
      for (const m of pl.melds) if (m.type === 'peng' && c[m.tile] >= 1) bugang.push(m.tile);
      return { hu: info, angang, bugang };
    }

    askDiscard(p, self) {
      const pl = this.players[p];
      if (!pl.isHuman) {
        return this.delay(360).then(() => {
          if (this.phase !== 'playing') return { type: 'none' };
          const tile = AI.chooseDiscard(pl.hand, pl.melds);
          return { type: 'discard', tile };
        });
      }
      this.awaiting = { kind: 'discard', player: p, self };
      this.emitState();
      return new Promise((resolve) => {
        this.awaiting.resolve = resolve;
        this.emit('prompt', this.awaiting);
      });
    }

    /* ---------------- 副露 ---------------- */

    doPeng(p, tile, from) {
      const pl = this.players[p];
      pl.hand = removeTiles(pl.hand, tile, 2);
      pl.melds.push({ type: 'peng', tile, tiles: [tile, tile, tile], from });
      pl.mustDiscard = true;
      pl.said = '碰';
      this.turn = p;
      this.note(`${pl.name} 碰 ${R.tileName(tile)}`);
      this.emit('call', { p, text: '碰', tile });
      this.emitState();
    }

    async doKong(p, type, tile, from) {
      const pl = this.players[p];
      let payers;
      const deltas = [0, 0, 0, 0];

      if (type === 'angang') {
        pl.hand = removeTiles(pl.hand, tile, 4);
        pl.melds.push({ type: 'angang', tile, tiles: [tile, tile, tile, tile] });
        payers = [0, 1, 2, 3].filter((i) => i !== p);
      } else if (type === 'bugang') {
        pl.hand = removeTiles(pl.hand, tile, 1);
        const m = pl.melds.find((x) => x.type === 'peng' && x.tile === tile);
        if (m) { m.type = 'gang'; m.tiles.push(tile); }
        payers = [0, 1, 2, 3].filter((i) => i !== p);
      } else {
        pl.hand = removeTiles(pl.hand, tile, 3);
        pl.melds.push({ type: 'gang', tile, tiles: [tile, tile, tile, tile], from });
        payers = [from];
      }
      pl.hand = R.sortHand(pl.hand);
      pl.said = type === 'angang' ? '暗杠' : type === 'bugang' ? '补杠' : '明杠';
      this.turn = p;

      for (const j of payers) { deltas[j] -= KONG_POINT; deltas[p] += KONG_POINT; }
      this.applyDeltas(deltas);
      this.kongLog.push({ p, type, tile, deltas, payers });
      this.note(`${pl.name} ${pl.said} ${R.tileName(tile)}（${payers.map((i) => this.players[i].name).join('、')}各付 ${KONG_POINT}）`);
      this.emit('call', { p, text: pl.said, tile });
      this.emitState();
      await this.delay(320);
    }

    applyDeltas(deltas) {
      for (let i = 0; i < 4; i++) {
        this.scores[i] += deltas[i];
        this.roundDeltas[i] += deltas[i];
      }
    }

    /* ---------------- 抢牌判定 ---------------- */

    async resolveClaims(from, tile) {
      const claims = [];
      for (let k = 1; k < 4; k++) {
        const p = (from + k) % 4;
        const pl = this.players[p];
        const c = R.counts(pl.hand);
        const acts = [];
        const info = R.winInfo(pl.hand.concat(tile), pl.melds);
        if (info && R.canChiPao(info)) acts.push('hu');
        if (info && !R.canChiPao(info) && pl.isHuman) {
          this.emit('blocked', { info, tile });
        }
        if (c[tile] >= 3) acts.push('gang');
        if (c[tile] >= 2) acts.push('peng');
        if (acts.length) claims.push({ p, acts, k, info });
      }
      if (!claims.length) return null;

      const picks = [];
      const humanClaim = claims.find((c) => this.players[c.p].isHuman);
      let humanPick = null;
      if (humanClaim) {
        humanPick = await this.askClaim(tile, from, humanClaim);
        if (humanPick) picks.push({ p: 0, type: humanPick, k: humanClaim.k });
      }
      for (const cl of claims) {
        if (this.players[cl.p].isHuman) continue;
        const a = AI.decideClaim(cl.acts, this.players[cl.p], tile);
        if (a) picks.push({ p: cl.p, type: a, k: cl.k });
      }
      if (!picks.length) return null;
      const rank = { hu: 3, gang: 2, peng: 1 };
      picks.sort((a, b) => rank[b.type] - rank[a.type] || a.k - b.k);
      await this.delay(220); // 让「碰 / 杠 / 胡」有个落点，不至于瞬间切走
      return { p: picks[0].p, type: picks[0].type };
    }

    askClaim(tile, from, claim) {
      const awaiting = {
        kind: 'claim', player: 0, tile, from, options: claim.acts,
        info: claim.info
      };
      this.awaiting = awaiting;
      this.emitState();
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          if (this.awaiting === awaiting) this.awaiting = null;
          this.emitState();
          resolve(v);
        };
        awaiting.resolve = finish;
        this.emit('prompt', awaiting);
      });
    }

    /* ---------------- 玩家操作 ---------------- */

    humanDiscard(tile) {
      const a = this.awaiting;
      if (!a || a.kind !== 'discard' || a.player !== 0) return false;
      if (!this.players[0].hand.includes(tile)) return false;
      this.awaiting = null;
      this.emitState();
      a.resolve({ type: 'discard', tile });
      return true;
    }

    humanGang(type, tile) {
      const a = this.awaiting;
      if (!a || a.kind !== 'discard' || a.player !== 0) return false;
      const self = a.self || {};
      if (type === 'angang' && !(self.angang || []).includes(tile)) return false;
      if (type === 'bugang' && !(self.bugang || []).includes(tile)) return false;
      this.awaiting = null;
      this.emitState();
      a.resolve({ type: 'gang', gangType: type, tile });
      return true;
    }

    humanHu() {
      const a = this.awaiting;
      if (!a || a.kind !== 'discard' || a.player !== 0 || !a.self || !a.self.hu) return false;
      this.awaiting = null;
      this.emitState();
      a.resolve({ type: 'hu' });
      return true;
    }

    humanRespond(action) {
      const a = this.awaiting;
      if (!a || a.kind !== 'claim') return false;
      if (action === 'pass') { a.resolve(null); return true; }
      if (!a.options.includes(action)) return false;
      a.resolve(action);
      return true;
    }

    /* ---------------- 结算 ---------------- */

    settleWin(p, opts) {
      if (this.phase === 'ended') return;
      this.phase = 'ended';
      const pl = this.players[p];
      const winTile = opts.winTile != null ? opts.winTile : null;
      const fullHand = opts.selfDraw ? pl.hand.slice() : R.sortHand(pl.hand.concat(winTile));
      const info = R.winInfo(fullHand, pl.melds);

      const extra = [];
      let points = info ? info.points : 1;
      if (opts.selfDraw) { points += 1; extra.push('自摸 +1'); }
      if (opts.gangFlower) { points += 1; extra.push('杠上花 +1'); }

      const deltas = [0, 0, 0, 0];
      if (opts.selfDraw) {
        for (let i = 0; i < 4; i++) if (i !== p) { deltas[i] -= points; deltas[p] += points; }
      } else {
        deltas[opts.from] -= points;
        deltas[p] += points;
      }
      this.applyDeltas(deltas);

      const flip = this.wall.length ? this.wall[0] : null;
      const chickens = R.chickenSet(flip);
      const isTing = this.players.map((q, i) => (i === p ? true : R.tenpaiTiles(q.hand, q.melds).length > 0));
      const chickenCount = this.players.map((q) => R.chickenPoints(q.hand, q.melds, q.discards, chickens));
      const chickenDeltas = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        if (!isTing[i] || !chickenCount[i]) continue;
        for (let j = 0; j < 4; j++) if (j !== i) { chickenDeltas[j] -= chickenCount[i]; chickenDeltas[i] += chickenCount[i]; }
      }
      this.applyDeltas(chickenDeltas);

      this.result = {
        draw: false,
        winner: p,
        selfDraw: !!opts.selfDraw,
        from: opts.from,
        winTile,
        hand: fullHand,
        melds: pl.melds.map((m) => Object.assign({}, m)),
        info,
        points,
        extra,
        winDeltas: deltas.slice(),
        flip,
        chickens,
        chickenCount,
        chickenDeltas,
        isTing,
        kongLog: this.kongLog.slice(),
        deltas: this.roundDeltas.slice(),
        scores: this.scores.slice()
      };
      this.note(`${pl.name} ${opts.selfDraw ? '自摸' : '胡牌'}：${info ? info.name : ''} ${points} 分`);
      this.emit('win', this.result);
      this.emitState();
      this.emit('roundEnd', this.result);
      this.nextDealer = p;
      return this.result;
    }

    settleDraw() {
      if (this.phase === 'ended') return;
      this.phase = 'ended';
      const ting = this.players.map((q) => R.tingValue(q.hand, q.melds));
      const deltas = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        if (!ting[i].tiles.length) continue;
        const v = Math.max(1, ting[i].points);
        for (let j = 0; j < 4; j++) {
          if (j === i || ting[j].tiles.length) continue;
          deltas[j] -= v;
          deltas[i] += v;
        }
      }
      this.applyDeltas(deltas);
      this.result = {
        draw: true,
        ting,
        deltas: this.roundDeltas.slice(),
        scores: this.scores.slice(),
        kongLog: this.kongLog.slice()
      };
      this.note('牌墙摸完，黄庄查叫');
      this.emit('draw', this.result);
      this.emitState();
      this.emit('roundEnd', this.result);
      this.nextDealer = this.dealer;
      return this.result;
    }

    /* ---------------- 供 UI 查询 ---------------- */

    tingOf(p) {
      const pl = this.players[p];
      if (pl.hand.length !== 13 - pl.melds.length * 3) return null;
      const t = R.tingValue(pl.hand, pl.melds);
      return t.tiles.length ? t : null;
    }

    nextRound() {
      this.roundNo += 1;
      this.dealer = this.nextDealer != null ? this.nextDealer : this.dealer;
      this.startRound();
    }
  }

  return { Game, SEAT_NAMES, KONG_POINT };
});
