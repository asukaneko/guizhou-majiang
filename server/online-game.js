/* 联机对局：继承本地 Game 状态机，把「等人类输入」换成按座位的远程提示。
 *
 * - 每个真人座位一个 prompt（出牌 / 报听 / 碰杠胡 / 抢杠），互不阻塞，可以多人同时报「胡」
 * - 机器人座位完全复用原 AI 分支
 * - 超时兜底：出牌 60s、吃碰胡 20s，避免一家掉线卡死整桌
 */
'use strict';

const path = require('path');
const GZ = require(path.join(__dirname, '..', 'src', 'js', 'game.js'));
const R = require(path.join(__dirname, '..', 'src', 'js', 'rules.js'));
const AI = require(path.join(__dirname, '..', 'src', 'js', 'ai.js'));

const { Game } = GZ;

class OnlineGame extends Game {
  constructor(opts) {
    super(opts);
    this.totalRounds = opts.totalRounds || 0;
    this.prompts = new Map();          // seat -> prompt
    this.discardTimeout = opts.discardTimeout || 60000;
    this.claimTimeout = opts.claimTimeout || 20000;

    // 座位身份：type = 'human' | 'bot'
    (opts.seats || []).forEach((s, i) => {
      const pl = this.players[i];
      pl.isHuman = s.type !== 'bot';
      pl.uid = s.uid || null;
      if (s.name) pl.name = s.name;
    });
  }

  /* ---------------- 远程等待 ---------------- */

  askDiscard(p, self) {
    const pl = this.players[p];
    if (pl.isHuman && !pl.tingDeclared) return this.waitRemoteDiscard(p, self);
    // 报听锁牌 / 机器人走原逻辑（自动摸打 / AI）
    return super.askDiscard(p, self);
  }

  waitRemoteDiscard(p, self) {
    const pl = this.players[p];
    const prompt = { kind: 'discard', p, self, resolve: null, timer: null };
    this.prompts.set(p, prompt);
    const promise = new Promise((resolve) => { prompt.resolve = resolve; });
    prompt.timer = setTimeout(() => {
      if (this.prompts.get(p) !== prompt) return;
      this.note(`${pl.name} 超时，自动出牌`);
      const auto = this.autoDecision(p, self);
      const tile = auto && auto.type === 'discard' ? auto.tile
        : pl.hand.length ? pl.hand[(Math.random() * pl.hand.length) | 0] : null;
      this.finishPrompt(p, tile == null ? { type: 'hu' } : { type: 'discard', tile });
    }, this.discardTimeout);
    this.emitState();   // 先广播；监听器若立刻回应，resolve 已就位
    return promise;
  }

  askClaim(tile, from, claim) {
    const p = claim.p;
    const pl = this.players[p];
    if (!pl || !pl.isHuman) return Promise.resolve(null);
    const prompt = {
      kind: 'claim', p, tile, from,
      options: claim.acts.slice(),
      info: claim.info || null,
      rob: !!claim.rob,
      resolve: null, timer: null
    };
    this.prompts.set(p, prompt);
    const promise = new Promise((resolve) => { prompt.resolve = resolve; });
    prompt.timer = setTimeout(() => {
      if (this.prompts.get(p) !== prompt) return;
      this.note(`${pl.name} 超时，自动放弃`);
      this.finishPrompt(p, null);
    }, this.claimTimeout);
    this.emitState();
    return promise;
  }

  finishPrompt(p, value) {
    const prompt = this.prompts.get(p);
    if (!prompt) return;
    this.prompts.delete(p);
    if (prompt.timer) clearTimeout(prompt.timer);
    this.emitState();
    if (typeof prompt.resolve === 'function') prompt.resolve(value);
  }

  /* ---------------- 抢牌判定（多人版） ---------------- */

  async resolveClaims(from, tile) {
    const claims = [];
    for (let k = 1; k < 4; k++) {
      const p = (from + k) % 4;
      const pl = this.players[p];
      const c = R.counts(pl.hand);
      const acts = [];
      const info = R.winInfo(pl.hand.concat(tile), pl.melds);
      if (info && R.canChiPao(info)) acts.push('hu');
      if (info && !R.canChiPao(info) && pl.isHuman) this.emit('blocked', { info, tile });
      // 报听的人不能再碰 / 杠；幺筒是财神，谁也不能碰 / 杠
      if (!pl.tingDeclared && !R.isWildTile(tile, this.mode)) {
        if (c[tile] >= 3) acts.push('gang');
        if (c[tile] >= 2) acts.push('peng');
      }
      if (acts.length) claims.push({ p, acts, k, info });
    }
    if (!claims.length) return null;

    const picks = [];
    const asks = [];
    for (const cl of claims) {
      const pl = this.players[cl.p];
      if (!pl.isHuman) {
        const a = AI.decideClaim(cl.acts, pl, tile);
        if (a) picks.push({ p: cl.p, type: a, k: cl.k });
      } else if (pl.tingDeclared && cl.acts.includes('hu')) {
        picks.push({ p: cl.p, type: 'hu', k: cl.k });   // 报听的人见炮就胡
      } else {
        asks.push(this.askClaim(tile, from, cl).then((pick) => {
          if (pick) picks.push({ p: cl.p, type: pick, k: cl.k });
        }));
      }
    }
    await Promise.all(asks);
    if (!picks.length) return null;

    // 一炮多响：所有能胡的都胡，点炮者各赔一份
    const hus = picks.filter((x) => x.type === 'hu').sort((a, b) => a.k - b.k);
    if (hus.length) {
      await this.delay(220);
      return { type: 'hu', winners: hus.map((x) => ({ p: x.p, winTile: tile })) };
    }

    const rank = { gang: 2, peng: 1 };
    const rest = picks.sort((a, b) => rank[b.type] - rank[a.type] || a.k - b.k);
    await this.delay(220);
    return { p: rest[0].p, type: rest[0].type };
  }

  async resolveRobKong(kongger, tile) {
    const claims = [];
    for (let k = 1; k < 4; k++) {
      const p = (kongger + k) % 4;
      const pl = this.players[p];
      const info = R.winInfo(pl.hand.concat(tile), pl.melds);
      if (info) claims.push({ p, k, info });
    }
    if (!claims.length) return [];

    const robbers = [];
    const asks = [];
    for (const c of claims) {
      const pl = this.players[c.p];
      if (pl.tingDeclared || !pl.isHuman) {
        // 报听的人见杠就抢；电脑能抢就抢
        robbers.push({ p: c.p, winTile: tile });
      } else {
        asks.push(this.askClaim(tile, kongger, { acts: ['hu'], info: c.info, rob: true, p: c.p })
          .then((pick) => { if (pick === 'hu') robbers.push({ p: c.p, winTile: tile }); }));
      }
    }
    await Promise.all(asks);
    if (!robbers.length) return [];
    await this.delay(260);
    return robbers;
  }

  /* ---------------- 远程操作入口 ---------------- */

  /**
   * @param {number} p 服务器侧座位号
   * @param {object} action {type:'discard'|'hu'|'gang'|'ting'|'claim'|'pass', ...}
   */
  remoteAction(p, action) {
    const prompt = this.prompts.get(p);
    if (!prompt) return { ok: false, err: '现在没有等你操作' };
    const pl = this.players[p];

    if (prompt.kind === 'discard') {
      const self = prompt.self || {};
      if (action.type === 'discard') {
        if (pl.tingDeclared) return { ok: false, err: '报听锁牌中，摸什么打什么' };
        if (!Number.isInteger(action.tile) || !pl.hand.includes(action.tile)) {
          return { ok: false, err: '手里没有这张牌' };
        }
        this.finishPrompt(p, { type: 'discard', tile: action.tile });
        return { ok: true };
      }
      if (action.type === 'hu') {
        if (!self.hu) return { ok: false, err: '现在不能胡' };
        this.finishPrompt(p, { type: 'hu' });
        return { ok: true };
      }
      if (action.type === 'gang') {
        if (action.gangType === 'angang' && !(self.angang || []).includes(action.tile)) {
          return { ok: false, err: '不能暗杠这张' };
        }
        if (action.gangType === 'bugang' && !(self.bugang || []).includes(action.tile)) {
          return { ok: false, err: '不能补杠这张' };
        }
        this.finishPrompt(p, { type: 'gang', gangType: action.gangType, tile: action.tile });
        return { ok: true };
      }
      if (action.type === 'ting') {
        if (pl.tingDeclared) return { ok: false, err: '已经报听了' };
        const tile = this.bestTingDiscard(p);
        if (tile == null) return { ok: false, err: '还没听牌，不能报听' };
        pl.tingDeclared = true;
        pl.tianTing = !!pl.tingAtDeal && !pl.discards.length && !pl.melds.length;
        this.note(`${pl.name} ${pl.tianTing ? '天听' : '报听'}：打出 ${R.tileName(tile)} 后锁牌`);
        this.emit('ting', { p, tianTing: pl.tianTing, tile });
        this.finishPrompt(p, { type: 'discard', tile });
        return { ok: true };
      }
    }

    if (prompt.kind === 'claim') {
      if (action.type === 'claim') {
        if (!prompt.options.includes(action.act)) return { ok: false, err: '没有这个选项' };
        this.finishPrompt(p, action.act);
        return { ok: true };
      }
      if (action.type === 'pass') {
        this.finishPrompt(p, null);
        return { ok: true };
      }
    }

    return { ok: false, err: '未知操作' };
  }

  /** 强制清掉某座位未决的提示（玩家掉线时兜底） */
  dropPrompt(p) {
    const prompt = this.prompts.get(p);
    if (!prompt) return false;
    if (prompt.kind === 'claim') this.finishPrompt(p, null);
    else {
      const pl = this.players[p];
      const auto = this.autoDecision(p, prompt.self);
      const tile = auto && auto.type === 'discard' ? auto.tile
        : pl.hand.length ? pl.hand[(Math.random() * pl.hand.length) | 0] : null;
      this.finishPrompt(p, tile == null ? { type: 'hu' } : { type: 'discard', tile });
    }
    return true;
  }

  abort() {
    this.phase = 'ended';
    for (const p of [...this.prompts.keys()]) this.dropPrompt(p);
  }
}

module.exports = { OnlineGame, Game };
