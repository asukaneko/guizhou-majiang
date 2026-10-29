/* 手机牌桌始终按横屏排版；浏览器不支持方向锁定时旋转页面兜底。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GZViewport = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  function measure(width, height, coarse, inGame) {
    const mobile = coarse && Math.min(width, height) <= 600;
    const rotated = mobile && inGame && height > width;
    return { mobile, rotated, width: rotated ? height : width, height: rotated ? width : height };
  }
  // 手机牌桌的尺寸使用舞台的实际可用区域，包含浏览器工具栏/安全区扣除后的结果。
  function tableLayout(width, height, hasActions = false) {
    const compact = height < 250, gap = compact ? 6 : 8, top = compact ? 42 : 46;
    const tileW = Math.min(48, width * .05, height * .135, (width - 60) / 14);
    const tileH = tileW * 1.36, handBottom = 10, handZone = tileH + handBottom + 10;
    const panelW = Math.min(132, Math.max(100, width * .145)), panelH = compact ? 46 : 64;
    const playBottom = height - handZone;
    const availableRiverH = Math.max(12, (playBottom - top - panelH - gap * 2) / 2);
    let riverW = Math.min(24, width * .027, height * .074, availableRiverH / 1.34);
    if (availableRiverH >= 42) riverW = Math.min(riverW, (availableRiverH - 2) / (2 * 1.34));
    const riverTileH = riverW * 1.34, riverGap = 2;
    const wholeRows = (available) => {
      const rows = Math.max(1, Math.floor((available + riverGap + .001) / (riverTileH + riverGap)));
      return rows * riverTileH + (rows - 1) * riverGap;
    };
    const riverH = wholeRows(availableRiverH);
    const northWidth = riverW * 6 + riverGap * 5, sideWidth = riverW * 4 + riverGap * 3;
    const center = { x: (width - panelW) / 2, y: (top + playBottom - panelH) / 2, w: panelW, h: panelH };
    const actionX = center.x + center.w + 14;
    const actionH = Math.min(84, Math.max(36, playBottom - top - riverTileH - gap));
    const actions = { x: actionX, y: playBottom - actionH, w: width - actionX - 8, h: actionH };
    const hudW = Math.min(126, width * .2), hudH = compact ? 30 : 34;

    /* 三家对手的牌河不再是同一条横带（那样会连成一长排）：
       对家留在顶部正中，上家 / 下家整体下移一条带，左右夹着桌心，彼此留出空隙。 */
    const rowGap = Math.max(10, gap + 6);
    const sideLimit = Math.min(hasActions ? actions.y - gap : playBottom, playBottom) - gap;
    const sideTop = top + riverH + rowGap;
    // 至少要能放下一整行弃牌才下移，否则（极矮屏）退回顶部同一条带
    const sideY = sideLimit - sideTop >= riverTileH + riverGap ? sideTop : top;
    const sideH = wholeRows(Math.max(riverTileH, sideLimit - sideY));
    const sideGap = Math.max(14, gap + 6);
    // 下家牌河右边的空白列：手机提示条（toast）摆在这里，不再压在牌桌上方
    const toastX = center.x + center.w + sideGap + sideWidth + sideGap;
    const toastY = top + hudH + gap;
    const toastW = Math.max(96, width - 8 - toastX);
    const toast = {
      x: Math.min(toastX, width - 8 - toastW), y: toastY, w: toastW,
      h: Math.max(0, sideLimit - toastY)
    };

    return {
      tile: { w: tileW, h: tileH }, riverTile: { w: riverW, h: riverTileH }, handBottom, handZone, center,
      hand: { x: (width - (tileW * 14 + 2 * 13 + 8)) / 2, y: height - handBottom - tileH, w: tileW * 14 + 2 * 13 + 8, h: tileH },
      hud: { w: hudW, h: hudH, bottom: handZone + 8 }, actions,
      rivers: [
        { x: (width - northWidth) / 2, y: playBottom - riverH, w: northWidth, h: riverH },
        { x: center.x + center.w + sideGap, y: sideY, w: sideWidth, h: sideH },
        { x: (width - northWidth) / 2, y: top, w: northWidth, h: riverH },
        { x: center.x - sideWidth - sideGap, y: sideY, w: sideWidth, h: sideH }
      ],
      toast
    };
  }
  if (!root) return { measure, tableLayout };
  let requestedFullscreen = false;
  let entering = false;
  let attempted = false;
  function layout() {
    const width = root.visualViewport?.width || root.innerWidth;
    const height = root.visualViewport?.height || root.innerHeight;
    // 竖拿手机的聊天按设备方向显示，软键盘收缩视口时也不旋转输入框。
    const chatting = document.body.classList.contains('chat-open');
    const view = measure(width, height, root.matchMedia('(pointer: coarse)').matches,
      document.body.classList.contains('in-game') && !chatting);
    document.documentElement.style.setProperty('--viewport-w', width + 'px');
    document.documentElement.style.setProperty('--viewport-h', height + 'px');
    document.documentElement.style.setProperty('--viewport-top', (root.visualViewport?.offsetTop || 0) + 'px');
    document.body.classList.toggle('mobile-table', view.mobile);
    document.body.classList.toggle('rotate-game', view.rotated);
    document.body.classList.toggle('chat-short', chatting && height < 240);
    return view;
  }
  async function enter(force = false) {
    const view = layout();
    if (!view.mobile || entering || (attempted && !force) || !root.navigator.userActivation?.isActive) return;
    attempted = true;
    entering = true;
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
        requestedFullscreen = true;
      }
      if (document.body.classList.contains('in-game') && root.screen.orientation?.lock) {
        await root.screen.orientation.lock('landscape');
      }
    } catch { /* 页面旋转已经保证横屏，不要求浏览器支持全屏或锁屏。 */ }
    finally { entering = false; layout(); }
  }
  function leave() {
    try { root.screen.orientation?.unlock?.(); } catch { /* unsupported */ }
    if (requestedFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    requestedFullscreen = false;
    attempted = false;
    layout();
  }
  return { measure, tableLayout, layout, enter, leave };
});
