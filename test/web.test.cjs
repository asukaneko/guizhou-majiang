'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { measure } = require('../src/js/viewport.js');
const { OnlineGame } = require('../server/online-game.js');
const { snapshot } = require('../server/serialize.js');
const R = require('../src/js/rules.js');

const script = (ctx, name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js', name), 'utf8'), ctx, { filename: name });
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) || null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };

test('手机横屏：竖拿进入牌桌交换宽高；实际横屏、返回房间、桌面不旋转', () => {
  for (const [w, h] of [[320, 568], [375, 667], [390, 844], [430, 932]]) {
    assert.deepEqual(measure(w, h, true, true), { mobile: true, rotated: true, width: h, height: w });
    assert.deepEqual(measure(h, w, true, true), { mobile: true, rotated: false, width: h, height: w });
    assert.equal(measure(w, h, true, false).rotated, false);
  }
  assert.equal(measure(1440, 900, false, true).rotated, false);
});

test('手机横屏：方向锁定或全屏被拒，页面旋转仍保持；退出牌桌恢复', async () => {
  const classes = new Set(['in-game']);
  const ctx = vm.createContext({
    innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: true }),
    navigator: { userActivation: { isActive: true } },
    screen: { orientation: { lock: async () => { throw new Error('unsupported'); }, unlock() {} } },
    document: {
      body: { classList: { contains: (c) => classes.has(c), toggle: (c, yes) => yes ? classes.add(c) : classes.delete(c) } },
      documentElement: { style: { setProperty() {} }, requestFullscreen: async () => { throw new Error('denied'); } }
    }
  });
  ctx.window = ctx;
  script(ctx, 'viewport.js');
  await ctx.GZViewport.enter();
  assert.ok(classes.has('rotate-game'));
  ctx.innerWidth = 844; ctx.innerHeight = 390;
  ctx.GZViewport.layout(); assert.equal(classes.has('rotate-game'), false);
  ctx.innerWidth = 390; ctx.innerHeight = 844;
  classes.delete('in-game'); ctx.GZViewport.leave();
  assert.equal(classes.has('rotate-game'), false);
});

test('结算同步：同一局重复快照只触发一次；新一局和同局号的新房间正常结算', () => {
  const ctx = vm.createContext({ GZRules: R, GZNet: { send: () => true } });
  ctx.window = ctx; script(ctx, 'remote-game.js');
  const remote = new ctx.GZRemoteGame.RemoteGame();
  const g = new OnlineGame({ dealer: 0, mode: 'classic' });
  g.phase = 'playing'; g.settleDraw();
  let ends = 0; remote.on('roundEnd', () => ends++);
  const snap = snapshot(g, 0);
  remote.applySnapshot(JSON.parse(JSON.stringify(snap)));
  remote.applySnapshot(JSON.parse(JSON.stringify(snap)));
  assert.equal(ends, 1);
  remote.applySnapshot({ ...snap, roundNo: 2, roundId: 'round2', result: null, phase: 'playing' });
  remote.applySnapshot({ ...snap, roundNo: 2, roundId: 'round2' });
  assert.equal(ends, 2);
  remote.applySnapshot({ ...snap, roundId: 'new-room-round1' });
  assert.equal(ends, 3);
});

test('刷新后恢复结算也只记一次战绩；不同局继续累加', () => {
  const localStorage = storage();
  const ctx = vm.createContext({ localStorage }); ctx.window = ctx;
  script(ctx, 'profile.js');
  const result = { onlineRoundId: 'r1', mode: 'classic', delta: 8, win: true };
  ctx.GZProfile.record(result); ctx.GZProfile.record(result);
  script(ctx, 'profile.js'); // 模拟刷新，重新从存储加载。
  ctx.GZProfile.record(result);
  assert.equal(ctx.GZProfile.summary().games, 1);
  assert.equal(ctx.GZProfile.summary().score, 8);
  ctx.GZProfile.record({ ...result, onlineRoundId: 'r2' });
  assert.equal(ctx.GZProfile.summary().games, 2);
});

test('网络：旧 socket 的延迟 close/message 不影响新连接；会话先恢复后开放操作', () => {
  const sockets = [], timers = new Map(); let timerId = 0;
  class Socket {
    constructor(addr) { this.addr = addr; this.readyState = 0; this.sent = []; sockets.push(this); }
    close() { this.readyState = 3; }
    send(data) { this.sent.push(JSON.parse(data)); }
  }
  const ctx = vm.createContext({ WebSocket: Socket, sessionStorage: storage(), addEventListener() {},
    setInterval: (fn) => { timers.set(++timerId, fn); return timerId; },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearInterval: (id) => timers.delete(id), clearTimeout: (id) => timers.delete(id) });
  ctx.window = ctx; script(ctx, 'net.js');
  const net = ctx.GZNet;
  const open = (s, token) => {
    s.readyState = 1; s.onopen(); s.onmessage({ data: JSON.stringify({ t: 'welcome', resumeToken: token }) });
  };
  net.connect('ws://one'); const old = sockets[0]; open(old, 'token1');
  assert.equal(net.status(), 'open');
  net.connect('ws://two'); const current = sockets[1]; open(current, 'token2');
  old.onclose({ code: 1000 }); old.onmessage({ data: JSON.stringify({ t: 'welcome', resumeToken: 'wrong' }) });
  assert.equal(net.status(), 'open'); assert.equal(net.send({ t: 'ping' }), true);
  assert.equal(current.sent.at(-1).t, 'ping');
  net.disconnect(); net.connect('ws://one'); const restored = sockets[2]; open(restored, 'new-token');
  assert.equal(restored.sent[0].t, 'resume');
  assert.equal(restored.sent[0].token, 'token1');
  assert.equal(net.send({ t: 'action' }), false);
  restored.onmessage({ data: JSON.stringify({ t: 'resumed', resumeToken: 'token1' }) });
  assert.equal(net.status(), 'open');
  net.disconnect(); assert.equal(timers.size, 0);
});

test('网页脚本集成：联机换局、回房实时刷新、完桌重新配置并开启新桌', () => {
  // DOM 仅用于验证消息与渲染代码能协作；实际视觉布局由设备验收。
  const elements = new Map(), listeners = new Map(), sockets = [], timeouts = [];
  class Element {
    constructor(id = '') {
      this.id = id; this.innerHTML = ''; this.dataset = {}; this.children = new Map();
      this.style = { setProperty() {} }; this.clientWidth = 844; this.clientHeight = 348;
      this.events = new Map(); const classes = new Set();
      this.classList = {
        add: (...cs) => cs.forEach((c) => classes.add(c)), remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c), toggle: (c, yes = !classes.has(c)) => yes ? classes.add(c) : classes.delete(c)
      };
    }
    addEventListener(name, fn) { this.events.set(name, fn); }
    setAttribute(name, value) { this[name] = value; }
    querySelector(s) { if (!this.children.has(s)) this.children.set(s, new Element()); return this.children.get(s); }
    querySelectorAll() { return []; }
    appendChild() {}
    remove() {}
  }
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set('#' + id, new Element(id));
  const seats = ['bottom', 'right', 'top', 'left'].map((side, i) => {
    const seat = elements.get('#seat-' + side); seat.dataset.seat = String(i); return seat;
  });
  const doc = {
    body: new Element(), documentElement: new Element(),
    querySelector(s) {
      const seat = s.match(/^\.seat\[data-seat="(\d)"\]$/);
      const river = s.match(/^\.river\[data-seat="(\d)"\]$/);
      if (seat) return seats[+seat[1]];
      if (river) return elements.get('#river-' + ['bottom', 'right', 'top', 'left'][+river[1]]);
      if (s === '.win-btns') return new Element();
      return elements.get(s) || null;
    },
    querySelectorAll: (s) => s === '.seat' ? seats : [],
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    createElement: () => new Element()
  };
  ['#lobby', '#online', '#overlay', '#tip', '#net-status'].forEach((s) => elements.get(s).classList.add('hidden'));
  class Socket {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  const ctx = vm.createContext({ document: doc, localStorage: storage(), sessionStorage: storage(),
    GZRules: R, GZGame: require('../src/js/game.js'),
    location: { protocol: 'http:', host: 'localhost:8788' }, WebSocket: Socket,
    innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: true }),
    navigator: { userActivation: { isActive: false } }, screen: {},
    addEventListener() {}, setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    setInterval: () => 1, clearTimeout() {}, clearInterval() {}, console });
  ctx.window = ctx;
  for (const name of ['tiles.js', 'profile.js', 'viewport.js', 'net.js', 'remote-game.js', 'online.js', 'lobby.js', 'ui.js']) script(ctx, name);
  listeners.get('DOMContentLoaded')[0]();
  assert.ok(doc.body.classList.contains('in-lobby'));
  assert.equal(elements.get('#lobby').classList.contains('hidden'), false);
  assert.equal(elements.get('#brand-sub').textContent, '贵州麻将 · 游戏大厅');
  assert.equal(sockets.length, 0);
  ctx.GZUI.showOnline();
  assert.ok(doc.body.classList.contains('in-online'));
  const ws = sockets[0]; ws.readyState = 1; ws.onopen();
  const receive = (m) => ws.onmessage({ data: JSON.stringify(m) });
  receive({ t: 'welcome', resumeToken: 'token' });
  assert.equal(ws.sent[0].t, 'hello');
  const g = new OnlineGame({ dealer: 0, mode: 'yitong' });
  g.phase = 'playing';
  g.players[0].hand = [0, 1, 2, 3, 4, 5, 18, 19, 20, 22, 23, 18, 17, 17];
  g.players[1].name = '<img src=x>';
  g.players[2].melds = [{ type: 'angang', tile: 7, tiles: [7, 7, 7, 7] }];
  g.prompts.set(0, { id: 'prompt1', kind: 'discard', self: g.selfActions(0) });
  const room = { id: '4321', host: true, full: true, running: true, roundNo: 1, totalRounds: 2,
    config: { mode: 'yitong', totalRounds: 2 },
    seats: g.players.map((p, i) => ({ uid: `seat${i}`, name: p.name, you: i === 0, bot: i > 0, seat: i })) };
  receive({ t: 'joined', room: { ...room, running: false, roundNo: 0 } });
  assert.ok(doc.body.classList.contains('in-online'), '新建或加入等待房间能正常显示');
  assert.equal(ctx.GZOnline.started, false);
  receive({ t: 'room', room });
  assert.ok(doc.body.classList.contains('in-game'));
  assert.ok(doc.body.classList.contains('rotate-game'));
  receive({ t: 'snapshot', snap: { ...snapshot(g, 0), roomId: room.id }, fx: [] });
  assert.equal(elements.get('#btn-auto').textContent, '人机代打 关');
  assert.equal(elements.get('#btn-new').disabled, true, '联机中本局结束后才能开下一局');
  elements.get('#btn-auto').events.get('click')();
  assert.deepEqual(JSON.parse(JSON.stringify(ws.sent.at(-1))), { t: 'action', action: { type: 'autoplay', enabled: true } });
  g.players[0].botPlay = true;
  receive({ t: 'snapshot', snap: { ...snapshot(g, 0), roomId: room.id }, fx: [] });
  assert.equal(elements.get('#btn-auto').textContent, '人机代打 开');
  assert.match(seats[0].querySelector('.hand-main').innerHTML, /role="button"/);
  assert.match(seats[1].querySelector('.plate').innerHTML, /&lt;img/);
  assert.equal((seats[2].querySelector('.melds').innerHTML.match(/backface/g) || []).length, 4);
  assert.ok(ctx.GZOnline.started);
  receive({ t: 'room', room });
  assert.ok(ctx.GZOnline.started, '普通房间广播不能重置进场标记');
  g.prompts.clear(); g.settleDraw();
  const ended = { ...snapshot(g, 0), roomId: room.id };
  receive({ t: 'snapshot', snap: ended, fx: [] });
  receive({ t: 'snapshot', snap: ended, fx: [] });
  assert.equal(ctx.GZProfile.summary().games, 1);
  ctx.GZUI.showResult(ctx.__game.result);
  assert.equal(elements.get('#overlay').classList.contains('hidden'), false);
  receive({ t: 'room', room: { ...room, host: false, running: false } });
  assert.equal(elements.get('#overlay').querySelector('[data-act="next"]').disabled, true);
  assert.equal(elements.get('#btn-new').disabled, true);
  receive({ t: 'room', room: { ...room, host: true, running: false } });
  assert.equal(elements.get('#overlay').querySelector('[data-act="next"]').disabled, false);
  assert.equal(elements.get('#btn-new').disabled, false);
  elements.get('#btn-new').events.get('click')();
  assert.equal(ws.sent.at(-1).t, 'next');
  receive({ t: 'room', room: { ...room, roundNo: 2 } });
  assert.ok(elements.get('#overlay').classList.contains('hidden'));

  const finishedRoom = { ...room, running: false, finished: true, roundNo: 2 };
  receive({ t: 'snapshot', snap: { ...ended, roundNo: 2, roundId: 'last-round' }, fx: [] });
  receive({ t: 'room', room: finishedRoom });
  ctx.GZUI.showResult(ctx.__game.result);
  ctx.GZUI.showOnlineRoom();
  assert.equal(ctx.GZOnline.started, false, '返回房间清除正在牌桌的标记');
  assert.ok(doc.body.classList.contains('in-online'));
  assert.equal(doc.body.classList.contains('rotate-game'), false);
  const online = elements.get('#online');
  assert.match(online.innerHTML, /data-act="start" >开启新的一桌/);
  const onlineClick = (act, uid) => online.events.get('click')({ target: { closest: () => ({ dataset: { act, uid } }) } });
  onlineClick('removebot', 'seat1');
  assert.equal(ws.sent.at(-1).t, 'removebot');
  assert.equal(ws.sent.at(-1).uid, 'seat1');
  const removedRoom = { ...finishedRoom, full: false, seats: room.seats.map((s, i) => i === 1 ? { ...s, uid: null, name: null, bot: false } : s) };
  receive({ t: 'room', room: removedRoom });
  assert.match(online.innerHTML, /等待加入/);
  assert.doesNotMatch(online.innerHTML, /data-uid="seat1"/);
  assert.match(online.innerHTML, /data-act="start" disabled/);
  assert.match(online.innerHTML, /data-act="addbot" >/);
  assert.ok(doc.body.classList.contains('in-online'), '移除广播保持在房间配置页');
  for (const { fn, ms } of timeouts) if (ms === 650) fn();
  assert.ok(elements.get('#overlay').classList.contains('hidden'), '延迟结算不得覆盖房间页');
  receive({ t: 'joined', resumed: true, room: removedRoom });
  assert.equal(ctx.GZOnline.started, false, '在房间重连仍停留在配置页');

  elements.set('#ol-mode2', Object.assign(new Element(), { value: 'classic' }));
  elements.set('#ol-rounds2', Object.assign(new Element(), { value: '1' }));
  online.events.get('change')({ target: { id: 'ol-mode2' } });
  assert.deepEqual(JSON.parse(JSON.stringify(ws.sent.at(-1))), { t: 'config', config: { mode: 'classic', totalRounds: 1 } });
  const configuredRoom = { ...finishedRoom, config: { mode: 'classic', totalRounds: 1 } };
  receive({ t: 'room', room: configuredRoom });
  assert.match(online.innerHTML, /data-act="start" >开启新的一桌/);
  assert.match(online.innerHTML, /累计分数继续保留/);
  onlineClick('start');
  assert.equal(ws.sent.at(-1).t, 'newtable');
  receive({ t: 'room', room: { ...configuredRoom, running: true, finished: false, roundNo: 1, totalRounds: 1 } });
  assert.ok(ctx.GZOnline.started);
  assert.ok(doc.body.classList.contains('in-game'));
  receive({ t: 'snapshot', snap: { ...ended, roundId: 'new-table-round1', roundNo: 1, totalRounds: 1, mode: 'classic', scores: [12, -7, -3, -2], phase: 'playing', result: null }, fx: [] });
  assert.equal(ctx.__game.mode.id, 'classic');
  assert.equal(ctx.__game.result, null);
  assert.deepEqual(Array.from(ctx.__game.scores), [12, -7, -3, -2]);
  receive({ t: 'snapshot', snap: { ...ended, roundId: 'new-table-round1', totalRounds: 1 }, fx: [] });
  assert.equal(ctx.GZProfile.summary().games, 3, '新桌第 1 局仍独立记录');
  const oneRoundRoom = { ...configuredRoom, roundNo: 1, totalRounds: 1 };
  receive({ t: 'room', room: oneRoundRoom });
  ctx.GZUI.showResult(ctx.__game.result);
  receive({ t: 'room', room: { ...oneRoundRoom, running: true, finished: false } });
  assert.ok(elements.get('#overlay').classList.contains('hidden'), '连续单局桌的局号相同也要收起旧结算');
  ctx.GZUI.showLobby();
  assert.equal(doc.body.classList.contains('rotate-game'), false);
  ctx.__ui.enterMode('classic');
  assert.ok(doc.body.classList.contains('rotate-game'), '练习桌也自动横屏');
  const previous = ctx.__game;
  assert.equal(elements.get('#btn-new').disabled, false);
  elements.get('#btn-new').events.get('click')();
  assert.notEqual(ctx.__game, previous);
  assert.equal(previous.phase, 'ended');
  assert.equal(ctx.__game.roundNo, previous.roundNo + 1);
  ctx.__game.phase = 'ended';
});
