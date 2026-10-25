/* 启动器：绕开 ELECTRON_RUN_AS_NODE 之类的环境干扰，直接拉起 Electron 主进程 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');

let electronPath = null;
try {
  // 在普通 Node 里 require('electron') 返回的是可执行文件路径
  electronPath = require('electron');
} catch (e) {
  electronPath = null;
}

if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
  const local = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  electronPath = fs.existsSync(local) ? local : null;
}

if (!electronPath) {
  console.error('找不到 Electron，请先执行：npm install');
  process.exit(1);
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE; // 否则 Electron 会当成 Node 跑，导致 require('electron') 失效

const args = [root].concat(process.argv.slice(2));
const child = spawn(electronPath, args, { stdio: 'inherit', env, cwd: root });
child.on('close', (code) => process.exit(code == null ? 0 : code));
