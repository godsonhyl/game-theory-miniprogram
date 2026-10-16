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
  // 与真实 wx.showModal 语义一致：确认与取消都回调 success（取消时 res.cancel=true、
  // confirm=false），只有弹窗本身失败才走 fail。此前 mock 没有 cancel 分支，取消时
  // 什么也不回调——依赖它的「取消删除」用例验证的不是真机会走的路径（评审 MEDIUM）。
  showModal: o => {
    global.__lastModal = o;
    const m = global.__modalMode;
    if (m === 'confirm' && o.success) o.success({ confirm: true, cancel: false });
    else if (m === 'cancel' && o.success) o.success({ confirm: false, cancel: true });
    else if (m === 'fail' && o.fail) o.fail();
  },
  navigateTo: o => { global.__nav = o.url; },
  navigateBack: () => { global.__navBack = true; },
  reLaunch: () => {}, setClipboardData: () => {},
  showLoading: o => { global.__lastLoading = o; }, hideLoading: () => {},
  stopPullDownRefresh: () => { global.__stoppedPull = true; },
  showActionSheet: o => { global.__sheet = o; }, getUserProfile: () => {},
  showShareMenu: () => {},
  getStorageSync: k => global.__storage[k],
  setStorageSync: (k, v) => { global.__storage[k] = v; },
  removeStorageSync: k => { delete global.__storage[k]; }
};
global.__storage = {};
// getApp 返回单例：index.js 在模块加载时以 const app = getApp() 捕获引用，
// 测试要改 methods（如 consumeRoomCard）必须改这份单例，新建对象改不动已加载页面。
const __appSingleton = {
  globalData: {
    ready: true, loginError: '',
    profile: { nickname: '玩家', room_cards: 12, total_hands: 10, total_wins: 4, total_net: 30, owner_id: 'u_test' }
  },
  login: async () => {},
  consumeRoomCard: async n => ({ ok: true, roomCards: 12 - n })
};
global.getApp = () => __appSingleton;

let currentPage = null;
global.Page = cfg => { currentPage = cfg; };

// 桩掉 listMyRooms（避免真实网络请求，验证首页映射逻辑）
// 两个新鲜房间 + 一个限时已到期的僵尸房（30 分钟房，建于 2 小时前）
const authMod = require('./utils/auth');
const NOW = Date.now();
authMod.auth.listMyRooms = () => Promise.resolve([
  { room_no: '123456', mode: 'friend', max_players: 6, created_at: new Date(NOW - 3600e3).toISOString() },
  { room_no: '654321', mode: 'friend', max_players: 6, created_at: new Date(NOW - 3600e3).toISOString() },
  { room_no: '999999', mode: 'friend', max_players: 6, duration_min: 30, created_at: new Date(NOW - 2 * 3600e3).toISOString() }
].filter(r => (global.__closed || []).indexOf(r.room_no) === -1));
// 桩掉 createRoom：记录入参，返回固定房间号（避免真实网络请求）
authMod.auth.createRoom = (mode, maxPlayers, durationMin) => {
  global.__created = { mode, maxPlayers, durationMin };
  return Promise.resolve({ room_no: '888888' });
};
// 桩掉 closeRoom：记录被关闭的房间号（避免真实网络请求）
authMod.auth.closeRoom = roomNo => {
  global.__closed = (global.__closed || []).concat(roomNo);
  return Promise.resolve();
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

  // 加载失败态：listMyRooms reject → roomsError=true，用户可重试
  const goodListMyRooms = authMod.auth.listMyRooms;
  authMod.auth.listMyRooms = () => Promise.reject(new Error('net'));
  await pageCtx.loadMyRooms();
  ok(dataStore.roomsError === true && dataStore.roomsLoading === false,
    '房间列表加载失败标记 roomsError（区分「没有房间」与「加载失败」）');
  authMod.auth.listMyRooms = goodListMyRooms;
  pageCtx.onRetryRooms();
  await new Promise(r => setTimeout(r, 250));
  ok(dataStore.roomsError === false && dataStore.myRooms.length === 2,
    '重试后恢复正常列表');

  /* ---------- 创建房间：人数与时长 ---------- */
  pageCtx.onCreateTap();
  ok(dataStore.createShow === true, '创建房间弹窗可打开');
  ok(dataStore.cMax === 6 && dataStore.cDur === 30, '默认 6 人桌 · 30 分钟（建档默认时长，不再是不限时）');
  // 人数 2–9 逐人可调（± 按钮），越界自动夹取
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '1' } } });
  ok(dataStore.cMax === 7, '人数可逐人 +1');
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '-1' } } });
  ok(dataStore.cMax === 6, '人数可逐人 −1');
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '1' } } });
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '1' } } });
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '1' } } });
  ok(dataStore.cMax === 9, '人数上限夹到 9');
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '-1' } } });
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '-1' } } });
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '-1' } } });
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '-1' } } });
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '-1' } } });
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '-1' } } });
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '-1' } } });
  pageCtx.onMaxStep({ currentTarget: { dataset: { step: '-1' } } });
  ok(dataStore.cMax === 2, '人数下限夹到 2（连点 − 不会越界）');
  // 时长 10 分钟一档 + 不限时开关
  pageCtx.onDurStep({ currentTarget: { dataset: { step: '1' } } });
  ok(dataStore.cDur === 40, '时长可 ±10 分钟');
  pageCtx.onToggleUnlimited();
  ok(dataStore.cDur === 0 && dataStore.durLabel === '不限时', '「不限时」开关：切到不限时');
  pageCtx.onDurStep({ currentTarget: { dataset: { step: '1' } } });
  ok(dataStore.cDur === 50, '从不限时 +1：接续上次的 40 再 +10（而非从 10 起算）');
  pageCtx.onToggleUnlimited();
  ok(dataStore.cDur === 0 && dataStore.cDurLast === 50, '「不限时」→ 再点开关：cDurLast 仍保留 50');
  pageCtx.onToggleUnlimited();
  ok(dataStore.cDur === 50 && dataStore.durLabel === '50 分钟', '再点开关：恢复上次的有限时长 50');
  ok(pageCtx.durText(90) === '1 小时 30 分钟', '90 分钟显示为「1 小时 30 分钟」');
  for (let i = 0; i < 40; i++) pageCtx.onDurStep({ currentTarget: { dataset: { step: '1' } } });
  ok(dataStore.cDur === 300, '时长上限夹到 300 分钟（连点 + 不会越界）');
  for (let i = 0; i < 40; i++) pageCtx.onDurStep({ currentTarget: { dataset: { step: '-1' } } });
  ok(dataStore.cDur === 10, '时长下限夹到 10 分钟（连点 − 不会越界）');
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
  // 确认创建：建房后弹自定义成功弹窗（分享/复制/进入），不再用 wx.showModal
  global.__nav = null;
  global.__lastModal = null;
  global.__clipboard = null;
  await pageCtx.onCreateConfirm();
  await new Promise(r => setTimeout(r, 60));
  ok(dataStore.createShow === false, '确认后关闭创建弹窗');
  ok(dataStore.createdShow === true, '建房成功弹出自定义成功弹窗');
  ok(dataStore.createdRoomNo === '888888', '成功弹窗带房间号');
  ok(dataStore.createdDesc.indexOf('2 人桌') >= 0,
    '成功弹窗显示人数设置: ' + dataStore.createdDesc);
  ok(dataStore.createdDesc.indexOf('2 小时') > 0, '成功弹窗显示时长设置');
  ok(dataStore.createdRoomUrl.indexOf('max=2') > 0 && dataStore.createdRoomUrl.indexOf('dur=120') > 0,
    '成功弹窗的进入 URL 带人数与时长: ' + dataStore.createdRoomUrl);
  ok(global.__created && global.__created.maxPlayers === 2 && global.__created.durationMin === 120,
    '创建房间把人数与时长写入云端: ' + JSON.stringify(global.__created));
  // 分享卡片：onShareAppMessage 用成功弹窗的房间号
  const share = pageCtx.onShareAppMessage();
  ok(share && share.path.indexOf('room=888888') > 0, '分享路径带房间号: ' + (share && share.path));
  // 复制房号
  global.wx.setClipboardData = o => { global.__clipboard = o.data; if (o.success) o.success(); };
  pageCtx.onCreatedCopy();
  ok(global.__clipboard === '888888', '复制房号写入剪贴板');
  // 进入房间
  global.__nav = null;
  pageCtx.onCreatedEnter();
  ok(global.__nav && global.__nav.indexOf('room=888888') > 0, '进入房间跳转牌桌: ' + global.__nav);
  ok(dataStore.createdShow === false, '进入后关闭成功弹窗');
  // 关闭弹窗
  dataStore.createdShow = true;
  pageCtx.onCreatedClose();
  ok(dataStore.createdShow === false, '稍后按钮关闭成功弹窗');
  ok(dataStore.myRooms[0].durText === '不限时', '房间列表显示时长文案');

  /* ---------- 牌桌设置（四色牌 / 反馈 / 动画）---------- */
  ok(dataStore.sFourColor === true, '设置：默认启用四色牌');
  ok(dataStore.sSound === true && dataStore.sVibrate === true && dataStore.sAnim === true, '设置：默认开启音效、震动与动画');
  pageCtx.onSettingsTap();
  ok(dataStore.setShow === true, '设置弹窗可打开');
  pageCtx.onToggle({ currentTarget: { dataset: { k: 'fourColor' } } });
  ok(dataStore.sFourColor === false, '四色牌可关闭');
  ok(global.__storage.poker_settings && global.__storage.poker_settings.fourColor === false,
    '设置已持久化到 storage');
  pageCtx.onToggle({ currentTarget: { dataset: { k: 'sound' } } });
  ok(dataStore.sSound === false, '音效可关闭');
  pageCtx.onToggle({ currentTarget: { dataset: { k: 'vibrate' } } });
  ok(dataStore.sVibrate === false, '震动可独立关闭');
  ok(global.__storage.poker_settings && global.__storage.poker_settings.vibrate === false,
    '震动开关已持久化');
  pageCtx.onToggle({ currentTarget: { dataset: { k: 'animation' } } });
  ok(dataStore.sAnim === false, '牌桌动画可关闭');
  pageCtx.onToggle({ currentTarget: { dataset: { k: 'fourColor' } } });
  ok(dataStore.sFourColor === true, '四色牌可再次开启');
  pageCtx.onSettingsClose();
  ok(dataStore.setShow === false, '设置弹窗可关闭');

  /* ---------- 僵尸房自动过期 + 手动删除 ---------- */
  // 过期规则：限时房到期即过期；不限时房 24 小时后过期
  ok(authMod.auth.roomExpired({ created_at: new Date(NOW - 2 * 3600e3).toISOString(), duration_min: 30 }, NOW) === true,
    '限时房到期即判定过期');
  ok(authMod.auth.roomExpired({ created_at: new Date(NOW - 25 * 3600e3).toISOString(), duration_min: 0 }, NOW) === true,
    '不限时房超 24 小时判定过期');
  ok(authMod.auth.roomExpired({ created_at: new Date(NOW - 2 * 3600e3).toISOString(), duration_min: 0 }, NOW) === false,
    '不限时房 24 小时内不过期');
  ok(authMod.auth.roomExpired({ created_at: '' }, NOW) === false && authMod.auth.roomExpired(null, NOW) === false,
    '脏数据（空/缺房间）不误判过期');

  // loadMyRooms：僵尸房被过滤并自动关闭 + 清快照，列表只剩 2 条新鲜房
  global.__storage['poker_room_snap_999999'] = { ts: Date.now(), handNo: 3, seats: [{ seat: 0 }] };
  global.__closed = [];
  await pageCtx.loadMyRooms();
  ok(dataStore.myRooms.length === 2, '过期僵尸房不进列表，剩 2 条: ' + dataStore.myRooms.length);
  ok(!dataStore.myRooms.find(r => r.roomNo === '999999'), '僵尸房 999999 已被过滤');
  ok(global.__closed.indexOf('999999') !== -1, '僵尸房 999999 已自动关闭: ' + JSON.stringify(global.__closed));
  ok(!global.__storage['poker_room_snap_999999'], '僵尸房本地续局快照已清除');

  // 僵尸房清理关房失败不再静默吞：closeRoom reject → console.error 记日志
  {
    global.__closed = [];
    const origClose = authMod.auth.closeRoom;
    const errs = []; const origErr = console.error;
    console.error = (...a) => { errs.push(a.join(' ')); };
    authMod.auth.closeRoom = () => Promise.reject(new Error('stale close boom'));
    await pageCtx.loadMyRooms();
    await new Promise(r => setTimeout(r, 30));
    ok(errs.some(s => s.indexOf('loadMyRooms-stale') >= 0),
      '僵尸房关房失败 → console.error 记录（不静默吞，含 stage=loadMyRooms-stale）');
    console.error = origErr;
    authMod.auth.closeRoom = origClose;
  }

  // 手动删除：确认后关闭房间 + 清快照 + 刷新列表
  global.__storage['poker_room_snap_123456'] = { ts: Date.now(), handNo: 7, seats: [{ seat: 0, isMe: true }] };
  await pageCtx.loadMyRooms();
  ok(dataStore.myRooms.length === 2, '删除前列表 2 条');
  global.__modalMode = 'confirm';   // 模拟在确认弹窗上点「删除」
  global.__closed = [];
  pageCtx.onCloseRoom({ currentTarget: { dataset: { room: '123456' } } });
  await new Promise(r => setTimeout(r, 60));
  ok(global.__closed.indexOf('123456') !== -1, '确认删除后关闭云端房间 123456');
  ok(!global.__storage['poker_room_snap_123456'], '删除后清掉本地续局快照');
  await new Promise(r => setTimeout(r, 60));
  ok(dataStore.myRooms.length === 1 && dataStore.myRooms[0].roomNo === '654321',
    '删除后列表刷新，只剩 654321: ' + JSON.stringify((dataStore.myRooms || []).map(r => r.roomNo)));

  // 取消删除：不关房间（真实 wx 语义——取消同样回调 success，res.cancel=true）
  global.__modalMode = 'cancel';
  global.__closed = [];
  pageCtx.onCloseRoom({ currentTarget: { dataset: { room: '654321' } } });
  await new Promise(r => setTimeout(r, 60));
  ok(global.__closed.length === 0, '取消删除时不关闭房间');
  ok(dataStore.myRooms.length === 1, '取消删除后列表不变');

  // 白盒：验证 mock 的 cancel 分支确实回调 success（res.cancel=true），
  // 而不是依赖「未匹配 → 不回调」的旧行为——评审 MEDIUM 指出旧 mock 取消时
  // 什么也不回调，依赖它的「取消」用例验证的不是真机会走的路径。
  {
    let got = null;
    global.wx.showModal({ success: res => { got = res; } });
    ok(!!got && got.cancel === true && got.confirm === false,
      'mock showModal：cancel 模式回调 success({cancel:true,confirm:false})（与真实 wx 一致）');
  }

  /* ---------- 建房扣卡抛异常 → 房间回滚关闭（防泄漏 active 房） ---------- */
  global.__created = null;
  global.__closed = [];
  global.__cardError = true;   // 让 consumeRoomCard 抛错（模拟扣卡瞬间断网）
  const origConsume = __appSingleton.consumeRoomCard;
  __appSingleton.consumeRoomCard = async () => {
    if (global.__cardError) throw new Error('network down');
    return origConsume(1);
  };
  await pageCtx.onCreateRoom(6, 30);
  await new Promise(r => setTimeout(r, 60));
  ok(global.__created !== null, '异常路径：云端房间已建出');
  ok(global.__closed.indexOf('888888') !== -1,
    '扣卡抛异常 → 已建房间被回滚关闭: ' + JSON.stringify(global.__closed));
  global.__cardError = false;   // 恢复正常扣卡
  global.__created = null;
  global.__closed = [];
  await pageCtx.onCreateRoom(6, 30);
  await new Promise(r => setTimeout(r, 60));
  ok(global.__closed.length === 0, '恢复正常扣卡后建房成功（不触发回滚）');
  __appSingleton.consumeRoomCard = origConsume;   // 还原，不影响后续场景

  // 回滚关房本身失败也不再静默吞：catch 应 console.error 记录（与 table.js 离房清理同口径）。
  // 扣卡抛异常 + closeRoom 也 reject → 记日志，不抛穿 onCreateRoom 的外层 catch（外层只 toast）。
  global.__cardError = true;
  __appSingleton.consumeRoomCard = async () => { throw new Error('network down'); };
  const origCloseRoom = authMod.auth.closeRoom;
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  authMod.auth.closeRoom = () => Promise.reject(new Error('closeRoom boom'));
  await pageCtx.onCreateRoom(6, 30);
  await new Promise(r => setTimeout(r, 60));
  ok(errs.some(s => s.indexOf('createRoom-cardErr') >= 0),
    '扣卡异常回滚关房失败 → console.error 记录（不静默吞，含 stage=createRoom-cardErr）');
  console.error = origErr;
  __appSingleton.consumeRoomCard = origConsume;
  authMod.auth.closeRoom = origCloseRoom;
  global.__cardError = false;

  /* ---------- 分享参数校验：onLoad 的 room 参数 ---------- */
  // 合法 6 位数字 → 自动尝试加入
  global.__nav = null;
  global.__joinedRoom = null;
  const origTryJoin = pageCtx.tryJoin;
  pageCtx.tryJoin = function (no) { global.__joinedRoom = no; return Promise.resolve(); };
  pageCtx.onLoad({ room: '700123' });
  ok(global.__joinedRoom === '700123', '分享带合法 6 位房号 → 自动 tryJoin');
  ok(dataStore.joinShow === true && dataStore.joinNo === '700123', '分享进入：加入弹窗带房号');
  // 脏参数（拼接的 query / 脚本串）→ 不自动加入，只提示
  global.__joinedRoom = null;
  pageCtx.onLoad({ room: '700123&own=1' });
  ok(global.__joinedRoom === null, '分享参数带拼接 query → 不自动加入');
  global.__joinedRoom = null;
  pageCtx.onLoad({ room: 'abc123' });
  ok(global.__joinedRoom === null, '非 6 位数字参数 → 不自动加入');
  global.__joinedRoom = null;
  pageCtx.onLoad({});
  ok(global.__joinedRoom === null, '无 room 参数 → 不触发加入流程');
  pageCtx.tryJoin = origTryJoin;
  // 恢复：手动打开加入弹窗的路径不受影响
  global.__nav = null;

  /* ---------- 下拉刷新 ---------- */
  ok(typeof cfg.onPullDownRefresh === 'function', 'index.js 定义了 onPullDownRefresh');
  // syncFromCloud 返回 loadMyRooms 的 promise（而非发射即忘），下拉刷新才能等列表就绪
  ok(/return this\.loadMyRooms\(\)/.test(require('fs').readFileSync(
    require('path').join(__dirname, 'pages/index/index.js'), 'utf8')),
    'syncFromCloud 返回 loadMyRooms 的 promise（下拉刷新等列表真正就绪再收起转圈）');
  global.__stoppedPull = false;
  await pageCtx.onPullDownRefresh();
  ok(global.__stoppedPull === true, 'onPullDownRefresh 调用 wx.stopPullDownRefresh 收起刷新');
  const idxJsonSrc = require('fs').readFileSync(require('path').join(__dirname, 'pages/index/index.json'), 'utf8');
  ok(/enablePullDownRefresh/.test(idxJsonSrc), 'index.json 启用 enablePullDownRefresh');

  /* ---------- 朋友圈分享 ---------- */
  ok(typeof cfg.onShareTimeline === 'function', 'index.js 定义了 onShareTimeline');
  const tl = pageCtx.onShareTimeline();
  ok(tl && tl.title.indexOf('博弈论') >= 0, 'onShareTimeline 返回带标题的分享内容');

  /* ---------- 加入防抖 + showLoading mask ---------- */
  ok(/this\.joining/.test(require('fs').readFileSync(require('path').join(__dirname, 'pages/index/index.js'), 'utf8')),
    'index.js 有 joining 防抖标记');
  ok(global.__lastLoading && global.__lastLoading.mask === true,
    'tryJoin showLoading 带 mask（防查找期间误触）');
  // 行为：joining 期间 onJoinConfirm 不触发 tryJoin（不跳转）
  global.__nav = null;
  pageCtx.joining = true;
  pageCtx.data.joinNo = '123456';
  pageCtx.onJoinConfirm();
  ok(global.__nav === null, 'joining 期间连点不重复触发加入');
  pageCtx.joining = false;

  if (failures.length === 0) {
    console.log('首页逻辑测试全部通过：' + passes + ' 项断言 ✓');
    process.exit(0);
  } else {
    console.log('通过 ' + passes + ' 项，失败 ' + failures.length + ' 项：');
    failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    process.exit(1);
  }
})();
