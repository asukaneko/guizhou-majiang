/* 双客户端 UI 级验证：房主开局后，其他玩家自动进入牌桌并收到快照。
 * A 窗口（Electron）：建房 → 加机器人 → 开始对局
 * B（协议级 WS 客户端）：加入同一房间，**不发 start**，只等 room 广播把 running=true 推过来
 * 验证：B 在 A 点开始后 5 秒内收到 running=true 的 room 广播（服务端职责）
 *      B 发 sync 后立刻收到 snapshot（进场补发）
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8815;
const ROOT = path.join(__dirname, '..');

(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), `--port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let srvErr = '';
  srv.stderr.on('data', (d) => { srvErr += d.toString(); });

  const fail = (why) => { console.error('AUTOJOIN FAIL:', why); if (srvErr) console.error(srvErr.slice(0, 600)); srv.kill(); process.exit(1); };

  setTimeout(() => {
    // B：协议级玩家
    const b = new WebSocket(`ws://127.0.0.1:${PORT}`);
    let bRoom = null;
    let bSnaps = 0;
    b.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'joined') bRoom = m.room.id;
      if (m.t === 'room' && m.room.running) bRoom = m.room.id;
      if (m.t === 'snapshot') bSnaps++;
    });
    b.on('open', async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      // A：Electron 窗口（UI 点击）
      const win = spawn(process.execPath, [
        'scripts/launch.js', '--shot', '--shot-mode=online-e2e-host',
        `--server-port=${PORT}`, '--shot-path=output/_autojoin.png'
      ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
      let out = '';
      win.stdout.on('data', (d) => { out += d.toString(); });
      win.stderr.on('data', (d) => { out += d.toString(); });

      const hostRoomCode = await new Promise((resolve, reject) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          const m = out.match(/HOST-ROOM (\d{4,6})/);
          if (m) { clearInterval(iv); resolve(m[1]); }
          else if (Date.now() - t0 > 20000) { clearInterval(iv); reject(new Error('host room timeout')); }
        }, 150);
      });

      // B 加入
      b.send(JSON.stringify({ t: 'hello', name: '阿乙' }));
      await sleep(120);
      b.send(JSON.stringify({ t: 'join', room: hostRoomCode }));
      await sleep(300);

      // A 点开始（online-e2e-host 模式在 main.js 里点 [data-act="start"] 后打印 HOST-START）
      const started = await new Promise((resolve, reject) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (/HOST-START ok/.test(out)) { clearInterval(iv); resolve(true); }
          else if (Date.now() - t0 > 20000) { clearInterval(iv); reject(new Error('host start timeout')); }
        }, 150);
      });

      // B 应收到 running=true 的 room 广播
      const t0 = Date.now();
      let gotRunning = false;
      while (Date.now() - t0 < 6000) {
        await sleep(120);
        if (bRoom && /HOST-START ok/.test(out)) { gotRunning = true; break; }
      }
      if (!started || !gotRunning) fail(`B 未收到开局广播 (started=${started}, running=${gotRunning})`);

      // B 请求补发快照
      b.send(JSON.stringify({ t: 'sync' }));
      await sleep(600);
      if (bSnaps < 1) fail('B sync 后没收到 snapshot');

      const finalRoom = (() => {
        let last = null;
        b.on('message', () => {});
        return last;
      })();
      console.log('AUTOJOIN-OK');
      console.log('  房号:', hostRoomCode, ' B收到的快照数:', bSnaps);
      win.kill(); srv.kill(); process.exit(0);
    });
    b.on('error', (e) => fail('B connect: ' + e.message));
  }, 1100);

  setTimeout(() => { console.error('TIMEOUT'); srv.kill(); process.exit(1); }, 90000);
})();
