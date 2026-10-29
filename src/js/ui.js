/* 界面：渲染、交互、音效、结算 */
(function () {
  'use strict';

  const R = window.GZRules;
  const AI = window.GZAI;
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
  let reviewGame = null, reviewRound = null;
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
    el.review = $('#round-review');
    el.round = $('#cp-round');
    el.wall = $('#cp-wall');
    el.turn = $('#cp-turn');
    el.soundBtn = $('#btn-sound');
    el.speedBtn = $('#btn-speed');
    el.autoBtn = $('#btn-auto');
    el.brandSub = $('#brand-sub');
    el.lobbyBtn = $('#btn-lobby');
    el.online = $('#online');
    el.resultBtn = $('#btn-result');
    el.menu = $('#tb-menu');
    el.renameBtn = $('#btn-rename');
    el.renameDialog = $('#rename-dialog');
    el.renameForm = $('#rename-form');
    el.renameInput = $('#rename-input');
  }

  function openRenameDialog() {
    // 等待开局时还没有对局对象，只要在房间里且连接正常就能改名（房主、房客都一样）
    if (!window.GZOnline?.room || window.GZNet.status() !== 'open') {
      toast('进入房间并连上服务器后才能修改昵称'); return;
    }
    el.renameInput.value = window.GZProfile.get().name;
    el.renameDialog.showModal();
    el.renameInput.focus(); el.renameInput.select();
  }

  /* ---------------- 出牌速度 ---------------- */

  const SPEEDS = Object.entries(AI.BOT_SPEEDS).map(([id, speed]) => ({ id, ...speed }));
  let speedIdx = 0;
  let aiDifficulty = 'normal';

  function applySpeed() {
    if (game && !game.isRemote) { game.speed = SPEEDS[speedIdx].value; game.botSpeed = SPEEDS[speedIdx].id; }
    refreshControls();
    try { localStorage.setItem('gz-speed', String(speedIdx)); } catch (e) { /* ignore */ }
  }

  /* ---------------- 人机代打 ---------------- */

  let autoOn = false;

  function applyAuto() {
    if (game && !game.isRemote) game.setAuto(autoOn);
    refreshControls();
    try { localStorage.setItem('gz-bot-play', autoOn ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function applyDifficulty() {
    if (game && !game.isRemote) game.aiDifficulty = aiDifficulty;
    try { localStorage.setItem('gz-ai-difficulty', aiDifficulty); } catch { /* ignore */ }
    refreshControls();
  }

  function practiceSettings(cfg) {
    if (cfg.aiDifficulty !== undefined) { aiDifficulty = AI.difficultyOf(cfg.aiDifficulty); applyDifficulty(); }
    if (cfg.botSpeed !== undefined) { speedIdx = SPEEDS.findIndex((s) => s.id === AI.speedOf(cfg.botSpeed)); applySpeed(); }
  }

  function toggleAuto() {
    if (!game) return;
    const enabled = !game.autoPlay;
    if (game.isRemote) {
      if (!game.setAuto(enabled)) { toast('连接恢复后可切换代打'); return; }
    } else {
      autoOn = enabled;
      applyAuto();
    }
    toast(enabled ? '人机代打已开启，电脑接管出牌和碰杠胡' : '人机代打已关闭，恢复手动操作', 2400);
  }

  function refreshControls() {
    const room = window.GZOnline?.room;
    const speedId = game?.isRemote ? room?.config.botSpeed || game.botSpeed : SPEEDS[speedIdx].id;
    el.speedBtn.textContent = `速度 ${AI.BOT_SPEEDS[AI.speedOf(speedId)].label}`;
    el.speedBtn.disabled = !!game?.isRemote && (!room?.host || window.GZNet.status() !== 'open');
    el.speedBtn.title = game?.isRemote ? room?.host ? '调整本房间人机速度，立即生效' : '由房主调整人机速度' : '电脑出牌速度';
    $('#btn-difficulty').textContent = `难度 ${AI.DIFFICULTIES[aiDifficulty].label}`;
    const enabled = !!(game && game.autoPlay);
    el.autoBtn.textContent = `人机代打 ${enabled ? '开' : '关'}`;
    el.autoBtn.classList.toggle('on', enabled);
    el.autoBtn.setAttribute('aria-pressed', String(enabled));
    el.resultBtn.classList.toggle('hidden', !(game?.phase === 'ended' && game.result));
    el.renameBtn.classList.toggle('hidden', !window.GZOnline?.room);
    refreshRoundActions();
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
    return `<div class="tile${classes}" data-tile="${t}"${interactive}>${T.face(t)}<i class="cap" aria-hidden="true"></i>${wild}${marker}</div>`;
  }

  function backHtml() { return `<div class="back">${T.back()}<i class="side" aria-hidden="true"></i><i class="cap" aria-hidden="true"></i></div>`; }

  function plateHtml(p, id) {
    const score = game.scores[id];
    const badges = [];
    if (game.dealer === id) badges.push('<span class="badge zhuang">庄</span>');
    if (p.tingDeclared) badges.push(`<span class="badge baoting">${p.tianTing ? '天听' : '报听'}</span>`);
    if (p.botPlay) badges.push('<span class="badge auto">代打</span>');
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

  /** 四方牌墙：一排牌背排成墙，不再是一根木条 */
  function buildWalls() {
    const perRow = 26;
    const tile = '<div class="wall-tile"><img class="face" src="assets/tiles/Back.svg" alt="" draggable="false"><i class="cap" aria-hidden="true"></i></div>';
    document.querySelectorAll('.wall-strip').forEach((strip) => {
      strip.innerHTML = new Array(perRow).fill(tile).join('');
    });
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
    document.querySelectorAll('.hud-seat').forEach((node) => { node.innerHTML = '<div class="plate"></div>'; });
    buildWalls();
  }

  const seatEl = (id) => document.querySelector(`.seat[data-seat="${id}"]`);
  const hudEl = (id) => document.querySelector(`.hud-seat[data-seat="${id}"]`);

  /* ---------------- 渲染 ---------------- */

  function setHtml(node, html) {
    if (node._sig === html) return false;
    node._sig = html;
    node.innerHTML = html;
    return true;
  }

  let glOn = false;
  let opening = null, openingId = 0, openingSeen = { game: null, round: null };
  const openingNow = () => window.performance?.now() ?? Date.now();

  function stopOpening() {
    if (!opening) return;
    clearTimeout(opening.timer);
    for (const animation of opening.animations) animation.cancel();
    opening = null;
    document.body.classList.remove('dealing-table');
  }

  function updateOpening() {
    const round = game.state?.roundId || game.roundNo;
    const freshHand = ['dealing', 'playing'].includes(game.phase) && !game.discardSeq &&
      game.players.every((p) => !p.discards.length && !p.melds.length &&
        (p.handCount ?? p.hand.length) >= 13 && (p.handCount ?? p.hand.length) <= 14);
    if (opening && (opening.game !== game || opening.round !== round || !freshHand)) stopOpening();
    if (!document.body.classList.contains('in-game') ||
        (glOn && !document.body.classList.contains('mobile-table') && !window.GZScene3D.ready) ||
        (openingSeen.game === game && openingSeen.round === round)) return;
    openingSeen = { game, round };
    if (!freshHand || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const session = { id: ++openingId, game, round, start: openingNow(), animations: new Set() };
    opening = session;
    document.body.classList.add('dealing-table');
    session.timer = setTimeout(() => {
      if (opening !== session) return;
      stopOpening();
      syncScene();
    }, 1000);
  }

  function animateOpeningHands() {
    if (!opening || (glOn && !document.body.classList.contains('mobile-table'))) return;
    const elapsed = openingNow() - opening.start;
    const directions = [[0, -52], [-52, 0], [0, 52], [52, 0]];
    for (let seat = 0; seat < 4; seat++) {
      const hand = seatEl(seat).querySelector(seat === 0 ? '.hand-main' : '.hand');
      const nodes = hand.querySelectorAll(seat === 0 ? ':scope > .tile[data-tile]' : ':scope > .back');
      nodes.forEach((node, i) => {
        if (node._dealOpening === opening.id || typeof node.animate !== 'function') return;
        node._dealOpening = opening.id;
        const order = Math.floor(i / 4) * 4 + (seat - game.dealer + 4) % 4;
        const delay = order * 42 + (i % 4) * 18 - elapsed;
        if (delay + 300 <= 0) return;
        const base = window.getComputedStyle(node).transform;
        const [x, y] = directions[seat];
        opening.animations.add(node.animate([
          { opacity: 0, transform: `translate(${x}px, ${y}px) scale(.88) ${base === 'none' ? '' : base}` },
          { opacity: 1, transform: base }
        ], { duration: 300, delay, fill: 'backwards', easing: 'cubic-bezier(.2,.7,.3,1)' }));
      });
    }
  }

  /** 挂上 three.js 牌桌；手机或无 WebGL 时继续用 DOM 牌桌 */
  function mountGL() {
    if (glOn) return true;
    if (!game || document.body.classList.contains('mobile-table')) return false;
    const cv = $('#gl');
    if (!cv || !window.GZScene3D) return false;
    if (!window.GZScene3D.init(cv)) return false;
    window.GZScene3D.onReady(() => { if (document.body.classList.contains('in-game')) render(); });
    window.GZScene3D.onDiscard((tile) => {
      const a = game && game.awaiting;
      if (a && a.kind === 'discard' && a.player === 0 && !a.auto) {
        Sound.ensure();
        return game.humanDiscard(tile);
      }
      return false;
    });
    window.GZScene3D.onTip((tile, x, y) => {
      if (tile == null) { if (tipTile !== null) hideTip(); return; }
      const a = game && game.awaiting;
      if (!a || a.kind !== 'discard' || a.player !== 0 || a.auto) { if (tipTile !== null) hideTip(); return; }
      showTip(tile, x, y);
    });
    window.GZScene3D.onLayout(placeTingBar);
    document.body.classList.add('gl-table');
    glOn = true;
    return true;
  }

  function syncScene() {
    if (!glOn || !game) return;
    window.GZScene3D.sync(game, {
      round: el.round.textContent,
      wall: el.wall.textContent,
      turn: el.turn.textContent,
      opening: opening?.id || 0
    });
    placeTingBar();
  }

  function render() {
    if (!game || game.players.length !== 4) return;
    document.body.classList.toggle('is-remote', !!game.isRemote);
    updateOpening();
    refreshControls();
    renderSeats();
    renderRivers();
    renderHand();
    renderCenter();
    renderActions();
    fitMobileTable();
    renderActive();
    renderReview();
    syncScene();
    animateOpeningHands();
  }

  function hideReview() {
    reviewGame = null;
    reviewRound = null;
    el.review.classList.add('hidden');
    el.review.innerHTML = '';
    el.review._sig = null;
  }

  function renderReview() {
    if (reviewGame !== game || reviewRound !== (game.state?.roundId || game.roundNo) || game.phase !== 'ended' || !game.result) {
      hideReview();
      return;
    }
    const res = game.result;
    const seats = game.players.map((p) => {
      const winner = (res.winners || []).find((w) => w.p === p.id);
      let hand = winner ? winner.hand : p.hand;
      if (!winner && res.robKong && res.winners[0].from === p.id) {
        hand = hand.slice();
        const robbed = hand.indexOf(res.winTile);
        if (robbed >= 0) hand.splice(robbed, 1);
      }
      const state = winner ? '胡牌' : (res.draw ? res.ting[p.id].tiles.length > 0 : res.isTing[p.id]) ? '听牌' : '未听';
      const melds = p.melds.map((m) => `<div class="meld">${m.tiles.map((t) => faceHtml(t)).join('')}</div>`).join('');
      return `<article class="review-seat${winner ? ' review-winner' : ''}">
        <h3>${esc(p.name)}${p.id === 0 && p.name !== '你' ? '（你）' : ''}<span>${state}</span></h3>
        <div class="review-hand">${hand.map((t) => faceHtml(t)).join('')}</div>
        ${melds ? `<div class="review-melds">${melds}</div>` : ''}
      </article>`;
    }).join('');
    setHtml(el.review, `<div class="review-head"><strong>第 ${game.roundNo} 局 · 四家牌面</strong><button class="btn-primary" data-act="result">返回结算</button></div><div class="review-seats">${seats}</div>`);
    el.review.classList.remove('hidden');
  }

  function showCards() {
    if (!game?.result || game.phase !== 'ended') return;
    reviewGame = game;
    reviewRound = game.state?.roundId || game.roundNo;
    el.overlay.classList.add('hidden');
    renderReview();
    el.review.querySelector('[data-act="result"]').focus();
  }

  function renderSeats() {
    game.players.forEach((p) => {
      const seat = seatEl(p.id);
      // 信息牌放屏幕层（不随桌面倾斜）；没有 #hud 时退回座位里的那块
      const html = plateHtml(p, p.id);
      const hud = hudEl(p.id);
      const hudPlate = hud && hud.querySelector('.plate');
      if (hudPlate) setHtml(hudPlate, html);
      const inSeat = seat.querySelector('.plate');
      if (inSeat) setHtml(inSeat, html);
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
    // 报听锁牌：只能打刚摸到的那张（这一手可能是在等玩家决定要不要杠）
    const locked = canPlay && !!pl.tingDeclared;
    let html = hand.map((t) => faceHtml(t, canPlay && !locked ? 'playable' : '')).join('') +
      (drawn != null ? faceHtml(drawn, 'drawn' + (canPlay ? ' playable' : '')) : '');
    // 听牌：按手牌样式排在右侧，每张角上标可见剩张
    const strip = drawn == null ? tingStripHtml() : '';
    const bar = $('#ting-bar');
    if (glOn || document.body.classList.contains('mobile-table')) {
      // 3D 和手机使用独立候选区，避免听牌提示挤占手牌的宽度。
      if (bar) {
        setHtml(bar, strip);
        bar.classList.toggle('hidden', !strip);
        placeTingBar();
      }
    } else {
      html += strip;
      if (bar) bar.classList.add('hidden');
    }
    setHtml(node, html);
    node.classList.toggle('my-turn', canPlay);
  }

  /** 把听牌候选条对到 3D 手牌右端（舞台有缩放，要换算成局部坐标） */
  function placeTingBar() {
    const bar = $('#ting-bar');
    if (!bar || bar.classList.contains('hidden')) return;
    if (document.body.classList.contains('mobile-table')) {
      bar.style.left = ''; bar.style.top = '';
      return;
    }
    if (!glOn || !window.GZScene3D || !window.GZScene3D.handEnd) return;
    const pt = window.GZScene3D.handEnd();
    const stage = el.stage;
    if (!pt || !stage) return;
    const sr = stage.getBoundingClientRect();
    const k = sr.width / (stage.offsetWidth || sr.width) || 1;
    const stageWidth = stage.offsetWidth || sr.width / k;
    let left = (pt.x - sr.left) / k + 8;
    let top = (pt.y - sr.top) / k + 6;
    if (left + bar.offsetWidth > stageWidth - 12) {
      // 放大的手牌占满横向空间时，把候选条放在手牌上方并收进画布。
      left = Math.max(12, stageWidth - bar.offsetWidth - 12);
      top = (pt.top - sr.top) / k - 10;
    }
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  }

  /** 听牌张（手牌样式 + 剩余张数角标），最多展示 4 张，其余用 +N */
  function tingStripHtml() {
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

  /** 自己这手牌能不能算天听（庄家起手 13 张就听牌） */
  function myTianTing() {
    const me = game && game.players ? game.players[0] : null;
    return !!(me && game.isTianTing && game.isTianTing(me));
  }

  function turnLabel() {
    if (game.phase === 'ended') return '本局结束';
    if (game.awaiting && game.awaiting.kind === 'claim') return '等你决定 · 碰 / 杠 / 胡';
    if (game.awaiting && game.awaiting.auto) {
      if (!game.awaiting.ting) return '人机代打中';
      return myTianTing() ? '天听中' : '报听中';
    }
    const p = game.players[game.turn];
    if (!p) return '';
    return game.turn === 0 ? '轮到你出牌' : `轮到 ${p.name}`;
  }

  let panelTurn = { game: null, round: null, seat: -1, phase: 0 };
  function renderCenter() {
    el.round.textContent = `第 ${game.roundNo} 局${game.totalRounds ? ` / ${game.totalRounds}` : ''}`;
    el.wall.textContent = game.isRemote ? game.wallLeft : game.wall.length;
    el.turn.textContent = turnLabel();
    const node = $('#center-panel');
    const seat = game.phase === 'playing' && Number.isInteger(game.turn) && game.turn >= 0 && game.turn < 4 ? game.turn : -1;
    const round = game.state?.roundId || game.roundNo;
    if (panelTurn.game === game && panelTurn.round === round && panelTurn.seat === seat) return;
    const animate = panelTurn.game === game && panelTurn.round === round && panelTurn.seat >= 0 && seat >= 0;
    let phase = seat < 0 ? panelTurn.phase : seat;
    if (animate) {
      const sweep = node.querySelector('.cp-turn-core');
      const offset = typeof window.getComputedStyle === 'function' ? parseFloat(window.getComputedStyle(sweep).strokeDashoffset) : NaN;
      const current = Number.isFinite(offset) ? (22 - offset) / 100 : panelTurn.phase;
      let delta = (seat - ((current % 4 + 4) % 4) + 4) % 4;
      if (delta > 2) delta -= 4;
      phase = current + delta;
    }
    node.style.setProperty('--turn-offset', String(22 - phase * 100));
    node.style.setProperty('--turn-travel', animate ? '420ms' : '0ms');
    node.classList.toggle('turn-lit', seat >= 0);
    panelTurn = { game, round, seat, phase };
  }

  function renderActive() {
    game.players.forEach((p) => {
      const on = game.phase !== 'ended' && game.turn === p.id;
      seatEl(p.id).classList.toggle('active', on);
      const hud = hudEl(p.id);
      if (hud) hud.classList.toggle('active', on);
    });
  }

  function renderActions() {
    const a = game.awaiting;
    let html = '';
    if (a && a.kind === 'discard' && a.player === 0) {
      if (a.auto) {
        const action = a.autoAction === 'gang' ? (a.autoGangType === 'angang' ? '暗杠 ' : '补杠 ') + TN(a.autoTile)
          : a.autoTile != null ? '打出 ' + TN(a.autoTile) : '自摸';
        html += `<div class="auto-hint">${a.ting ? (myTianTing() ? '天听' : '报听') : '人机代打'} · ${action}</div>`;
      } else {
        const s = a.self || {};
        if (s.hu) html += `<button class="action-btn hu" data-act="hu">胡 ${s.hu.name}</button>`;
        (s.angang || []).forEach((t) => { html += `<button class="action-btn gang" data-act="angang" data-tile="${t}">暗杠 ${TN(t)}</button>`; });
        (s.bugang || []).forEach((t) => { html += `<button class="action-btn gang" data-act="bugang" data-tile="${t}">补杠 ${TN(t)}</button>`; });
        if (game.canTing(0)) {
          const tian = myTianTing();
          const tip = tian
            ? `庄家配完 13 张就听牌：自摸其他三家各付 ${R.BONUS.tianting}，点炮只那家付；放炮向每个胡牌者各赔 ${R.BONUS.tianting}`
            : `首次出牌前锁牌：自摸其他三家各付 ${R.BONUS.baoting}，点炮只那家付；放炮向每个胡牌者各赔 ${R.BONUS.baoting}（天听需庄家起手就听）`;
          html += `<button class="action-btn ting" data-act="ting" title="${tip}">${tian ? '天听' : '报听'}</button>`;
        }
        const chong = wildHint();
        if (chong) html += `<div class="auto-hint chong-hint">${chong}</div>`;
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

  const TOAST_MAX = 3;        // 限制遮挡，较早的提示先退场
  const ANNOUNCE_MS = 3400;

  function toast(text, ms) {
    const div = document.createElement('div');
    div.className = ms === ANNOUNCE_MS ? 'toast-item announce' : 'toast-item';
    div.textContent = text;
    el.toast.appendChild(div);
    while (el.toast.childElementCount > TOAST_MAX) el.toast.firstElementChild.remove();
    setTimeout(() => { div.classList.add('out'); setTimeout(() => div.remove(), 200); }, ms || 3000);
  }

  /** 吃炮门槛挡下时的提示：抢杠与普通吃炮分开说 */
  function blockedText(rob) {
    return rob
      ? `没豆抢不了杠：牌型需 ${R.CHI_PAO_MIN} 分以上（有豆的话任意牌型都能抢）`
      : `当前牌型未满足吃炮门槛（有豆就能过），可继续摸牌或自摸`;
  }

  const CALL_POS = {
    0: 'left:50%; bottom:246px; transform:translateX(-50%);',
    1: 'right:210px; top:300px;',
    2: 'left:50%; top:210px; transform:translateX(-50%);',
    3: 'left:210px; top:300px;'
  };
  // 3D 牌桌里自己的手牌更高一点，碰杠提示跟着往下压
  const CALL_POS_GL = Object.assign({}, CALL_POS, {
    0: 'left:50%; bottom:372px; transform:translateX(-50%);'
  });

  function showCall(seat, text) {
    const div = document.createElement('div');
    div.className = 'call';
    div.textContent = text;
    div.dataset.seat = seat;
    div.style.cssText = (glOn ? CALL_POS_GL : CALL_POS)[seat] || '';
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
    // 报听放炮的赔付说明（两个玩法都有报听）
    const tingNote = (res.tingDeltas || []).some((n) => n)
      ? `<p class="note">报听放炮：报听的人打出的牌被胡，按自己的报听分（${R.BONUS.baoting} 分，天听 ${R.BONUS.tianting} 分）赔给每个胡牌者。</p>`
      : '';
    if (mode.chickens) {
      const chargeChips = (res.charges || []).map((c) =>
        `<span class="ji-chip charge">${tileMini(c.tile)}${c.follow ? '跟冲' : '冲锋鸡'} ×2（${esc(game.players[c.p].name)}）</span>`).join('');
      const chickenChips = res.chickens.map((c) =>
        `<span class="ji-chip">${tileMini(c.tile)}${c.kind} ${c.rate} 分/张</span>`).join('') + chargeChips;
      const flipText = res.flip != null
        ? `<div class="ji-flip">翻牌 ${tileMini(res.flip)} <span>${TN(res.flip)}</span> → 翻牌鸡 ${TN(R.nextTile(res.flip))}</div>`
        : '<div class="ji-flip">牌墙已空，未翻牌（只有幺鸡 / 乌骨鸡算鸡）</div>';
      const baojiText = (res.baoji && res.baoji.length)
        ? `<p class="note">包鸡：${res.baoji.map((b) => `${esc(game.players[b.p].name)} 没叫牌，${b.points} 分赔给 ${esc(game.players[b.to].name)}`).join('；')}</p>`
        : '';
      collectHtml = `${flipText}
        <div class="ji-row" style="margin-top:8px">${chickenChips}</div>
        <p class="note" style="margin-top:6px">叫牌的人按手牌 + 副露 + 自己牌河的鸡分，向其他三家各收一份；没叫牌的人（包鸡）把自己的常鸡（幺鸡 / 乌骨鸡 / 冲锋鸡）赔给每位听牌者，翻牌鸡不算，包括未胡牌的听牌者。</p>
        ${tingNote}${baojiText}`;
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
        }</p>
        ${tingNote}`;
    }

    const rows = game.players.map((p, i) => {
      const d = res.deltas[i];
      const state = isWinner(i) ? '胡牌' : (res.isTing[i] ? '叫牌' : '未叫');

      // 各项均使用本局实际收支，区分杠、责任鸡和普通鸡。
      const parts = [];
      const w = res.winDeltas[i];
      if (w) parts.push(`胡 ${w > 0 ? '+' : ''}${w}`);
      let kong = 0, responsibility = 0, chong = 0;
      const ting = (res.tingDeltas || [])[i] || 0;
      res.kongLog.forEach((k) => { kong += k.deltas[i]; });
      (res.penaltyLog || []).forEach((k) => {
        if (k.kind === '冲幺筒') chong += k.deltas[i];
        else responsibility += k.deltas[i];
      });
      if (kong) parts.push(`杠 ${kong > 0 ? '+' : ''}${kong}`);
      if (responsibility) parts.push(`责 ${responsibility > 0 ? '+' : ''}${responsibility}`);
      if (ting) parts.push(`听 ${ting > 0 ? '+' : ''}${ting}`);
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

    const headCells = mode.chickens
      ? '<th>玩家</th><th>状态</th><th>鸡</th><th>明细（胡 · 杠 · 责 · 听 · 鸡）</th><th>本局</th><th>总分</th>'
      : '<th>玩家</th><th>状态</th><th>明细（胡 · 杠 · 听 · 冲）</th><th>本局</th><th>总分</th>';

    return `<div class="panel${multi ? ' multi' : ''}">
      ${banner}
      ${blocks}
      <h3>${collectHead}</h3>
      ${collectHtml}
      ${deferredHtml(res)}
      <h3>本局结算</h3>
      <table class="score-table">
        <thead><tr>${headCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="panel-actions">
        <p class="round-ready-status" data-ready-status role="status" aria-live="polite"></p>
        <button class="btn-ghost" data-act="close">查看牌面</button>
        <button class="btn-ghost" data-act="lobby">回大厅</button>
        <button class="btn-primary" data-act="next">再来一局</button>
      </div>
    </div>`;
  }

  function deferredHtml(res) {
    const name = (p) => esc(game.players[p].name);
    const outcome = (k) => {
      if (k.voided) return '黄庄作废';
      const others = k.deltas.map((n, i) => ({ n, i }))
        .filter(({ n }) => k.reversed ? n > 0 : n < 0).map(({ i }) => name(i)).join('、');
      return k.reversed ? `未听牌，向 ${others} 各赔 ${k.points} 分` : `已听牌，向 ${others} 各收 ${k.points} 分`;
    };
    const notes = (res.kongLog || []).map((k) => {
      const kind = k.type === 'angang' ? '暗杠' : k.type === 'bugang' ? '补杠' : '明杠';
      return `${name(k.p)} ${kind} ${TN(k.tile)}：${outcome(k)}`;
    }).concat((res.penaltyLog || []).filter((k) => k.kind === '责任鸡').map((k) =>
      `${name(k.to)} 拿走 ${name(k.p)} 的冲锋鸡，责任鸡：${outcome(k)}`));
    return notes.length ? `<h3>杠 / 责任鸡</h3><p class="note">${notes.join('；')}</p>` : '';
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
      `${esc(game.players[k.p].name)} 冲幺筒（第 ${k.seq} 张）收 ${k.points} 分/家`);
    const note = mode.chickens
      ? '本局不翻牌，杠和责任鸡作废，普通鸡不结算，只进行查叫。'
      : `本局杠分作废，按查叫结算。${chong.length ? '已发生的冲幺筒保留：' + chong.join('；') : ''}`;
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
      ${deferredHtml(res)}
      <table class="score-table">
        <thead><tr><th>玩家</th><th>状态</th><th>听牌</th><th>本局</th><th>总分</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="panel-actions">
        <p class="round-ready-status" data-ready-status role="status" aria-live="polite"></p>
        <button class="btn-ghost" data-act="close">查看牌面</button>
        <button class="btn-ghost" data-act="lobby">回大厅</button>
        <button class="btn-primary" data-act="next">再来一局</button>
      </div>
    </div>`;
  }

  function showResult(res) {
    hideReview();
    el.overlay.classList.remove('hidden');
    el.overlay.innerHTML = resultHtml(res);
    refreshRoundActions();
    el.overlay._sig = null;
  }

  function refreshRoundActions() {
    if (!game) return;
    const topNext = $('#btn-new');
    topNext.disabled = false;
    topNext.title = '开始新的一局';
    if (game.isRemote) {
      const next = el.overlay.querySelector('[data-act="next"]');
      const room = window.GZOnline.room;
      if (room) {
        const finished = room.finished ?? (game.phase === 'ended' && game.roundNo >= room.totalRounds);
        const ready = window.GZOnline.readyInfo();
        const ended = game.phase === 'ended' && !room.running;
        const connected = window.GZNet.status() === 'open';
        const canNext = !finished && room.host && ended && ready.all && connected;
        topNext.disabled = !canNext;
        topNext.title = finished ? '本桌已结束，返回房间可配置新桌' : !room.host ? '请在结算界面准备，等待房主开局' : !ended ? '本局结束后可开始下一局' : !ready.all ? '等待所有非房主玩家准备' : '开始下一局';
        if (next) {
          next.disabled = room.host ? !canNext : !ended || !connected;
          next.textContent = room.host ? (finished ? '本桌已结束' : ready.all ? '开始下一局' : '等待玩家准备')
            : ready.mine ? '已准备（取消）' : finished ? '准备下一桌' : '准备';
        }
        const status = el.overlay.querySelector('[data-ready-status]');
        if (status) {
          status.textContent = !ended ? '' : !room.full ? '房间尚有空位，请先补齐座位。'
            : room.seats.some((s) => s.offline) ? '等待掉线玩家恢复连接。'
              : ready.all ? (finished ? '全员已准备，返回房间可开启新的一桌。' : '全员已准备，等待房主开下一局。')
                : `等待 ${ready.waiting.join('、') || '玩家'} 准备；机器人自动就绪。`;
        }
      } else {
        topNext.disabled = true;
      }
      const back = el.overlay.querySelector('[data-act="lobby"]');
      if (back) back.textContent = '返回房间';
    }
  }

  function startNewRound() {
    if (!game) return;
    if (game.isRemote) {
      const room = window.GZOnline.room;
      if (!room) return;
      if (game.phase !== 'ended') { toast('本局结束后可开始下一局'); return; }
      if (!room.host) {
        if (!window.GZOnline.toggleReady()) toast('连接恢复后可准备');
        return;
      }
      if (room.finished ?? (game.roundNo >= room.totalRounds)) { toast('返回房间可配置并开启新桌'); return; }
      if (!window.GZOnline.readyInfo().all) { toast('请等待所有非房主玩家准备'); return; }
      if (!window.GZNet.send({ t: 'next' })) toast('连接恢复后可开下一局');
      return;
    }
    const modeId = game.mode.id;
    const table = { scores: game.scores.slice(), round: game.roundNo + 1,
      dealer: game.nextDealer != null ? game.nextDealer : game.dealer };
    hideResult();
    createGame(modeId, table);
    toast(`第 ${game.roundNo} 局开始`);
  }

  /** 新一局开始（联机：房主开了下一局）→ 收起上一局结算 */
  function hideResult() {
    hideReview();
    el.overlay.classList.add('hidden');
    el.overlay.innerHTML = '';
  }

  /* ---------------- 规则 ---------------- */

  const PATTERN_RULES = (() => {
    const patterns = Object.entries(R.PATTERN_POINTS);
    const rows = [];
    for (let i = 0; i < patterns.length; i += 4) rows.push(`<li>${patterns.slice(i, i + 4).map(([id, points]) => `${R.PATTERN_NAMES[id]} <span class="hl">${points}</span>`).join('　')}</li>`);
    return rows.join('');
  })();

  const RULES_COMMON = `
    <h3>吃炮门槛</h3>
    <p>没豆的时候，吃炮要求基础牌型分至少 ${R.CHI_PAO_MIN} 分；报听、硬胡的加分不改变这个门槛。<b>手里有豆（杠）就是吃炮通行证</b>：任意牌型都能点炮——平胡有豆也能胡。抢杠同样按这条算：没豆要 ${R.CHI_PAO_MIN} 分以上，有豆任何牌型都能抢。自摸不受此限。</p>

    <h3>豆（杠）</h3>
    <ul>
      <li>杠时只记账，胡牌时统一结算；本人听牌才收分：暗杠、补杠向其他三家各收 ${R.KONG_POINT} 分，明杠向放杠者收 ${R.KONG_POINT} 分</li>
      <li>本人未听牌，每个杠向每位听牌者赔 ${R.KONG_POINT} 分；黄庄时本局所有杠分作废</li>
      <li>手里有豆就是「吃炮通行证」：点炮、抢杠都不看 ${R.CHI_PAO_MIN} 分门槛，平胡也能胡</li>
    </ul>

    <h3>抢杠胡 / 热炮 / 一炮多响</h3>
    <ul>
      <li><span class="hl">抢杠胡</span>：别人补杠的那张牌正好是你听的牌，可以抢杠；杠不成立，由补杠者向每位胡家付一份胡牌分。</li>
      <li><span class="hl">热炮</span>：杠完后打出的第一张牌被别人胡，胡牌分 +${R.BONUS.repao}。</li>
      <li><span class="hl">一炮多响</span>：一张牌同时被两家以上胡，所有人都算胡，点炮者各赔一份。</li>
    </ul>

    <h3>报听 / 天听</h3>
    <p>只能在本人首次出牌前、无副露且可以打牌听牌时点「<span class="hl">报听</span>」（+${R.BONUS.baoting}）：系统替你打出保持听牌的牌，之后手牌锁定，不能碰杠，摸什么打什么，见胡就胡。<span class="hl">庄家</span>配完 13 张就听牌并报听算<span class="hl">天听</span>（+${R.BONUS.tianting}），替代报听加分；<span class="hl">非庄家</span>就算开局 13 张就听牌，也只按报听（+${R.BONUS.baoting}）算。</p>

    <h3>黄庄</h3>
    <p>牌墙摸完按查叫结算：未叫的人赔给每个叫牌者「其最高基础牌型的分值」，不加报听、天听或硬胡。杠和责任鸡作废，不翻牌、不算普通鸡；已发生的冲幺筒保留。</p>

    <h3>人机代打</h3>
    <p>右上角「人机代打」开关（快捷键 <span class="hl">A</span>）：电脑接管出牌、碰杠胡和抢杠，关闭后交回手动操作。报听后继续遵守锁牌规则。</p>`;

  const RULES_BODY = {
    classic: `
    <div class="sub">108 张牌（万 / 条 / 筒 各 1-9），无字牌无花牌；不能吃，只能碰、杠、胡</div>

    <h3>牌型与分值（取最高的一种，不叠加）</h3>
    <ul>
      ${PATTERN_RULES}
      <li>上述分值已包含 ${R.HU_BASE} 分胡牌底分；七对按实牌中的四张同牌组数区分龙、双龙、三龙</li>
      <li>自摸 <span class="hl">+1</span>，杠上花 <span class="hl">+1</span>；清一色按「手牌 + 副露」整体同门判定</li>
    </ul>

    <h3>特殊牌型加分（在牌型分之上相加）</h3>
    <ul>
      <li>天胡 <span class="hl">+${R.BONUS.tianhu}</span>：庄家配牌后第一摸就自摸</li>
      <li>地胡 <span class="hl">+${R.BONUS.dihu}</span>：下家第一摸自摸，或单独胡庄家打出的第一张</li>
      <li>报听 <span class="hl">+${R.BONUS.baoting}</span>、天听 <span class="hl">+${R.BONUS.tianting}</span>：本人首次出牌前、无副露时声明，之后锁牌（只能打刚摸到的那张）；庄家配完 13 张即听牌算天听，其余（含非庄家起手听牌）都算报听，天听替代报听加分</li>
      <li>报听的分：<span class="hl">自摸</span>时其他三家各付一份，<span class="hl">点炮</span>只由放炮那家付；报听的人打出的牌被胡，他要向<span class="hl">每个</span>胡牌者各赔一份（报听 ${R.BONUS.baoting} 分 / 天听 ${R.BONUS.tianting} 分）</li>
      <li>报听后仍可以杠，只要杠完还保持听牌；报听的人打出的牌<span class="hl">不看吃炮门槛</span>，其他三家都能胡；别人打的牌他也可以选择不胡，留着自摸</li>
      <li>抢杠胡 <span class="hl">+${R.BONUS.qianggang}</span>，补杠者向每位胡家付一份</li>
      <li>热炮 <span class="hl">+${R.BONUS.repao}</span>：杠后打出的那张牌被别人胡</li>
      <li>素摸 <span class="hl">+${R.BONUS.sumo}</span>：自摸且手牌、副露、自己牌河一张鸡都没有（幺鸡、八筒、翻牌鸡都算鸡）</li>
    </ul>

    <h3>鸡</h3>
    <ul>
      <li>幺鸡（一条）${R.CHICKEN_BASE[R.YAOJI]} 分/张，乌骨鸡（八筒）${R.CHICKEN_BASE[R.WUGU]} 分/张，整局都算</li>
      <li>翻牌鸡：胡牌后翻牌墙第 1 张，翻到牌的下一张为鸡（翻 5 万 → 6 万；翻 9 条 → 幺鸡），1 分/张；<span class="hl">只算叫牌的人</span>，没叫牌的人手里的翻牌鸡不赔</li>
      <li><span class="hl">金鸡</span>：翻牌鸡正好是幺鸡 / 乌骨鸡时，该牌种翻倍（幺鸡 ${R.CHICKEN_BASE[R.YAOJI] * 2} 分、八筒 ${R.CHICKEN_BASE[R.WUGU] * 2} 分）</li>
      <li><span class="hl">冲锋鸡</span>：本局第一张被打出的幺鸡 / 八筒，计双倍；幺鸡和八筒<span class="hl">各算各的</span>，可以分别冲</li>
      <li><span class="hl">跟冲</span>：第一轮（开局前 4 张出牌）内，已经冲过的那种鸡再被打出，也算冲锋鸡，同样双倍</li>
      <li><span class="hl">责任鸡</span>：冲锋鸡被别人碰 / 杠走，只记账且这张不再翻倍。胡牌时拿牌者听牌，原出牌者付 ${R.RESPONSIBILITY_POINT} 分；拿牌者未听，向每位听牌者赔 ${R.RESPONSIBILITY_POINT} 分</li>
      <li><span class="hl">包鸡</span>：胡牌时没叫牌的人，按自己手牌、副露和牌河的<span class="hl">常鸡</span>分向每位听牌者各赔一份（翻牌鸡不赔）</li>
      <li>鸡分在胡牌时统一结算；叫牌（听牌）的人按手牌 + 副露 + 自己牌河的张数，向其他三家各收一份</li>
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
      ${PATTERN_RULES}
      <li>上述分值已包含 ${R.HU_BASE} 分胡牌底分</li>
      <li>自摸 <span class="hl">+1</span>，杠上花 <span class="hl">+1</span>，硬胡 <span class="hl">+5</span></li>
      <li>天胡 <span class="hl">+${R.BONUS.tianhu}</span>　地胡 <span class="hl">+${R.BONUS.dihu}</span>　报听 <span class="hl">+${R.BONUS.baoting}</span>　天听 <span class="hl">+${R.BONUS.tianting}</span>　抢杠胡 <span class="hl">+${R.BONUS.qianggang}</span>　热炮 <span class="hl">+${R.BONUS.repao}</span></li>
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
      <p class="note">本地练习与联机共用本页计分规则。</p>
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
      else if (act === 'next') startNewRound();
      else if (act === 'close') showCards();
      else if (act === 'result' && game?.phase === 'ended' && game.result) showResult(game.result);
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
        if (el.menu.open) { el.menu.open = false; return; }
        if (reviewGame === game && game?.result) { showResult(game.result); return; }
        if (game && game.awaiting && game.awaiting.kind === 'claim') game.humanRespond('pass');
        else el.overlay.classList.add('hidden');
        return;
      }
      // 键盘 A：开关人机代打
      if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey) toggleAuto();
    });

    /* 鼠标停在手牌上：显示打出去之后听什么、还剩几张 */
    el.stage.addEventListener('mousemove', (e) => {
      if (glOn) return; // 3D 牌桌自己在 canvas 上处理悬停
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
      if (game?.isRemote) {
        const room = window.GZOnline.room;
        if (!room?.host) return;
        const index = SPEEDS.findIndex((s) => s.id === (room.config.botSpeed || 'normal'));
        if (!window.GZNet.send({ t: 'config', config: { botSpeed: SPEEDS[(index + 1) % SPEEDS.length].id } })) toast('连接恢复后可调整速度');
        return;
      }
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      applySpeed();
    });
    $('#btn-difficulty').addEventListener('click', () => {
      if (!game || game.isRemote) return;
      const levels = Object.keys(AI.DIFFICULTIES);
      aiDifficulty = levels[(levels.indexOf(aiDifficulty) + 1) % levels.length];
      applyDifficulty();
    });

    el.autoBtn.addEventListener('click', toggleAuto);

    $('#rename-cancel').addEventListener('click', () => el.renameDialog.close());
    el.renameForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = el.renameInput.value.trim().slice(0, 10);
      if (!name) { el.renameInput.focus(); return; }
      if (!window.GZOnline.rename(name)) { toast('连接恢复后再试着改名'); return; }
      el.renameDialog.close();
      toast('昵称已同步给同桌');
    });
    el.renameBtn.addEventListener('click', openRenameDialog);
    el.soundBtn.addEventListener('click', () => {
      Sound.enabled = !Sound.enabled;
      el.soundBtn.textContent = `音效 ${Sound.enabled ? '开' : '关'}`;
      if (Sound.enabled) Sound.tone(880, 0.1, 'sine', 0.08);
    });

    $('#btn-rules').addEventListener('click', () => showRules(game ? game.mode.id : 'classic'));
    el.resultBtn.addEventListener('click', () => {
      if (game?.phase === 'ended' && game.result) showResult(game.result);
    });
    el.menu.addEventListener('toggle', () => {
      // 抬升标题栏层级，菜单才不会被侧边聊天面板盖住
      document.body.classList.toggle('menu-open', el.menu.open);
    });
    el.menu.addEventListener('click', (e) => {
      if (e.target.closest('.tb-menu-panel .tb-btn')) setTimeout(() => { el.menu.open = false; }, 0);
    });
    document.addEventListener('pointerdown', (e) => {
      if (el.menu.open && !el.menu.contains(e.target)) el.menu.open = false;
    });
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
    $('#btn-new').addEventListener('click', startNewRound);
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

  function fitMobileTable() {
    if (!document.body.classList.contains('mobile-table') || !game || !el.stage.clientWidth || !el.stage.clientHeight) return;
    const hasActions = !!el.actions.innerHTML;
    document.body.classList.toggle('table-actions-open', hasActions);
    const waitsVisible = !$('#ting-bar').classList.contains('hidden');
    const controls = hasActions || waitsVisible;
    const key = `${el.stage.clientWidth}:${el.stage.clientHeight}:${controls}`;
    if (el.stage._phoneLayout === key) return;
    const layout = window.GZViewport.tableLayout(el.stage.clientWidth, el.stage.clientHeight, controls);
    const values = {
      'tile-w': layout.tile.w, 'tile-h': layout.tile.h,
      'hand-bottom': layout.handBottom, 'hand-zone': layout.handZone,
      'river-w': layout.riverTile.w, 'river-h': layout.riverTile.h,
      'center-x': layout.center.x, 'center-y': layout.center.y, 'center-w': layout.center.w, 'center-h': layout.center.h,
      'hud-w': layout.hud.w, 'hud-h': layout.hud.h, 'hud-bottom': layout.hud.bottom,
      'action-x': layout.actions.x, 'action-w': layout.actions.w, 'action-h': layout.actions.h,
      'toast-y': layout.toast.y, 'toast-w': layout.toast.w, 'toast-h': layout.toast.h
    };
    layout.rivers.forEach((rect, seat) => {
      for (const [key, value] of Object.entries(rect)) values[`river-${seat}-${key}`] = value;
    });
    for (const [key, value] of Object.entries(values)) el.stage.style.setProperty(`--phone-${key}`, `${value.toFixed(2)}px`);
    el.stage._phoneLayout = key;
    // 方向、工具栏或操作区改变高度后，继续展示最新弃牌所在的完整行。
    for (let seat = 0; seat < 4; seat++) {
      const river = document.querySelector(`.river[data-seat="${seat}"]`);
      if (river) river.scrollTop = river.scrollHeight;
    }
  }

  function fit() {
    const view = window.GZViewport.layout();
    if (view.mobile) { el.stage.style.transform = ''; fitMobileTable(); placeTingBar(); return; }
    const box = el.wrap;
    if (!box.clientWidth || !box.clientHeight) return;
    const k = Math.min(
      (box.clientWidth - 4) / 1200,
      (box.clientHeight - 4) / 740
    );
    el.stage.style.transform = `scale(${k})`;
    placeTingBar();
  }

  /* ---------------- 启动 / 大厅 ↔ 牌桌 ↔ 联机 ---------------- */

  /** body 状态类：视图相关的 CSS 全走这里 */
  function setView(name) {
    if (name !== 'game') { hideReview(); stopOpening(); }
    document.body.classList.toggle('in-lobby', name === 'lobby');
    document.body.classList.toggle('in-online', name === 'online');
    document.body.classList.toggle('in-game', name === 'game');
    window.GZChat.setView(name, !!game?.isRemote);
    if (name === 'game') { window.GZViewport.enter(); mountGL(); }
    else window.GZViewport.leave();
    window.GZScene3D?.setActive(name === 'game');
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
    if (game && !game.isRemote) game.abort();
    if (!game || !game.isRemote) {
      game = new GZRemoteGame.RemoteGame();
      window.__game = game;
      const remote = game;
      game.on('state', () => { if (game === window.__game) render(); });
      game.on('roundEnd', (res) => {
        if (game !== remote) return;
        const round = remote.roundNo;
        const roundId = remote.state?.roundId;
        try {
          if (!res.draw) Sound.hu();
          recordRound(res);
          setTimeout(() => {
            if (game !== remote || remote.phase !== 'ended' || remote.roundNo !== round ||
                remote.state?.roundId !== roundId || !GZOnline.started || !document.body.classList.contains('in-game')) return;
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
    if (msg.t === 'room') refreshControls();
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
        // 提示文字由服务端随 msg 特效下发，这里只补音效，避免重复弹两条
        Sound.tone(760, 0.12, 'triangle', 0.09);
        Sound.tone(1140, 0.18, 'sine', 0.07, 0.09);
      } else if (f.type === 'ting') {
        Sound.tone(1046, 0.18, 'sine', 0.1);
      } else if (f.type === 'blocked') {
        if (!blockedShown) {
          blockedShown = true;
          toast(blockedText(f.rob));
        }
      } else if (f.type === 'msg') {
        if (f.text) toast(f.text, ANNOUNCE_MS);
      }
    }
  }

  function enterMode(modeId) {
    const id = R.MODES[modeId] ? modeId : 'classic';
    GZLobby.hide();
    GZOnline.hide();
    if (game && !game.isRemote && game.mode.id === id) {
      setView('game');
      // 同一玩法再进来：接着上桌，不重发牌
      if (el.brandSub) el.brandSub.textContent = `${game.mode.name} · 单机版`;
      render();
      fit();
      return;
    }
    createGame(id);
    setView('game');
    render();
    if (el.brandSub) el.brandSub.textContent = `${game.mode.name} · 单机版`;
    toast(`进入「${game.mode.name}」· 第 ${game.roundNo} 局`, 2200);
  }

  function createGame(modeId, tableState) {
    if (game) {
      if (game.abort) game.abort();
      else game.phase = 'ended';
      saveScore();
    }
    const saved = tableState || window.GZProfile.tableScore(modeId);
    game = new GZ.Game({
      mode: modeId,
      speed: SPEEDS[speedIdx].value,
      botSpeed: SPEEDS[speedIdx].id,
      aiDifficulty,
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
    on('chong', () => {
      // 旁白由 message 事件统一弹出，这里只补音效，避免重复
      Sound.tone(760, 0.12, 'triangle', 0.09);
      Sound.tone(1140, 0.18, 'sine', 0.07, 0.09);
    });
    on('call', ({ p, text }) => {
      showCall(p, text);
      if (text === '碰') Sound.peng();
      else if (text.indexOf('杠') >= 0) { Sound.gang(); saveScore(); }
      else if (text === '胡') Sound.hu();
    });
    // 单机也要同步弹条：冲锋鸡、责任鸡、冲幺筒、杠分、报听等旁白
    on('message', (text) => {
      if (!text) return;
      renderCenter();
      toast(text, ANNOUNCE_MS);
    });
    on('blocked', (info) => {
      if (blockedShown) return;
      blockedShown = true;
      toast(blockedText(info && info.rob));
    });
    on('ting', () => {
      Sound.tone(1046, 0.18, 'sine', 0.1);
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

  /** 3D 显示实际动画绘制帧率；静止时按需绘制，DOM 兜底显示页面刷新频率。 */
  function startFps() {
    const node = $('#fps');
    if (!node || typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined') return;
    let frames = 0, last = performance.now();
    let glSample = null;
    const tick = (now) => {
      frames++;
      const dt = now - last;
      if (dt >= 500) {
        let fps = Math.round((frames * 1000) / dt);
        if (glOn && !document.body.classList.contains('mobile-table')) {
          const sample = window.GZScene3D.stats();
          const elapsed = glSample ? sample.activeMs - glSample.activeMs : sample.activeMs;
          const count = glSample ? sample.activeFrames - glSample.activeFrames : sample.activeFrames;
          fps = elapsed > 0 ? Math.round(count * 1000 / elapsed) : null;
          node.textContent = fps == null ? '3D · 静止' : `3D ${fps} FPS`;
          node.title = '实际动画绘制帧率；静止时按需绘制';
          glSample = sample;
        } else {
          node.textContent = fps + ' FPS';
          node.title = '页面刷新回调频率';
          glSample = null;
        }
        node.classList.toggle('slow', fps != null && fps < 45);
        // 弹层盖住牌桌时这个数字没意义，也挡视线，先藏起来
        node.style.visibility = document.querySelector('#overlay:not(.hidden)') ? 'hidden' : '';
        frames = 0;
        last = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function start() {
    cacheDom();
    buildSeats();
    fit();
    startFps();
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('scroll', fit);
    document.addEventListener('fullscreenchange', fit);

    try {
      const saved = parseInt(localStorage.getItem('gz-speed'), 10);
      if (saved >= 0 && saved < SPEEDS.length) speedIdx = saved;
      autoOn = localStorage.getItem('gz-bot-play') === '1';
      aiDifficulty = AI.difficultyOf(localStorage.getItem('gz-ai-difficulty'));
    } catch (e) { /* ignore */ }

    GZOnline.init({ onError: toast, onEnterGame: enterOnlineGame });
    window.GZChat.init();
    GZLobby.init({ onEnter: enterMode, onRules: showRules, onRender: fit, onOnline: showOnline,
      getPracticeSettings: () => ({ aiDifficulty, botSpeed: SPEEDS[speedIdx].id }), onPracticeSettings: practiceSettings });
    window.__ui = { enterMode, showLobby, showOnline, showOnlineRoom, showRules, showResult, hideResult, openRenameDialog, fit };
    window.GZUI = window.__ui;   // 供 online.js / lobby.js 回调返回大厅、联机面板

    // 联机消息只在启动时挂一次；onNetMsg 自己判断当前牌桌
    window.GZNet.on('msg', onNetMsg);
    window.GZNet.on('msg', (m) => {
      // 在线人数：welcome 首推 + stats 增量广播，喂给大厅联机卡片
      if (m && (m.t === 'welcome' || m.t === 'stats') && typeof m.online === 'number') {
        root.GZLobby?.setServerStats({ online: m.online, rooms: m.rooms });
      }
    });
    window.GZNet.on('status', (st) => {
      const banner = $('#net-status');
      const disconnected = ['lost', 'connecting', 'reconnecting', 'error'].includes(st);
      banner.classList.toggle('hidden', !disconnected);
      document.body.classList.toggle('net-offline', disconnected);
      banner.textContent = game && game.isRemote ? '连接中断，正在重连 · 座位保留 60 秒，电脑临时代打' : '正在连接服务器…';
      refreshControls();
      fit();
    });

    blockedShown = false;
    bind();
    showLobby();
  }

  function saveScore() {
    if (!game || game.isRemote) return;
    window.GZProfile.saveTable(game.mode.id, {
      scores: game.scores, round: game.roundNo, dealer: game.dealer
    });
  }

  document.addEventListener('DOMContentLoaded', start);
})();
