/* 联机：连接 → 创建/加入房间 → 房间等待（机器人/规则/开局）→ 进入牌桌 */
(function (root) {
  'use strict';

  const R = root.GZRules;
  const P = root.GZProfile;
  const Net = root.GZNet;
  const $ = (s, n) => (n || document).querySelector(s);

  let node = null;
  let view = 'connect';          // connect | room
  let room = null;               // 服务端房间状态
  let onError = null;            // 由 ui.js 注入
  let onEnterGame = null;
  let started = false;           // 已进入牌桌

  const MODES = R.MODE_ORDER;

  function init(options) {
    node = $('#online');
    onError = options.onError || (() => {});
    onEnterGame = options.onEnterGame || (() => {});
    Net.on('msg', handle);
    Net.on('status', (st) => {
      if (view === 'connect') render();
      if (st === 'open') {
        // 连上先报名字：房间列表、牌桌座位都用它
        Net.send({ t: 'hello', name: P.get().name });
      }
      if (st === 'lost' && room) {
        onError('与服务器断开了连接');
        leave(true);
      }
      if (st === 'lost') render();
    });
    bind();
    render();
  }

  /** 本地离开房间视图（退房请求已发或已断线） */
  function leave(silent) {
    if (!silent && Net.status() === 'open') Net.send({ t: 'leave' });
    room = null;
    view = 'connect';
    started = false;
    render();
  }

  /* ---------------- 服务端消息 ---------------- */

  function handle(msg) {
    switch (msg.t) {
      case 'joined':
        room = msg.room;
        view = 'room';
        started = false;
        show();
        // 中途加入一局已经开打的房间：直接进牌桌
        if (room.running) enterTable();
        break;
      case 'room': {
        if (!room || msg.room.id === room.id) {
          const prev = room;
          room = msg.room;
          if (!started) render();
          const newRound = room.running && (!prev || !prev.running
            || (prev.roundNo !== room.roundNo));
          if (room.running && !started) {
            // 房主开局 / 开下一局：没在牌桌的玩家自动进场
            enterTable();
          } else if (room.running && started && newRound) {
            // 新一局开始了：收起上一局的结算面板
            if (root.GZUI && root.GZUI.hideResult) root.GZUI.hideResult();
          }
        }
        break;
      }
      case 'error':
        if (onError) onError(msg.err);
        break;
      case 'left':
        room = null;
        view = 'connect';
        show();
        break;
      default:
        break;
    }
  }

  /** 进入联机牌桌（房主开局后所有人走这里） */
  function enterTable() {
    started = true;
    hide();
    // 先进场再要一份当前快照：晚进场 / 中途加入也能立刻拿到牌桌状态
    if (onEnterGame) onEnterGame();
    Net.send({ t: 'sync' });
  }

  /* ---------------- 视图 ---------------- */

  function show() {
    if (!node) return;
    node.classList.remove('hidden');
    // 网页模式（http://IP:8788 打开）默认直连本页来源，进去就能用
    if (Net.status() === 'closed'
      && (location.protocol === 'http:' || location.protocol === 'https:')) {
      const addr = defaultAddr();
      localStorage.setItem('gz-server', addr);
      Net.connect(addr);
    }
    render();
  }

  function hide() {
    if (!node) return;
    node.classList.add('hidden');
  }

  function render() {
    if (!node) return;
    const online = view === 'room' ? roomHtml() : connectHtml();
    node.innerHTML = `<div class="ol-wrap">${online}</div>`;
    if (root.GZUI && root.GZUI.fit) root.GZUI.fit();
  }

  /* 浏览器打开 http://IP:8788 时，默认就连本页来源的服务器；Electron(file://) 才退回手填 */
  function defaultAddr() {
    try {
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        return proto + location.host;
      }
    } catch (e) { /* ignore */ }
    return localStorage.getItem('gz-server') || 'ws://127.0.0.1:8788';
  }

  function connectHtml() {
    const st = Net.status();
    const badge = st === 'open'
      ? '<span class="ol-badge on">已连接</span>'
      : st === 'connecting' ? '<span class="ol-badge">连接中…</span>'
        : '<span class="ol-badge off">未连接</span>';
    const saved = defaultAddr();
    const name = P.get().name;
    const webMode = location.protocol === 'http:' || location.protocol === 'https:';
    return `<div class="ol-card">
      <div class="ol-head">
        <h2>联机对战</h2>
        ${badge}
      </div>
      <p class="ol-sub">房主建房拿到 4 位房号，别人用房号进房；不满 4 人可以补机器人。经典和幺筒麻将都能联机。${
        webMode ? '当前就是网页模式，服务器地址已自动填好。' : '也可以直接把 <b>http://服务器IP:8788</b> 发给朋友，浏览器打开即玩。'
      }</p>
      <label class="ol-field">
        <span>服务器地址</span>
        <input id="ol-addr" value="${saved}" spellcheck="false" placeholder="ws://192.168.1.5:8788" />
      </label>
      <div class="ol-row">
        <button class="btn-ghost" data-act="connect">连接</button>
        <span class="ol-tip">连上后创建或加入房间</span>
      </div>
      <div class="ol-grid">
        <div class="ol-block">
          <h3>我是房主</h3>
          <label class="ol-field"><span>玩法</span>
            <select id="ol-mode">${MODES.map((m) => `<option value="${m}">${R.MODES[m].name}</option>`).join('')}</select>
          </label>
          <label class="ol-field"><span>打几局</span>
            <select id="ol-rounds">${[1, 2, 4, 8, 16].map((n) => `<option value="${n}"${n === 4 ? ' selected' : ''}>${n} 局</option>`).join('')}</select>
          </label>
          <button class="btn-primary" data-act="create" ${st === 'open' ? '' : 'disabled'}>创建房间</button>
        </div>
        <div class="ol-block">
          <h3>加入房间</h3>
          <label class="ol-field"><span>房间号</span>
            <input id="ol-code" maxlength="6" inputmode="numeric" placeholder="如 4321" />
          </label>
          <button class="btn-primary" data-act="join" ${st === 'open' ? '' : 'disabled'}>加入房间</button>
        </div>
      </div>
      <div class="ol-foot">
        <button class="btn-ghost" data-act="back">返回大厅</button>
        <span class="ol-tip">本机昵称：${name}</span>
      </div>
    </div>`;
  }

  function roomHtml() {
    const seatRow = room.seats.map((s, i) => {
      const kind = s === null ? '<span class="ol-seat-tag empty">空位</span>'
        : s.bot ? '<span class="ol-seat-tag bot">机器人</span>' : '<span class="ol-seat-tag">玩家</span>';
      const hostTag = s && s.host ? '<span class="ol-seat-tag host">房主</span>' : '';
      const name = s ? s.name : '等待加入…';
      const rm = s && s.bot && room.host ? `<button class="ol-mini" data-act="removebot" data-uid="${s.uid}">移除</button>` : '';
      return `<div class="ol-seat${s ? '' : ' empty'}">
        <div class="ol-seat-no">${['你', '下家', '对家', '上家'][i]}</div>
        <div class="ol-seat-name">${name}</div>
        <div class="ol-seat-tags">${kind}${hostTag}${rm}</div>
      </div>`;
    }).join('');

    const startedBtn = `<button class="btn-primary" data-act="start" ${room.full ? '' : 'disabled'}>
      ${room.full ? (room.host ? '开始对局' : '进入牌桌') : '还差人数'}</button>`;

    return `<div class="ol-card wide">
      <div class="ol-head">
        <h2>房间 ${room.id}</h2>
        <span class="ol-badge on">${room.full ? '满员' : '等待玩家'}</span>
        ${room.running ? '<span class="ol-badge run">对局中</span>' : ''}
      </div>
      <p class="ol-sub">把房号 <b class="ol-code">${room.id}</b> 告诉朋友，让 TA「加入房间」；不满 4 人房主可以补机器人。</p>
      <div class="ol-seats">${seatRow}</div>
      <div class="ol-config">
        ${room.host ? `
          <label class="ol-field inline"><span>玩法</span>
            <select id="ol-mode2">${MODES.map((m) => `<option value="${m}"${m === room.config.mode ? ' selected' : ''}>${R.MODES[m].name}</option>`).join('')}</select>
          </label>
          <label class="ol-field inline"><span>局数</span>
            <select id="ol-rounds2">${[1, 2, 4, 8, 16].map((n) => `<option value="${n}"${n === room.config.totalRounds ? ' selected' : ''}>${n} 局</option>`).join('')}</select>
          </label>
          <button class="btn-ghost" data-act="addbot" ${room.full ? 'disabled' : ''}>添加机器人</button>
        ` : `
          <span class="ol-tip">玩法：${R.MODES[room.config.mode].name} · ${room.config.totalRounds} 局（房主可改）</span>
        `}
      </div>
      <div class="ol-foot">
        <button class="btn-ghost" data-act="back">返回大厅</button>
        <button class="btn-ghost" data-act="leave">退出房间</button>
        ${room.host ? `<button class="btn-ghost" data-act="addbot" ${room.full ? 'disabled' : ''}>添加机器人</button>` : ''}
        ${startedBtn}
      </div>
      ${room.running ? `<div class="ol-note">对局进行中 · 第 ${room.roundNo} / ${room.totalRounds} 局 —— 点「开始对局」加入牌桌</div>` : ''}
    </div>`;
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    node.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'connect') {
        const addr = $('#ol-addr').value.trim();
        if (!/^wss?:\/\//.test(addr)) { if (onError) onError('地址要以 ws:// 或 wss:// 开头'); return; }
        localStorage.setItem('gz-server', addr);
        Net.connect(addr);
      } else if (act === 'create') {
        Net.send({
          t: 'create',
          config: {
            mode: ($('#ol-mode') || {}).value || 'classic',
            totalRounds: parseInt(($('#ol-rounds') || {}).value || '4', 10)
          }
        });
      } else if (act === 'join') {
        const code = ($('#ol-code').value || '').trim();
        if (!code) { if (onError) onError('先填房号'); return; }
        Net.send({ t: 'join', room: code });
      } else if (act === 'addbot') {
        Net.send({ t: 'addbot' });
      } else if (act === 'removebot') {
        Net.send({ t: 'removebot', uid: btn.dataset.uid });
      } else if (act === 'start') {
        if (room && room.host) Net.send({ t: 'start' });
        enterTable();   // 房主请求开局后进场；其他人点「进入牌桌」直接进场
      } else if (act === 'leave') {
        leave();
        if (root.GZUI && root.GZUI.showLobby) root.GZUI.showLobby();
      } else if (act === 'back') {
        hide();
        if (root.GZUI && root.GZUI.showLobby) root.GZUI.showLobby();
      }
    });

    node.addEventListener('change', (e) => {
      if (e.target.id === 'ol-mode2' || e.target.id === 'ol-rounds2') {
        Net.send({
          t: 'config',
          config: {
            mode: $('#ol-mode2').value,
            totalRounds: parseInt($('#ol-rounds2').value, 10)
          }
        });
      }
    });

    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'ol-code') {
        const code = e.target.value.trim();
        if (code) Net.send({ t: 'join', room: code });
      }
    });
  }

  root.GZOnline = { init, show, hide, get room() { return room; }, get started() { return started; }, resetStarted() { started = false; } };
})(typeof window !== 'undefined' ? window : globalThis);
