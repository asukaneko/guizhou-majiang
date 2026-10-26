/* 游戏大厅：玩家资料 / 分数 / 最近对局 / 玩法选择 */
(function (root) {
  'use strict';

  const R = root.GZRules;
  const T = root.GZTiles;
  const P = root.GZProfile;
  const $ = (s) => document.querySelector(s);

  let node = null;
  let hooks = { onEnter: null, onRules: null };
  let renaming = false;

  const clock = (ts) => {
    const d = new Date(ts);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };

  const signed = (n) => `${n > 0 ? '+' : ''}${n}`;
  const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

  function modeBadge(id) {
    const m = R.MODES[id] || R.MODES.classic;
    return `<span class="chip ${m.id}">${m.short}</span>`;
  }

  /* ---------------- 侧栏：玩家资料 ---------------- */

  function profileHtml() {
    const p = P.get();
    const sum = P.summary();
    const rank = sum.rank;
    const id = 'pf-name-input';
    const nameHtml = renaming
      ? `<input id="${id}" class="pf-name-input" value="${p.name}" maxlength="10" spellcheck="false" />`
      : `<span class="pf-name-txt">${p.name}</span><button class="pf-mini" data-act="rename">改名</button>`;

    const modeRows = R.MODE_ORDER.map((mid) => {
      const s = P.mode(mid);
      return `<div class="pf-mode">
        ${modeBadge(mid)}
        <b class="${cls(s.score)}">${signed(s.score)}</b>
        <i>${s.games} 局 · ${s.wins} 胡</i>
      </div>`;
    }).join('');

    const nextTxt = rank.next
      ? `再打 ${rank.need} 局升到「${rank.next}」`
      : '已是最高段位';

    return `<aside class="pf-card">
      <div class="pf-head">
        <div class="pf-avatar" data-act="avatar" title="点一下换头像">${p.avatar}</div>
        <div class="pf-id">
          <div class="pf-name">${nameHtml}</div>
          <div class="pf-rank"><span class="pf-badge">Lv.${rank.level} ${rank.title}</span></div>
        </div>
      </div>
      <div class="pf-bar"><i style="width:${Math.round(rank.progress * 100)}%"></i></div>
      <div class="pf-hint">${nextTxt}</div>

      <div class="pf-score">
        <span>生涯总分</span>
        <strong class="${cls(sum.score)}">${signed(sum.score)}</strong>
      </div>

      <div class="pf-grid">
        <div><b>${sum.games}</b><span>对局</span></div>
        <div><b>${sum.wins}</b><span>胡牌</span></div>
        <div><b>${sum.rate}%</b><span>胡牌率</span></div>
        <div><b>${sum.bestStreak}</b><span>最高连胜</span></div>
      </div>
      <div class="pf-grid sub">
        <div><b class="${cls(sum.best)}">${signed(sum.best)}</b><span>单局最高</span></div>
        <div><b>${sum.selfDraws}</b><span>自摸</span></div>
        <div><b>${sum.streak}</b><span>当前连胜</span></div>
      </div>

      <div class="pf-modes">
        <div class="pf-modes-title">各玩法战绩</div>
        ${modeRows}
      </div>
      ${lastHtml()}
      ${formHtml()}

      <div class="pf-foot">
        <span class="pf-tip">资料与战绩只存在本机</span>
        <button class="pf-ghost" data-act="reset">清空战绩</button>
      </div>
    </aside>`;
  }

  /* ---------------- 玩法卡片 ---------------- */

  function artHtml(mode) {
    if (mode.wild !== null && mode.wild !== undefined) {
      // 一筒当财神：后面垫一张普通牌，示意「可替任意牌」
      return `<div class="mc-art">
        <div class="tile art-tile a">${T.face(4)}</div>
        <div class="tile art-tile b wild">${T.face(mode.wild)}</div>
        <span class="art-tag">财神</span>
      </div>`;
    }
    return `<div class="mc-art">
      <div class="tile art-tile a">${T.face(R.YAOJI)}</div>
      <div class="tile art-tile b">${T.face(R.WUGU)}</div>
      <span class="art-tag">捉鸡</span>
    </div>`;
  }

  /** 最近一局的小结 */
  function lastHtml() {
    const p = P.get();
    const h = p.history[0];
    if (!h) return '';
    const res = h.win ? (h.selfDraw ? '自摸' : '胡牌') : (h.pattern === '黄庄' ? '黄庄' : '没胡');
    const detail = h.pattern && h.pattern !== '黄庄' ? `${h.pattern}${h.points ? ` ${h.points} 分` : ''}` : '—';
    return `<div class="pf-last">
      <div class="pf-form-head"><span>最近一局</span><span>${clock(h.t)}</span></div>
      <div class="pf-last-row">
        ${modeBadge(h.mode)}
        <span class="pf-last-res">${res}</span>
        <span class="pf-last-pat">${detail}</span>
        <b class="${cls(h.delta)}">${signed(h.delta)}</b>
      </div>
    </div>`;
  }


  /** 最近 12 局的走势小方块 */
  function formHtml() {
    const p = P.get();
    if (!p.history.length) return '';
    const list = p.history.slice(0, 12).reverse();
    const dots = list.map((h) => {
      const kind = h.win ? 'w' : (h.pattern === '黄庄' ? 'd' : 'l');
      const tip = `${h.win ? '胡' : (h.pattern === '黄庄' ? '黄庄' : '没胡')} ${h.delta > 0 ? '+' : ''}${h.delta}`;
      return `<i class="${kind}" title="${tip}"></i>`;
    }).join('');
    return `<div class="pf-form">
      <div class="pf-form-head"><span>最近 ${list.length} 局</span><span>左旧 → 右新</span></div>
      <div class="pf-dots">${dots}</div>
    </div>`;
  }

  function cardHtml(id) {
    const m = R.MODES[id];
    const s = P.mode(id);
    const table = P.tableScore(id);
    const hasTable = !!(table && table.scores.some((n) => n !== 0));
    const btn = hasTable ? '继续对局' : '开始对局';
    const sub = hasTable
      ? `牌桌进行中 · 第 ${table.round} 局 · 你 ${signed(table.scores[0])}`
      : `${s.games} 局 · 生涯 ${signed(s.score)}`;
    return `<article class="mode-card ${m.id}" data-card="${m.id}">
      <div class="mc-top">
        <div class="mc-text">
          <span class="mc-tag">${m.tag}</span>
          <h3>${m.name}</h3>
          <p>${m.tagline}</p>
        </div>
        ${artHtml(m)}
      </div>
      <ul class="mc-feats">${m.features.map((f) => `<li>${f}</li>`).join('')}</ul>
      <div class="mc-foot">
        <div class="mc-stat"><span>本模式</span><b>${sub}</b></div>
        <button class="mc-rules" data-rules="${m.id}">规则</button>
        <button class="mc-play" data-enter="${m.id}">${btn}</button>
      </div>
    </article>`;
  }

  /* ---------------- 最近对局 ---------------- */

  function historyHtml() {
    const p = P.get();
    if (!p.history.length) {
      return `<div class="hist-empty">还没有对局记录 —— 挑一个玩法开一桌吧</div>`;
    }
    const rows = p.history.slice(0, 8).map((h) => {
      const result = h.win
        ? `<span class="res win">${h.selfDraw ? '自摸' : '胡牌'}</span>`
        : (h.pattern === '黄庄' ? '<span class="res draw">黄庄</span>' : '<span class="res lose">没胡</span>');
      const pattern = h.pattern && h.pattern !== '黄庄'
        ? `${h.pattern}${h.points ? ` ${h.points} 分` : ''}`
        : '—';
      return `<tr>
        <td class="muted">${clock(h.t)}</td>
        <td>${modeBadge(h.mode)}</td>
        <td>${result}</td>
        <td class="muted">${pattern}</td>
        <td class="${cls(h.delta)}">${signed(h.delta)}</td>
      </tr>`;
    }).join('');
    return `<table class="hist-table">
      <thead><tr><th>时间</th><th>玩法</th><th>结果</th><th>牌型</th><th>得分</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    if (!node) return;
    node.innerHTML = `<div class="lb-wrap">
      ${profileHtml()}
      <section class="lb-main">
        <div class="lb-head">
          <div>
            <h2>选择玩法</h2>
            <p>四种牌搭子、幺筒当财神，各是各的账；换玩法不丢分。</p>
          </div>
          <div class="lb-quick">
            <span>本机存档</span>
            <b>${P.get().history.length} 条对局记录</b>
          </div>
        </div>
        <div class="mode-cards">${R.MODE_ORDER.map(cardHtml).join('')}</div>
        <div class="lb-hist">
          <div class="hist-head"><h3>最近对局</h3><span>最多显示 8 条</span></div>
          ${historyHtml()}
        </div>
      </section>
    </div>`;

    if (renaming) {
      const input = node.querySelector('.pf-name-input');
      if (input) { input.focus(); input.select(); }
    }
    if (hooks.onRender) hooks.onRender();
  }

  function show() {
    if (!node) return;
    node.classList.remove('hidden');
    document.body.classList.add('in-lobby');
    render();
  }

  function hide() {
    if (!node) return;
    renaming = false;
    node.classList.add('hidden');
    document.body.classList.remove('in-lobby');
  }

  function commitRename() {
    const input = node.querySelector('.pf-name-input');
    if (!input) return;
    P.rename(input.value);
    renaming = false;
    render();
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    node.addEventListener('click', (e) => {
      const enter = e.target.closest('[data-enter]');
      if (enter) {
        if (hooks.onEnter) hooks.onEnter(enter.dataset.enter);
        return;
      }
      const rules = e.target.closest('[data-rules]');
      if (rules) {
        if (hooks.onRules) hooks.onRules(rules.dataset.rules);
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const name = act.dataset.act;
      if (name === 'avatar') {
        P.cycleAvatar();
        render();
      } else if (name === 'rename') {
        renaming = true;
        render();
      } else if (name === 'reset') {
        const ok = window.confirm('清空本机的全部战绩、各玩法分数和对局记录吗？牌桌上的累计分也会一起归零。');
        if (!ok) return;
        P.resetAll();
        for (const id of R.MODE_ORDER) P.clearTable(id);
        render();
      }
    });

    node.addEventListener('keydown', (e) => {
      if (!node.querySelector('.pf-name-input')) return;
      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
      else if (e.key === 'Escape') { e.preventDefault(); renaming = false; render(); }
    });

    node.addEventListener('focusout', (e) => {
      if (e.target && e.target.classList.contains('pf-name-input')) commitRename();
    });
  }

  function init(options) {
    hooks = Object.assign(hooks, options || {});
    node = $('#lobby');
    if (!node) return;
    bind();
    render();
  }

  root.GZLobby = { init, show, hide, render };
})(typeof window !== 'undefined' ? window : globalThis);
