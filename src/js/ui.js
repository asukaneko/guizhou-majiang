/* 界面：渲染、交互、音效、结算 */
(function () {
  'use strict';

  const R = window.GZRules;
  const T = window.GZTiles;
  const GZ = window.GZGame;
  const $ = (s) => document.querySelector(s);
  const TN = R.tileName;
  const AVATAR = ['你', '下', '对', '上'];

  /* ---------------- 音效（WebAudio 合成，无外部文件） ---------------- */

  const Sound = {
    ctx: null,
    enabled: true,
    ensure() {
      if (!this.enabled) return null;
      if (!this.ctx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        this.ctx = new C();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(freq, dur, type, gain, delay) {
      const ctx = this.ensure();
      if (!ctx) return;
      const t0 = ctx.currentTime + (delay || 0);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.1, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
    noise(dur, gain, freq) {
      const ctx = this.ensure();
      if (!ctx) return;
      const len = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq || 2400;
      bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.value = gain || 0.16;
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start();
    },
    discard() { this.noise(0.06, 0.2, 2200); this.tone(640, 0.05, 'triangle', 0.05); },
    draw() { this.noise(0.04, 0.09, 3200); },
    peng() { this.noise(0.09, 0.26, 1400); this.tone(300, 0.12, 'square', 0.05); },
    gang() { this.noise(0.12, 0.3, 900); this.tone(180, 0.22, 'sawtooth', 0.06); },
    hu() {
      [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.5, 'sine', 0.12, i * 0.08));
    },
    deal() { this.noise(0.3, 0.12, 1500); }
  };

  /* ---------------- 状态 ---------------- */

  let game = null;
  let blockedShown = false;
  const el = {};

  function cacheDom() {
    el.stage = $('#stage');
    el.wrap = $('#stage-wrap');
    el.actions = $('#actions');
    el.calls = $('#calls');
    el.toast = $('#toast');
    el.tip = $('#tip');
    el.overlay = $('#overlay');
    el.round = $('#cp-round');
    el.wall = $('#cp-wall');
    el.turn = $('#cp-turn');
    el.soundBtn = $('#btn-sound');
    el.speedBtn = $('#btn-speed');
  }

  /* ---------------- 出牌速度 ---------------- */

  const SPEEDS = [
    { label: '慢', value: 0.42 },
    { label: '中', value: 0.7 },
    { label: '快', value: 1.3 }
  ];
  let speedIdx = 0;

  function applySpeed() {
    if (game) game.speed = SPEEDS[speedIdx].value;
    el.speedBtn.textContent = `速度 ${SPEEDS[speedIdx].label}`;
    try { localStorage.setItem('gz-speed', String(speedIdx)); } catch (e) { /* ignore */ }
  }

  /* ---------------- 拼装 ---------------- */

  const isKnownChicken = (t) => t === R.YAOJI || t === R.WUGU;

  function faceHtml(t, extra) {
    const classes = `${isKnownChicken(t) ? ' chicken' : ''}${extra ? ' ' + extra : ''}`;
    const marker = extra && extra.indexOf('claim-target') >= 0
      ? '<span class="claim-marker">可碰这张</span>'
      : extra && extra.indexOf('fresh') >= 0
        ? '<span class="claim-marker latest-marker">最新</span>'
        : '';
    return `<div class="tile${classes}" data-tile="${t}">${T.face(t)}${marker}</div>`;
  }

  function backHtml() { return `<div class="back">${T.back()}</div>`; }

  function plateHtml(p, id) {
    const score = game.scores[id];
    const badges = [];
    if (game.dealer === id) badges.push('<span class="badge zhuang">庄</span>');
    if (p.said) badges.push(`<span class="badge said">${p.said}</span>`);
    if (id === 0) {
      const ting = game.tingOf(0);
      if (ting) badges.push(`<span class="badge ting">听 ${ting.tiles.length} 种</span>`);
    }
    return `<div class="avatar">${AVATAR[id]}</div>
      <div class="meta"><span class="name">${p.name}</span>
      <span class="score${score < 0 ? ' neg' : ''}">${score > 0 ? '+' : ''}${score}</span></div>
      <div class="badges">${badges.join('')}</div>`;
  }

  function meldsHtml(p, seat) {
    return p.melds.map((m) => {
      const tiles = m.tiles.map((t) => {
        if (m.type === 'angang' && seat !== 0) return `<div class="tile backface">${T.back()}</div>`;
        return faceHtml(t);
      }).join('');
      return `<div class="meld">${tiles}</div>`;
    }).join('');
  }

  function buildSeats() {
    document.querySelectorAll('.seat').forEach((seat) => {
      const id = +seat.dataset.seat;
      if (id === 0) {
        seat.innerHTML = '<div class="plate"></div><div class="melds"></div><div class="ting-status hidden"></div><div class="hand-main"></div>';
      } else {
        seat.innerHTML = '<div class="plate"></div><div class="hand"></div><div class="melds"></div>';
      }
    });
  }

  const seatEl = (id) => document.querySelector(`.seat[data-seat="${id}"]`);

  /* ---------------- 渲染 ---------------- */

  function setHtml(node, html) {
    if (node._sig === html) return false;
    node._sig = html;
    node.innerHTML = html;
    return true;
  }

  function render() {
    renderSeats();
    renderRivers();
    renderHand();
    renderTingStatus();
    renderCenter();
    renderActions();
    renderActive();
  }

  function renderSeats() {
    game.players.forEach((p) => {
      const seat = seatEl(p.id);
      setHtml(seat.querySelector('.plate'), plateHtml(p, p.id));
      setHtml(seat.querySelector('.melds'), meldsHtml(p, p.id));
      if (p.id !== 0) {
        const n = p.hand.length;
        setHtml(seat.querySelector('.hand'), new Array(n).fill(backHtml()).join(''));
      }
    });
  }

  function renderHand() {
    hideTip();
    const pl = game.players[0];
    const node = seatEl(0).querySelector('.hand-main');
    const hand = pl.hand.slice().sort((a, b) => a - b);
    let drawn = null;
    const awaiting = game.awaiting;
    if (awaiting && awaiting.kind === 'discard' && awaiting.player === 0 && pl.justDrawn != null) {
      const i = hand.indexOf(pl.justDrawn);
      if (i >= 0) { hand.splice(i, 1); drawn = pl.justDrawn; }
    }
    const canPlay = !!(awaiting && awaiting.kind === 'discard' && awaiting.player === 0);
    const html = hand.map((t) => faceHtml(t, canPlay ? 'playable' : '')).join('') +
      (drawn != null ? faceHtml(drawn, 'drawn' + (canPlay ? ' playable' : '')) : '');
    setHtml(node, html);
    node.classList.toggle('my-turn', canPlay);
  }

  function renderRivers() {
    const claim = game.awaiting && game.awaiting.kind === 'claim' ? game.awaiting : null;
    game.players.forEach((p) => {
      const node = document.querySelector(`.river[data-seat="${p.id}"]`);
      const last = game.lastDiscard && game.lastDiscard.p === p.id ? p.discards.length - 1 : -1;
      const claimIndex = claim && claim.from === p.id ? p.discards.length - 1 : -1;
      const html = p.discards.map((t, i) => {
        const classes = [];
        if (i === last || i === claimIndex) classes.push('fresh');
        if (claim && i === claimIndex && t === claim.tile) classes.push('claim-target');
        return faceHtml(t, classes.join(' '));
      }).join('');
      setHtml(node, html);
    });
  }

  function turnLabel() {
    if (game.phase === 'ended') return '本局结束';
    if (game.awaiting && game.awaiting.kind === 'claim') return '等你决定 · 碰 / 杠 / 胡';
    const p = game.players[game.turn];
    if (!p) return '';
    return game.turn === 0 ? '轮到你出牌' : `轮到 ${p.name}`;
  }

  function renderCenter() {
    el.round.textContent = `第 ${game.roundNo} 局`;
    el.wall.textContent = game.wall.length;
    el.turn.textContent = turnLabel();
  }

  function renderActive() {
    game.players.forEach((p) => {
      seatEl(p.id).classList.toggle('active', game.phase !== 'ended' && game.turn === p.id);
    });
  }

  function renderActions() {
    const a = game.awaiting;
    let html = '';
    if (a && a.kind === 'discard' && a.player === 0) {
      const s = a.self || {};
      if (s.hu) html += `<button class="action-btn hu" data-act="hu">胡 ${s.hu.name}</button>`;
      (s.angang || []).forEach((t) => { html += `<button class="action-btn gang" data-act="angang" data-tile="${t}">暗杠 ${TN(t)}</button>`; });
      (s.bugang || []).forEach((t) => { html += `<button class="action-btn gang" data-act="bugang" data-tile="${t}">补杠 ${TN(t)}</button>`; });
    } else if (a && a.kind === 'claim') {
      const source = game.players[a.from] ? game.players[a.from].name : '对方';
      html += `<div class="claim-notice">${source} 打出 <b>${TN(a.tile)}</b></div>`;
      if (a.options.includes('hu')) html += `<button class="action-btn hu" data-act="claim-hu">胡 ${a.info ? a.info.name : ''}</button>`;
      if (a.options.includes('peng')) html += `<button class="action-btn peng" data-act="claim-peng">碰 ${TN(a.tile)}</button>`;
      if (a.options.includes('gang')) html += `<button class="action-btn gang" data-act="claim-gang">杠 ${TN(a.tile)}</button>`;
      html += '<button class="action-btn pass" data-act="claim-pass">过</button>';
    }
    setHtml(el.actions, html);
  }

  /* ---------------- 悬停：打出这张牌之后听什么 ---------------- */

  let tipTile = null;

  function visibleCounts() {
    const c = new Array(27).fill(0);
    const me = game.players[0];
    for (const t of me.hand) c[t]++;
    for (const p of game.players) {
      for (const m of p.melds) for (const t of m.tiles) c[t]++;
      for (const t of p.discards) c[t]++;
    }
    return c;
  }

  function renderTingStatus() {
    const node = seatEl(0).querySelector('.ting-status');
    const ting = game.tingOf(0);
    if (!ting || !ting.tiles.length) {
      node.classList.add('hidden');
      setHtml(node, '');
      return;
    }
    const visible = visibleCounts();
    const waits = ting.tiles.map((tile) => ({
      tile,
      left: Math.max(0, 4 - visible[tile])
    }));
    const total = waits.reduce((sum, wait) => sum + wait.left, 0);
    const tilesHtml = waits.map((wait) =>
      `<span class="ting-wait">${T.face(wait.tile)}<b>${wait.left}</b></span>`
    ).join('');
    const html = `<span class="ting-title">听 ${waits.length} 种</span><span class="ting-waits">${tilesHtml}</span><span class="ting-total">可见共 ${total} 张</span>`;
    node.classList.remove('hidden');
    setHtml(node, html);
  }

  function buildTip(tile) {
    const me = game.players[0];
    const hand = me.hand.slice();
    const idx = hand.indexOf(tile);
    if (idx < 0) return { html: '', waits: [] };
    hand.splice(idx, 1);
    const waits = R.tenpaiTiles(hand, me.melds);
    if (!waits.length) {
      return { html: `<b>打 ${TN(tile)}</b> → 不听牌`, waits: [] };
    }
    const vis = visibleCounts();
    const remain = waits.reduce((s, w) => s + Math.max(0, 4 - vis[w]), 0);
    const tiles = waits.map((t) => `<span class="tile">${T.face(t)}</span>`).join('');
    return {
      html: `<b>打 ${TN(tile)}</b> → 听 <span class="tip-tiles">${tiles}</span> 可见剩 <b>${remain}</b> 张`,
      waits
    };
  }

  function highlightWaits(waits) {
    document.querySelectorAll('.hand-main .tile').forEach((node) => {
      node.classList.toggle('wait', waits.indexOf(+node.dataset.tile) >= 0);
    });
  }

  function hideTip() {
    el.tip.classList.add('hidden');
    tipTile = null;
    highlightWaits([]);
  }

  function showTip(tile, x, y) {
    if (tile !== tipTile) {
      tipTile = tile;
      const r = buildTip(tile);
      if (!r.html) { el.tip.classList.add('hidden'); highlightWaits([]); return; }
      el.tip.innerHTML = r.html;
      highlightWaits(r.waits);
    }
    el.tip.classList.remove('hidden');
    const rect = el.tip.getBoundingClientRect();
    el.tip.style.left = Math.max(8, Math.min(x + 18, window.innerWidth - rect.width - 12)) + 'px';
    el.tip.style.top = Math.max(8, Math.min(y - rect.height - 14, window.innerHeight - rect.height - 12)) + 'px';
  }

  /* ---------------- 反馈 ---------------- */

  function toast(text, ms) {
    const div = document.createElement('div');
    div.className = 'toast-item';
    div.textContent = text;
    el.toast.appendChild(div);
    setTimeout(() => { div.classList.add('out'); setTimeout(() => div.remove(), 320); }, ms || 2200);
  }

  const CALL_POS = {
    0: 'left:50%; bottom:246px; transform:translateX(-50%);',
    1: 'right:210px; top:300px;',
    2: 'left:50%; top:210px; transform:translateX(-50%);',
    3: 'left:210px; top:300px;'
  };

  function showCall(seat, text) {
    const div = document.createElement('div');
    div.className = 'call';
    div.textContent = text;
    div.style.cssText = CALL_POS[seat] || '';
    el.calls.appendChild(div);
    setTimeout(() => div.remove(), 1100);
  }

  /* ---------------- 结算面板 ---------------- */

  function tileMini(t) { return `<div class="tile">${T.face(t)}</div>`; }

  function resultHtml(res) {
    if (res.draw) return drawHtml(res);
    const info = res.info || { name: '胡牌', points: res.points };
    const fromName = res.selfDraw ? '自摸' : `${game.players[res.from].name} 点炮`;
    const melds = res.melds.map((m) => `<div class="meld-inline">${m.tiles.map(tileMini).join('')}</div>`).join('');
    const handTiles = res.hand.map((t) => `<div class="tile${res.winTile === t ? ' win' : ''}">${T.face(t)}</div>`).join('');

    const chickenChips = res.chickens.map((c) =>
      `<span class="ji-chip">${tileMini(c.tile)}${c.kind} ${c.rate} 分/张</span>`).join('');

    const rows = game.players.map((p, i) => {
      const d = res.deltas[i];
      const state = i === res.winner ? '胡牌' : (res.isTing[i] ? '叫牌' : '未叫');
      const n = res.chickenCount[i];
      const jiText = res.isTing[i] ? `${n} 只` : (n ? `${n} 只<i>（未叫不计）</i>` : '0 只');

      // 收支明细：胡 / 豆 / 鸡 三笔
      const parts = [];
      const w = res.winDeltas[i];
      if (w) parts.push(`胡 ${w > 0 ? '+' : ''}${w}`);
      let kong = 0;
      res.kongLog.forEach((k) => { kong += k.deltas[i]; });
      if (kong) parts.push(`豆 ${kong > 0 ? '+' : ''}${kong}`);
      const c = res.chickenDeltas[i];
      if (c) parts.push(`鸡 ${c > 0 ? '+' : ''}${c}`);
      if (!parts.length) parts.push('0');
      const detail = parts.join('<i> · </i>');

      return `<tr class="${i === 0 ? 'me' : ''}">
        <td class="name">${p.name}</td>
        <td>${state}</td>
        <td class="${res.isTing[i] ? '' : 'muted'}">${jiText}</td>
        <td class="detail">${detail}</td>
        <td class="${d >= 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : ''}${d}</td>
        <td class="${res.scores[i] >= 0 ? 'pos' : 'neg'}">${res.scores[i] > 0 ? '+' : ''}${res.scores[i]}</td>
      </tr>`;
    }).join('');

    const kongRows = res.kongLog.length
      ? `<h3>豆（杠）</h3><p class="note">${res.kongLog.map((k) => {
          const who = game.players[k.p].name;
          const kind = k.type === 'angang' ? '暗杠' : k.type === 'bugang' ? '补杠' : '明杠';
          return `${who} ${kind} ${TN(k.tile)}`;
        }).join('　·　')}</p>`
      : '';

    const flipText = res.flip != null
      ? `<div class="ji-flip">翻牌 ${tileMini(res.flip)} <span>${TN(res.flip)}</span> → 翻牌鸡 ${TN(R.nextTile(res.flip))}</div>`
      : '<div class="ji-flip">牌墙已空，未翻牌（只有幺鸡 / 乌骨鸡算鸡）</div>';

    return `<div class="panel">
      <div class="result-head">
        <div>
          <div class="result-pattern">${info.name}</div>
          <div class="sub" style="margin:0">${fromName}　·　${game.players[res.winner].name}</div>
        </div>
        <div class="result-points"><strong>${res.points}</strong><span>胡牌分${res.extra.length ? '（' + res.extra.join('，') + '）' : ''}</span></div>
      </div>
      <div class="win-tiles">${handTiles}${melds}</div>
      <h3>捉鸡</h3>
      ${flipText}
      <div class="ji-row" style="margin-top:8px">${chickenChips}</div>
      <p class="note" style="margin-top:6px">只有叫牌的人收鸡，按手牌 + 副露 + 自己牌河的张数，向其他三家各收一份。</p>
      ${kongRows}
      <h3>本局结算</h3>
      <table class="score-table">
        <thead><tr><th>玩家</th><th>状态</th><th>鸡</th><th>明细（胡 · 豆 · 鸡）</th><th>本局</th><th>总分</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="panel-actions">
        <button class="btn-ghost" data-act="close">看看牌桌</button>
        <button class="btn-primary" data-act="next">再来一局</button>
      </div>
    </div>`;
  }

  function drawHtml(res) {
    const rows = game.players.map((p, i) => {
      const ting = res.ting[i];
      const d = res.deltas[i];
      return `<tr class="${i === 0 ? 'me' : ''}">
        <td class="name">${p.name}</td>
        <td>${ting.tiles.length ? '叫牌' : '未叫'}</td>
        <td>${ting.tiles.length ? ting.tiles.map((t) => TN(t)).join(' ') : '—'}</td>
        <td class="${d >= 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : ''}${d}</td>
        <td class="${res.scores[i] >= 0 ? 'pos' : 'neg'}">${res.scores[i] > 0 ? '+' : ''}${res.scores[i]}</td>
      </tr>`;
    }).join('');
    return `<div class="panel">
      <div class="result-head">
        <div>
          <div class="result-pattern">黄庄</div>
          <div class="sub" style="margin:0">牌墙摸完 · 查叫结算</div>
        </div>
        <div class="result-points"><strong>0</strong><span>本局不翻牌，鸡与豆不另算</span></div>
      </div>
      <h3>查叫</h3>
      <p class="note">未叫牌的人，赔给每个叫牌者「其叫牌牌型的分值」。</p>
      <table class="score-table">
        <thead><tr><th>玩家</th><th>状态</th><th>听牌</th><th>本局</th><th>总分</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="panel-actions">
        <button class="btn-ghost" data-act="close">看看牌桌</button>
        <button class="btn-primary" data-act="next">再来一局</button>
      </div>
    </div>`;
  }

  function showResult(res) {
    el.overlay.classList.remove('hidden');
    el.overlay.innerHTML = resultHtml(res);
    el.overlay._sig = null;
  }

  /* ---------------- 规则 ---------------- */

  const RULES_HTML = `<div class="panel">
    <h2>贵阳捉鸡 · 规则</h2>
    <div class="sub">108 张牌（万 / 条 / 筒 各 1-9），无字牌无花牌；不能吃，只能碰、杠、胡</div>

    <h3>牌型与分值（取最高的一种，不叠加）</h3>
    <ul>
      <li>平胡 <span class="hl">1</span>　大对子 <span class="hl">5</span>　七对 <span class="hl">7</span>　龙七对 <span class="hl">10</span></li>
      <li>清一色 <span class="hl">10</span>　清大对 <span class="hl">15</span>　清七对 <span class="hl">17</span>　清龙七对 <span class="hl">20</span></li>
      <li>自摸 <span class="hl">+1</span>，杠上花 <span class="hl">+1</span>；清一色按「手牌 + 副露」整体同门判定</li>
    </ul>

    <h3>吃炮通行证</h3>
    <p>有豆（杠过）→ 平胡也能吃炮；没有豆 → 只有 5 分以上的牌型才能吃炮，平胡只能自摸。</p>

    <h3>豆（杠）</h3>
    <ul>
      <li>每个豆 3 分：暗杠、补杠由其他三家各付 3；明杠只由放杠那家付 3</li>
      <li>豆分当场结算，直接计入总分</li>
    </ul>

    <h3>鸡</h3>
    <ul>
      <li>幺鸡（一条）、乌骨鸡（八筒）整局都算鸡，各 1 分/张</li>
      <li>翻牌鸡：胡牌后翻牌墙第 1 张，翻到牌的下一张为鸡（翻 5 万 → 6 万；翻 9 条 → 幺鸡）</li>
      <li>金鸡：翻牌鸡正好是幺鸡 / 乌骨鸡时，该牌种本局 2 分/张</li>
      <li>只有<span class="hl">叫牌</span>（听牌）的人收鸡，按手牌 + 副露 + 自己牌河的张数，向其他三家各收一份；未叫家的鸡不算</li>
    </ul>

    <h3>黄庄</h3>
    <p>牌墙摸完不翻牌，豆与鸡都不算，按查叫结算：未叫的人赔给每个叫牌者「其叫牌牌型的分值」。</p>

    <h3>本版未实现</h3>
    <p class="note">报听 / 天听 / 天胡地胡 / 抢杠胡 / 热炮 / 一炮多响 / 冲锋鸡 / 责任鸡 / 包鸡。规则口径参考公开的贵阳捉鸡资料，够日常单机开一桌。</p>

    <div class="panel-actions"><button class="btn-primary" data-act="close-rules">知道了</button></div>
  </div>`;

  function showRules() {
    el.overlay.classList.remove('hidden');
    el.overlay.innerHTML = RULES_HTML;
  }

  /* ---------------- 交互 ---------------- */

  function bind() {
    document.addEventListener('click', (e) => {
      const tile = e.target.closest('.hand-main .tile');
      if (tile && game) {
        const a = game.awaiting;
        if (a && a.kind === 'discard' && a.player === 0) {
          Sound.ensure();
          game.humanDiscard(+tile.dataset.tile);
        }
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'hu') game.humanHu();
      else if (act === 'angang' || act === 'bugang') game.humanGang(act, +btn.dataset.tile);
      else if (act === 'claim-hu' || act === 'claim-peng' || act === 'claim-gang') {
        game.humanRespond(act.replace('claim-', ''));
      } else if (act === 'claim-pass') game.humanRespond('pass');
      else if (act === 'next') { el.overlay.classList.add('hidden'); game.nextRound(); }
      else if (act === 'close') el.overlay.classList.add('hidden');
      else if (act === 'close-rules') el.overlay.classList.add('hidden');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (game && game.awaiting && game.awaiting.kind === 'claim') game.humanRespond('pass');
        else el.overlay.classList.add('hidden');
      }
    });

    /* 鼠标停在手牌上：显示打出去之后听什么、还剩几张 */
    el.stage.addEventListener('mousemove', (e) => {
      const node = e.target && e.target.closest ? e.target.closest('.hand-main .tile') : null;
      const a = game && game.awaiting;
      if (!node || !a || a.kind !== 'discard' || a.player !== 0) {
        if (tipTile !== null) hideTip();
        return;
      }
      showTip(+node.dataset.tile, e.clientX, e.clientY);
    });
    el.stage.addEventListener('mouseleave', () => { if (tipTile !== null) hideTip(); });

    el.speedBtn.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      applySpeed();
    });

    el.soundBtn.addEventListener('click', () => {
      Sound.enabled = !Sound.enabled;
      el.soundBtn.textContent = `音效 ${Sound.enabled ? '开' : '关'}`;
      if (Sound.enabled) Sound.tone(880, 0.1, 'sine', 0.08);
    });

    $('#btn-rules').addEventListener('click', showRules);
    $('#btn-reset-scores').addEventListener('click', () => {
      if (!game) return;
      const ok = window.confirm('确定清空你、下家、对家、上家的累计分数吗？此操作不能撤销。');
      if (!ok) return;
      game.scores = [0, 0, 0, 0];
      game.roundDeltas = [0, 0, 0, 0];
      game.kongLog = [];
      game.result = null;
      el.overlay.classList.add('hidden');
      saveScore();
      render();
      toast('四家累计分数已清零');
    });
    $('#btn-new').addEventListener('click', () => {
      if (!game) return;
      el.overlay.classList.add('hidden');
      game.startRound();
      toast('重新发牌');
    });

    const d = window.desktop;
    if (d) {
      $('#btn-min').addEventListener('click', () => d.minimize());
      $('#btn-max').addEventListener('click', () => d.maximize());
      $('#btn-close').addEventListener('click', () => d.close());
    } else {
      document.querySelector('.win-btns').style.display = 'none';
    }
  }

  /* ---------------- 缩放 ---------------- */

  function fit() {
    const k = Math.min(
      (el.wrap.clientWidth - 4) / 1200,
      (el.wrap.clientHeight - 4) / 740
    );
    el.stage.style.transform = `scale(${k})`;
  }

  /* ---------------- 启动 ---------------- */

  function start() {
    cacheDom();
    buildSeats();
    fit();
    window.addEventListener('resize', fit);

    try {
      const saved = parseInt(localStorage.getItem('gz-speed'), 10);
      if (saved >= 0 && saved < SPEEDS.length) speedIdx = saved;
    } catch (e) { /* ignore */ }

    const savedScore = loadScore();
    game = new GZ.Game({
      speed: SPEEDS[speedIdx].value,
      scores: savedScore ? savedScore.scores : undefined,
      roundNo: savedScore ? savedScore.round : undefined,
      dealer: savedScore ? savedScore.dealer : undefined
    });
    window.__game = game;
    applySpeed();
    saveScore();

    game.on('state', render);
    game.on('deal', () => { Sound.deal(); blockedShown = false; saveScore(); render(); });
    game.on('discard', () => Sound.discard());
    game.on('call', ({ p, text }) => {
      showCall(p, text);
      if (text === '碰') Sound.peng();
      else if (text.indexOf('杠') >= 0) { Sound.gang(); saveScore(); }
      else if (text === '胡') Sound.hu();
    });
    game.on('message', (text) => { if (text) renderCenter(); });
    game.on('blocked', () => {
      if (blockedShown) return;
      blockedShown = true;
      toast('平胡没有豆，不能吃炮，只能自摸');
    });
    game.on('roundEnd', (res) => {
      if (!res.draw) Sound.hu();
      setTimeout(() => showResult(res), 650);
      saveScore();
    });
    game.on('error', () => toast('对局出现异常，已重新发牌'));

    bind();
    game.startRound();
  }

  function loadScore() {
    try {
      const raw = localStorage.getItem('gz-mj-score');
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.scores) || data.scores.length !== 4) return null;
      const scores = data.scores.map((n) => Number.isFinite(Number(n)) ? Number(n) : 0);
      const round = Number.isInteger(data.round) && data.round > 0 ? data.round : 1;
      const dealer = Number.isInteger(data.dealer) && data.dealer >= 0 && data.dealer < 4 ? data.dealer : 0;
      return { scores, round, dealer };
    } catch (e) { return null; }
  }

  function saveScore() {
    if (!game) return;
    try {
      localStorage.setItem('gz-mj-score', JSON.stringify({
        scores: game.scores, round: game.roundNo, dealer: game.dealer
      }));
    } catch (e) { /* ignore */ }
  }

  document.addEventListener('DOMContentLoaded', start);
})();
