/* HTTP 网页与 WebSocket 共用端口；规则与房间状态由服务端维护。 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room } = require('./room.js');

const SRC = path.join(__dirname, '..', 'src');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

/* 模块级：当前运行实例的 stats 取值器（createMahjongServer 内注册），供 /stats 路由用 */
let liveStats = () => ({ online: 0, rooms: 0 });

function serveStatic(req, res) {
  if (req.url.split('?')[0] === '/stats') {
    // 大厅轮询在线人数：不建 WS、不影响「先进大厅不自动连服」的设计
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(liveStats()));
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
  }
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); }
  catch { res.writeHead(400); res.end('bad request'); return; }
  const file = path.resolve(SRC, '.' + (rel === '/' ? '/index.html' : rel));
  const relative = path.relative(SRC, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || rel.includes('\0')) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createMahjongServer({ reconnectGrace = 60000, heartbeatInterval = 30000, gameOptions = {} } = {}) {
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  const rooms = new Map();
  const players = new Map();
  const sessions = new Map();
  const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const onlineCount = () => [...players.values()].filter((p) => p.ws && p.ws.readyState === 1).length;
  const stats = () => ({ online: onlineCount(), rooms: rooms.size });
  liveStats = stats; // 注册到模块级，供 HTTP /stats 路由读取
  // 连接 / 断开 / 恢复 / 踢除都会改变在线人数；广播给所有活跃连接，供大厅显示。
  function broadcastStats() {
    const payload = JSON.stringify({ t: 'stats', ...stats() });
    for (const p of players.values()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(payload);
    }
  }

  function newRoomCode() {
    const start = crypto.randomInt(9000);
    for (let i = 0; i < 9000; i++) {
      const code = String(1000 + (start + i) % 9000);
      if (!rooms.has(code)) return code;
    }
    throw new Error('房间数量已满，请稍后再试');
  }

  function leaveRoom(p, voluntary = false) {
    const room = p.room;
    if (!room) return;
    p.room = null;
    room.remove(p.uid, voluntary);
    if (room.empty()) {
      room.abort(); rooms.delete(room.id);
    } else {
      room.broadcastRoom();
      room.pushFx({ type: 'msg', text: `${p.name} 离开了房间` });
      room.broadcastGame();
    }
  }

  function forget(p) {
    clearTimeout(p.expiry);
    sessions.delete(p.token); players.delete(p.uid);
    broadcastStats();
  }

  function resume(current, token, ws) {
    const previous = typeof token === 'string' && sessions.get(token);
    if (!previous || previous === current) {
      send(ws, { t: 'resume-failed', uid: current.uid, resumeToken: current.token });
      return current;
    }
    if (current.room) throw new Error('请先退出当前房间再恢复会话');
    forget(current);
    clearTimeout(previous.expiry);
    const oldSocket = previous.ws;
    previous.ws = ws;
    // 旧连接的 close/message 不能再影响已恢复的会话。
    if (oldSocket && oldSocket !== ws) oldSocket.close(4001, 'session resumed elsewhere');
    send(ws, { t: 'resumed', uid: previous.uid, resumeToken: previous.token });
    if (previous.room) {
      const room = previous.room;
      room.reconnect(previous);
      send(ws, { t: 'joined', resumed: true, room: room.publicState(previous.uid) });
      room.sendChatHistory(previous.uid);
      room.broadcastRoom(); room.broadcastGame();
    }
    broadcastStats();
    return previous;
  }

  function handleMessage(me, msg) {
    const requireRoom = () => {
      if (!me.room) throw new Error('你还没有进房间');
      return me.room;
    };
    const check = (result) => { if (!result.ok) throw new Error(result.err); };
    switch (msg.t) {
      case 'hello':
        me.name = String(msg.name || '玩家').trim().slice(0, 10) || '玩家';
        if (me.room) {
          me.room.rename(me.uid, me.name);
          me.room.broadcastRoom(); me.room.broadcastGame();
        }
        send(me.ws, { t: 'hello-ok', name: me.name }); return;
      case 'create': {
        const room = new Room(newRoomCode(), me, gameOptions);
        if (msg.config !== undefined) check(room.setConfig(me.uid, msg.config, false));
        leaveRoom(me, true);
        rooms.set(room.id, room); me.room = room;
        send(me.ws, { t: 'joined', room: room.publicState(me.uid) });
        room.sendChatHistory(me.uid); return;
      }
      case 'join': {
        const code = String(msg.room || '').trim();
        const room = rooms.get(code);
        if (!room) throw new Error(`没有房号 ${code} 的房间`);
        if (me.room !== room) {
          room.add(me); // 先校验目标房；失败时保留原房间。
          leaveRoom(me, true); me.room = room;
        }
        send(me.ws, { t: 'joined', room: room.publicState(me.uid) });
        room.sendChatHistory(me.uid);
        room.broadcastRoom();
        if (room.game) room.sendSnapshotTo(room.seatOf(me.uid));
        return;
      }
      case 'addbot': {
        const room = requireRoom();
        if (!room.isHost(me.uid)) throw new Error('只有房主能加机器人');
        check(room.addBot()); room.broadcastRoom(); return;
      }
      case 'removebot': {
        const room = requireRoom();
        if (!room.isHost(me.uid)) throw new Error('只有房主能移除机器人');
        check(room.removeBot(msg.uid)); room.broadcastRoom(); return;
      }
      case 'config': check(requireRoom().setConfig(me.uid, msg.config)); return;
      case 'start': {
        const room = requireRoom();
        if (!room.isHost(me.uid)) throw new Error('只有房主能开局');
        check(room.start()); return;
      }
      case 'next': check(requireRoom().nextRound(me.uid)); return;
      case 'newtable': check(requireRoom().newTable(me.uid)); return;
      case 'ready': check(requireRoom().setReady(me.uid, msg.ready, msg.roundId, msg.readyId)); return;
      case 'chat': {
        const room = requireRoom();
        const result = room.chat(me.uid, msg.text, msg.clientId);
        if (!result.ok) send(me.ws, { t: 'chat-error', roomId: room.id, err: result.err,
          clientId: typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : undefined });
        return;
      }
      case 'leave': leaveRoom(me, true); send(me.ws, { t: 'left' }); return;
      case 'action': check(requireRoom().action(me.uid, msg.action)); return;
      case 'sync': {
        const room = requireRoom();
        send(me.ws, { t: 'room', room: room.publicState(me.uid) });
        room.sendChatHistory(me.uid);
        if (room.game) room.sendSnapshotTo(room.seatOf(me.uid));
        return;
      }
      case 'ping': send(me.ws, { t: 'pong' }); return;
      default: throw new Error(`未知消息 ${msg.t}`);
    }
  }

  wss.on('connection', (ws) => {
    let me = { uid: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), name: '玩家', ws, room: null };
    players.set(me.uid, me); sessions.set(me.token, me);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    send(ws, { t: 'welcome', uid: me.uid, resumeToken: me.token, online: onlineCount(), rooms: rooms.size });
    broadcastStats();
    ws.on('message', (raw, binary) => {
      if (me.ws !== ws) return;
      try {
        if (binary) throw new Error('只接受 JSON 文本消息');
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') throw new Error('消息格式不正确');
        if (msg.t === 'resume') me = resume(me, msg.token, ws);
        else handleMessage(me, msg);
      } catch (err) { send(ws, { t: 'error', err: err instanceof SyntaxError ? '消息不是有效 JSON' : err.message }); }
    });
    ws.on('close', () => {
      if (me.ws !== ws) return;
      me.ws = null;
      if (me.room) {
        me.room.disconnect(me.uid);
        me.room.broadcastRoom(); me.room.broadcastGame();
      }
      me.expiry = setTimeout(() => { leaveRoom(me); forget(me); }, reconnectGrace);
      me.expiry.unref();
      broadcastStats(); // 在线人数按「有活跃连接」计，断开即时回落
    });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, heartbeatInterval);
  heartbeat.unref();

  async function close() {
    clearInterval(heartbeat);
    for (const p of players.values()) { clearTimeout(p.expiry); p.ws = null; }
    for (const room of rooms.values()) room.abort();
    rooms.clear(); players.clear(); sessions.clear();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  return { server, wss, rooms, players, close };
}

if (require.main === module) {
  const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const port = Number(arg('port', '8788'));
  const host = arg('host', '0.0.0.0');
  const app = createMahjongServer();
  app.server.listen(port, host, () => {
    const actualPort = app.server.address().port;
    console.log('贵州麻将联机服务器已启动');
    console.log(`  本机:   ws://127.0.0.1:${actualPort}`);
    console.log(`  网页:   http://127.0.0.1:${actualPort}/`);
    for (const list of Object.values(require('os').networkInterfaces())) {
      for (const ni of list) if (ni.family === 'IPv4' && !ni.internal) console.log(`  局域网: http://${ni.address}:${actualPort}/`);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}

module.exports = { createMahjongServer };
