/**
 * 首页逻辑层仿真测试：覆盖「我的房间」加载与点击进入。
 * mock wx / Page / getApp，桩 auth.listMyRooms，真实调用页面方法。
 */
let failures = [];
let passes = 0;
function ok(c, l) { if (c) passes++; else failures.push(l); }

global.wx = {
  login: ({ success }) => success({ code: 'mock' }),
  showToast: () => {},
  showModal: o => {
    global.__lastModal = o;
    if (global.__modalMode === 'confirm' && o.success) o.success({ confirm: true, cancel: false });
    else if (global.__modalMode === 'fail' && o.fail) o.fail();
  },
  navigateTo: o => { global.__nav = o.url; },
  navigateBack: () => { global.__navBack = true; },
  reLaunch: () => {}, setClipboardData: () => {},
  showLoading: () => {}, hideLoading: () => {},
  showActionSheet: o => { global.__sheet = o; }, getUserProfile: () => {},
  showShareMenu: () => {},
  getStorageSync: k => global.__storage[k],
  setStorageSync: (k, v) => { global.__storage[k] = v; },
  removeStorageSync: k => { delete global.__storage[k]; }
};
global.__storage = {};
global.getApp = () => ({
  globalData: {
    ready: true, loginError: '',
    profile: { nickname: '玩家', room_cards: 12, total_hands: 10, total_wins: 4, total_net: 30, owner_id: 'u_test' }
  },
  login: async () => {},
  consumeRoomCard: async n => ({ ok: true, roomCards: 12 - n })
});

let currentPage = null;
global.Page = cfg => { currentPage = cfg; };

// 桩掉 listMyRooms（避免真实网络请求，验证首页映射逻辑）
const authMod = require('./utils/auth');
authMod.auth.listMyRooms = () => Promise.resolve([
  { room_no: '123456', mode: 'friend', max_players: 6, created_at: '2026-10-13' },
  { room_no: '654321', mode: 'friend', max_players: 6, created_at: '2026-10-13' }
]);
// 桩掉 createRoom：记录入参，返回固定房间号（避免真实网络请求）
authMod.auth.createRoom = (mode, maxPlayers, durationMin) => {
  global.__created = { mode, maxPlayers, durationMin };
  return Promise.resolve({ room_no: '888888' });
};

require('./pages/index/index.js');
const cfg = currentPage;
ok(!!cfg, 'index.js 调用了 Page()');
ok(typeof cfg.onShow === 'function', '定义了 onShow');
ok(typeof cfg.onEnterRoom === 'function', '定义了 onEnterRoom');

const dataStore = Object.assign({}, cfg.data);
const pageCtx = Object.assign({}, cfg, {
  data: dataStore,
  setData(p, cb) { Object.keys(p).forEach(k => { dataStore[k] = p[k]; }); if (cb) cb(); }
});

(async () => {
  pageCtx.onShow();                 // syncFromCloud -> loadMyRooms
  await new Promise(r => setTimeout(r, 250));

  ok(Array.isArray(dataStore.myRooms) && dataStore.myRooms.length === 2,
    '我的房间列表加载 2 条，实际 ' + (dataStore.myRooms ? dataStore.myRooms.length : 0));
  ok(dataStore.myRooms[0].roomNo === '123456', '房间号映射正确: ' + (dataStore.myRooms && dataStore.myRooms[0].roomNo));
  ok(dataStore.myRooms[0].maxPlayers === 6, 'maxPlayers 映射正确');

  global.__nav = null;
  pageCtx.onEnterRoom({ currentTarget: { dataset: { room: '654321' } } });
  ok(global.__nav && global.__nav.indexOf('room=654321') > 0, '点击房间卡片进入对应房间: ' + global.__nav);
  ok(global.__nav.indexOf('own=1') > 0, '以房主身份进入（own=1），可续局/开牌: ' + global.__nav);

  // 有本地牌局快照的房间显示「继续第 N 手」，进入后可续局
  global.__storage['poker_room_snap_123456'] = {
    ts: Date.now(), handNo: 7, dealerSeat: 1,
    seats: [{ seat: 0, name: '你（房主）', stack: 880, isMe: true }]
  };
  await pageCtx.loadMyRooms();
  const liveRoom = dataStore.myRooms.find(r => r.roomNo === '123456');
  ok(liveRoom && liveRoom.live === true, '有快照的房间标记为可续局');
  ok(liveRoom && liveRoom.liveText === '继续第 7 手', '续局文案显示手数: ' + (liveRoom && liveRoom.liveText));
  const waitRoom = dataStore.myRooms.find(r => r.roomNo === '654321');
  ok(waitRoom && waitRoom.live === false && waitRoom.liveText === '等待中', '无快照的房间显示等待中');

  /* ---------- 创建房间：人数与时长 ---------- */
  pageCtx.onCreateTap();
  ok(dataStore.createShow === true, '创建房间弹窗可打开');
  ok(dataStore.cMax === 6 && dataStore.cDur === 0, '默认 6 人桌 · 不限时');
  pageCtx.onPickMax({ currentTarget: { dataset: { max: '9' } } });
  ok(dataStore.cMax === 9, '可选 9 人（上限）');
  pageCtx.onPickMax({ currentTarget: { dataset: { max: '2' } } });
  ok(dataStore.cMax === 2, '可选 2 人（下限）');
  pageCtx.onPickDur({ currentTarget: { dataset: { d: '30' } } });
  ok(dataStore.cDur === 30, '可选 30 分钟');
  pageCtx.onPickDur({ currentTarget: { dataset: { d: '120' } } });
  ok(dataStore.cDur === 120, '可选 2 小时（120 分钟）');
  ok(pageCtx.durText(30) === '30 分钟' && pageCtx.durText(60) === '1 小时' && pageCtx.durText(0) === '不限时',
    '时长文案转换正确');
  // 确认创建：带参数建房并跳转牌桌
  global.__nav = null;
  global.__lastModal = null;
  global.__modalMode = 'confirm';   // 模拟在成功弹窗上点「进入房间」
  await pageCtx.onCreateConfirm();
  await new Promise(r => setTimeout(r, 60));
  ok(dataStore.createShow === false, '确认后关闭弹窗');
  ok(global.__lastModal && global.__lastModal.content.indexOf('2 人桌') > 0,
    '建房成功弹窗显示人数设置: ' + (global.__lastModal && global.__lastModal.content));
  ok(global.__lastModal && global.__lastModal.content.indexOf('2 小时') > 0, '弹窗显示时长设置');
  ok(global.__nav && global.__nav.indexOf('max=2') > 0 && global.__nav.indexOf('dur=120') > 0,
    '进入牌桌时带上人数与时长: ' + global.__nav);
  ok(global.__created && global.__created.maxPlayers === 2 && global.__created.durationMin === 120,
    '创建房间把人数与时长写入云端: ' + JSON.stringify(global.__created));
  ok(dataStore.myRooms[0].durText === '不限时', '房间列表显示时长文案');

  /* ---------- 牌桌设置（四色牌 / 反馈 / 动画）---------- */
  ok(dataStore.sFourColor === true, '设置：默认启用四色牌');
  ok(dataStore.sSound === true && dataStore.sAnim === true, '设置：默认开启反馈与动画');
  pageCtx.onSettingsTap();
  ok(dataStore.setShow === true, '设置弹窗可打开');
  pageCtx.onToggle({ currentTarget: { dataset: { k: 'fourColor' } } });
  ok(dataStore.sFourColor === false, '四色牌可关闭');
  ok(global.__storage.poker_settings && global.__storage.poker_settings.fourColor === false,
    '设置已持久化到 storage');
  pageCtx.onToggle({ currentTarget: { dataset: { k: 'sound' } } });
  ok(dataStore.sSound === false, '操作反馈可关闭');
  pageCtx.onToggle({ currentTarget: { dataset: { k: 'animation' } } });
  ok(dataStore.sAnim === false, '牌桌动画可关闭');
  pageCtx.onToggle({ currentTarget: { dataset: { k: 'fourColor' } } });
  ok(dataStore.sFourColor === true, '四色牌可再次开启');
  pageCtx.onSettingsClose();
  ok(dataStore.setShow === false, '设置弹窗可关闭');

  if (failures.length === 0) {
    console.log('首页逻辑测试全部通过：' + passes + ' 项断言 ✓');
    process.exit(0);
  } else {
    console.log('通过 ' + passes + ' 项，失败 ' + failures.length + ' 项：');
    failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    process.exit(1);
  }
})();
