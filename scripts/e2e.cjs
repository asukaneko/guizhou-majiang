/* 端到端自检：真实起一个 HTTP+WS 服务器，用 4 个客户端连进去打完一局。
 * 用法：node scripts/e2e.cjs
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8791;

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js'), `--port=${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString(); });
  child.stderr.on('data', (d) => process.stderr.write(d));
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (buf.includes('已启动')) resolve(child);
      else if (Date.now() - t0 > 8000) reject(new Error('server start timeout'));
      else setTimeout(tick, 150);
    };
    tick();
  });
}

function client(name) {
  const c = { name, sent: [], ws: null, snaps: 0, errs: [] };
  c.connect = () => new Promise((resolve, reject) => {
    c.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    c.ws.on('open', resolve);
    c.ws.on('error', reject);
    c.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      c.sent.push(msg);
      if (msg.t === 'snapshot') c.snaps++;
      if (msg.t === 'error') c.errs.push(msg.err);
      if (c.onmsg) c.onmsg(msg);
    });
  });
  c.send = (obj) => c.ws.send(JSON.stringify(obj));
  c.close = () => c.ws.close();
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = await startServer();
  const fail = (why) => { console.error('E2E FAIL:', why); server.kill(); process.exit(1); };

  try {
    const host = client('房主');
    const p2 = client('阿乙');
    await host.connect();
    await p2.connect();

    host.send({ t: 'hello', name: '房主' });
    p2.send({ t: 'hello', name: '阿乙' });
    await wait(150);

    // 建房 → p2 房号加入 → 补两个机器人凑满
    host.send({ t: 'create', config: { mode: 'yitong', totalRounds: 1 } });
    await wait(300);
    if (!host.sent.some((m) => m.t === 'joined')) fail('房主没收到 joined');
    const roomMsg = host.sent.find((m) => m.t === 'joined');
    p2.send({ t: 'join', room: roomMsg.room.id });
    await wait(300);
    host.send({ t: 'addbot' });
    await wait(200);
    host.send({ t: 'addbot' });
    const deadline0 = Date.now() + 5000;
    while (Date.now() < deadline0) {
      const r = host.sent.filter((m) => m.t === 'room').pop();
      if (r && r.room.full) break;
      await wait(120);
    }
    const lastRoom = () => host.sent.filter((m) => m.t === 'room').pop();
    if (!lastRoom() || !lastRoom().room.full) fail('p2 加入 + 两个机器人后应满员');

    // 开局
    host.send({ t: 'start' });
    await wait(400);

    // 自动应答真人提示：只看最新快照，每条快照最多回一次
    const mkAuto = (c) => {
      let lastSnap = null;
      c.onmsg = (msg) => {
        if (msg.t !== 'snapshot') return;
        lastSnap = msg;
        const a = msg.snap.awaiting;
        if (!a) return;
        if (a.kind === 'claim') {
          const act = a.options.includes('hu') ? 'hu' : 'pass';
          c.send({ t: 'action', action: act === 'hu' ? { type: 'claim', act } : { type: 'pass' } });
          return;
        }
        const me = msg.snap.players[0];
        if (a.self && a.self.hu) { c.send({ t: 'action', action: { type: 'hu' } }); return; }
        const tile = me.hand && me.hand.includes(me.justDrawn) ? me.justDrawn : (me.hand || [])[0];
        if (tile != null) c.send({ t: 'action', action: { type: 'discard', tile } });
      };
    };
    mkAuto(host);
    mkAuto(p2);

    // 等对局结束（最多 120s）
    const deadline = Date.now() + 120000;
    let finalSnap = null;
    const watch = setInterval(() => {
      for (const c of [host, p2]) {
        const last = c.sent.filter((m) => m.t === 'snapshot').pop();
        if (last && last.snap.phase === 'ended' && last.snap.result) finalSnap = last.snap;
      }
    }, 300);
    while (!finalSnap && Date.now() < deadline) await wait(200);
    clearInterval(watch);

    if (!finalSnap) fail('120 秒内没等到对局结束');
    if (finalSnap.scores.reduce((a, b) => a + b, 0) !== 0) fail('结束分不零和');
    for (const c of [host, p2]) {
      const last = c.sent.filter((m) => m.t === 'snapshot').pop();
      if (last.snap.players[0].name !== c.name) fail(`${c.name} 没坐 0 号位`);
      if (last.snap.players.slice(1).some((pl) => pl.hand && pl.hand.length)) fail('有人收到了别人的手牌');
    }
    if (host.errs.length) fail(`服务端报错：${host.errs.join(';')}`);

    // 下一局由房主发起（这里只有 1 局，验证拒绝即可）
    host.send({ t: 'next' });
    await wait(200);
    if (!host.errs.some((e) => e.includes('已打满'))) fail('打满局数后 next 应被拒');

    console.log('E2E OK');
    console.log('  模式:', finalSnap.mode, ' 局数:', finalSnap.roundNo + '/' + finalSnap.totalRounds);
    console.log('  结束分:', finalSnap.scores.join(', '));
    console.log('  host 快照数:', host.snaps, ' p2 快照数:', p2.snaps);
    server.kill();
    process.exit(0);
  } catch (err) {
    fail(err.stack || err.message);
  }
})();
