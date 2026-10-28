/* 3D 牌桌渲染层（three.js）
 * 只负责“桌子 + 牌 + 桌心面板”，HUD、按钮、弹层仍然是 DOM。
 * 坐标系：桌面中心 (0,0)，+X 向右，+Z 朝向自己（南），Y 向上，1 单位 ≈ 3cm。
 */
(function (root) {
  'use strict';
  const T = { w: 0.38, h: 0.51, t: 0.22 };          // 一张牌：宽 / 高 / 厚
  const TABLE = 9.0;                                 // 桌面边长
  const SEAT = [                                     // 0 南(自己) 1 东 2 北 3 西
    { x: 0, z: 4.05, ry: 0 },
    { x: 4.05, z: 0, ry: Math.PI / 2 },
    { x: 0, z: -4.05, ry: Math.PI },
    { x: -4.05, z: 0, ry: -Math.PI / 2 }
  ];
  const HAND_GAP = 0.02;                             // 手牌之间的缝
  const RIVER = { cols: 7, start: -1.05, meldShift: -0.32 };
  const PANEL = { w: 1.90, h: 0.15 };                // 桌心铭牌
  const MELD_Z = -0.58;                              // 副露那条道的深度
  const COMMON = { colors: {
    ivory: 0xf7f1e0, ivoryEdge: 0xe8ddc4, amber: 0xe0a044, amberDeep: 0xb87a2a,
    felt: 0x17365c, wood: 0x3a2418, brass: 0xc9a15c
  } };

  let renderer = null, scene = null, camera = null, canvas = null;
  let seatGroups = [], tileLayer = null, panelMesh = null, panelTex = null, panelCanvas = null;
  let assets = { face: {}, back: null };
  let pending = 0, ready = false, needsRender = false, running = false;
  let sig = '';
  let hoverTile = null, tipHandler = null, discardHandler = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  root.addEventListener('error', (e) => {
    root.__glError = `${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno || ''}`;
  });

  /* ---------------- 几何体 ---------------- */
  function roundedShape(w, h, r) {
    const s = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }

  let tileGeo = null, tileFrontZ = 0, tileHalfH = 0.36;
  function getTileGeo() {
    if (tileGeo) return tileGeo;
    const shape = roundedShape(T.w, T.h, 0.06);
    tileGeo = new THREE.ExtrudeGeometry(shape, {
      depth: T.t, bevelEnabled: true, bevelSegments: 2,
      bevelSize: 0.018, bevelThickness: 0.018, curveSegments: 4, steps: 1
    });
    tileGeo.center();
    tileGeo.computeBoundingBox();
    tileFrontZ = tileGeo.boundingBox.max.z;   // 半个厚
    tileHalfH = tileGeo.boundingBox.max.y;    // 半个高
    return tileGeo;
  }

  function ivoryMat() {
    return new THREE.MeshStandardMaterial({ color: 0xe6dabd, roughness: .52, metalness: 0 });
  }
  function amberMat() {
    return new THREE.MeshStandardMaterial({ color: COMMON.colors.amber, roughness: .5, metalness: 0 });
  }

  /* 一张牌：象牙牌身 + 正面的牌面（或牌背） */
  function makeTile(tileId, faceUp, tiltX) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(getTileGeo(), [ivoryMat(), ivoryMat()]);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    if (faceUp && assets.face[tileId]) {
      const mat = new THREE.MeshBasicMaterial({
        map: assets.face[tileId], transparent: true,
        polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(T.w * 0.94, T.h * 0.94), mat);
      plane.position.z = tileFrontZ + 0.004;
      g.add(plane);
    } else if (!faceUp) {
      // 牌背：琥珀底 + 内框，画在 -Z 一侧（对手牌背朝向镜头）
      const backMat = new THREE.MeshStandardMaterial({ color: 0xd2892f, roughness: .48, metalness: .04 });
      const back = new THREE.Mesh(new THREE.PlaneGeometry(T.w * 0.96, T.h * 0.96), backMat);
      back.position.z = -tileFrontZ - 0.004;
      back.rotation.y = Math.PI;
      g.add(back);
      const frameMat = new THREE.MeshStandardMaterial({ color: 0xf0c47a, roughness: .5, metalness: .08 });
      const frame = new THREE.Mesh(new THREE.PlaneGeometry(T.w * 0.70, T.h * 0.72), frameMat);
      frame.position.z = -tileFrontZ - 0.006;
      frame.rotation.y = Math.PI;
      g.add(frame);
      const inner = new THREE.Mesh(new THREE.PlaneGeometry(T.w * 0.60, T.h * 0.62), backMat);
      inner.position.z = -tileFrontZ - 0.008;
      inner.rotation.y = Math.PI;
      g.add(inner);
    }
    if (tiltX) g.rotation.x = tiltX;
    g.userData.tileId = tileId;
    return g;
  }

  /* ---------------- 桌面静态部分 ---------------- */
  function feltTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(512, 470, 60, 512, 512, 730);
    grd.addColorStop(0, '#173252');
    grd.addColorStop(.45, '#102742');
    grd.addColorStop(.78, '#091b30');
    grd.addColorStop(1, '#050e1b');
    g.fillStyle = grd;
    g.fillRect(0, 0, 1024, 1024);

    // 布纹
    g.globalAlpha = .012;
    for (let y = 0; y < 1024; y += 3) {
      g.fillStyle = y % 6 ? '#ffffff' : '#000000';
      g.fillRect(0, y, 1024, 1);
    }
    g.globalAlpha = .009;
    for (let x = 0; x < 1024; x += 3) {
      g.fillStyle = x % 6 ? '#000000' : '#ffffff';
      g.fillRect(x, 0, 1, 1024);
    }
    // 菱形导引线
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(150, 195, 245, .06)';
    g.lineWidth = 2;
    g.save();
    g.translate(512, 512);
    g.rotate(Math.PI / 4);
    g.strokeRect(-300, -300, 600, 600);
    g.strokeRect(-190, -190, 380, 380);
    g.restore();
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 8;
    return tex;
  }

  function buildTable() {
    const group = new THREE.Group();

    // 木框：略大于桌面，压住绒面边缘
    const rimMat = new THREE.MeshStandardMaterial({ color: COMMON.colors.wood, roughness: .72, metalness: .06 });
    const rim = new THREE.Mesh(new THREE.BoxGeometry(TABLE + 0.85, 0.62, TABLE + 0.85), rimMat);
    rim.position.y = -0.34;
    rim.castShadow = false;
    rim.receiveShadow = true;
    group.add(rim);

    // 铜色压条
    const brass = new THREE.MeshStandardMaterial({ color: COMMON.colors.brass, roughness: .42, metalness: .6 });
    const inlayW = TABLE + 0.30, inlayD = TABLE + 0.30, t = 0.06;
    [[0, (inlayD - t) / 2], [0, -(inlayD - t) / 2], [(inlayW - t) / 2, 0], [-(inlayW - t) / 2, 0]].forEach(([x, z]) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(x ? t : inlayW, 0.05, x ? inlayD : t), brass);
      bar.position.set(x, -0.012, z);
      group.add(bar);
    });

    // 绒面
    const feltMat = new THREE.MeshStandardMaterial({ map: feltTexture(), color: 0xffffff, roughness: .96, metalness: 0 });
    const felt = new THREE.Mesh(new THREE.BoxGeometry(TABLE, 0.16, TABLE), feltMat);
    felt.position.y = -0.08;
    felt.receiveShadow = true;
    group.add(felt);

    // 桌心铭牌：圆角方牌，跟桌子同向（不转 45°，否则文字是歪的）
    panelCanvas = document.createElement('canvas');
    panelCanvas.width = 512;
    panelCanvas.height = 512;
    panelTex = new THREE.CanvasTexture(panelCanvas);
    panelTex.encoding = THREE.sRGBEncoding;
    panelTex.anisotropy = 8;
    const plaqueGeo = new THREE.ExtrudeGeometry(roundedShape(PANEL.w, PANEL.w, 0.26), {
      depth: PANEL.h - 0.04, bevelEnabled: true, bevelSegments: 1,
      bevelSize: 0.02, bevelThickness: 0.02, steps: 1, curveSegments: 3
    });
    plaqueGeo.center();
    plaqueGeo.computeBoundingBox();
    const PH = plaqueGeo.boundingBox.max.z * 2;          // 实际厚度（含倒角）
    panelMesh = new THREE.Mesh(plaqueGeo, new THREE.MeshStandardMaterial({ color: 0x1b283d, roughness: .46, metalness: .5 }));
    panelMesh.rotation.x = -Math.PI / 2;
    panelMesh.position.y = PH / 2;
    panelMesh.castShadow = true;
    panelMesh.receiveShadow = true;
    group.add(panelMesh);
    const panelTop = new THREE.MeshBasicMaterial({
      map: panelTex, transparent: true, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2
    });
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(PANEL.w, PANEL.w), panelTop);
    cap.rotation.x = -Math.PI / 2;
    cap.position.y = PH + 0.003;
    group.add(cap);

    return group;
  }

  /* ---------------- 动态牌层 ---------------- */
  function clearGroup(g) {
    while (g.children.length) {
      const c = g.children.pop();
      c.traverse?.((n) => {
        if (n.geometry && n.geometry !== getTileGeo()) n.geometry.dispose();
        if (n.material && !Array.isArray(n.material)) n.material.dispose?.();
      });
    }
  }

  function seatLocal(sx, sz, ry, lx, lz) {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    return { x: sx + lx * cos + lz * sin, z: sz - lx * sin + lz * cos };
  }

  /** 立着的牌：底面贴桌面 */
  function standUp(tile, ry, p, lift) {
    tile.rotation.set(0, ry, 0);
    tile.position.set(p.x, tileHalfH + (lift || 0), p.z);
  }

  /** 自己那排：不立在桌上，而是整体后仰、牌面正对镜头 */
  function leanToCamera(tile, p, lift) {
    const a = -handLean();                       // 负角度 = 牌面转向镜头
    const k = Math.abs(a);
    const y = tileHalfH * Math.cos(k) + tileFrontZ * Math.sin(k);
    tile.rotation.set(a, 0, 0);
    tile.position.set(p.x, y + (lift || 0), p.z);
    tile.userData.restY = y + 0.004;
  }

  function handLean() {
    if (!camera) return 0;
    const dy = camera.position.y - tileHalfH;
    const dz = camera.position.z - SEAT[0].z;
    return Math.atan2(dy, dz);
  }

  /** 平放的牌（牌面朝上）：必须用 YXZ 顺序，先翻倒再转向，否则侧家/对家会立起来 */
  function layFlat(tile, ry, p, lift) {
    tile.rotation.order = 'YXZ';
    tile.rotation.set(-Math.PI / 2, ry, 0);
    tile.position.set(p.x, tileFrontZ + (lift || 0), p.z);
  }

  /** 自己那排手牌：摸到的牌单独空一格摆在最右边，不并进牌列 */
  function placeHand(seat, tiles, ctx, drawn) {
    const pitch = T.w + HAND_GAP;
    const main = tiles.slice();
    let hasDrawn = false;
    if (drawn != null && main.length > 1) {
      const i = main.indexOf(drawn);
      if (i >= 0) { main.splice(i, 1); hasDrawn = true; }
    }
    const gapExtra = hasDrawn ? 0.15 : 0;
    const items = hasDrawn ? main.concat([drawn]) : main;
    const span = items.length * pitch - HAND_GAP + gapExtra;
    items.forEach((id, i) => {
      const extra = hasDrawn && i === items.length - 1 ? gapExtra : 0;
      const lx = -span / 2 + i * pitch + T.w / 2 + extra;
      const p = seatLocal(seat.x, seat.z, seat.ry, lx, 0);
      const tile = makeTile(id, seat.id === 0, 0);
      if (seat.id === 0) leanToCamera(tile, p, 0.004);
      else standUp(tile, seat.ry, p, 0.004);
      if (seat.id === 0 && ctx.playable) {
        tile.userData.playable = true;
        tile.userData.sx = lx;
      }
      if (hasDrawn && i === items.length - 1) tile.userData.drawn = true;
      ctx.layer.add(tile);
      if (seat.id === 0) ctx.handTiles.push(tile);
    });
  }

  function placeBacks(seat, count, ctx) {
    const span = count * (T.w + HAND_GAP) - HAND_GAP;
    for (let i = 0; i < count; i++) {
      const lx = -span / 2 + i * (T.w + HAND_GAP) + T.w / 2;
      const p = seatLocal(seat.x, seat.z, seat.ry, lx, 0);
      const tile = makeTile(null, false, 0);
      standUp(tile, seat.ry, p, 0.004);
      ctx.layer.add(tile);
    }
  }

  /** 牌河：7 列，从靠手的这一排往桌心长；有副露时整体往里让一条道 */
  function placeRiver(seat, discards, ctx, meldCount) {
    const { cols, start, meldShift } = RIVER;
    const pitch = T.w + 0.05, rowPitch = T.h + 0.04;
    const z0 = meldCount ? start + meldShift : start;
    const maxRows = meldCount ? 3 : 4;
    discards.slice(0, cols * maxRows).forEach((id, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const lx = -((cols - 1) / 2) * pitch + col * pitch;
      const p = seatLocal(seat.x, seat.z, seat.ry, lx, z0 - row * rowPitch);
      const tile = makeTile(id, true, 0);
      layFlat(tile, seat.ry, p, 0);
      ctx.layer.add(tile);
    });
  }

  /** 副露：平摊在手内侧那一条道上，四家都能看见 */
  function placeMelds(seat, melds, ctx) {
    if (!melds.length) return;
    const MELD_GAP = 0.12, pitch = T.w + 0.02;
    const total = melds.reduce((s, m) => s + m.tiles.length * pitch, 0) + MELD_GAP * (melds.length - 1);
    let lx = -total / 2;
    melds.forEach((m) => {
      m.tiles.forEach((id) => {
        const p = seatLocal(seat.x, seat.z, seat.ry, lx, MELD_Z);
        const tile = makeTile(id, true, 0);
        layFlat(tile, seat.ry, p, 0.004);
        ctx.layer.add(tile);
        lx += pitch;
      });
      lx += MELD_GAP;
    });
  }

  /* ---------------- 桌心文字 ---------------- */
  function drawPanel(info) {
    if (!panelCanvas) return;
    const g = panelCanvas.getContext('2d');
    const W = 512, H = 512;                     // 逻辑坐标，画布按倍数放大
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, panelCanvas.width, panelCanvas.height);
    g.scale(panelCanvas.width / W, panelCanvas.height / H);
    const cx = W / 2, cy = H / 2;
    /** 一行字太长就缩字号，别挤出牌面 */
    const fitFont = (text, maxW, size, weight) => {
      let s = size;
      do {
        g.font = `${weight} ${s}px "Microsoft YaHei", sans-serif`;
        if (g.measureText(text).width <= maxW || s <= 16) break;
        s -= 1;
      } while (true);
    };

    // 牌面：圆角方，四周留一圈金属边
    const pad = 10, r = 74;
    roundRect(g, pad, pad, W - pad * 2, H - pad * 2, r);    const grd = g.createRadialGradient(cx, cy * 0.72, 30, cx, cy, 330);
    grd.addColorStop(0, '#223c60');
    grd.addColorStop(.55, '#132741');
    grd.addColorStop(1, '#0a1526');
    g.fillStyle = grd;
    g.fill();
    g.strokeStyle = 'rgba(243,206,131,.46)';
    g.lineWidth = 3;
    roundRect(g, pad + 6, pad + 6, W - (pad + 6) * 2, H - (pad + 6) * 2, r - 5);
    g.stroke();
    g.strokeStyle = 'rgba(160,195,240,.16)';
    g.lineWidth = 1.5;
    roundRect(g, pad + 20, pad + 20, W - (pad + 20) * 2, H - (pad + 20) * 2, r - 16);
    g.stroke();

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // 局数
    g.fillStyle = 'rgba(168,190,221,.92)';
    fitFont(info.round || '', 400, 34, '500');
    g.fillText(info.round || '', cx, cy - 156);
    // 牌墙剩余
    g.fillStyle = '#ffd98d';
    g.font = '700 156px "Microsoft YaHei", sans-serif';
    g.shadowColor = 'rgba(255,186,70,.35)';
    g.shadowBlur = 18;
    g.fillText(String(info.wall ?? ''), cx, cy - 6);
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(139,164,198,.9)';
    g.font = '500 30px "Microsoft YaHei", sans-serif';
    g.fillText('牌墙剩余', cx, cy + 92);
    // 轮到谁
    g.fillStyle = '#8fe3dc';
    const turn = info.turn || '';
    fitFont(turn, 430, 34, '500');
    g.fillText(turn, cx, cy + 164);
    panelTex.needsUpdate = true;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* ---------------- 同步游戏状态 ---------------- */
  function sync(game, view) {
    if (!ready || !game || !game.players || game.players.length !== 4) return;
    const snapshot = {
      hands: game.players.map((p) => (p.handCount != null ? p.handCount : p.hand.length)),
      hand0: game.players[0].hand.slice().sort((a, b) => a - b),
      discards: game.players.map((p) => p.discards.slice()),
      melds: game.players.map((p) => p.melds.map((m) => ({ type: m.type, tiles: m.tiles }))),
      playable: !!(game.awaiting && game.awaiting.kind === 'discard' && game.awaiting.player === 0 && !game.awaiting.auto),
      drawn: (game.awaiting && game.awaiting.kind === 'discard' && game.awaiting.player === 0
        && game.players[0].justDrawn != null) ? game.players[0].justDrawn : null,
      round: view && view.round,
      wall: view && view.wall,
      turn: view && view.turn
    };
    const next = JSON.stringify(snapshot);
    if (next === sig) return;
    const panelChanged = sig === '' || snapshot.round !== undefined;
    sig = next;

    clearGroup(tileLayer);
    const ctx = { layer: tileLayer, handTiles: [], playable: snapshot.playable };
    game.players.forEach((p, i) => {
      const seat = { id: i, x: SEAT[i].x, z: SEAT[i].z, ry: SEAT[i].ry };
      if (i === 0) placeHand(seat, snapshot.hand0, ctx, snapshot.drawn);
      else placeBacks(seat, snapshot.hands[i], ctx);
      placeRiver(seat, snapshot.discards[i], ctx, snapshot.melds[i].length);
      placeMelds(seat, snapshot.melds[i], ctx);
    });
    seatGroups = ctx.handTiles;
    if (panelChanged !== false) drawPanel(snapshot);
    needsRender = true;
  }

  /* ---------------- 交互 ---------------- */
  function pickTile(clientX, clientY) {
    if (!canvas || !seatGroups.length) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    scene.updateMatrixWorld();     // 刚重建的牌还没渲染过，矩阵是旧的
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(seatGroups, true);
    for (const h of hits) {
      let n = h.object;
      while (n && !n.userData.playable) n = n.parent;
      if (n && n.userData.playable) return n;
    }
    return null;
  }

  function onMove(e) {
    const node = pickTile(e.clientX, e.clientY);
    if (node !== hoverTile) {
      if (hoverTile) hoverTile.position.y = hoverTile.userData.restY ?? (tileHalfH + 0.004);
      hoverTile = node;
      if (hoverTile) hoverTile.position.y = (hoverTile.userData.restY ?? tileHalfH) + 0.09;
      needsRender = true;
    }
    if (node && tipHandler) tipHandler(node.userData.tileId, e.clientX, e.clientY);
    else if (!node && tipHandler) tipHandler(null, e.clientX, e.clientY);
  }

  function onDown(e) {
    const node = pickTile(e.clientX, e.clientY);
    if (node && discardHandler) discardHandler(node.userData.tileId);
  }

  /* ---------------- 初始化 ---------------- */
  function loadFaceTextures(done) {
    const DIRS = ['Man', 'Sou', 'Pin'];
    const jobs = [];
    let id = 0;
    const loader = new THREE.TextureLoader();
    const one = (src, cb) => {
      jobs.push(new Promise((resolve) => {
        loader.load(src, (tex) => { tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 4; cb(tex); resolve(); },
          undefined, () => resolve());
      }));
    };
    for (const d of DIRS) for (let r = 1; r <= 9; r++) {
      const key = id++;
      one(`assets/tiles/${d}${r}.svg`, (tex) => { assets.face[key] = tex; });
    }
    one('assets/tiles/Back.svg', (tex) => { assets.back = tex; });
    Promise.all(jobs).then(done);
  }

  /** 画布尺寸跟着容器走，避免拉伸变形 */
  function resize() {
    if (!renderer || !canvas) return;
    const w = canvas.clientWidth || 1200;
    const h = canvas.clientHeight || 740;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  }

  function init(canvasEl, opts) {
    if (renderer) { resize(); return true; }
    canvas = canvasEl;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) {
      return false;
    }
    renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    renderer.setSize(1200, 740, false);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.94;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(34, 1200 / 740, 0.1, 140);
    camera.position.set(0, 6.2, 10.6);     // 坐在桌边，往里坐一点：牌大一圈
    camera.lookAt(0, 0, 0.95);

    scene.add(new THREE.HemisphereLight(0x9dbce8, 0x050b14, 0.26));
    const key = new THREE.DirectionalLight(0xfff1dc, 1.28);
    key.position.set(3.2, 8.5, 4.4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -6.5;
    key.shadow.camera.right = 6.5;
    key.shadow.camera.top = 6.5;
    key.shadow.camera.bottom = -6.5;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 22;
    key.shadow.bias = -0.0012;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fb6e8, 0.26);
    fill.position.set(-5, 5, -6);
    scene.add(fill);
    const center = new THREE.PointLight(0xffe0b0, 0.20, 12, 2);
    center.position.set(0, 3.4, 1.2);
    scene.add(center);
    // 从自己背后打一点逆光，把牌从绒面上分出来
    const rim = new THREE.DirectionalLight(0xbfd6ff, 0.24);
    rim.position.set(-2.5, 3.2, 7.5);
    scene.add(rim);

    scene.add(buildTable());
    tileLayer = new THREE.Group();
    scene.add(tileLayer);

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerleave', () => {
      if (hoverTile) { hoverTile.position.y = hoverTile.userData.restY ?? (tileHalfH + 0.004); hoverTile = null; needsRender = true; }
    });

    getTileGeo();
    resize();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => resize()).observe(canvas);
    } else {
      root.addEventListener('resize', resize);
    }

    loadFaceTextures(() => { ready = true; needsRender = true; });
    start();
    return true;
  }

  function start() {
    if (running) return;
    running = true;
    const loop = () => {
      requestAnimationFrame(loop);
      if (!needsRender || !renderer) return;
      needsRender = false;
      renderer.render(scene, camera);
    };
    loop();
  }

  root.GZScene3D = {
    init,
    sync,
    drawPanel,
    invalidate() { needsRender = true; },
    onDiscard(fn) { discardHandler = fn; },
    onTip(fn) { tipHandler = fn; },
    get ready() { return ready; },
    get canvas() { return canvas; },
    debug() {
      const proj = (x, y, z) => {
        const v = new THREE.Vector3(x, y, z).project(camera);
        return [Math.round((v.x + 1) / 2 * canvas.clientWidth), Math.round((1 - v.y) / 2 * canvas.clientHeight)];
      };
      return {
        faces: Object.keys(assets.face).length, back: !!assets.back, ready,
        cam: camera.position.toArray().map((n) => +n.toFixed(2)),
        fov: camera.fov, aspect: +camera.aspect.toFixed(4),
        client: [canvas.clientWidth, canvas.clientHeight], buf: [canvas.width, canvas.height],
        handBase: proj(0, 0, 3.95), handTop: proj(0, 0.72, 3.95), panel: proj(0, 0.14, 0)
      };
    },
    pickAt(x, y) { const n = pickTile(x, y); return n ? n.userData.tileId : null; },
    /** 自己手牌右端在屏幕上的位置（听牌候选牌挂在这儿） */
    handEnd() {
      if (!canvas || !camera) return null;
      const last = seatGroups[seatGroups.length - 1];
      const x = last ? last.position.x + T.w / 2 + 0.10 : SEAT[0].x + 1.0;
      const z = last ? last.position.z : SEAT[0].z;
      const v = new THREE.Vector3(x, 0.02, z).project(camera);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    /** 某张手牌在屏幕上的位置（截图和自检用） */
    screenOf(tileId) {
      const t = seatGroups.find((n) => n.userData.tileId === tileId);
      if (!t || !canvas) return null;
      const v = new THREE.Vector3().copy(t.position).project(camera);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
