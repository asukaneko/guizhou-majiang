/* 贵州麻将 · 规则核心
 * 纯函数模块，浏览器 / Node 通用。
 *
 * 牌：108 张，万/条/筒 各 1-9，无字牌无花牌。
 * 编号 0..26：0-8 = 一万..九万，9-17 = 一条..九条，18-26 = 一筒..九筒。
 *
 * 玩法模式（MODES）：
 *   classic  经典 · 贵阳捉鸡：四类鸡 + 报听 + 抢杠
 *   yitong   冲幺筒：一筒当财神（可替任意牌），没有鸡，打出幺筒要赔分
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
  const YITONG = 18;    // 幺筒（一筒）

  const suit = (t) => (t / 9) | 0;
  const rank = (t) => (t % 9) + 1;
  const tileName = (t) => CN[t % 9] + SUITS[(t / 9) | 0];
  const nextTile = (t) => (t % 9 === 8 ? t - 8 : t + 1);

  /* ---------------- 玩法模式 ---------------- */

  const MODES = {
    classic: {
      id: 'classic',
      name: '经典 · 贵阳捉鸡',
      short: '经典',
      tag: '108 张 · 捉鸡',
      tagline: '四类鸡、报听锁牌、抢杠热炮，一桌贵阳老规矩。',
      features: [
        '幺鸡 / 乌骨鸡 / 翻牌鸡，金鸡翻倍',
        '报听 · 天听 · 天胡地胡',
        '抢杠胡 · 热炮 · 一炮多响',
        '冲锋鸡（幺鸡 / 八筒各算各的）· 跟冲 · 责任鸡 · 包鸡',
        '黄庄查叫：没叫牌的人赔给叫牌者'
      ],
      wild: null,     // 无财神
      chickens: true,
      accent: 'gold'
    },
    yitong: {
      id: 'yitong',
      name: '幺筒麻将',
      short: '幺筒',
      tag: '财神幺筒',
      tagline: '一筒当财神，能替任意一张牌；谁先把幺筒冲出去，谁收分。',
      features: [
        '幺筒（一筒）为财神，可替代任意牌',
        '软胡 / 硬胡：一张替身都不用 = 硬胡 +5',
        '冲幺筒：第 1 张打出的幺筒向三家各收 5 分，第 2 张收 3 分',
        '幺筒不能碰、不能杠；本模式不捉鸡'
      ],
      wild: YITONG,
      chickens: false,
      accent: 'jade'
    }
  };
  const MODE_ORDER = ['classic', 'yitong'];

  let current = 'classic';

  function resolveMode(mode) {
    if (!mode) return MODES[current] || MODES.classic;
    if (typeof mode === 'string') return MODES[mode] || MODES.classic;
    if (mode.id && MODES[mode.id]) return MODES[mode.id];
    return mode;
  }
  /** 切换当前玩法（胡牌判定 / 听牌等直接按当前模式算） */
  function setMode(mode) {
    const M = resolveMode(mode);
    current = M.id;
    return M;
  }
  const currentMode = () => MODES[current] || MODES.classic;
  const isWildTile = (t, mode) => {
    const M = resolveMode(mode);
    return M.wild !== null && M.wild !== undefined && t === M.wild;
  };

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

  /** 把 c 拆成 sets 组面子（wild 张财神可当任意牌）。不考虑将。 */
  function canFormSets(c, sets, wild) {
    wild = wild || 0;
    if (sets === 0) return wild === 0;
    let i = -1;
    for (let k = 0; k < 27; k++) if (c[k]) { i = k; break; }
    if (i < 0) return wild === sets * 3;

    // 刻子：尽量用真牌，不够的用财神补
    const useReal = Math.min(3, c[i]);
    const needTriplet = 3 - useReal;
    if (needTriplet <= wild) {
      c[i] -= useReal;
      const ok = canFormSets(c, sets - 1, wild - needTriplet);
      c[i] += useReal;
      if (ok) return true;
    }
    // 财神也能补顺子前面的缺张，例如「八万、九万、财神」组成七八九万。
    const suitBase = Math.floor(i / 9) * 9;
    for (let rank = Math.max(0, i % 9 - 2); rank <= Math.min(6, i % 9); rank++) {
      const others = [suitBase + rank, suitBase + rank + 1, suitBase + rank + 2].filter((t) => t !== i);
      for (let a = 0; a <= 1; a++) {
        for (let b = 0; b <= 1; b++) {
          const need = a + b;
          if (need > wild) continue;
          if (!a && c[others[0]] < 1) continue;
          if (!b && c[others[1]] < 1) continue;
          c[i]--; if (!a) c[others[0]]--; if (!b) c[others[1]]--;
          const ok = canFormSets(c, sets - 1, wild - need);
          c[i]++; if (!a) c[others[0]]++; if (!b) c[others[1]]++;
          if (ok) return true;
        }
      }
    }
    return false;
  }

  /** 是否成胡（sets 组面子 + 一对将），wild 为财神张数 */
  function isWinShape(c, setsNeeded, wild) {
    wild = wild || 0;
    for (let i = 0; i < 27; i++) {
      if (c[i] >= 2) {
        c[i] -= 2;
        const ok = canFormSets(c, setsNeeded, wild);
        c[i] += 2;
        if (ok) return true;
      }
    }
    // 将里带财神：一张真牌 + 一张财神，或者两张财神
    if (wild >= 1) {
      for (let i = 0; i < 27; i++) {
        if (c[i] >= 1) {
          c[i] -= 1;
          const ok = canFormSets(c, setsNeeded, wild - 1);
          c[i] += 1;
          if (ok) return true;
        }
      }
    }
    if (wild >= 2 && canFormSets(c, setsNeeded, wild - 2)) return true;
    return false;
  }

  /** 七对（含四归一算两对）；财神可以补单张 */
  function isSevenPairs(c, wild) {
    wild = wild || 0;
    let total = 0;
    let odd = 0;
    for (let i = 0; i < 27; i++) {
      total += c[i];
      if (c[i] % 2) odd++;
    }
    if (odd > wild) return false;
    // 剩下的财神两两成对（张数固定，奇偶自然吻合）
    return total + wild === 14;
  }

  /** 大对子（全是刻子 + 一对将） */
  function allTripletsShape(c, sets, wild) {
    wild = wild || 0;
    for (let i = 0; i < 27; i++) {
      if (c[i] >= 2) {
        c[i] -= 2;
        let ok = true, s = 0;
        for (let k = 0; k < 27; k++) {
          if (c[k] % 3) { ok = false; break; }
          s += c[k] / 3;
        }
        c[i] += 2;
        if (ok && s === sets && wild === 0) return true;
      }
    }
    // 带财神：把不足三张的坎用财神补齐，余下的财神三张一坎
    const tripletsWithWild = (w) => {
      let need = 0;
      for (let k = 0; k < 27; k++) {
        const r = c[k] % 3;
        if (r === 1) need += 2;
        else if (r === 2) need += 1;
      }
      return need <= w && (w - need) % 3 === 0;
    };
    for (let i = 0; i < 27; i++) {
      if (c[i] >= 2) {
        c[i] -= 2;
        const ok = tripletsWithWild(wild);
        c[i] += 2;
        if (ok) return true;
      }
    }
    if (wild >= 1) {
      for (let i = 0; i < 27; i++) {
        if (c[i] >= 1) {
          c[i] -= 1;
          const ok = tripletsWithWild(wild - 1);
          c[i] += 1;
          if (ok) return true;
        }
      }
    }
    if (wild >= 2 && tripletsWithWild(wild - 2)) return true;
    return false;
  }

  /* ---------------- 牌型与分值 ---------------- */
  // 牌型取最高的一种，不叠加。清一色按「手牌 + 副露」整体同门判定。
  const HU_BASE = 4;
  const KONG_POINT = 4;
  const RESPONSIBILITY_POINT = 2;
  const CHI_PAO_MIN = 14;
  const PATTERN_POINTS = {
    ping: HU_BASE, duizi: 10 + HU_BASE, qidui: 20 + HU_BASE, longqidui: 40 + HU_BASE,
    shuanglongqidui: 60 + HU_BASE, sanlongqidui: 80 + HU_BASE,
    qing: 20 + HU_BASE, qingduizi: 30 + HU_BASE, qingqidui: 40 + HU_BASE, qinglongqidui: 60 + HU_BASE,
    qingshuanglongqidui: 80 + HU_BASE, qingsanlongqidui: 100 + HU_BASE
  };
  const PATTERN_NAMES = {
    ping: '平胡', duizi: '大对子', qidui: '七对', longqidui: '龙七对',
    shuanglongqidui: '双龙七对', sanlongqidui: '三龙七对',
    qing: '清一色', qingduizi: '清大对', qingqidui: '清七对', qinglongqidui: '清龙七对',
    qingshuanglongqidui: '清双龙七对', qingsanlongqidui: '清三龙七对'
  };

  /** 不加财神的牌型判定（wild = 已按财神用的张数） */
  function shapeOf(c, melds, wild) {
    wild = wild || 0;
    const sets = 4 - melds.length;
    const cands = [];
    if (melds.length === 0 && isSevenPairs(c, wild)) {
      let quads = 0;
      for (let i = 0; i < 27; i++) if (c[i] >= 4) quads++;
      cands.push(['qidui', 'longqidui', 'shuanglongqidui', 'sanlongqidui'][Math.min(3, quads)]);
    }
    if (isWinShape(c, sets, wild)) {
      cands.push(allTripletsShape(c, sets, wild) ? 'duizi' : 'ping');
    }
    if (!cands.length) return null;
    let best = cands[0];
    for (const s of cands) if (PATTERN_POINTS[s] > PATTERN_POINTS[best]) best = s;
    return best;
  }

  /**
   * 判定胡牌并给出牌型。
   * @param {number[]} hand 手牌
   * @param {Array} melds 副露 [{type:'peng'|'gang'|'angang', tile, tiles, from}]
   * @param {string|Object} [mode] 玩法模式，默认取当前模式
   */
  function winInfo(hand, melds, mode) {
    melds = melds || [];
    const M = resolveMode(mode);
    if (hand.length !== 14 - melds.length * 3) return null;

    if (M.wild === null || M.wild === undefined) return plainWin(hand, melds, 0, null);

    // 幺筒既能当财神，也能当真一筒用：枚举有几张当财神，取分最高的拆法
    let jokers = 0;
    for (const t of hand) if (t === M.wild) jokers++;
    let best = null;
    let bestTotal = -1;
    for (let k = 0; k <= jokers; k++) {
      const rest = hand.slice();
      for (let i = 0; i < k; i++) rest.splice(rest.indexOf(M.wild), 1);
      const r = plainWin(rest, melds, k, M);
      if (!r) continue;
      r.joker = k;
      r.hard = k === 0;
      r.hardBonus = k === 0 ? BONUS.hardHu : 0;
      const total = r.points + r.hardBonus;
      if (total > bestTotal) { bestTotal = total; best = r; }
    }
    return best;
  }

  function plainWin(hand, melds, wild, M) {
    const c = counts(hand);
    const all = hand.concat(...melds.map((m) => m.tiles));
    const real = (M && M.wild !== null && M.wild !== undefined)
      ? all.filter((t) => t !== M.wild)
      : all;
    const pure = real.length > 0 && real.every((t) => suit(t) === suit(real[0]));
    const shape = shapeOf(c, melds, wild);
    if (!shape) return null;
    const pattern = pure ? 'qing' + (shape === 'ping' ? '' : shape) : shape;
    const points = PATTERN_POINTS[pattern];
    return {
      pattern, name: PATTERN_NAMES[pattern], points, pure, shape,
      kongs: melds.filter((m) => m.type !== 'peng').length
    };
  }

  const isWin = (hand, melds, mode) => !!winInfo(hand, melds, mode);

  /** 听牌张（手牌须为 3n+1 张） */
  function tenpaiTiles(hand, melds, mode) {
    melds = melds || [];
    const out = [];
    if (hand.length !== 13 - melds.length * 3) return out;
    const c = counts(hand);
    for (let t = 0; t < 27; t++) {
      if (c[t] >= 4) continue;
      if (winInfo(hand.concat(t), melds, mode)) out.push(t);
    }
    return out;
  }

  /** 查叫：叫牌者按「叫牌牌型的分值」结算，取所听牌中最高分 */
  function tingValue(hand, melds, mode) {
    const tiles = tenpaiTiles(hand, melds, mode);
    let best = 0;
    for (const t of tiles) {
      const info = winInfo(hand.concat(t), melds, mode);
      if (info && info.points > best) best = info.points;
    }
    return { tiles, points: best };
  }

  /** 某人视角下的可见牌张数：自己手牌 + 四家副露 + 四家牌河 */
  function seenCountsOf(hand, players) {
    const c = new Array(27).fill(0);
    for (const t of hand) c[t]++;
    for (const pl of players) {
      for (const m of pl.melds || []) for (const t of m.tiles) c[t]++;
      for (const t of pl.discards || []) c[t]++;
    }
    return c;
  }

  /**
   * 挑一张「打出去仍听牌」的牌：听口可见剩张多者优先，平手偏向刚摸到的那张。
   * 手牌不是 14 - 3×副露 张、或怎么打都不听 → null
   */
  function bestTingOf(hand, melds, seen, justDrawn, mode) {
    if (hand.length !== 14 - melds.length * 3) return null;
    const tried = new Set();
    let best = null;
    for (const tile of hand) {
      if (tried.has(tile)) continue;
      tried.add(tile);
      const rest = hand.slice();
      rest.splice(rest.indexOf(tile), 1);
      const waits = tenpaiTiles(rest, melds, mode);
      if (!waits.length) continue;
      const left = waits.reduce((sum, w) => sum + Math.max(0, 4 - seen[w]), 0);
      const score = left * 2 + (tile === justDrawn ? 1 : 0);
      if (!best || score > best.score) best = { score, tile };
    }
    return best ? best.tile : null;
  }

  function canDeclareTing(player) {
    return !!player && !player.tingDeclared && !(player.discardCount || player.discards?.length) && !player.melds?.length;
  }

  /* ---------------- 吃炮通行证 ---------------- */
  // 门槛按基础牌型分判断，不把报听、硬胡等附加分计入。
  // 例外：手里有豆（杠）就是通行证，任意牌型都能点炮 / 抢杠——平胡有豆也能胡。
  function canChiPao(info) {
    if (!info) return false;
    if ((info.kongs || 0) > 0) return true;
    return info.points >= CHI_PAO_MIN;
  }

  /* ---------------- 鸡 ---------------- */
  // 常鸡：幺鸡（一条）与乌骨鸡（八筒）均为 2 分/张；金鸡翻倍。
  const CHICKEN_BASE = {};
  CHICKEN_BASE[YAOJI] = 2;
  CHICKEN_BASE[WUGU] = 2;

  /**
   * 本局的鸡与分值：幺鸡、乌骨鸡（常鸡，2 分/张）、翻牌鸡（翻牌的下一张，1 分/张；
   * 撞上常鸡即为金鸡，该牌种翻倍）。翻牌鸡只算叫牌（听牌）的人，没叫牌的人不赔。
   */
  function chickenSet(flip, mode) {
    const M = resolveMode(mode);
    if (!M.chickens) return [];
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

  /**
   * 统计某人（手牌 + 副露 + 自己牌河）的鸡分。
   * filter(chicken) 可选：返回 false 的鸡不计入（用于「翻牌鸡只算叫牌的人」）。
   */
  function chickenPoints(hand, melds, discards, chickens, filter) {
    let n = 0;
    if (!chickens || !chickens.length) return 0;
    const hit = (t) => {
      const c = chickens.find((x) => x.tile === t);
      if (c && (!filter || filter(c))) n += c.rate;
    };
    for (const t of hand) hit(t);
    for (const m of melds || []) for (const t of m.tiles) hit(t);
    for (const t of discards || []) hit(t);
    return n;
  }

  /* ---------------- 特殊牌型的加分 ---------------- */
  // 本作口径：都在牌型分之上一次性加分，不叠倍数
  const BONUS = {
    tianhu: 60,    // 天胡：庄家第一摸就胡
    dihu: 30,      // 地胡：下家第一摸自摸 / 胡庄家首张
    baoting: 20,   // 本人首次出牌前报听，胡牌加分（非庄家起手就听也算报听）
    tianting: 40,  // 天听：庄家配完 13 张就听牌并在首次出牌前报听，替代报听加分
    qianggang: 20, // 抢杠胡，由补杠者向每位胡家付一份
    repao: 20,     // 热炮：杠后打出的牌被胡
    hardHu: 5      // 冲幺筒模式：硬胡（一张替身都没用）
  };

  // 冲幺筒：本局第 1 / 第 2 张被打出的幺筒，打牌者向其他三家各收多少分（先冲先赚）
  const CHONG_POINTS = [5, 3];

  return {
    SUITS, CN, YAOJI, WUGU, YITONG,
    suit, rank, tileName, nextTile,
    createWall, shuffle, counts, sortHand,
    canFormSets, isWinShape, isSevenPairs, allTripletsShape,
    winInfo, isWin, tenpaiTiles, tingValue, canChiPao,
    seenCountsOf, bestTingOf, canDeclareTing,
    chickenSet, chickenRate, chickenPoints, CHICKEN_BASE,
    HU_BASE, KONG_POINT, RESPONSIBILITY_POINT, CHI_PAO_MIN, PATTERN_POINTS, PATTERN_NAMES, BONUS, CHONG_POINTS,
    MODES, MODE_ORDER, resolveMode, setMode, currentMode, isWildTile
  };
});
