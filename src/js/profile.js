/* 玩家资料 / 战绩 / 对局记录 —— 本地存储（localStorage）
 *
 * gz-mj-profile-v2 : 昵称、头像、各玩法战绩、最近对局
 * gz-mj-table-<mode> : 该玩法牌桌上四家的累计分（和局数、庄家）
 */
(function (root) {
  'use strict';

  const PROFILE_KEY = 'gz-mj-profile-v2';
  const LEGACY_KEY = 'gz-mj-score';
  const tableKey = (mode) => 'gz-mj-table-' + mode;

  const AVATARS = ['贵', '雀', '幺', '鸡', '筒', '胡', '福', '和'];
  const RANKS = [
    { at: 0, title: '新手上路' },
    { at: 5, title: '幺鸡学徒' },
    { at: 15, title: '茶馆常客' },
    { at: 30, title: '筑城好手' },
    { at: 60, title: '贵阳老雀' },
    { at: 100, title: '黔中雀神' }
  ];

  const stats = () => ({
    score: 0, games: 0, wins: 0, selfDraws: 0, rounds: 0,
    best: 0, streak: 0, bestStreak: 0, last: 0
  });

  function blank() {
    return {
      v: 2,
      name: '玩家',
      avatar: '贵',
      created: Date.now(),
      modes: { classic: stats(), yitong: stats() },
      history: []
    };
  }

  const clampInt = (n, d) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : d);

  function normalize(raw) {
    const out = blank();
    if (!raw || typeof raw !== 'object') return out;
    out.name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 10) : out.name;
    out.avatar = AVATARS.indexOf(raw.avatar) >= 0 ? raw.avatar : out.avatar;
    out.created = clampInt(raw.created, out.created);
    for (const id of Object.keys(out.modes)) {
      const s = raw.modes && raw.modes[id];
      if (!s) continue;
      for (const k of Object.keys(out.modes[id])) out.modes[id][k] = clampInt(s[k], 0);
    }
    out.history = Array.isArray(raw.history)
      ? raw.history.filter((h) => h && h.mode && out.modes[h.mode]).slice(0, 60)
      : [];
    return out;
  }

  let cache = null;

  function get() {
    if (cache) return cache;
    let raw = null;
    try {
      const txt = localStorage.getItem(PROFILE_KEY);
      if (txt) raw = JSON.parse(txt);
    } catch (e) { raw = null; }
    cache = normalize(raw);
    if (!raw) migrateLegacy();
    return cache;
  }

  function save() {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(cache || blank())); } catch (e) { /* ignore */ }
  }

  /* 老版本只存了经典模式的四家分数，顺手迁到新结构里 */
  function migrateLegacy() {
    try {
      const txt = localStorage.getItem(LEGACY_KEY);
      if (!txt) return;
      const data = JSON.parse(txt);
      if (data && Array.isArray(data.scores) && data.scores.length === 4) {
        localStorage.setItem('gz-mj-table-classic', JSON.stringify({
          scores: data.scores.map((n) => clampInt(n, 0)),
          round: clampInt(data.round, 1),
          dealer: clampInt(data.dealer, 0)
        }));
      }
    } catch (e) { /* ignore */ }
  }

  function mode(id) {
    const p = get();
    if (!p.modes[id]) p.modes[id] = stats();
    return p.modes[id];
  }

  /** 记一局结果：返回写入的对局记录 */
  function record(info) {
    const p = get();
    if (info.onlineRoundId && p.history.some((h) => h.onlineRoundId === info.onlineRoundId)) return;
    const s = mode(info.mode);
    const delta = clampInt(info.delta, 0);
    const win = !!info.win;
    s.games += 1;
    s.rounds += 1;
    s.score += delta;
    s.last = Date.now();
    if (win) {
      s.wins += 1;
      if (info.selfDraw) s.selfDraws += 1;
      s.streak += 1;
      if (s.streak > s.bestStreak) s.bestStreak = s.streak;
    } else {
      s.streak = 0;
    }
    if (delta > s.best) s.best = delta;

    const entry = {
      onlineRoundId: info.onlineRoundId,
      t: Date.now(),
      mode: info.mode,
      delta,
      win,
      selfDraw: !!info.selfDraw,
      pattern: info.pattern || (info.draw ? '黄庄' : ''),
      points: clampInt(info.points, 0)
    };
    p.history.unshift(entry);
    if (p.history.length > 60) p.history.length = 60;
    save();
    return entry;
  }

  /** 生涯汇总 */
  function summary() {
    const p = get();
    let games = 0, wins = 0, selfDraws = 0, score = 0, bestStreak = 0, best = 0, streak = 0;
    for (const id of Object.keys(p.modes)) {
      const s = p.modes[id];
      games += s.games; wins += s.wins; selfDraws += s.selfDraws;
      score += s.score; bestStreak = Math.max(bestStreak, s.bestStreak);
      best = Math.max(best, s.best); streak = Math.max(streak, s.streak);
    }
    const rank = rankOf(games);
    return {
      games, wins, selfDraws, score, bestStreak, best, streak,
      rate: games ? Math.round((wins / games) * 100) : 0,
      rank
    };
  }

  function rankOf(games) {
    let cur = RANKS[0], next = null;
    for (let i = 0; i < RANKS.length; i++) {
      if (games >= RANKS[i].at) { cur = RANKS[i]; next = RANKS[i + 1] || null; }
    }
    const span = next ? next.at - cur.at : 0;
    return {
      title: cur.title,
      level: RANKS.indexOf(cur) + 1,
      next: next ? next.title : null,
      need: next ? next.at - games : 0,
      progress: next ? Math.min(1, (games - cur.at) / Math.max(1, span)) : 1
    };
  }

  function rename(name) {
    const p = get();
    const v = String(name || '').trim().slice(0, 10);
    if (!v) return false;
    p.name = v;
    save();
    return true;
  }

  function cycleAvatar() {
    const p = get();
    const i = AVATARS.indexOf(p.avatar);
    p.avatar = AVATARS[(i + 1) % AVATARS.length];
    save();
    return p.avatar;
  }

  function resetAll() {
    cache = blank();
    save();
    return cache;
  }

  /* ---------------- 牌桌分数（按玩法分开存） ---------------- */

  function tableScore(id) {
    try {
      const txt = localStorage.getItem(tableKey(id));
      if (!txt) return null;
      const data = JSON.parse(txt);
      if (!data || !Array.isArray(data.scores) || data.scores.length !== 4) return null;
      return {
        scores: data.scores.map((n) => clampInt(n, 0)),
        round: Number.isInteger(data.round) && data.round > 0 ? data.round : 1,
        dealer: Number.isInteger(data.dealer) && data.dealer >= 0 && data.dealer < 4 ? data.dealer : 0
      };
    } catch (e) { return null; }
  }

  function saveTable(id, data) {
    try {
      localStorage.setItem(tableKey(id), JSON.stringify({
        scores: data.scores, round: data.round, dealer: data.dealer
      }));
    } catch (e) { /* ignore */ }
  }

  function clearTable(id) {
    try { localStorage.removeItem(tableKey(id)); } catch (e) { /* ignore */ }
  }

  root.GZProfile = {
    AVATARS, RANKS, PROFILE_KEY,
    get, save, summary, rankOf, mode, record,
    rename, cycleAvatar, resetAll,
    tableScore, saveTable, clearTable
  };
})(typeof window !== 'undefined' ? window : globalThis);
