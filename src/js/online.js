/* 网页房间：连接、创建/加入、等人、换局与恢复原座位。 */
(function (root) {
  'use strict';
  const R = root.GZRules, AI = root.GZAI, P = root.GZProfile, Net = root.GZNet;
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let node, room = null, started = false, onError = () => {}, onEnterGame = () => {}, onNotice = () => {};
  let inviteCode = '', autoJoinCode = '';
  const webMode = () => ['http:', 'https:'].includes(location.protocol);
  function defaultAddr() {
    if (webMode()) return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    return localStorage.getItem('gz-server') || 'ws://127.0.0.1:8788';
  }
  /** 邀请链接形如 /?room=4321；只认 4 位数字房号，其余参数原样忽略。 */
  function readInviteCode() {
    try {
      const source = `${location.search || ''}&${location.hash || ''}`;
      const m = source.match(/[?&#]room=(\d{4})(?:[&#]|$)/);
      return m ? m[1] : '';
    } catch { return ''; }
  }
  function inviteUrl(code) {
    if (!webMode() || !location.host) return '';
    const pathname = location.pathname && location.pathname !== '/' ? location.pathname : '/';
    return `${location.protocol}//${location.host}${pathname}?room=${encodeURIComponent(code)}`;
  }
  function inviteMessage(code) {
    const link = inviteUrl(code);
    return link
      ? `【贵州麻将】邀请码 ${code}，点击链接直接进房：${link}`
      : `【贵州麻将】邀请码 ${code}，打开联机对战后输入房号即可加入。`;
  }
  /** 旧浏览器 / 非安全上下文没有 Clipboard API 时的兜底。 */
  function fallbackCopy(text) {
    try {
      const doc = root.document;
      const input = doc.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      if (input.style) Object.assign(input.style, { position: 'fixed', top: '-1000px', left: '-1000px', opacity: '0' });
      (doc.body || doc.documentElement).appendChild(input);
      input.focus?.();
      input.select?.();
      input.setSelectionRange?.(0, input.value.length);
      const ok = typeof doc.execCommand === 'function' && doc.execCommand('copy');
      input.remove?.();
      return !!ok;
    } catch { return false; }
  }
  function copyInvite(code = room?.id) {
    const value = String(code || room?.id || '').trim();
    if (!/^\d{4}$/.test(value)) return false;
    const text = inviteMessage(value);
    const finish = (ok) => {
      if (ok) onNotice(inviteUrl(value)
        ? `邀请码 ${value} 已复制，发给朋友点链接即可进房`
        : `邀请码 ${value} 已复制，发给朋友输入房号即可加入`);
      else onNotice(`复制失败，请手动告诉朋友房号 ${value}`);
    };
    try {
      const clipboard = root.navigator?.clipboard;
      if (clipboard && typeof clipboard.writeText === 'function') {
        clipboard.writeText(text).then(() => finish(true), () => finish(fallbackCopy(text)));
        return true;
      }
    } catch { /* 落到 execCommand 兜底 */ }
    finish(fallbackCopy(text));
    return true;
  }
  /** 自动进房成功后把地址栏里的 room 参数去掉，退出房间后刷新不会再次自动加入。 */
  function clearInviteParam() {
    if (!inviteCode) return;
    try {
      const loc = root.location;
      if (!loc?.href || typeof root.URL !== 'function' || !root.history?.replaceState) return;
      const url = new root.URL(loc.href);
      if (url.searchParams.get('room') !== inviteCode) return;
      url.searchParams.delete('room');
      root.history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch { /* 地址栏不可写时忽略 */ }
  }
  function joinInvite() {
    if (!autoJoinCode || room || Net.status() !== 'open') return false;
    const code = autoJoinCode;
    if (!Net.send({ t: 'join', room: code })) return false;
    autoJoinCode = '';
    return true;
  }
  function init(options = {}) {
    node = $('#online');
    onError = options.onError || onError;
    onEnterGame = options.onEnterGame || onEnterGame;
    onNotice = options.onNotice || onError;
    inviteCode = readInviteCode();
    autoJoinCode = inviteCode;
    Net.on('msg', handle);
    Net.on('status', (st) => {
      if (st === 'open') {
        Net.send({ t: 'hello', name: P.get().name });
        joinInvite();
      }
      if (st === 'replaced') { leave(true); onError('会话已在另一个页面恢复'); }
      if (!started) render();
    });
    bind(); render();
  }
  function leave(silent = false) {
    if (!silent && !Net.send({ t: 'leave' })) { onError('正在重连，恢复连接后可退出房间'); return; }
    autoJoinCode = '';
    room = null; started = false; render();
    root.GZUI?.showLobby();
  }
  function handle(msg) {
    if (msg.t === 'joined') {
      const sameRoom = room && room.id === msg.room.id;
      const wasStarted = started;
      room = msg.room;
      if (inviteCode && room.id === inviteCode) clearInviteParam();
      if (!sameRoom) started = false;
      if (room.running || (room.roundNo > 0 && (msg.resumed || sameRoom) && (!sameRoom || wasStarted))) enterTable();
      else { show(); root.GZUI?.showOnlineRoom(); }
    } else if (msg.t === 'room') {
      if (!room || room.id !== msg.room.id) return;
      const previous = room; room = msg.room;
      if (room.running && !started) enterTable();
      else if (room.running && (!previous.running || room.roundNo !== previous.roundNo)) root.GZUI?.hideResult();
      if (!started) render();
    } else if (msg.t === 'resume-failed') {
      if (room) { leave(true); onError('房间保留时间已过，请重新加入'); }
    } else if (msg.t === 'error') onError(msg.err);
    else if (msg.t === 'left') { room = null; started = false; show(); }
  }
  function enterTable() {
    if (!room || !room.roundNo) return;
    started = true; hide(); onEnterGame(); Net.send({ t: 'sync' });
  }
  function show() {
    if (!node) return;
    started = false;
    node.classList.remove('hidden');
    if (webMode() && Net.status() === 'closed') Net.connect(defaultAddr());
    joinInvite();
    render();
  }
  function hide() { node?.classList.add('hidden'); }
  function readyInfo() {
    const mine = room?.seats.find((s) => s.you);
    return { all: room?.allReady === true, mine: mine?.ready === true,
      waiting: room?.seats.filter((s) => s.uid && !s.bot && !s.host && (!s.ready || s.offline)).map((s) => s.name) || [] };
  }
  function rename(name) {
    const value = String(name || '').trim().slice(0, 10);
    if (!room || !value) return false;
    if (!Net.send({ t: 'hello', name: value })) return false;
    P.rename(value);
    return true;
  }
  function toggleReady() {
    if (!room || room.host || room.running || !room.roundNo) return false;
    return Net.send({ t: 'ready', ready: !readyInfo().mine, roundId: room.roundId, readyId: room.readyId });
  }
  function statusHtml() {
    const st = Net.status();
    const label = st === 'open' ? '已连接' : ['connecting', 'reconnecting'].includes(st) ? '连接中…' : '等待连接';
    return `<span class="ol-badge ${st === 'open' ? 'on' : ''}" role="status">${label}</span>`;
  }
  const modeOptions = (selected) => R.MODE_ORDER.map((id) => `<option value="${id}" ${selected === id ? 'selected' : ''}>${R.MODES[id].name}</option>`).join('');
  const roundOptions = (selected) => [...new Set([1, 2, 4, 8, 16, selected])].sort((a, b) => a - b).map((n) => `<option value="${n}" ${selected === n ? 'selected' : ''}>${n} 局</option>`).join('');
  const aiOptions = (selected) => Object.entries(AI.DIFFICULTIES).map(([id, d]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${d.label}</option>`).join('');
  const speedOptions = (selected) => Object.entries(AI.BOT_SPEEDS).map(([id, d]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${d.label}</option>`).join('');
  function connectHtml() {
    const disabled = Net.status() === 'open' ? '' : 'disabled';
    return `<div class="ol-card">
      <div class="ol-head"><h2>联机对战</h2>${statusHtml()}</div>
      <p class="ol-sub">创建一桌，分享房号给朋友。支持经典捉鸡和幺筒麻将，人数不够可补机器人。</p>
      <details class="ol-server" ${webMode() ? '' : 'open'}><summary>服务器连接</summary>
        <div class="ol-row"><label class="ol-field"><span>服务器地址</span><input id="ol-addr" value="${esc(defaultAddr())}" spellcheck="false" /></label>
        <button class="btn-ghost" data-act="connect">连接</button></div>
      </details>
      <div class="ol-grid"><section class="ol-block"><h3>创建房间</h3>
        <label class="ol-field"><span>玩法</span><select id="ol-mode">${modeOptions('classic')}</select></label>
        <label class="ol-field"><span>局数</span><select id="ol-rounds">${roundOptions(4)}</select></label>
        <label class="ol-field"><span>人机难度</span><select id="ol-difficulty">${aiOptions('normal')}</select></label>
        <label class="ol-field"><span>人机速度</span><select id="ol-botspeed">${speedOptions('normal')}</select></label>
        <button class="btn-primary" data-act="create" ${disabled}>创建房间</button>
      </section><section class="ol-block"><h3>加入朋友的房间</h3>
        <label class="ol-field"><span>4 位房号</span><input id="ol-code" maxlength="4" inputmode="numeric" pattern="[0-9]{4}" autocomplete="off" placeholder="输入房号" value="${esc(inviteCode)}" /></label>
        <p class="ol-sub">向房主获取房号或邀请链接，即可同桌。</p>
        <button class="btn-primary" data-act="join" ${disabled}>加入房间</button>
      </section></div>
      <div class="ol-foot"><button class="btn-ghost" data-act="back">游戏大厅</button><span class="ol-tip">昵称：${esc(P.get().name)}</span></div>
    </div>`;
  }
  function roomHtml() {
    const canEdit = room.host && !room.running && Net.status() === 'open';
    const mine = room.seats.findIndex((s) => s.you);
    const seats = room.seats.slice(mine).concat(room.seats.slice(0, mine));
    const occupiedCount = room.seats.filter((s) => s.uid).length;
    const finished = room.finished ?? (room.roundNo >= room.totalRounds && !room.running);
    const ready = readyInfo();
    const rows = seats.map((s, i) => {
      const occupied = !!s.uid;
      const state = !occupied ? '空位' : s.offline ? '等待重连' : room.running ? '对局中' : s.bot ? '自动就绪' : s.host ? '房主开局' : room.roundNo ? (s.ready ? '已准备' : '未准备') : '已入座';
      const role = !occupied ? '点击复制邀请码' : s.offline ? '座位保留中' : s.host ? '房主' : s.bot ? `${AI.DIFFICULTIES[AI.difficultyOf(room.config.aiDifficulty)].label}人机` : s.you ? '本机玩家' : '联机玩家';
      const score = Number.isFinite(room.standings?.[s.seat]) ? room.standings[s.seat] : 0;
      const avatar = !occupied ? '＋' : s.bot ? '机' : Array.from(s.name || '玩家')[0];
      // 空位整张卡都是邀请入口；房主和非房主都能点，权限只影响增删机器人。
      const inviteAttrs = occupied ? '' : ` data-act="invite" data-code="${esc(room.id)}" role="button" tabindex="0" aria-label="空位，点击复制邀请码 ${esc(room.id)}" title="点击复制邀请码 ${esc(room.id)}"`;
      return `<article class="ol-seat room-seat${occupied ? '' : ' empty is-invite'}${s.you ? ' is-you' : ''}${s.offline ? ' is-offline' : ''}"${inviteAttrs}>
        <div class="room-seat-head"><span>${['你', '下家', '对家', '上家'][i]}</span><span class="room-player-state${occupied && !s.offline && (s.ready || s.bot || s.host) ? ' ready' : ''}">${state}</span></div>
        <div class="room-player"><div class="room-avatar${s.bot ? ' bot' : ''}" aria-hidden="true">${esc(avatar)}</div>
          <div class="room-player-info"><div class="room-name-line"><div class="ol-seat-name" title="${esc(s.name || '等待加入')}">${occupied ? esc(s.name) : '等待加入'}</div>${s.you && occupied && !s.bot ? '<button class="room-rename" type="button" data-act="rename">改名</button>' : ''}</div><span class="room-player-role">${role}</span></div></div>
        <div class="room-seat-foot">${occupied ? `<span>累计分 <b class="${score > 0 ? 'positive' : score < 0 ? 'negative' : ''}">${score > 0 ? '+' : ''}${score}</b></span>` : '<span>等待入座</span><span class="room-invite-hint">复制邀请码</span>'}
        ${s.bot && canEdit ? `<button class="ol-mini" data-act="removebot" data-uid="${esc(s.uid)}">移除人机</button>` : ''}</div></article>`;
    }).join('');
    const canPrepare = !room.running && room.roundNo > 0 && !room.host;
    const label = room.running ? '返回牌桌' : canPrepare ? (ready.mine ? '已准备（取消）' : finished ? '准备下一桌' : '准备') : !room.host ? '等待房主开局' : finished ? '开启新的一桌' : room.roundNo ? (ready.all ? '开始下一局' : '等待玩家准备') : '开始对局';
    const canStart = room.running || (canPrepare ? Net.status() === 'open' : canEdit && room.full && !room.seats.some((s) => s.offline) && (!room.roundNo || ready.all));
    const offline = room.seats.filter((s) => s.offline).map((s) => s.name);
    const stage = room.running ? '对局进行中' : !room.full ? '等待玩家入座' : offline.length ? '等待玩家重连' : !room.roundNo ? '已到齐，可以开局' : !ready.all ? '等待玩家准备' : finished ? '准备开启新桌' : '准备开始下一局';
    const detail = room.running ? '可返回牌桌继续打牌，也可以在这里与同桌聊天。' : !room.full ? `还差 ${4 - occupiedCount} 位，可邀请朋友或添加人机。`
      : offline.length ? `等待 ${offline.join('、')} 恢复连接。` : !room.roundNo ? (room.host ? '确认牌桌设置后，点击开始对局。' : '房主确认设置后即可开局。')
        : !ready.all ? `等待 ${ready.waiting.join('、') || '玩家'} 点击准备，机器人自动就绪。` : '全员已准备，等待房主开局。';
    return `<div class="ol-card wide ol-room"><header class="room-header"><div class="room-identity"><h2>房间 <span class="room-code">${esc(room.id)}</span></h2>
      <div class="room-meta">${statusHtml()}<span>${esc(R.MODES[room.config.mode]?.name || room.config.mode)}</span><span>${occupiedCount} / 4 人</span><span>${room.roundNo ? `第 ${room.roundNo} / ${room.totalRounds} 局` : `${room.config.totalRounds} 局一桌`}</span></div></div>
      <button class="btn-ghost room-chat-launch" data-act="chat" data-room-chat-toggle aria-controls="room-chat" aria-expanded="false"><span class="room-chat-label">房间聊天</span><span class="chat-unread hidden" aria-hidden="true"></span></button></header>
      <div class="room-progress" role="status"><strong>${stage}</strong><p>${esc(detail)}</p></div>
      <section class="room-players"><div class="room-section-head"><h3>同桌玩家</h3>${canEdit ? `<button class="btn-ghost" data-act="addbot" ${room.full ? 'disabled' : ''}>添加机器人</button>` : ''}</div>
      <div class="ol-seats room-seat-grid">${rows}</div></section>
      <section class="room-settings"><div class="room-section-head"><h3>牌桌设置</h3><span>${room.host ? room.running ? '对局中可调整人机速度' : '由房主配置' : '由房主设置'}</span></div>
      <div class="ol-config"><label class="ol-field"><span>玩法</span><select id="ol-mode2" ${canEdit ? '' : 'disabled'}>${modeOptions(room.config.mode)}</select></label>
      <label class="ol-field"><span>局数</span><select id="ol-rounds2" ${canEdit ? '' : 'disabled'}>${roundOptions(room.config.totalRounds)}</select></label>
      <label class="ol-field"><span>人机难度</span><select id="ol-difficulty2" ${canEdit ? '' : 'disabled'}>${aiOptions(room.config.aiDifficulty || 'normal')}</select></label>
      <label class="ol-field"><span>人机速度</span><select id="ol-botspeed2" ${room.host && Net.status() === 'open' ? '' : 'disabled'}>${speedOptions(room.config.botSpeed || 'normal')}</select></label></div></section>
      <footer class="room-footer"><p class="room-footnote">${finished ? `新桌从第 1 局开始，${room.resetScoresOnNewTable ? '房主已主动退房，新桌重新计分' : '累计分数继续保留'}，房号保持不变。` : '临时掉线保留座位 60 秒，恢复连接后回到原座位。'}</p>
      <div class="ol-foot"><button class="btn-ghost" data-act="back">游戏大厅</button><button class="btn-ghost room-leave" data-act="leave">退出房间</button>
      <button class="btn-primary" data-act="${canPrepare ? 'ready' : 'start'}" ${canStart ? '' : 'disabled'}>${label}</button></div></footer></div>`;
  }
  function render() {
    if (!node) return;
    node.innerHTML = `<div class="ol-wrap">${room ? roomHtml() : connectHtml()}</div>`;
    root.GZChat?.sync();
    root.GZUI?.fit();
  }
  function bind() {
    node.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      switch (btn.dataset.act) {
        case 'connect': {
          const addr = $('#ol-addr').value.trim();
          if (!/^wss?:\/\//.test(addr)) { onError('地址要以 ws:// 或 wss:// 开头'); return; }
          localStorage.setItem('gz-server', addr); Net.connect(addr); break;
        }
        case 'create': Net.send({ t: 'create', config: { mode: $('#ol-mode').value, totalRounds: +$('#ol-rounds').value,
          aiDifficulty: $('#ol-difficulty').value, botSpeed: $('#ol-botspeed').value } }); break;
        case 'join': {
          const code = $('#ol-code').value.trim();
          if (!/^\d{4}$/.test(code)) { onError('请输入 4 位数字房号'); return; }
          Net.send({ t: 'join', room: code }); break;
        }
        case 'invite': copyInvite(btn.dataset.code); break;
        case 'addbot': Net.send({ t: 'addbot' }); break;
        case 'removebot': Net.send({ t: 'removebot', uid: btn.dataset.uid }); break;
        case 'ready': toggleReady(); break;
        case 'chat': root.GZChat?.toggle(); break;
        case 'rename': root.GZUI?.openRenameDialog(); break;
        case 'start':
          root.GZViewport.enter();
          if (room.running) enterTable();
          else if (room.host) Net.send({ t: (room.finished ?? (room.roundNo >= room.totalRounds)) ? 'newtable' : room.roundNo ? 'next' : 'start' });
          break;
        case 'leave': leave(); break;
        case 'back': autoJoinCode = ''; hide(); root.GZUI?.showLobby(); break;
      }
    });
    node.addEventListener('change', (e) => {
      const key = { 'ol-mode2': 'mode', 'ol-rounds2': 'totalRounds', 'ol-difficulty2': 'aiDifficulty', 'ol-botspeed2': 'botSpeed' }[e.target.id];
      if (key) Net.send({ t: 'config', config: { [key]: key === 'totalRounds' ? +e.target.value : e.target.value } });
    });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'ol-code') { node.querySelector('[data-act="join"]').click(); return; }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const seat = e.target.closest?.('[data-act="invite"]');
      if (!seat) return;
      e.preventDefault();
      copyInvite(seat.dataset.code);
    });
  }
  root.GZOnline = { init, show, hide, readyInfo, toggleReady, rename, copyInvite, get room() { return room; }, get started() { return started; }, get inviteCode() { return inviteCode; }, resetStarted() { started = false; } };
})(typeof window !== 'undefined' ? window : globalThis);
