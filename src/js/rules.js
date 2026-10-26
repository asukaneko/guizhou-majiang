/* 贵阳捉鸡麻将 · 规则核心
 * 纯函数模块，浏览器 / Node 通用。
 *
 * 牌：108 张，万/条/筒 各 1-9，无字牌无花牌。
 * 编号 0..26：0-8 = 一万..九万，9-17 = 一条..九条，18-26 = 一筒..九筒。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GZRules = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SUITS = ['万', '条', '筒'];
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

  const YAOJI = 9;      // 幺鸡（一条）
  const WUGU = 25;      // 乌骨鸡（八筒）

  const suit = (t) => (t / 9) | 0;
  const rank = (t) => (t % 9) + 1;
  const tileName = (t) => CN[t % 9] + SUITS[(t / 9) | 0];
  const nextTile = (t) => (t % 9 === 8 ? t - 8 : t + 1);

  function createWall() {
    const wall = [];
    for (let t = 0; t < 27; t++) for (let i = 0; i < 4; i++) wall.push(t);
    return wall;
  }

  function shuffle(arr, rnd) {
    rnd = rnd || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function counts(hand) {
    const c = new Array(27).fill(0);
    for (let i = 0; i < hand.length; i++) c[hand[i]]++;
    return c;
  }

  const sortHand = (hand) => hand.slice().sort((a, b) => a - b);

  /* ---------------- 胡牌拆解 ---------------- */

  function canFormSets(c, sets) {
    if (sets === 0) {
      for (let i = 0; i < 27; i++) if (c[i]) return false;
      return true;
    }
    let i = -1;
    for (let k = 0; k < 27; k++) if (c[k]) { i = k; break; }
    if (i < 0) return false;
    if (c[i] >= 3) {
      c[i] -= 3;
      const ok = canFormSets(c, sets - 1);
      c[i] += 3;
      if (ok) return true;
    }
    const r = i % 9;
    if (r <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      const ok = canFormSets(c, sets - 1);
      c[i]++; c[i + 1]++; c[i + 2]++;
      if (ok) return true;
    }
    return false;
  }

  function isWinShape(c, setsNeeded) {
    for (let i = 0; i < 27; i++) {
      if (c[i] >= 2) {
        c[i] -= 2;
        const ok = canFormSets(c, setsNeeded);
        c[i] += 2;
        if (ok) return true;
      }
    }
    return false;
  }

  function isSevenPairs(c) {
    let total = 0;
    for (let i = 0; i < 27; i++) {
      if (c[i] % 2) return false;
      total += c[i];
    }
    // 四归一（4 张相同）按两个对子算，所以只看总张数与对子数
    return total === 14;
  }

  function allTripletsShape(c, sets) {
    for (let i = 0; i < 27; i++) {
      if (c[i] >= 2) {
        c[i] -= 2;
        let ok = true, s = 0;
        for (let k = 0; k < 27; k++) {
          if (c[k] % 3) { ok = false; break; }
          s += c[k] / 3;
        }
        c[i] += 2;
        if (ok && s === sets) return true;
      }
    }
    return false;
  }

  /* ---------------- 牌型与分值 ---------------- */
  // 牌型取最高的一种，不叠加。清一色按「手牌 + 副露」整体同门判定。
  const PATTERN_POINTS = {
    ping: 1, duizi: 5, qidui: 7, longqidui: 10,
    qing: 10, qingduizi: 15, qingqidui: 17, qinglongqidui: 20
  };
  const PATTERN_NAMES = {
    ping: '平胡', duizi: '大对子', qidui: '七对', longqidui: '龙七对',
    qing: '清一色', qingduizi: '清大对', qingqidui: '清七对', qinglongqidui: '清龙七对'
  };

  function shapeOf(c, melds, pure) {
    const sets = 4 - melds.length;
    if (melds.length === 0 && isSevenPairs(c)) {
      return c.some((x) => x === 4) ? 'longqidui' : 'qidui';
    }
    if (!isWinShape(c, sets)) return null;
    return allTripletsShape(c, sets) ? 'duizi' : 'ping';
  }

  /**
   * 判定胡牌并给出牌型。
   * @param {number[]} hand 手牌
   * @param {Array} melds 副露 [{type:'peng'|'gang'|'angang', tile, tiles, from}]
   */
  function winInfo(hand, melds) {
    melds = melds || [];
    if (hand.length !== 14 - melds.length * 3) return null;
    const c = counts(hand);
    const all = hand.concat(...melds.map((m) => m.tiles));
    const pure = all.every((t) => suit(t) === suit(all[0]));
    const shape = shapeOf(c, melds, pure);
    if (!shape) return null;
    const pattern = pure ? 'qing' + (shape === 'ping' ? '' : shape) : shape;
    const points = PATTERN_POINTS[pattern];
    return {
      pattern, name: PATTERN_NAMES[pattern], points, pure, shape,
      kongs: melds.filter((m) => m.type !== 'peng').length
    };
  }

  const isWin = (hand, melds) => !!winInfo(hand, melds);

  /** 听牌张（手牌须为 3n+1 张） */
  function tenpaiTiles(hand, melds) {
    melds = melds || [];
    const out = [];
    if (hand.length !== 13 - melds.length * 3) return out;
    const c = counts(hand);
    for (let t = 0; t < 27; t++) {
      if (c[t] >= 4) continue;
      if (winInfo(hand.concat(t), melds)) out.push(t);
    }
    return out;
  }

  /** 查叫：叫牌者按「叫牌牌型的分值」结算，取所听牌中最高分 */
  function tingValue(hand, melds) {
    const tiles = tenpaiTiles(hand, melds);
    let best = 0;
    for (const t of tiles) {
      const info = winInfo(hand.concat(t), melds);
      if (info && info.points > best) best = info.points;
    }
    return { tiles, points: best };
  }

  /* ---------------- 吃炮通行证 ---------------- */
  // 有豆（杠过）→ 平胡也能吃炮；没豆 → 只有 5 分及以上的牌型才能吃炮。
  function canChiPao(info) {
    if (!info) return false;
    return info.kongs > 0 || info.points >= 5;
  }

  /* ---------------- 鸡 ---------------- */
  // 常鸡：幺鸡（一条）1 分/张，乌骨鸡（八筒）2 分/张；金鸡（翻牌鸡正好是常鸡）该牌种翻倍。
  const CHICKEN_BASE = {};
  CHICKEN_BASE[YAOJI] = 1;
  CHICKEN_BASE[WUGU] = 2;

  /** 本局的鸡与分值：幺鸡、乌骨鸡、翻牌鸡（翻牌的下一张，撞上常鸡即为金鸡） */
  function chickenSet(flip) {
    const list = [
      { tile: YAOJI, rate: CHICKEN_BASE[YAOJI], kind: '幺鸡' },
      { tile: WUGU, rate: CHICKEN_BASE[WUGU], kind: '乌骨鸡' }
    ];
    if (flip !== null && flip !== undefined) {
      const t = nextTile(flip);
      const hit = list.find((x) => x.tile === t);
      if (hit) {
        // 金鸡：翻到的牌下一张正好是常鸡 → 该牌种翻倍
        hit.rate = CHICKEN_BASE[t] * 2;
        hit.kind = '金鸡';
      } else {
        list.push({ tile: t, rate: 1, kind: '翻牌鸡' });
      }
    }
    return list;
  }

  /** 某种牌本局算几分鸡（不算就是 0） */
  function chickenRate(chickens, tile) {
    const hit = (chickens || []).find((x) => x.tile === tile);
    return hit ? hit.rate : 0;
  }

  /** 统计某人（手牌 + 副露 + 自己牌河）的鸡分 */
  function chickenPoints(hand, melds, discards, chickens) {
    let n = 0;
    const hit = (t) => {
      const c = chickens.find((x) => x.tile === t);
      if (c) n += c.rate;
    };
    for (const t of hand) hit(t);
    for (const m of melds || []) for (const t of m.tiles) hit(t);
    for (const t of discards || []) hit(t);
    return n;
  }

  /* ---------------- 特殊牌型的加分 ---------------- */
  // 本作口径：都在牌型分之上一次性加分，不叠倍数
  const BONUS = {
    tianhu: 20,    // 天胡：庄家第一摸就胡
    dihu: 10,      // 地胡：闲家第一巡胡（下家第一摸自摸 / 胡庄家首张）
    baoting: 3,    // 报听（硬报）后胡牌
    tianting: 6,   // 天听：起手就听牌并报听（取代报听的 3 分）
    qianggang: 5,  // 抢杠胡（另由杠家包三家）
    repao: 1       // 热炮：杠后打出的牌被胡
  };

  return {
    SUITS, CN, YAOJI, WUGU,
    suit, rank, tileName, nextTile,
    createWall, shuffle, counts, sortHand,
    canFormSets, isWinShape, isSevenPairs, allTripletsShape,
    winInfo, isWin, tenpaiTiles, tingValue, canChiPao,
    chickenSet, chickenRate, chickenPoints, CHICKEN_BASE,
    PATTERN_POINTS, PATTERN_NAMES, BONUS
  };
});
