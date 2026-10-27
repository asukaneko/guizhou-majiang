/* 同房间聊天：等待页与牌桌共用记录，收到服务端确认后清空草稿。 */
(function (root) {
  'use strict';
  const Net = root.GZNet;
  const LIMIT = 100, MAX_LENGTH = 200;
  const $ = (s) => document.querySelector(s);
  let el, roomId = null, myUid = null, messages = [], unread = 0, opened = false;
  let view = 'lobby', remote = false, pending = null, sequence = 0, hasHistory = false, recovering = false, composing = false;
  const collapsed = { online: false, game: false };
  const available = () => !!roomId && (view === 'online' || (view === 'game' && remote));
  const canDock = () => available() && !root.matchMedia('(pointer: coarse)').matches && root.innerWidth >= 1000;
  const docked = () => canDock() && !collapsed[view];
  const expanded = () => available() && (opened || docked());
  const nearBottom = () => el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 56;
  const bottom = () => { el.list.scrollTop = el.list.scrollHeight; };

  function refresh(error = '') {
    const active = available();
    if (!active) opened = false;
    const dock = docked(), changedDock = document.body.classList.contains('chat-docked') !== dock;
    if (dock && changedDock) unread = 0;
    el.toggle.classList.toggle('hidden', !active);
    el.panel.classList.toggle('hidden', !expanded());
    document.body.classList.toggle('chat-open', expanded() && !dock);
    document.body.classList.toggle('chat-docked', dock);
    el.toggle.setAttribute('aria-expanded', String(expanded()));
    el.toggle.title = expanded() ? '折叠房间聊天' : '展开房间聊天';
    el.close.textContent = canDock() ? '折叠' : '收起';
    el.close.setAttribute('aria-label', canDock() ? '折叠聊天区' : '收起聊天');
    el.badge.textContent = unread > 99 ? '99+' : String(unread);
    el.badge.classList.toggle('hidden', !unread);
    el.latest.textContent = `查看 ${unread} 条新消息`;
    el.latest.classList.toggle('hidden', !expanded() || !unread);
    el.toggle.setAttribute('aria-label', unread ? `房间聊天，${unread} 条未读消息` : '房间聊天');
    for (const button of document.querySelectorAll('[data-room-chat-toggle]')) {
      button.textContent = unread ? `房间聊天（${unread > 99 ? '99+' : unread}）` : expanded() ? '折叠房间聊天' : '打开房间聊天';
      button.setAttribute('aria-expanded', String(expanded()));
    }
    el.room.textContent = roomId ? `房间 ${roomId} · 最近 100 条` : '';
    const connected = Net.status() === 'open';
    el.input.disabled = !connected || !roomId;
    el.send.disabled = !connected || !roomId || !!pending;
    for (const button of el.quick.querySelectorAll('button')) button.disabled = !connected || !!pending;
    el.status.textContent = error || (!connected ? '正在重连，草稿已保留' : pending ? '发送中…' : '仅同房间玩家可见 · 最多 200 字');
    el.status.classList.toggle('error', !!error);
    if (changedDock) { resize(); if (dock) bottom(); }
  }
  function resize() { root.GZUI?.fit(); }
  function orient() {
    const type = root.screen?.orientation?.type;
    const angle = typeof root.orientation === 'number' ? root.orientation : null;
    if (!type && angle === null && document.body.classList.contains('chat-typing')) return;
    const portrait = type ? type.startsWith('portrait') : angle !== null ? Math.abs(angle) % 180 === 0 : root.innerHeight > root.innerWidth;
    document.body.classList.toggle('chat-portrait', root.matchMedia('(pointer: coarse)').matches && portrait);
  }
  function close(focus = true) {
    if (canDock()) collapsed[view] = true;
    opened = false;
    composing = false;
    el.input.blur();
    document.body.classList.remove('chat-typing', 'chat-portrait');
    refresh(); resize();
    if (focus && available() && !docked()) el.toggle.focus({ preventScroll: true });
  }
  function open() {
    if (!available()) return;
    if (canDock()) collapsed[view] = false;
    opened = !canDock(); unread = 0;
    orient();
    refresh(); resize(); bottom();
    // 手机打开面板先展示消息和快捷短语，点输入框再唤起软键盘。
    if (!root.matchMedia('(pointer: coarse)').matches) el.input.focus({ preventScroll: true });
  }
  function toggle() { if (expanded()) close(); else open(); }
  function reset() {
    roomId = null; myUid = null; messages = []; unread = 0; pending = null; hasHistory = false; recovering = false;
    el.input.value = ''; el.list.replaceChildren(); close(false);
  }
  function elementFor(message) {
    const item = document.createElement('div');
    item.className = 'chat-message' + (message.uid === myUid ? ' mine' : '');
    const meta = document.createElement('div'); meta.className = 'chat-meta';
    const name = document.createElement('span'); name.textContent = message.uid === myUid ? `${message.name}（我）` : message.name;
    const time = document.createElement('time');
    const date = new Date(message.at);
    time.textContent = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    meta.append(name, time);
    const text = document.createElement('p'); text.textContent = message.text;
    item.append(meta, text); return item;
  }
  const valid = (m) => m && typeof m.id === 'string' && typeof m.uid === 'string' &&
    typeof m.name === 'string' && typeof m.text === 'string' && Number.isFinite(m.at);
  function acknowledge(message) {
    if (!pending || message.uid !== myUid || message.clientId !== pending.id) return;
    if (el.input.value.trim() === pending.text) el.input.value = '';
    pending = null;
  }
  function append(message) {
    if (!valid(message) || messages.some((m) => m.id === message.id)) return;
    const stick = nearBottom();
    messages.push(message);
    el.list.querySelector('.chat-empty')?.remove();
    el.list.append(elementFor(message));
    if (messages.length > LIMIT) { messages.shift(); el.list.firstElementChild?.remove(); }
    acknowledge(message);
    if (message.uid !== myUid && (!expanded() || !stick)) unread = Math.min(999, unread + 1);
    if (expanded() && stick) { unread = 0; bottom(); }
    refresh();
  }
  function history(list) {
    if (!Array.isArray(list)) return;
    const ids = new Set();
    const next = list.filter((m) => valid(m) && !ids.has(m.id) && ids.add(m.id)).slice(-LIMIT);
    const same = next.length === messages.length && next.every((m, i) => m.id === messages[i].id);
    const stick = nearBottom(), scroll = el.list.scrollTop;
    if (hasHistory && !expanded()) unread = Math.min(999, unread + next.filter((m) => m.uid !== myUid && !messages.some((old) => old.id === m.id)).length);
    next.forEach(acknowledge);
    if (recovering) pending = null;
    recovering = false;
    messages = next; hasHistory = true;
    if (!same || !el.list.childElementCount) {
      el.list.replaceChildren(...messages.map(elementFor));
      if (!messages.length) {
        const empty = document.createElement('p'); empty.className = 'chat-empty'; empty.textContent = '和同桌打个招呼吧'; el.list.append(empty);
      }
      if (stick) bottom(); else el.list.scrollTop = scroll;
    }
    refresh();
  }
  function send(text = el.input.value) {
    if (!available() || pending) return;
    const content = text.trim();
    if (!content) { refresh('请输入聊天文字'); return; }
    if (Array.from(content).length > MAX_LENGTH) { refresh('消息最多 200 字'); return; }
    const id = `c${Date.now().toString(36)}-${++sequence}`;
    pending = { id, text: content };
    if (!Net.send({ t: 'chat', text: content, clientId: id })) {
      pending = null; refresh('连接恢复后可发送，草稿已保留'); return;
    }
    refresh();
  }
  function handle(msg) {
    if (msg.t === 'joined') {
      if (roomId !== msg.room.id) reset();
      roomId = msg.room.id; myUid = msg.room.seats.find((s) => s.you)?.uid || null;
      refresh();
    } else if (msg.t === 'left' || msg.t === 'resume-failed') reset();
    else if (msg.roomId === roomId) {
      if (msg.t === 'chat') append(msg.message);
      else if (msg.t === 'chat-history') history(msg.messages);
      else if (msg.t === 'chat-error' && (!pending || !msg.clientId || msg.clientId === pending.id)) {
        pending = null; refresh(msg.err);
      }
    }
  }
  function init() {
    el = { toggle: $('#btn-chat'), badge: $('#chat-unread'), close: $('#chat-close'), panel: $('#room-chat'), room: $('#chat-room'),
      list: $('#chat-messages'), input: $('#chat-input'), send: $('#chat-send'), status: $('#chat-status'), quick: $('#chat-quick'), latest: $('#chat-latest') };
    el.toggle.addEventListener('click', toggle);
    el.close.addEventListener('click', () => close());
    el.latest.addEventListener('click', () => { unread = 0; bottom(); refresh(); });
    $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); if (!composing) send(); });
    el.input.addEventListener('compositionstart', () => { composing = true; });
    el.input.addEventListener('compositionend', () => { composing = false; });
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) e.preventDefault();
    });
    el.input.addEventListener('focus', () => document.body.classList.add('chat-typing'));
    el.input.addEventListener('blur', () => document.body.classList.remove('chat-typing'));
    el.quick.addEventListener('click', (e) => {
      const button = e.target.closest('[data-chat-quick]');
      if (button && !button.disabled) send(button.dataset.chatQuick);
    });
    el.list.addEventListener('scroll', () => { if (expanded() && nearBottom() && unread) { unread = 0; refresh(); } });
    document.addEventListener('keydown', (e) => {
      if (expanded() && (!docked() || e.target?.closest?.('#room-chat')) && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    }, true);
    root.addEventListener('resize', () => { if (opened) orient(); refresh(); resize(); });
    Net.on('msg', handle);
    Net.on('status', (status) => {
      if (status === 'replaced' || status === 'closed') reset();
      else { if (status === 'open') recovering = true; refresh(); }
    });
    refresh();
  }
  root.GZChat = { init, toggle, sync() { if (el) refresh(); }, setView(name, isRemote) {
    view = name; remote = isRemote;
    if (!available()) close(false); else refresh();
  } };
})(typeof window !== 'undefined' ? window : globalThis);
