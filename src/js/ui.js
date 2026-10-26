/* 界面：渲染、交互、音效、结算 */
(function () {
  'use strict';

  const R = window.GZRules;
  const T = window.GZTiles;
  const GZ = window.GZGame;
  const $ = (s) => document.querySelector(s);
  const TN = R.tileName;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    el.lobby = $('#lobby');
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
    el.autoBtn = $('#btn-auto');
    el.brandSub = $('#brand-sub');
    el.lobbyBtn = $('#btn-lobby');
    el.online = $('#online');
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

  /* ---------------- 自动摸打 ---------------- */

  let autoOn = false;

  function applyAuto() {
    if (game && !game.isRemote) game.setAuto(autoOn);
    el.autoBtn.textContent = `自动摸打 ${autoOn ? '开' : '关'}`;
    el.autoBtn.classList.toggle('on', autoOn);
    try { localStorage.setItem('gz-auto', autoOn ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function toggleAuto() {
    autoOn = !autoOn;
    applyAuto();
    toast(autoOn
      ? '自动摸打已开启：听牌后自动替你摸打（碰、杠、胡仍由你点）'
      : '自动摸打关闭，恢复手动出牌', 2600);
  }

  /* ---------------- 拼装 ---------------- */

  const curMode = () => (game && game.mode) || R.MODES.classic;
  const isWild = (t) => {
    const m = curMode();
    return m.wild !== null && m.wild !== undefined && t === m.wild;
  };
  const isKnownChicken = (t) => curMode().chickens && (t === R.YAOJI || t === R.WUGU);

  function faceHtml(t, extra) {
    const classes = `${isKnownChicken(t) ? ' chicken' : ''}${isWild(t) ? ' wild' : ''}${extra ? ' ' + extra : ''}`;
    const marker = extra && extra.indexOf('claim-target') >= 0
      ? '<span class="claim-marker">可碰这张</span>'
      : extra && extra.indexOf('fresh') >= 0
        ? '<span class="claim-marker latest-marker">最新</span>'
        : '';
    const wild = isWild(t) ? '<span class="wild-tag">财神</span>' : '';
    const interactive = extra && extra.includes('playable') ? ` role="button" tabindex="0" aria-label="打出${TN(t)}"` : '';
    return `<div class="tile${classes}" data-tile="${t}"${interactive}>${T.face(t)}${wild}${marker}</div>`;
  }

  function backHtml() { return `<div class="back">${T.back()}</div>`; }

  function plateHtml(p, id) {
    const score = game.scores[id];
    const badges = [];
    if (game.dealer === id) badges.push('<span class="badge zhuang">庄</span>');
    if (p.tingDeclared) badges.push(`<span class="badge baoting">${p.tianTing ? '天听' : '报听'}</span>`);
    if (id === 0 && game.autoPlay) badges.push('<span class="badge auto">自动</span>');
    if (p.said) badges.push(`<span class="badge said">${p.said}</span>`);
    if (id === 0) {
      const ting = game.tingOf(0);
      if (ting) badges.push(`<span class="badge ting">听 ${ting.tiles.length} 种</span>`);
    }
    return `<div class="avatar">${AVATAR[id]}</div>
      <div class="meta"><span class="name">${esc(p.name)}</span>
      <span class="score${score < 0 ? ' neg' : ''}">${score > 0 ? '+' : ''}${score}</span></div>
      ${id ? `<span class="mobile-hand-count">${p.handCount ?? p.hand.length} 张</span>` : ''}
      <div class="badges">${badges.join('')}</div>`;
  }

  function meldsHtml(p, seat) {
    return p.melds.map((m) => {
      const tiles = (m.type === 'angang' && seat !== 0 ? new Array(4).fill(null) : m.tiles).map((t) => {
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
        seat.innerHTML = '<div class="plate"></div><div class="melds"></div><div class="hand-main"></div>';
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
    if (!game || game.players.length !== 4) return;
    document.body.classList.toggle('is-remote', !!game.isRemote);
    renderSeats();
    renderRivers();
    renderHand();
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
        const n = p.handCount != null ? p.handCount : (p.hand ? p.hand.length : 0);
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
    const canPlay = !!(awaiting && awaiting.kind === 'discard' && awaiting.player === 0 && !awaiting.auto);
    let html = hand.map((t) => faceHtml(t, canPlay ? 'playable' : '')).join('') +
      (drawn != null ? faceHtml(drawn, 'drawn' + (canPlay ? ' playable' : '')) : '');
    // 听牌：按手牌样式排在右侧，每张角上标可见剩张
    if (drawn == null) html += tingTilesHtml();
    setHtml(node, html);
    node.classList.toggle('my-turn', canPlay);
  }

  /** 听牌张（手牌样式 + 剩余张数角标），最多展示 4 张，其余用 +N */
  function tingTilesHtml() {
    const ting = game.tingOf(0);
    if (!ting || !ting.tiles.length) return '';
    const visible = visibleCounts();
    const waits = ting.tiles
      .map((tile) => ({ tile, left: Math.max(0, 4 - visible[tile]) }))
      .sort((a, b) => a.tile - b.tile);
    const shown = waits.slice(0, 4);
    const rest = waits.length - shown.length;
    const tiles = shown.map((wait) =>
      `<div class="tile ting-tile" title="${TN(wait.tile)} 可见剩 ${wait.left} 张">${T.face(wait.tile)}<span class="ting-count">${wait.left}</span></div>`
    ).join('');
    return `<div class="ting-sep"></div>${tiles}${rest > 0 ? `<span class="ting-more">+${rest}</span>` : ''}`;
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
      if (setHtml(node, html)) node.scrollTop = node.scrollHeight;
    });
  }

  function turnLabel() {
    if (game.phase === 'ended') return '本局结束';
    if (game.awaiting && game.awaiting.kind === 'claim') return '等你决定 · 碰 / 杠 / 胡';
    if (game.awaiting && game.awaiting.auto) {
      return game.awaiting.ting ? '报听中' : '自动摸打中';
    }
    const p = game.players[game.turn];
    if (!p) return '';
    return game.turn === 0 ? '轮到你出牌' : `轮到 ${p.name}`;
  }

  function renderCenter() {
    el.round.textContent = `第 ${game.roundNo} 局${game.totalRounds ? ` / ${game.totalRounds}` : ''}`;
    el.wall.textContent = game.isRemote ? game.wallLeft : game.wall.length;
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
      if (a.auto) {
        html += `<div class="auto-hint">${a.ting ? '报听' : '自动摸打'} · ${a.autoTile != null ? '打出 ' + TN(a.autoTile) : '自摸'}</div>`;
      } else {
        const s = a.self || {};
        if (s.hu) html += `<button class="action-btn hu" data-act="hu">胡 ${s.hu.name}</button>`;
        (s.angang || []).forEach((t) => { html += `<button class="action-btn gang" data-act="angang" data-tile="${t}">暗杠 ${TN(t)}</button>`; });
        (s.bugang || []).forEach((t) => { html += `<button class="action-btn gang" data-act="bugang" data-tile="${t}">补杠 ${TN(t)}</button>`; });
        if (game.canTing(0)) html += '<button class="action-btn ting" data-act="ting">报听</button>';
        const chong = wildHint();
        if (chong) html += `<div class="auto-hint chong-hint">${chong}</div>`;
        if (game.autoPlay && !game.autoDecision(0, a.self)) {
          html += '<div class="auto-hint">自动摸打待命 · 还没听牌，先手动打一张</div>';
        }
      }
    } else if (a && a.kind === 'claim') {
      const source = esc(game.players[a.from] ? game.players[a.from].name : '对方');
      html += a.rob
        ? `<div class="claim-notice">${source} 补杠 <b>${TN(a.tile)}</b> · 可以抢杠</div>`
        : `<div class="claim-notice">${source} 打出 <b>${TN(a.tile)}</b></div>`;
      if (a.options.includes('hu')) html += `<button class="action-btn hu" data-act="claim-hu">${a.rob ? '抢杠胡' : '胡'} ${a.info ? a.info.name : ''}</button>`;
      if (a.options.includes('peng')) html += `<button class="action-btn peng" data-act="claim-peng">碰 ${TN(a.tile)}</button>`;
      if (a.options.includes('gang')) html += `<button class="action-btn gang" data-act="claim-gang">杠 ${TN(a.tile)}</button>`;
      html += '<button class="action-btn pass" data-act="claim-pass">过</button>';
    }
    setHtml(el.actions, html);
  }

  /* ---------------- 悬停：打出这张牌之后听什么 ---------------- */

  let tipTile = null;

  /** 冲幺筒还有分可拿时，提示手里那张幺筒值多少 */
  function wildHint() {
    const m = curMode();
    if (!game || m.wild === null || m.wild === undefined) return '';
    const left = R.CHONG_POINTS.length - (game.chongCount || 0);
    if (left <= 0) return '';
    const hand = game.players[0].hand;
    if (hand.indexOf(m.wild) < 0) return '';
    return `冲幺筒 · 打出 ${TN(m.wild)} 向三家各收 ${R.CHONG_POINTS[game.chongCount]} 分`;
  }

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
    const chongLeft = R.CHONG_POINTS.length - (game.chongCount || 0);
    const chong = isWild(tile) && chongLeft > 0
      ? `<div class="tip-chong">冲幺筒 · 向其他三家各收 ${R.CHONG_POINTS[game.chongCount]} 分</div>` : '';
    const waits = R.tenpaiTiles(hand, me.melds, game.mode);
    if (!waits.length) {
      return { html: `${chong}<b>打 ${TN(tile)}</b> → 不听牌`, waits: [] };
    }
    const vis = visibleCounts();
    const remain = waits.reduce((s, w) => s + Math.max(0, 4 - vis[w]), 0);
    const tiles = waits.map((t) => `<span class="tile">${T.face(t)}</span>`).join('');
    return {
      html: `${chong}<b>打 ${TN(tile)}</b> → 听 <span class="tip-tiles">${tiles}</span> 可见剩 <b>${remain}</b> 张`,
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
    div.dataset.seat = seat;
    div.style.cssText = CALL_POS[seat] || '';
    el.calls.appendChild(div);
    setTimeout(() => div.remove(), 1100);
  }

  /* ---------------- 结算面板 ---------------- */

  function tileMini(t) { return `<div class="tile">${T.face(t)}</div>`; }

  function resultHtml(res) {
    if (res.draw) return drawHtml(res);
    const mode = R.MODES[res.mode] || R.MODES.classic;
    const winners = res.winners || [{
      p: res.winner, winTile: res.winTile, selfDraw: res.selfDraw, from: res.from,
      hand: res.hand, melds: res.melds, info: res.info, points: res.points, extra: res.extra || []
    }];
    const isWinner = (i) => winners.some((w) => w.p === i);
    const multi = winners.length > 1;

    const blocks = winners.map((w) => {
      const info = w.info || { name: '胡牌', points: w.points };
      const fromName = w.selfDraw ? '自摸'
        : res.robKong ? `抢杠（${esc(game.players[w.from].name)} 补杠）`
          : `${esc(game.players[w.from].name)} 点炮`;
      const melds = w.melds.map((m) => `<div class="meld-inline">${m.tiles.map(tileMini).join('')}</div>`).join('');
      const handTiles = w.hand.map((t) => `<div class="tile${w.winTile === t ? ' win' : ''}${isWild(t) ? ' wild' : ''}">${T.face(t)}</div>`).join('');
      const softTag = w.hard === undefined || w.hard === null ? ''
        : w.hard ? '<span class="hard-tag hard">硬胡</span>' : '<span class="hard-tag soft">软胡</span>';
      return `<div class="winner-block">
        <div class="result-head">
          <div>
            <div class="result-pattern">${multi ? `<span class="winner-tag">${esc(game.players[w.p].name)}</span>` : ''}${info.name}${softTag}</div>
            <div class="sub" style="margin:0">${fromName}</div>
          </div>
          <div class="result-points"><strong>${w.points}</strong><span>胡牌分${w.extra && w.extra.length ? '（' + w.extra.join('，') + '）' : ''}</span></div>
        </div>
        <div class="win-tiles">${handTiles}${melds}</div>
      </div>`;
    }).join('');

    const banner = multi
      ? `<div class="multi-banner">一炮 ${winners.length} 响 · ${esc(game.players[winners[0].from].name)} 一家赔 ${winners.length} 份</div>`
      : '';

    /* 鸡（经典）/ 幺筒（幺筒麻将）说明区 */
    let collectHead = '捉鸡';
    let collectHtml = '';
    if (mode.chickens) {
      const chickenChips = res.chickens.map((c) =>
        `<span class="ji-chip">${tileMini(c.tile)}${c.kind} ${c.rate} 分/张</span>`).join('') +
        (res.charge ? `<span class="ji-chip charge">${tileMini(res.charge.tile)}冲锋鸡 ×2（${esc(game.players[res.charge.p].name)}）</span>` : '');
      const flipText = res.flip != null
        ? `<div class="ji-flip">翻牌 ${tileMini(res.flip)} <span>${TN(res.flip)}</span> → 翻牌鸡 ${TN(R.nextTile(res.flip))}</div>`
        : '<div class="ji-flip">牌墙已空，未翻牌（只有幺鸡 / 乌骨鸡算鸡）</div>';
      const baojiText = (res.baoji && res.baoji.length)
        ? `<p class="note">包鸡：${res.baoji.map((b) => `${esc(game.players[b.p].name)} 没叫牌，${b.points} 分赔给 ${esc(game.players[b.to].name)}`).join('；')}</p>`
        : '';
      collectHtml = `${flipText}
        <div class="ji-row" style="margin-top:8px">${chickenChips}</div>
        <p class="note" style="margin-top:6px">叫牌的人按手牌 + 副露 + 自己牌河的张数，向其他三家各收一份；没叫牌的人（包鸡）反而把自己的鸡赔给胡牌的人。</p>
        ${baojiText}`;
    } else {
      collectHead = '幺筒（财神）';
      const chong = (res.chongLog || []).map((k) =>
        `第 ${k.seq} 张 · ${esc(game.players[k.p].name)} 打出，向其他三家各收 ${k.points} 分`);
      collectHtml = `<div class="ji-flip">幺筒 = ${tileMini(18)} <span>一筒</span> → 可替代任意牌；不能碰、不能杠</div>
        <div class="ji-row" style="margin-top:8px">
          <span class="ji-chip">${tileMini(18)}财神 · 替任意牌</span>
          <span class="ji-chip">软胡（用了替身）</span>
          <span class="ji-chip">硬胡（没用替身）+${R.BONUS.hardHu}</span>
          <span class="ji-chip">首冲 ${R.CHONG_POINTS[0]} 分/家 · 二冲 ${R.CHONG_POINTS[1]} 分/家</span>
        </div>
        <p class="note" style="margin-top:6px">本模式不捉鸡：只算胡牌分、豆和冲幺筒的流水。${
          chong.length ? '冲幺筒记录：' + chong.join('；') : '本局没有幺筒被打出。'
        }</p>`;
    }

    const rows = game.players.map((p, i) => {
      const d = res.deltas[i];
      const state = isWinner(i) ? '胡牌' : (res.isTing[i] ? '叫牌' : '未叫');

      // 收支明细：胡 / 豆 · 责任鸡 / 鸡（或冲幺筒）
      const parts = [];
      const w = res.winDeltas[i];
      if (w) parts.push(`胡 ${w > 0 ? '+' : ''}${w}`);
      let kong = 0, chong = 0;
      res.kongLog.forEach((k) => { kong += k.deltas[i]; });
      (res.penaltyLog || []).forEach((k) => {
        if (k.kind === '冲幺筒') chong += k.deltas[i];
        else kong += k.deltas[i];
      });
      if (kong) parts.push(`豆 ${kong > 0 ? '+' : ''}${kong}`);
      if (chong) parts.push(`冲 ${chong > 0 ? '+' : ''}${chong}`);
      if (mode.chickens) {
        const c = res.chickenDeltas[i];
        if (c) parts.push(`鸡 ${c > 0 ? '+' : ''}${c}`);
      }
      if (!parts.length) parts.push('0');
      const detail = parts.join('<i> · </i>');

      const collectCell = mode.chickens
        ? `<td class="${res.isTing[i] ? '' : 'muted'}">${res.isTing[i]
            ? `${res.chickenCount[i]} 分`
            : (res.chickenCount[i] ? `${res.chickenCount[i]} 分<i>（包鸡）</i>` : '0')}</td>`
        : '';

      return `<tr class="${i === 0 ? 'me' : ''}">
        <td class="name">${esc(p.name)}</td>
        <td>${state}</td>
        ${collectCell}
        <td class="detail">${detail}</td>
        <td class="${d >= 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : ''}${d}</td>
        <td class="${res.scores[i] >= 0 ? 'pos' : 'neg'}">${res.scores[i] > 0 ? '+' : ''}${res.scores[i]}</td>
      </tr>`;
    }).join('');

    const kongNotes = res.kongLog.map((k) => {
      const who = game.players[k.p].name;
      const kind = k.type === 'angang' ? '暗杠' : k.type === 'bugang' ? '补杠' : '明杠';
      return `${who} ${kind} ${TN(k.tile)}`;
    }).concat((res.penaltyLog || []).filter((k) => k.kind !== '冲幺筒').map((k) =>
      `${esc(game.players[k.p].name)} 冲锋鸡被 ${esc(game.players[k.to].name)} 拿走，责任鸡赔 ${k.points} 分`
    ));
    const kongRows = kongNotes.length
      ? `<h3>豆 / 责任鸡</h3><p class="note">${kongNotes.join('　·　')}</p>`
      : '';

    const headCells = mode.chickens
      ? '<th>玩家</th><th>状态</th><th>鸡</th><th>明细（胡 · 豆 · 鸡）</th><th>本局</th><th>总分</th>'
      : '<th>玩家</th><th>状态</th><th>明细（胡 · 豆 · 冲）</th><th>本局</th><th>总分</th>';

    return `<div class="panel${multi ? ' multi' : ''}">
      ${banner}
      ${blocks}
      <h3>${collectHead}</h3>
      ${collectHtml}
      ${kongRows}
      <h3>本局结算</h3>
      <table class="score-table">
        <thead><tr>${headCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="panel-actions">
        <button class="btn-ghost" data-act="close">看看牌桌</button>
        <button class="btn-ghost" data-act="lobby">回大厅</button>
        <button class="btn-primary" data-act="next">再来一局</button>
      </div>
    </div>`;
  }

  function drawHtml(res) {
    const mode = R.MODES[res.mode] || R.MODES.classic;
    const rows = game.players.map((p, i) => {
      const ting = res.ting[i];
      const d = res.deltas[i];
      return `<tr class="${i === 0 ? 'me' : ''}">
        <td class="name">${esc(p.name)}</td>
        <td>${ting.tiles.length ? '叫牌' : '未叫'}</td>
        <td>${ting.tiles.length ? ting.tiles.map((t) => TN(t)).join(' ') : '—'}</td>
        <td class="${d >= 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : ''}${d}</td>
        <td class="${res.scores[i] >= 0 ? 'pos' : 'neg'}">${res.scores[i] > 0 ? '+' : ''}${res.scores[i]}</td>
      </tr>`;
    }).join('');
    const chong = (res.chongLog || []).map((k) =>
      `${esc(game.players[k.p].name)} 冲幺筒（第 ${k.seq} 张）赔 ${k.points} 分/家`);
    const note = mode.chickens
      ? '本局不翻牌，鸡与豆不另算，按查叫结算。'
      : `本模式不捉鸡，按查叫结算。${chong.length ? '冲幺筒：' + chong.join('；') : ''}`;
    return `<div class="panel">
      <div class="result-head">
        <div>
          <div class="result-pattern">黄庄</div>
          <div class="sub" style="margin:0">${mode.name} · 牌墙摸完 · 查叫结算</div>
        </div>
        <div class="result-points"><strong>0</strong><span>本局不翻牌</span></div>
      </div>
      <h3>查叫</h3>
      <p class="note">未叫牌的人，赔给每个叫牌者「其叫牌牌型的分值」。${note}</p>
      <table class="score-table">
        <thead><tr><th>玩家</th><th>状态</th><th>听牌</th><th>本局</th><th>总分</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="panel-actions">
        <button class="btn-ghost" data-act="close">看看牌桌</button>
        <button class="btn-ghost" data-act="lobby">回大厅</button>
        <button class="btn-primary" data-act="next">再来一局</button>
      </div>
    </div>`;
  }

  function showResult(res) {
    el.overlay.classList.remove('hidden');
    el.overlay.innerHTML = resultHtml(res);
    refreshRoundActions();
    el.overlay._sig = null;
  }

  function refreshRoundActions() {
    if (!game) return;
    if (game.isRemote) {
      const next = el.overlay.querySelector('[data-act="next"]');
      const room = window.GZOnline.room;
      if (next && room) {
        const finished = game.roundNo >= room.totalRounds;
        next.disabled = finished || !room.host;
        next.textContent = finished ? '本桌已结束' : room.host ? '开始下一局' : '等待房主开局';
      }
      const back = el.overlay.querySelector('[data-act="lobby"]');
      if (back) back.textContent = '返回房间';
    }
  }

  /** 新一局开始（联机：房主开了下一局）→ 收起上一局结算 */
  function hideResult() {
    el.overlay.classList.add('hidden');
    el.overlay.innerHTML = '';
  }

  /* ---------------- 规则 ---------------- */

  const RULES_COMMON = `
    <h3>豆（杠）</h3>
    <ul>
      <li>每个豆 3 分：暗杠、补杠由其他三家各付 3；明杠只由放杠那家付 3</li>
      <li>豆分当场结算，直接计入总分</li>
    </ul>

    <h3>抢杠胡 / 热炮 / 一炮多响</h3>
    <ul>
      <li><span class="hl">抢杠胡</span>：别人补杠的那张牌正好是你听的牌 → 你可以抢杠，杠不成立，杠家包三家。</li>
      <li><span class="hl">热炮</span>：杠完后打出的第一张牌被别人胡，胡牌分 +1。</li>
      <li><span class="hl">一炮多响</span>：一张牌同时被两家以上胡，所有人都算胡，点炮者各赔一份。</li>
    </ul>

    <h3>报听 / 天听</h3>
    <p>轮到你出牌且手牌听牌时，可以点「<span class="hl">报听</span>」：系统替你打出那张保持听牌的牌，之后手牌锁定——不能再碰、不能杠，摸什么打什么，见胡就胡。起手 13 张就听牌、并且在第一巡报听，算<span class="hl">天听</span>（+6）。</p>

    <h3>黄庄</h3>
    <p>牌墙摸完按查叫结算：未叫的人赔给每个叫牌者「其叫牌牌型的分值」。</p>

    <h3>自动摸打</h3>
    <p>右上角「自动摸打」开关（快捷键 <span class="hl">A</span>）：听牌后自动替你摸打，打出一张仍保持听牌的牌，能自摸就直接胡；碰、杠、吃炮胡仍然由你决定。</p>`;

  const RULES_BODY = {
    classic: `
    <div class="sub">108 张牌（万 / 条 / 筒 各 1-9），无字牌无花牌；不能吃，只能碰、杠、胡</div>

    <h3>牌型与分值（取最高的一种，不叠加）</h3>
    <ul>
      <li>平胡 <span class="hl">1</span>　大对子 <span class="hl">5</span>　七对 <span class="hl">7</span>　龙七对 <span class="hl">10</span></li>
      <li>清一色 <span class="hl">10</span>　清大对 <span class="hl">15</span>　清七对 <span class="hl">17</span>　清龙七对 <span class="hl">20</span></li>
      <li>自摸 <span class="hl">+1</span>，杠上花 <span class="hl">+1</span>；清一色按「手牌 + 副露」整体同门判定</li>
    </ul>

    <h3>特殊牌型加分（在牌型分之上相加）</h3>
    <ul>
      <li>天胡 <span class="hl">+20</span>：庄家配牌后第一摸就自摸</li>
      <li>地胡 <span class="hl">+10</span>：闲家第一巡就胡（下家第一摸自摸，或胡庄家打出的第一张）</li>
      <li>报听 <span class="hl">+3</span>、天听 <span class="hl">+6</span>：主动报听 / 起手就听牌并报听</li>
      <li>抢杠胡 <span class="hl">+5</span>，另由杠家包三家（赔三份）</li>
      <li>热炮 <span class="hl">+1</span>：杠后打出的那张牌被别人胡</li>
    </ul>

    <h3>吃炮通行证</h3>
    <p>有豆（杠过）→ 平胡也能吃炮；没有豆 → 只有 5 分以上的牌型才能吃炮，平胡只能自摸。抢杠胡不受此限。</p>

    <h3>鸡</h3>
    <ul>
      <li>幺鸡（一条）1 分/张，乌骨鸡（八筒）2 分/张，整局都算</li>
      <li>翻牌鸡：胡牌后翻牌墙第 1 张，翻到牌的下一张为鸡（翻 5 万 → 6 万；翻 9 条 → 幺鸡），1 分/张</li>
      <li><span class="hl">金鸡</span>：翻牌鸡正好是幺鸡 / 乌骨鸡时，该牌种翻倍（幺鸡 2 分、八筒 4 分）</li>
      <li><span class="hl">冲锋鸡</span>：本局第一张被打出的幺鸡 / 八筒，计双倍</li>
      <li><span class="hl">责任鸡</span>：冲锋鸡被别人碰 / 杠走 → 打牌的人赔一个豆（3 分）给拿走的人，这张不再翻倍</li>
      <li><span class="hl">包鸡</span>：胡牌时没叫牌的人，自己手里的鸡反过来赔给胡牌的人</li>
      <li>叫牌（听牌）的人按手牌 + 副露 + 自己牌河的张数，向其他三家各收一份</li>
    </ul>
    ${RULES_COMMON}`,

    yitong: `
    <div class="sub">108 张牌（万 / 条 / 筒 各 1-9），四家，不能吃；一筒就是<span class="hl">幺筒</span></div>

    <h3>财神：幺筒</h3>
    <ul>
      <li>手里的每张幺筒都能<span class="hl">替代任意一张牌</span>去凑牌型：顺子缺张、刻子缺张、将缺一张，都能用幺筒替</li>
      <li>幺筒也可以当真一筒用（凑 123 筒、当刻子、当将），怎么划算怎么来</li>
      <li><span class="hl">软胡</span>：胡牌时用了替身（至少一张幺筒当别的牌）</li>
      <li><span class="hl">硬胡</span>：一张替身都没用（幺筒全当真一筒，或者手里根本没幺筒），胡牌分 <span class="hl">+5</span></li>
      <li>幺筒<span class="hl">不能碰、不能杠</span>——财神不成坎</li>
    </ul>

    <h3>冲幺筒</h3>
    <ul>
      <li>本局<span class="hl">第一张</span>被打出的幺筒：打牌者向其他三家<span class="hl">各收 5 分</span></li>
      <li>本局<span class="hl">第二张</span>：各收 <span class="hl">3 分</span>；第三、第四张没有冲分</li>
      <li>先冲先赚：4 张幺筒谁先打出去谁收钱——冲出去就少一张财神，自己权衡</li>
      <li>电脑也懂这个：冲分还没被拿完时，会主动把幺筒打出来抢分</li>
    </ul>

    <h3>牌型与分值（与经典一致，取最高的一种）</h3>
    <ul>
      <li>平胡 <span class="hl">1</span>　大对子 <span class="hl">5</span>　七对 <span class="hl">7</span>　龙七对 <span class="hl">10</span></li>
      <li>清一色 <span class="hl">10</span>　清大对 <span class="hl">15</span>　清七对 <span class="hl">17</span>　清龙七对 <span class="hl">20</span></li>
      <li>自摸 <span class="hl">+1</span>，杠上花 <span class="hl">+1</span>，硬胡 <span class="hl">+5</span></li>
      <li>天胡 <span class="hl">+20</span>　地胡 <span class="hl">+10</span>　报听 <span class="hl">+3</span>　天听 <span class="hl">+6</span>　抢杠胡 <span class="hl">+5</span>　热炮 <span class="hl">+1</span></li>
    </ul>

    <h3>本模式没有鸡</h3>
    <p>幺鸡、八筒在这里都只是普通牌；不算鸡、不翻牌、也没有包鸡。结算只看：胡牌分 + 豆 + 冲幺筒。</p>
    ${RULES_COMMON}`
  };

  function rulesHtml(tab) {
    const id = R.MODES[tab] ? tab : (game ? game.mode.id : 'classic');
    const tabs = R.MODE_ORDER.map((mid) =>
      `<button class="rules-tab${mid === id ? ' on' : ''}" data-rules-tab="${mid}">${R.MODES[mid].name}</button>`
    ).join('');
    return `<div class="panel rules-panel">
      <h2>玩法规则</h2>
      <div class="rules-tabs">${tabs}</div>
      ${RULES_BODY[id]}
      <p class="note">规则口径参考公开的贵阳捉鸡 / 遵义幺筒麻将资料；加分与赔率是为单机对局定的固定值，可在规则里随时改。</p>
      <div class="panel-actions"><button class="btn-primary" data-act="close-rules">知道了</button></div>
    </div>`;
  }

  function showRules(tab) {
    el.overlay.classList.remove('hidden');
    el.overlay.innerHTML = rulesHtml(tab);
  }

  /* ---------------- 交互 ---------------- */

  function bind() {
    document.addEventListener('click', (e) => {
      const tile = e.target.closest('.hand-main .tile.playable');
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
      else if (act === 'ting') game.humanTing();
      else if (act === 'angang' || act === 'bugang') game.humanGang(act, +btn.dataset.tile);
      else if (act === 'claim-hu' || act === 'claim-peng' || act === 'claim-gang') {
        game.humanRespond(act.replace('claim-', ''));
      } else if (act === 'claim-pass') game.humanRespond('pass');
      else if (act === 'next') {
        el.overlay.classList.add('hidden');
        if (game.isRemote) {
          const onlineRoom = window.GZOnline.room;
          if (onlineRoom && onlineRoom.host) {
            // 房主开下一局；其他玩家由服务端 room 广播自动进场
            window.GZNet.send({ t: 'next' });
          } else {
            toast('等房主开下一局', 2200);
            showOnlineRoom();
          }
        } else game.nextRound();
      }
      else if (act === 'close') el.overlay.classList.add('hidden');
      else if (act === 'lobby') {
        if (game && game.isRemote) showOnlineRoom();
        else showLobby();
      }
      else if (act === 'close-rules') el.overlay.classList.add('hidden');
    });

    // 规则面板：切换玩法页签
    document.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-rules-tab]');
      if (!tab) return;
      showRules(tab.dataset.rulesTab);
    });

    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tile.playable')) {
        e.preventDefault(); e.target.click(); return;
      }
      if (e.key === 'Escape') {
        if (game && game.awaiting && game.awaiting.kind === 'claim') game.humanRespond('pass');
        else el.overlay.classList.add('hidden');
        return;
      }
      // 键盘 A：开关自动摸打
      if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey) toggleAuto();
    });

    /* 鼠标停在手牌上：显示打出去之后听什么、还剩几张 */
    el.stage.addEventListener('mousemove', (e) => {
      if (window.matchMedia('(pointer: coarse)').matches) return;
      const node = e.target && e.target.closest ? e.target.closest('.hand-main .tile') : null;
      const a = game && game.awaiting;
      if (!node || !a || a.kind !== 'discard' || a.player !== 0 || a.auto) {
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

    el.autoBtn.addEventListener('click', toggleAuto);

    el.soundBtn.addEventListener('click', () => {
      Sound.enabled = !Sound.enabled;
      el.soundBtn.textContent = `音效 ${Sound.enabled ? '开' : '关'}`;
      if (Sound.enabled) Sound.tone(880, 0.1, 'sine', 0.08);
    });

    $('#btn-rules').addEventListener('click', () => showRules(game ? game.mode.id : 'classic'));
    el.lobbyBtn.addEventListener('click', showLobby);
    $('#btn-reset-scores').addEventListener('click', () => {
      if (!game || game.isRemote) return;
      const ok = window.confirm(`确定清空「${game.mode.name}」牌桌上四家的累计分数吗？（生涯战绩在大厅里清空）`);
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
      if (!game || game.isRemote) return;
      el.overlay.classList.add('hidden');
      game.startRound();
      toast('重新发牌');
    });
    $('#btn-fullscreen').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (document.body.classList.contains('mobile-table')) window.GZViewport.enter(true);
      else document.documentElement.requestFullscreen?.().catch(() => {});
    });
    document.addEventListener('pointerdown', () => {
      if (document.body.classList.contains('in-game')) window.GZViewport.enter();
    }, { passive: true });

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
    const view = window.GZViewport.layout();
    if (view.mobile) { el.stage.style.transform = ''; return; }
    const box = el.wrap;
    if (!box.clientWidth || !box.clientHeight) return;
    const k = Math.min(
      (box.clientWidth - 4) / 1200,
      (box.clientHeight - 4) / 740
    );
    el.stage.style.transform = `scale(${k})`;
  }

  /* ---------------- 启动 / 大厅 ↔ 牌桌 ↔ 联机 ---------------- */

  /** body 状态类：视图相关的 CSS 全走这里 */
  function setView(name) {
    document.body.classList.toggle('in-lobby', name === 'lobby');
    document.body.classList.toggle('in-online', name === 'online');
    document.body.classList.toggle('in-game', name === 'game');
    if (name === 'game') window.GZViewport.enter();
    else window.GZViewport.leave();
    fit();
  }

  function showLobby() {
    if (game && !game.isRemote) saveScore();
    el.overlay.classList.add('hidden');
    el.overlay.innerHTML = '';
    hideTip();
    GZOnline.hide();
    GZLobby.show();
    setView('lobby');
    if (el.brandSub) el.brandSub.textContent = '贵州麻将 · 游戏大厅';
  }

  /** 联机面板 ↔ 大厅 */
  function showOnline() {
    GZLobby.hide();
    el.overlay.classList.add('hidden');
    hideTip();
    GZOnline.show();
    setView('online');
    if (el.brandSub) el.brandSub.textContent = '联机对战';
  }

  /** 从结算面板回到房间等待页 */
  function showOnlineRoom() {
    el.overlay.classList.add('hidden');
    hideTip();
    GZOnline.show();
    setView('online');
    if (el.brandSub) el.brandSub.textContent = '联机对战 · 房间';
  }

  /** 房主点了「开始对局」：切到牌桌，用 RemoteGame 接住服务端快照 */
  function enterOnlineGame() {
    if (game && !game.isRemote) game.phase = 'ended';
    if (!game || !game.isRemote) {
      game = new GZRemoteGame.RemoteGame();
      window.__game = game;
      const remote = game;
      game.on('state', () => { if (game === window.__game) render(); });
      game.on('roundEnd', (res) => {
        if (game !== remote) return;
        const round = remote.roundNo;
        try {
          if (!res.draw) Sound.hu();
          recordRound(res);
          setTimeout(() => {
            if (game !== remote || remote.phase !== 'ended' || remote.roundNo !== round) return;
            try { showResult(res); } catch (err) { console.error('[remote] showResult', err); toast('结算渲染异常'); }
          }, 650);
        } catch (err) { console.error('[remote] roundEnd', err); }
      });
    }
    GZOnline.hide();
    GZLobby.hide();
    setView('game');
    render();
    fit();
    const sub = game.totalRounds ? `${game.mode.name} · ${game.totalRounds} 局` : game.mode.name;
    if (el.brandSub) el.brandSub.textContent = `${sub} · 联机`;
    toast('已进入牌桌，等服务端发牌', 2000);
  }

  /** 服务端快照与特效 */
  function onNetMsg(msg) {
    if (msg.t === 'snapshot') {
      if (!game || !game.isRemote) return;
      if (!GZOnline.started || msg.snap.roomId !== GZOnline.room?.id) return;
      game.applySnapshot(msg.snap);
      playFx(msg.fx || []);
      return;
    }
    if (msg.t === 'room') refreshRoundActions();
  }

  /** 回放这轮快照里的动效 */
  function playFx(list) {
    for (const f of list) {
      if (f.type === 'discard') Sound.discard();
      else if (f.type === 'call') {
        showCall(f.p, f.text);
        if (f.text === '碰') Sound.peng();
        else if (String(f.text).indexOf('杠') >= 0) Sound.gang();
        else if (f.text === '胡') Sound.hu();
      } else if (f.type === 'chong') {
        Sound.tone(760, 0.12, 'triangle', 0.09);
        Sound.tone(1140, 0.18, 'sine', 0.07, 0.09);
        toast(`冲幺筒：向其他三家各收 ${f.points} 分`, 2400);
      } else if (f.type === 'ting') {
        Sound.tone(1046, 0.18, 'sine', 0.1);
        toast(f.tianTing ? '天听！起手就听牌，胡牌 +6' : '已报听：手牌锁定，摸什么打什么', 2600);
      } else if (f.type === 'blocked') {
        if (!blockedShown) {
          blockedShown = true;
          toast('平胡没有豆，不能吃炮，只能自摸');
        }
      } else if (f.type === 'msg') {
        if (f.text) toast(f.text, 2000);
      }
    }
  }

  function enterMode(modeId) {
    const id = R.MODES[modeId] ? modeId : 'classic';
    GZLobby.hide();
    GZOnline.hide();
    setView('game');
    if (game && !game.isRemote && game.mode.id === id) {
      // 同一玩法再进来：接着上桌，不重发牌
      if (el.brandSub) el.brandSub.textContent = `${game.mode.name} · 单机版`;
      render();
      fit();
      return;
    }
    createGame(id);
    if (el.brandSub) el.brandSub.textContent = `${game.mode.name} · 单机版`;
    toast(`进入「${game.mode.name}」· 第 ${game.roundNo} 局`, 2200);
  }

  function createGame(modeId) {
    if (game) {
      game.phase = 'ended';   // 停掉上一桌的循环
      saveScore();
    }
    const saved = window.GZProfile.tableScore(modeId);
    game = new GZ.Game({
      mode: modeId,
      speed: SPEEDS[speedIdx].value,
      autoPlay: autoOn,
      scores: saved ? saved.scores : undefined,
      roundNo: saved ? saved.round : undefined,
      dealer: saved ? saved.dealer : undefined
    });
    window.__game = game;
    applySpeed();
    applyAuto();
    saveScore();
    wireGame();
    blockedShown = false;
    game.startRound();
  }

  function wireGame() {
    const g = game;                                  // 换玩法后旧牌桌的事件一律忽略
    const on = (ev, fn) => g.on(ev, (data) => { if (game === g) fn(data); });
    on('state', render);
    on('deal', () => { Sound.deal(); blockedShown = false; saveScore(); render(); });
    on('discard', () => Sound.discard());
    on('chong', (entry) => {
      Sound.tone(760, 0.12, 'triangle', 0.09);
      Sound.tone(1140, 0.18, 'sine', 0.07, 0.09);
      toast(`冲幺筒：向其他三家各收 ${entry.points} 分`, 2400);
    });
    on('call', ({ p, text }) => {
      showCall(p, text);
      if (text === '碰') Sound.peng();
      else if (text.indexOf('杠') >= 0) { Sound.gang(); saveScore(); }
      else if (text === '胡') Sound.hu();
    });
    on('message', (text) => { if (text) renderCenter(); });
    on('blocked', () => {
      if (blockedShown) return;
      blockedShown = true;
      toast('平胡没有豆，不能吃炮，只能自摸');
    });
    on('ting', (info) => {
      Sound.tone(1046, 0.18, 'sine', 0.1);
      toast(info.tianTing ? '天听！起手就听牌，胡牌 +6' : '已报听：手牌锁定，摸什么打什么', 2600);
    });
    g.on('roundEnd', (res) => {
      if (game !== g) return;
      if (!res.draw) Sound.hu();
      if (!g.isRemote) {
        recordRound(res);
        saveScore();
      } else {
        // 联机：战绩记给玩家，但牌桌分数由服务器管
        recordRound(res);
      }
      setTimeout(() => { if (game === g) showResult(res); }, 650);
    });
    on('error', () => toast('对局出现异常，已重新发牌'));
  }

  /** 一局结束 → 写进玩家战绩与对局记录 */
  function recordRound(res) {
    const P = window.GZProfile;
    const wins = res.winners || [];
    const mine = wins.find((w) => w.p === 0) || null;
    P.record({
      mode: game.mode.id,
      onlineRoundId: game.isRemote ? game.state?.roundId : undefined,
      delta: res.deltas[0],
      win: !!mine,
      selfDraw: !!(mine && mine.selfDraw),
      pattern: mine && mine.info ? mine.info.name : (res.draw ? '黄庄' : ''),
      points: mine ? mine.points : 0,
      draw: !!res.draw
    });
  }

  function start() {
    cacheDom();
    buildSeats();
    fit();
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    document.addEventListener('fullscreenchange', fit);

    try {
      const saved = parseInt(localStorage.getItem('gz-speed'), 10);
      if (saved >= 0 && saved < SPEEDS.length) speedIdx = saved;
      autoOn = localStorage.getItem('gz-auto') === '1';
    } catch (e) { /* ignore */ }

    GZOnline.init({ onError: toast, onEnterGame: enterOnlineGame });
    GZLobby.init({ onEnter: enterMode, onRules: showRules, onRender: fit, onOnline: showOnline });
    window.__ui = { enterMode, showLobby, showOnline, showRules, showResult, hideResult, fit };
    window.GZUI = window.__ui;   // 供 online.js / lobby.js 回调返回大厅、联机面板

    // 联机消息只在启动时挂一次；onNetMsg 自己判断当前牌桌
    window.GZNet.on('msg', onNetMsg);
    window.GZNet.on('status', (st) => {
      const banner = $('#net-status');
      const disconnected = ['lost', 'connecting', 'reconnecting', 'error'].includes(st);
      banner.classList.toggle('hidden', !disconnected);
      document.body.classList.toggle('net-offline', disconnected);
      banner.textContent = game && game.isRemote ? '连接中断，正在重连 · 座位保留 60 秒，电脑临时代打' : '正在连接服务器…';
      fit();
    });

    blockedShown = false;
    bind();
    if (['http:', 'https:'].includes(location.protocol)) showOnline();
    else showLobby();
  }

  function saveScore() {
    if (!game || game.isRemote) return;
    window.GZProfile.saveTable(game.mode.id, {
      scores: game.scores, round: game.roundNo, dealer: game.dealer
    });
  }

  document.addEventListener('DOMContentLoaded', start);
})();
