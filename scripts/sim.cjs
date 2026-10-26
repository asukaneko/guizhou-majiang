/* 临时压力测试：多局随机对局，检查异常与零和（不入库） */
const { Game } = require('../src/js/game.js');
const AI = require('../src/js/ai.js');

const stats = { rounds: 0, errors: 0, ting: 0, tianTing: 0, rob: 0, multi: 0, repao: 0, tianhu: 0, dihu: 0, baoting: 0, hu: 0, draw: 0 };

(async () => {
  const g = new Game({ speed: 90, dealer: 0 });
  g.on('error', (e) => { stats.errors++; console.error('ERR', e); });
  g.on('ting', (i) => { stats.ting++; if (i.tianTing) stats.tianTing++; });

  g.on('prompt', (a) => {
    setTimeout(() => {
      if (g.awaiting !== a) return;
      if (a.kind === 'claim') {
        if (a.options.includes('hu')) { g.humanRespond('hu'); return; }
        if (a.options.includes('peng') && Math.random() < 0.3) { g.humanRespond('peng'); return; }
        g.humanRespond('pass');
        return;
      }
      if (g.canTing(0) && Math.random() < 0.5) { g.humanTing(); return; }
      if (a.self && a.self.hu) { g.humanHu(); return; }
      if (a.self.angang.length && Math.random() < 0.6) { g.humanGang('angang', a.self.angang[0]); return; }
      if (a.self.bugang.length && Math.random() < 0.6) { g.humanGang('bugang', a.self.bugang[0]); return; }
      g.humanDiscard(AI.chooseDiscard(g.players[0].hand, g.players[0].melds));
    }, 0);
  });

  let resolveEnd = null;
  g.on('roundEnd', (res) => {
    if (!res.draw) {
      stats.hu++;
      if (res.winners.length > 1) stats.multi++;
      if (res.robKong) stats.rob++;
      for (const w of res.winners) {
        if (w.extra.some((x) => x.indexOf('热炮') === 0)) stats.repao++;
        if (w.extra.some((x) => x.indexOf('天胡') === 0)) stats.tianhu++;
        if (w.extra.some((x) => x.indexOf('地胡') === 0)) stats.dihu++;
        if (w.extra.some((x) => x.indexOf('报听') === 0 || x.indexOf('天听') === 0)) stats.baoting++;
      }
    } else stats.draw++;
    if (resolveEnd) { const r = resolveEnd; resolveEnd = null; r(); }
  });

  for (let i = 0; i < 200; i++) {
    const done = new Promise((r) => { resolveEnd = r; });
    g.startRound();
    await done;
    stats.rounds++;
    const total = g.scores.reduce((a, b) => a + b, 0);
    if (total !== 0) { stats.errors++; console.error('非零和', i, g.scores, g.result); }
    if (g.result && !g.result.draw) {
      const wsum = g.result.winDeltas.reduce((a, b) => a + b, 0);
      if (wsum !== 0) { stats.errors++; console.error('胡分非零和', i, g.result.winDeltas); }
      const csum = g.result.chickenDeltas.reduce((a, b) => a + b, 0);
      if (csum !== 0) { stats.errors++; console.error('鸡分非零和', i, g.result.chickenDeltas); }
    }
    g.nextDealer = (g.dealer + 1) % 4;
  }
  console.log(stats);
})();
