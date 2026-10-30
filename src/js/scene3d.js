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
  const SELF_HAND = { z: 4.8, zMobile: 4.05, scale: 1.25, scaleMobile: 1.45 };  // 自己手牌单独放大
  let selfHandZ = SELF_HAND.z;                               // 手机上挪到绒面上，近侧木框让出画面
  let selfHandScale = SELF_HAND.scale;                       // 手机上再放大一档
  let selfMeldZ = -0.58;                                     // 自己副露的深度（跟着手牌大小走，resize 时改成 MELD_Z / MELD_Z_SELF_MOBILE）
  // 机位：约 43° 俯视；宽扁屏（手机横屏）按内容包围盒自动拉远，保证四家牌河与手牌都在画面内
  const CAM = { lookZ: 1.25, lookZMobile: 0.85, up: 8.2, back: 8.95, backMobile: 8.95, fov: 34,
    dist: Math.hypot(8.2, 8.95) };
  // 取景包围盒：hard 必须完整在画面内（四家手牌、牌河、桌心），soft 是远侧木框外沿，允许被顶部信息牌盖住
  // 自己手牌的点跟着 selfHandZ 变（手机上挪到桌内），所以取景时动态生成
  const fitHard = () => [
    [-4.50, 0.02, -4.50], [4.50, 0.02, -4.50], [-4.50, 0.02, 4.50], [4.50, 0.02, 4.50],
    [-4.55, 0.02, 0], [4.55, 0.02, 0], [0, 1.05, 0],
    [-3.0, 0.02, selfMeldZ], [3.0, 0.02, selfMeldZ],        // 自己副露那一条也要在画面里
    [-2.62, 0.56, -4.05], [2.62, 0.56, -4.05], [0, 0.56, -4.05],
    [-4.05, 0.56, 2.6], [4.05, 0.56, 2.6], [-4.05, 0.56, -2.6], [4.05, 0.56, -2.6],
    [-3.0 * selfHandScale, 0.04, selfHandZ + 0.15], [3.0 * selfHandScale, 0.04, selfHandZ + 0.15],
    [0, 0.736 * selfHandScale, selfHandZ + 0.1], [0, 0.02, selfHandZ + 0.15]
  ];
  const FIT_SOFT = [
    [-5.50, 0.04, -5.45], [5.50, 0.04, -5.45], [0, 0.04, -5.45],
    [-5.55, 0.12, -5.45], [5.55, 0.12, -5.45]
  ];
  const RIVER = { cols: 7, start: -1.05, meldShift: -0.32, meldGapSelfMobile: 0.52, rowsSelfMobile: 2 };
  const PANEL = { w: 1.90, h: 0.15 };                // 桌心铭牌
  const MELD_Z = -0.58;                              // 副露那条道的深度
  const MELD_Z_SELF_MOBILE = -0.55;                  // 手机兜底值；实际深度按手牌遮挡阴影动态算（selfMeldDepth）
  const COMMON = { colors: {
    ivory: 0xf7f1e0, ivoryEdge: 0xe8ddc4, amber: 0xe0a044, amberDeep: 0xb87a2a,
    felt: 0x17365c, wood: 0x3a2418, brass: 0xc9a15c
  } };
  const MOTION = { move: 210, draw: 260, discard: 360, meld: 280, deal: 300, hover: 32 };
  const TURN_LIGHT = { inset: .11, radius: .22, period: 2400, travel: 420, fade: 180 };
  // 木框：内沿贴绒面（TABLE/2），近侧敞开并铺到镜头前，三面连续、远侧两角圆润
  const FRAME = {
    half: TABLE / 2, band: 0.98, front: 6.95,
    ri: 0.30, rf: 0.18,
    base: -0.62, height: 0.72
  };
  FRAME.ro = FRAME.ri + FRAME.band;                  // 内外圆角共心
  // 扶手分层：金护条 / 暗槽 / 皮质扶手 / 车线 / 外侧木边（偏移量相对绒面边界）
  const RAIL_LAYERS = {
    guard: [0, .16], groove: [.16, .19], pipeIn: [.19, .235],
    pad: [.235, .79], pipeOut: [.79, .835],
    seamA: [.39, .412], seamB: [.615, .637]
  };

  let renderer = null, scene = null, camera = null, canvas = null;
  let seatGroups = [], tileLayer = null, panelMesh = null, panelTex = null, panelCanvas = null;
  let assets = { face: {}, back: null };
  let ready = false, needsRender = false, frameId = 0, active = true;
  let sig = '';
  let hoverTile = null, pressedTile = null, discardPick = null, tipHandler = null, discardHandler = null, layoutHandler = null, readyHandler = null, kongHandler = null;
  let deal = null, lastDealId = 0;
  let tiles = new Map(), previous = null, previousGame = null, latest = null;
  let pointerEvent = null, lastTime = null, lastFrameMoving = false, lastPointerDown = -1e9;
  const pickLayer = new THREE.Group();
  const metrics = { frames: 0, activeFrames: 0, activeMs: 0, renderMs: 0 };
  let turnLight = null, shadowsDirty = true;
  const lamp = { seat: -1, head: 0, target: 0, alpha: 0, targetAlpha: 0, move: null, fade: null };
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

  /* 木纹：底色 + 长年轮 + 细孔，贴在木框上，避免大面积纯色塑料感 */
  function woodTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#2a1a11';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 300; i++) {
      const y = Math.random() * 512, w = .5 + Math.random() * 2.6;
      const dark = 8 + Math.random() * 54;
      g.strokeStyle = `rgba(${dark | 0}, ${(dark * .5) | 0}, ${(dark * .28) | 0}, ${.1 + Math.random() * .3})`;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(y, -12);
      g.bezierCurveTo(y + (Math.random() - .5) * 16, 160, y + (Math.random() - .5) * 16, 348, y + (Math.random() - .5) * 9, 524);
      g.stroke();
    }
    for (let i = 0; i < 150; i++) {
      const y = Math.random() * 512;
      g.strokeStyle = `rgba(${150 + Math.random() * 60 | 0}, ${108 + Math.random() * 40 | 0}, ${70 + Math.random() * 26 | 0}, ${.05 + Math.random() * .12})`;
      g.lineWidth = .6 + Math.random() * 1.8;
      g.beginPath();
      g.moveTo(y, -12);
      g.bezierCurveTo(y + (Math.random() - .5) * 20, 170, y + (Math.random() - .5) * 20, 340, y + (Math.random() - .5) * 12, 524);
      g.stroke();
    }
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      g.fillStyle = `rgba(${110 + Math.random() * 70 | 0}, ${72 + Math.random() * 40 | 0}, ${40 + Math.random() * 24 | 0}, ${.04 + Math.random() * .08})`;
      g.fillRect(x, y, 1 + Math.random() * 2.4, 1);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(5.5, 1.1);
    tex.anisotropy = 8;
    return tex;
  }

  /* 皮面颗粒：细密噪点，避免扶手是一块死板的纯色 */
  function leatherTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#6b4e3a';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 1400; i++) {
      const x = Math.random() * 512, y = Math.random() * 512, r = 3 + Math.random() * 9;
      const light = Math.random() > .45;
      g.fillStyle = light
        ? `rgba(${158 + Math.random() * 54 | 0}, ${122 + Math.random() * 40 | 0}, ${92 + Math.random() * 30 | 0}, ${.03 + Math.random() * .05})`
        : `rgba(${28 + Math.random() * 24 | 0}, ${18 + Math.random() * 16 | 0}, ${12 + Math.random() * 12 | 0}, ${.04 + Math.random() * .06})`;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      g.fillStyle = `rgba(${Math.random() > .5 ? 210 : 30}, ${Math.random() > .5 ? 176 : 22}, ${Math.random() > .5 ? 140 : 16}, .05)`;
      g.fillRect(x, y, 2, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1.15, 1.15);
    return tex;
  }

  /* U 形条带：圆角外形走一圈、近侧留口。inner 是内沿到桌心的距离，band 是宽度。 */
  function bandShape(inner, band, front, opts) {
    const o = opts || {};
    const ro = o.ro ?? FRAME.ro, ri = o.ri ?? FRAME.ri, rf = o.rf ?? FRAME.rf;
    const W = inner + band, iw = W - band, y0 = -front;
    const s = new THREE.Shape();
    s.moveTo(-W, y0 + rf);
    s.lineTo(-W, W - ro);                            // 外沿远左
    s.quadraticCurveTo(-W, W, -W + ro, W);
    s.lineTo(W - ro, W);
    s.quadraticCurveTo(W, W, W, W - ro);             // 外沿远右
    s.lineTo(W, y0 + rf);
    s.quadraticCurveTo(W, y0, W - rf, y0);           // 右臂近端
    s.lineTo(iw + rf, y0);
    s.quadraticCurveTo(iw, y0, iw, y0 + rf);
    s.lineTo(iw, iw - ri);                           // 内沿远右（绒面圆角）
    s.quadraticCurveTo(iw, iw, iw - ri, iw);
    s.lineTo(-iw + ri, iw);
    s.quadraticCurveTo(-iw, iw, -iw, iw - ri);       // 内沿远左
    s.lineTo(-iw, y0 + rf);
    s.quadraticCurveTo(-iw, y0, -iw - rf, y0);       // 左臂近端
    s.lineTo(-W + rf, y0);
    s.quadraticCurveTo(-W, y0, -W, y0 + rf);
    return s;
  }

  function bandMesh(name, spec) {
    const geometry = new THREE.ExtrudeGeometry(bandShape(spec.inner, spec.band, spec.front, spec), {
      depth: spec.height, bevelEnabled: true, bevelSegments: 2,
      bevelSize: spec.bevel, bevelThickness: spec.bevel, curveSegments: 6, steps: 1
    });
    const mesh = new THREE.Mesh(geometry, spec.material);
    mesh.name = name;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = spec.base;
    mesh.castShadow = !!spec.castShadow;
    mesh.receiveShadow = true;
    return mesh;
  }

  /* 十六进制色按 sRGB 给定，渲染前要转到线性空间，否则深色会发灰发亮 */
  function srgb(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }

  function buildTable() {
    const group = new THREE.Group();

    const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture(), color: 0xffffff, roughness: .56, metalness: .05 });
    const leatherMat = new THREE.MeshStandardMaterial({ map: leatherTexture(), color: srgb(0xa08670), roughness: .68, metalness: .06 });
    const brassMat = new THREE.MeshStandardMaterial({ color: srgb(0xc79b52), roughness: .34, metalness: .22 });
    const brassDeep = new THREE.MeshStandardMaterial({ color: srgb(0x7d5a24), roughness: .46, metalness: .2 });
    const seamMat = new THREE.MeshStandardMaterial({ color: srgb(0x3a2a1e), roughness: .8, metalness: .1 });
    const grooveMat = new THREE.MeshStandardMaterial({ color: srgb(0x140e0a), roughness: .95, metalness: .02 });
    const pipeMat = new THREE.MeshStandardMaterial({ color: srgb(0x3f2c20), roughness: .7, metalness: .08 });
    const railTop = FRAME.base + FRAME.height;       // 木框顶面高度
    const outer = FRAME.half + FRAME.band;           // 木框外沿
    // 与绒面等距的两条边界之间就是一条共心的圆角条带
    const radii = (a, b) => ({ ri: FRAME.ri + a, ro: FRAME.ri + b });
    const layer = (name, key, spec) => {
      const [a, b] = RAIL_LAYERS[key];
      return bandMesh(name, Object.assign({
        inner: FRAME.half + a, band: b - a, front: FRAME.front - .1,
        rf: .06, base: railTop, height: .05, bevel: .01, material: leatherMat
      }, radii(a, b), spec));
    };

    // 木框主体：一条连续的圆角 U 形条带，远侧两角圆润、近端敞开并铺到镜头前
    group.add(bandMesh('table-rail', {
      inner: FRAME.half, band: FRAME.band, front: FRAME.front,
      base: FRAME.base, height: FRAME.height, bevel: .03, material: woodMat, castShadow: true
    }));

    // 外立面的装饰线脚，给侧板一点车线感
    group.add(bandMesh('table-molding', {
      inner: outer + .01, band: .022, front: FRAME.front - .2,
      rf: .05, base: -.34, height: .036, bevel: .007, material: brassDeep,
      ...radii(FRAME.band + .01, FRAME.band + .032)
    }));

    // 绒面与扶手之间的黄铜护条
    group.add(layer('table-rail-guard', 'guard', {
      front: FRAME.front - .04, base: railTop - .02, height: .09, bevel: .013, material: brassMat, castShadow: true
    }));

    // 护条与皮面之间的暗槽，压出一道分界阴影
    group.add(layer('table-rail-groove', 'groove', {
      base: railTop - .006, height: .034, bevel: .005, material: grooveMat
    }));

    // 皮质扶手，外侧留一条木边
    group.add(layer('table-rail-cap', 'pad', {
      front: FRAME.front - .12, base: railTop + .002, height: .062, bevel: .009, material: leatherMat, castShadow: true
    }));

    // 扶手内外两条包边珠子
    ['pipeIn', 'pipeOut'].forEach((key) => {
      group.add(layer(`table-rail-${key}`, key, {
        front: FRAME.front - .115, base: railTop + .001, height: .092, bevel: .016,
        material: pipeMat, castShadow: true
      }));
    });

    // 扶手上一道双车线
    ['seamA', 'seamB'].forEach((key) => {
      group.add(layer(`table-rail-${key}`, key, {
        front: FRAME.front - .15, base: railTop + .058, height: .012, bevel: .004, material: seamMat
      }));
    });

    // 远侧两角的黄铜护角 + 铆钉
    const plateGeo = new THREE.ExtrudeGeometry(roundedShape(1.0, 1.0, .24), {
      depth: .028, bevelEnabled: true, bevelSegments: 1, bevelSize: .014, bevelThickness: .014, curveSegments: 5, steps: 1
    });
    plateGeo.center();
    plateGeo.rotateX(-Math.PI / 2);
    const capGeo = new THREE.ExtrudeGeometry(roundedShape(.72, .72, .17), {
      depth: .022, bevelEnabled: true, bevelSegments: 1, bevelSize: .012, bevelThickness: .012, curveSegments: 5, steps: 1
    });
    capGeo.center();
    capGeo.rotateX(-Math.PI / 2);
    const screwGeo = new THREE.CylinderGeometry(.028, .028, .016, 10);
    const corner = FRAME.half + FRAME.band / 2 + .01;
    [-1, 1].forEach((sx) => {
      const bracket = new THREE.Group();
      bracket.name = `table-corner-${sx < 0 ? 'left' : 'right'}`;
      const base = new THREE.Mesh(plateGeo, brassDeep);
      base.rotation.y = Math.PI / 4;
      base.position.set(sx * corner, railTop + .044, -corner);
      bracket.add(base);
      const plate = new THREE.Mesh(capGeo, brassMat);
      plate.rotation.y = Math.PI / 4;
      plate.position.set(sx * corner, railTop + .082, -corner);
      bracket.add(plate);
      [[-.2, .2], [.2, .2], [-.2, -.2], [.2, -.2]].forEach(([dx, dz]) => {
        const screw = new THREE.Mesh(screwGeo, brassDeep);
        screw.position.set(sx * corner + dx, railTop + .102, -corner + dz);
        bracket.add(screw);
      });
      group.add(bracket);
    });

    // 绒面
    const feltMat = new THREE.MeshStandardMaterial({ map: feltTexture(), color: 0xffffff, roughness: .96, metalness: 0 });
    const frontExtension = FRAME.front - TABLE / 2;
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
      // 已抬离牌身；负深度偏移会盖住其上方的灯带，透明贴图也无需写入深度。
      depthWrite: false
    });
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(PANEL.w, PANEL.w), panelTop);
    cap.name = 'table-panel-top';
    cap.renderOrder = 1;
    cap.rotation.x = -Math.PI / 2;
    cap.position.y = PH + 0.003;
    group.add(cap);
    buildTurnLight(group, PH);

    return group;
  }

  // 从自己这一侧的中点出发，沿圆角方框走向右/上/左侧。
  function panelTrack(phase) {
    const a = PANEL.w / 2 - TURN_LIGHT.inset, r = TURN_LIGHT.radius;
    const edge = a - r, arc = r * Math.PI / 2, quarter = edge * 2 + arc;
    const wrapped = ((phase % 4) + 4) % 4, side = Math.floor(wrapped);
    const distance = (wrapped - side) * quarter;
    let x, z, nx, nz;
    if (distance < edge) { x = distance; z = a; nx = 0; nz = 1; }
    else if (distance < edge + arc) {
      const angle = Math.PI / 2 - (distance - edge) / r;
      nx = Math.cos(angle); nz = Math.sin(angle);
      x = edge + nx * r; z = edge + nz * r;
    } else { x = a; z = edge - (distance - edge - arc); nx = 1; nz = 0; }
    const angle = side * Math.PI / 2, c = Math.cos(angle), s = Math.sin(angle);
    return { x: x * c + z * s, z: z * c - x * s, nx: nx * c + nz * s, nz: nz * c - nx * s };
  }

  function lightRingGeometry(width) {
    const positions = [], uv = [], indices = [], segments = 128;
    for (let i = 0; i <= segments; i++) {
      const phase = i * 4 / segments, p = panelTrack(phase);
      for (const side of [-1, 1]) {
        positions.push(p.x + p.nx * width / 2 * side, 0, p.z + p.nz * width / 2 * side);
        uv.push(phase, side);
      }
      if (i < segments) {
        const n = i * 2;
        indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  function buildTurnLight(group, height) {
    const track = new THREE.Mesh(lightRingGeometry(.085), new THREE.MeshBasicMaterial({ color: 0x060e19 }));
    track.name = 'table-turn-track';
    track.position.y = height + .006;
    group.add(track);
    // 一整圈共用一个着色器，光带包住拐角；光晕与亮芯只占一次绘制。
    const material = new THREE.ShaderMaterial({
      uniforms: { head: { value: 0 }, strength: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      vertexShader: 'varying vec2 vTrack; void main() { vTrack = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec2 vTrack;
        uniform float head;
        uniform float strength;
        void main() {
          float distance = abs(vTrack.x - head);
          distance = min(distance, 4.0 - distance);
          float bar = 1.0 - smoothstep(0.16, 0.25, distance);
          float core = 1.0 - smoothstep(0.13, 0.32, abs(vTrack.y));
          float halo = exp(-4.0 * abs(vTrack.y));
          float alpha = bar * (core * 0.85 + halo * 0.32) * strength;
          if (alpha < 0.002) discard;
          vec3 color = mix(vec3(1.0, 0.53, 0.08), vec3(1.0, 0.95, 0.65), core);
          gl_FragColor = vec4(color, alpha);
        }`
    });
    turnLight = new THREE.Mesh(lightRingGeometry(.22), material);
    turnLight.name = 'table-turn-light';
    turnLight.renderOrder = 2;
    turnLight.position.y = height + .010;
    group.add(turnLight);
  }

  function advanceTurnLight(now) {
    if (!turnLight) return false;
    for (const key of ['move', 'fade']) {
      const motion = lamp[key];
      if (!motion) continue;
      const t = Math.min(1, Math.max(0, (now - motion.start) / motion.duration));
      lamp[key === 'move' ? 'head' : 'alpha'] = THREE.MathUtils.lerp(motion.from, motion.to, t * t * (3 - 2 * t));
      if (t === 1) lamp[key] = null;
    }
    const breathe = reducedMotion?.matches ? 1 : .82 + .18 * Math.cos(now * Math.PI * 2 / TURN_LIGHT.period);
    turnLight.material.uniforms.head.value = ((lamp.head % 4) + 4) % 4;
    turnLight.material.uniforms.strength.value = lamp.alpha * breathe;
    turnLight.visible = lamp.alpha > 0;
    return !!lamp.move || !!lamp.fade || (lamp.seat >= 0 && motionAllowed());
  }

  function syncTurnLight(seat, now, animate) {
    advanceTurnLight(now);
    if (seat === lamp.seat) {
      if (!animate) {
        lamp.move = null; lamp.fade = null;
        lamp.head = lamp.target; lamp.alpha = lamp.targetAlpha;
        advanceTurnLight(now);
      }
      return;
    }
    const hadSeat = lamp.seat >= 0;
    lamp.seat = seat;
    lamp.targetAlpha = seat >= 0 ? 1 : 0;
    if (seat >= 0) {
      // 用当前光的位置续接新目标；碰杠跨座和 3→0 都走最近的边框路径。
      const phase = ((lamp.head % 4) + 4) % 4;
      let delta = ((seat - phase + 4) % 4);
      if (delta > 2) delta -= 4;
      lamp.target = hadSeat ? lamp.head + delta : seat;
    } else lamp.target = lamp.head;
    lamp.move = animate && hadSeat && seat >= 0 && Math.abs(lamp.target - lamp.head) > .0001
      ? { from: lamp.head, to: lamp.target, start: now, duration: TURN_LIGHT.travel } : null;
    lamp.fade = animate && lamp.alpha !== lamp.targetAlpha
      ? { from: lamp.alpha, to: lamp.targetAlpha, start: now, duration: TURN_LIGHT.fade } : null;
    if (!lamp.move) lamp.head = lamp.target;
    if (!lamp.fade) lamp.alpha = lamp.targetAlpha;
    advanceTurnLight(now);
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
    const dy = camera.position.y - tileHalfH * selfHandScale;
    const dz = camera.position.z - selfHandZ;
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
    const scale = selfHandScale, pitch = (T.w + HAND_GAP) * scale;
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
      const p = seatLocal(seat.x, selfHandZ, seat.ry, lx, 0);
      const occurrence = items.slice(0, i).filter((t) => t === id).length;
      const tile = tileSpec(ctx, `hand:0:${id}:${occurrence}`, seat, 'hand', id, true);
      tile.userData.slot = i;
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
      tile.userData.slot = i;
      standUp(tile, seat.ry, p, 0.004);
    }
  }

  /** 牌河：7 列，从靠手的这一排往桌心长；有副露时整体往里让一条道 */
  function placeRiver(seat, discards, ctx, meldCount) {
    const { cols, start, meldShift } = RIVER;
    const pitch = T.w + 0.05, rowPitch = T.h + 0.04;
    // 自己那排副露被手牌顶到更靠桌心：牌河紧贴副露上方、只留两行，
    // 起点由副露实际深度推出来（固定留 meldGapSelfMobile 的道），保证不叠也不隔太远
    const selfMobile = seat.id === 0 && selfHandZ !== SELF_HAND.z;
    const maxRows = meldCount ? (selfMobile ? RIVER.rowsSelfMobile : 3) : 4;
    let z0 = meldCount ? start + meldShift : start;
    if (selfMobile && meldCount) z0 = selfMeldDepth() - 0.51 - RIVER.meldGapSelfMobile - seat.z;
    // 手机上自己牌河只摆两行，超出的丢掉最旧的（保留最近的弃牌，信息更有用）
    const shown = discards.length > cols * maxRows && selfMobile ? discards.slice(-cols * maxRows) : discards.slice(0, cols * maxRows);
    shown.forEach((id, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const lx = -((cols - 1) / 2) * pitch + col * pitch;
      const p = seatLocal(seat.x, seat.z, seat.ry, lx, z0 - row * rowPitch);
      const tile = tileSpec(ctx, `river:${seat.id}:${i}:${id}`, seat, 'river', id, true);
      layFlat(tile, seat.ry, p, 0);
    });
  }

  /** 自己副露该摆多深：视线越过手牌顶沿落到桌面的位置就是遮挡阴影边界，副露要摆在它后面 */
  function selfMeldDepth() {
    const fallback = SEAT[0].z + MELD_Z_SELF_MOBILE;
    if (!camera) return fallback;
    const topY = 0.55 * selfHandScale;               // 手牌顶沿高度（与取景点同一套口径）
    const cy = camera.position.y, cz = camera.position.z;
    if (cy <= topY + 0.2) return fallback;
    const t = (cy - 0.12) / (cy - topY);              // 沿视线落到桌面（y≈0.12）的距离倍率
    const zHit = cz + (selfHandZ - cz) * t;
    return Math.min(fallback, zHit - 0.69);           // 再让开半张牌 + 一点余量
  }

  /** 副露：平摊在手内侧那一条道上，四家都能看见；暗杠四张背面朝上，只有自己点开才翻面 */
  function placeMelds(seat, melds, ctx) {
    if (!melds.length) return;
    const MELD_GAP = 0.12, pitch = T.w + 0.02;
    // 别人的暗杠不下发牌面（tiles=[]），但桌上仍然占四张的位置，不能凭空少一排
    const count = (m) => (m.tiles.length || 4);
    const total = melds.reduce((s, m) => s + count(m) * pitch, 0) + MELD_GAP * (melds.length - 1);
    let lx = -total / 2;
    melds.forEach((m, mi) => {
      const mine = seat.id === 0 && ctx.kongPeek.includes(mi);
      const hidden = m.type === 'angang' && !ctx.kongEnded && !mine;
      for (let ti = 0; ti < count(m); ti++) {
        const mz = seat.id === 0 ? selfMeldDepth() - seat.z : MELD_Z;
        const p = seatLocal(seat.x, seat.z, seat.ry, lx, mz);
        const id = hidden ? null : (m.tiles[ti] ?? null);
        const tile = tileSpec(ctx, `meld:${seat.id}:${mi}:${ti}`, seat, 'meld', id, !hidden && id != null);
        if (hidden && seat.id === 0) tile.userData.kong = mi;   // 自己的暗杠：可点开翻看
        layFlat(tile, seat.ry, p, 0.004);
        lx += pitch;
      }
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
    deal = null;
    lamp.move = null; lamp.fade = null;
    lamp.head = lamp.target; lamp.alpha = lamp.targetAlpha;
    advanceTurnLight(performance.now());
    shadowsDirty = true;
    for (const node of tiles.values()) {
      const d = node.userData;
      d.motion = null; d.hover = 0; d.hoverVelocity = 0;
      node.visible = true;
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
    let moving = advanceTurnLight(now);
    for (const node of tiles.values()) {
      const d = node.userData, m = d.motion;
      if (m) {
        shadowsDirty = true;
        if (m.deal) node.visible = now >= m.start;
        const t = Math.min(1, Math.max(0, (now - m.start) / m.duration));
        const ease = t * t * (3 - 2 * t);
        d.basePosition.lerpVectors(m.from, d.targetPosition, ease);
        d.basePosition.y += Math.sin(Math.PI * ease) * m.arc;
        node.quaternion.slerpQuaternions(m.rotation, d.targetQuaternion, ease);
        node.scale.setScalar(THREE.MathUtils.lerp(m.scale, d.targetScale, ease));
        if (t === 1) d.motion = null;
        else moving = true;
      }
      const oldHover = d.hover;
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
      if (oldHover !== d.hover) shadowsDirty = true;
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
    const changed = kind === 'deal' || !d.targetPosition || !d.targetPosition.equals(spec.position) ||
      1 - Math.abs(d.targetQuaternion.dot(rotation)) > 1e-8 || d.targetScale !== spec.scale;
    if (!changed) return; // 重复快照/轮次文字更新不能重启正在运行的动画。
    if (d.motion?.deal && deal && spec.zone === 'hand') {
      // 庄家补首摸和操作提示可能紧接着到达，只更新终点，不打断已经排好的发牌批次。
      d.targetPosition.copy(spec.position); d.targetQuaternion.copy(rotation); d.targetScale = spec.scale;
      return;
    }
    const from = ['discard', 'meld', 'deal'].includes(kind) ? node.position.clone() : (d.basePosition || node.position).clone();
    if (kind === 'discard' || kind === 'meld') { d.hover = 0; d.hoverVelocity = 0; }
    d.targetPosition = spec.position.clone();
    d.targetQuaternion = rotation;
    d.targetScale = spec.scale;
    d.basePosition = from;
    if (animate) d.motion = {
      from: from.clone(), rotation: node.quaternion.clone(), scale: node.scale.x, start: now,
      duration: MOTION[kind], arc: kind === 'discard' ? .65 : kind === 'deal' ? .24 : kind === 'meld' ? .20 : kind === 'draw' ? .10 : 0
    };
    else {
      d.motion = null;
      d.basePosition.copy(spec.position);
      node.position.copy(spec.position);
      node.quaternion.copy(rotation);
      node.scale.setScalar(spec.scale);
    }
    if (kind === 'deal' && d.motion) {
      const slot = spec.userData.slot;
      const order = Math.floor(slot / 4) * 4 + (spec.seat - deal.dealer + 4) % 4;
      d.motion.start = deal.start + order * 42 + (slot % 4) * 18;
      d.motion.deal = true;
    }
  }

  function finishDeal(now) {
    deal = null;
    for (const node of tiles.values()) {
      const d = node.userData;
      if (!d.motion?.deal) continue;
      node.visible = true;
      d.motion = { from: d.basePosition.clone(), rotation: node.quaternion.clone(), scale: node.scale.x,
        start: now, duration: 160, arc: 0 };
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
      }
      const dealing = deal && spec.zone === 'hand' && (fresh || deal.new);
      if (dealing) {
        const seat = SEAT[spec.seat], slot = spec.userData.slot;
        const origin = seatLocal(0, 0, seat.ry, ((slot % 4) - 1.5) * .18, 1.85);
        node.position.set(origin.x, .24 + (slot % 4) * .025, origin.z);
        node.rotation.order = 'YXZ';
        node.rotation.set(spec.seat === 0 ? -Math.PI / 2 : Math.PI / 2, seat.ry, 0);
        node.scale.setScalar(spec.scale * .88);
        node.userData.motion = null;
      } else if (fresh && animate && (spec.zone === 'hand' || spec.zone === 'river')) {
        const seat = SEAT[spec.seat];
        const origin = spec.zone === 'hand'
          ? seatLocal(spec.position.x, spec.position.z, seat.ry, .20, -.45)
          : seatLocal(seat.x, seat.z, seat.ry, 0, 0);
        node.position.set(origin.x, spec.zone === 'hand' ? spec.position.y + .10 : tileHalfH + .1, origin.z);
        if (spec.zone === 'river') node.rotation.set(0, seat.ry, 0);
      }
      available.delete(node);
      const oldZone = node.userData.zone;
      const kind = dealing ? 'deal' : spec.zone === 'river' && oldZone !== 'river' ? 'discard' :
        spec.zone === 'meld' && oldZone !== 'meld' ? 'meld' : fresh && spec.zone === 'hand' ? 'draw' : 'move';
      appearance(node, spec.id, spec.faceUp);
      Object.assign(node.userData, { key: spec.key, zone: spec.zone, seat: spec.seat,
        playable: !!spec.userData.playable, kong: spec.userData.kong, drawn: !!spec.userData.drawn });
      targetPose(node, spec, now, animate || kind === 'deal', kind);
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
      const pickable = d.playable || d.kong != null;   // 自己的暗杠也要能点开翻看
      if (pickable && !d.pick) {
        d.pick = new THREE.Mesh(pickGeo, tileMaterials[0]);
        d.pick.userData.tile = node;
      }
      if (d.pick) {
        if (pickable) pickLayer.add(d.pick);
        else pickLayer.remove(d.pick);
      }
    }
    const keepHover = hoverTile && (hoverTile.userData.kong != null ||
      (hoverTile.userData.playable && seatGroups.includes(hoverTile)));
    if (!keepHover) setHover(null);
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
      dealId: view?.opening || 0, dealer: game.dealer ?? 0,
      phase: game.phase, seq: game.discardSeq || 0,
      turnSeat: game.phase === 'playing' && Number.isInteger(game.turn) && game.turn >= 0 && game.turn < 4 ? game.turn : -1,
      hands: game.players.map((p) => (p.handCount != null ? p.handCount : p.hand.length)),
      hand0: game.players[0].hand.slice().sort((a, b) => a - b),
      discards: game.players.map((p) => p.discards.slice()),
      melds: game.players.map((p) => p.melds.map((m) => ({ type: m.type, tiles: m.tiles }))),
      kongPeek: (view && Array.isArray(view.kongPeek) ? view.kongPeek : []).slice(),
      kongEnded: game.phase === 'ended' && !!game.result,
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
      deal = null;
      tileLayer.clear(); pickLayer.clear(); tiles.clear();
      setHover(null); pressedTile = null; discardPick = null; lastTime = null;
      if (tipHandler) tipHandler(null, 0, 0);
    }
    if (deal && (snapshot.dealId !== deal.id || snapshot.seq > 0 || !['dealing', 'playing'].includes(snapshot.phase))) finishDeal(now);
    if (snapshot.dealId && snapshot.dealId !== lastDealId) {
      lastDealId = snapshot.dealId;
      if (motionAllowed() && !snapshot.seq && snapshot.hands.every((count) => count >= 13 && count <= 14) &&
          snapshot.discards.every((list) => !list.length) && snapshot.melds.every((list) => !list.length)) {
        deal = { id: snapshot.dealId, start: now, dealer: snapshot.dealer, new: true };
      }
    }
    const panelChanged = !previous || snapshot.round !== previous.round || snapshot.wall !== previous.wall;
    sig = next;

    const ctx = { items: [], playable: snapshot.playable, kongPeek: snapshot.kongPeek, kongEnded: snapshot.kongEnded };
    game.players.forEach((p, i) => {
      const seat = { id: i, x: SEAT[i].x, z: SEAT[i].z, ry: SEAT[i].ry };
      if (i === 0) placeHand(seat, snapshot.hand0, ctx, snapshot.drawn);
      else placeBacks(seat, snapshot.hands[i], ctx);
      placeRiver(seat, snapshot.discards[i], ctx, snapshot.melds[i].length);
      placeMelds(seat, snapshot.melds[i], ctx);
    });
    reconcile(ctx.items, now, animate, snapshot);
    if (deal) deal.new = false;
    syncTurnLight(snapshot.turnSeat, now, animate);
    shadowsDirty = true;
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
    const targets = pickLayer.children.filter((p) => p.userData.tile.visible && !p.userData.tile.userData.motion?.deal);
    const hit = raycaster.intersectObjects(targets, false)[0];
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
    lastPointerDown = performance.now();   // 给 touchend 兜底去重用（有 Pointer Events 时它不会重复出牌）
    if (e.button != null && e.button !== 0) return;
    if (pressedTile) return;
    advance(performance.now());
    const node = pickTile(e.clientX, e.clientY);
    if (!node) return;
    // 自己的暗杠：点一下翻看/扣回，交给上层维护翻面状态再重新 sync
    if (node.userData.kong != null) {
      if (kongHandler) kongHandler(node.userData.kong);
      return;
    }
    if (!discardHandler) return;
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

  /** 取景：把桌面 + 四家手牌/牌河塞进当前画幅。
   *  桌面（1.62 左右）结果与固定机位基本一致；宽扁的手机横屏按高度填充并给顶部 HUD 留出安全带。 */
  function frameCamera(aspect, w, h) {
    const look = new THREE.Vector3(0, 0, CAM.lookZMobile);
    // 矮画幅（手机）视角抬到约 50°：更接近俯视，手牌在桌面上的遮挡阴影更短，副露才放得下
    const dir = new THREE.Vector3(0, CAM.up, h < 460 ? CAM.backMobile : CAM.back).normalize();
    const p = new THREE.Vector3();
    // 手机：顶部给矮信息牌留一条安全带，底部留一点，其余高度全部给牌桌
    const topPx = h < 420 ? Math.max(30, Math.round(h * 0.09)) : 28;
    const bottomPx = h < 420 ? Math.max(6, Math.round(h * 0.03)) : 16;
    const sidePx = 10;
    const limTop = 1 - (2 * topPx) / h;
    const limTopSoft = 1 - (2 * (h < 420 ? 4 : 8)) / h;   // 远侧木框可以贴着上沿/被信息牌盖住
    const limBottom = 1 - (2 * bottomPx) / h;
    const limX = 1 - (2 * sidePx) / w;
    const fitAt = (dist) => {
      camera.position.copy(look).addScaledVector(dir, dist);
      camera.aspect = aspect;
      camera.fov = CAM.fov;
      camera.updateProjectionMatrix();
      camera.lookAt(look);
      camera.updateMatrixWorld(true);
      let mx = 0, upHard = 0, upSoft = 0, down = 0;
      for (const [x, y, z] of fitHard()) {
        p.set(x, y, z).project(camera);
        mx = Math.max(mx, Math.abs(p.x));
        if (p.y > 0) upHard = Math.max(upHard, p.y); else down = Math.max(down, -p.y);
      }
      for (const [x, y, z] of FIT_SOFT) {
        p.set(x, y, z).project(camera);
        mx = Math.max(mx, Math.abs(p.x));
        if (p.y > 0) upSoft = Math.max(upSoft, p.y);
      }
      return Math.max(mx / limX, upHard / limTop, upSoft / limTopSoft, down / limBottom);
    };
    // 距离越远内容越小，二分找刚好装得下的最近机位（固定点迭代会在远侧过冲）
    let lo = 5, hi = 44;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fitAt(mid) <= 1) hi = mid; else lo = mid;
    }
    const dist = hi * (h < 420 ? 0.93 : 1);
    camera.position.copy(look).addScaledVector(dir, dist);
    camera.lookAt(look);
    camera.updateProjectionMatrix();
  }

  /** 画布尺寸跟着容器走，避免拉伸变形 */
  function resize() {
    if (!renderer || !canvas) return;
    const w = canvas.clientWidth || 1200;
    const h = canvas.clientHeight || 740;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    if (h >= 460) {
      selfHandZ = SELF_HAND.z;
      if (panelMesh) panelMesh.scale.setScalar(1);
      selfHandScale = SELF_HAND.scale;
      selfMeldZ = MELD_Z;
      // 桌面保持原来的固定机位，手机/矮画幅才走自适应取景
      camera.aspect = w / h;
      camera.fov = CAM.fov;
      camera.position.set(0, CAM.up, CAM.lookZ + CAM.back);
      camera.lookAt(0, 0, CAM.lookZ);
      camera.updateProjectionMatrix();
    } else {
      selfHandZ = SELF_HAND.zMobile;
      if (panelMesh) panelMesh.scale.setScalar(0.85);
      selfHandScale = SELF_HAND.scaleMobile;
      selfMeldZ = MELD_Z_SELF_MOBILE;
      frameCamera(w / h, w, h);
    }
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
    renderer.shadowMap.autoUpdate = false;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(CAM.fov, 1200 / 740, 0.1, 140);
    camera.position.set(0, CAM.up, CAM.lookZ + CAM.back);   // 约 43° 俯视，兼顾四家牌河与自己手牌
    camera.lookAt(0, 0, CAM.lookZ);

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
    // 有的手机浏览器不派发 Pointer Events，只给 touch*；这里补一条兜底（有 Pointer 时靠时间窗去重）
    const onTouchEnd = (e) => {
      if (e.touches.length) return;
      if (performance.now() - lastPointerDown < 700) return;
      const t = (e.changedTouches && e.changedTouches[0]);
      if (!t) return;
      onDown({ button: 0, clientX: t.clientX, clientY: t.clientY, pointerType: 'touch', preventDefault() {} });
    };
    canvas.addEventListener('touchend', onTouchEnd, { passive: true });
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
      if (readyHandler) readyHandler();
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
      // 暗杠牌背不对鼠标显示牌名，只有自己的手牌才给提示
      if (node && tipHandler) tipHandler(node.userData.kong != null ? null : node.userData.tileId, e.clientX, e.clientY);
      moving = moving || !!(node && node.userData.kong == null);
    }
    if (needsRender || moving || wasMoving) {
      const layoutChanged = needsRender || shadowsDirty;
      needsRender = false;
      const began = performance.now();
      renderer.shadowMap.needsUpdate = shadowsDirty;
      shadowsDirty = false;
      renderer.render(scene, camera);
      metrics.renderMs = performance.now() - began;
      if (layoutChanged && layoutHandler) layoutHandler();
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
    /** 桌心铭牌显隐（保留接口；手机上也用 3D 这块） */
    setPanelVisible(v) { if (panelMesh) panelMesh.visible = !!v; },
    stats() { return { ...metrics, animating: lastFrameMoving }; },
    onDiscard(fn) { discardHandler = fn; },
    onKong(fn) { kongHandler = fn; },
    onTip(fn) { tipHandler = fn; },
    onLayout(fn) { layoutHandler = fn; },
    onReady(fn) { readyHandler = fn; },
    get ready() { return ready; },
    get canvas() { return canvas; },
    get scene() { return scene; },
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
        handBase: proj(0, 0, selfHandZ), handTop: proj(0, .72 * selfHandScale, selfHandZ), panel: proj(0, 0.14, 0)
      };
    },
    pickAt(x, y) { const n = pickTile(x, y); return n ? n.userData.tileId : null; },
    /** 世界坐标 → 画布像素（手机端验收：确认四家牌河 / 手牌都在画面内） */
    project(x, y, z) {
      if (!camera || !canvas) return null;
      const v = new THREE.Vector3(x, y, z).project(camera);
      return [Math.round((v.x + 1) / 2 * canvas.clientWidth), Math.round((1 - v.y) / 2 * canvas.clientHeight)];
    },
    layoutInfo() {
      const topY = 0.55 * selfHandScale;
      const cy = camera ? camera.position.y : 0, cz = camera ? camera.position.z : 0;
      const zHit = cy > topY ? cz + (selfHandZ - cz) * ((cy - 0.12) / (cy - topY)) : null;
      return {
        selfHandZ, selfHandScale, selfMeldZValue: selfMeldDepth(),
        shadowZ: zHit == null ? null : +zHit.toFixed(2),
        riverZ0: +(SEAT[0].z + RIVER.start + RIVER.meldShiftSelfMobile).toFixed(2),
        cam: camera ? [camera.position.y, camera.position.z].map((n) => +n.toFixed(2)) : null
      };
    },
    camDist() {
      if (!camera) return null;
      return +camera.position.distanceTo(new THREE.Vector3(0, 0, CAM.lookZ)).toFixed(2);
    },
    /** 自己手牌右端在屏幕上的位置（听牌候选牌挂在这儿） */
    handEnd() {
      if (!canvas || !camera) return null;
      const last = seatGroups[seatGroups.length - 1];
      const x = last ? last.position.x + T.w * last.scale.x / 2 + .10 : SEAT[0].x + 1.0;
      const z = last ? last.position.z : selfHandZ;
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
