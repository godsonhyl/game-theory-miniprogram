// 复现 SNG「本人不坐下」场景：验证两件事
//  1) 开局后 mySeat 指向 me 玩家（不是林小满 bot 座位）
//  2) 每手结束进就绪 → 点「准备就绪」→ 下一手能正常发出（含第二手起）
const path = require('path');
// 压缩所有 setTimeout 延迟（AI 决策 620ms / bot 就绪 1.5~4s / 自动代点 3s）→ ≤8ms，
// 既保留异步让事件循环喘息，又避免「无限定时器风暴」导致手跑不完卡死
const _st = global.setTimeout.bind(global);
global.setTimeout = (fn, d, ...a) => _st(fn, Math.min(d || 0, 8), ...a);
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
const sleep = ms => new Promise(r => _st(r, Math.max(ms, 8)));

function whoIsMe() {
  // render 把「我」写进 dataStore.seats（buildSeats 用 this.mySeat 标记），
  // 找 name 为本人（微信昵称 / 「你」）的座位；同时打印实例 mySeat
  const seats = dataStore.seats || [];
  const meSeats = seats.filter(s => s.isMe).map(s => `#${s.seat}:${s.name}`);
  return { mySeat: pageCtx.mySeat, meSeats };
}

(async () => {
  pageCtx.onLoad({ mode: 'sng', blind: '3', level: 'advanced', max: '6' });
  pageCtx.addBot();
  pageCtx.addBot();
  await pageCtx.startGame();
  let w = whoIsMe();
  console.log('[开局] mySeat=%s | data.seats 中 isMe: %s', w.mySeat, JSON.stringify(w.meSeats));
  console.log('[开局] game.players 名字(来自 requireGame 不可直接读，看 data.seats):',
    JSON.stringify((dataStore.seats || []).map(s => `#${s.seat}:${s.name}`)));

  for (let h = 1; h <= 3; h++) {
    let t = 0;
    while (!dataStore.result && t < 4000) {
      await sleep(8);
      try { pageCtx.scheduleAI(); pageCtx.onCheckOrCall(); } catch (e) {}
      t++;
    }
    console.log('[第%d手结束] result=%s handNo=%d', h, !!dataStore.result, dataStore.handNo);
    // 进就绪
    pageCtx.closeResultModal(true);
    const seated = pageCtx.seatedOf(pageCtx.mySeat);
    const rl = dataStore.readyList || [];
    const meInList = rl.some(x => x.isMe);
    console.log('  [进就绪] readyPhase=%s seatedOf(mySeat)=%s readyList人数=%d 含我(me项)=%s',
      dataStore.readyPhase, seated, rl.length, meInList);
    // 点准备就绪（手动）
    toasts.length = 0;
    pageCtx.onReadyTap();
    console.log('  [点准备就绪] myReady=%s toasts=%s', dataStore.myReady, JSON.stringify(toasts));
    // 其余 bot 标就绪
    rl.forEach(r => { if (!r.isMe) pageCtx.markReady(r.seat, true); });
    await sleep(20);
    const stillReady = dataStore.readyPhase;
    console.log('  [之后] readyPhase=%s handNo=%d (预期下一手 handNo=%d)', stillReady, dataStore.handNo, h + 1);
    if (stillReady) { console.log('  ⚠️ 卡在就绪阶段，下一手未发出'); break; }
  }
  console.log('=== DONE ===');
  process.exit(0);
})().catch(e => { console.error('SCRIPT ERR', e); process.exit(1); });
