'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const R = require('../src/js/rules.js');
const AI = require('../src/js/ai.js');

test('房间界面：聊天入口可用，座位旋转后累计分对应正确，昵称按文字显示并保留准备与权限', () => {
  const listeners = {}, events = {}, sent = []; let toggled = 0, synced = 0;
  const node = { innerHTML:'', classList:{ add() {}, remove() {} }, addEventListener(name, fn) { events[name] = fn; } };
  const ctx = vm.createContext({
    document:{ querySelector:() => node }, location:{ protocol:'http:', host:'localhost' },
    GZRules:R, GZAI:AI, GZProfile:{ get:() => ({ name:'我' }) },
    GZNet:{ status:() => 'open', send:(m) => { sent.push(m); return true; }, on:(name, fn) => { listeners[name] = fn; } },
    GZUI:{ fit() {}, showOnlineRoom() {} }, GZChat:{ toggle() { toggled++; }, sync() { synced++; } }
  });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(require.resolve('../src/js/online.js'), 'utf8'), ctx);
  ctx.GZOnline.init({ onError() {}, onEnterGame() {} });
  const seats = [
    { uid:'host', name:'甲', seat:0, host:true, bot:false, you:false, ready:true },
    { uid:'bot', name:'阿贵', seat:1, host:false, bot:true, you:false, ready:true },
    { uid:'me', name:'<b>我</b>', seat:2, host:false, bot:false, you:true, ready:false },
    { uid:null, name:null, seat:3, host:false, bot:false, you:false, ready:false }
  ];
  const room = { id:'4321', host:false, running:false, roundNo:1, totalRounds:4, full:false, allReady:false,
    roundId:'round1', readyId:'ready1', config:{ mode:'classic', totalRounds:4, aiDifficulty:'hard', botSpeed:'normal' },
    standings:[12,-8,-4,0], seats };
  listeners.msg({ t:'joined', room });
  const cards = Array.from(node.innerHTML.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/g), (m) => m[1]);
  assert.equal(cards.length, 4);
  assert.match(cards[0], /&lt;b&gt;我&lt;\/b&gt;/); assert.doesNotMatch(cards[0], /<b>我<\/b>/);
  assert.match(cards[0], />-4<\/b>/); assert.match(cards[2], />\+12<\/b>/); assert.match(cards[3], />-8<\/b>/);
  assert.match(cards[1], /等待加入/); assert.match(node.innerHTML, /还差 1 位/);
  assert.match(node.innerHTML, /data-act="ready" >准备/);
  assert.doesNotMatch(node.innerHTML, /data-act="removebot"|data-act="addbot"/);
  assert.match(node.innerHTML, /id="ol-difficulty2" disabled/);
  assert.match(node.innerHTML, /id="ol-botspeed2" disabled/);
  events.click({ target:{ closest:() => ({ dataset:{ act:'chat' } }) } }); assert.equal(toggled, 1);
  events.click({ target:{ closest:() => ({ dataset:{ act:'ready' } }) } });
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { t:'ready', ready:true, roundId:'round1', readyId:'ready1' });
  listeners.msg({ t:'room', room:{ ...room, seats:seats.map((s) => s.you ? { ...s, ready:true } : s) } });
  assert.match(node.innerHTML, /已准备（取消）/); assert.ok(synced >= 2);
});
