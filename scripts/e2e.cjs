/* 真实 HTTP/WS：双玩法各连打两局、恢复掉线座位，再在原房间配置并各开一局新桌。 */
'use strict';
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createMahjongServer } = require('../server/index.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function client(url) {
  const c = { ws: new WebSocket(url), messages: [], handled: new Set(), cursor: 0, auto: false };
  c.send = (msg) => c.ws.send(JSON.stringify(msg));
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()); c.messages.push(m);
    if (!c.auto || m.t !== 'snapshot' || !m.snap.awaiting || m.snap.awaiting.auto) return;
    const a = m.snap.awaiting;
    if (c.handled.has(a.id)) return;
    c.handled.add(a.id);
    let action;
    if (a.kind === 'claim') action = a.options.includes('hu') ? { type: 'claim', act: 'hu' } : { type: 'pass' };
    else if (a.self?.hu) action = { type: 'hu' };
    else if (a.self?.angang?.length) action = { type: 'gang', gangType: 'angang', tile: a.self.angang[0] };
    else {
      const me = m.snap.players[0];
      action = { type: 'discard', tile: me.hand.includes(me.justDrawn) ? me.justDrawn : me.hand[0] };
    }
    c.send({ t: 'action', action: { ...action, promptId: a.id } });
  });
  c.next = async (t, predicate = () => true) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const idx = c.messages.findIndex((m, i) => i >= c.cursor && m.t === t && predicate(m));
      if (idx >= 0) { c.cursor = idx + 1; return c.messages[idx]; }
      const err = c.messages.find((m, i) => i >= c.cursor && m.t === 'error');
      if (err) throw new Error(err.err);
      await wait(5);
    }
    throw new Error(`等待 ${t} 超时`);
  };
  await once(c.ws, 'open'); c.welcome = await c.next('welcome');
  return c;
}

(async () => {
  const app = createMahjongServer({ gameOptions: { speed: 100 } });
  try {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const url = `ws://127.0.0.1:${app.server.address().port}`;
    const tables = [];
    for (const mode of ['yitong', 'classic']) {
      const a = await client(url), b = await client(url);
      a.send({ t: 'hello', name: `${mode}甲` }); b.send({ t: 'hello', name: `${mode}乙` });
      a.send({ t: 'create', config: { mode, totalRounds: 2 } });
      const id = (await a.next('joined')).room.id;
      b.send({ t: 'join', room: id }); await b.next('joined');
      a.send({ t: 'addbot' }); a.send({ t: 'addbot' });
      await a.next('room', (m) => m.room.full);
      a.send({ t: 'start' }); await a.next('snapshot', (m) => m.snap.awaiting);
      tables.push({ mode, id, a, b });
    }
    // 第一桌掉线后恢复；第二桌仍在进行，避免仅验证单房顺序执行。
    const first = tables[0], originalUid = first.a.welcome.uid, token = first.a.welcome.resumeToken;
    first.a.ws.terminate();
    await first.b.next('room', (m) => m.room.seats[0].offline);
    const resumed = await client(url);
    resumed.send({ t: 'resume', token });
    assert.equal((await resumed.next('resumed')).uid, originalUid);
    await resumed.next('joined'); first.a = resumed;
    for (const table of tables) for (const c of [table.a, table.b]) { c.auto = true; c.send({ t: 'sync' }); }
    for (let round = 1; round <= 2; round++) {
      await Promise.all(tables.map(async (table) => {
        const done = await table.a.next('snapshot', (m) => m.snap.roundNo === round && m.snap.result);
        assert.equal(done.snap.mode, table.mode);
        assert.equal(done.snap.scores.reduce((a, b) => a + b, 0), 0);
        assert.ok(done.snap.players.slice(1).every((p) => !p.hand.length));
        if (round === 1) {
          const room = app.rooms.get(table.id);
          const nextDealer = room.game.nextDealer;
          const owner = room.hostUid === table.b.welcome.uid ? table.b : table.a;
          owner.send({ t: 'next' });
          const opening = await table.a.next('snapshot', (m) => m.snap.roundNo === 2 && m.snap.phase === 'dealing');
          assert.deepEqual(opening.snap.scores, done.snap.scores, '换局继承累计分');
          assert.equal(opening.snap.dealer, nextDealer, '换局继承下一庄家');
        }
        console.log(`  ${table.mode} 第 ${round} 局完成，累计分 ${done.snap.scores.join(', ')}`);
      }));
    }
    for (const table of tables) {
      for (const c of [table.a, table.b]) assert.deepEqual(c.messages.filter((m) => m.t === 'error'), []);
      const owner = app.rooms.get(table.id).hostUid === table.b.welcome.uid ? table.b : table.a;
      owner.send({ t: 'start' });
      await owner.next('error', (m) => m.err.includes('已打满'));
      const previous = app.rooms.get(table.id).game;
      const mode = table.mode === 'classic' ? 'yitong' : 'classic';
      const bot = app.rooms.get(table.id).seats.find((s) => s.bot);
      owner.send({ t: 'removebot', uid: bot.uid });
      for (const c of [table.a, table.b]) await c.next('room', (m) => !m.room.full && m.room.finished);
      owner.send({ t: 'config', config: { mode, totalRounds: 1 } });
      await owner.next('room', (m) => m.room.config.mode === mode && m.room.finished);
      owner.send({ t: 'addbot' }); await owner.next('room', (m) => m.room.full);
      owner.send({ t: 'newtable' });
      const opening = (await table.a.next('snapshot', (m) => m.snap.roundId !== previous.roundId && m.snap.phase === 'dealing')).snap;
      assert.equal(opening.roomId, table.id);
      assert.equal(opening.roundNo, 1);
      assert.equal(opening.totalRounds, 1);
      assert.equal(opening.mode, mode);
      assert.deepEqual(opening.scores, previous.scores, '原房新桌继承上一桌累计分');
      const done = (await table.a.next('snapshot', (m) => m.snap.roundId !== previous.roundId && m.snap.result)).snap;
      assert.equal(done.mode, mode);
      assert.equal(done.scores.reduce((a, b) => a + b, 0), 0);
      for (const c of [table.a, table.b]) {
        assert.deepEqual(c.messages.filter((m) => m.t === 'error').map((m) => m.err), c === owner ? ['已打满约定的 2 局，请在房间开启新的一桌'] : []);
      }
      console.log(`  房间 ${table.id} 原座位开启新桌，${mode} 第 1 局完成`);
    }
    console.log('E2E OK：并行双玩法、六局、断线恢复、换局、完桌配置及移除机器人、原房开新桌、分数零和、局数限制');
  } finally { await app.close(); }
})().catch((err) => { console.error('E2E FAIL:', err); process.exitCode = 1; });
