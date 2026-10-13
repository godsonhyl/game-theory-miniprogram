/**
 * WXML 静态检查
 *
 * 1) 标签闭合平衡：<view> … </view> 一一对应（历史事故：等待室漏 </view> 导致发布失败）
 * 2) 循环变量声明：wx:for 作用域内若使用别名（如 {{c.rank}}），必须声明 wx:for-item="c"
 *    （历史事故：底部 myzone 手牌漏 wx:for-item="c"，真机上两张牌渲染成空白白板）
 *
 * 用法：node scripts/check-wxml.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const VOID_TAGS = new Set(['image', 'input', 'icon', 'import', 'include', 'wxs', 'br']);
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const INTERP_RE = /\{\{([a-zA-Z_][\w]*)\./g;   // {{xx.yy}} 形式的点访问插值

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
  const src = fs.readFileSync(file, 'utf8');

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
  const forStack = [];      // 每层：{ tag, alias }
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
    checkText(text, forStack, rel, src, m.index);

    if (closing) {
      for (let i = forStack.length - 1; i >= 0; i--) {
        if (forStack[i].tag === tag) { forStack.splice(i); break; }
      }
      continue;
    }
    if (selfClose || VOID_TAGS.has(tag)) continue;

    if (/\bwx:for\s*=/.test(attrs)) {
      const am = /wx:for-item\s*=\s*"([^"]+)"/.exec(attrs);
      forStack.push({ tag: tag, alias: am ? am[1] : 'item' });
    }
  }
  checkText(src.slice(cursor), forStack, rel, src);
});

function checkText(text, forStack, rel, src, offset) {
  if (!forStack.length) return;                  // 不在循环内：点访问的是页面 data 对象，不限制
  const aliases = new Set(['item', 'index']);    // wx:for 默认名
  forStack.forEach(f => aliases.add(f.alias));
  INTERP_RE.lastIndex = 0;
  let m;
  while ((m = INTERP_RE.exec(text))) {
    const name = m[1];
    if (aliases.has(name)) continue;
    const line = src.slice(0, (offset || 0) + m.index).split('\n').length;
    failures.push(rel + ':' + line + '：循环体内使用了未声明的变量 {{' + name +
      '.…}}，需加 wx:for-item="' + name + '"（否则真机渲染为空白）');
    INTERP_RE.lastIndex = text.length;           // 同一段文本只报一次，避免刷屏
  }
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
