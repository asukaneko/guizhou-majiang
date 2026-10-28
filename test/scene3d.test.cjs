'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const THREE = require('../src/vendor/three.min.js');

// 使用项目实际的 Three.js 几何、相机、射线和四元数；仅替换 GPU/图片加载与时钟。
// 不启动浏览器，验证连续帧中的位置、实体生命周期和真实命中区域。
async function table({ reduced = false, beforeReady } = {}) {
  let now = 0, id = 0, renderer, picks = 0;
  const frames = new Map(), events = new Map(), documentEvents = new Map();
  const media = { matches: reduced, addEventListener(name, fn) { this.changed = fn; } };
  const context2d = new Proxy({
    createRadialGradient: () => ({ addColorStop() {} }), measureText: (s) => ({ width: s.length * 20 })
  }, { get: (target, key) => target[key] || (() => {}) });
  class Renderer {
    constructor() { renderer = this; this.shadowMap = {}; this.calls = 0; }
    setSize() {} setPixelRatio() {} initTexture() {}
    render(scene, camera) {
      scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
      this.scene = scene; this.camera = camera; this.calls++;
    }
  }
  class Raycaster extends THREE.Raycaster {
    intersectObjects(...args) { picks++; return super.intersectObjects(...args); }
  }
  const canvas = {
    style: {}, width: 1200, height: 740, clientWidth: 1200, clientHeight: 740,
    addEventListener: (name, fn) => events.set(name, fn),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 740 })
  };
  const ctx = vm.createContext({
    THREE: { ...THREE, WebGLRenderer: Renderer, Raycaster,
      TextureLoader: class { load(src, done) { done(new THREE.Texture()); } } },
    performance: { now: () => now }, devicePixelRatio: 1,
    matchMedia: () => media, addEventListener() {},
    requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; },
    document: { hidden: false, createElement: () => ({ getContext: () => context2d }),
      addEventListener: (name, fn) => documentEvents.set(name, fn) }
  });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(require.resolve('../src/js/scene3d.js'), 'utf8'), ctx);
  const api = ctx.GZScene3D;
  assert.equal(api.init(canvas), true);
  if (beforeReady) beforeReady(api);
  await new Promise(setImmediate);
  const h = {
    api, canvas, media, document: ctx.document,
    get now() { return now; }, get queued() { return frames.size; }, get picks() { return picks; },
    get renderer() { return renderer; },
    frame(time = now + 1000 / 60) {
      now = time;
      const callbacks = [...frames.values()]; frames.clear();
      for (const fn of callbacks) fn(now);
    },
    to(time, hz = 120) {
      const step = 1000 / hz;
      while (now + step < time - 1e-6) h.frame(now + step);
      h.frame(time);
    },
    drain() {
      for (let n = 0; frames.size && n < 150; n++) h.frame();
      assert.equal(frames.size, 0, '静止后应停止绘制');
    },
    sync(g, view = {}) { api.sync(g, view); },
    get nodes() {
      return renderer.scene?.children.find((n) => n.children.some((c) => c.userData.zone))?.children || [];
    },
    node(key) { return h.nodes.find((n) => n.userData.key === key); },
    point(node, y = 0) {
      renderer.scene.updateMatrixWorld(true);
      const v = node.localToWorld(new THREE.Vector3(0, y, 0)).project(renderer.camera);
      return { clientX: (v.x + 1) * 600, clientY: (1 - v.y) * 370 };
    },
    move(node, y = 0) { events.get('pointermove')({ ...h.point(node, y), pointerType: 'mouse' }); },
    down(node, button = 0) { events.get('pointerdown')({ ...h.point(node), button }); },
    leave() { events.get('pointerleave')(); },
    visibility(hidden) { ctx.document.hidden = hidden; documentEvents.get('visibilitychange')(); }
  };
  h.frame(0);
  return h;
}

function game(hand = [0, 0, 1, 2, 4, 5, 9, 10, 11, 18, 19, 20, 22, 26]) {
  return {
    phase: 'playing', roundNo: 1, discardSeq: 0,
    awaiting: { kind: 'discard', player: 0 },
    players: [0, 1, 2, 3].map((i) => ({ hand: i === 0 ? hand.slice() : [],
      ...(i ? { handCount: 13 } : {}), melds: [], discards: [], justDrawn: null }))
  };
}
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function discard(g, seat, tile) {
  const p = g.players[seat];
  if (seat === 0) p.hand.splice(p.hand.indexOf(tile), 1);
  else p.handCount--;
  p.discards.push(tile); p.justDrawn = null;
  g.lastDiscard = { p: seat, tile }; g.discardSeq++;
  g.awaiting = null;
}

test('3D：纹理就绪即使用最新状态；文字/可操作状态更新保留实体和共享材质，静止不空转', async () => {
  const g = game();
  const h = await table({ beforeReady(api) { api.sync(g, { turn: '我' }); } });
  assert.equal(h.nodes.length, 53);
  const saved = h.nodes.slice(), body = saved[0].children[0];
  for (const node of saved) {
    assert.equal(node.children[0].geometry, body.geometry);
    assert.equal(node.children[0].material, body.material);
  }
  for (let i = 0; i < 40; i++) h.sync(g, { turn: String(i), wall: 50 - i });
  assert.deepEqual(h.nodes, saved);
  h.drain();
  const count = h.api.stats().frames;
  h.to(h.now + 1000);
  assert.equal(h.api.stats().frames, count);
  assert.equal(h.api.stats().animating, false);
});

test('3D：悬停连续上浮、快速换牌/离开平滑回落，命中区不随上浮抖动且鼠标事件每帧合并', async () => {
  const g = game(), h = await table(); h.sync(g); h.drain();
  const a = h.node('hand:0:9:0'), b = h.node('hand:0:10:0');
  const rest = a.position.y;
  const edge = h.point(a, -.20);
  const oldPicks = h.picks;
  for (let i = 0; i < 100; i++) h.move(a);
  assert.equal(h.picks, oldPicks);
  h.frame(); assert.equal(h.picks, oldPicks + 1);
  const start = h.now;
  h.frame(start + 16);
  assert.ok(a.position.y > rest && a.position.y < rest + .1);
  h.to(start + 120);
  assert.equal(h.api.pickAt(edge.clientX, edge.clientY), 9, '上浮不能导致静止指针失去命中');
  const before = a.position.y;
  h.move(b);
  near(a.position.y, before, 1e-10);
  h.frame(h.now); near(a.position.y, before);
  h.frame(h.now + 16);
  assert.ok(a.position.y > rest && b.position.y > b.userData.targetPosition.y);
  const identity = b;
  h.sync(g, { turn: '轮到你' });
  assert.equal(h.node('hand:0:10:0'), identity);
  const y = b.position.y;
  h.leave(); near(b.position.y, y);
  h.drain(); near(a.position.y, rest); near(b.position.y, b.userData.targetPosition.y);
});

test('3D：点击的重复牌从当前位置飞入牌河，手牌补位；中途快照不会重启动画', async () => {
  const g = game(), h = await table(); h.sync(g); h.drain();
  const clicked = h.node('hand:0:0:1'), kept = h.node('hand:0:0:0');
  const original = clicked.position.clone();
  let sends = 0;
  h.api.onDiscard(() => {
    sends++;
    // 本地和联机都可能先关闭操作提示，下一条状态才真正打出牌。
    g.awaiting = null; h.sync(g); return true;
  });
  h.down(clicked, 2); assert.equal(sends, 0);
  h.down(clicked); assert.equal(sends, 1);
  discard(g, 0, 0); h.sync(g);
  const river = h.node('river:0:0:0');
  assert.equal(river, clicked);
  assert.equal(h.node('hand:0:0:0'), kept);
  near(river.position.distanceTo(original), 0);
  const barPositions = [];
  h.api.onLayout(() => barPositions.push(h.api.handEnd().x));
  const m = river.userData.motion, from = h.now;
  h.to(from + 120);
  assert.ok(river.position.z < original.z && river.position.z > river.userData.targetPosition.z);
  assert.ok(river.position.y > Math.min(original.y, river.userData.targetPosition.y) + .2);
  assert.ok(river.quaternion.angleTo(river.userData.targetQuaternion) > .01);
  h.sync(g, { turn: '等待其他玩家' }); assert.equal(river.userData.motion, m);
  h.to(from + 360);
  near(river.position.distanceTo(river.userData.targetPosition), 0);
  near(river.quaternion.angleTo(river.userData.targetQuaternion), 0);
  h.drain();
  assert.equal(h.nodes.length, 53);
  assert.ok(h.api.stats().activeFrames > 20, '出牌必须经过多帧实际绘制');
  assert.ok(new Set(barPositions.map((x) => x.toFixed(3))).size > 3, '听牌条随手牌补位逐帧定位');
});

test('3D：长时间静止后离开/点击仍从当前姿态过渡，未确认的点击不会提前出牌或重复发送', async () => {
  const g = game(), h = await table(); h.sync(g); h.drain();
  const node = h.node('hand:0:9:0'); h.move(node); h.drain();
  h.to(h.now + 5000);
  const y = node.position.y;
  h.leave(); near(node.position.y, y);
  h.frame(h.now + 8);
  assert.ok(node.position.y < y && node.position.y > node.userData.targetPosition.y);
  h.drain(); h.to(h.now + 5000);
  let sends = 0; h.api.onDiscard(() => { sends++; return true; });
  const rest = node.position.y;
  h.down(node); h.down(node); assert.equal(sends, 1);
  near(node.position.y, rest);
  h.frame(h.now + 8);
  assert.ok(node.position.y > rest && node.position.y < rest + .13);
  assert.equal(h.nodes.filter((n) => n.userData.zone === 'river').length, 0);
  h.drain();
  h.down(node); assert.equal(sends, 2, '超时后恢复重试，不依赖网络再次触发状态更新');
});

test('3D：对手出牌由牌背翻成牌面；碰牌接住飞行中的弃牌并继续移动到副露', async () => {
  const g = game(), h = await table(); h.sync(g); h.drain();
  const opponent = h.node('hand:1:12');
  discard(g, 1, 0); h.sync(g);
  assert.equal(h.node('river:1:0:0'), opponent);
  assert.equal(opponent.userData.appearance, 'face:0');
  h.to(h.now + 100);
  const midair = opponent.position.clone();
  g.players[1].discards = [];
  g.players[0].hand.splice(0, 2);
  g.players[0].melds.push({ type: 'peng', tiles: [0, 0, 0] });
  g.lastDiscard = null;
  h.sync(g);
  assert.equal(h.node('meld:0:0:0'), opponent);
  near(opponent.position.distanceTo(midair), 0);
  h.drain();
  near(opponent.position.distanceTo(opponent.userData.targetPosition), 0);
  assert.equal(h.nodes.filter((n) => n.userData.zone === 'meld').length, 3);
  assert.equal(h.nodes.filter((n) => n.userData.zone === 'river').length, 0);
});

test('3D：摸到的牌在操作提示到达前就留在右端，提示切换不重新插入/跳位', async () => {
  const g = game(); g.players[0].hand.pop();
  g.awaiting = null;
  const h = await table(); h.sync(g); h.drain();
  g.players[0].hand.push(3); g.players[0].justDrawn = 3;
  h.sync(g);
  const drawn = h.node('hand:0:3:0');
  assert.equal(drawn.userData.drawn, true);
  assert.ok(drawn.userData.targetPosition.x > h.node('hand:0:22:0').userData.targetPosition.x);
  h.to(h.now + 80);
  const motion = drawn.userData.motion, pos = drawn.position.clone();
  g.awaiting = { kind: 'discard', player: 0 }; h.sync(g);
  assert.equal(h.node('hand:0:3:0'), drawn);
  assert.equal(drawn.userData.motion, motion);
  near(drawn.position.distanceTo(pos), 0);
  h.drain();
});

test('3D：换局、换游戏、断线补快照不会播放旧动作；离开牌桌和后台清理过渡', async () => {
  const g = game(), h = await table(); h.sync(g); h.drain();
  discard(g, 2, 5); h.sync(g); h.to(h.now + 80);
  assert.ok(h.node('river:2:0:5').userData.motion);
  h.visibility(true);
  assert.equal(h.node('river:2:0:5').userData.motion, null);
  h.frame(); assert.equal(h.queued, 0);
  h.visibility(false); h.drain();
  g.discardSeq += 5; g.players[3].discards.push(1, 2); h.sync(g);
  assert.ok(h.nodes.every((n) => !n.userData.motion));
  const old = h.nodes[0];
  g.roundNo++; g.discardSeq = 0;
  for (const p of g.players) p.discards = [];
  h.sync(g); assert.ok(!h.nodes.includes(old));
  h.api.setActive(false); h.frame();
  const count = h.api.stats().frames;
  discard(g, 2, 6); h.sync(g);
  h.to(h.now + 400); assert.equal(h.api.stats().frames, count);
  assert.ok(h.nodes.every((n) => !n.userData.motion));
  h.api.setActive(true); h.drain();
  const oldGame = h.nodes[0]; h.sync(game());
  assert.ok(!h.nodes.includes(oldGame));
});

test('3D：减少动态效果直接落到正确状态；出牌发送失败可立即重试且不移动到牌河', async () => {
  const g = game(), h = await table({ reduced: true }); h.sync(g); h.drain();
  let sends = 0; h.api.onDiscard(() => { sends++; return false; });
  const hand = h.node('hand:0:9:0');
  h.down(hand); h.down(hand); assert.equal(sends, 2);
  assert.equal(h.nodes.filter((n) => n.userData.zone === 'river').length, 0);
  h.move(hand); h.drain();
  near(hand.position.y - hand.userData.targetPosition.y, .1);
  discard(g, 0, 9); h.sync(g); h.drain();
  assert.ok(h.nodes.every((n) => !n.userData.motion));
  near(h.node('river:0:0:9').position.distanceTo(h.node('river:0:0:9').userData.targetPosition), 0);
});

test('3D：60/120/144Hz 和不均匀帧间隔在同一时刻得到相同悬停与出牌位置', async () => {
  const poses = [];
  for (const hz of [60, 120, 144, 0]) {
    const g = game(), h = await table(); h.sync(g); h.drain();
    const node = h.node('hand:0:9:0'); h.move(node); h.frame(h.now);
    const start = h.now;
    if (hz) h.to(start + 120, hz);
    else for (const delta of [7, 31, 40, 76, 120]) h.frame(start + delta);
    const hover = node.position.y;
    discard(g, 0, 9); h.sync(g);
    if (hz) h.to(start + 300, hz);
    else for (const delta of [131, 170, 181, 260, 300]) h.frame(start + delta);
    poses.push({ hover, position: h.node('river:0:0:9').position.clone() });
  }
  for (const pose of poses.slice(1)) {
    near(pose.hover, poses[0].hover);
    near(pose.position.distanceTo(poses[0].position), 0);
  }
});
