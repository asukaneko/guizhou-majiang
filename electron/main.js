const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isShot = process.argv.includes('--shot');
const shotArg = process.argv.find((a) => a.startsWith('--shot-path='));
const modeArg = process.argv.find((a) => a.startsWith('--shot-mode='));
const shotMode = modeArg ? modeArg.split('=')[1] : 'table';
const shotPath = shotArg ? shotArg.split('=')[1] : path.join(__dirname, '..', 'output', 'shot.png');

let win = null;

if (isShot) app.disableHardwareAcceleration();

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 720,
    frame: false,
    show: !isShot,
    backgroundColor: '#060c09',
    title: '贵州麻将 · 贵阳捉鸡',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  const page = process.argv.find((a) => a.startsWith('--shot-url='));
  const file = page ? page.split('=')[1] : path.join(__dirname, '..', 'src', 'index.html');
  win.loadFile(file);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

Menu.setApplicationMenu(null);

ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => win && win.close());

app.whenReady().then(async () => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  if (isShot) {
    try { await capture(); } catch (err) { console.error(err); }
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- 截图模式（开发自检用） ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture() {
  const w = win;
  await new Promise((r) => w.webContents.once('did-finish-load', r));
  await sleep(900);

  const isPreview = process.argv.some((a) => a.startsWith('--shot-url='));
  if (isPreview) {
    await sleep(600);
    if (isShot) { w.showInactive(); await sleep(600); }
    const shot = await w.webContents.capturePage();
    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
    fs.writeFileSync(shotPath, shot.toPNG());
    console.log('screenshot saved:', shotPath);
    return;
  }

  if (shotMode === 'rules') {
    await w.webContents.executeJavaScript(`document.querySelector('#btn-rules').click(); true;`);
    await sleep(600);
  } else if (shotMode === 'claim') {
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.askDiscard = function(){ return new Promise(function(){}); };
        g.phase = 'playing';
        g.turn = 1;
        g.players[0].hand = [0,1,2,3,4,5,6,18,19,20,22,23,26];
        g.players[0].melds = [];
        g.players[0].discards = [];
        g.players[1].discards = [9];
        g.lastDiscard = { p: 1, tile: 9 };
        g.awaiting = { kind: 'claim', player: 0, tile: 9, from: 1, options: ['hu','peng'], info: { name: '清一色', points: 10 }, deadline: Date.now() + 9000 };
        g.emitState();
      })(); true;
    `);
    await sleep(900);
  } else if (shotMode === 'ting') {
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.speed = 0.00001;
        g.askDiscard = function(){ return new Promise(function(){}); };
      })(); true;
    `);
    await sleep(700);
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.phase = 'playing';
        g.turn = 2;
        g.players[0].hand = [0,1,2,3,4,5,6,7,8,12,13,18,18];
        g.players[0].melds = [];
        g.players[0].discards = [];
        g.players[0].justDrawn = null;
        g.awaiting = null;
        g.emitState();
      })(); true;
    `);
    await sleep(700);
  } else if (shotMode === 'auto') {
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.speed = 0.00001;
        g.askDiscard = function(){ return new Promise(function(){}); };
      })(); true;
    `);
    await sleep(700);
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.setAuto(true);
        const btn = document.querySelector('#btn-auto');
        btn.classList.add('on');
        btn.textContent = '自动摸打 开';
        g.phase = 'playing';
        g.turn = 0;
        g.scores = [0, 0, 0, 0];
        g.roundDeltas = [0, 0, 0, 0];
        g.players.forEach(function (q) { q.discards = []; q.melds = []; q.said = ''; });
        g.lastDiscard = null;
        g.players[0].hand = [0,1,2,3,4,5,6,7,8,12,13,18,18,20];
        g.players[0].discards = [22, 24];
        g.players[0].justDrawn = 20;
        g.awaiting = { kind: 'discard', player: 0, auto: true, autoTile: 20, self: { hu: null, angang: [], bugang: [] } };
        g.emitState();
      })(); true;
    `);
    await sleep(700);
  } else if (shotMode === 'tip') {
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.speed = 0.00001;               // 冻结对局节奏
        g.askDiscard = function(){ return new Promise(function(){}); };
      })(); true;
    `);
    await sleep(700);
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.phase = 'playing';
        g.turn = 0;
        g.players[0].hand = [0,1,2,3,4,5,6,7,8,12,13,18,18,20];
        g.players[0].melds = [];
        g.players[0].discards = [22, 25];
        g.players[0].justDrawn = 20;
        g.players[1].discards = [9, 20, 14];
        g.awaiting = { kind: 'discard', player: 0, self: { hu: null, angang: [], bugang: [] } };
        g.emitState();
        setTimeout(function(){
          const node = document.querySelector('.hand-main .tile[data-tile="20"]');
          if (!node) return;
          const r = node.getBoundingClientRect();
          node.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + 8
          }));
        }, 350);
      })(); true;
    `);
    await sleep(1200);
  } else if (shotMode === 'result') {
    const r = await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        if (!g) return 'no-game';
        g.phase = 'playing';
        g.scores = [0,0,0,0];
        g.roundDeltas = [0,0,0,0];
        g.kongLog = [];
        g.turn = 0;
        g.players[0].hand = [0,1,2,3,4,5,6,7,8,18,18];
        g.players[0].melds = [{ type: 'peng', tile: 9, tiles: [9,9,9], from: 2 }];
        g.players[0].discards = [];
        g.wall = [22, 5, 6, 7];
        g.settleWin(0, { selfDraw: true, winTile: 18 });
        return JSON.stringify({ wall: g.wall.length, phase: g.phase });
      })();
    `);
    if (process.argv.includes('--diag')) console.log('INJECT', r);
    await sleep(1400);
  } else {
    await w.webContents.executeJavaScript(`
      window.__game.speed = 2.6;
      (function auto(){
        const g = window.__game;
        if (!g) return setTimeout(auto, 200);
        const a = g.awaiting;
        if (a) {
          if (a.kind === 'claim') g.humanRespond('pass');
          else if (a.kind === 'discard') {
            const h = g.players[0].hand;
            g.humanDiscard(h[(Math.random() * h.length) | 0]);
          }
        }
        if (g.phase === 'playing') setTimeout(auto, 260);
      })();
      true;
    `);
    await sleep(4600);
    await w.webContents.executeJavaScript(`window.__game.speed = 0.0004; true;`);
    await sleep(500);
  }

  if (isShot) { w.showInactive(); await sleep(700); }
  const img = await w.webContents.capturePage();
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, img.toPNG());
  console.log('screenshot saved:', shotPath);

  if (process.argv.includes('--diag')) {
    const info = await w.webContents.executeJavaScript(`JSON.stringify((() => {
      const r = document.querySelector('.river[data-seat="0"]');
      const t = r.firstElementChild;
      const cs = t ? getComputedStyle(t) : null;
      const b = t ? t.getBoundingClientRect() : null;
      const hit = b ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) : null;
      return {
        html: r.innerHTML.slice(0, 160),
        tile: t ? { w: b.width, h: b.height, opacity: cs.opacity, bg: cs.backgroundImage.slice(0, 40), anim: cs.animationName, transform: cs.transform } : null,
        hit: hit ? hit.className + '|' + hit.tagName : null,
        hitPath: hit ? (function(){ let p=[], n=hit; while(n && p.length<4){ p.push(n.id||n.className); n=n.parentElement; } return p.join(' < '); })() : null,
        stageTransform: getComputedStyle(document.querySelector('#stage')).transform
      };
    })())`);
    console.log('DIAG', info);
  }
}
