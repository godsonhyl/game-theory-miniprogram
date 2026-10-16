/**
 * JS 语法静态检查（npm test 第九套件之后新增）
 *
 * 为什么需要它：miniprogram/pages/profile/profile.js 曾带着一个语法错误
 * （对象字面量里 loadRecords 方法结尾漏了逗号）进包，而 npm test 的九套件
 * **全部通过** —— 因为测试只 require 入口跑逻辑，从不校验文件本身能否被解析。
 * 开发者工具里该页只是白屏/不生效，也不报红；只有点「上传」时才炸：
 *   pages/profile/profile.js:109:3: Unexpected token, expected "..."
 * 而报错位置（109）离真正的病根（105 缺逗号）差了 4 行，极难定位。
 *
 * 检查手段：`new vm.Script(src)` —— 与 Node 加载该文件用的是同一套 V8 解析器，
 * 等价于 `node --check`，但能直接拿行号，无需为每个文件起子进程。
 *
 * 覆盖范围：miniprogram/** + core/*.js（引擎双副本都要过）。
 * 注意：不覆盖 miniprogram_npm（第三方构建产物，体积大且不由我们维护）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const failures = [];
let count = 0;

/** 递归收集 .js 文件（跳过 node_modules / miniprogram_npm / dist） */
function collect(dir, acc) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return acc; }
  names.forEach(n => {
    if (n === 'node_modules' || n === 'miniprogram_npm' || n === 'dist' || n === '.git') return;
    const full = path.join(dir, n);
    let st;
    try { st = fs.statSync(full); } catch (e) { return; }
    if (st.isDirectory()) collect(full, acc);
    else if (n.endsWith('.js')) acc.push(full);
  });
  return acc;
}

const targets = [];
collect(path.join(ROOT, 'miniprogram'), targets);
collect(path.join(ROOT, 'core'), targets);

targets.sort().forEach(full => {
  const rel = path.relative(ROOT, full).replace(/\\/g, '/');
  count++;
  let src;
  try {
    src = fs.readFileSync(full, 'utf8');
  } catch (e) {
    failures.push(rel + ' 读取失败：' + e.message);
    return;
  }
  // 去掉 UTF-8 BOM —— 否则 V8 会把它报成非法字符，掩盖真正的问题
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
  try {
    new vm.Script(src, { filename: rel });
  } catch (e) {
    // e.stack 首行形如 "rel:109\n  loadStyleAnalysis() {\n  ^^^"
    const head = (e.stack || e.message || String(e)).split('\n').slice(0, 3).join('\n      ');
    failures.push(rel + ' 语法错误：' + e.message + '\n      ' + head);
  }
});

console.log('\n' + '='.repeat(56));
console.log('JS 语法检查（V8 解析器，覆盖 ' + count + ' 个文件）');
if (failures.length === 0) {
  console.log('全部通过：' + count + ' 个文件语法正确 ✓');
  console.log('='.repeat(56) + '\n');
  process.exit(0);
} else {
  console.log('失败 ' + failures.length + ' 项：\n');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  console.log('='.repeat(56) + '\n');
  process.exit(1);
}
