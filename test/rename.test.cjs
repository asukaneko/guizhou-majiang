'use strict';
/* 房间内改名与「聊天未读同步到菜单」的客户端路径。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = (ctx, name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js', name), 'utf8'), ctx, { filename: name });

/* 只实现脚本用到的 DOM 子集，按选择器返回稳定的假节点。 */
function fakeDom() {
  const makeNode = (selector) => {
    const classes = new Set();
    const attrs = new Map();
    const node = {
      selector, innerHTML: '', textContent: '', title: '', value: '', disabled: false,
      scrollTop: 0, scrollHeight: 100, clientHeight: 100, dataset: {}, style: {}, className: '',
      children: [], __on: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, on) => { const next = on === undefined ? !classes.has(c) : !!on; if (next) classes.add(c); else classes.delete(c); return next; }
      },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
      addEventListener(type, fn) { (node.__on[type] ||= []).push(fn); },
      removeEventListener() {},
      append(...kids) { node.children.push(...kids); },
      appendChild(kid) { node.children.push(kid); return kid; },
      replaceChildren(...kids) { node.children = kids; },
      remove() {},
      get firstElementChild() { return node.children[0] || null; },
      get childElementCount() { return node.children.length; },
      focus() {}, select() {}, close() {}, showModal() {}, blur() {},
      querySelector: () => makeNode('nested'),
      querySelectorAll: () => [],
      closest: () => null,
      contains: () => false
    };
    return node;
  };
  const nodes = new Map();
  const bySelector = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, makeNode(selector));
    return nodes.get(selector);
  };
  return {
    bySelector,
    document: {
      querySelector: bySelector,
      querySelectorAll: () => [],
      createElement: () => makeNode('created'),
      addEventListener() {},
      body: bySelector('body'),
      documentElement: bySelector('html')
    }
  };
}

function onlineContext() {
  const { document, bySelector } = fakeDom();
  const handlers = { msg: [], status: [] };
  const sent = [], renamed = [];
  let status = 'open';
  const ctx = vm.createContext({
    document, console,
    GZRules: { MODE_ORDER: [], MODES: {} },
    GZAI: {
      DIFFICULTIES: { normal: { label: '普通', hint: '' } },
      BOT_SPEEDS: { normal: { label: '普通' } },
      difficultyOf: (x) => x, speedOf: (x) => x
    },
    GZProfile: { get: () => ({ name: '旧名字' }), rename: (n) => renamed.push(n) },
    GZNet: {
      on: (ev, fn) => handlers[ev].push(fn),
      send: (msg) => { if (status !== 'open') return false; sent.push(msg); return true; },
      status: () => status
    },
    location: { protocol: 'https:', host: 'example.test' },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false })
  });
  ctx.window = ctx;
  script(ctx, 'online.js');
  ctx.GZOnline.init({ onError() {}, onEnterGame() {} });
  return { ctx, bySelector, handlers, sent, renamed, setStatus: (s) => { status = s; } };
}

const roomState = () => ({
  id: '1234', host: true, running: false, roundNo: 0, totalRounds: 4, finished: false, full: false,
  readyId: 'r1', allReady: false, resetScoresOnNewTable: false, standings: [0, 0, 0, 0],
  config: { mode: 'classic', totalRounds: 4, aiDifficulty: 'normal', botSpeed: 'normal' },
  seats: [
    { uid: 'u1', seat: 0, name: '旧名字', bot: false, offline: false, host: true, ready: true, you: true },
    { uid: null, seat: 1, name: null, bot: false, offline: false, host: false, ready: false, you: false },
    { uid: null, seat: 2, name: null, bot: false, offline: false, host: false, ready: false, you: false },
    { uid: null, seat: 3, name: null, bot: false, offline: false, host: false, ready: false, you: false }
  ]
});

test('房间等待页：房主点自己座位的「改名」同样能发 hello 并写回本地昵称', () => {
  const env = onlineContext();
  for (const fn of env.handlers.msg) fn({ t: 'joined', room: roomState() });
  assert.ok(env.ctx.GZOnline.room, '已进房');
  assert.match(env.bySelector('#online').innerHTML, /data-act="rename"/, '房主自己座位也有改名牌');
  assert.ok(env.ctx.GZOnline.rename('  新名字  '));
  const last = env.sent.at(-1);
  assert.deepEqual({ t: last.t, name: last.name }, { t: 'hello', name: '新名字' }, '走 hello 协议同步昵称');
  assert.deepEqual(env.renamed, ['新名字']);
});

test('昵称去空格、截断 10 字，空昵称和断线时不发', () => {
  const env = onlineContext();
  for (const fn of env.handlers.msg) fn({ t: 'joined', room: roomState() });
  const before = env.sent.length;
  assert.equal(env.ctx.GZOnline.rename('   '), false);
  assert.equal(env.sent.length, before);
  assert.ok(env.ctx.GZOnline.rename('一二三四五六七八九十十一'));
  assert.equal(env.sent.at(-1).name.length, 10);
  env.setStatus('lost');
  const offlineCount = env.sent.length;
  assert.equal(env.ctx.GZOnline.rename('断线时'), false, '断线时不能改');
  assert.equal(env.sent.length, offlineCount);
});

test('聊天未读数字同步到菜单按钮和菜单读屏标签', () => {
  const { document, bySelector } = fakeDom();
  const handlers = { msg: [], status: [] };
  const ctx = vm.createContext({
    document, console,
    GZNet: { on: (ev, fn) => handlers[ev].push(fn), status: () => 'open', send: () => true },
    matchMedia: () => ({ matches: true }),
    innerWidth: 420, innerHeight: 800,
    screen: { orientation: { type: 'portrait-primary' } },
    addEventListener() {}
  });
  ctx.window = ctx;
  script(ctx, 'chat.js');
  ctx.GZChat.init();
  ctx.GZChat.setView('online', true);
  for (const fn of handlers.msg) fn({ t: 'joined', room: { id: '1234', seats: [{ uid: 'me', you: true }], roundNo: 0 } });
  for (const fn of handlers.msg) fn({ t: 'chat', roomId: '1234', message: { id: 'm1', uid: 'other', clientId: null, name: '甲', text: '在吗', at: Date.now() } });
  const badge = bySelector('#menu-unread');
  assert.equal(badge.textContent, '1', '菜单按钮显示未读数');
  assert.equal(badge.classList.contains('hidden'), false);
  assert.match(bySelector('#tb-menu-trigger').getAttribute('aria-label'), /未读/);
});
