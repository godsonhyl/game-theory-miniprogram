/**
 * 打包脚本：把小程序代码打成可分发 zip
 *
 * 用途：
 *   1. 交付给其他开发者（对方导入即可运行）
 *   2. CI 归档
 *   3. 上传前体积复核
 *
 * 用法：node pack.js
 * 产物：dist/texas-holdem-miniprogram-0.1.0.zip
 *
 * 实现说明：自实现 zip 写入（zlib deflateRaw + CRC32），
 * 不依赖系统 tar / 第三方压缩库，避免 Windows 下的 execSync EBUSY 问题。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const RULES = require('./scripts/pack-rules');

const SRC = path.join(__dirname, 'miniprogram');
const DIST = path.join(__dirname, 'dist');
const VERSION = '0.1.0';
const ZIP_NAME = `game-theory-miniprogram-${VERSION}.zip`;

// 排除清单单一来源：scripts/pack-rules.js（pack.js / upload.js /
// project.config.json 三处共用，check-pack-rules.js 校验无漂移）。
// 注意：node_modules 与 package.json 也不进包 —— 微信「构建 npm」时
// 依赖会被编译进 miniprogram_npm/（编译产物保留在包里，云 SDK 运行时靠它解析）。
const EXCLUDE_RULES = RULES;

/* ============================================================
 * 最小可用 ZIP 实现（store 或 deflate）
 * ========================================================== */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ (-1)) >>> 0;
}

/**
 * 生成 zip。
 * @param {Array<{name:string, data:Buffer}>} entries
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  entries.forEach(e => {
    const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(e.data);
    const raw = e.data;

    // 尝试压缩；压缩后反而更大则用 store
    let method = 0;
    let payload = raw;
    if (raw.length > 64) {
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }

    // local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // signature
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0x0800, 6);       // flags: UTF-8 filename
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);           // mod time
    lfh.writeUInt16LE(0x21, 12);        // mod date (1996-01-01, 固定值保证可复现)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, payload);

    // central directory entry
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);           // version made by
    cdh.writeUInt16LE(20, 6);           // version needed
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);           // extra
    cdh.writeUInt16LE(0, 32);           // comment
    cdh.writeUInt16LE(0, 34);           // disk number
    cdh.writeUInt16LE(0, 36);           // internal attrs
    cdh.writeUInt32LE(0, 38);           // external attrs
    cdh.writeUInt32LE(offset, 42);      // local header offset
    centrals.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + payload.length;
  });

  const centralBuf = Buffer.concat(centrals);

  // end of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function collect(dir, base = '') {
  const out = [];
  fs.readdirSync(dir).forEach(name => {
    // 排除名单同时作用于文件与目录（node_modules 等整棵子树跳过）
    if (EXCLUDE_RULES.shouldExclude(name)) return;
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...collect(full, rel));
    else out.push({ rel, full, size: st.size });
  });
  return out;
}

function main() {
  console.log('='.repeat(54));
  console.log('博弈论 · 打包');
  console.log('='.repeat(54));

  if (!fs.existsSync(SRC)) {
    console.error('未找到 miniprogram 目录');
    process.exit(1);
  }

  // 引擎完整性校验：引擎是核心，缺失必须阻断打包
  const coreFile = path.join(SRC, 'core', 'poker-core.js');
  if (!fs.existsSync(coreFile)) {
    console.error('\n✗ 缺少 core/poker-core.js，核心引擎不存在，拒绝打包');
    process.exit(1);
  }

  const files = collect(SRC);
  const total = files.reduce((s, f) => s + f.size, 0);
  const LIMIT = 2 * 1024 * 1024;

  console.log('源目录  : miniprogram/');
  console.log('文件数  : ' + files.length);
  console.log('总体积  : ' + (total / 1024).toFixed(1) + ' KB');
  console.log('包体积  : ' + (total / 1024 / 1024).toFixed(2) + ' MB / 2.00 MB' +
    (total < LIMIT ? '  ✓ 合规' : '  ✗ 超限'));
  console.log('-'.repeat(54));

  if (total >= LIMIT) {
    console.error('\n包体积超出小程序主包 2MB 限制，打包中止。');
    console.error('建议：把非核心页面拆为分包，或将大资源移至 CDN。');
    process.exit(1);
  }

  // 必需的页面四件套
  const appJson = JSON.parse(fs.readFileSync(path.join(SRC, 'app.json'), 'utf8'));
  const missing = [];
  appJson.pages.forEach(p => {
    ['js', 'json', 'wxml', 'wxss'].forEach(ext => {
      const f = path.join(SRC, p + '.' + ext);
      if (!fs.existsSync(f)) missing.push(p + '.' + ext);
    });
  });
  if (missing.length) {
    console.error('\n✗ 以下页面文件缺失，拒绝打包：\n  ' + missing.join('\n  '));
    process.exit(1);
  }
  console.log('✓ 页面完整性检查通过（' + appJson.pages.length + ' 个页面）');

  // 生成 zip
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST);
  const zipPath = path.join(DIST, ZIP_NAME);
  const entries = files.map(f => ({ name: f.rel, data: fs.readFileSync(f.full) }));
  const zipBuf = makeZip(entries);
  fs.writeFileSync(zipPath, zipBuf);

  const ratio = total > 0 ? (1 - zipBuf.length / total) * 100 : 0;
  console.log('\n' + '-'.repeat(54));
  console.log('✓ 打包完成');
  console.log('  产物    : dist/' + ZIP_NAME);
  console.log('  原始体积: ' + (total / 1024).toFixed(1) + ' KB');
  console.log('  压缩后  : ' + (zipBuf.length / 1024).toFixed(1) + ' KB  (压缩率 ' + ratio.toFixed(0) + '%)');
  console.log('  文件数  : ' + entries.length);
  console.log('');
  console.log('使用方式：');
  console.log('  1. 解压 zip');
  console.log('  2. 微信开发者工具 →「导入项目」→ 选择解压后的目录');
  console.log('  3. 填入你的 AppID → 开始开发');
  console.log('='.repeat(54) + '\n');
}

main();

