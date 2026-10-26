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

  // 现在启动先到大厅：除大厅截图外，其余截图先进入对应玩法
  if (shotMode === 'online-e2e') {
    // 真服务器 + 真窗口 + 真 UI 点击：联机面板 → 建房 → 加机器人 → 开始对局
    const port = (process.argv.find((a) => a.startsWith('--server-port=')) || '').split('=')[1] || '8788';
    const run = async () => {
      const exec = (code) => w.webContents.executeJavaScript(code);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const click = (sel) => exec(`(function(){ const b = document.querySelector('${sel}'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()`);
      const fill = (sel, v) => exec(`(function(){ const n = document.querySelector('${sel}'); if (!n) return 'no-input'; n.value = '${v}'; n.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);

      // 1. 进联机面板，连接服务器
      await exec(`window.__ui.showOnline(); 'ok'`);
      await wait(400);
      console.log('FILL', await fill('#ol-addr', `ws://127.0.0.1:${port}`));
      console.log('CONN', await click('[data-act="connect"]'));
      await wait(800);
      // 2. 建房（经典 1 局）
      const modeSet = await exec(`(function(){ const s = document.querySelector('#ol-mode'); if (!s) return 'no-select'; s.value = 'classic'; s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
      console.log('MODE', modeSet);
      console.log('CREATE', await click('.ol-block [data-act="create"]'));
      await wait(700);
      // 3. 加满机器人
      for (let i = 0; i < 3; i++) {
        console.log('BOT', await click('[data-act="addbot"]'));
        await wait(300);
      }
      // 4. 开始对局（走真实按钮 → onEnterGame → RemoteGame）
      console.log('START', await click('[data-act="start"]'));
      await wait(900);
      await exec(`
        (function(){
          const g = () => window.__game;
          window.__autoTimer = setInterval(function(){
            const gm = g();
            if (!gm || !gm.isRemote) return;
            const a = gm.awaiting;
            if (!a) return;
            if (a.kind === 'claim') { gm.humanRespond(a.options.includes('hu') ? 'hu' : 'pass'); return; }
            if (a.self && a.self.hu) { gm.humanHu(); return; }
            const me = gm.players[0];
            const tile = me.hand && me.hand.includes(me.justDrawn) ? me.justDrawn : (me.hand || [])[0];
            if (tile != null) gm.humanDiscard(tile);
          }, 240);
        })(); 'auto-on'
      `);
      // 等结算面板出现
      const t0 = Date.now();
      let done = false;
      while (Date.now() - t0 < 150000) {
        await wait(500);
        const st = await exec(`
          (function(){
            const gm = window.__game;
            return JSON.stringify({
              remote: !!(gm && gm.isRemote),
              phase: gm ? gm.phase : 'none',
              round: gm ? gm.roundNo : 0,
              panel: !!document.querySelector('#overlay .panel'),
              seats: gm && gm.players ? gm.players.map(function(p){ return p.name; }) : [],
              score: gm ? gm.scores : [],
              net: window.GZNet.status(),
              snapSeen: gm ? !!gm.state : false,
              waiting: gm && gm.awaiting ? gm.awaiting.kind : null
            });
          })()
        `);
        const s = JSON.parse(st);
        if (process.env.DIAG || process.argv.includes('--diag')) {
          console.log('RENDER-TICK', st);
        }
        if (s.phase === 'ended' && s.panel) {
          console.log('RENDER-OK', st);
          done = true;
          break;
        }
      }
      if (!done) console.log('RENDER-TIMEOUT');
      await exec(`clearInterval(window.__autoTimer); 'off'`);
    };
    try { await run(); } catch (err) { console.log('RENDER-ERR', err && err.message); }
    await sleep(500);
  } else if (shotMode === 'online') {
    await w.webContents.executeJavaScript(`window.__ui.showOnline(); true;`);
    await sleep(700);
  } else if (shotMode === 'online-room') {
    // 演示房间（本地桩数据，不起服务器）
    await w.webContents.executeJavaScript(`
      (function(){
        const node = document.querySelector('#online');
        node.classList.remove('hidden');
        const seats = ['你', '阿乙', '阿贵', '小幺'].map((name, i) => ({ name, bot: i >= 2, host: i === 0 }));
        node.querySelector('.ol-wrap').innerHTML = '<div class="ol-card wide">' +
          '<div class="ol-head"><h2>房间 5213</h2><span class="ol-badge on">满员</span></div>' +
          '<p class="ol-sub">把房号 <b class="ol-code">5213</b> 告诉朋友，让 TA「加入房间」；不满 4 人房主可以补机器人。</p>' +
          '<div class="ol-seats">' + seats.map((s, i) =>
            '<div class="ol-seat"><div class="ol-seat-no">' + ['你','下家','对家','上家'][i] + '</div>' +
            '<div class="ol-seat-name">' + s.name + '</div>' +
            '<div class="ol-seat-tags"><span class="ol-seat-tag' + (s.bot ? ' bot' : '') + '">' + (s.bot ? '机器人' : '玩家') + '</span>' +
            (s.host ? '<span class="ol-seat-tag host">房主</span>' : '') + '</div></div>'
          ).join('') + '</div>' +
          '<div class="ol-config"><label class="ol-field inline"><span>玩法</span><select><option>幺筒麻将</option></select></label>' +
          '<label class="ol-field inline"><span>局数</span><select><option>4 局</option></select></label>' +
          '<button class="btn-ghost">添加机器人</button></div>' +
          '<div class="ol-foot"><button class="btn-ghost">退出房间</button><button class="btn-primary">开始对局</button></div></div>';
        window.__ui.fit();
      })(); true;
    `);
    await sleep(700);
  } else if (shotMode === 'lobby') {
    const demo = `(() => {
      const now = Date.now();
      const h = (mins, mode, delta, win, selfDraw, pattern, points) => ({
        t: now - mins * 60000, mode, delta, win, selfDraw, pattern, points
      });
      const st = (o) => Object.assign({
        score: 0, games: 0, wins: 0, selfDraws: 0, rounds: 0, best: 0,
        streak: 0, bestStreak: 0, last: 0
      }, o);
      localStorage.setItem('gz-mj-profile-v2', JSON.stringify({
        v: 2, name: '阿岩', avatar: '雀', created: now - 86400000 * 12,
        modes: {
          classic: st({ score: 86, games: 24, wins: 9, selfDraws: 4, rounds: 24, best: 32, streak: 2, bestStreak: 4, last: now }),
          yitong: st({ score: 41, games: 11, wins: 5, selfDraws: 3, rounds: 11, best: 26, streak: 1, bestStreak: 3, last: now })
        },
        history: [
          h(14, 'yitong', 18, true, true, '清一色', 11),
          h(19, 'yitong', -15, false, false, '', 0),
          h(52, 'classic', 9, true, false, '大对子', 6),
          h(58, 'classic', -3, false, false, '', 0),
          h(1260, 'yitong', 26, true, true, '硬胡 · 七对', 12),
          h(1290, 'classic', 4, false, false, '黄庄', 0),
          h(2820, 'classic', 32, true, true, '清大对', 15),
          h(2860, 'yitong', -6, false, false, '', 0)
        ]
      }));
      localStorage.setItem('gz-mj-table-classic', JSON.stringify({ scores: [86, -34, -12, -40], round: 25, dealer: 1 }));
      return true;
    })()`;
    await w.webContents.executeJavaScript(demo);
    const loaded = new Promise((r) => w.webContents.once('did-finish-load', r));
    w.webContents.reload();
    await loaded;
    await sleep(1200);
  } else if (shotMode !== 'online' && shotMode !== 'online-room' && shotMode !== 'online-e2e') {
    const modeForShot = shotMode.indexOf('yitong') === 0 ? 'yitong' : 'classic';
    await w.webContents.executeJavaScript(`
      (function(){
        try { localStorage.removeItem('gz-mj-table-classic'); localStorage.removeItem('gz-mj-table-yitong'); } catch (e) {}
        window.__ui.enterMode('${modeForShot}');
      })(); true;
    `);
    await sleep(700);
  }

  if (shotMode === 'lobby') {
    /* 大厅已经就位，直接截图 */
  } else if (shotMode === 'smoke') {
    /* 冒烟自检：打一局 → 战绩落盘 → 回大厅 → 换玩法，检查串起来没断 */
    const out = await w.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const g = window.__game;
      const P = window.GZProfile;
      const before = P.get().modes.classic.games;
      g.phase = 'playing';
      g.wall = [22, 5, 6];
      g.players[0].hand = [0,1,2,3,4,5,6,7,8,9,10,11,13,13];
      g.settleWin(0, { selfDraw: true, winTile: null });
      await wait(900);
      const rec = P.get();
      const panel = document.querySelector('#overlay .panel');
      document.querySelector('[data-act="lobby"]').click();
      await wait(300);
      const inLobby = document.body.classList.contains('in-lobby');
      const rows = document.querySelectorAll('.hist-table tbody tr').length;
      document.querySelector('[data-enter="yitong"]').click();
      await wait(600);
      const modeNow = window.__game.mode.id;
      const brand = document.querySelector('#brand-sub').textContent;
      document.querySelector('#btn-lobby').click();
      await wait(300);
      document.querySelector('#btn-rules').click();
      await wait(250);
      const tabs = document.querySelectorAll('.rules-tab').length;
      document.querySelector('[data-rules-tab="yitong"]').click();
      await wait(250);
      const activeTab = (document.querySelector('.rules-tab.on') || {}).textContent;
      const hasYitong = document.querySelector('#overlay').innerHTML.indexOf('财神：幺筒') >= 0;
      document.querySelector('[data-act="close-rules"]').click();
      await wait(150);
      return JSON.stringify({
        gamesBefore: before, gamesAfter: rec.modes.classic.games,
        score: rec.modes.classic.score, win: rec.modes.classic.wins,
        hist0: rec.history[0], panel: !!panel,
        inLobby, rows, modeNow, brand,
        tableClassic: !!P.tableScore('classic'), tableYitong: !!P.tableScore('yitong'),
        cards: document.querySelectorAll('.mode-card').length,
        tabs, activeTab, hasYitong,
        overlayClosed: document.querySelector('#overlay').classList.contains('hidden')
      });
    })()`);
    console.log('SMOKE', out);
    await sleep(400);
  } else if (shotMode === 'yitong') {
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.speed = 0.00001;
        g.askDiscard = function(){ return new Promise(function(){}); };
      })(); true;
    `);
    await sleep(500);
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.phase = 'playing';
        g.turn = 0;
        g.scores = [0, 0, 0, 0];
        g.roundDeltas = [0, 0, 0, 0];
        g.players.forEach(function (q) { q.discards = []; q.melds = []; q.said = ''; });
        g.lastDiscard = null;
        g.chongCount = 0;
        g.penaltyLog = [];
        // 手里两张幺筒（财神），另有一张当真一筒
        g.players[0].hand = [0,1,2,3,4,5,9,9,18,18,20,21,22,13];
        g.players[0].justDrawn = 13;
        g.players[1].discards = [18];
        g.lastDiscard = { p: 1, tile: 18 };
        g.chongYitong(1);        g.awaiting = { kind: 'discard', player: 0, self: { hu: null, angang: [], bugang: [] } };
        g.emitState();
      })(); true;
    `);
    await sleep(900);
  } else if (shotMode === 'yitong-result') {
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.speed = 0.00001;
        g.askDiscard = function(){ return new Promise(function(){}); };
      })(); true;
    `);
    await sleep(500);
    await w.webContents.executeJavaScript(`
      (function(){
        const g = window.__game;
        g.phase = 'playing';
        g.turn = 0;
        g.scores = [0, 0, 0, 0];
        g.roundDeltas = [0, 0, 0, 0];
        g.players.forEach(function (q) { q.discards = []; q.melds = []; q.said = ''; });
        // 幺筒当真一筒用：123万 456万 789万 123筒 99条 —— 硬胡
        g.players[0].hand = [0,1,2,3,4,5,6,7,8,18,19,20,9,9];
        g.players[1].hand = [0,1,2,4,5,6,18,18,20,21,22,13,13];
        g.players[2].hand = [9,10,11,12,13,14,15,16,17,22,23,24,25];
        g.players[3].hand = [3,4,5,6,7,8,10,11,12,19,20,21,26];
        g.players[1].discards = [18];
        g.wall = [22, 5, 6, 7];
        g.chongCount = 1;
        g.penaltyLog = [{ kind: '冲幺筒', p: 1, points: 5, deltas: [-5, 15, -5, -5], seq: 1, label: '第 1 张幺筒' }];
        g.scores = [-5, 15, -5, -5];
        g.roundDeltas = [-5, 15, -5, -5];
        g.settleWin(0, { selfDraw: true, winTile: 9 });
      })(); true;
    `);
    await sleep(1400);
  } else if (shotMode === 'yitong-rules') {
    await w.webContents.executeJavaScript(`document.querySelector('#btn-rules').click(); true;`);
    await sleep(800);
  } else if (shotMode === 'rules') {
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
  } else if (shotMode === 'baoting') {
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
        g.turn = 0;
        g.scores = [0, 0, 0, 0];
        g.roundDeltas = [0, 0, 0, 0];
        g.players.forEach(function (q) { q.discards = []; q.melds = []; q.said = ''; });
        g.lastDiscard = null;
        g.players[0].hand = [0,1,2,3,4,5,6,7,8,9,10,11,17,22];
        g.players[0].justDrawn = 17;
        g.awaiting = { kind: 'discard', player: 0, self: { hu: null, angang: [], bugang: [] } };
        g.emitState();
      })(); true;
    `);
    await sleep(600);
  } else if (shotMode === 'baoting-on') {
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
        g.turn = 0;
        g.scores = [0, 0, 0, 0];
        g.roundDeltas = [0, 0, 0, 0];
        g.players.forEach(function (q) { q.discards = []; q.melds = []; q.said = ''; });
        g.lastDiscard = null;
        const pl = g.players[0];
        pl.hand = [0,1,2,3,4,5,6,7,8,9,10,11,17,22];
        pl.justDrawn = 17;
        pl.tingAtDeal = false;
        const self = { hu: null, angang: [], bugang: [] };
        g.awaiting = { kind: 'discard', player: 0, self: self, resolve: function(){} };
        g.humanTing();
        pl.hand = [0,1,2,3,4,5,6,7,8,9,10,11,22];
        g.awaiting = { kind: 'discard', player: 0, self: self, auto: true, ting: true, autoTile: 17 };
        g.emitState();
      })(); true;
    `);
    await sleep(700);
  } else if (shotMode === 'multi') {
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
        g.scores = [0, 0, 0, 0];
        g.roundDeltas = [0, 0, 0, 0];
        g.players.forEach(function (q) { q.discards = []; q.melds = []; q.said = ''; });
        // 两家都听五筒
        g.players[1].hand = [0,1,2,3,4,5,6,7,8,9,10,11,22];
        g.players[2].hand = [18,19,20,21,23,9,10,11,0,1,2,26,26];
        g.players[3].hand = [22,0,1,2,3,4,5,6,7,8,12,13,14];
        g.players[3].discards = [22];
        g.lastDiscard = { p: 3, tile: 22 };
        g.wall = [4, 5, 6];
        g.settleWin([{ p: 1, winTile: 22 }, { p: 2, winTile: 22 }], { selfDraw: false, from: 3 });
      })(); true;
    `);
    await sleep(1600);
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
        // 下家 / 对家 都叫牌，上家没叫（手里也没鸡）
        g.players[1].hand = [0,1,2,3,4,5,6,7,8,9,10,11,22];
        g.players[2].hand = [18,19,20,21,23,9,10,11,0,1,2,26,26];
        g.players[3].hand = [3,4,5,12,13,14,19,20,21,24,26,0,1];
        g.wall = [22, 5, 6, 7];
        g.settleWin(0, { selfDraw: true, winTile: 18 });
        return JSON.stringify({ wall: g.wall.length, phase: g.phase });
      })();
    `);
    if (process.argv.includes('--diag')) console.log('INJECT', r);
    await sleep(1400);
  } else if (shotMode !== 'lobby' && shotMode !== 'online' && shotMode !== 'online-room') {
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
