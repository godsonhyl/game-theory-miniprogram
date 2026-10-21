/**
 * WXSS → CSS 转换器（视觉回归专用，不进发布包）
 *
 * 小程序 WXSS 有三套长度单位，转换时全部落到真实像素，浏览器才能按真机尺寸
 * 渲染出可用于比对画面：
 *   - rpx：设计稿 750 宽，rpx = 视口宽 / 750（真机按宽度等比缩放）
 *   - var(--uh)：视口高 / 100（本项目约定，横屏下 = min(w,h)/100）
 *   - var(--uw)：视口宽 / 100
 *
 * 注意 rpx 的基准是**宽度**而非高度：横屏 844×390 下 1rpx = 844/750 = 1.125px，
 * 这与 --uh = 3.9px 完全不同。历史上本项目就吃过 uh/felt% 单位混算的亏，转换器
 * 必须严格按各自基准换算，不能图省事合并成一个数。
 */

'use strict';

/** 把 WXSS 源码转成可在浏览器直接用的 CSS 文本 */
function wxssToCss(wxssSrc, viewport) {
  const { width, height } = viewport;
  const rpx = width / 750;
  const uh = Math.min(width, height) / 100;
  const uw = width / 100;

  let css = String(wxssSrc);

  // 1) @import 去掉（本项目 table.wxss 无 import，留防御）
  css = css.replace(/@import\s+[^;]+;/g, '');

  // 2) rpx → px（支持小数与负数，带 3 位精度）
  css = css.replace(/(-?\d*\.?\d+)rpx/g, (m, n) => {
    const v = parseFloat(n) * rpx;
    return (Math.round(v * 1000) / 1000) + 'px';
  });

  // 3) var(--uh) / var(--uw) → px
  css = css.replace(/var\(\s*--uh\s*\)/g, uh.toFixed(4) + 'px');
  css = css.replace(/var\(\s*--uw\s+\)/g, uw.toFixed(4) + 'px');
  css = css.replace(/var\(\s*--uw\s*\)/g, uw.toFixed(4) + 'px');

  // 4) 小程序 page 选择器 → html,body（真机 page 是根节点，撑满视口）
  css = css.replace(/(^|\})\s*page\s*\{/g, '$1 body {');

  // 5) 去掉小程序专有的 ::after border 写法里可能残留的非标准值（无需处理，保留原样）

  // 6) 补根容器样式：真机 page 默认 overflow 行为与浏览器 body 不同
  const preamble = [
    'html, body { margin:0; padding:0; width:' + width + 'px; height:' + height + 'px;',
    '  overflow:hidden; background:#0b1220;',
    '  -webkit-font-smoothing:antialiased;',
    '}',
    '*, *::before, *::after { box-sizing: border-box; }',
    /* 真机默认字体是系统无衬线；显式指定避免 CI 环境字体差异导致文本宽度不同 */
    'body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }',
    /* 动画在截图时应静止：视觉回归对比的是布局，不是动画中间帧 */
    '*, *::before, *::after { animation-play-state: paused !important; animation-delay: -1s !important; }'
  ].join('\n');

  return preamble + '\n' + css;
}

/**
 * 生成完整 HTML 文档：根容器 + 渲染后的 WXML + 转换后的 CSS
 * @param {string} bodyHtml  renderWxml 产出的片段
 * @param {string} css       wxssToCss 产出的样式
 * @param {{width:number,height:number,style:string}} viewport
 */
function buildHtml(bodyHtml, css, viewport) {
  // rootStyle 由页面自己算（--uh/--uw 变量），这里直接套在外层包一层即可：
  // table-page 自身带 style="{{rootStyle}}"，变量作用域已经正确。
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=' + viewport.width + '">',
    '<style>',
    css,
    '</style>',
    '</head>',
    '<body>',
    bodyHtml,
    '</body>',
    '</html>'
  ].join('\n');
}

module.exports = { wxssToCss, buildHtml };
