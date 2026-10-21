/**
 * 视觉回归 —— 基线比对
 *
 * 用法：
 *   node scripts/visual/compare.js --update     # 用当前 out/ 覆盖基线
 *   node scripts/visual/compare.js              # 与基线比对，超出阈值即失败
 *   node scripts/visual/compare.js --report     # 只打印各图统计，不判失败
 *
 * 判定口径（为什么不只是「像素差比例」）：
 * 视觉回归最容易犯的错是「阈值定得太松，改了也发现不了」或「太严，一点抗锯齿
 * 抖动就红」。这里同时看两个量：
 *   1. 变化像素占比（diffRatio）——整体是否变了；
 *   2. 变化区域是否**成块**（maxBlobRatio）——抗锯齿/字体渲染差异是零散细线，
 *      真实布局问题（座位挪位、元素被裁、遮挡）一定是连成大片的区域。
 * 只有「占比超阈值 且 成块」才判失败，能有效滤掉渲染抖动。
 *
 * 图像解码不引第三方库：PNG 解码用 zlib + 手写反滤波（Node 内置能力足够），
 * 保持仓库零新增依赖的约束。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, 'out');
const BASELINE = path.join(__dirname, 'baseline');

/* ------------------------------------------------------------------ *
 * 最小 PNG 解码器（仅支持 Chrome 截图产出的 8bit RGB/RGBA 非隔行 PNG）
 * ------------------------------------------------------------------ */

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8bit PNG，实际 ' + bitDepth);
  const channels = colorType === 6 ? 4 : (colorType === 2 ? 3 : (colorType === 0 ? 1 : 0));
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          val = v + pr;
          break;
        }
        default: throw new Error('未知滤波类型 ' + filter);
      }
      cur[x] = val & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

/* ------------------------------------------------------------------ *
 * 比对
 * ------------------------------------------------------------------ */

/** 逐像素求差，返回统计量 */
function diffStats(a, b, threshold) {
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, diffRatio: 1, maxBlobRatio: 1, changed: a.width * a.height };
  }
  const { width, height } = a;
  const n = width * height;
  const mask = new Uint8Array(n);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const oa = i * a.channels, ob = i * b.channels;
    const d = Math.abs(a.data[oa] - b.data[ob]) +
              Math.abs(a.data[oa + 1] - b.data[ob + 1]) +
              Math.abs(a.data[oa + 2] - b.data[ob + 2]);
    if (d > threshold) { mask[i] = 1; changed++; }
  }

  // 最大连通块（4 邻域，迭代式 BFS 避免递归爆栈）
  const seen = new Uint8Array(n);
  let maxBlob = 0;
  const queue = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[i] || seen[i]) continue;
    let head = 0, tail = 0;
    queue[tail++] = i;
    seen[i] = 1;
    let size = 0;
    while (head < tail) {
      const cur = queue[head++];
      size++;
      const x = cur % width, y = (cur - x) / width;
      if (x > 0 && mask[cur - 1] && !seen[cur - 1]) { seen[cur - 1] = 1; queue[tail++] = cur - 1; }
      if (x < width - 1 && mask[cur + 1] && !seen[cur + 1]) { seen[cur + 1] = 1; queue[tail++] = cur + 1; }
      if (y > 0 && mask[cur - width] && !seen[cur - width]) { seen[cur - width] = 1; queue[tail++] = cur - width; }
      if (y < height - 1 && mask[cur + width] && !seen[cur + width]) { seen[cur + width] = 1; queue[tail++] = cur + width; }
    }
    if (size > maxBlob) maxBlob = size;
  }

  return {
    sizeMismatch: false,
    diffRatio: changed / n,
    maxBlobRatio: maxBlob / n,
    changed
  };
}

/**
 * 阈值：像素差总和 > 24（约每通道 8）才算「变了」，滤掉编码抖动；
 * 变化像素 > 0.5% 且最大连通块 > 0.15% 判失败（座位挪位/遮挡一定远超此值，
 * 而抗锯齿细线连通块很小）。
 */
const DIFF_THRESHOLD = 24;
const RATIO_LIMIT = 0.005;
const BLOB_LIMIT = 0.0015;

function listPngs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
}

function main() {
  const argv = process.argv.slice(2);
  const doUpdate = argv.includes('--update');
  const reportOnly = argv.includes('--report');

  const pngs = listPngs(OUT);
  if (!pngs.length) {
    console.log('out/ 下没有 PNG。先跑: node scripts/visual/run.js');
    process.exit(1);
  }

  if (doUpdate) {
    fs.mkdirSync(BASELINE, { recursive: true });
    for (const f of pngs) {
      fs.copyFileSync(path.join(OUT, f), path.join(BASELINE, f));
    }
    console.log('已更新基线: ' + pngs.length + ' 张 → ' + BASELINE);
    return;
  }

  const baselinePngs = listPngs(BASELINE);
  if (!baselinePngs.length) {
    console.log('基线为空。先确认当前画面符合预期，再跑: node scripts/visual/compare.js --update');
    process.exit(1);
  }

  let fail = 0;
  let same = 0;
  let added = 0;
  for (const f of pngs) {
    const bp = path.join(BASELINE, f);
    if (!fs.existsSync(bp)) {
      console.log('  + ' + f + '  （基线中不存在，新增）');
      added++;
      continue;
    }
    const a = decodePng(fs.readFileSync(path.join(OUT, f)));
    const b = decodePng(fs.readFileSync(bp));
    const s = diffStats(b, a, DIFF_THRESHOLD);
    if (s.sizeMismatch) {
      console.log('  ✗ ' + f + '  尺寸不同');
      fail++;
      continue;
    }
    if (reportOnly) {
      console.log('  · ' + f + '  diff=' + (s.diffRatio * 100).toFixed(3) +
                  '%  blob=' + (s.maxBlobRatio * 100).toFixed(3) + '%');
      continue;
    }
    const bad = s.diffRatio > RATIO_LIMIT && s.maxBlobRatio > BLOB_LIMIT;
    if (bad) {
      fail++;
      console.log('  ✗ ' + f + '  diff=' + (s.diffRatio * 100).toFixed(2) +
                  '%  blob=' + (s.maxBlobRatio * 100).toFixed(2) + '%  ★ 画面有实质变化');
    } else if (s.changed > 0) {
      console.log('  ~ ' + f + '  diff=' + (s.diffRatio * 100).toFixed(3) +
                  '%  （渲染抖动，未超阈值）');
    } else {
      same++;
    }
  }

  const removed = baselinePngs.filter(f => !pngs.includes(f));
  if (removed.length) console.log('  - 基线中缺少的当前图: ' + removed.join(', '));

  console.log('');
  if (reportOnly) {
    console.log('报告模式：共 ' + pngs.length + ' 张');
    return;
  }
  if (fail) {
    console.log('视觉回归失败: ' + fail + ' 张有实质变化（一致 ' + same + '，新增 ' + added + '）');
    console.log('确认变化符合预期后，跑 node scripts/visual/compare.js --update 更新基线。');
    process.exit(1);
  }
  console.log('视觉回归通过: 完全一致 ' + same + ' 张' +
              (added ? '，新增 ' + added + ' 张' : '') +
              (pngs.length !== same + added ? '，其余为渲染抖动' : ''));
}

if (require.main === module) main();

module.exports = { decodePng, diffStats, DIFF_THRESHOLD, RATIO_LIMIT, BLOB_LIMIT };
