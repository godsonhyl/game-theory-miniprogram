// 复现 SNG「准备就绪」按钮：跑多手，每手结束进就绪→点 onReadyTap，验证 seatedOf 与 myReady
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
  pageCtx.onLoad({ mode: 'sng', blind: '3', level: 'advanced', max: '6' });
  pageCtx.sitSeat(0, 1000);
  if (pageCtx.addBot) pageCtx.addBot();
  await pageCtx.startGame();

  for (let h = 1; h <= 4; h++) {
    // 等本手结束
    let t = 0;
    while (!dataStore.result && t < 800) {
      await sleep(15);
      try { if (!dataStore.result) pageCtx.scheduleAI(); pageCtx.onCheckOrCall(); } catch (e) {}
      t++;
    }
    console.log('[hand %d end] result=%s handNo=%d', h, !!dataStore.result, dataStore.handNo);
    // 进就绪
    pageCtx.closeResultModal(true);
    const seatedBefore = pageCtx.seatedOf(pageCtx.mySeat);
    const msBefore = pageCtx.myStanding, psBefore = pageCtx.pendingSit;
    console.log('  [ready enter] readyPhase=%s seatedOf=%s myStanding=%s pendingSit=%s myReady=%s',
      dataStore.readyPhase, seatedBefore, msBefore, psBefore, dataStore.myReady);
    // 点准备就绪
    toasts.length = 0;
    pageCtx.onReadyTap();
    console.log('  [tap] myReady=%s toasts=%s', dataStore.myReady, JSON.stringify(toasts));
    // 把其余 bot 标记就绪 → 触发发下一手
    (dataStore.readyList || []).forEach(r => { if (!r.isMe) pageCtx.markReady(r.seat, true); });
    await sleep(50);
    console.log('  [after] readyPhase=%s handNo=%d (预期 handNo=%d)', dataStore.readyPhase, dataStore.handNo, h + 1);
  }
  console.log('=== DONE ===');
  process.exit(0);
})().catch(e => { console.error('SCRIPT ERR', e); process.exit(1); });
