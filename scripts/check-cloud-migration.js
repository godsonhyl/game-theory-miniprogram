/**
 * 云端迁移落地检查（服务端权威化的护栏）
 *
 * 背景：commit ce1516a 起把 auth.js 的写入口陆续改成调用云端 rpc（现为 9 个），
 * 但**数据库迁移没有同步执行**过一次 —— 客户端调用时 rpc 根本不存在。
 * 而 auth.js 对 rpc 失败是 `throw` 无降级，导致建房扣卡 / 每日领卡等核心流程直接失败。
 *
 * ⚠️ npm test 查不出这类问题：测试 mock 掉了 cloud 层，rpc 不存在照样全绿。
 * 本脚本因此做两件事：
 *   1) 静态守卫：auth.js 调用的每个 rpc 名，都必须在 migrations/ 里能找到
 *      对应的 CREATE FUNCTION（契约对齐，防止改名失联）
 *   2) 运行时校验：给一条 SQL，粘到云端执行即可确认函数真的存在
 *
 * 用法：
 *   node scripts/check-cloud-migration.js          # 只跑静态守卫
 *   node scripts/check-cloud-migration.js --sql    # 额外打印待执行的验证 SQL
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 云端应用 ID 不写死：cloud.js 的 publishableKey 形如 wbpk_<appId>_<secret>。
// 应用被整体替换过一次（2026-10-17），写死会让本脚本打印的验证 SQL 一直指向
// 已废弃的旧应用 —— 对着错的应用验证，结论再漂亮也是假的。
const cloudSrc = (() => {
  try { return fs.readFileSync(path.join(ROOT, 'miniprogram/utils/cloud.js'), 'utf8'); }
  catch (e) { return ''; }
})();
const APP_ID = (cloudSrc.match(/wbpk_([A-Za-z0-9]+)_/) || [])[1] || '';

const failures = [];
let passes = 0;
const ok = (cond, label) => { if (cond) passes++; else failures.push(label); };

/* ---------- 1) 提取 auth.js 实际调用的 rpc 名 ---------- */
const authPath = path.join(ROOT, 'miniprogram/utils/auth.js');
const authSrc = fs.readFileSync(authPath, 'utf8');
const called = [];
// 提取正则曾经的盲区（2026-10-19 修复）：auth.js 里 rpc 调用有两种形态——
// 同表达式 `cloud.database.rpc('...')`（4 处，001 迁移那批）与链式换行
// `.rpc('...')`（5 处，002 迁移那批：close_room/list_my_rooms/save_hand_replay/
// list_room_replays/purge_room）。旧正则只认 `database\.rpc\(`，链式形态全部漏提，
// 护栏对这 5 个改名失联不放哨。放宽为 `\.rpc\(` 两种都收。
const rpcRe = /\.rpc\(\s*'([^']+)'/g;
let m;
while ((m = rpcRe.exec(authSrc))) called.push(m[1]);

ok(called.length > 0, 'auth.js 至少调用了一个 rpc（否则本检查失去意义）');
ok(new Set(called).size === called.length, 'auth.js 的 rpc 调用无重复名');

/* ---------- 2) 每个 rpc 都必须在 migrations/ 里有 CREATE FUNCTION ---------- */
const migDir = path.join(ROOT, 'migrations');
let migFiles = [];
try { migFiles = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')); } catch (e) { migFiles = []; }
ok(migFiles.length > 0, 'migrations/ 目录存在且有 .sql 文件');

const migText = migFiles
  .map(f => { try { return fs.readFileSync(path.join(migDir, f), 'utf8'); } catch (e) { return ''; } })
  .join('\n');

[...new Set(called)].sort().forEach(fn => {
  // 允许 CREATE OR REPLACE FUNCTION public.<name>( 或 FUNCTION <name>(
  const re = new RegExp('CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?' + fn + '\\s*\\(');
  ok(re.test(migText), 'rpc `' + fn + '` 在 migrations/ 里有对应 CREATE FUNCTION（否则客户端调用必失败）');
});

/* ---------- 3) 每个 rpc 都有 SECURITY DEFINER（否则列权限收口后写不进去） ---------- */
[...new Set(called)].sort().forEach(fn => {
  // 取该函数定义后紧跟的选项串
  const re = new RegExp(
    'CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?' + fn + '\\s*\\([\\s\\S]*?\\)\\s*RETURNS[^$]*?AS\\s*\\$[^$]*\\$',
    'i');
  const def = migText.match(re);
  if (!def) return;   // 定义缺失已在上一条断言报出，不重复计数
  ok(/SECURITY\s+DEFINER/i.test(def[0]),
    'rpc `' + fn + '` 声明了 SECURITY DEFINER（列权限收口后靠它绕过写限制）');
});

/* ---------- 4) 列权限收口必须按「先撤表级、再按列授权」的顺序 ---------- */
// PostgreSQL 陷阱：列级 REVOKE 是无效的（列级权限是追加授权不是限制），
// 必须先 REVOKE 表级 UPDATE，再 GRANT 具体列。锁死这个形态防止回退。
ok(/REVOKE\s+UPDATE\s+ON\s+public\.poker_profiles\s+FROM\s+authenticated/i.test(migText),
  '迁移里有「先撤表级 UPDATE」这一步（列级 REVOKE 在 PG 下无效，只撤列等于没撤）');
ok(/GRANT\s+UPDATE\s*\(\s*nickname\s*,\s*avatar_url\s*\)\s+ON\s+public\.poker_profiles\s+TO\s+authenticated/i.test(migText),
  '迁移里按列重新授权 nickname/avatar_url（收口后客户端只能改这两列）');

/* ---------- 5) 流水表与幂等唯一键 ---------- */
ok(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?public\.poker_card_ledger/i.test(migText),
  '迁移里有流水表 poker_card_ledger');
ok(/UNIQUE\s+INDEX[\s\S]*?poker_card_ledger[\s\S]*?\(\s*owner_id\s*,\s*token\s*\)/i.test(migText),
  '流水表有 (owner_id, token) 唯一键做幂等（同 token 重发不二次扣/发）');

/* ---------- 输出 ---------- */
const showSql = process.argv.includes('--sql');
if (showSql) {
  const fns = [...new Set(called)].sort();
  console.log('\n' + '-'.repeat(62));
  console.log('待在云端执行的验证 SQL（应用 ' +
    (APP_ID || '见 miniprogram/utils/cloud.js 的 publishableKey') + '）');
  console.log('-'.repeat(62));
  console.log('\n-- 1) 函数是否真的存在（应看到 ' + fns.length + ' 行，prosecdef 全 true）');
  console.log("SELECT p.proname AS fn, pg_get_function_identity_arguments(p.oid) AS args,");
  console.log("       p.prosecdef AS security_definer");
  console.log("  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace");
  console.log(" WHERE n.nspname = 'public' AND p.proname LIKE 'poker%' ORDER BY p.proname;\n");
  console.log('-- 2) 权限矩阵（profile_update_table 必须为 false）');
  console.log("SELECT has_table_privilege('authenticated','public.poker_profiles','UPDATE') AS profile_update_table,");
  console.log("       has_table_privilege('authenticated','public.poker_profiles','INSERT') AS profile_insert,");
  console.log("       has_table_privilege('authenticated','public.poker_card_ledger','SELECT') AS ledger_select;");
  console.log('');
}

console.log('\n' + '='.repeat(56));
console.log('云端迁移落地检查（auth.js 调用 ' + new Set(called).size + ' 个 rpc）');
if (failures.length === 0) {
  console.log('全部通过：' + passes + ' 项断言 ✓');
  if (!showSql) console.log('提示：加 --sql 可打印云端验证 SQL');
  console.log('='.repeat(56) + '\n');
  process.exit(0);
} else {
  console.log('通过 ' + passes + ' 项，失败 ' + failures.length + ' 项：\n');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  console.log('='.repeat(56) + '\n');
  process.exit(1);
}
