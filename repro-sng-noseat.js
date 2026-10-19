// 复现 SNG「自己不坐下、直接加 bot 开始」→ 准备就绪按钮失效
const path = require('path');
global.__storage = {};
global.getApp = () => ({ globalData: { roomCards: 12, userInfo: null }, consumeRoomCard: () => true });
let currentPage = null;
global.Page = cfg => { currentPage = cfg; };
const toasts = [];
global.wx = {
  login: ({ success }) => success({ code: 'mock' }),
  request: () => {}, setStorageSync: (k, v) => { global.__storage[k] = v; },
  getStorageSync: k => global.__storage[k], removeStorageSync: k => { delete global.__storage[k]; },
  showToast: o => { toasts.push(o.title); },
  showModal: o => { const m = global.__modalMode; if (m === 'confirm' && o.success) o.success({ confirm: true }); else if (m === 'cancel' && o.success) o.success({ confirm: false, cancel: true }); else if (m === 'fail' && o.fail) o.fail(); },
  navigateTo: () => {}, navigateBack: () => {}, reLaunch: () => {},
  setClipboardData: () => {}, getUserProfile: () => {}, showShareMenu: () => {},
  showLoading: () => {}, hideLoading: () => {}, setPageOrientation: () => {},
  getWindowInfo: () => ({ windowWidth: 812, windowHeight: 375 }), vibrateShort: () => {}
};
require(path.join(__dirname, 'miniprogram', 'pages', 'table', 'table.js'));
const cfg = currentPage;
const dataStore = Object.assign({}, cfg.data || {});
function setData(patch) { Object.assign(dataStore, patch); }
const pageCtx = Object.assign({}, cfg, { data: dataStore, setData });

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 进 SNG 等待室
  pageCtx.onLoad({ mode: 'sng', blind: '3', level: 'advanced', max: '6' });
  console.log('[onLoad] phase=%s mySeat=%d canStart=%s', dataStore.phase, pageCtx.mySeat, dataStore.canStart);

  // 关键：不 sitSeat，直接加 2 个 bot
  if (pageCtx.addBot) pageCtx.addBot();
  if (pageCtx.addBot) pageCtx.addBot();
  const seats = dataStore.waitSeats;
  const occ = seats.filter(s => s.occupied);
  console.log('[after 2 bots] occupied=%d meInSeats=%s canStart=%s',
    occ.length, occ.some(s => s.isMe), dataStore.canStart);

  // 直接开始（本人未坐下）
  await pageCtx.startGame();
  console.log('[startGame] phase=%s mySeat=%d (mySeat 应指向 game 里真实座位；若仍=0 且 game 无 me 即畸形局)',
    dataStore.phase, pageCtx.mySeat);
  console.log('[startGame] seatedOf(mySeat)=%s myStanding=%s pendingSit=%s',
    pageCtx.seatedOf(pageCtx.mySeat), pageCtx.myStanding, pageCtx.pendingSit);

  // 直接进就绪阶段
  pageCtx.enterReadyPhase();
  const rl = dataStore.readyList || [];
  const meInReady = rl.filter(x => x.isMe);
  console.log('[ready enter] readyPhase=%s readyList 人数=%d 其中 me=%d',
    dataStore.readyPhase, rl.length, meInReady.length);
  console.log('[ready enter] 按钮渲染条件 mySeated=%s (true 则按钮显示但 me 不在 list)', dataStore.mySeated);

  // 点「准备就绪」
  toasts.length = 0;
  pageCtx.onReadyTap();
  console.log('[tap 准备就绪] myReady=%s (预期若 me 不在 list 则恒 false，按钮「点了没反应」) toasts=%s',
    dataStore.myReady, JSON.stringify(toasts));

  // 模拟 bot 自动就绪 → 是否不等我直接发下一手
  rl.forEach(r => { if (!r.isMe) pageCtx.markReady(r.seat, true); });
  await sleep(60);
  console.log('[bot 就绪后] readyPhase=%s (若 false 说明已自动发下一手，彻底绕过我的点击)', dataStore.readyPhase);

  console.log('=== DONE ===');
  process.exit(0);
})().catch(e => { console.error('SCRIPT ERR', e); process.exit(1); });
