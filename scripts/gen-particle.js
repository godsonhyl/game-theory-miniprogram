/**
 * 生成牌桌氛围特效用的粒子贴图（唯一引入的资源，评审 2026-10-15 设计文档 §2.2）。
 *
 * 产出 miniprogram/assets/spark.png：48×48 RGBA，金色柔光，中心亮边缘透明，
 * 供赢牌星光粒子动画做 background-image（CSS animation 驱动位移，不逐帧 JS）。
 * 体积 < 2KB，包体积红线 2MB 余量充足（当前包 ~883KB）。
 *
 * 用法：node scripts/gen-particle.js（幂等，已存在则覆盖）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 48, H = 48;
const cx = (W - 1) / 2, cy = (H - 1) / 2;
const maxR = Math.min(W, H) / 2;

// 金色 (255,217,138) 径向衰减：中心 alpha=1，边缘 →0，平滑过渡
const R = 255, G = 217, B = 138;
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;                 // 滤镜字节（0 = None）
  for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy) / maxR;     // 0..~1.4
    // smoothstep 反向：中心 1、边缘 0，超过 1 迅速归零
    let a = 1 - Math.min(1, d);
    a = a * a * (3 - 2 * a);                             // smoothstep
    a = Math.pow(a, 1.6) * 255;                          // 略压暗外圈，更聚光
    const o = y * (W * 4 + 1) + 1 + x * 4;
    raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = Math.round(a);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

// PNG CRC32（标准多项式）
const crcTable = (() => {
  const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t.push(c); } return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

const outDir = path.join(__dirname, '..', 'miniprogram', 'assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'spark.png');
fs.writeFileSync(out, png);
console.log('生成 ' + out + ' (' + png.length + ' bytes)');
