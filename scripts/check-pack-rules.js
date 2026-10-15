/**
 * 打包/上传排除清单 —— 漂移校验（单一来源的「警察」）
 *
 * 排除清单唯一来源是 scripts/pack-rules.js；project.config.json 是静态 JSON
 * 没法 require 模块，就用本校验拦漂移：
 *   1. project.config.json 的 packOptions.ignore 必须与 pack-rules.devtoolsIgnores()
 *      完全一致（多一项少一项都算失败）；
 *   2. miniprogram 下实际存在的 test-*.js 必须都在 pack-rules.TEST_FILES 里
 *      （开发者工具不支持通配，漏登记的测试文件会进包；前缀兜底只救 pack.js/upload.js）；
 *   3. miniprogram_npm 必须不在任何排除清单里（排除 = 体验版白屏，历史事故）。
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

/* ---------- 3) miniprogram_npm 绝不被排除（历史事故：排除 = 白屏） ---------- */
const allIgnores = [].concat(
  actual.map(x => x.value),
  RULES.ciIgnores()
);
ok(allIgnores.every(v => String(v).indexOf('miniprogram_npm') === -1),
  'miniprogram_npm 不在任何排除清单（排除会导致体验版白屏）');

/* ---------- 4) pack.js / upload.js 确实接上了单一来源 ---------- */
const packSrc = fs.readFileSync(path.join(__dirname, '..', 'pack.js'), 'utf8');
ok(packSrc.indexOf('pack-rules') >= 0 && packSrc.indexOf('shouldExclude') >= 0,
  'pack.js 通过 pack-rules.shouldExclude 排除');
const uploadSrc = fs.readFileSync(path.join(__dirname, '..', 'upload.js'), 'utf8');
ok(uploadSrc.indexOf('pack-rules') >= 0 && uploadSrc.indexOf('RULES.ciIgnores()') >= 0,
  'upload.js 通过 pack-rules.ciIgnores 排除');

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
