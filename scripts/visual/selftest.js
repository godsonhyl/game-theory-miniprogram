/**
 * 视觉回归 —— 自检
 *
 * 这层测试保证「视觉回归工具本身是可信的」。历史上最容易坏的三件事：
 *   ① 渲染器静默吞错，产出空白页 → 比对永远通过（假绿）
 *   ② 场景数据不随参数变化，所有截图长得一样 → 比对毫无意义
 *   ③ 渲染不确定（随机牌、随机 bot 决策）→ 基线比对天天红，最后被无视
 * 三者都在本文件里钉死。
 *
 * 本脚本不依赖浏览器：只验证「数据 + HTML 产出」这一层，因此可以进 npm test。
 * 真正的截图比对仍是单独的 `npm run visual`（需要本机 Chrome）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const MP = path.join(ROOT, 'miniprogram');

const { renderWxml } = require('./wxml-render');
const { wxssToCss } = require('./wxss-render');
const { SCENES } = require('./scenes');
const { decodePng, diffStats } = require('./compare');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; console.log('  ✗ ' + label); }
}

const VP = { width: 844, height: 390, feltUh: 65.9 };

/* ---------- ① 渲染器：插值与指令语义 ---------- */
{
  const cases = [
    // [模板, 数据, 期望包含片段, 说明]
    ['<view>{{a}}</view>', { a: 'X' }, '>X<', '单表达式文本'],
    ['<view>{{a}} 与 {{b}}</view>', { a: 'X', b: 'Y' }, 'X 与 Y', '一段文本里两个插值（曾因正则吃错边界而崩）'],
    ['<view>{{a > 0 ? \'正\' : \'负\'}}</view>', { a: 1 }, '正', '三元表达式'],
    ['<view>{{ \'}}\' + a }}</view>', { a: 1 }, '}}1', '表达式字符串字面量里含 }}'],
    ['<view wx:if="{{ok}}">T</view>', { ok: true }, '>T<', 'wx:if 真'],
    ['<view wx:if="{{ok}}">T</view>', { ok: false }, '', 'wx:if 假'],
    ['<view wx:if="{{a}}">A</view><view wx:elif="{{b}}">B</view><view wx:else>C</view>', { a: 0, b: 1 }, '>B<', 'wx:elif 命中'],
    ['<view wx:if="{{a}}">A</view><view wx:elif="{{b}}">B</view><view wx:else>C</view>', { a: 0, b: 0 }, '>C<', 'wx:else 兜底'],
    ['<view wx:for="{{list}}" wx:for-item="it">{{it.n}}</view>', { list: [{ n: 1 }, { n: 2 }] }, '>1</div><div', 'wx:for 展开'],
    ['<view class="{{c}}" style="left:{{x}}%"></view>', { c: 'k', x: 42 }, 'class="k"', '属性插值 class'],
    ['<view class="{{c}}" style="left:{{x}}%"></view>', { c: 'k', x: 42 }, 'left:42%', '属性插值 style']
  ];
  for (const [tpl, data, expect, label] of cases) {
    let html = '';
    try { html = renderWxml(tpl, data).html; } catch (e) { html = 'ERR:' + e.message; }
    const okk = expect === '' ? html.trim() === '' : html.indexOf(expect) >= 0;
    ok(okk, '渲染器 · ' + label + (okk ? '' : '  期望含 ' + JSON.stringify(expect) + ' 实际 ' + JSON.stringify(html.slice(0, 120))));
  }
}

/* ---------- ② 真实 WXML 能完整渲染（不抛错、结构完整） ---------- */
{
  const wxmlSrc = fs.readFileSync(path.join(MP, 'pages', 'table', 'table.wxml'), 'utf8');
  const { rt, clock } = SCENES.find(s => s.name === 'ai-6p').build(VP);
  try {
    const data = JSON.parse(JSON.stringify(rt.dataStore));
    let html = '';
    try { html = renderWxml(wxmlSrc, data).html; } catch (e) { html = ''; }
    ok(html.length > 2000, '真实 table.wxml 渲染产出非空（' + html.length + ' 字节）');
    ok(html.indexOf('class="table-page') >= 0, '真实 WXML 渲染含 table-page 根节点');
    ok(html.indexOf('class="felt"') >= 0, '真实 WXML 渲染含 felt 容器');
    // 座位根节点：class 以 "seat" 开头但后面紧跟空格或引号（排除 seat-no/seat-meta 等子元素）
    const seatRoots = (html.match(/class="seat(?: [^"]*)?"/g) || []).length;
    ok(seatRoots === 6, '6 人桌渲染出 6 个座位根节点（实际 ' + seatRoots + '）');
  } finally {
    rt.stopTimers(); clock.restore(); rt.restore();
  }
}

/* ---------- ③ 场景数据必须随参数变化（防「所有截图一样」） ---------- */
{
  const sigs = new Map();
  for (const name of ['ai-2p', 'ai-5p', 'ai-6p', 'ai-7p', 'ai-8p', 'ai-9p']) {
    const scene = SCENES.find(s => s.name === name);
    const { rt, clock } = scene.build(VP);
    try {
      const d = rt.dataStore;
      // 指纹 = 座位数 + 全部座位坐标（几何回归看的正是这个）
      const coords = (d.seats || []).map(s => s ? s.x + ',' + s.y : '-').join(';');
      sigs.set(name, d.maxSeats + '|' + coords);
    } finally {
      rt.stopTimers(); clock.restore(); rt.restore();
    }
  }
  const uniq = new Set(sigs.values());
  ok(uniq.size === 6, '6 个场景的座位布局各不相同（唯一 ' + uniq.size + '/6；全同说明 max 参数没生效）');
  ok(/^8\|/.test(sigs.get('ai-8p')) && sigs.get('ai-8p').indexOf('26,38') >= 0,
    '8 人桌用 x=26 内侧位（防历史 x=10 交叠回归）');
  ok(/^9\|/.test(sigs.get('ai-9p')), '9 人桌 maxSeats=9');
}

/* ---------- ④ 渲染必须确定（防随机牌导致基线不稳） ---------- */
{
  const scene = SCENES.find(s => s.name === 'ai-6p');
  function fingerprint() {
    const { rt, clock } = scene.build(VP);
    try {
      const d = rt.dataStore;
      return JSON.stringify({
        pot: d.pot,
        board: (d.board || []).map(c => c && c.id),
        seats: (d.seats || []).map(s => s ? [s.x, s.y, s.stack] : null)
      });
    } finally {
      rt.stopTimers(); clock.restore(); rt.restore();
    }
  }
  const a = fingerprint();
  const b = fingerprint();
  ok(a === b, '同场景两次构造数据完全一致（牌种已固定，基线可比）');
}

/* ---------- ⑤ WXSS 单位换算正确 ---------- */
{
  const css = wxssToCss('.x{width:calc(13 * var(--uh));height:100rpx;top:calc(2 * var(--uw))}', VP);
  // uh = min(844,390)/100 = 3.9 ; rpx = 844/750 = 1.12533… ; uw = 8.44
  ok(css.indexOf('3.9000px') >= 0, 'WXSS · var(--uh) 按 min(w,h)/100 换算（3.9px）');
  ok(css.indexOf('112.533px') >= 0, 'WXSS · rpx 按宽/750 换算（100rpx=112.533px）');
  ok(css.indexOf('8.4400px') >= 0, 'WXSS · var(--uw) 按宽/100 换算（8.44px）');
  ok(css.indexOf('rpx') < 0, 'WXSS · 转换后不残留 rpx');
}

/* ---------- ⑥ PNG 解码与差异判定 ---------- */
{
  const pngs = fs.existsSync(path.join(__dirname, 'baseline'))
    ? fs.readdirSync(path.join(__dirname, 'baseline')).filter(f => f.endsWith('.png'))
    : [];
  if (pngs.length) {
    const buf = fs.readFileSync(path.join(__dirname, 'baseline', pngs[0]));
    let img = null;
    try { img = decodePng(buf); } catch (e) { img = null; }
    ok(img && img.width > 0 && img.height > 0, 'PNG 解码器可读基线图（' + (img ? img.width + 'x' + img.height : '失败') + '）');
    if (img) {
      const same = diffStats(img, img, 24);
      ok(same.diffRatio === 0 && same.maxBlobRatio === 0, 'PNG · 自身比对差异为 0');
    }
  } else {
    pass++;   // 无基线时跳过（首次 clone 未跑过 visual:update）
  }
}

/* ---------- ⑦ 截图脚本不得并入 npm test（无浏览器环境会红） ---------- */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const testScript = pkg.scripts.test || '';
  // 允许 selftest.js 进 npm test（纯 JS，不依赖浏览器）；
  // 但 run.js / compare.js 依赖 Chrome 与基线图，必须独立命令。
  ok(testScript.indexOf('visual/run.js') < 0 && testScript.indexOf('visual/compare.js') < 0,
    'npm test 不含截图/比对脚本（依赖本机 Chrome 与基线图，必须独立命令）');
  ok(testScript.indexOf('visual/selftest.js') >= 0,
    'npm test 含视觉回归自检（纯 JS，守渲染器与场景可信度）');
  ok(typeof pkg.scripts.visual === 'string' && pkg.scripts.visual.indexOf('run.js') >= 0,
    '存在独立 npm run visual 命令');
  ok(typeof pkg.scripts['visual:update'] === 'string',
    '存在独立 npm run visual:update 命令');
}

console.log('');
if (fail) {
  console.log('视觉回归自检: 通过 ' + pass + ' 项，失败 ' + fail + ' 项 ✗');
  process.exit(1);
}
console.log('视觉回归自检: 全部通过 ' + pass + ' 项 ✓');
