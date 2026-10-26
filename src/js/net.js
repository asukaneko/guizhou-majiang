/* 浏览器网络层：会话恢复、自动重连与旧连接隔离。 */
(function (root) {
  'use strict';
  const listeners = { msg: [], status: [] };
  const tokens = new Map();
  let ws = null, url = null, state = 'closed';
  let pingTimer = null, retryTimer = null, attempts = 0;

  function emitStatus(next, detail) {
    state = next;
    for (const fn of listeners.status) fn(next, detail);
  }
  function tokenFor(addr) {
    try { return sessionStorage.getItem('gz-session:' + addr) || tokens.get(addr); }
    catch { return tokens.get(addr); }
  }
  function saveToken(addr, token) {
    if (token) tokens.set(addr, token); else tokens.delete(addr);
    try {
      if (token) sessionStorage.setItem('gz-session:' + addr, token);
      else sessionStorage.removeItem('gz-session:' + addr);
    } catch { /* 禁用存储时仍可在本页恢复 */ }
  }
  function connect(addr, retry = false) {
    if (ws && url === addr && ws.readyState <= 1) return;
    clearTimeout(retryTimer); clearInterval(pingTimer);
    const old = ws;
    ws = null;
    if (old) old.close();
    if (!retry) attempts = 0;
    url = addr;
    let socket;
    try { socket = new WebSocket(addr); }
    catch { emitStatus('error', '地址格式不对，应为 ws://IP:端口'); return; }
    ws = socket;
    emitStatus(retry ? 'reconnecting' : 'connecting', addr);
    socket.onopen = () => {
      if (ws !== socket) return;
      pingTimer = setInterval(() => send({ t: 'ping' }), 25000);
    };
    socket.onmessage = (e) => {
      if (ws !== socket) return;
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.t === 'welcome') {
        const saved = tokenFor(addr);
        if (saved && data.resumeToken) {
          socket.send(JSON.stringify({ t: 'resume', token: saved }));
        } else {
          saveToken(addr, data.resumeToken);
          attempts = 0; emitStatus('open', addr);
        }
      } else if (data.t === 'resumed' || data.t === 'resume-failed') {
        saveToken(addr, data.resumeToken);
        attempts = 0; emitStatus('open', addr);
      }
      for (const fn of listeners.msg) fn(data);
    };
    socket.onerror = () => { if (ws === socket) emitStatus('error', '连不上服务器，正在重试'); };
    socket.onclose = (e) => {
      if (ws !== socket) return;
      clearInterval(pingTimer); ws = null;
      if (e.code === 4001) {
        saveToken(addr, null); emitStatus('replaced', '会话已在另一个页面恢复'); return;
      }
      emitStatus('lost', addr);
      retryTimer = setTimeout(() => connect(addr, true), Math.min(8000, 1000 * 1.6 ** attempts++));
    };
  }
  function disconnect() {
    clearTimeout(retryTimer); clearInterval(pingTimer);
    const old = ws; ws = null;
    if (old) old.close();
    emitStatus('closed', url);
  }
  function send(obj) {
    if (!ws || ws.readyState !== 1 || state !== 'open') return false;
    ws.send(JSON.stringify(obj)); return true;
  }
  root.GZNet = {
    connect, disconnect, send, status: () => state,
    on: (ev, fn) => { listeners[ev].push(fn); return fn; },
    off: (ev, fn) => { const i = listeners[ev].indexOf(fn); if (i >= 0) listeners[ev].splice(i, 1); }
  };
  root.addEventListener('online', () => { if (url && state !== 'open') connect(url, true); });
  root.addEventListener('pageshow', () => { if (state === 'open') send({ t: 'sync' }); });
})(typeof window !== 'undefined' ? window : globalThis);
