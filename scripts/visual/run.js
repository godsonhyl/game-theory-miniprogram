/**
 * 视觉回归 —— 主驱动
 *
 * 用法：
 *   node scripts/visual/run.js                  # 渲染全部场景到 scripts/visual/out/
 *   node scripts/visual/run.js --only ai-8p     # 只跑一个场景
 *   node scripts/visual/run.js --update         # 覆盖基线（确认改动符合预期后）
 *   node scripts/visual/run.js --diff           # 与基线比对，输出差异统计
 *
 * 为什么用 Chrome --headless --screenshot 而不引 puppeteer：
 * 本仓库零构建步骤、依赖越少越好（miniprogram/ 下禁止 node_modules 是硬约束）。
 * Chrome/Edge 是 Windows 与 macOS 常见自带组件，用它的命令行截图能力即可，
 * 不新增任何 npm 依赖。找不到浏览器时脚本降级为「只产出 HTML」并给出提示。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { renderWxml } = require('./wxml-render');
const { wxssToCss, buildHtml } = require('./wxss-render');
const { SCENES } = require('./scenes');

const ROOT = path.resolve(__dirname, '..', '..');
const MP = path.join(ROOT, 'miniprogram');
const OUT = path.join(__dirname, 'out');
const BASELINE = path.join(__dirname, 'baseline');

/**
 * 视口档位。
 * feltUh 是 measureFelt() 会实测到的 .felt 高度（uh）——本仓库几何逻辑的关键输入，
 * 三档覆盖「窄缝 / 实测常态 / 极端全屏」。
 */
const VIEWPORTS = [
  { key: 'land-844x390', width: 844, height: 390, feltUh: 65.9, desc: '横屏 844×390（iPhone 12 等）' },
  { key: 'land-780x360', width: 780, height: 360, feltUh: 65.9, desc: '横屏 780×360（小屏）' },
  { key: 'land-926x428', width: 926, height: 428, feltUh: 65.9, desc: '横屏 926×428（大屏）' }
];

/* ------------------------------------------------------------------ */

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 忽略 */ }
  }
  return null;
}

let chromePath = null;

function screenshot(htmlPath, pngPath, vp) {
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=' + vp.width + ',' + vp.height,
    '--screenshot=' + pngPath,
    'file:///' + htmlPath.replace(/\\/g, '/')
  ];
  execFileSync(chromePath, args, { stdio: 'ignore', timeout: 60000 });
  return fs.existsSync(pngPath);
}

/* ------------------------------------------------------------------ */

function buildScene(scene, vp) {
  const { rt, clock } = scene.build(vp);
  try {
    if (typeof scene.after === 'function') scene.after(rt, clock);
    // 确保根变量与数据一致（updateViewport 会按视口写 --uh/--uw）
    try { rt.pageCtx.updateViewport(); } catch (e) { /* 无该方法则跳过 */ }
    // 快照前再推进一小步，让 quick 路径的坐下/发牌真正落定
    try { clock.advance(50); } catch (e) { /* 已停表 */ }
    return JSON.parse(JSON.stringify(rt.dataStore));
  } finally {
    try { rt.stopTimers(); } catch (e) { /* 收尾 */ }
    try { clock.restore(); } catch (e) { /* 收尾 */ }
    rt.restore();
  }
}

function renderOne(scene, vp) {
  const wxmlSrc = fs.readFileSync(path.join(MP, 'pages', 'table', 'table.wxml'), 'utf8');
  const wxssSrc = fs.readFileSync(path.join(MP, 'pages', 'table', 'table.wxss'), 'utf8');

  const data = buildScene(scene, vp);
  const { html: bodyHtml } = renderWxml(wxmlSrc, data);
  const css = wxssToCss(wxssSrc, vp);
  const doc = buildHtml(bodyHtml, css, vp);

  const base = scene.name + '--' + vp.key;
  fs.mkdirSync(OUT, { recursive: true });
  const htmlPath = path.join(OUT, base + '.html');
  fs.writeFileSync(htmlPath, doc, 'utf8');

  let pngPath = null;
  if (chromePath) {
    pngPath = path.join(OUT, base + '.png');
    screenshot(htmlPath, pngPath, vp);
  }
  return { base, htmlPath, pngPath, data };
}

/* ------------------------------------------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const doUpdate = argv.includes('--update');
  const doDiff = argv.includes('--diff');

  chromePath = findChrome();
  if (!chromePath) {
    console.log('⚠️ 未找到 Chrome/Edge，将只产出 HTML（可用浏览器手动打开）。');
    console.log('   设置环境变量 CHROME_PATH 指向浏览器可执行文件即可自动截图。\n');
  } else {
    console.log('浏览器: ' + chromePath + '\n');
  }

  const scenes = only ? SCENES.filter(s => s.name === only) : SCENES;
  if (!scenes.length) {
    console.log('没有匹配的场景: ' + only);
    process.exit(1);
  }

  let ok = 0;
  let failed = 0;
  for (const scene of scenes) {
    for (const vp of VIEWPORTS) {
      try {
        const r = renderOne(scene, vp);
        ok++;
        const png = r.pngPath ? '' : '（无 PNG）';
        console.log('  ✓ ' + r.base + png);
      } catch (e) {
        failed++;
        console.log('  ✗ ' + scene.name + '--' + vp.key + ' : ' + e.message);
      }
    }
  }

  console.log('\n渲染完成: 成功 ' + ok + '，失败 ' + failed);
  console.log('输出目录: ' + OUT);
  if (doUpdate) console.log('\n基线更新请运行: node scripts/visual/compare.js --update');
  if (doDiff) console.log('\n像素比对请运行: node scripts/visual/compare.js');

  if (failed) process.exit(1);
}

if (require.main === module) main();

module.exports = { VIEWPORTS, findChrome, renderOne, OUT, BASELINE };
