/**
 * 重新压缩 vendor SDK（只去注释/空白，不改语义、不改名）。
 *
 * 为什么需要：WorkBuddy「发布」会把 miniprogram/ 里的 .js 用 babel 降到 iOS10
 * （compact:false，且保留注释），体积放大约 1.37×。微信对**单文件**上限 512KB，
 * SDK 原始 507KB 时 babel 后 530KB → errcode 80051（前端只显示「发布失败」）。
 *
 * 触发场景：升级 @tencent-ai/workbuddy-cloud-sdk 后，把新的构建产物放回
 * `miniprogram/utils/vendor/workbuddy-cloud-sdk.js`，然后跑本脚本。
 *
 * 用法：npm install（提供 terser）→ node scripts/minify-vendor.js
 * 守卫：scripts/check-pack-rules.js 要求该文件 < 360KB（babel 后 < 512KB）。
 */
const fs = require('fs');
const path = require('path');

let terser;
try {
  terser = require('terser');
} catch (e) {
  console.error('[minify-vendor] 缺少 terser：请先在项目根执行 npm install');
  process.exit(1);
}

(async () => {
  const file = path.join(__dirname, '..', 'miniprogram', 'utils', 'vendor', 'workbuddy-cloud-sdk.js');
  const src = fs.readFileSync(file, 'utf8');
  // compress/mangle 全关：只做「去注释 + 压空白」，不改变任何标识符与语义。
  // 保留 license/copyright 注释以满足合规。
  const r = await terser.minify(src, {
    compress: false,
    mangle: false,
    output: { comments: /@license|@preserve|copyright/i }
  });
  if (r.error) throw r.error;
  fs.writeFileSync(file, r.code);
  const kb = (Buffer.byteLength(r.code) / 1024).toFixed(1);
  console.log('[minify-vendor] 完成：' + kb + 'KB（babel 到 iOS10 后约 ' + (kb * 1.37).toFixed(0) + 'KB，上限 512KB）');
})().catch(e => {
  console.error('[minify-vendor] 失败：' + (e && e.message));
  process.exit(1);
});
