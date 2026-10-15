/**
 * WXML 静态检查
 *
 * 1) 标签闭合平衡：<view> … </view> 一一对应（历史事故：等待室漏 </view> 导致发布失败）
 * 2) 循环变量声明：wx:for 作用域内若使用别名（如 {{c.rank}}），必须声明 wx:for-item="c"
 *    （历史事故：底部 myzone 手牌漏 wx:for-item="c"，真机上两张牌渲染成空白白板）
 *    —— 插值无论出现在文本位置还是属性位置（wx:if="{{c.rank}}" 一类）都要查：
 *    历史事故若写在属性位置，旧版检查器是盲的（2026-10-15 评审 MEDIUM）。
 *
 * 预处理：先剥离 <!-- … --> 注释——注释里的标签/插值是说明文字，不是要检查的
 * 结构，混进来会造成假阳性（多边形如 {{xx.yy}} 的解释性注释会被当成漏声明）。
 *
 * 用法：node scripts/check-wxml.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
// 微信官方 WXML 中不需要闭合标签的元素集（含表单控件与媒体元素）
const VOID_TAGS = new Set([
  'image', 'input', 'icon', 'import', 'include', 'wxs', 'br', 'hr',
  'progress', 'slider', 'switch', 'audio', 'video', 'camera', 'live-player', 'live-pusher',
  'canvas', 'map', 'web-view', 'ad', 'official-account', 'page-meta'
]);
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const INTERP_RE = /\{\{([a-zA-Z_][\w]*)\./g;   // {{xx.yy}} 形式的点访问插值
const ATTR_INTERP_RE = /"([^"]*)"/g;           // 属性值域，插值在这里同样会被解析

function walk(dir, out) {
  fs.readdirSync(dir).forEach(name => {
    if (name === 'node_modules' || name === 'miniprogram_npm') return;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.wxml')) out.push(p);
  });
  return out;
}

let failures = [];
let passes = 0;
function ok(cond, label) {
  if (cond) passes++;
  else failures.push(label);
}

const files = walk(ROOT, []);
ok(files.length > 0, 'miniprogram 下应能找到 wxml 文件，实际 ' + files.length);

files.forEach(file => {
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
  // 剥离注释：与其后检查用的正则保持一致的粒度（不支持注释嵌套，WXML 注释本就不可嵌套）
  const src = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');


  /* ---------- 1) 标签平衡 ---------- */
  const stack = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src))) {
    const closing = m[1] === '/';
    const tag = m[2];
    const selfClose = m[4] === '/';
    if (selfClose || VOID_TAGS.has(tag)) continue;
    if (!closing) stack.push(tag);
    else {
      if (!stack.length) { failures.push(rel + '：多余的闭合标签 </' + tag + '>'); continue; }
      const top = stack.pop();
      if (top !== tag) {
        failures.push(rel + '：标签交叉/不匹配，期望 </' + top + '> 实际 </' + tag + '>');
      }
    }
  }
  ok(stack.length === 0, rel + '：标签闭合平衡' + (stack.length ? '（未闭合：' + stack.join(',') + '）' : ''));

  /* ---------- 2) wx:for 别名必须声明 wx:for-item ---------- */
  // 作用域规则与 WXML 一致，两条关键点：
  //  a) 完整标签栈（不只是 wx:for 帧）——<view wx:for> 里还有普通 <view> 子元素，
  //     只记 wx:for 帧的话，子 </view> 会把 for 帧提前弹出，循环体内后半段变盲区；
  //  b) wx:for 的集合表达式（wx:for="{{c.rows}}"）在外层作用域求值，其余属性
  //     （wx:if/class/data-*）在内层，可引用本标签声明的别名。
  const tagStack = [];       // 每个开标签一层：{ tag, alias }，alias 为该标签 wx:for 声明的别名（无则 null）
  let cursor = 0;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    const text = src.slice(cursor, m.index);
    cursor = TAG_RE.lastIndex;

    const closing = m[1] === '/';
    const tag = m[2];
    const attrs = m[3] || '';
    const selfClose = m[4] === '/';

    // 文本总是落在「当前」for 作用域内（闭合标签前先用父作用域判断，再出栈）
    checkText(text, tagStack, rel, src, m.index);

    if (closing) {
      if (tagStack.length) tagStack.pop();   // 与规则 1 一致的严格栈：标签平衡已由规则 1 保障
      continue;
    }

    const attrsStart = m.index + m[0].indexOf(attrs);
    const forMatch = /\bwx:for\s*=\s*"([^"]*)"/.exec(attrs);
    if (forMatch) {
      // wx:for="{{…}}" 的值在入栈前求值，只能引用外层别名
      const vStart = attrsStart + forMatch.index + forMatch[0].indexOf('"') + 1;
      checkExpr(forMatch[1], vStart, tagStack, rel, src);
    }
    // 其余属性（wx:if / class / data-* …）在内层作用域求值，可引用本标签声明的别名
    const aliasMatch = forMatch ? /wx:for-item\s*=\s*"([^"]+)"/.exec(attrs) : null;
    const skipSpan = forMatch ? [forMatch.index, forMatch.index + forMatch[0].length] : null;
    if (!(selfClose || VOID_TAGS.has(tag))) {
      tagStack.push({ tag: tag, alias: forMatch ? (aliasMatch ? aliasMatch[1] : 'item') : null });
      checkAttrs(attrs, attrsStart, tagStack, rel, src, skipSpan);
    } else {
      // 自闭合/void 元素不开作用域：属性仍按当前（外层）作用域查
      checkAttrs(attrs, attrsStart, tagStack, rel, src, skipSpan);
    }
  }
  checkText(src.slice(cursor), tagStack, rel, src);
});

/**
 * 属性值域内的点访问插值检查（wx:if="{{a.b}}" 等属性位置，旧版是盲区）。
 * attrsStart 是 attrs 片段在 src 中的起始下标（报错行号用）；skipSpan 是其中
 * 不按当前作用域求值的片段（wx:for 的集合表达式，调用方已按外层单独查过）。
 */
function checkAttrs(attrs, attrsStart, tagStack, rel, src, skipSpan) {
  if (!tagStack.length) return;
  ATTR_INTERP_RE.lastIndex = 0;
  let am;
  while ((am = ATTR_INTERP_RE.exec(attrs))) {
    if (skipSpan && am.index >= skipSpan[0] && am.index < skipSpan[1]) continue;
    const vStart = attrsStart + am.index + 1;
    checkExpr(am[1], vStart, tagStack, rel, src);
  }
}

/** 对一段插值表达式文本查未声明的点访问变量（文本/属性位置共用） */
function checkExpr(expr, start, tagStack, rel, src) {
  // WXML 词法作用域：内层循环可见外层别名——栈上每一层 wx:for 声明的别名
  // 对其内部所有插值都可见；不在任何 wx:for 内时，点访问的是页面 data 对象，不限制。
  let inLoop = false;
  const aliases = new Set(['item', 'index']);       // wx:for 默认名
  for (let i = 0; i < tagStack.length; i++) {
    if (tagStack[i].alias !== null) { inLoop = true; aliases.add(tagStack[i].alias); }
  }
  if (!inLoop) return;
  INTERP_RE.lastIndex = 0;
  let im;
  while ((im = INTERP_RE.exec(expr))) {
    const name = im[1];
    if (aliases.has(name)) continue;
    const line = src.slice(0, start + im.index).split('\n').length;
    failures.push(rel + ':' + line + '：属性插值使用了未声明的变量 {{' + name +
      '.…}}，需加 wx:for-item="' + name + '"（否则真机渲染为空白）');
    INTERP_RE.lastIndex = expr.length;             // 同一段只报一次，避免刷屏
    break;
  }
}

function checkText(text, tagStack, rel, src, offset) {
  // 与 checkExpr 共用同一逻辑：文本插值的点访问变量同样必须在当前 for 作用域内已声明
  checkExpr(text, offset || 0, tagStack, rel, src);
}

console.log('\n' + '='.repeat(52));
if (failures.length === 0) {
  console.log('WXML 静态检查全部通过：' + passes + ' 项断言 ✓（' + files.length + ' 个文件）');
  console.log('='.repeat(52) + '\n');
  process.exit(0);
} else {
  console.log('通过 ' + passes + ' 项，失败 ' + failures.length + ' 项：\n');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  console.log('='.repeat(52) + '\n');
  process.exit(1);
}
