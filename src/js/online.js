/* 网页房间：连接、创建/加入、等人、换局与恢复原座位。 */
(function (root) {
  'use strict';
  const R = root.GZRules, AI = root.GZAI, P = root.GZProfile, Net = root.GZNet;
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let node, room = null, started = false, onError = () => {}, onEnterGame = () => {};
  const webMode = () => ['http:', 'https:'].includes(location.protocol);
  function defaultAddr() {
    if (webMode()) return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    return localStorage.getItem('gz-server') || 'ws://127.0.0.1:8788';
  }
  function init(options) {
    node = $('#online');
    onError = options.onError; onEnterGame = options.onEnterGame;
    Net.on('msg', handle);
    Net.on('status', (st) => {
      if (st === 'open') Net.send({ t: 'hello', name: P.get().name });
      if (st === 'replaced') { leave(true); onError('会话已在另一个页面恢复'); }
      if (!started) render();
    });
    bind(); render();
  }
  function leave(silent = false) {
    if (!silent && !Net.send({ t: 'leave' })) { onError('正在重连，恢复连接后可退出房间'); return; }
    room = null; started = false; render();
    root.GZUI?.showLobby();
  }
  function handle(msg) {
    if (msg.t === 'joined') {
      const sameRoom = room && room.id === msg.room.id;
      const wasStarted = started;
      room = msg.room;
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
    render();
  }
  function hide() { node?.classList.add('hidden'); }
  function readyInfo() {
    const mine = room?.seats.find((s) => s.you);
    return { all: room?.allReady === true, mine: mine?.ready === true,
      waiting: room?.seats.filter((s) => s.uid && !s.bot && !s.host && (!s.ready || s.offline)).map((s) => s.name) || [] };
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
        <label class="ol-field"><span>4 位房号</span><input id="ol-code" maxlength="4" inputmode="numeric" pattern="[0-9]{4}" autocomplete="off" placeholder="输入房号" /></label>
        <p class="ol-sub">向房主获取房号，即可同桌。</p>
        <button class="btn-primary" data-act="join" ${disabled}>加入房间</button>
      </section></div>
      <div class="ol-foot"><button class="btn-ghost" data-act="back">游戏大厅</button><span class="ol-tip">昵称：${esc(P.get().name)}</span></div>
    </div>`;
  }
  function roomHtml() {
    const canEdit = room.host && !room.running && Net.status() === 'open';
    const mine = room.seats.findIndex((s) => s.you);
    const seats = room.seats.slice(mine).concat(room.seats.slice(0, mine));
    const rows = seats.map((s, i) => {
      const occupied = !!s.name;
      const readiness = room.roundNo > 0 && !room.running && occupied
        ? `<span class="ol-seat-tag ${s.ready ? 'ready' : ''}">${s.bot ? '自动就绪' : s.host ? '房主开局' : s.ready ? '已准备' : '未准备'}</span>` : '';
      return `<div class="ol-seat${occupied ? '' : ' empty'}"><div class="ol-seat-no">${['你', '下家', '对家', '上家'][i]}</div>
        <div class="ol-seat-name">${occupied ? esc(s.name) : '等待加入'}</div><div class="ol-seat-tags">
        <span class="ol-seat-tag">${!occupied ? '空位' : s.offline ? '重连中 · 电脑代打' : s.bot ? '机器人' : '已入座'}</span>
        ${s.host ? '<span class="ol-seat-tag host">房主</span>' : ''}
        ${readiness}
        ${s.bot && canEdit ? `<button class="ol-mini" data-act="removebot" data-uid="${esc(s.uid)}">移除</button>` : ''}</div></div>`;
    }).join('');
    const finished = room.finished ?? (room.roundNo >= room.totalRounds && !room.running);
    const ready = readyInfo();
    const canPrepare = !room.running && room.roundNo > 0 && !room.host;
    const label = room.running ? '返回牌桌' : canPrepare ? (ready.mine ? '已准备（取消）' : finished ? '准备下一桌' : '准备') : !room.host ? '等待房主开局' : finished ? '开启新的一桌' : room.roundNo ? (ready.all ? '开始下一局' : '等待玩家准备') : '开始对局';
    const canStart = room.running || (canPrepare ? Net.status() === 'open' : canEdit && room.full && !room.seats.some((s) => s.offline) && (!room.roundNo || ready.all));
    return `<div class="ol-card wide"><div class="ol-head"><h2>房间 ${room.id}</h2>${statusHtml()}<span class="ol-tip">第 ${room.roundNo} / ${room.totalRounds} 局</span></div>
      <p class="ol-sub">分享房号 <b class="ol-code">${room.id}</b> 给朋友，等待入座后开始。</p><div class="ol-seats">${rows}</div>
      <div class="ol-config"><label class="ol-field"><span>玩法</span><select id="ol-mode2" ${canEdit ? '' : 'disabled'}>${modeOptions(room.config.mode)}</select></label>
      <label class="ol-field"><span>局数</span><select id="ol-rounds2" ${canEdit ? '' : 'disabled'}>${roundOptions(room.config.totalRounds)}</select></label>
      <label class="ol-field"><span>人机难度</span><select id="ol-difficulty2" ${canEdit ? '' : 'disabled'}>${aiOptions(room.config.aiDifficulty || 'normal')}</select></label>
      <label class="ol-field"><span>人机速度</span><select id="ol-botspeed2" ${room.host && Net.status() === 'open' ? '' : 'disabled'}>${speedOptions(room.config.botSpeed || 'normal')}</select></label>
      ${canEdit ? `<button class="btn-ghost" data-act="addbot" ${room.full ? 'disabled' : ''}>添加机器人</button>` : ''}</div>
      <div class="ol-foot"><button class="btn-ghost" data-act="back">游戏大厅</button><button class="btn-ghost" data-act="leave">退出房间</button>
      <button class="btn-primary" data-act="${canPrepare ? 'ready' : 'start'}" ${canStart ? '' : 'disabled'}>${label}</button></div>
      ${room.roundNo && !room.running ? `<p class="ol-note" role="status">${ready.all ? '全员已准备，等待房主开局。' : `等待 ${esc(ready.waiting.join('、') || '玩家')} 准备；机器人自动就绪。`}</p>` : ''}
      <p class="ol-note">${finished ? `本桌已结束，可调整玩法、局数和座位。新桌从第 1 局开始，${room.resetScoresOnNewTable ? '房主已主动退房，新桌重新计分' : '累计分数继续保留'}，房号保持不变。` : '掉线后保留座位 60 秒，电脑临时代打；恢复连接后回到原座位。'}</p></div>`;
  }
  function render() {
    if (!node) return;
    node.innerHTML = `<div class="ol-wrap">${room ? roomHtml() : connectHtml()}</div>`;
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
        case 'addbot': Net.send({ t: 'addbot' }); break;
        case 'removebot': Net.send({ t: 'removebot', uid: btn.dataset.uid }); break;
        case 'ready': toggleReady(); break;
        case 'start':
          root.GZViewport.enter();
          if (room.running) enterTable();
          else if (room.host) Net.send({ t: (room.finished ?? (room.roundNo >= room.totalRounds)) ? 'newtable' : room.roundNo ? 'next' : 'start' });
          break;
        case 'leave': leave(); break;
        case 'back': hide(); root.GZUI?.showLobby(); break;
      }
    });
    node.addEventListener('change', (e) => {
      const key = { 'ol-mode2': 'mode', 'ol-rounds2': 'totalRounds', 'ol-difficulty2': 'aiDifficulty', 'ol-botspeed2': 'botSpeed' }[e.target.id];
      if (key) Net.send({ t: 'config', config: { [key]: key === 'totalRounds' ? +e.target.value : e.target.value } });
    });
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'ol-code') node.querySelector('[data-act="join"]').click(); });
  }
  root.GZOnline = { init, show, hide, readyInfo, toggleReady, get room() { return room; }, get started() { return started; }, resetStarted() { started = false; } };
})(typeof window !== 'undefined' ? window : globalThis);
