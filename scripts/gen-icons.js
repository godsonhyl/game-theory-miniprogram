/**
 * 生成精细线性图标，以 base64 data-uri 写入 app.wxss（小程序 WXSS background-image
 * 不支持本地 svg 文件路径，只能用 base64 data uri 或网络图，故采用 base64）。
 *
 * 运行：node scripts/gen-icons.js
 * 幂等：以标记行为界，重复运行只更新图标段、不重复追加。
 */
const fs = require('fs');
const path = require('path');

const APP_WXSS = path.join(__dirname, '..', 'miniprogram', 'app.wxss');
const MARK = '/* === 精细线性图标 (auto-generated) ===';

const GOLD = '#d9a441';
const LIGHT = '#a9c2b9';

const svgs = {
  friend: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c0-3 2.6-5.5 5.5-5.5S14.5 16 14.5 19"/><circle cx="17" cy="9" r="2.3"/><path d="M15.6 14.4c2.5.5 4.4 2.3 4.4 5.6"/></svg>`,
  ai: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="11" rx="2.5"/><path d="M12 8V4.6"/><circle cx="12" cy="3.6" r="1.1" fill="${GOLD}" stroke="none"/><circle cx="9.3" cy="13.2" r="1.2"/><circle cx="14.7" cy="13.2" r="1.2"/><path d="M9.3 16.6h5.4"/></svg>`,
  rank: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2.5 4.5 13.8H10l-1 7.7 9-12.2h-5.5z"/></svg>`,
  cards: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="11" height="14" rx="2"/><rect x="9.5" y="3.5" width="11" height="14" rx="2"/></svg>`,
  back: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${LIGHT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6 8 12l6.5 6"/></svg>`,
  chevron: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${LIGHT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>`,
  trophy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7.5 5H4.8v2a3 3 0 0 0 2.7 3"/><path d="M16.5 5h2.7v2a3 3 0 0 1-2.7 3"/><path d="M12 13v3.4"/><path d="M9.6 21h4.8"/><path d="M10.2 17h3.6v4h-3.6z"/></svg>`,
  spade: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c-2.6 2.8-5.4 5.6-5.4 8.6a3 3 0 0 0 5.4 1.6c-.3-.6-.5-1.2-.5-1.9 1 .8 2.5.8 3.5 0-.1.7-.2 1.3-.5 1.9a3 3 0 0 0 5.4-1.6C17.4 8.6 14.6 5.8 12 3z"/><path d="M12 15.4V21"/><path d="M9 21h6"/></svg>`,
  share: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="2.4"/><circle cx="17.6" cy="6" r="2.4"/><circle cx="17.6" cy="18" r="2.4"/><path d="M8.3 10.9l7.3-3.7M8.3 13.1l7.3 3.7"/></svg>`
};

function b64(s) {
  return Buffer.from(s).toString('base64');
}

let css = `\n${MARK} */\n`;
css += '.ic { background-repeat: no-repeat; background-position: center; background-size: contain; display: block; }\n';
for (const [k, v] of Object.entries(svgs)) {
  css += `.ic-${k} { background-image: url("data:image/svg+xml;base64,${b64(v)}"); }\n`;
}

let cur = fs.readFileSync(APP_WXSS, 'utf8');
const idx = cur.indexOf(MARK);
if (idx >= 0) cur = cur.slice(0, idx).replace(/\s*$/, '');
cur = cur + css;

fs.writeFileSync(APP_WXSS, cur);
console.log('已写入图标：', Object.keys(svgs).join(', '));
console.log('app.wxss 体积:', (Buffer.byteLength(cur) / 1024).toFixed(1) + ' KB');
