'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { measure, tableLayout } = require('../src/js/viewport.js');
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

test('手机牌桌：不同可用高度下14张手牌完整留白，牌河不覆盖桌心、手牌或操作区，弃牌保留整行', () => {
  const overlap = (a, b) => a.x < b.x + b.w - .01 && a.x + a.w > b.x + .01 &&
    a.y < b.y + b.h - .01 && a.y + a.h > b.y + .01;
  for (const width of [480, 568, 640, 667, 740, 812, 844, 896, 932, 1024, 1260]) {
    for (const height of [190, 198, 220, 239, 260, 278, 306, 348, 388, 480, 560]) {
      for (const controls of [false, true]) {
        const l = tableLayout(width, height, controls);
        for (const rect of [l.hand, l.center, ...l.rivers, ...(controls ? [l.actions] : [])]) {
          assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= width + .01 && rect.y + rect.h <= height + .01,
            `${width}x${height} controls=${controls}: ${JSON.stringify(rect)} 越界`);
        }
        assert.ok(l.tile.w >= 24, '手牌仍有可点击的宽度');
        assert.ok(height - l.hand.y - l.hand.h >= 9.99, '给牌底和安全区保留至少10像素');
        for (const river of l.rivers) {
          assert.equal(overlap(river, l.center), false);
          assert.equal(overlap(river, l.hand), false);
          const rows = (river.h + 2) / (l.riverTile.h + 2);
          assert.ok(Math.abs(rows - Math.round(rows)) < .0001, '滚动牌河不能只露出半张弃牌');
        }
        if (controls) assert.equal(overlap(l.rivers[1], l.actions), false);
        // 三家对手的牌河不再挤在同一条横带里
        assert.equal(overlap(l.rivers[1], l.rivers[2]), false);
        assert.equal(overlap(l.rivers[3], l.rivers[2]), false);
        assert.equal(overlap(l.rivers[1], l.rivers[3]), false);
        // 提示条落在下家牌河右边的空白列：不压桌心、手牌、牌河和操作区
        assert.ok(l.toast.x >= 0 && l.toast.x + l.toast.w <= width + .01, '提示条越界');
        assert.ok(l.toast.y + l.toast.h <= height + .01, '提示条越界');
        if (l.toast.h > .5) {                       // 极矮屏没有空白列时高度为 0（不显示提示条）
          assert.equal(overlap(l.toast, l.center), false);
          assert.equal(overlap(l.toast, l.hand), false);
          for (const river of l.rivers) assert.equal(overlap(l.toast, river), false);
          if (controls) assert.equal(overlap(l.toast, l.actions), false);
        }
      }
    }
  }
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

test('网页脚本集成：联机换局、结算看牌、回房实时刷新、完桌重新配置并开启新桌', async () => {
  // DOM 仅用于验证消息与渲染代码能协作；实际视觉布局由设备验收。
  const elements = new Map(), listeners = new Map(), sockets = [], timeouts = [], animations = [];
  class Element {
    constructor(id = '') {
      this.id = id; this.innerHTML = ''; this.dataset = {}; this.children = new Map();
      this.nodes = []; this.value = ''; this.scrollTop = 0; this.scrollHeight = 0;
      this.style = { setProperty(name, value) { this[name] = value; } }; this.clientWidth = 844; this.clientHeight = 348;
      this.events = new Map(); const classes = new Set();
      this.classList = {
        add: (...cs) => cs.forEach((c) => classes.add(c)), remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c), toggle: (c, yes = !classes.has(c)) => yes ? classes.add(c) : classes.delete(c)
      };
    }
    addEventListener(name, fn) { this.events.set(name, fn); }
    setAttribute(name, value) { this[name] = value; }
    focus() {}
    blur() {}
    replaceChildren(...nodes) { this.nodes = nodes; }
    append(...nodes) { this.nodes.push(...nodes); }
    get childElementCount() { return this.nodes.length; }
    get firstElementChild() { return this.nodes[0]; }
    querySelector(s) { if (!this.children.has(s)) this.children.set(s, new Element()); return this.children.get(s); }
    querySelectorAll(selector) {
      if (![':scope > .tile[data-tile]', ':scope > .back'].includes(selector)) return [];
      const sig = selector + this.innerHTML;
      if (this._cardsSig !== sig) {
        this._cardsSig = sig;
        const pattern = selector.endsWith('.back') ? /<div class="back">/g : /<div class="tile[^\"]*" data-tile=/g;
        this._cards = Array.from(this.innerHTML.matchAll(pattern), () => new Element());
      }
      return this._cards;
    }
    animate(keyframes, options) {
      const animation = { node: this, keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
      animations.push(animation); return animation;
    }
    appendChild(node) { this.nodes.push(node); node.parent = this; return node; }
    remove() {
      if (!this.parent) return;
      const i = this.parent.nodes.indexOf(this);
      if (i >= 0) this.parent.nodes.splice(i, 1);
      this.parent = null;
    }
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
    GZRules: R, GZAI: require('../src/js/ai.js'), GZGame: require('../src/js/game.js'),
    location: { protocol: 'http:', host: 'localhost:8788' }, WebSocket: Socket,
    innerWidth: 390, innerHeight: 844, matchMedia: (q) => ({ matches: q.includes('pointer: coarse') }),
    getComputedStyle: () => ({ transform: 'none' }),
    navigator: { userActivation: { isActive: false } }, screen: {},
    addEventListener() {}, setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    setInterval: () => 1, clearTimeout() {}, clearInterval() {}, console });
  ctx.window = ctx;
  for (const name of ['tiles.js', 'profile.js', 'viewport.js', 'net.js', 'remote-game.js', 'online.js', 'chat.js', 'lobby.js', 'ui.js']) script(ctx, name);
  listeners.get('DOMContentLoaded')[0]();
  assert.ok(doc.body.classList.contains('in-lobby'));
  assert.equal(elements.get('#lobby').classList.contains('hidden'), false);
  assert.equal(elements.get('#brand-sub').textContent, '贵州麻将 · 游戏大厅');
  assert.match(elements.get('#lobby').innerHTML, /id="local-ai-difficulty"/);
  assert.match(elements.get('#lobby').innerHTML, /困难 · 扩大搜索与风险判断/);
  elements.get('#lobby').events.get('change')({ target: { id: 'local-ai-difficulty', value: 'hard' } });
  elements.get('#lobby').events.get('change')({ target: { id: 'local-bot-speed', value: 'fast' } });
  assert.equal(ctx.localStorage.getItem('gz-ai-difficulty'), 'hard');
  assert.equal(ctx.localStorage.getItem('gz-speed'), '2');
  assert.equal(sockets.length, 0);
  for (const mode of ['classic', 'yitong']) {
    ctx.GZUI.showRules(mode);
    const rules = elements.get('#overlay').innerHTML;
    assert.match(rules, /清三龙七对 <span class="hl">104/);
    assert.match(rules, /至少 14 分/);
    assert.match(rules, /每个杠向每位听牌者赔 4 分/);
    assert.match(rules, /杠和责任鸡作废/);
    assert.match(rules, /向每位胡家付一份/);
  }
  ctx.GZUI.hideResult();
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
  g.players[1].hand = [3,4,5,12,13,14,18,19,20,22];
  g.players[2].hand = [0,1,2,12,13,14,18,19,20,22];
  g.players[3].hand = [0,3,6,9,12,15,18,21,24,1,10,19,22];
  g.players[2].hand.push(7,7,7,7);
  await g.doKong(2, 'angang', 7);
  g.prompts.set(0, { id: 'prompt1', kind: 'discard', self: g.selfActions(0) });
  const room = { id: '4321', host: true, full: true, running: true, allReady: true, roundId: g.roundId, readyId: 'ready1', roundNo: 1, totalRounds: 2,
    config: { mode: 'yitong', totalRounds: 2 },
    seats: g.players.map((p, i) => ({ uid: `seat${i}`, name: p.name, you: i === 0, host: i === 0, bot: i > 0, seat: i })) };
  receive({ t: 'joined', room: { ...room, running: false, roundNo: 0 } });
  assert.ok(doc.body.classList.contains('in-online'), '新建或加入等待房间能正常显示');
  assert.equal(ctx.GZOnline.started, false);
  assert.match(elements.get('#online').innerHTML, /data-act="chat" data-room-chat-toggle/);
  assert.match(elements.get('#online').innerHTML, /同桌玩家/);
  assert.match(elements.get('#online').innerHTML, /牌桌设置/);
  elements.get('#online').events.get('click')({ target:{ closest:() => ({ dataset:{ act:'chat' } }) } });
  assert.ok(doc.body.classList.contains('chat-open'), '手机房间页的聊天入口可直接展开');
  const chatInput = elements.get('#chat-input'); chatInput.value = '房间里聊天';
  elements.get('#chat-form').events.get('submit')({ preventDefault() {} });
  const chat = ws.sent.at(-1); assert.equal(chat.t, 'chat'); assert.equal(chat.text, '房间里聊天');
  receive({ t:'chat', roomId:room.id, message:{ id:'room-message', uid:'seat0', name:'玩家', text:chat.text, at:1, clientId:chat.clientId } });
  assert.equal(chatInput.value, '');
  elements.get('#chat-close').events.get('click')();
  receive({ t: 'room', room });
  assert.ok(doc.body.classList.contains('in-game'));
  assert.ok(doc.body.classList.contains('rotate-game'));
  receive({ t: 'snapshot', snap: { ...snapshot(g, 0), roomId: room.id }, fx: [] });
  const center = elements.get('#center-panel');
  const stage = elements.get('#stage');
  const bottomRiver = elements.get('#river-bottom');
  bottomRiver.scrollHeight = 300; bottomRiver.scrollTop = 0;
  stage.clientWidth = 568; stage.clientHeight = 198;
  ctx.GZUI.fit();
  assert.equal(stage.style['--phone-hand-bottom'], '10.00px');
  assert.equal(stage.style['--phone-center-h'], '46.00px', '使用实际舞台高度适配矮屏');
  assert.ok(parseFloat(stage.style['--phone-tile-w']) < 28);
  assert.equal(bottomRiver.scrollTop, 300, '可用高度改变后仍展示最新弃牌');
  stage.clientWidth = 844; stage.clientHeight = 348; ctx.GZUI.fit();
  assert.equal(stage.style['--phone-center-h'], '64.00px');
  const notices = elements.get('#toast');
  receive({ t: 'snapshot', snap: { ...snapshot(g, 0), roomId: room.id }, fx: [{ type:'msg', text:'联机提示：对家报听' }] });
  assert.equal(notices.nodes.at(-1).textContent, '联机提示：对家报听');
  assert.equal(notices.nodes.at(-1).className, 'toast-item announce');
  assert.ok(center.classList.contains('turn-lit'), '手机桌心显示当前玩家的灯带');
  assert.equal(center.style['--turn-offset'], String(22 - g.turn * 100));
  assert.equal(center.style['--turn-travel'], '0ms', '首次进入直接亮在正确座位');
  const savedTurn = g.turn;
  g.turn = (g.turn + 1) % 4;
  receive({ t: 'snapshot', snap: { ...snapshot(g, 0), roomId: room.id }, fx: [] });
  assert.equal(center.style['--turn-travel'], '420ms');
  assert.equal(center.style['--turn-offset'], String(22 - (savedTurn + 1) * 100));
  g.turn = savedTurn;
  receive({ t: 'snapshot', snap: { ...snapshot(g, 0), roomId: room.id }, fx: [] });
  assert.equal(elements.get('#btn-auto').textContent, '人机代打 关');
  assert.equal(elements.get('#btn-new').disabled, true, '联机中本局结束后才能开下一局');
  assert.equal(elements.get('#btn-speed').disabled, false);
  elements.get('#btn-speed').events.get('click')();
  assert.deepEqual(JSON.parse(JSON.stringify(ws.sent.at(-1))), { t: 'config', config: { botSpeed: 'fast' } });
  assert.equal(ctx.localStorage.getItem('gz-speed'), '2', '联机调整不改本地速度设置');
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
  assert.equal(center.classList.contains('turn-lit'), false, '结算后关闭手机回合灯带');
  assert.equal(ctx.GZProfile.summary().games, 1);
  ctx.GZUI.showResult(ctx.__game.result);
  assert.equal(elements.get('#overlay').classList.contains('hidden'), false);
  assert.match(elements.get('#overlay').innerHTML, /查看牌面/);
  assert.match(elements.get('#overlay').innerHTML, /暗杠 八万：黄庄作废/);
  const clickAction = (act) => listeners.get('click')[0]({ target: { closest: (s) => s === '[data-act]' ? { dataset:{ act } } : null } });
  clickAction('close');
  const review = elements.get('#round-review');
  assert.ok(elements.get('#overlay').classList.contains('hidden'));
  assert.equal(review.classList.contains('hidden'), false);
  assert.equal((review.innerHTML.match(/<article /g) || []).length, 4);
  assert.equal((review.innerHTML.match(/data-tile=/g) || []).length, 51, '四家手牌加暗杠全部明示');
  assert.doesNotMatch(review.innerHTML, /backface|class="back"|<img src=x/);
  assert.match(review.innerHTML, /&lt;img src=x&gt;/);
  assert.match(review.innerHTML, /返回结算/);
  receive({ t:'snapshot', snap:ended, fx:[] });
  assert.equal(review.classList.contains('hidden'), false, '同局广播保留查看状态');
  clickAction('result');
  assert.ok(review.classList.contains('hidden'));
  assert.equal(elements.get('#overlay').classList.contains('hidden'), false);
  receive({ t: 'room', room: { ...room, host: false, running: false } });
  assert.equal(elements.get('#btn-speed').disabled, true);
  const resultNext = elements.get('#overlay').querySelector('[data-act="next"]');
  assert.equal(resultNext.disabled, false);
  assert.equal(resultNext.textContent, '准备');
  const clickNext = () => listeners.get('click')[0]({ target: { closest: (s) => s === '[data-act]' ? { dataset: { act: 'next' } } : null } });
  clickNext();
  assert.deepEqual(JSON.parse(JSON.stringify(ws.sent.at(-1))), { t: 'ready', ready: true, roundId: g.roundId, readyId: 'ready1' });
  assert.equal(elements.get('#btn-new').disabled, true);
  receive({ t: 'room', room: { ...room, host: false, running: false, seats: room.seats.map((s) => s.you ? { ...s, ready: true } : s) } });
  assert.equal(resultNext.textContent, '已准备（取消）');
  clickNext(); assert.equal(ws.sent.at(-1).ready, false);
  const waitingRoom = { ...room, running: false, allReady: false, seats: room.seats.map((s, i) => i === 1 ? { ...s, bot: false, ready: false } : s) };
  receive({ t: 'room', room: waitingRoom });
  assert.equal(resultNext.disabled, true); assert.equal(elements.get('#btn-new').disabled, true);
  const sentCount = ws.sent.length;
  elements.get('#btn-new').events.get('click')(); assert.equal(ws.sent.length, sentCount, '未准备时顶部入口也不能开局');
  assert.match(elements.get('#overlay').querySelector('[data-ready-status]').textContent, /准备/);
  receive({ t: 'room', room: { ...room, host: true, running: false } });
  assert.equal(elements.get('#overlay').querySelector('[data-act="next"]').disabled, false);
  assert.equal(elements.get('#btn-new').disabled, false);
  elements.get('#btn-new').events.get('click')();
  assert.equal(ws.sent.at(-1).t, 'next');
  clickAction('close');
  receive({ t: 'room', room: { ...room, roundNo: 2 } });
  assert.ok(elements.get('#overlay').classList.contains('hidden'));
  assert.ok(review.classList.contains('hidden'), '换局收起上一局牌面');

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
  online.events.get('change')({ target: { id: 'ol-mode2', value: 'classic' } });
  assert.deepEqual(JSON.parse(JSON.stringify(ws.sent.at(-1))), { t: 'config', config: { mode: 'classic' } });
  const configuredRoom = { ...finishedRoom, config: { mode: 'classic', totalRounds: 1 } };
  receive({ t: 'room', room: configuredRoom });
  assert.match(online.innerHTML, /data-act="start" >开启新的一桌/);
  assert.match(online.innerHTML, /累计分数继续保留/);
  online.events.get('change')({ target: { id: 'ol-difficulty2', value: 'hard' } });
  assert.deepEqual(JSON.parse(JSON.stringify(ws.sent.at(-1))), { t: 'config', config: { aiDifficulty: 'hard' } });
  online.events.get('change')({ target: { id: 'ol-botspeed2', value: 'slow' } });
  assert.deepEqual(JSON.parse(JSON.stringify(ws.sent.at(-1))), { t: 'config', config: { botSpeed: 'slow' } });
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
  assert.ok(doc.body.classList.contains('dealing-table'), '进入本地新局时开始发牌');
  assert.ok(animations.length >= 52, '手机四家手牌均有入场动画');
  assert.ok(animations.every((a) => a.options.duration === 300 && a.options.fill === 'backwards'));
  const openingCount = animations.length;
  previous.emitState();
  assert.equal(animations.length, openingCount, '同一手牌重复状态不重新发牌');
  for (let i = 0; i < 5; i++) previous.emit('message', `本地提示 ${i} <img src=x>`);
  assert.equal(notices.childElementCount, 3, '密集本地播报最多保留三条');
  assert.equal(notices.nodes.at(-1).textContent, '本地提示 4 <img src=x>');
  assert.equal(notices.nodes.at(-1).innerHTML, '');
  assert.equal(notices.nodes.at(-1).className, 'toast-item announce');
  assert.equal(previous.aiDifficulty, 'hard');
  assert.equal(previous.botSpeed, 'fast');
  assert.equal(previous.speed, ctx.GZAI.BOT_SPEEDS.fast.value);
  assert.ok(elements.get('#btn-chat').classList.contains('hidden'), '本地练习不展示联机聊天');
  elements.get('#btn-difficulty').events.get('click')();
  assert.equal(previous.aiDifficulty, 'easy');
  elements.get('#btn-speed').events.get('click')();
  assert.equal(previous.botSpeed, 'slow');
  assert.equal(elements.get('#btn-new').disabled, false);
  elements.get('#btn-new').events.get('click')();
  assert.notEqual(ctx.__game, previous);
  assert.equal(previous.phase, 'ended');
  assert.ok(animations.slice(0, openingCount).every((a) => a.cancelled), '换局清理旧发牌动画');
  assert.equal(ctx.__game.roundNo, previous.roundNo + 1);
  assert.equal(ctx.__game.aiDifficulty, 'easy');
  assert.equal(ctx.__game.botSpeed, 'slow');
  const local = ctx.__game;
  local.players.forEach((p) => { p.hand = [0,1,2,3,4,5,6,7,8,9,10,11,22]; p.melds = []; });
  local.awaiting = null; local.emitState();
  assert.doesNotMatch(seats[0].querySelector('.hand-main').innerHTML, /ting-tile/, '听牌候选不挤占手机手牌宽度');
  assert.match(elements.get('#ting-bar').innerHTML, /ting-tile/);
  assert.equal(elements.get('#ting-bar').classList.contains('hidden'), false);
  const riverY = (n) => parseFloat(stage.style[`--phone-river-${n}-y`]);
  const riverH = (n) => parseFloat(stage.style[`--phone-river-${n}-h`]);
  assert.ok(riverY(1) > riverY(2) + riverH(2) && riverY(3) > riverY(2) + riverH(2),
    '下家 / 上家牌河与对家牌河上下错开，不再连成一排');
  assert.ok(riverY(1) + riverH(1) <= stage.clientHeight - parseFloat(stage.style['--phone-hand-zone']),
    '候选条 / 操作区保留独立空间');
  local.players[0].hand.push(22);
  local.players[1].hand = [2,5,8,10,13,16,19,21,24,26,0,0,0,0];
  await local.doKong(1, 'angang', 0);
  local.settleWin([{ p:0, winTile:22 }], { selfDraw:true });
  ctx.GZUI.showResult(local.result);
  clickAction('close');
  assert.equal(review.classList.contains('hidden'), false, '本地胡牌也可查看四家');
  assert.match(review.innerHTML, /review-winner/);
  assert.equal((review.innerHTML.match(/data-tile=/g) || []).length, 54);
  clickAction('result');
  assert.match(elements.get('#overlay').innerHTML, /每位听牌者/);
  assert.match(elements.get('#overlay').innerHTML, /未听牌，向 .* 各赔 4 分/);
  const robHand = [0,1,2,3,4,5,6,7,8,9,10,11,22];
  const robbed = { ...local.result, robKong:true, winTile:22, winners:[{ ...local.result.winners[0], from:1 }] };
  local.players[1].hand = robHand.concat(22); local.players[1].melds = [];
  local.result = robbed;
  ctx.GZUI.showResult(robbed);
  clickAction('close');
  const sourceHand = review.innerHTML.split('<div class="review-hand">')[2].split('</div>\n')[0];
  assert.equal((sourceHand.match(/data-tile=/g) || []).length, 13, '抢杠者展示被抢后的剩余手牌');
  clickAction('close');
  ctx.GZUI.showLobby();
  assert.equal(doc.body.classList.contains('dealing-table'), false, '返回大厅清理开场状态');
  assert.ok(review.classList.contains('hidden'), '返回大厅收起牌面');
  ctx.__game.phase = 'ended';
});
