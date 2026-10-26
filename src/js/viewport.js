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
  if (!root) return { measure };
  let requestedFullscreen = false;
  let entering = false;
  let attempted = false;
  function layout() {
    const width = root.visualViewport?.width || root.innerWidth;
    const height = root.visualViewport?.height || root.innerHeight;
    const view = measure(width, height, root.matchMedia('(pointer: coarse)').matches,
      document.body.classList.contains('in-game'));
    document.documentElement.style.setProperty('--viewport-w', width + 'px');
    document.documentElement.style.setProperty('--viewport-h', height + 'px');
    document.body.classList.toggle('mobile-table', view.mobile);
    document.body.classList.toggle('rotate-game', view.rotated);
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
  return { measure, layout, enter, leave };
});
