/* 牌效决策：记忆化向听数、可见进张、有限宽度期望前瞻与公开信息风险。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else root.GZAI = factory(root.GZRules);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (R) {
  'use strict';

  const DIFFICULTIES = Object.freeze({
    easy: Object.freeze({ label: '简单', hint: '基础牌型组合', roots: 0, draws: 0, leaves: 0, risk: 0 }),
    normal: Object.freeze({ label: '普通', hint: '牌效与有限前瞻', roots: 3, draws: 6, leaves: 2, risk: 8 }),
    hard: Object.freeze({ label: '困难', hint: '扩大搜索与风险判断', roots: 5, draws: 12, leaves: 3, risk: 16 })
  });
  const BOT_SPEEDS = Object.freeze({
    slow: Object.freeze({ label: '慢', value: .5 }),
    normal: Object.freeze({ label: '中', value: 1.1 }),
    fast: Object.freeze({ label: '快', value: 2.2 })
  });
  const difficultyOf = (id) => typeof id === 'string' && Object.hasOwn(DIFFICULTIES, id) ? id : 'normal';
  const speedOf = (id) => typeof id === 'string' && Object.hasOwn(BOT_SPEEDS, id) ? id : 'normal';

  function basicScore(hand, mode) {
    const c = R.counts(hand); let score = 0;
    for (let t = 0; t < 27; t++) {
      if (!c[t]) continue;
      if (t === mode.wild) score += c[t] * 8;
      if (c[t] >= 3) score += 12;
      if (c[t] >= 2) score += 3.2;
      if (t % 9 <= 6 && c[t + 1] && c[t + 2]) score += 10;
      if (t % 9 <= 7 && c[t + 1]) score += 2.1;
      if (t % 9 <= 6 && c[t + 2]) score += 1.2;
    }
    return score;
  }

  const suitCache = new Map([[0, [0]]]);
  const distanceCache = new Map();
  const CACHE_LIMIT = 30000;
  const POW5 = [1, 5, 25, 125, 625, 3125, 15625, 78125, 390625];
  const pack = (m, b, p) => m | (b << 3) | (p << 6);
  const meldsOf = (x) => x & 7;
  const blocksOf = (x) => (x >> 3) & 7;
  const headOf = (x) => x >> 6;
  const remove = (hand, tile, n = 1) => {
    const out = hand.slice();
    for (let i = 0; i < n; i++) {
      const at = out.indexOf(tile);
      if (at < 0) return null;
      out.splice(at, 1);
    }
    return out;
  };
  function remember(cache, key, value) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, value);
    return value;
  }

  // 每门枚举完整面子、搭子和将的互斥拆分，避免贪心拆牌丢失更好组合。
  function suitProfiles(c) {
    let key = 0, first = -1;
    for (let i = 0; i < 9; i++) { key += c[i] * POW5[i]; if (first < 0 && c[i]) first = i; }
    if (!key) return [0];
    if (suitCache.has(key)) return suitCache.get(key);
    const result = new Set();
    function branch(tiles, dm, db, dp) {
      for (const t of tiles) c[t]--;
      const tails = suitProfiles(c);
      for (const v of tails) {
        const m = meldsOf(v) + dm, b = blocksOf(v) + db, p = headOf(v) + dp;
        if (m + b <= 4 && p <= 1) result.add(pack(m, b, p));
      }
      for (const t of tiles) c[t]++;
    }
    const i = first;
    branch([i], 0, 0, 0);
    if (c[i] >= 3) branch([i, i, i], 1, 0, 0);
    if (i <= 6 && c[i + 1] && c[i + 2]) branch([i, i + 1, i + 2], 1, 0, 0);
    if (c[i] >= 2) { branch([i, i], 0, 1, 0); branch([i, i], 0, 0, 1); }
    if (i <= 7 && c[i + 1]) branch([i, i + 1], 0, 1, 0);
    if (i <= 6 && c[i + 2]) branch([i, i + 2], 0, 1, 0);
    return remember(suitCache, key, [...result]);
  }

  function distance(c, open, wildTile) {
    const natural = c.slice();
    const wild = wildTile == null ? 0 : natural[wildTile];
    if (wildTile != null) natural[wildTile] = 0;
    const key = `${open}:${wildTile}:${wild}:${natural.join('')}`;
    if (distanceCache.has(key)) return distanceCache.get(key);
    const required = 4 - open;
    let profiles = [0];
    for (let suit = 0; suit < 3; suit++) {
      const next = new Set();
      const group = suitProfiles(natural.slice(suit * 9, suit * 9 + 9));
      for (const a of profiles) for (const b of group) {
        const m = meldsOf(a) + meldsOf(b), blocks = blocksOf(a) + blocksOf(b), p = headOf(a) + headOf(b);
        if (m + blocks <= required && p <= 1) next.add(pack(m, blocks, p));
      }
      profiles = [...next];
    }
    const total = natural.reduce((a, b) => a + b, 0);
    let missing = 14;
    for (const v of profiles) {
      const m = meldsOf(v), b = blocksOf(v), p = headOf(v);
      const emptySets = required - m - b;
      const singles = total - 3 * m - 2 * b - 2 * p;
      const need = b + 3 * emptySets + (p ? 0 : 2) - Math.min(singles, emptySets + (p ? 0 : 1));
      missing = Math.min(missing, need);
    }
    if (open === 0) {
      // 本项目四张相同牌可算两对；七对与普通四面子一将并行比较。
      let pairs = 0, singles = 0;
      for (const n of natural) { pairs += Math.floor(n / 2); singles += n % 2; }
      missing = Math.min(missing, 2 * (7 - pairs) - Math.min(singles, 7 - pairs));
    }
    return remember(distanceCache, key, Math.max(-1, missing - wild - 1));
  }

  function shanten(hand, melds = [], mode) {
    const M = R.resolveMode(mode);
    return distance(R.counts(hand), melds.length, M.wild);
  }

  function visible(hand, melds, context) {
    const own = R.counts(hand.concat(...melds.map((m) => m.tiles || [])));
    return own.map((n, t) => Math.min(4, Math.max(n, context.seen?.[t] || 0)));
  }

  function riskOf(tile, mode, context = {}) {
    const seen = context.seen || new Array(27).fill(0);
    const left = seen.map((n) => Math.max(0, 4 - n));
    let safe = 1;
    for (const p of context.players || []) {
      if (p.id === context.seat) continue;
      const melds = p.melds || [], river = p.discards || [];
      const threat = p.tingDeclared ? 1 : Math.min(.55, .06 + melds.length * .09 + river.length * .012);
      let shape = left[tile] / 4 * .2 + left[tile] * Math.max(0, left[tile] - 1) / 12 * .15;
      for (let start = Math.max(0, tile % 9 - 2); start <= Math.min(6, tile % 9); start++) {
        const others = [0, 1, 2].map((d) => Math.floor(tile / 9) * 9 + start + d).filter((t) => t !== tile);
        shape += left[others[0]] * left[others[1]] / 16 * .25;
      }
      if (mode.wild != null && left[mode.wild]) shape += .18;
      const publicMelds = melds.filter((m) => m.type !== 'angang' && m.tile != null);
      if (publicMelds.length >= 2 && publicMelds.every((m) => R.suit(m.tile) === R.suit(publicMelds[0].tile))) {
        shape *= R.suit(tile) === R.suit(publicMelds[0].tile) ? 1.25 : .7;
      }
      // 贵州麻将没有本项目实现的振听限制，不能把对手打过的牌当作绝对安全牌。
      safe *= 1 - Math.min(.9, threat * shape);
    }
    return 1 - safe;
  }

  function evaluator(mode, context = {}) {
    const memo = new Map();
    function evaluate(hand, melds, seenOverride) {
      const seen = seenOverride || visible(hand, melds, context);
      const key = `${melds.length}:${R.counts(hand).join('')}:${seen.join('')}`;
      if (memo.has(key)) return memo.get(key);
      const c = R.counts(hand);
      const base = distance(c, melds.length, mode.wild);
      const draws = [];
      let ukeire = 0, winValue = 0, unknown = 0;
      for (let t = 0; t < 27; t++) {
        const left = Math.max(0, 4 - seen[t]);
        unknown += left;
        if (!left || c[t] >= 4) continue;
        c[t]++;
        const next = distance(c, melds.length, mode.wild);
        c[t]--;
        if (next >= base) continue;
        const info = next < 0 ? R.winInfo(hand.concat(t), melds, mode) : null;
        if (next < 0 && !info) continue;
        const points = info ? info.points + (info.hardBonus || 0) + 1 : 0;
        draws.push({ tile: t, left, win: !!info });
        ukeire += left;
        winValue += left * points * 3;
      }
      const out = { shanten: base, ukeire, winValue: winValue / Math.max(1, unknown), draws, seen, unknown };
      memo.set(key, out);
      return out;
    }
    return evaluate;
  }

  // 跟冲：第一轮（开局前 4 张出牌）内跟打同一种鸡也算冲锋鸡
  const CHARGE_FOLLOW_DISCARDS = 4;

  /** 打出这张能多拿的冲锋鸡分：幺鸡 / 乌骨鸡各算各的，第一轮内跟冲也算 */
  function chargeGain(tile, mode, context) {
    if (!mode.chickens || (tile !== R.YAOJI && tile !== R.WUGU)) return 0;
    const charges = context.charges || [];
    const charged = charges.some((c) => c.tile === tile);
    if (!charged) return R.CHICKEN_BASE[tile] * 3;                       // 本局首张
    if ((context.discardSeq || 0) < CHARGE_FOLLOW_DISCARDS) return R.CHICKEN_BASE[tile] * 3; // 跟冲
    return 0;
  }

  function discardReward(tile, mode, context) {
    if (tile === mode.wild && Number.isInteger(context.chongCount)) return 3 * (R.CHONG_POINTS[context.chongCount] || 0);
    return chargeGain(tile, mode, context);
  }

  // 按难度限制根候选、有效摸牌与后续弃牌的展开数量。
  function lookAhead(row, melds, mode, evaluate, level) {
    let total = 0;
    for (const draw of row.draws.slice().sort((a, b) => b.left - a.left || a.tile - b.tile).slice(0, level.draws)) {
      if (draw.win) continue;
      const hand = row.hand.concat(draw.tile), c = R.counts(hand);
      const candidates = [];
      for (let t = 0; t < 27; t++) if (c[t]) {
        c[t]--;
        candidates.push({ tile: t, shanten: distance(c, melds.length, mode.wild) });
        c[t]++;
      }
      candidates.sort((a, b) => a.shanten - b.shanten || a.tile - b.tile);
      const seen = row.seen.slice(); seen[draw.tile]++;
      let best = 0;
      for (const candidate of candidates.slice(0, level.leaves)) {
        const leaf = evaluate(remove(hand, candidate.tile), melds, seen);
        best = Math.max(best, leaf.ukeire);
      }
      total += draw.left * best;
    }
    return total / Math.max(1, row.unknown);
  }

  function analyzeDiscards(hand, melds = [], mode, context = {}) {
    const M = R.resolveMode(mode), evaluate = evaluator(M, context);
    const difficulty = difficultyOf(context.difficulty), level = DIFFICULTIES[difficulty];
    const seen = visible(hand, melds, context), ctx = { ...context, seen };
    const rows = [...new Set(hand)].map((tile) => {
      const rest = remove(hand, tile);
      const metric = evaluate(rest, melds, seen);
      const risk = riskOf(tile, M, ctx);
      const reward = M.chickens && metric.shanten !== 0 ? 0 : discardReward(tile, M, ctx);
      return { ...metric, tile, hand: rest, risk, reward, future: 0,
        value: difficulty === 'easy' ? basicScore(rest, M) : metric.ukeire + metric.winValue * .6 + reward * .8 - risk * level.risk };
    });
    if (!rows.length) return [];
    if (difficulty === 'easy') return rows.sort((a, b) => b.value - a.value || a.tile - b.tile);
    const minimum = Math.min(...rows.map((r) => r.shanten));
    const folding = minimum >= (difficulty === 'hard' ? 1 : 2) && context.wallLeft != null && context.wallLeft < (difficulty === 'hard' ? 40 : 28)
      && (context.players || []).some((p) => p.id !== context.seat && p.tingDeclared);
    // 尚未听牌时可用一步进度换取确定的冲分；已听牌时优先保留听口。
    const canCash = (r) => minimum > 0 && r.tile === M.wild && r.reward > 0 && r.shanten === minimum + 1;
    const eligible = (r) => r.shanten === minimum || (folding && r.shanten === minimum + 1) || canCash(r);
    const order = (a, b) => {
      if (eligible(a) !== eligible(b)) return eligible(a) ? -1 : 1;
      if (!eligible(a) && a.shanten !== b.shanten) return a.shanten - b.shanten;
      const score = (r) => r.value - (r.shanten - minimum) * (folding ? 25 : 20) - (folding ? r.risk * 100 : 0);
      return score(b) - score(a) || a.tile - b.tile;
    };
    rows.sort(order);
    if (context.lookahead !== false) for (const row of rows.slice(0, level.roots)) {
      if (!eligible(row)) continue;
      row.future = lookAhead(row, melds, M, evaluate, level);
      row.value += row.future * (difficulty === 'hard' ? .55 : .35);
    }
    return rows.sort(order);
  }

  function chooseDiscard(hand, melds, mode, context) {
    return analyzeDiscards(hand, melds, mode, context)[0]?.tile;
  }

  function callValue(next, baseline, bonus) {
    if (next.shanten > baseline.shanten) return null;
    if (next.shanten === baseline.shanten && next.ukeire < baseline.ukeire + 1 &&
      !(bonus > 0 && next.ukeire >= baseline.ukeire * .85) &&
      !(next.winValue > baseline.winValue + .2 && next.ukeire >= baseline.ukeire)) return null;
    return -next.shanten * 1000 + next.ukeire + next.winValue * .6 + bonus - (next.risk || 0) * 12;
  }

  function decideClaim(acts, player, tile, mode, context = {}) {
    if (acts.includes('hu')) return 'hu';
    if (player.tingDeclared || player.melds.length >= 4) return null;
    const M = R.resolveMode(mode);
    if (R.isWildTile(tile, M)) return null;
    if (difficultyOf(context.difficulty) === 'easy') {
      const c = R.counts(player.hand);
      if (acts.includes('gang') && context.wallLeft !== 0 && c[tile] >= 3) return 'gang';
      return acts.includes('peng') && c[tile] >= 2 ? 'peng' : null;
    }
    const evaluate = evaluator(M, context), base = evaluate(player.hand, player.melds);
    const ctx = { ...context, seen: base.seen, lookahead: false };
    let best = null, value = -Infinity;
    for (const act of ['peng', 'gang']) {
      if (!acts.includes(act) || (act === 'gang' && context.wallLeft === 0)) continue;
      const hand = remove(player.hand, tile, act === 'gang' ? 3 : 2);
      if (!hand) continue;
      const melds = player.melds.concat({ type: act, tile, tiles: new Array(act === 'gang' ? 4 : 3).fill(tile) });
      const after = act === 'peng' ? analyzeDiscards(hand, melds, M, ctx)[0] : evaluate(hand, melds, base.seen);
      if (!after) continue;
      const chicken = (context.charges || []).find((c) => !c.follow && !c.taken && c.tile === tile && c.p !== context.seat);
      const responsibility = chicken ? R.RESPONSIBILITY_POINT : 0;
      const score = callValue(after, base, after.shanten === 0 ? (act === 'gang' ? R.KONG_POINT : 0) + responsibility : 0);
      if (score != null && score > value) { best = act; value = score; }
    }
    return best;
  }

  function decideSelfGang(actions, player, mode, context = {}) {
    if (actions.hu || player?.tingDeclared || context.wallLeft === 0) return null;
    if (!(actions.angang || []).length && !(actions.bugang || []).length) return null;
    if (!player) return null;
    const M = R.resolveMode(mode), evaluate = evaluator(M, context);
    const difficulty = difficultyOf(context.difficulty);
    if (difficulty === 'easy') {
      const c = R.counts(player.hand);
      for (const type of ['angang', 'bugang']) for (const tile of actions[type] || []) {
        if (R.isWildTile(tile, M)) continue;
        if ((type === 'angang' && c[tile] === 4) || (type === 'bugang' && c[tile] && player.melds.some((m) => m.type === 'peng' && m.tile === tile))) return { type, tile };
      }
      return null;
    }
    const baseline = analyzeDiscards(player.hand, player.melds, M, { ...context, lookahead: false })[0];
    if (!baseline) return null;
    let best = null, value = -Infinity;
    for (const type of ['angang', 'bugang']) for (const tile of actions[type] || []) {
      if (R.isWildTile(tile, M)) continue;
      const hand = remove(player.hand, tile, type === 'angang' ? 4 : 1);
      if (!hand) continue;
      const melds = player.melds.map((m) => ({ ...m, tiles: m.tiles.slice() }));
      if (type === 'angang') melds.push({ type, tile, tiles: new Array(4).fill(tile) });
      else {
        const old = melds.find((m) => m.type === 'peng' && m.tile === tile);
        if (!old) continue;
        old.type = 'gang'; old.tiles.push(tile);
        if (riskOf(tile, M, { ...context, seen: baseline.seen }) > (difficulty === 'hard' ? .3 : .4)) continue;
      }
      const after = evaluate(hand, melds, baseline.seen);
      const score = callValue(after, baseline, after.shanten === 0 ? R.KONG_POINT * 3 : 0);
      if (score != null && score > value) { value = score; best = { type, tile }; }
    }
    return best;
  }

  return { DIFFICULTIES, BOT_SPEEDS, difficultyOf, speedOf, chooseDiscard, decideClaim, decideSelfGang, shanten, analyzeDiscards,
    evaluateHand: (hand, melds = [], mode, context = {}) => evaluator(R.resolveMode(mode), context)(hand, melds) };
});
