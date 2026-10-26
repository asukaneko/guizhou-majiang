/* 电脑对手：牌效启发式 + 简单的碰杠取舍 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else root.GZAI = factory(root.GZRules);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (R) {
  'use strict';

  const removeOne = (hand, tile) => {
    const out = hand.slice();
    out.splice(out.indexOf(tile), 1);
    return out;
  };

  /** 牌形评分：刻子 > 顺子 > 对子 > 两面/嵌张 */
  function shapeScore(hand, mode) {
    const M = R.resolveMode(mode);
    const c = R.counts(hand);
    let score = 0;
    // 财神（幺筒）本身很值钱，别当废牌算
    if (M.wild !== null && M.wild !== undefined) score += c[M.wild] * 7;
    for (let i = 0; i < 27; i++) {
      while (c[i] >= 3) { score += 12; c[i] -= 3; }
    }
    for (let i = 0; i < 27; i++) {
      while (i % 9 <= 6 && c[i] && c[i + 1] && c[i + 2]) {
        score += 10; c[i]--; c[i + 1]--; c[i + 2]--;
      }
    }
    for (let i = 0; i < 27; i++) {
      while (c[i] >= 2) { score += 3.2; c[i] -= 2; }
    }
    for (let i = 0; i < 27; i++) {
      while (i % 9 <= 7 && c[i] && c[i + 1]) { score += 2.1; c[i]--; c[i + 1]--; }
    }
    for (let i = 0; i < 27; i++) {
      while (i % 9 <= 6 && c[i] && c[i + 2]) { score += 1.2; c[i]--; c[i + 2]--; }
    }
    return score;
  }

  /** 孤张、边张略微扣分，让电脑先丢没用的牌 */
  function isolationBonus(hand, tile) {
    const r = R.rank(tile);
    const c = R.counts(hand);
    let n = 0;
    for (let d = -2; d <= 2; d++) {
      if (!d) continue;
      const t = tile + d;
      if (t < 0 || t > 26 || R.suit(t) !== R.suit(tile)) continue;
      n += c[t] * (3 - Math.abs(d));
    }
    return n;
  }

  function chooseDiscard(hand, melds, mode) {
    const M = R.resolveMode(mode);
    const uniq = [...new Set(hand)];
    const keepTing = uniq.filter((t) => R.tenpaiTiles(removeOne(hand, t), melds, M).length > 0);
    const pool = keepTing.length ? keepTing : uniq;
    let best = pool[0], bestScore = -Infinity;
    for (const t of pool) {
      const rest = removeOne(hand, t);
      let s = shapeScore(rest, M);
      // 听牌张数多的优先
      const waits = R.tenpaiTiles(rest, melds, M).length;
      s += waits * 1.5;
      // 打出去越孤立越好
      s -= isolationBonus(hand, t) * 0.35;
      // 边张（1/9）先走
      const r = R.rank(t);
      if (r === 1 || r === 9) s += 0.4;
      // 幺筒是财神，打出去还要赔分，尽量留着
      if (R.isWildTile(t, M)) s -= 12;
      s += Math.random() * 0.5;
      if (s > bestScore) { bestScore = s; best = t; }
    }
    return best;
  }

  function decideClaim(acts, player, tile) {
    if (acts.includes('hu')) return 'hu';
    const c = R.counts(player.hand);
    if (acts.includes('gang') && player.melds.length < 4 && Math.random() < 0.9) return 'gang';
    if (acts.includes('peng')) {
      if (player.melds.length >= 4) return null;
      const pairs = c.filter((x) => x >= 2).length;
      // 对子多、已经碰过牌 —— 更愿意做大对子
      const eager = pairs >= 2 || player.melds.length >= 1 ? 0.78 : 0.34;
      return Math.random() < eager ? 'peng' : null;
    }
    return null;
  }

  function decideSelfGang(actions) {
    if (actions.angang.length && Math.random() < 0.92) {
      return { type: 'angang', tile: actions.angang[0] };
    }
    if (actions.bugang.length && Math.random() < 0.95) {
      return { type: 'bugang', tile: actions.bugang[0] };
    }
    return null;
  }

  return { chooseDiscard, decideClaim, decideSelfGang, shapeScore };
});
