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
  const KONG_POINT = R.KONG_POINT;
  const BONUS = R.BONUS;

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
      this.botSpeed = AI.speedOf(opts.botSpeed);
      this.speed = opts.speed || AI.BOT_SPEEDS[this.botSpeed].value;
      this.aiDifficulty = AI.difficultyOf(opts.aiDifficulty);
      this.mode = opts.mode ? R.resolveMode(opts.mode) : R.MODES.classic;
      R.setMode(this.mode);   // 胡牌判定 / 听牌 / 鸡 都跟着当前模式走
      this.handlers = {};
      this.roundNo = opts.roundNo || 1;
      this.dealer = opts.dealer != null ? opts.dealer : ((Math.random() * 4) | 0);
      this.scores = opts.scores ? opts.scores.slice() : [0, 0, 0, 0];
      this.players = [0, 1, 2, 3].map((i) => ({
        id: i,
        name: SEAT_NAMES[i],
        isHuman: i === 0,
        botPlay: i === 0 && !!opts.autoPlay,
        hand: [],
        melds: [],
        discards: [],
        discardCount: 0,
        said: '',
        mustDiscard: false,
        justDrawn: null,
        tingDeclared: false,   // 报听（硬报）
        tianTing: false,       // 天听
        tingAtDeal: false      // 起手 13 张就听牌
      }));
      this.phase = 'idle';
      this.awaiting = null;
      this.autoPlay = !!opts.autoPlay;
      this.kongLog = [];
      this.penaltyLog = [];
      this.roundDeltas = [0, 0, 0, 0];
      this.wall = [];
      this.turn = this.dealer;
      this.lastDiscard = null;
      this.discardSeq = 0;       // 本局已经打出多少张（判断天胡 / 地胡 / 热炮）
      this.discardHot = false;   // 刚打出的这张是不是杠后打出的
      this.lastKongBy = -1;
      this.firstChicken = null;  // 冲锋鸡 {p, tile, index, taken}
      this.chongCount = 0;       // 冲幺筒：本局已经打出几张幺筒
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
      this.penaltyLog = [];
      this.roundDeltas = [0, 0, 0, 0];
      this.lastDiscard = null;
      this.discardSeq = 0;
      this.discardHot = false;
      this.lastKongBy = -1;
      this.firstChicken = null;
      this.chongCount = 0;
      this.log = [];
      this.wall = R.shuffle(R.createWall());
      for (const p of this.players) {
        p.hand = []; p.melds = []; p.discards = []; p.said = '';
        p.discardCount = 0;
        p.mustDiscard = false; p.justDrawn = null;
        p.tingDeclared = false; p.tianTing = false; p.tingAtDeal = false;
      }
      for (let k = 0; k < 13; k++) {
        for (let i = 0; i < 4; i++) {
          this.players[(this.dealer + i) % 4].hand.push(this.wall.shift());
        }
      }
      // 四家先各发 13 张；庄家首摸由 playLoop 统一完成，避免庄家多摸一张。
      for (const p of this.players) {
        p.hand = R.sortHand(p.hand);
        p.tingAtDeal = R.tenpaiTiles(p.hand, [], this.mode).length > 0;
      }
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
          if (this.phase !== 'playing') return;

          if (this.isBotControlled(cur)) {
            const self = this.selfActions(cur);
            if (self.hu) {
              return this.settleWin([{ p: cur, winTile: tile }], {
                selfDraw: true, gangFlower,
                tianhu: this.isTianHu(cur), dihu: this.isDiHu(cur, true)
              });
            }
            const gang = AI.decideSelfGang(self, pl, this.mode, this.aiContext(cur));
            if (gang) {
              await this.doKong(cur, gang.type, gang.tile);
              if (this.phase !== 'playing') return;
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
          const winTile = this.players[cur].justDrawn != null ? this.players[cur].justDrawn : null;
          return this.settleWin([{ p: cur, winTile }], {
            selfDraw: true, gangFlower,
            tianhu: this.isTianHu(cur), dihu: this.isDiHu(cur, true)
          });
        }
        if (decision.type === 'gang') {
          await this.doKong(cur, decision.gangType, decision.tile);
          if (this.phase !== 'playing') return;
          needDraw = true; gangFlower = true;
          continue;
        }

        const tile = decision.tile;
        this.discard(cur, tile);
        const hot = this.discardHot;
        await this.delay(240);
        if (this.phase !== 'playing') return;

        const claim = await this.resolveClaims(cur, tile);
        if (this.phase !== 'playing') return;
        if (!claim) {
          cur = (cur + 1) % 4;
          needDraw = true; gangFlower = false;
          continue;
        }
        if (claim.type === 'hu') {
          // 一炮多响：所有胡的人一起结算，点炮者各赔一份
          return this.settleWin(claim.winners, {
            selfDraw: false,
            from: cur,
            repao: hot,
            dihu: claim.winners.length === 1 && this.isDiHu(claim.winners[0].p, false, cur)
          });
        }
        if (claim.type === 'peng') {
          this.doPeng(claim.p, tile, cur);
          cur = claim.p; needDraw = false; gangFlower = false;
          continue;
        }
        if (claim.type === 'gang') {
          await this.doKong(claim.p, 'minggang', tile, cur);
          if (this.phase !== 'playing') return;
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
      this.discardSeq += 1;
      pl.discardCount = (pl.discardCount || 0) + 1;
      // 杠后打出的这张被别人胡 → 热炮
      this.discardHot = this.lastKongBy === p;
      if (this.lastKongBy === p) this.lastKongBy = -1;
      // 冲锋鸡：本局第一张被打出的幺鸡 / 乌骨鸡
      if (this.mode.chickens && !this.firstChicken && (tile === R.YAOJI || tile === R.WUGU)) {
        this.firstChicken = { p, tile, index: pl.discards.length - 1, taken: false };
        this.note(`冲锋鸡：${pl.name} 打出 ${R.tileName(tile)}`);
      }
      // 冲幺筒：财神被扔出来要赔分，赔率逐张递减
      if (this.mode.wild !== null && this.mode.wild !== undefined && tile === this.mode.wild) {
        this.chongYitong(p);
      }
      this.emit('discard', { p, tile });
      this.emitState();
    }

    /** 打出一张幺筒：本局第 1 张向其他三家各收 5 分，第 2 张各收 3 分，之后不收 */
    chongYitong(p) {
      const idx = this.chongCount++;
      const pts = R.CHONG_POINTS[idx] || 0;
      if (!pts) {
        this.note(`${this.players[p].name} 又打一张幺筒（已经没有冲分可拿）`);
        return null;
      }
      const deltas = [0, 0, 0, 0];
      deltas[p] += pts * 3;
      for (let i = 0; i < 4; i++) if (i !== p) deltas[i] -= pts;
      this.applyDeltas(deltas);
      const entry = {
        kind: '冲幺筒', p, points: pts, deltas,
        seq: idx + 1, label: `第 ${idx + 1} 张幺筒`
      };
      this.penaltyLog.push(entry);
      this.note(`冲幺筒：${this.players[p].name} 打出幺筒，向其他三家各收 ${pts} 分`);
      this.emit('chong', entry);
      return entry;
    }

    /* ---------------- 可选动作 ---------------- */

    selfActions(p) {
      const pl = this.players[p];
      const ready = pl.hand.length === 14 - pl.melds.length * 3;
      const info = ready && !pl.mustDiscard ? R.winInfo(pl.hand, pl.melds, this.mode) : null;
      const c = R.counts(pl.hand);
      const angang = [];
      const bugang = [];
      // 报听后手牌锁定，不能再碰 / 杠
      if (!pl.tingDeclared) {
        // 幺筒是财神，不能杠
        for (let t = 0; t < 27; t++) if (c[t] === 4 && !R.isWildTile(t, this.mode)) angang.push(t);
        for (const m of pl.melds) if (m.type === 'peng' && c[m.tile] >= 1) bugang.push(m.tile);
      }
      return { hu: info, angang, bugang };
    }

    askDiscard(p, self) {
      const pl = this.players[p];
      // 报听锁牌对掉线代打也生效。
      if (pl.tingDeclared) {
        const auto = self && self.hu
          ? { type: 'hu' }
          : { type: 'discard', tile: pl.justDrawn != null ? pl.justDrawn : this.bestTingDiscard(p) };
        return this.playAuto(p, self, auto, 340, true);
      }
      if (!pl.isHuman) {
        return this.delay(360).then(() => {
          if (this.phase !== 'playing') return { type: 'none' };
          if (!this.isBotControlled(p)) return this.askDiscard(p, this.selfActions(p));
          const tile = this.aiDiscard(p);
          return { type: 'discard', tile };
        });
      }

      if (pl.botPlay) return this.playAuto(p, self, this.botDecision(p, self), 380, false);
      return this.waitHumanDiscard(p, self);
    }

    isBotControlled(p) {
      const pl = this.players[p];
      return !pl.isHuman || !!pl.botPlay;
    }

    botDecision(p, self) {
      if (self && self.hu) return { type: 'hu' };
      const gang = self && AI.decideSelfGang(self, this.players[p], this.mode, this.aiContext(p));
      if (gang) return { type: 'gang', gangType: gang.type, tile: gang.tile };
      return { type: 'discard', tile: this.aiDiscard(p) };
    }

    /** 电脑决策只接收本人手牌和公开信息。 */
    aiDiscard(p) {
      const pl = this.players[p];
      return AI.chooseDiscard(pl.hand, pl.melds, this.mode, this.aiContext(p));
    }

    aiContext(p) {
      const players = this.players.map((pl, i) => ({
        id: i, discards: pl.discards.slice(), tingDeclared: !!pl.tingDeclared,
        melds: pl.melds.map((m) => m.type === 'angang' && i !== p
          ? { type: m.type, tile: null, tiles: [] }
          : { type: m.type, tile: m.tile, tiles: m.tiles.slice() })
      }));
      return { seat: p, players, difficulty: this.aiDifficulty, seen: R.seenCountsOf(this.players[p].hand, players),
        wallLeft: this.wall.length, chongCount: this.chongCount, firstChicken: this.firstChicken };
    }

    /** 程序代打：先亮出要打哪张，再落子。sticky = 报听后不可撤销 */
    playAuto(p, self, auto, ms, sticky) {
      const awaiting = {
        kind: 'discard', player: p, self, auto: true,
        autoAction: auto.type, autoGangType: auto.gangType,
        ting: this.players[p].tingDeclared,
        autoTile: auto.type === 'hu' ? null : auto.tile
      };
      this.awaiting = awaiting;
      this.emitState();
      return this.delay(ms).then(() => {
        if (this.phase !== 'playing') return { type: 'none' };
        if (!sticky && !this.isBotControlled(p)) return this.askDiscard(p, this.selfActions(p));
        if (this.awaiting === awaiting) this.awaiting = null;
        this.emitState();
        return auto;
      });
    }

    waitHumanDiscard(p, self) {
      const awaiting = { kind: 'discard', player: p, self };
      const promise = new Promise((resolve) => { awaiting.resolve = resolve; });
      this.awaiting = awaiting;
      this.emitState();
      if (this.awaiting === awaiting) this.emit('prompt', awaiting);
      return promise;
    }

    /**
     * 听牌时打哪张：保持听牌、听口可见剩张多，平手时打刚摸到的那张。
     * 手里不是 14 - 3×副露 张、或者怎么打都不听牌 → null
     */
    bestTingDiscard(p) {
      const pl = this.players[p];
      return R.bestTingOf(pl.hand, pl.melds, this.seenCounts(p), pl.justDrawn, this.mode);
    }

    /** 超时优先选择：能自摸就胡，听牌则保持听牌，散牌交给兜底策略。 */
    autoDecision(p, self) {
      const pl = this.players[p];
      if (pl.hand.length !== 14 - pl.melds.length * 3) return null;
      if (self && self.hu) return { type: 'hu' };
      const tile = this.bestTingDiscard(p);
      return tile == null ? null : { type: 'discard', tile };
    }

    /** 现在能不能报听 */
    canTing(p) {
      const pl = this.players[p];
      return R.canDeclareTing(pl) && this.bestTingDiscard(p) != null;
    }

    /** 某人能看到的牌张数：自己手牌 + 四家副露 + 四家牌河 */
    seenCounts(p) {
      return this.aiContext(p).seen;
    }

    setAuto(on) {
      this.autoPlay = !!on;
      this.players[0].botPlay = this.autoPlay;
      const a = this.awaiting;
      if (this.autoPlay && a && a.player === 0 && !a.auto && a.resolve) {
        if (a.kind === 'discard') {
          this.awaiting = null;
          this.playAuto(0, a.self, this.botDecision(0, a.self), 380, false).then(a.resolve);
        } else if (a.kind === 'claim') a.resolve(AI.decideClaim(a.options, this.players[0], a.tile, this.mode, this.aiContext(0)));
      }
      this.emitState();
      return this.autoPlay;
    }

    abort() {
      this.phase = 'ended';
      const a = this.awaiting;
      this.awaiting = null;
      if (a && a.resolve) a.resolve(a.kind === 'claim' ? null : { type: 'none' });
      this.emitState();
    }

    /* ---------------- 副露 ---------------- */

    takeDiscard(from, tile) {
      if (this.lastDiscard && this.lastDiscard.p === from && this.lastDiscard.tile === tile) {
        const river = this.players[from].discards;
        if (river[river.length - 1] === tile) river.pop();
        this.lastDiscard = null;
      }
    }

    doPeng(p, tile, from) {
      const pl = this.players[p];
      pl.hand = removeTiles(pl.hand, tile, 2);
      pl.melds.push({ type: 'peng', tile, tiles: [tile, tile, tile], from });
      this.takeDiscard(from, tile);
      pl.mustDiscard = true;
      pl.said = '碰';
      this.turn = p;
      this.settleResponsibility(p, tile, from);
      this.note(`${pl.name} 碰 ${R.tileName(tile)}`);
      this.emit('call', { p, text: '碰', tile });
      this.emitState();
    }

    async doKong(p, type, tile, from) {
      // 补杠可能被抢杠胡，抢杠时杠不成立
      if (type === 'bugang') {
        const robbers = await this.resolveRobKong(p, tile);
        if (this.phase !== 'playing') return false;
        if (robbers.length) {
          this.settleWin(robbers, { selfDraw: false, from: p, robKong: true });
          return false;
        }
      }
      const pl = this.players[p];
      let payers;

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
        this.takeDiscard(from, tile);
      }
      pl.hand = R.sortHand(pl.hand);
      pl.said = type === 'angang' ? '暗杠' : type === 'bugang' ? '补杠' : '明杠';
      this.turn = p;

      this.kongLog.push({ p, type, tile, points: KONG_POINT, payers, deltas: [0, 0, 0, 0], settled: false, voided: false });
      this.note(`${pl.name} ${pl.said}${type === 'angang' ? '' : ' ' + R.tileName(tile)}（每份 ${KONG_POINT} 分，胡牌时按听牌状态结算）`);
      if (type === 'minggang') this.settleResponsibility(p, tile, from);
      this.lastKongBy = p; // 杠后打出的牌若被胡 → 热炮
      this.emit('call', { p, text: pl.said, tile });
      this.emitState();
      await this.delay(320);
      return true;
    }

    /**
     * 冲锋鸡被碰 / 杠走，记录拿牌者的责任鸡，胡牌时按听牌状态结算。
     */
    settleResponsibility(taker, tile, from) {
      const fc = this.firstChicken;
      if (!fc || fc.taken || fc.p !== from || fc.tile !== tile) return false;
      fc.taken = true;
      this.penaltyLog.push({ kind: '责任鸡', p: from, to: taker, tile, points: R.RESPONSIBILITY_POINT,
        deltas: [0, 0, 0, 0], settled: false, voided: false });
      this.note(`责任鸡：${this.players[taker].name} 拿走 ${this.players[from].name} 的冲锋鸡，记 ${R.RESPONSIBILITY_POINT} 分，胡牌时结算`);
      return true;
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
        const info = R.winInfo(pl.hand.concat(tile), pl.melds, this.mode);
        if (info && R.canChiPao(info)) acts.push('hu');
        if (info && !R.canChiPao(info) && pl.isHuman) {
          this.emit('blocked', { info, tile });
        }
        // 报听的人不能再碰 / 杠；幺筒是财神，谁也不能碰 / 杠
        if (!pl.tingDeclared && !R.isWildTile(tile, this.mode)) {
          if (c[tile] >= 3) acts.push('gang');
          if (c[tile] >= 2) acts.push('peng');
        }
        if (acts.length) claims.push({ p, acts, k, info });
      }
      if (!claims.length) return null;

      const picks = [];
      const humanClaim = claims.find((c) => !this.isBotControlled(c.p));
      if (humanClaim) {
        // 报听的人见炮就胡
        const humanPick = this.players[0].tingDeclared && humanClaim.acts.includes('hu')
          ? 'hu'
          : await this.askClaim(tile, from, humanClaim);
        if (humanPick) picks.push({ p: 0, type: humanPick, k: humanClaim.k });
      }
      for (const cl of claims) {
        if (humanClaim && cl.p === humanClaim.p) continue;
        const a = AI.decideClaim(cl.acts, this.players[cl.p], tile, this.mode, this.aiContext(cl.p));
        if (a) picks.push({ p: cl.p, type: a, k: cl.k });
      }
      if (!picks.length) return null;

      // 一炮多响：所有能胡的都胡，点炮者各赔一份
      const hus = picks.filter((x) => x.type === 'hu').sort((a, b) => a.k - b.k);
      if (hus.length) {
        await this.delay(220);
        return { type: 'hu', winners: hus.map((x) => ({ p: x.p, winTile: tile })) };
      }

      const rank = { gang: 2, peng: 1 };
      const rest = picks.sort((a, b) => rank[b.type] - rank[a.type] || a.k - b.k);
      await this.delay(220); // 让「碰 / 杠」有个落点，不至于瞬间切走
      return { p: rest[0].p, type: rest[0].type };
    }

    /** 补杠时看看有没人抢杠胡 */
    async resolveRobKong(kongger, tile) {
      const claims = [];
      for (let k = 1; k < 4; k++) {
        const p = (kongger + k) % 4;
        const pl = this.players[p];
        const info = R.winInfo(pl.hand.concat(tile), pl.melds, this.mode);
        if (info) claims.push({ p, k, info });
      }
      if (!claims.length) return [];

      const robbers = [];
      const human = claims.find((c) => !this.isBotControlled(c.p));
      if (human) {
        if (this.players[0].tingDeclared) robbers.push({ p: 0, winTile: tile });
        else {
          const pick = await this.askClaim(tile, kongger, { acts: ['hu'], info: human.info, rob: true });
          if (pick === 'hu') robbers.push({ p: 0, winTile: tile });
        }
      }
      for (const c of claims) {
        if (human && c.p === human.p) continue;
        robbers.push({ p: c.p, winTile: tile });
      }
      if (!robbers.length) return [];
      await this.delay(260);
      return robbers;
    }

    askClaim(tile, from, claim) {
      const awaiting = {
        kind: 'claim', player: 0, tile, from, options: claim.acts,
        info: claim.info, rob: !!claim.rob
      };
      const promise = new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          if (this.awaiting === awaiting) this.awaiting = null;
          this.emitState();
          resolve(v);
        };
        awaiting.resolve = finish;
      });
      this.awaiting = awaiting;
      this.emitState();
      if (this.awaiting === awaiting) this.emit('prompt', awaiting);
      return promise;
    }

    /* ---------------- 玩家操作 ---------------- */

    humanDiscard(tile) {
      const a = this.awaiting;
      if (!a || a.kind !== 'discard' || a.player !== 0 || a.auto) return false;
      if (!this.players[0].hand.includes(tile)) return false;
      this.awaiting = null;
      this.emitState();
      a.resolve({ type: 'discard', tile });
      return true;
    }

    humanGang(type, tile) {
      const a = this.awaiting;
      if (!a || a.kind !== 'discard' || a.player !== 0 || a.auto) return false;
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
      if (!a || a.kind !== 'discard' || a.player !== 0 || a.auto || !a.self || !a.self.hu) return false;
      this.awaiting = null;
      this.emitState();
      a.resolve({ type: 'hu' });
      return true;
    }

    /** 报听：锁牌，之后摸什么打什么，见胡就胡 */
    humanTing() {
      const a = this.awaiting;
      if (!a || a.kind !== 'discard' || a.player !== 0 || a.auto) return false;
      const pl = this.players[0];
      if (!R.canDeclareTing(pl)) return false;
      const tile = this.bestTingDiscard(0);
      if (tile == null) return false;
      pl.tingDeclared = true;
      pl.tianTing = !!pl.tingAtDeal && !pl.discards.length && !pl.melds.length;
      this.note(`${pl.name} ${pl.tianTing ? '天听' : '报听'}：打出 ${R.tileName(tile)} 后锁牌`);
      this.emit('ting', { p: 0, tianTing: pl.tianTing, tile });
      this.awaiting = null;
      this.emitState();
      a.resolve({ type: 'discard', tile });
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

    /* ---------------- 天胡 / 地胡 ---------------- */

    isTianHu(p) {
      if (p !== this.dealer) return false;
      if (this.discardSeq !== 0) return false;
      return this.players.every((q) => !q.melds.length && !q.discards.length);
    }

    isDiHu(p, selfDraw, from) {
      if (p === this.dealer) return false;
      if (p !== (this.dealer + 1) % 4) return false; // 只有下家赶得上第一巡
      if (this.discardSeq > 1) return false;
      const pl = this.players[p];
      if (pl.discards.length || pl.melds.length) return false;
      if (selfDraw) return this.discardSeq === 1;
      return from === this.dealer && this.discardSeq === 1;
    }

    /* ---------------- 结算 ---------------- */

    /** 胡牌时按听牌状态结算；传 null 表示黄庄，所有待结杠和责任鸡作废。 */
    settleDeferred(isTing) {
      const kongDeltas = [0, 0, 0, 0], responsibilityDeltas = [0, 0, 0, 0];
      const settle = (entry, owner, payers, points, total) => {
        if (entry.settled) return;
        const deltas = [0, 0, 0, 0];
        const move = (from, to) => { deltas[from] -= points; deltas[to] += points; };
        if (isTing) {
          if (isTing[owner]) for (const from of payers) move(from, owner);
          else for (let to = 0; to < 4; to++) if (isTing[to]) move(owner, to);
        }
        Object.assign(entry, { deltas, settled: true, voided: !isTing, reversed: !!isTing && !isTing[owner] });
        for (let i = 0; i < 4; i++) total[i] += deltas[i];
      };
      for (const k of this.kongLog) settle(k, k.p, k.payers, k.points, kongDeltas);
      for (const k of this.penaltyLog) if (k.kind === '责任鸡') settle(k, k.to, [k.p], k.points, responsibilityDeltas);
      this.applyDeltas(kongDeltas);
      this.applyDeltas(responsibilityDeltas);
      return { kongDeltas, responsibilityDeltas };
    }

    settleWin(winners, opts) {
      if (this.phase === 'ended') return;
      opts = opts || {};
      if (!Array.isArray(winners)) winners = [{ p: winners, winTile: opts.winTile }];
      this.phase = 'ended';

      const results = winners.map((w) => {
        const p = w.p;
        const pl = this.players[p];
        const winTile = w.winTile != null ? w.winTile : null;
        const fullHand = opts.selfDraw ? pl.hand.slice() : R.sortHand(pl.hand.concat(winTile));
        const info = R.winInfo(fullHand, pl.melds, this.mode);

        const extra = [];
        let points = info ? info.points : R.HU_BASE;
        if (info && info.hardBonus) { points += info.hardBonus; extra.push(`硬胡 +${info.hardBonus}`); }
        if (opts.selfDraw) { points += 1; extra.push('自摸 +1'); }
        if (opts.gangFlower) { points += 1; extra.push('杠上花 +1'); }
        if (opts.repao) { points += BONUS.repao; extra.push(`热炮 +${BONUS.repao}`); }
        if (opts.tianhu) { points += BONUS.tianhu; extra.push(`天胡 +${BONUS.tianhu}`); }
        if (opts.dihu) { points += BONUS.dihu; extra.push(`地胡 +${BONUS.dihu}`); }
        if (opts.robKong) { points += BONUS.qianggang; extra.push(`抢杠胡 +${BONUS.qianggang}`); }
        if (pl.tingDeclared) {
          const bonus = pl.tianTing ? BONUS.tianting : BONUS.baoting;
          points += bonus;
          extra.push(`${pl.tianTing ? '天听' : '报听'} +${bonus}`);
        }

        return {
          p, winTile, selfDraw: !!opts.selfDraw, from: opts.from,
          hand: fullHand,
          melds: pl.melds.map((m) => Object.assign({}, m)),
          info, points, extra,
          hard: info && info.hard !== undefined ? info.hard : undefined,
          joker: info && info.joker !== undefined ? info.joker : undefined
        };
      });

      // 自摸三家各付；点炮或抢杠由出牌者/补杠者向每位胡家各付一份。
      const winDeltas = [0, 0, 0, 0];
      for (const r of results) {
        if (r.selfDraw) {
          for (let i = 0; i < 4; i++) {
            if (i === r.p) continue;
            winDeltas[i] -= r.points;
            winDeltas[r.p] += r.points;
          }
        } else {
          winDeltas[r.from] -= r.points;
          winDeltas[r.p] += r.points;
        }
      }
      this.applyDeltas(winDeltas);

      // 鸡（冲幺筒模式没有鸡）
      const flip = this.wall.length ? this.wall[0] : null;
      const chickens = R.chickenSet(flip, this.mode);
      const winnerSeats = results.map((r) => r.p);
      const isTing = this.players.map((q, i) =>
        winnerSeats.indexOf(i) >= 0 || R.tenpaiTiles(opts.robKong && opts.from === i
          ? removeTiles(q.hand, results[0].winTile, 1) : q.hand, q.melds, this.mode).length > 0);
      const { kongDeltas, responsibilityDeltas } = this.settleDeferred(isTing);
      const charge = this.firstChicken && !this.firstChicken.taken ? this.firstChicken : null;
      const chickenCount = this.players.map((q, i) => {
        let n = R.chickenPoints(q.hand, q.melds, q.discards, chickens);
        if (charge && charge.p === i) n += R.chickenRate(chickens, charge.tile); // 冲锋鸡翻倍
        return n;
      });

      const chickenDeltas = [0, 0, 0, 0];
      const move = (from, to, n) => { chickenDeltas[from] -= n; chickenDeltas[to] += n; };
      // 叫牌的人收鸡：其他三家各付一份
      for (let i = 0; i < 4; i++) {
        if (!isTing[i] || !chickenCount[i]) continue;
        for (let j = 0; j < 4; j++) if (j !== i) move(j, i, chickenCount[i]);
      }
      // 未听牌者把自己的鸡分反赔给所有听牌者（包括未胡牌的听牌者）。
      const baoji = [];
      for (let i = 0; i < 4; i++) {
        if (isTing[i] || !chickenCount[i]) continue;
        for (let to = 0; to < 4; to++) if (isTing[to]) {
          move(i, to, chickenCount[i]);
          baoji.push({ p: i, to, points: chickenCount[i] });
        }
      }
      this.applyDeltas(chickenDeltas);

      const first = results[0];
      this.result = {
        draw: false,
        mode: this.mode.id,
        winners: results,
        winner: first.p,
        selfDraw: first.selfDraw,
        robKong: !!opts.robKong,
        from: first.from,
        winTile: first.winTile,
        hand: first.hand,
        melds: first.melds,
        info: first.info,
        points: first.points,
        extra: first.extra,
        winDeltas,
        kongDeltas,
        responsibilityDeltas,
        flip,
        chickens,
        chickenCount,
        chickenDeltas,
        chongLog: this.penaltyLog.filter((k) => k.kind === '冲幺筒'),
        charge: charge ? { p: charge.p, tile: charge.tile } : null,
        baoji,
        isTing,
        kongLog: this.kongLog.slice(),
        penaltyLog: this.penaltyLog.slice(),
        deltas: this.roundDeltas.slice(),
        scores: this.scores.slice()
      };
      const names = results.map((r) => this.players[r.p].name).join('、');
      const desc = results.map((r) => `${r.info ? r.info.name : '胡牌'} ${r.points} 分`).join('、');
      this.note(`${names} ${opts.selfDraw ? '自摸' : '胡牌'}：${desc}`);
      this.nextDealer = first.p;
      this.emit('win', this.result);
      this.emitState();
      this.emit('roundEnd', this.result);
      return this.result;
    }

    settleDraw() {
      if (this.phase === 'ended') return;
      this.phase = 'ended';
      const ting = this.players.map((q) => R.tingValue(q.hand, q.melds, this.mode));
      const deltas = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        if (!ting[i].tiles.length) continue;
        const v = Math.max(R.HU_BASE, ting[i].points);
        for (let j = 0; j < 4; j++) {
          if (j === i || ting[j].tiles.length) continue;
          deltas[j] -= v;
          deltas[i] += v;
        }
      }
      this.applyDeltas(deltas);
      const { kongDeltas, responsibilityDeltas } = this.settleDeferred(null);
      this.result = {
        draw: true,
        mode: this.mode.id,
        ting,
        kongDeltas,
        responsibilityDeltas,
        deltas: this.roundDeltas.slice(),
        scores: this.scores.slice(),
        kongLog: this.kongLog.slice(),
        penaltyLog: this.penaltyLog.slice(),
        chongLog: this.penaltyLog.filter((k) => k.kind === '冲幺筒')
      };
      this.note('牌墙摸完，黄庄查叫');
      this.nextDealer = this.dealer;
      this.emit('draw', this.result);
      this.emitState();
      this.emit('roundEnd', this.result);
      return this.result;
    }

    /* ---------------- 供 UI 查询 ---------------- */

    tingOf(p) {
      const pl = this.players[p];
      if (pl.hand.length !== 13 - pl.melds.length * 3) return null;
      const t = R.tingValue(pl.hand, pl.melds, this.mode);
      return t.tiles.length ? t : null;
    }

    nextRound() {
      this.roundNo += 1;
      this.dealer = this.nextDealer != null ? this.nextDealer : this.dealer;
      this.startRound();
    }
  }

  return { Game, SEAT_NAMES, KONG_POINT, BONUS };
});
