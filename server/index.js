/* 联机服务器：
 *   node server/index.js [--port=8788] [--host=0.0.0.0]
 *
 * - 同一个端口：HTTP 提供 src/ 静态页（浏览器直接打开也能玩），Upgrade 升级为 WebSocket
 * - 房主建房拿 4 位房号，玩家用房号加入；房主可加/移机器人、改玩法与局数、开局
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room } = require('./room.js');

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};

const PORT = parseInt(arg('port', '8788'), 10);
const HOST = arg('host', '0.0.0.0');
const SRC = path.join(__dirname, '..', 'src');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(SRC, rel));
  if (!file.startsWith(SRC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

/* ---------------- 在线玩家与房间表 ---------------- */

const rooms = new Map();          // 房号 -> Room
const players = new Map();        // uid -> {uid, name, ws, room}

const newRoomCode = () => {
  for (let i = 0; i < 50; i++) {
    const code = String(1000 + ((Math.random() * 9000) | 0));
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
};

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

const playerList = () => [...players.values()].map((p) => p.name);

function leaveRoom(p, silent) {
  const room = p.room;
  if (!room) return;
  const seat = room.seatOf(p.uid);
  room.remove(p.uid);
  p.room = null;
  if (room.empty()) {
    room.abort();
    rooms.delete(room.id);
  } else {
    room.broadcastRoom();
    if (!silent) room.pushFx({ type: 'msg', text: `${p.name} 离开了${seat >= 0 ? '，该座位改由电脑代打' : ''}` });
    if (room.game) room.broadcastGame();
  }
}

wss.on('connection', (ws) => {
  const uid = crypto.randomUUID();
  const me = { uid, name: '玩家', ws, room: null };
  players.set(uid, me);
  send(ws, { t: 'welcome', uid, online: playerList().length });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    try { handleMessage(me, msg); } catch (err) {
      send(ws, { t: 'error', err: err.message || String(err) });
    }
  });

  ws.on('close', () => {
    leaveRoom(me);
    players.delete(uid);
  });
  ws.on('error', () => { /* close 会跟进来 */ });
});

function handleMessage(me, msg) {
  switch (msg.t) {
    case 'hello': {
      me.name = String(msg.name || '玩家').trim().slice(0, 10) || '玩家';
      if (me.room) me.room.broadcastRoom();
      send(me.ws, { t: 'hello-ok', name: me.name });
      return;
    }

    case 'create': {
      if (me.room) leaveRoom(me);
      const code = newRoomCode();
      const room = new Room(code, me);
      rooms.set(code, room);
      me.room = room;
      if (msg.config) room.setConfig(me.uid, msg.config);
      send(me.ws, { t: 'joined', room: room.publicState(me.uid) });
      return;
    }

    case 'join': {
      if (me.room) leaveRoom(me);
      const code = String(msg.room || '').trim();
      const room = rooms.get(code);
      if (!room) { send(me.ws, { t: 'error', err: `没有房号 ${code} 的房间` }); return; }
      const seats = room.publicState(me.uid);
      if (seats.full) { send(me.ws, { t: 'error', err: '房间已满' }); return; }
      room.add(me);
      me.room = room;
      room.pushFx({ type: 'msg', text: `${me.name} 加入了房间` });
      send(me.ws, { t: 'joined', room: room.publicState(me.uid) });
      room.broadcastRoom();
      return;
    }

    case 'addbot': {
      if (!me.room) { send(me.ws, { t: 'error', err: '你还没有进房间' }); return; }
      if (!me.room.isHost(me.uid)) { send(me.ws, { t: 'error', err: '只有房主能加机器人' }); return; }
      const res = me.room.addBot();
      if (!res.ok) { send(me.ws, { t: 'error', err: res.err }); return; }
      me.room.broadcastRoom();
      return;
    }

    case 'removebot': {
      if (!me.room || !me.room.isHost(me.uid)) return;
      const res = me.room.removeBot(msg.uid);
      if (!res.ok) { send(me.ws, { t: 'error', err: res.err }); return; }
      me.room.broadcastRoom();
      return;
    }

    case 'config': {
      if (!me.room) return;
      const res = me.room.setConfig(me.uid, msg.config || {});
      if (!res.ok) send(me.ws, { t: 'error', err: res.err });
      return;
    }

    case 'start': {
      if (!me.room) return;
      if (!me.room.isHost(me.uid)) { send(me.ws, { t: 'error', err: '只有房主能开局' }); return; }
      const res = me.room.start();
      if (!res.ok) send(me.ws, { t: 'error', err: res.err });
      return;
    }

    case 'next': {
      if (!me.room) return;
      const res = me.room.nextRound(me.uid);
      if (!res.ok) send(me.ws, { t: 'error', err: res.err });
      return;
    }

    case 'leave': {
      leaveRoom(me);
      send(me.ws, { t: 'left' });
      return;
    }

    case 'action': {
      if (!me.room) return;
      const res = me.room.action(me.uid, msg.action || {});
      if (!res.ok) send(me.ws, { t: 'error', err: res.err });
      return;
    }

    /* 玩家（重新）进入牌桌：立刻补发一份当前快照，不等下一次状态变化 */
    case 'sync': {
      if (!me.room || !me.room.game) return;
      const seat = me.room.seatOf(me.uid);
      if (seat < 0) return;
      me.room.sendSnapshotTo(seat);
      return;
    }

    case 'ping': send(me.ws, { t: 'pong' }); return;

    default: send(me.ws, { t: 'error', err: `未知消息 ${msg.t}` });
  }
}

/* full 已挪进 Room.publicState，这里只做启动 */

server.listen(PORT, HOST, () => {
  const nets = [];
  try {
    const os = require('os');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list) if (ni.family === 'IPv4' && !ni.internal) nets.push(ni.address);
    }
  } catch (e) { /* ignore */ }
  console.log('贵州麻将联机服务器已启动');
  console.log(`  本机:   ws://127.0.0.1:${PORT}`);
  for (const ip of nets) console.log(`  局域网: ws://${ip}:${PORT}`);
  console.log(`  浏览器: http://<上面的地址>/  （同端口，打开即是游戏页面）`);
});
