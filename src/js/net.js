/* 联机网络层：WebSocket 连接、消息收发、断线提示 */
(function (root) {
  'use strict';

  const listeners = { msg: [], status: [] };

  let ws = null;
  let url = null;
  let manualClose = false;
  let pingTimer = null;

  function emitStatus(status, detail) {
    for (const fn of listeners.status) fn(status, detail);
  }

  function connect(addr) {
    if (ws && url === addr && (ws.readyState === 0 || ws.readyState === 1)) return;
    disconnect();
    url = addr;
    manualClose = false;
    try {
      ws = new WebSocket(addr);
    } catch (e) {
      emitStatus('error', '地址格式不对，应为 ws://IP:端口');
      return;
    }
    emitStatus('connecting', addr);
    ws.onopen = () => {
      emitStatus('open', addr);
      pingTimer = setInterval(() => send({ t: 'ping' }), 25000);
    };
    ws.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      for (const fn of listeners.msg) fn(data);
    };
    ws.onerror = () => emitStatus('error', '连不上服务器');
    ws.onclose = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      emitStatus(manualClose ? 'closed' : 'lost', addr);
      ws = null;
    };
  }

  function disconnect() {
    manualClose = true;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function status() {
    if (!ws) return 'closed';
    return ws.readyState === 1 ? 'open' : 'connecting';
  }

  root.GZNet = {
    connect, disconnect, send, status,
    on: (ev, fn) => { listeners[ev].push(fn); return fn; },
    off: (ev, fn) => { const i = listeners[ev].indexOf(fn); if (i >= 0) listeners[ev].splice(i, 1); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
