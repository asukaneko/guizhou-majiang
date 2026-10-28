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
  const SELF_HAND = { z: 4.8, scale: 1.25 };           // 自己的手牌靠近镜头，单独放大
  const RIVER = { cols: 7, start: -1.05, meldShift: -0.32 };
  const PANEL = { w: 1.90, h: 0.15 };                // 桌心铭牌
  const MELD_Z = -0.58;                              // 副露那条道的深度
  const COMMON = { colors: {
    ivory: 0xf7f1e0, ivoryEdge: 0xe8ddc4, amber: 0xe0a044, amberDeep: 0xb87a2a,
    felt: 0x17365c, wood: 0x3a2418, brass: 0xc9a15c
  } };
  const MOTION = { move: 210, draw: 260, discard: 360, meld: 280, hover: 32 };

  let renderer = null, scene = null, camera = null, canvas = null;
  let seatGroups = [], tileLayer = null, panelMesh = null, panelTex = null, panelCanvas = null;
  let assets = { face: {}, back: null };
  let ready = false, needsRender = false, frameId = 0, active = true;
  let sig = '';
  let hoverTile = null, pressedTile = null, discardPick = null, tipHandler = null, discardHandler = null, layoutHandler = null;
  let tiles = new Map(), previous = null, previousGame = null, latest = null;
  let pointerEvent = null, lastTime = null, lastFrameMoving = false;
  const pickLayer = new THREE.Group();
  const metrics = { frames: 0, activeFrames: 0, activeMs: 0, renderMs: 0 };
  const reducedMotion = root.matchMedia?.('(prefers-reduced-motion: reduce)');
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

  // 同款牌共享几何体和材质；状态更新只移动已有实体，避免反复编译/上传和回收。
  let tileMaterials = null, faceGeo = null, backParts = null, pickGeo = null;
  const faceMaterials = new Map();
  function tileAssets() {
    if (tileMaterials) return;
    const ivory = new THREE.MeshStandardMaterial({ color: 0xe6dabd, roughness: .52, metalness: 0 });
    tileMaterials = [ivory, ivory];
    faceGeo = new THREE.PlaneGeometry(T.w * .94, T.h * .94);
    pickGeo = new THREE.BoxGeometry(T.w + HAND_GAP, T.h + .08, T.t + .04);
    const back = new THREE.MeshStandardMaterial({ color: 0xd2892f, roughness: .48, metalness: .04 });
    const frame = new THREE.MeshStandardMaterial({ color: 0xf0c47a, roughness: .5, metalness: .08 });
    backParts = [[.96, .96, .004, back], [.70, .72, .006, frame], [.60, .62, .008, back]]
      .map(([w, h, z, material]) => ({ geometry: new THREE.PlaneGeometry(T.w * w, T.h * h), material, z }));
  }
  function appearance(tile, tileId, faceUp) {
    const key = faceUp ? `face:${tileId}` : 'back';
    if (tile.userData.appearance === key) return;
    while (tile.children.length > 1) tile.remove(tile.children[tile.children.length - 1]);
    if (faceUp && assets.face[tileId]) {
      if (!faceMaterials.has(tileId)) faceMaterials.set(tileId, new THREE.MeshBasicMaterial({
        map: assets.face[tileId], transparent: true,
        polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false
      }));
      const plane = new THREE.Mesh(faceGeo, faceMaterials.get(tileId));
      plane.position.z = tileFrontZ + .004;
      tile.add(plane);
    } else if (!faceUp) {
      for (const part of backParts) {
        const plane = new THREE.Mesh(part.geometry, part.material);
        plane.position.z = -tileFrontZ - part.z;
        plane.rotation.y = Math.PI;
        tile.add(plane);
      }
    }
    tile.userData.appearance = key;
    tile.userData.tileId = tileId;
  }

  /* 一张牌：象牙牌身 + 正面的牌面（或牌背） */
  function makeTile(tileId, faceUp, tiltX) {
    tileAssets();
    const g = new THREE.Group();
    const body = new THREE.Mesh(getTileGeo(), tileMaterials);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    appearance(g, tileId, faceUp);
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

    // 三侧木框；近侧敞开，让桌布铺到镜头下方。
    const rimMat = new THREE.MeshStandardMaterial({ color: COMMON.colors.wood, roughness: .72, metalness: .06 });
    const rimWidth = .425, rimCenter = (TABLE + rimWidth) / 2;
    [['far', TABLE + rimWidth * 2, rimWidth, 0, -rimCenter],
      ['left', rimWidth, TABLE, -rimCenter, 0],
      ['right', rimWidth, TABLE, rimCenter, 0]].forEach(([side, w, d, x, z]) => {
      const rim = new THREE.Mesh(new THREE.BoxGeometry(w, .62, d), rimMat);
      rim.name = `table-rim-${side}`;
      rim.position.set(x, -.34, z);
      rim.receiveShadow = true;
      group.add(rim);
    });

    // 铜色压条
    const brass = new THREE.MeshStandardMaterial({ color: COMMON.colors.brass, roughness: .42, metalness: .6 });
    const inlayW = TABLE + 0.30, inlayD = TABLE + 0.30, t = 0.06;
    [[0, -(inlayD - t) / 2], [(inlayW - t) / 2, 0], [-(inlayW - t) / 2, 0]].forEach(([x, z]) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(x ? t : inlayW, 0.05, x ? inlayD : t), brass);
      bar.position.set(x, -0.012, z);
      group.add(bar);
    });

    // 绒面
    const feltMat = new THREE.MeshStandardMaterial({ map: feltTexture(), color: 0xffffff, roughness: .96, metalness: 0 });
    const frontExtension = 3;
    const felt = new THREE.Mesh(new THREE.BoxGeometry(TABLE, .16, TABLE + frontExtension), feltMat);
    felt.name = 'table-felt';
    felt.position.set(0, -.08, frontExtension / 2);
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
  // 布局用轻量位姿描述，绘制实体由 reconcile 保留并平滑移动。
  function tileSpec(ctx, key, seat, zone, id, faceUp) {
    const spec = { key, seat: seat.id, zone, id, faceUp, scale: 1, position: new THREE.Vector3(), rotation: new THREE.Euler(), userData: {} };
    ctx.items.push(spec);
    return spec;
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
    const y = (tileHalfH * Math.cos(k) + tileFrontZ * Math.sin(k)) * tile.scale;
    tile.rotation.set(a, 0, 0);
    tile.position.set(p.x, y + (lift || 0), p.z);
    tile.userData.restY = y + 0.004;
  }

  function handLean() {
    if (!camera) return 0;
    const dy = camera.position.y - tileHalfH * SELF_HAND.scale;
    const dz = camera.position.z - SELF_HAND.z;
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
    const scale = SELF_HAND.scale, pitch = (T.w + HAND_GAP) * scale;
    const main = tiles.slice();
    let hasDrawn = false;
    if (drawn != null && main.length > 1) {
      const i = main.indexOf(drawn);
      if (i >= 0) { main.splice(i, 1); hasDrawn = true; }
    }
    const gapExtra = hasDrawn ? .15 * scale : 0;
    const items = hasDrawn ? main.concat([drawn]) : main;
    const span = items.length * pitch - HAND_GAP * scale + gapExtra;
    items.forEach((id, i) => {
      const extra = hasDrawn && i === items.length - 1 ? gapExtra : 0;
      const lx = -span / 2 + i * pitch + T.w * scale / 2 + extra;
      const p = seatLocal(seat.x, SELF_HAND.z, seat.ry, lx, 0);
      const occurrence = items.slice(0, i).filter((t) => t === id).length;
      const tile = tileSpec(ctx, `hand:0:${id}:${occurrence}`, seat, 'hand', id, true);
      tile.scale = scale;
      if (seat.id === 0) leanToCamera(tile, p, 0.004);
      else standUp(tile, seat.ry, p, 0.004);
      if (seat.id === 0 && ctx.playable) {
        tile.userData.playable = true;
        tile.userData.sx = lx;
      }
      if (hasDrawn && i === items.length - 1) tile.userData.drawn = true;
    });
  }

  function placeBacks(seat, count, ctx) {
    const span = count * (T.w + HAND_GAP) - HAND_GAP;
    for (let i = 0; i < count; i++) {
      const lx = -span / 2 + i * (T.w + HAND_GAP) + T.w / 2;
      const p = seatLocal(seat.x, seat.z, seat.ry, lx, 0);
      const tile = tileSpec(ctx, `hand:${seat.id}:${i}`, seat, 'hand', null, false);
      standUp(tile, seat.ry, p, 0.004);
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
      const tile = tileSpec(ctx, `river:${seat.id}:${i}:${id}`, seat, 'river', id, true);
      layFlat(tile, seat.ry, p, 0);
    });
  }

  /** 副露：平摊在手内侧那一条道上，四家都能看见 */
  function placeMelds(seat, melds, ctx) {
    if (!melds.length) return;
    const MELD_GAP = 0.12, pitch = T.w + 0.02;
    const total = melds.reduce((s, m) => s + m.tiles.length * pitch, 0) + MELD_GAP * (melds.length - 1);
    let lx = -total / 2;
    melds.forEach((m, mi) => {
      m.tiles.forEach((id, ti) => {
        const p = seatLocal(seat.x, seat.z, seat.ry, lx, MELD_Z);
        const tile = tileSpec(ctx, `meld:${seat.id}:${mi}:${ti}`, seat, 'meld', id, id != null);
        layFlat(tile, seat.ry, p, 0.004);
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
  function motionAllowed() { return active && !document.hidden && !reducedMotion?.matches; }

  function finishMotions() {
    for (const node of tiles.values()) {
      const d = node.userData;
      d.motion = null; d.hover = 0; d.hoverVelocity = 0;
      node.position.copy(d.targetPosition);
      node.quaternion.copy(d.targetQuaternion);
      node.scale.setScalar(d.targetScale);
      d.basePosition.copy(node.position);
    }
    lastTime = null;
    lastFrameMoving = false;
  }

  // 悬停用解析临界阻尼：60/120/144Hz 同一时刻的位置一致，反向时保留速度。
  function advance(now) {
    const dt = lastTime == null ? 0 : Math.max(0, (now - lastTime) / 1000);
    lastTime = now;
    if (pressedTile && (now >= pressedTile.userData.pressedUntil || !pressedTile.userData.playable)) pressedTile = null;
    let moving = false;
    for (const node of tiles.values()) {
      const d = node.userData, m = d.motion;
      if (m) {
        const t = Math.min(1, Math.max(0, (now - m.start) / m.duration));
        const ease = t * t * (3 - 2 * t);
        d.basePosition.lerpVectors(m.from, d.targetPosition, ease);
        d.basePosition.y += Math.sin(Math.PI * ease) * m.arc;
        node.quaternion.slerpQuaternions(m.rotation, d.targetQuaternion, ease);
        node.scale.setScalar(THREE.MathUtils.lerp(m.scale, d.targetScale, ease));
        if (t === 1) d.motion = null;
        else moving = true;
      }
      const target = d.playable ? (node === pressedTile ? .13 : node === hoverTile ? .10 : 0) : 0;
      if (reducedMotion?.matches) { d.hover = target; d.hoverVelocity = 0; }
      else {
        const error = d.hover - target, k = MOTION.hover;
        const v = d.hoverVelocity + k * error, decay = Math.exp(-k * dt);
        d.hover = target + (error + v * dt) * decay;
        d.hoverVelocity = (d.hoverVelocity - k * v * dt) * decay;
        if (Math.abs(d.hover - target) < .0001 && Math.abs(d.hoverVelocity) < .001) {
          d.hover = target; d.hoverVelocity = 0;
        } else moving = true;
      }
      node.position.copy(d.basePosition);
      node.position.y += d.hover;
      if (d.pick) {
        // 命中区跟随补位，但不跟随悬停上浮，避免边缘反复命中/失去命中。
        d.pick.position.copy(d.basePosition);
        d.pick.quaternion.copy(node.quaternion);
        d.pick.scale.copy(node.scale);
      }
    }
    return moving || !!pressedTile;
  }

  function targetPose(node, spec, now, animate, kind) {
    const d = node.userData, rotation = new THREE.Quaternion().setFromEuler(spec.rotation);
    const changed = !d.targetPosition || !d.targetPosition.equals(spec.position) ||
      1 - Math.abs(d.targetQuaternion.dot(rotation)) > 1e-8 || d.targetScale !== spec.scale;
    if (!changed) return; // 重复快照/轮次文字更新不能重启正在运行的动画。
    const from = kind === 'discard' || kind === 'meld' ? node.position.clone() : (d.basePosition || node.position).clone();
    if (kind === 'discard' || kind === 'meld') { d.hover = 0; d.hoverVelocity = 0; }
    d.targetPosition = spec.position.clone();
    d.targetQuaternion = rotation;
    d.targetScale = spec.scale;
    d.basePosition = from;
    if (animate) d.motion = {
      from: from.clone(), rotation: node.quaternion.clone(), scale: node.scale.x, start: now,
      duration: MOTION[kind], arc: kind === 'discard' ? .65 : kind === 'meld' ? .20 : kind === 'draw' ? .10 : 0
    };
    else {
      d.motion = null;
      d.basePosition.copy(spec.position);
      node.position.copy(spec.position);
      node.quaternion.copy(rotation);
      node.scale.setScalar(spec.scale);
    }
  }

  function reconcile(items, now, animate, snapshot) {
    const available = new Set(tiles.values()), next = new Map(), reserved = new Map();
    const keys = new Set(items.map((s) => s.key));
    const take = (test) => [...available].find(test);
    // 先保留打出去的实体，尤其是手里有重复牌时，必须从实际点击的那张起飞。
    if (animate) for (const spec of items) {
      if (spec.zone !== 'river' || tiles.has(spec.key) ||
          snapshot.discards[spec.seat].length <= previous.discards[spec.seat].length) continue;
      const match = (n) => n.userData.zone === 'hand' && n.userData.seat === spec.seat &&
        (spec.seat !== 0 || n.userData.tileId === spec.id);
      const picked = discardPick && now < discardPick.until ? discardPick.node : null;
      const source = available.has(picked) && match(picked) ? picked :
        [...available].reverse().find(match);
      if (source) { reserved.set(spec.key, source); available.delete(source); }
    }
    for (const spec of items) {
      let node = reserved.get(spec.key);
      if (!node) {
        const exact = tiles.get(spec.key);
        if (available.has(exact)) node = exact;
      }
      if (!node && spec.zone === 'hand') node = take((n) => n.userData.zone === 'hand' &&
        n.userData.seat === spec.seat && (spec.seat !== 0 || n.userData.tileId === spec.id));
      if (!node && spec.zone === 'meld') {
        // 碰/明杠可以接住尚未落桌的弃牌，其余实体来自自己的手牌。
        node = take((n) => n.userData.zone === 'river' && n.userData.tileId === spec.id && !keys.has(n.userData.key)) ||
          take((n) => n.userData.zone === 'hand' && n.userData.seat === spec.seat &&
            (spec.seat !== 0 || n.userData.tileId === spec.id));
      }
      const fresh = !node;
      if (fresh) {
        node = makeTile(spec.id, spec.faceUp, 0);
        node.position.copy(spec.position);
        node.quaternion.setFromEuler(spec.rotation);
        node.scale.setScalar(spec.scale);
        node.userData.hover = 0; node.userData.hoverVelocity = 0;
        tileLayer.add(node);
        if (animate && (spec.zone === 'hand' || spec.zone === 'river')) {
          const seat = SEAT[spec.seat];
          const origin = spec.zone === 'hand'
            ? seatLocal(spec.position.x, spec.position.z, seat.ry, .20, -.45)
            : seatLocal(seat.x, seat.z, seat.ry, 0, 0);
          node.position.set(origin.x, spec.zone === 'hand' ? spec.position.y + .10 : tileHalfH + .1, origin.z);
          if (spec.zone === 'river') node.rotation.set(0, seat.ry, 0);
        }
      }
      available.delete(node);
      const oldZone = node.userData.zone;
      const kind = spec.zone === 'river' && oldZone !== 'river' ? 'discard' :
        spec.zone === 'meld' && oldZone !== 'meld' ? 'meld' : fresh && spec.zone === 'hand' ? 'draw' : 'move';
      appearance(node, spec.id, spec.faceUp);
      Object.assign(node.userData, { key: spec.key, zone: spec.zone, seat: spec.seat,
        playable: !!spec.userData.playable, drawn: !!spec.userData.drawn });
      targetPose(node, spec, now, animate, kind);
      next.set(spec.key, node);
    }
    for (const node of available) {
      tileLayer.remove(node);
      if (node.userData.pick) pickLayer.remove(node.userData.pick);
    }
    tiles = next;
    seatGroups = [...tiles.values()].filter((n) => n.userData.zone === 'hand' && n.userData.seat === 0);
    for (const node of tiles.values()) {
      const d = node.userData;
      if (d.playable && !d.pick) {
        d.pick = new THREE.Mesh(pickGeo, tileMaterials[0]);
        d.pick.userData.tile = node;
      }
      if (d.pick) {
        if (d.playable) pickLayer.add(d.pick);
        else pickLayer.remove(d.pick);
      }
    }
    if (!seatGroups.includes(hoverTile) || !hoverTile?.userData.playable) setHover(null);
    if (!seatGroups.includes(pressedTile) || !pressedTile?.userData.playable) pressedTile = null;
    if (discardPick && (!seatGroups.includes(discardPick.node) || now >= discardPick.until)) discardPick = null;
    advance(now);
  }

  function sync(game, view) {
    if (!game || !game.players || game.players.length !== 4) return;
    latest = { game, view };
    if (!ready) return;
    const snapshot = {
      roundKey: game.state?.roundId || game.roundNo,
      phase: game.phase, seq: game.discardSeq || 0,
      hands: game.players.map((p) => (p.handCount != null ? p.handCount : p.hand.length)),
      hand0: game.players[0].hand.slice().sort((a, b) => a - b),
      discards: game.players.map((p) => p.discards.slice()),
      melds: game.players.map((p) => p.melds.map((m) => ({ type: m.type, tiles: m.tiles }))),
      playable: !!(game.awaiting && game.awaiting.kind === 'discard' && game.awaiting.player === 0 && !game.awaiting.auto),
      drawn: game.players[0].justDrawn ?? null,
      round: view && view.round,
      wall: view && view.wall,
      turn: view && view.turn
    };
    const next = JSON.stringify(snapshot);
    if (next === sig && previousGame === game) return;
    const sameRound = previous && previousGame === game && snapshot.roundKey === previous.roundKey &&
      snapshot.seq >= previous.seq && !(snapshot.phase === 'dealing' && previous.phase !== 'dealing');
    const animate = !!sameRound && snapshot.seq - previous.seq <= 1 && motionAllowed();
    const now = performance.now();
    if (sameRound) advance(now);
    else {
      tileLayer.clear(); pickLayer.clear(); tiles.clear();
      setHover(null); pressedTile = null; discardPick = null; lastTime = null;
      if (tipHandler) tipHandler(null, 0, 0);
    }
    const panelChanged = !previous || snapshot.round !== previous.round || snapshot.wall !== previous.wall || snapshot.turn !== previous.turn;
    sig = next;

    const ctx = { items: [], playable: snapshot.playable };
    game.players.forEach((p, i) => {
      const seat = { id: i, x: SEAT[i].x, z: SEAT[i].z, ry: SEAT[i].ry };
      if (i === 0) placeHand(seat, snapshot.hand0, ctx, snapshot.drawn);
      else placeBacks(seat, snapshot.hands[i], ctx);
      placeRiver(seat, snapshot.discards[i], ctx, snapshot.melds[i].length);
      placeMelds(seat, snapshot.melds[i], ctx);
    });
    reconcile(ctx.items, now, animate, snapshot);
    previous = snapshot; previousGame = game;
    if (panelChanged) drawPanel(snapshot);
    invalidate();
  }

  /* ---------------- 交互 ---------------- */
  function pickTile(clientX, clientY) {
    if (!canvas || !active || !pickLayer.children.length) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    pickLayer.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickLayer.children, false)[0];
    return hit ? hit.object.userData.tile : null;
  }

  function setHover(node) {
    if (node === hoverTile) return;
    // 按需绘制可能已静止数秒，先推进旧目标，再切换目标，不能把空闲时间算进新过渡。
    if (ready) advance(performance.now());
    hoverTile = node;
    if (canvas) canvas.style.cursor = node ? 'pointer' : '';
    if (!node && tipHandler) tipHandler(null, 0, 0);
    invalidate();
  }
  function onMove(e) {
    if (e.pointerType === 'touch') return;
    pointerEvent = { clientX: e.clientX, clientY: e.clientY };
    invalidate(); // 每帧最多拾取一次，合并高频鼠标事件。
  }

  function onDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (pressedTile) return;
    advance(performance.now());
    const node = pickTile(e.clientX, e.clientY);
    if (!node || !discardHandler) return;
    pressedTile = node;
    node.userData.pressedUntil = performance.now() + 1000;
    discardPick = { node, until: node.userData.pressedUntil };
    // 等服务端确认再迁移到牌河；拒绝/发送失败时不改变牌局，立即恢复可点。
    if (discardHandler(node.userData.tileId) === false) { pressedTile = null; discardPick = null; }
    invalidate();
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
    invalidate();
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
    camera.position.set(0, 8.2, 10.2);     // 抬高到约 43° 俯视，兼顾四家牌河与自己手牌
    camera.lookAt(0, 0, 1.25);

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
      pointerEvent = null;
      setHover(null);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { pointerEvent = null; setHover(null); pressedTile = null; finishMotions(); }
      else { lastTime = null; invalidate(); }
    });
    reducedMotion?.addEventListener?.('change', () => { finishMotions(); invalidate(); });

    getTileGeo();
    resize();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => resize()).observe(canvas);
    } else {
      root.addEventListener('resize', resize);
    }

    loadFaceTextures(() => {
      for (const texture of Object.values(assets.face)) renderer.initTexture?.(texture);
      ready = true;
      if (latest) sync(latest.game, latest.view);
      invalidate();
    });
    invalidate();
    return true;
  }

  let lastDrawTime = null;
  function invalidate() { needsRender = true; start(); }
  function start() {
    if (frameId || !renderer || !active || document.hidden) return;
    frameId = requestAnimationFrame(frame);
  }
  function frame(now) {
    frameId = 0;
    if (!active || document.hidden) return;
    const wasMoving = lastFrameMoving;
    let moving = advance(now);
    if (pointerEvent) {
      const e = pointerEvent; pointerEvent = null;
      const node = pickTile(e.clientX, e.clientY);
      setHover(node);
      if (node && tipHandler) tipHandler(node.userData.tileId, e.clientX, e.clientY);
      moving = moving || !!node;
    }
    if (needsRender || moving || wasMoving) {
      needsRender = false;
      const began = performance.now();
      renderer.render(scene, camera);
      metrics.renderMs = performance.now() - began;
      if (layoutHandler) layoutHandler();
      metrics.frames++;
      if (wasMoving && lastDrawTime != null) { metrics.activeFrames++; metrics.activeMs += now - lastDrawTime; }
      lastDrawTime = now;
    }
    lastFrameMoving = moving;
    if (moving || needsRender) start();
  }
  function setActive(value) {
    active = !!value;
    if (!active) {
      pointerEvent = null; pressedTile = null; discardPick = null; setHover(null); finishMotions();
    } else { lastTime = null; invalidate(); }
  }

  root.GZScene3D = {
    init,
    sync,
    drawPanel,
    invalidate,
    setActive,
    stats() { return { ...metrics, animating: lastFrameMoving }; },
    onDiscard(fn) { discardHandler = fn; },
    onTip(fn) { tipHandler = fn; },
    onLayout(fn) { layoutHandler = fn; },
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
        handBase: proj(0, 0, SELF_HAND.z), handTop: proj(0, .72 * SELF_HAND.scale, SELF_HAND.z), panel: proj(0, 0.14, 0)
      };
    },
    pickAt(x, y) { const n = pickTile(x, y); return n ? n.userData.tileId : null; },
    /** 自己手牌右端在屏幕上的位置（听牌候选牌挂在这儿） */
    handEnd() {
      if (!canvas || !camera) return null;
      const last = seatGroups[seatGroups.length - 1];
      const x = last ? last.position.x + T.w * last.scale.x / 2 + .10 : SEAT[0].x + 1.0;
      const z = last ? last.position.z : SELF_HAND.z;
      const v = new THREE.Vector3(x, 0.02, z).project(camera);
      const top = last ? new THREE.Vector3(0, tileHalfH, tileFrontZ + .004)
        .multiply(last.scale).applyQuaternion(last.quaternion).add(last.position).project(camera) : v;
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height,
        top: r.top + ((1 - top.y) / 2) * r.height };
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
