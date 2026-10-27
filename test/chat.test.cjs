'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const WebSocket = require('ws');
const { Room } = require('../server/room.js');
const { OnlineGame } = require('../server/online-game.js');
const { createMahjongServer } = require('../server/index.js');
const fake = (uid) => ({ uid, name: uid, ws: { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } } });

test('房间聊天：由服务端确定发送者，只广播同房间，校验文字和 Unicode 字数并限制频率', () => {
  const a = fake('甲'), b = fake('乙'), stranger = fake('丙');
  const room = new Room('1234', a); room.add(b);
  const other = new Room('5678', stranger);
  assert.equal(room.chat(a.uid, '  <b>你好👋</b>\n 再来  ', 'c1').ok, true);
  const event = a.ws.sent.at(-1);
  assert.equal(event.t, 'chat'); assert.equal(event.roomId, room.id);
  assert.equal(event.message.text, '<b>你好👋</b> 再来');
  assert.equal(event.message.name, a.name); assert.equal(event.message.uid, a.uid);
  assert.equal(event.message.seat, 0); assert.equal(event.message.clientId, 'c1');
  assert.deepEqual(b.ws.sent.at(-1), event);
  assert.equal(stranger.ws.sent.length, 0); assert.equal(other.chatHistory.length, 0);
  assert.match(room.chat(a.uid, '太快').err, /太快/);
  assert.equal(room.chat(b.uid, '其他玩家可正常发送').ok, true);
  for (const text of [null, {}, 123, ' \n\t\u0000 ', '字'.repeat(201), '🀄'.repeat(201)]) {
    assert.equal(room.chat(a.uid, text).ok, false);
  }
  assert.equal(room.chat(a.uid, '文字', '<bad-id>').ok, false);
  assert.equal(room.chat(stranger.uid, '串房').ok, false);
  room.chatLastSent.delete(a.uid);
  assert.equal(room.chat(a.uid, '🀄'.repeat(200)).ok, true, '200 个四字节字符按 200 字接收');
  assert.equal(room.chatHistory.length, 3);
});

test('聊天记录：最多 100 条，原房间跨桌保留，移除会话清理限流状态', () => {
  const a = fake('甲'), room = new Room('1234', a, { speed: 100 });
  room.addBot(); room.addBot(); room.addBot(); room.config.totalRounds = 1;
  for (let i = 0; i < 125; i++) { room.chatLastSent.delete(a.uid); assert.equal(room.chat(a.uid, `消息${i}`).ok, true); }
  assert.equal(room.chatHistory.length, 100);
  assert.equal(room.chatHistory[0].text, '消息25');
  const lastId = room.chatHistory.at(-1).id;
  room.game = new OnlineGame({ mode: 'classic', totalRounds: 1 }); room.game.phase = 'ended';
  assert.equal(room.newTable(a.uid).ok, true); room.abort();
  assert.equal(room.chatHistory.at(-1).id, lastId);
  room.sendChatHistory(a.uid);
  assert.equal(a.ws.sent.at(-1).messages.length, 100);
  room.remove(a.uid);
  assert.equal(room.chatLastSent.has(a.uid), false);
});

async function client(url) {
  const ws = new WebSocket(url), messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  await once(ws, 'open');
  let cursor = 0;
  const c = { ws, messages, send: (message) => ws.send(JSON.stringify(message)) };
  c.next = async (type, predicate = () => true) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const i = messages.findIndex((m, i) => i >= cursor && m.t === type && predicate(m));
      if (i >= 0) { cursor = i + 1; return messages[i]; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`未收到 ${type}: ${JSON.stringify(messages.slice(-4))}`);
  };
  c.welcome = await c.next('welcome'); return c;
}
test('真实 WS 聊天：等待/对局均可发送，禁止串房和身份伪造，重连及新成员补发历史', async (t) => {
  const app = createMahjongServer({ gameOptions: { speed: 100 } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  const url = `ws://127.0.0.1:${app.server.address().port}`;
  const a = await client(url), b = await client(url), outsider = await client(url);
  a.send({ t: 'hello', name: '真实甲' }); await a.next('hello-ok');
  a.send({ t: 'create' }); const id = (await a.next('joined')).room.id;
  assert.deepEqual((await a.next('chat-history')).messages, []);
  outsider.send({ t: 'create' }); await outsider.next('joined'); await outsider.next('chat-history');
  a.send({ t: 'chat', roomId: '伪造房间', uid: outsider.welcome.uid, name: '伪造昵称', text: '开局前打招呼', clientId: 'first' });
  const first = (await a.next('chat')).message;
  assert.equal(first.uid, a.welcome.uid); assert.equal(first.name, '真实甲');
  b.send({ t: 'join', room: id }); await b.next('joined');
  assert.equal((await b.next('chat-history')).messages[0].id, first.id);
  a.send({ t: 'chat', text: '太快', clientId: 'fast' });
  assert.equal((await a.next('chat-error')).clientId, 'fast');
  a.send({ t: 'addbot' }); a.send({ t: 'addbot' }); await a.next('room', (m) => m.room.full);
  a.send({ t: 'start' }); await a.next('snapshot', (m) => m.snap.awaiting);
  b.send({ t: 'chat', text: '<img src=x onerror=alert(1)> 对局中也可聊天', clientId: 'second' });
  const second = (await a.next('chat')).message;
  assert.equal((await b.next('chat')).message.id, second.id);
  assert.equal(outsider.messages.some((m) => m.t === 'chat'), false);
  a.ws.terminate(); await b.next('room', (m) => m.room.seats[0].offline);
  const restored = await client(url);
  restored.send({ t: 'resume', token: a.welcome.resumeToken }); await restored.next('joined');
  assert.deepEqual((await restored.next('chat-history')).messages.map((m) => m.id), [first.id, second.id]);
  b.send({ t: 'sync' }); await b.next('room');
  assert.equal((await b.next('chat-history')).messages.length, 2);
  b.send({ t: 'leave' }); await b.next('left');
  b.send({ t: 'chat', text: '退房后发送' }); await b.next('error');
});

function browser({ coarse = false } = {}) {
  const elements = new Map(), listeners = {}, sent = []; let status = 'open';
  class Element {
    constructor() { this.nodes = []; this.events = {}; this.value = ''; this.scrollTop = 0; this.clientHeight = 200; this.textContent = ''; this.attributes = {}; const classes = new Set();
      this.classList = { add: (...xs) => xs.forEach((x) => classes.add(x)), remove: (...xs) => xs.forEach((x) => classes.delete(x)), contains: (x) => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) };
    }
    addEventListener(name, fn) { this.events[name] = fn; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...nodes) { nodes.forEach((node) => { node.parent = this; this.nodes.push(node); }); }
    replaceChildren(...nodes) { this.nodes = []; this.append(...nodes); }
    get childElementCount() { return this.nodes.length; }
    get firstElementChild() { return this.nodes[0]; }
    get scrollHeight() { return this.nodes.length * 60; }
    querySelector(selector) { return this.nodes.find((n) => n.className === selector.slice(1)) || null; }
    querySelectorAll() { return []; }
    remove() { if (this.parent) this.parent.nodes.splice(this.parent.nodes.indexOf(this), 1); }
    focus() { this.focused = true; }
    blur() { this.focused = false; }
  }
  const doc = { body: new Element(), documentElement: { style: { setProperty() {} } },
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); },
    createElement: () => new Element(), addEventListener: (name, fn) => { doc[name] = fn; } };
  const ctx = vm.createContext({ document: doc, innerWidth: coarse ? 390 : 1440, innerHeight: coarse ? 844 : 900,
    GZNet: { status: () => status, send(message) { if (status !== 'open') return false; sent.push(message); return true; }, on(ev, fn) { (listeners[ev] ||= []).push(fn); } },
    matchMedia: () => ({ matches: coarse }), addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); } });
  ctx.window = ctx;
  for (const file of ['viewport.js', 'chat.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8'), ctx, { filename: file });
  ctx.GZUI = { fit: () => ctx.GZViewport.layout() }; ctx.GZChat.init(); ctx.GZChat.setView('online');
  const receive = (msg) => listeners.msg.forEach((fn) => fn(msg));
  const joined = (id = '1234') => receive({ t: 'joined', room: { id, seats: [{ uid: 'me', you: true }] } });
  const message = (id, uid = 'other', extra = {}) => ({ id, uid, name: '<img src=x>', text: '<script>危险文字</script>🀄', at: 1, ...extra });
  return { ctx, doc, elements, sent, receive, joined, message, resize: () => listeners.resize.forEach((fn) => fn()),
    setStatus(next) { status = next; listeners.status.forEach((fn) => fn(next)); },
    click: () => elements.get('#btn-chat').events.click(),
    submit() { elements.get('#chat-form').events.submit({ preventDefault() {} }); } };
}

test('聊天网页：未读、纯文字渲染、重复消息去重、房间和牌桌共享记录、切房清理', () => {
  const b = browser(); const get = (id) => b.elements.get(id);
  assert.ok(get('#btn-chat').classList.contains('hidden'));
  b.joined(); b.receive({ t: 'chat-history', roomId: '1234', messages: [] });
  b.receive({ t: 'chat', roomId: '5678', message: b.message('foreign') });
  b.receive({ t: 'chat', roomId: '1234', message: b.message('1') });
  b.receive({ t: 'chat', roomId: '1234', message: b.message('1') });
  assert.equal(get('#chat-unread').textContent, '1');
  const row = get('#chat-messages').nodes[0];
  assert.equal(row.nodes[0].nodes[0].textContent, '<img src=x>');
  assert.equal(row.nodes[1].textContent, '<script>危险文字</script>🀄');
  b.click(); assert.ok(b.doc.body.classList.contains('chat-open')); assert.ok(get('#chat-input').focused);
  assert.ok(get('#chat-unread').classList.contains('hidden'));
  b.ctx.GZChat.setView('game', true); assert.equal(get('#chat-messages').nodes[0], row);
  b.ctx.GZChat.setView('online'); assert.ok(b.doc.body.classList.contains('chat-open'));
  get('#chat-input').value = '草稿'; b.ctx.GZChat.setView('lobby');
  assert.equal(get('#chat-input').value, '草稿'); assert.ok(get('#room-chat').classList.contains('hidden'));
  b.ctx.GZChat.setView('online'); b.joined('5678');
  assert.equal(get('#chat-input').value, ''); assert.equal(get('#chat-messages').nodes.length, 0);
  b.receive({ t: 'left' }); assert.ok(get('#btn-chat').classList.contains('hidden'));
});

test('聊天网页：确认后清草稿，错误和断网保留，重连历史确认，输入法及快捷短语可用', () => {
  const b = browser(); b.joined(); b.receive({ t: 'chat-history', roomId: '1234', messages: [] });
  const input = b.elements.get('#chat-input'); input.value = '你好';
  input.events.compositionstart(); b.submit(); assert.equal(b.sent.length, 0);
  input.events.compositionend(); b.submit();
  const first = b.sent.at(-1); assert.equal(first.text, '你好'); assert.equal(input.value, '你好');
  b.receive({ t: 'chat-history', roomId: '1234', messages: [] });
  b.submit(); assert.equal(b.sent.length, 1, '普通 sync 历史不得解除正在发送的状态');
  b.receive({ t: 'chat', roomId: '1234', message: b.message('1', 'me', { clientId: first.clientId, text: '你好' }) });
  assert.equal(input.value, '');
  input.value = '保留草稿'; b.submit(); const second = b.sent.at(-1);
  b.receive({ t: 'chat-error', roomId: '1234', clientId: second.clientId, err: '发送太快，请稍后再试' });
  assert.equal(input.value, '保留草稿'); assert.match(b.elements.get('#chat-status').textContent, /太快/);
  b.submit(); const third = b.sent.at(-1);
  b.setStatus('lost'); assert.ok(input.disabled); assert.equal(input.value, '保留草稿');
  b.setStatus('open'); b.joined();
  b.receive({ t: 'chat-history', roomId: '1234', messages: [b.message('3', 'me', { clientId: third.clientId })] });
  assert.equal(input.value, '');
  input.value = '🀄'.repeat(201); b.submit(); assert.match(b.elements.get('#chat-status').textContent, /200/);
  input.value = '普通草稿';
  b.elements.get('#chat-quick').events.click({ target: { closest: () => ({ dataset: { chatQuick: '大家好！' } }) } });
  assert.equal(b.sent.at(-1).text, '大家好！'); assert.equal(input.value, '普通草稿');
});

test('聊天网页：手机打开不自动弹键盘，竖拿聊天恢复正向，收起恢复横屏；Escape 仅关闭聊天', () => {
  const b = browser({ coarse: true }); b.joined();
  b.doc.body.classList.add('in-game'); b.ctx.GZChat.setView('game', true); b.ctx.GZViewport.layout();
  assert.ok(b.doc.body.classList.contains('rotate-game'));
  b.click(); assert.notEqual(b.elements.get('#chat-input').focused, true);
  assert.ok(b.doc.body.classList.contains('chat-portrait')); assert.equal(b.doc.body.classList.contains('rotate-game'), false);
  b.ctx.visualViewport = { width: 390, height: 280 }; b.ctx.GZViewport.layout();
  assert.equal(b.doc.body.classList.contains('rotate-game'), false, '软键盘缩小视口也保持聊天正向');
  b.ctx.screen = { orientation: { type: 'landscape-primary' } };
  b.ctx.innerWidth = 844; b.ctx.innerHeight = 390; b.resize();
  assert.equal(b.doc.body.classList.contains('chat-portrait'), false);
  b.ctx.screen.orientation.type = 'portrait-primary'; b.ctx.innerWidth = 390; b.ctx.innerHeight = 844; b.resize();
  assert.ok(b.doc.body.classList.contains('chat-portrait'));
  let stopped = false;
  delete b.ctx.visualViewport;
  b.doc.keydown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
  assert.ok(stopped); assert.equal(b.doc.body.classList.contains('chat-open'), false);
  assert.ok(b.doc.body.classList.contains('rotate-game'));
});

test('聊天网页：长记录限量，浏览旧消息时保留位置并可跳至新消息，短视口隐藏辅助提示', () => {
  const b = browser({ coarse: true }); b.joined();
  b.receive({ t: 'chat-history', roomId: '1234', messages: Array.from({ length: 105 }, (_, i) => b.message(String(i))) });
  const list = b.elements.get('#chat-messages');
  assert.equal(list.nodes.length, 100);
  b.click(); list.scrollTop = 300;
  b.receive({ t: 'chat', roomId: '1234', message: b.message('new') });
  assert.equal(list.nodes.length, 100); assert.equal(list.scrollTop, 300);
  const latest = b.elements.get('#chat-latest');
  assert.equal(latest.classList.contains('hidden'), false);
  latest.events.click(); assert.equal(list.scrollTop, list.scrollHeight);
  assert.ok(latest.classList.contains('hidden'));
  b.ctx.visualViewport = { width: 844, height: 160 }; b.ctx.GZViewport.layout();
  assert.ok(b.doc.body.classList.contains('chat-short'));
});

test('聊天网页：PC 对局右侧常驻且预留牌桌空间，窄屏使用聊天按钮，手机对局按按钮覆盖显示', () => {
  const b = browser(); b.joined(); b.ctx.GZChat.setView('game', true);
  assert.ok(b.doc.body.classList.contains('chat-docked'));
  assert.equal(b.elements.get('#room-chat').classList.contains('hidden'), false);
  assert.ok(b.elements.get('#btn-chat').classList.contains('hidden'));
  assert.equal(b.elements.get('#chat-input').focused, false, '常驻区域不抢走牌桌焦点');
  b.ctx.innerWidth = 800; b.resize();
  assert.equal(b.doc.body.classList.contains('chat-docked'), false);
  assert.ok(b.elements.get('#room-chat').classList.contains('hidden'));
  assert.equal(b.elements.get('#btn-chat').classList.contains('hidden'), false);
  b.ctx.innerWidth = 1440; b.resize(); assert.ok(b.doc.body.classList.contains('chat-docked'));
  b.ctx.GZChat.setView('game', false); assert.ok(b.elements.get('#room-chat').classList.contains('hidden'));
  const mobile = browser({ coarse: true }); mobile.joined(); mobile.ctx.GZChat.setView('game', true);
  assert.equal(mobile.doc.body.classList.contains('chat-docked'), false);
  assert.ok(mobile.elements.get('#room-chat').classList.contains('hidden'));
  mobile.click(); assert.equal(mobile.elements.get('#room-chat').classList.contains('hidden'), false);
});
