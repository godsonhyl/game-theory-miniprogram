/**
 * 打包/上传排除清单 —— 漂移校验（单一来源的「警察」）
 *
 * 排除清单唯一来源是 scripts/pack-rules.js；project.config.json 是静态 JSON
 * 没法 require 模块，就用本校验拦漂移：
 *   1. project.config.json 的 packOptions.ignore 必须与 pack-rules.devtoolsIgnores()
 *      完全一致（多一项少一项都算失败）；
 *   2. miniprogram 下实际存在的 test-*.js 必须都在 pack-rules.TEST_FILES 里
 *      （开发者工具不支持通配，漏登记的测试文件会进包；前缀兜底只救 pack.js/upload.js）；
 *   3. 云 SDK 产物必须不在任何排除清单里（排除 = 体验版白屏，历史事故）。
 *      形态已变过一次：miniprogram_npm/（构建 npm 产物）→ utils/vendor/（内联）。
 *
 * 用法：node scripts/check-pack-rules.js（纳进 npm test）
 */
const fs = require('fs');
const path = require('path');
const RULES = require('./pack-rules');

let failures = [];
let passes = 0;
function ok(cond, label) {
  if (cond) passes++;
  else failures.push(label);
}

/* ---------- 1) project.config.json 与单一来源逐项一致 ---------- */
const cfgPath = path.join(__dirname, '..', 'project.config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const expect = RULES.devtoolsIgnores();
const actual = (cfg.packOptions && cfg.packOptions.ignore) || [];
ok(JSON.stringify(actual) === JSON.stringify(expect),
  'project.config.json packOptions.ignore 与 pack-rules 一致' +
  (JSON.stringify(actual) === JSON.stringify(expect) ? '' :
    '\n        JSON 实际: ' + JSON.stringify(actual) + '\n        规则期望: ' + JSON.stringify(expect)));

/* ---------- 2) 实际存在的测试文件必须全部登记（开发者工具无通配） ---------- */
const MP = path.join(__dirname, '..', 'miniprogram');
const onDisk = fs.readdirSync(MP).filter(n => n.startsWith('test-') && n.endsWith('.js'));
const unregistered = onDisk.filter(n => RULES.TEST_FILES.indexOf(n) < 0);
ok(unregistered.length === 0,
  'miniprogram 下的 test-*.js 全部已登记进 pack-rules.TEST_FILES' +
  (unregistered.length ? '（漏登记：' + unregistered.join(', ') + '  会进开发者工具包）' : ''));

/* ---------- 3) 云 SDK 产物绝不被排除（历史事故：排除 = 体验版白屏） ---------- */
// 2026-10-17 起 SDK 以构建产物内联在 miniprogram/utils/vendor/workbuddy-cloud-sdk.js
// （去掉「构建 npm」环节，换机器 clone 即可上传）；早期形态是 npm 依赖 + 微信
// 「构建 npm」生成的 miniprogram_npm/。两种形态都不能进任何排除清单。
const allIgnores = [].concat(
  actual.map(x => x.value),
  RULES.ciIgnores()
);
ok(allIgnores.every(v => String(v).indexOf('miniprogram_npm') === -1),
  'miniprogram_npm 不在任何排除清单（SDK 的历史形态，排除会导致体验版白屏）');
ok(allIgnores.every(v => String(v).indexOf('vendor') === -1),
  'utils/vendor 不在任何排除清单（云 SDK 内联产物，排除会令 require 失败白屏）');
// pack.js 是按 basename 逐段调 shouldExclude 的，这两段都必须放行
ok(fs.existsSync(path.join(MP, 'utils/vendor/workbuddy-cloud-sdk.js')),
  '云 SDK 内联产物存在：miniprogram/utils/vendor/workbuddy-cloud-sdk.js');
ok(!RULES.shouldExclude('vendor') && !RULES.shouldExclude('workbuddy-cloud-sdk.js'),
  'shouldExclude 放行 vendor 目录与其下的 SDK 文件（pack.js 按 basename 逐段判定）');

/* ---------- 4) pack.js / upload.js 确实接上了单一来源 ---------- */
const packSrc = fs.readFileSync(path.join(__dirname, '..', 'pack.js'), 'utf8');
ok(packSrc.indexOf('pack-rules') >= 0 && packSrc.indexOf('shouldExclude') >= 0,
  'pack.js 通过 pack-rules.shouldExclude 排除');
const uploadSrc = fs.readFileSync(path.join(__dirname, '..', 'upload.js'), 'utf8');
ok(uploadSrc.indexOf('pack-rules') >= 0 && uploadSrc.indexOf('RULES.ciIgnores()') >= 0,
  'upload.js 通过 pack-rules.ciIgnores 排除');

/* ---------- 5) 入包前必须规范化行尾（.gitattributes 只管入库，管不到工作区） ---------- */
// 事故背景：仓库有 `* text=auto eol=lf` 保证入库是 LF，但 Windows 编辑器仍会把
// 工作区写成 CRLF，而 pack.js 读的正是工作区 → 包内行尾与仓库不一致。
// 后果：解压后与仓库 diff 整片红，分不清是真改动还是行尾噪音。
ok(/text=auto eol=lf/.test(
    fs.readFileSync(path.join(__dirname, '..', '.gitattributes'), 'utf8')),
  '.gitattributes 锁定 LF（* text=auto eol=lf）');
// 语义守卫：锁死 pack.js 里的 CRLF→LF 转换与去 BOM 两步都还在
ok(/replace\(\/\\r\\n\/g, '\\n'\)/.test(packSrc) && /replace\(\/\\r\/g, '\\n'\)/.test(packSrc),
  'pack.js 入包前把 CRLF / 裸 CR 统一转 LF');
ok(/0xEF && .*0xBB && .*0xBF/.test(packSrc),
  'pack.js 入包前剥掉 UTF-8 BOM（wcc 对 BOM 比对 CRLF 更敏感）');
// 体积报数口径：必须用规范化后的实际字节，而非 files[].size
ok(/entries\.reduce\(\(s, e\) => s \+ e\.data\.length, 0\)/.test(packSrc),
  'pack.js 体积按规范化后的实际入包字节统计（与 limit 判定的原始 size 口径不同）');

/**
 * ---- 发布体积守卫（2026-10-20：微信上传 errcode 80051 = 源码包超限）----
 * WorkBuddy 的「发布」按 miniprogram/ 目录整包上传，**不套用** pack.js 的排除
 * 清单。历史上 miniprogram/node_modules（86MB 构建残留）把上传包撑到 88MB，
 * 微信直接 80051（source size exceed limit），前端只显示「发布失败」。
 * 这里钉死两条：① 发布目录里不许出现 node_modules；② 源码总字节 < 2MB。
 */
{
  const mpRoot = path.join(__dirname, '..', 'miniprogram');
  ok(!fs.existsSync(path.join(mpRoot, 'node_modules')),
    'miniprogram/ 下无 node_modules（整包上传会算进去 → 80051 发布失败）');
  let bytes = 0;
  const walk = dir => {
    fs.readdirSync(dir).forEach(name => {
      if (name === 'node_modules') return;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else bytes += st.size;
    });
  };
  if (fs.existsSync(mpRoot)) walk(mpRoot);
  ok(bytes < 2 * 1024 * 1024,
    'miniprogram/ 源码体积 ' + (bytes / 1048576).toFixed(2) + ' MB < 2MB（微信主包上限）');
}

console.log('\n' + '='.repeat(52));
console.log('打包排除清单校验（单一来源：scripts/pack-rules.js）');
if (failures.length === 0) {
  console.log('全部通过：' + passes + ' 项断言 ✓');
  console.log('='.repeat(52) + '\n');
  process.exit(0);
} else {
  console.log('通过 ' + passes + ' 项，失败 ' + failures.length + ' 项：\n');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  console.log('='.repeat(52) + '\n');
  process.exit(1);
}
