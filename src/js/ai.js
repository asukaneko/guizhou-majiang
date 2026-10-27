/* 牌效决策：记忆化向听数、可见进张、有限宽度期望前瞻与公开信息风险。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else root.GZAI = factory(root.GZRules);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (R) {
  'use strict';

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

  function immediate(tile, mode, context) {
    if (tile === mode.wild && Number.isInteger(context.chongCount)) return 3 * (R.CHONG_POINTS[context.chongCount] || 0);
    if (mode.chickens && context.firstChicken === null && (tile === R.YAOJI || tile === R.WUGU)) return tile === R.WUGU ? 6 : 3;
    return 0;
  }

  // 根部保留三个候选，每个最多展开六种有效摸牌、两种后续弃牌。
  function lookAhead(row, melds, mode, evaluate) {
    let total = 0;
    for (const draw of row.draws.slice().sort((a, b) => b.left - a.left || a.tile - b.tile).slice(0, 6)) {
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
      for (const candidate of candidates.slice(0, 2)) {
        const leaf = evaluate(remove(hand, candidate.tile), melds, seen);
        best = Math.max(best, leaf.ukeire);
      }
      total += draw.left * best;
    }
    return total / Math.max(1, row.unknown);
  }

  function analyzeDiscards(hand, melds = [], mode, context = {}) {
    const M = R.resolveMode(mode), evaluate = evaluator(M, context);
    const seen = visible(hand, melds, context), ctx = { ...context, seen };
    const rows = [...new Set(hand)].map((tile) => {
      const rest = remove(hand, tile);
      const metric = evaluate(rest, melds, seen);
      const risk = riskOf(tile, M, ctx);
      const reward = immediate(tile, M, ctx);
      return { ...metric, tile, hand: rest, risk, reward, future: 0,
        value: metric.ukeire + metric.winValue * .6 + reward * .8 - risk * 8 };
    });
    if (!rows.length) return [];
    const minimum = Math.min(...rows.map((r) => r.shanten));
    const folding = minimum >= 2 && context.wallLeft != null && context.wallLeft < 28
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
    if (context.lookahead !== false) for (const row of rows.slice(0, 3)) {
      if (!eligible(row)) continue;
      row.future = lookAhead(row, melds, M, evaluate);
      row.value += row.future * .35;
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
      const chicken = context.firstChicken;
      const responsibility = chicken && !chicken.taken && chicken.tile === tile && chicken.p !== context.seat ? 3 : 0;
      const score = callValue(after, base, (act === 'gang' ? 3 : 0) + responsibility);
      if (score != null && score > value) { best = act; value = score; }
    }
    return best;
  }

  function decideSelfGang(actions, player, mode, context = {}) {
    if (actions.hu || player?.tingDeclared || context.wallLeft === 0) return null;
    if (!(actions.angang || []).length && !(actions.bugang || []).length) return null;
    if (!player) return null;
    const M = R.resolveMode(mode), evaluate = evaluator(M, context);
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
        if (riskOf(tile, M, { ...context, seen: baseline.seen }) > .4) continue;
      }
      const after = evaluate(hand, melds, baseline.seen);
      const score = callValue(after, baseline, 9);
      if (score != null && score > value) { value = score; best = { type, tile }; }
    }
    return best;
  }

  return { chooseDiscard, decideClaim, decideSelfGang, shanten, analyzeDiscards,
    evaluateHand: (hand, melds = [], mode, context = {}) => evaluator(R.resolveMode(mode), context)(hand, melds) };
});
