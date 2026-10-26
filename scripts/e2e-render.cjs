/* UI 渲染层联机自检：起服务器，开一个真 Electron 窗口走完「建房→加机器人→开局→自动应答→结算」，截图。
 * 用法：node scripts/e2e-render.cjs
 */
'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');

const PORT = 8799;
const ROOT = path.join(__dirname, '..');

const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE';

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), `--port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
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

(async () => {
  const server = await startServer();
  const fail = (why) => { console.error('RENDER FAIL:', why); try { server.kill(); } catch (e) {} process.exit(1); };
  try {
    // Electron 窗口：加 --online-auto 让 main.js 注入自动应答脚本
    const env = { ...process.env, DIAG: '1' };
    delete env[ELECTRON_RUN_AS_NODE];
    const win = spawn(process.execPath, [
      'scripts/launch.js', '--shot',
      '--shot-mode=online-e2e',
      `--server-port=${PORT}`,
      '--shot-path=output/online-e2e.png'
    ], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    win.stdout.on('data', (d) => { out += d.toString(); });
    win.stderr.on('data', (d) => { out += d.toString(); });
    const code = await new Promise((r) => win.on('exit', r));
    console.log(out.split('\n').filter((l) => /RENDER|saved|DIAG|ERR|FILL|CONN|MODE|CREATE|BOT|START|SMOKE/i.test(l)).join('\n'));
    if (out.includes('RENDER-OK')) {
      console.log('RENDER PASS');
      server.kill();
      process.exit(0);
    }
    fail(`窗口退出码 ${code}`);
  } catch (err) {
    fail(err.stack || err.message);
  }
})();
