/* 牌面：使用 CC0 公共领域的麻将牌矢量图（FluffyStuff/riichi-mahjong-tiles）
 * 该资源只含花纹、透明底，由 CSS 的 .tile 提供牌身与阴影。
 * assets/tiles/Man1-9.svg（万）、Sou1-9.svg（条）、Pin1-9.svg（筒）、Back.svg
 */
(function (root) {
  'use strict';
  const DIRS = ['Man', 'Sou', 'Pin'];

  function face(tile) {
    const suit = (tile / 9) | 0;
    const rank = (tile % 9) + 1;
    return `<img class="face" src="assets/tiles/${DIRS[suit]}${rank}.svg" alt="" draggable="false">`;
  }

  function back() {
    return '<img class="face" src="assets/tiles/Back.svg" alt="" draggable="false">';
  }

  root.GZTiles = { face, back };
})(typeof globalThis !== 'undefined' ? globalThis : this);
