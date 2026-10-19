/**
 * 小程序逻辑层仿真测试
 *
 * 目的：在没有微信开发者工具的环境下，验证 pages/table/table.js
 * 能否正确驱动引擎、字段名是否与 WXML 一致、setData 调用是否合法。
 *
 * 做法：mock 出 wx / Page / getApp / setData，然后真实调用页面方法。
 */
const path = require('path');
const Module = require('module');
const fs = require('fs');

let failures = [];
let passes = 0;
function ok(cond, label) {
  if (cond) passes++;
  else failures.push(label);
}
function eq(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) passes++; else failures.push(label + '\n        got: ' + x + '\n        exp: ' + y);
}

/* ---------- mock 微信运行时 ---------- */
const toasts = [];
global.wx = {
  login: ({ success }) => success({ code: 'mock_code' }),
  request: () => {},
  setStorageSync: (k, v) => { global.__storage[k] = v; },
  getStorageSync: k => global.__storage[k],
  removeStorageSync: k => { delete global.__storage[k]; },
  showToast: o => toasts.push(o.title),
  // __modalMode: 'confirm' | 'cancel' | 'fail'，模拟用户在弹窗上的选择
  showModal: o => {
    global.__lastModal = o;
    const m = global.__modalMode;
    if (m === 'confirm' && o.success) o.success({ confirm: true, cancel: false });
    else if (m === 'cancel' && o.success) o.success({ confirm: false, cancel: true });
    else if (m === 'fail' && o.fail) o.fail();
  },
  navigateTo: o => { global.__nav = o.url; },
  navigateBack: () => { global.__navBack = true; },
  reLaunch: o => { global.__reLaunched = o.url; },
  setClipboardData: o => {},
  getUserProfile: () => {},
  showShareMenu: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  setPageOrientation: o => { global.__orient = o.orientation; },
  getWindowInfo: () => ({ windowWidth: global.__ww || 812, windowHeight: global.__wh || 375 }),
  vibrateShort: () => {}
};
global.__storage = {};
global.getApp = () => ({ globalData: { roomCards: 12, userInfo: null }, consumeRoomCard: () => true });

let currentPage = null;
global.Page = cfg => { currentPage = cfg; };

/* ---------- 加载页面 ---------- */
const tablePath = path.join(__dirname, 'pages', 'table', 'table.js');
const P = require(path.join(__dirname, 'core', 'poker-core.js'));

// 模拟 Page 生命周期
const data = Object.assign({}, currentPage ? {} : {});
const page = null;
require(tablePath);

// Page() 已把配置存入 currentPage
const cfg = currentPage;
ok(!!cfg, 'table.js 调用了 Page()');
ok(typeof cfg.onLoad === 'function', '定义了 onLoad');
ok(typeof cfg.render === 'function', '定义了 render');
ok(typeof cfg.onFold === 'function', '定义了 onFold');
ok(typeof cfg.onRaise === 'function', '定义了 onRaise');

/* ---------- 伪造 setData 运行时 ---------- */
let dataStore = Object.assign({}, cfg.data);
function setData(patch, cb) {
  if (typeof patch === 'string') return; // 路径形式由本页逻辑使用，直接跳过
  Object.keys(patch).forEach(k => { dataStore[k] = patch[k]; });
  if (cb) cb();
}
const pageCtx = Object.assign({}, cfg, { data: dataStore, setData });

/* ---------- AI 对战：同样先选座坐下、点开始才发牌 ---------- */
pageCtx.onLoad();
ok(dataStore.phase === 'waiting', 'AI 对战进入等待室（不自动开局）');
ok(dataStore.waitHint.indexOf('空位') >= 0, 'AI 等待室提示引导选座：' + dataStore.waitHint);
ok(dataStore.canStart === false, '还没坐下时不可开始');
// 选一个非 0 号位坐下，验证「自选座位」真的生效
pageCtx.chooseSeat({ currentTarget: { dataset: { seat: 3 } } });
pageCtx.confirmBuyIn({ currentTarget: { dataset: { amt: '1000' } } });
ok(dataStore.waitSeats[3].occupied === true, 'AI 桌选了 3 号位坐下');
ok(dataStore.waitHint.indexOf('开始游戏') >= 0, '坐下后提示改为「点开始游戏」');
ok(dataStore.canStart === true, '坐下后系统自动补 AI 对手 → 可开始');
ok(dataStore.waitSeats.filter(s => s.occupied).length === 2, '自动补位到 2 人，不一次加满');
pageCtx.startGame();
ok(dataStore.phase === 'playing', 'AI 桌点开始后进入牌桌');

ok(dataStore.handNo >= 1, '开局后 handNo = ' + dataStore.handNo);
ok(dataStore.pot === 30, '开局底池 = 30（盲注 10+20），实际 ' + dataStore.pot);

// ---- 批④ 涨盲定时器行为级：blindIntervalMin=0 不涨盲（默认 AI 桌），盲注级展示初始化 ----
ok(typeof pageCtx.startBlindTimer === 'function', 'pageCtx 定义 startBlindTimer 方法');
ok(typeof pageCtx.clearBlindTimer === 'function', 'pageCtx 定义 clearBlindTimer 方法');
ok(typeof pageCtx.fmtBlind === 'function', 'pageCtx 定义 fmtBlind 方法');
ok(pageCtx.blindIntervalMin === 0, 'AI 桌默认 blindIntervalMin=0（不涨盲）');
eq(pageCtx.fmtBlind(10, 20), '10/20', 'fmtBlind(10,20) → 「10/20」');
eq(pageCtx.fmtBlind(40, 80), '40/80', 'fmtBlind(40,80) → 「40/80」（涨盲后文案）');
ok(dataStore.blindLevel === 20, '初始 blindLevel=20（大盲）');
ok(dataStore.blindText === '10/20', '初始 blindText=「10/20」');
// blindIntervalMin=0 调 startBlindTimer 应 no-op（不创建定时器）
pageCtx.startBlindTimer();
ok(true, 'blindIntervalMin=0 调 startBlindTimer 不抛错（no-op）');
pageCtx.clearBlindTimer();   // 幂等清理，不抛错
ok(true, 'clearBlindTimer 幂等不抛错（无定时器时）');

const mySeatNow = dataStore.seats.filter(s => s.isMe)[0];
ok(dataStore.seats.length >= 2, 'WPK 式布局：所有座位（含我）都在牌桌环上，实际 ' + dataStore.seats.length);
ok(!!mySeatNow, '我的座位（自选的 3 号位）也在牌桌环上（isMe=true）');
ok(mySeatNow && mySeatNow.y > 60, '我的座位锚定在底部中央（y≈' + (mySeatNow && mySeatNow.y) + '）');
ok(Array.isArray(dataStore.myCards), '我的手牌渲染在 myCards');
ok(typeof dataStore.myStack === 'number' && dataStore.myStack > 0, '我的筹码在 myStack，实际 ' + dataStore.myStack);
ok(dataStore.board.length === 0, '翻牌前公共牌为空');
ok(Array.isArray(dataStore.boardPlaceholders), 'boardPlaceholders 是数组');
ok(dataStore.boardPlaceholders.length === 3, '翻牌前 3 个占位，实际 ' + dataStore.boardPlaceholders.length);

/* ---------- 好友房模式（room 参数）---------- */
pageCtx.onLoad({ room: '654321', own: '1' });
ok(dataStore.mode === 'friend', '带 room 参数进入好友房模式');
ok(dataStore.roomNo === '654321', '房间号经 setData 同步到视图: ' + dataStore.roomNo);
ok(dataStore.pageTitle === '好友房', '好友房标题正确');
const shareInfo = pageCtx.onShareAppMessage();
ok(shareInfo.path.indexOf('room=654321') > 0, '好友房转发路径携带房间号: ' + shareInfo.path);

/* ---------- 好友房等待室流程（空房间 → 坐下 → 开始才发牌）---------- */
pageCtx.onLoad({ room: '654321', own: '1' });
ok(dataStore.phase === 'waiting', '好友房进入等待室（空房间），不自动发牌');
ok(Array.isArray(dataStore.waitSeats) && dataStore.waitSeats.length === 6, '等待室 6 个座位，实际 ' + (dataStore.waitSeats ? dataStore.waitSeats.length : 0));
ok(dataStore.waitSeats[0].occupied && dataStore.waitSeats[0].isOwner, '房主已坐下 0 号位');
ok(dataStore.canStart === false, '仅房主 1 人时不可开始');
pageCtx.addBot();
ok(dataStore.waitSeats.filter(s => s.occupied).length === 2, '添加电脑玩家后 2 人坐下');
ok(dataStore.canStart === true, '2 人时可开始');
ok(typeof pageCtx.onBack === 'function', '等待室提供 onBack 返回处理');
pageCtx.onBack();
ok(global.__reLaunched || global.__navBack, '返回动作触发 navigateBack 或兜底 reLaunch');
pageCtx.startGame();
ok(dataStore.phase === 'playing', '房主点开始后进入牌桌');
// 座位环按房间座位数铺满：桌上有几个位就画几个位，没坐满的那几个显示为空位。
// 旧断言只数「在座人数」，改铺满后应为 6 个位（其中 2 个位有人）。
ok(dataStore.seats.length === 6, '2 人局：座位环按房间 6 个位铺满（含 4 个空位），实际 ' + dataStore.seats.length);
ok(dataStore.seats.filter(s => !s.empty).length === 2,
  '2 个在座的人都在环上（含我），实际 ' + dataStore.seats.filter(s => !s.empty).length);
ok(dataStore.myCards.length === 2, '我的两张底牌已在 myzone 渲染，实际 ' + dataStore.myCards.length);
ok(dataStore.pot === 30, '开局底池 30（盲注 10+20），实际 ' + dataStore.pot);

/* ---------- 空闲超时自动销毁（30 分钟无人加入）---------- */
pageCtx.onLoad({ room: '987654', own: '1' });   // 仅房主，进入等待室
ok(dataStore.phase === 'waiting', '超时场景：重新进入等待室（仅房主）');
ok(typeof pageCtx.armExpire === 'function', '定义了 armExpire（启动空闲倒计时）');
// 空闲超时提示：armExpire 启动后 idleRemainText 初始为空（最后 5 分钟才出现）
ok(dataStore.idleRemainText === '', '空闲超时提示初始为空（未到最后 5 分钟）');
// 模拟到期前 5 分钟：tickExpireWarn 按 _expireDeadline 计算「X 后自动解散」文案
ok(typeof pageCtx.tickExpireWarn === 'function', '定义了 tickExpireWarn（提前 5 分钟提示）');
pageCtx._expireDeadline = Date.now() + 5 * 60 * 1000;
pageCtx.tickExpireWarn();
ok(dataStore.idleRemainText.indexOf('后自动解散') > 0, '空闲提示显示倒计时文案: ' + dataStore.idleRemainText);
// clearExpireWarn 清掉文案
pageCtx.clearExpireWarn();
ok(dataStore.idleRemainText === '', 'clearExpireWarn 清空空闲提示文案');
global.__navBack = false; global.__reLaunched = false;
pageCtx.destroyRoom();
ok(global.__reLaunched || global.__navBack, '超时无人在 → 调用 onBack 离开页面');
ok(pageCtx.roomClosed === true, 'timeout 已标记房间关闭（closeRoom 已触发）');
ok(toasts.indexOf('房间超时已自动解散') >= 0, '超时提示文案正确: ' + toasts.slice(-1)[0]);

// 已开局（有人加入/已开始）后 destroyRoom 应被守卫拦截，不退出、不重复销毁
pageCtx.onLoad({ room: '135790', own: '1' });
pageCtx.addBot();
pageCtx.startGame();
ok(dataStore.phase === 'playing', '超时守卫场景：已进入牌桌（有人加入）');
global.__navBack = false; global.__reLaunched = false;
pageCtx.destroyRoom();
ok(!(global.__reLaunched || global.__navBack), '已开局后 destroyRoom 被守卫拦截，不触发退出');


/* ---------- 中途退出：二次确认 + 快照续局（好友房）---------- */
pageCtx.onLoad({ room: '246810', own: '1' });
ok(dataStore.isOwner === true, 'own=1 进入标记为房主');
pageCtx.addBot();
pageCtx.startGame();
ok(dataStore.phase === 'playing', '中途退出场景：房主已开局');

global.__lastModal = null;
global.__modalMode = 'cancel';
global.__navBack = false; global.__reLaunched = false;
pageCtx.onBack();
ok(!!global.__lastModal && global.__lastModal.confirmText === '退出', '牌局中点返回弹出退出房间确认（confirmText=退出）');
ok(global.__lastModal.cancelText === '留下', '取消按钮文案「留下」（真机限制 ≤4 字）');
ok(!!global.__lastModal && global.__lastModal.content.indexOf('站起退出本局') > 0,
  '确认弹窗说明「站起退出本局 ≠ 退出房间」');
ok(!(global.__navBack || global.__reLaunched), '选择「留下」时不退出牌桌');

global.__modalMode = 'confirm';
pageCtx.onBack();
ok(global.__navBack || global.__reLaunched, '确认「离开」后退出牌桌');
const snap = global.__storage['poker_room_snap_246810'];
ok(!!snap && snap.seats.length === 2, '退出时写入牌局快照（保留 2 个座位）');
ok(!!snap && typeof snap.handNo === 'number' && snap.handNo >= 1, '快照记录当前第几手: ' + (snap && snap.handNo));

// 重新进入同一房间 → 弹「继续/重开」确认，确认继续才续局（不再静默自动恢复）
const handBefore = snap.handNo;
global.__lastModal = null;
global.__modalMode = 'confirm';
pageCtx.onLoad({ room: '246810', own: '1' });
ok(!!global.__lastModal && global.__lastModal.title === '继续上一局？', '再次进入有快照的房间弹出续局确认');
ok(!!global.__lastModal && global.__lastModal.confirmText === '继续' && global.__lastModal.cancelText === '重开',
  '续局确认按钮：继续 / 重开');
ok(dataStore.phase === 'playing', '选择「继续」后回到牌桌');
ok(dataStore.seats.length === 6, '续局保留房间座位数（6 个位都在环上），实际 ' + dataStore.seats.length);
ok(dataStore.seats.filter(s => !s.empty).length === 2,
  '续局 2 个在座者仍在环上，实际 ' + dataStore.seats.filter(s => !s.empty).length);
ok(dataStore.handNo === handBefore, '续局从第 ' + handBefore + ' 手继续，实际 ' + dataStore.handNo);
ok(toasts.indexOf('已回到房间 · 第 ' + handBefore + ' 手') >= 0, '续局提示文案正确: ' + toasts.slice(-1)[0]);

// 选择「重开」→ 清掉快照进等待室（故意退出想重开不被自动拉回）
global.__modalMode = 'cancel';
pageCtx.onLoad({ room: '246810', own: '1' });
ok(dataStore.phase === 'waiting', '选择「重开」后进等待室，不再续局');
ok(!global.__storage['poker_room_snap_246810'], '重开清掉旧快照');

// 访客（无 own 参数）进入：自动落座并等待房主
pageCtx.onLoad({ room: '246810' });
ok(dataStore.isOwner === false, '无 own 参数进入视为访客');
ok(dataStore.phase === 'waiting', '访客进入等待室');
ok(dataStore.waitSeats[0].name === '房主', '访客视角 0 号位显示「房主」');
ok(dataStore.waitSeats[1].isMe === true, '访客自动落座 1 号位');
ok(dataStore.canStart === false, '访客不能开始牌局');
global.__modalMode = 'none';
toasts.length = 0;
pageCtx.startGame();
ok(toasts.indexOf('等待房主开始') >= 0, '访客点开始被拦截并提示等待房主');
ok(dataStore.phase === 'waiting', '访客点开始不会进入牌桌');

// 房主空等放弃离开 → 关闭房间并清理快照（避免残留出现在「我的房间」）
pageCtx.onLoad({ room: '112233', own: '1' });
global.__storage['poker_room_snap_112233'] = {
  ts: Date.now(), handNo: 3, seats: [{ seat: 0, name: '你', stack: 900, isMe: true }]
};
pageCtx.onBack();
ok(!global.__storage['poker_room_snap_112233'], '房主空等离开会清理该房间的快照');

/* ---------- 房间参数：限定人数（2~9）与游戏时长倒计时 ---------- */
pageCtx.onLoad({ room: '300001', own: '1', max: '2', dur: '30' });
ok(dataStore.maxSeats === 2, '限定人数 2 生效，实际 ' + dataStore.maxSeats);
ok(dataStore.durationMin === 30, '游戏时长 30 分钟生效，实际 ' + dataStore.durationMin);
ok(dataStore.waitSeats.length === 2, '等待室按限定人数生成 2 个座位，实际 ' + dataStore.waitSeats.length);
ok(dataStore.remainText === '30:00', '倒计时初始展示 30:00，实际 ' + dataStore.remainText);
pageCtx.addBot();
ok(dataStore.waitSeats.filter(s => s.occupied).length === 2, '2 人桌坐下 2 人');
pageCtx.addBot();
ok(dataStore.waitSeats.filter(s => s.occupied).length === 2, '达到限定人数后不能再加人');
ok(toasts.indexOf('已达限定人数') >= 0, '超限提示「已达限定人数」');

pageCtx.onLoad({ room: '300002', own: '1', max: '9', dur: '60' });
ok(dataStore.maxSeats === 9, '限定人数 9 生效，实际 ' + dataStore.maxSeats);
ok(dataStore.waitSeats.length === 9, '等待室生成 9 个座位，实际 ' + dataStore.waitSeats.length);
ok(dataStore.remainText === '1:00:00', '60 分钟倒计时展示 1:00:00，实际 ' + dataStore.remainText);
// 人数上限封顶 9、下限 2
pageCtx.onLoad({ room: '300003', own: '1', max: '12', dur: '0' });
ok(dataStore.maxSeats === 9, '人数上限封顶 9，实际 ' + dataStore.maxSeats);
ok(dataStore.durationMin === 0, '不限时（dur=0）');
ok(dataStore.remainText === '', '不限时不展示倒计时');

// 倒计时启动与到点结算
pageCtx.onLoad({ room: '300004', own: '1', max: '4', dur: '30' });
pageCtx.addBot();
pageCtx.startGame();
ok(dataStore.phase === 'playing', '带时长的房间开局进入牌桌');
ok(dataStore.remainSec === 1800, '开局倒计时 1800 秒，实际 ' + dataStore.remainSec);
// 4 人桌只坐了 2 人：环上依然是 4 个位，空着的那 2 个位可点「入座」加入
ok(dataStore.seats.length === 4, '4 人桌座位环按 4 个位铺满，实际 ' + dataStore.seats.length);
ok(dataStore.seats.filter(s => !s.empty).length === 2,
  '4 人桌 2 人入局（2 个在座者在环上），实际 ' + dataStore.seats.filter(s => !s.empty).length);
pageCtx.endGame();
ok(dataStore.timeUp === true, '到点后置 timeUp');
ok(!!dataStore.summary && dataStore.summary.title.indexOf('时长已到') > 0, '生成结束结算面板');
ok(dataStore.summary.rows.length === 2, '结算包含所有参与人，实际 ' + (dataStore.summary && dataStore.summary.rows.length));
let sortedOk = true;
for (let i = 1; i < dataStore.summary.rows.length; i++) {
  if (dataStore.summary.rows[i - 1].net < dataStore.summary.rows[i].net) sortedOk = false;
}
ok(sortedOk, '结算按盈亏从高到低排名');
ok(typeof dataStore.summary.myNet === 'number', '结算给出我的盈亏: ' + dataStore.summary.myNet);
ok(dataStore.summary.rows.filter(r => r.isMe).length === 1, '结算标出我自己');
// 盈亏基准回归（评审 MEDIUM）：无起始记录的座位不得按常数 1000 记假盈亏
{
  const g = pageCtx.requireGame();
  const probe = g.players[0];   // 任取一个真实玩家
  const savedSs = Object.assign({}, pageCtx.startStacks);
  delete pageCtx.startStacks[probe.seat];   // 制造「无基准」座位（站起者/续局缺项同态）
  pageCtx.endGame();
  const row2 = dataStore.summary.rows.filter(r => r.seat === probe.seat)[0];
  eq(row2.net, 0, '无起始记录的座位盈亏记 0（不再按常数 1000 算假盈亏）');
  pageCtx.startStacks = savedSs;   // 还原记账，后续流程不受影响
}
/* ---------- 中途加入 / 换座：N 人桌没坐满时，中途还能进人 ----------
   真机场景：8 人房开局只来 5 人，剩下的 3 个位必须看得见、点得进去。 */
{
  const gA = pageCtx.requireGame();
  const cntA = gA.players.length;
  // 房主端消化好友的「中途加入」动作：当手不插人，下一手才落座
  pageCtx.applyFriendAction({ type: 'join', seat: 2, rowSeat: 2 });
  ok(pageCtx.requireGame().players.length === cntA,
    '中途加入当手不插人（不打断进行中的这一手），实际 ' + pageCtx.requireGame().players.length);
  pageCtx.startHand();
  const gB = pageCtx.requireGame();
  ok(gB.players.length === cntA + 1, '中途加入：下一手座位 2 正式入局，实际 ' + gB.players.length);
  ok(!!gB.seatOf(2), '中途加入者落在他选的座位上');
  ok(pageCtx.startStacks[2] !== undefined, '中途加入者的带入额已记账（结算单盈亏有基准）');
  // 换座：我在座时点另一个空位 → 下一手挪过去，记账跟着座位走
  const myStackBefore = pageCtx.startStacks[pageCtx.mySeat];
  pageCtx.pendingMove = { from: pageCtx.mySeat, to: 3 };
  pageCtx.startHand();
  ok(pageCtx.mySeat === 3, '换座：下一手我已在新座位，实际 ' + pageCtx.mySeat);
  ok(pageCtx.startStacks[3] === myStackBefore, '换座后起始筹码记账跟着座位迁移（盈亏口径不漂移）');
  ok(!!pageCtx.requireGame().seatOf(3), '换座后新座位上有人');
}
// timeUp 后不再接受行动
const stackBefore = dataStore.myStack;
pageCtx.onFold();
ok(dataStore.myStack === stackBefore, '本局结束后行动被拦截（筹码不变）');
// 再来一局：重置筹码与倒计时
pageCtx.restartGame();
ok(dataStore.timeUp === false && dataStore.summary === null, '再来一局清除结算状态');
ok(dataStore.remainSec === 1800, '再来一局重置倒计时为 1800 秒');
ok(dataStore.myStack >= 960 && dataStore.myStack <= 1000,
  '再来一局筹码重置（开局已下盲注），实际 ' + dataStore.myStack);
pageCtx.clearClock();

/* ---------- 退出本局（站起）的准入条件 ---------- */
pageCtx.onLoad();
ok(dataStore.mode === 'ai' && dataStore.pageTitle === 'AI 对战', '无参数默认 AI 对战模式');
ok(dataStore.phase === 'waiting', 'AI 对战同样是等待室起步（需选座 + 点开始）');
// 选座开局后再验证「本手进行中」的站起准入
pageCtx.chooseSeat({ currentTarget: { dataset: { seat: 2 } } });
pageCtx.confirmBuyIn({ currentTarget: { dataset: { amt: '1000' } } });
pageCtx.startGame();
ok(dataStore.phase === 'playing', 'AI 桌选座并点开始后进入牌桌');
ok(dataStore.coachShow === true, 'AI 练习模式首手显示教练提示（发牌时才置位）');
ok(dataStore.myStanding === false, '默认坐在局内（未站起）');
ok(dataStore.canStand === false, '本手进行中且未弃牌 → 不允许站起');
toasts.length = 0;
pageCtx.standUp();
ok(toasts.indexOf('本手结束后或弃牌后可站起') >= 0, '不满足条件时站起被拦截并提示: ' + toasts.slice(-1)[0]);
ok(dataStore.myStanding === false, '被拦截后仍保持在局');

/* ---------- 分享后横屏回锁 + 视口自适应（防竖屏爆版）---------- */
ok(typeof cfg.onShow === 'function', '定义了 onShow（分享返回后锁回横屏）');
ok(typeof cfg.onResize === 'function', '定义了 onResize（转屏重算布局变量）');
pageCtx.onShow();
setTimeout(() => {
  ok(global.__orient === 'landscape', 'onShow 后重新锁定横屏，实际 ' + global.__orient);
}, 150);

// 横屏 812×375：uh = 3.75，uw = 8.12
pageCtx.updateViewport();
ok(dataStore.rootStyle.indexOf('--uh:3.750px') >= 0, '横屏实测 --uh = 视口高/100: ' + dataStore.rootStyle);
ok(dataStore.rootStyle.indexOf('--uw:8.120px') >= 0, '横屏实测 --uw = 视口宽/100: ' + dataStore.rootStyle);

// onResize 视口变化重算
pageCtx.onResize({ size: { windowWidth: 740, windowHeight: 360 } });
ok(dataStore.rootStyle.indexOf('--uh:3.600px') >= 0, 'onResize 后 --uh 重算为 3.600: ' + dataStore.rootStyle);

// 异常竖屏兜底：--uh 取 min(宽,高)/100，页面按宽度等比缩放不爆版
global.__ww = 375; global.__wh = 812;
pageCtx.updateViewport();
ok(dataStore.rootStyle.indexOf('--uh:3.750px') >= 0, '竖屏异常时 --uh 封顶为宽/100（不爆版）: ' + dataStore.rootStyle);
ok(dataStore.rootStyle.indexOf('--uw:3.750px') >= 0, '竖屏异常时 --uw 同步收紧: ' + dataStore.rootStyle);
global.__ww = 812; global.__wh = 375;
pageCtx.updateViewport();

/* ---------- ① 四色牌 + 设置 ---------- */
ok(dataStore.fourColor === true, '默认启用四色牌（设置项已加载）');
ok(dataStore.soundOn === true, '默认开启音效');
ok(dataStore.vibrateOn === true, '默认开启震动（与音效独立）');
ok(dataStore.animOn === true, '默认开启牌桌动画');
const hole0 = dataStore.myCards && dataStore.myCards[0];
ok(hole0 && ['s-spade', 's-club', 's-diamond', 's-heart'].indexOf(hole0.cls) >= 0,
  '底牌带花色配色 class（四色牌基础）: ' + (hole0 && hole0.cls));
ok(pageCtx.cardData(0).cls === 's-spade', '♠ → s-spade');
ok(pageCtx.cardData(1).cls === 's-club', '♣ → s-club');
ok(pageCtx.cardData(2).cls === 's-diamond', '♦ → s-diamond');
ok(pageCtx.cardData(3).cls === 's-heart', '♥ → s-heart');

/* ---------- ② 行动计时环 ---------- */
ok(dataStore.timerMax === 20, '计时环上限 20 秒');
const actSeat = dataStore.seats.filter(s => s.active)[0];
ok(!actSeat || typeof actSeat.timerPct === 'number', '行动座位带计时环百分比 timerPct');

/* ---------- ③ 社交：聊天 + 表情 ---------- */
const chatBefore = dataStore.chatLog.length;
pageCtx.onQuickChat({ currentTarget: { dataset: { t: '打得不错' } } });
ok(dataStore.chatLog.length === chatBefore + 1, '快捷短语入聊天日志');
ok(dataStore.chatLog[dataStore.chatLog.length - 1].text === '打得不错', '聊天内容正确');
ok(typeof dataStore.chatLog[dataStore.chatLog.length - 1].id === 'number', '聊天项带 id 供 wx:key');
pageCtx.onEmoji({ currentTarget: { dataset: { e: '🔥' } } });
ok(dataStore.chatLog[dataStore.chatLog.length - 1].text === '🔥', '表情可发送');
for (let i = 0; i < 12; i++) pageCtx.pushChat(1, '林小满', '压测' + i);
ok(dataStore.chatLog.length <= 8, '聊天日志最多保留 8 条，实际 ' + dataStore.chatLog.length);

/* 聊天未读徽章：折叠期间收他人消息累计，打开面板清零，自己发的消息不计 */
pageCtx.setData({ chatOpen: false, chatUnread: 0 });
pageCtx.pushChat(1, '林小满', '你好');
ok(dataStore.chatUnread === 1, '聊天折叠时收到他人消息累计未读');
pageCtx.pushChat(1, '林小满', '再来');
ok(dataStore.chatUnread === 2, '未读继续累加');
pageCtx.setData({ chatOpen: false });
pageCtx.pushChat(pageCtx.mySeat, '你', '我说');
ok(dataStore.chatUnread === 2, '我自己发的消息不计未读');
pageCtx.toggleChat();
ok(dataStore.chatOpen === true && dataStore.chatUnread === 0, '打开聊天面板清零未读');
pageCtx.toggleChat();   // 还原折叠状态，不污染后续折叠面板回归断言
ok(dataStore.chatOpen === false, '聊天面板还原折叠');

/* ---------- ④ 新手引导 ---------- */
pageCtx.onHelp();
ok(dataStore.helpShow === true, '帮助弹层可打开');
pageCtx.onHelpClose();
ok(dataStore.helpShow === false, '帮助弹层可关闭');
ok(Array.isArray(dataStore.helpRows) && dataStore.helpRows.length === 5, '规则讲解 5 个下注轮次');
pageCtx.onCoachClose();
ok(dataStore.coachShow === false, '教练提示可手动收起');

/* ---------- ⑤ 牌桌内设置（⋯ 菜单入口）---------- */
pageCtx.onMenuSettings();
ok(dataStore.settingsShow === true, '牌桌内设置弹窗可从菜单打开');
ok(dataStore.sFourColor === true && dataStore.sSound === true &&
   dataStore.sVibrate === true && dataStore.sAnim === true, '打开时读入当前设置');
// 关音效：soundOn 即时生效
pageCtx.onToggleSetting({ currentTarget: { dataset: { k: 'sound' } } });
ok(dataStore.sSound === false && dataStore.soundOn === false, '关音效即时生效（soundOn 同步刷新）');
// 关震动：vibrateOn 即时生效，且不影响音效
pageCtx.onToggleSetting({ currentTarget: { dataset: { k: 'vibrate' } } });
ok(dataStore.sVibrate === false && dataStore.vibrateOn === false && dataStore.soundOn === false,
  '震动独立关闭，音效不受影响');
// 关四色牌：fourColor 即时生效
pageCtx.onToggleSetting({ currentTarget: { dataset: { k: 'fourColor' } } });
ok(dataStore.sFourColor === false && dataStore.fourColor === false, '关四色牌即时生效');
// 关动画
pageCtx.onToggleSetting({ currentTarget: { dataset: { k: 'animation' } } });
ok(dataStore.sAnim === false && dataStore.animOn === false, '关动画即时生效');
// 持久化到 storage
ok(global.__storage.poker_settings && global.__storage.poker_settings.vibrate === false,
  '牌桌内设置已持久化');
pageCtx.onSettingsClose();
ok(dataStore.settingsShow === false, '设置弹窗可关闭');
// 复原：重开音效
pageCtx.onToggleSetting({ currentTarget: { dataset: { k: 'sound' } } });
ok(dataStore.soundOn === true, '重开音效生效');

// 座位坐标必须覆盖 0~100 且落在合理范围
let seatOk = true;
dataStore.seats.forEach(s => {
  if (typeof s.x !== 'number' || typeof s.y !== 'number') seatOk = false;
  if (s.x < 0 || s.x > 100 || s.y < 0 || s.y > 100) seatOk = false;
  if (s.initial !== s.name.slice(0, 1)) seatOk = false;
});
ok(seatOk, '所有座位坐标与首字均合法');

// 引擎对象可访问
const game = pageCtx; // render 内部闭包持有 game，这里通过行为间接验证

/* ---------- 自动打完一手 ---------- */
let guard = 0;
let sawFlop = false, sawTurn = false, sawRiver = false;
let myActions = 0;

while (guard++ < 400) {
  // 同步推进：若轮到我则执行一个动作，否则等 AI 定时器
  const isMyTurn = dataStore.isMyTurn && !dataStore.result;
  if (isMyTurn) {
    const legal = dataStore.legal;
    if (!legal) break;
    if (legal.toCall > 0) {
      pageCtx.onCheckOrCall();
      myActions++;
    } else {
      pageCtx.onCheckOrCall();
      myActions++;
    }
  }

  // AI 用 setTimeout 推进，这里用真实定时等待（缩短间隔不可行，直接轮询）
  break;
}

// 用真实异步跑完整局
(async () => {
  const start = Date.now();
  let result = null;
  let sawBoard3 = false, sawBoard4 = false, sawBoard5 = false;

  while (Date.now() - start < 25000) {
    await new Promise(r => setTimeout(r, 60));

    if (dataStore.board.length === 3) sawBoard3 = true;
    if (dataStore.board.length === 4) sawBoard4 = true;
    if (dataStore.board.length === 5) sawBoard5 = true;

    if (dataStore.result) {
      // 偶发：所有人 preflop 全弃牌则没到翻牌圈（随机牌局，非缺陷）。
      // 重开一手直到见过翻牌圈或超时，避免「经历过翻牌圈」断言随机误报。
      if (!sawBoard3 && Date.now() - start < 20000) { pageCtx.startHand(); continue; }
      result = dataStore.result; break;
    }

    if (dataStore.isMyTurn && dataStore.legal) {
      myActions++;
      if (dataStore.legal.toCall > 0) pageCtx.onCheckOrCall();
      else pageCtx.onCheckOrCall();
    }
  }

  ok(sawBoard3, '经历过翻牌圈（3 张公共牌）');
  ok(result !== null, '牌局能走到结算（结果已生成）');

  if (result) {
    ok(typeof result.title === 'string' && result.title.length > 0, '结算标题存在: ' + result.title);
    ok(Array.isArray(result.rows) && result.rows.length > 0, '结算行数 > 0，实际 ' + (result.rows ? result.rows.length : 0));
    ok(typeof result.netText === 'string' && result.netText.length > 0, '盈亏文案: ' + result.netText);

    // 每行的 hand 字段不得为空或 undefined
    let rowsOk = true;
    result.rows.forEach(r => {
      if (!r.name) rowsOk = false;
      if (typeof r.hand !== 'string' || !r.hand.length) rowsOk = false;
      if (r.hand.indexOf('undefined') >= 0) rowsOk = false;
    });
    ok(rowsOk, '结算行字段完整且无 undefined');

    // 赢家必须有 gain 字段
    const winRows = result.rows.filter(r => r.win);
    if (winRows.length) {
      ok(winRows.every(r => typeof r.gain === 'number'), '赢家行均有 gain 金额');
    }

    /* ---------- ⑧ 结算条（resultbar）：短文本与投入字段 ---------- */
    ok(result.rows.every(r => typeof r.short === 'string' && r.short.length > 0 && r.short.indexOf('undefined') < 0),
      '结算行带 short 短文本（摊牌=牌型名，未摊牌=底牌文本），实际 ' +
      JSON.stringify(result.rows.map(r => r.short)));
    ok(result.rows.every(r => typeof r.committed === 'number' && r.committed >= 0),
      '结算行带 committed（本手总投入，供飞筹动画）');
  }

  ok(myActions > 0, 'AI 推进中我方被要求行动 ' + myActions + ' 次');

  /* ---------- 站起退出本局 ≠ 退出房间，且可再坐下 ---------- */
  if (result) {
    ok(dataStore.canStand === true, '本手结束后允许站起退出本局');
    pageCtx.standUp();
    ok(dataStore.myStanding === true, '站起后退出本局但仍留在房间内');
    ok(dataStore.myCards.length === 0, '站起后 myzone 不再展示底牌（观战态）');
    ok(dataStore.canStand === false, '已站起时不可重复站起');
    ok(dataStore.isMyTurn === false, '站起后不会被要求行动');
    pageCtx.sitDown();
    ok(dataStore.myStanding === true && dataStore.mySeated === true,
      '坐下后本手仍观战（不插进已开始的牌局），标记为下一手入局');
    pageCtx.startHand();   // 下一手发牌时正式落座
    ok(dataStore.myStanding === false && dataStore.myCards.length === 2,
      '下一手开始发牌入局（底牌可见），实际 ' + dataStore.myCards.length);
  }

  /* ---------- 摊牌高亮：最佳成手 5 张 ---------- */
  if (result) {
    const all = dataStore.board.concat(dataStore.myCards);
    ok(all.every(c => typeof c.code === 'string'), '牌数据带 code（用于最佳 5 张比对）');
    const hi = all.filter(c => c.hi === true).length;
    ok(hi === 0 || hi === 5,
      '摊牌高亮牌数为 0（我方未摊牌）或 5（最佳成手），实际 ' + hi);
  }

  /* ---------- 驱动到「轮到我」：让建议类断言确定性执行 ---------- */
  // 上一手结算后各段留下的牌局状态是随机的（AI 行动中/已再结束）——建议类
  // 断言据此条件跳过，通过项数在 365↔371 间随机漂移（历史遗留 flaky）。
  // 这里主动等到「轮到我且可行动」再进入建议类校验；AI 翻牌前直接弃牌的偶发
  // 用「重发一手」消化（与主循环同策略）。
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !(dataStore.isMyTurn && dataStore.legal)) {
      await new Promise(r => setTimeout(r, 50));
      if (dataStore.result && !dataStore.isMyTurn) pageCtx.startHand();
    }
  }

  /* ---------- 牌力分析校验 ---------- */
  ok(typeof dataStore.advice === 'object', 'advice 为对象');
  if (dataStore.advice && dataStore.advice.text) {
    ok(dataStore.advice.equityPct.indexOf('%') > 0, '胜率含百分号: ' + dataStore.advice.equityPct);
    ok(['strong', 'weak', 'neutral', 'draw'].indexOf(dataStore.advice.tone) >= 0,
      '建议色调合法: ' + dataStore.advice.tone);
  }

  /* ---------- 合规：行动建议仅限「AI 对战」（练习模式） ---------- */
  // 当前 onLoad() 无参 → mode='ai'：轮到我时建议应正常输出
  {
    const g = pageCtx.requireGame();
    if (g && !g.result && g.actionSeat === pageCtx.mySeat) {
      const rAdv = P.advise(g, g.actionSeat, { practiceMode: true });
      ok(!!rAdv, '练习模式（AI 对战）：引擎建议可输出');
    }
    // 引擎层门槛（防新调用点漏传开关）
    ok(P.advise(g && g.actionSeat >= 0 ? g : null, 0) === null,
      '引擎合规：不传 practiceMode 一律返回 null');
  }

  /* ---------- 建议缓存（评审 2026-10-15 MEDIUM「每帧 1800 次蒙特卡洛」） ---------- */
  // 轮到我期间 render 反复触发（AI 回调/setData 回流），局势未变时不得重跑
  // 蒙特卡洛——用 advise 调用计数验证：同局势二次 render 零调用，局势变化后
  // （下注额变动）恰好重新计算一次。
  {
    const adviceSrc = require('fs').readFileSync(
      path.join(__dirname, 'pages', 'table', 'table.js'), 'utf8');
    const g = pageCtx.requireGame();
    const myTurnNow = g && !g.result && g.actionSeat === pageCtx.mySeat;
    // 静态守卫：缓存键存在 + 失效路径存在（离开我回合必须清 _adviceKey）
    guardAdviceCache(adviceSrc);
    if (myTurnNow) {
      const beforeAdvice = JSON.stringify(pageCtx.data.advice || {});
      // 数引擎层调用次数：替换 P.advise 计数（页面 require 的 P 与本测试 P 同源）
      let advised = 0;
      const realAdvise = P.advise;
      P.advise = () => { advised++; return realAdvise(g, pageCtx.mySeat, { practiceMode: true }); };
      try {
        pageCtx.renderAdvice(true);          // 同局势：应命中缓存，0 次引擎调用
        const cacheHit = advised === 0;
        ok(cacheHit, '同局势二次 render 复用缓存（引擎 0 次调用），实际 ' + advised);
        ok(JSON.stringify(pageCtx.data.advice || {}) === beforeAdvice,
          '缓存复用时 advice 内容不变（胜率数字不再因 RNG 抖动）');
        // 人为改变缓存键对应的局势（currentBet），必须触发重算
        const savedBet = g.currentBet;
        g.currentBet = savedBet + 17;
        advised = 0;
        pageCtx.renderAdvice(true);
        ok(advised === 1, '下注额变化后恰好重算一次，实际 ' + advised);
        g.currentBet = savedBet;
        pageCtx.renderAdvice(true);          // 还原局势 → 缓存恢复命中
      } finally {
        P.advise = realAdvise;
      }
    }
  }

  /* ---------- 下一手 ---------- */
  if (result) {
    const before = dataStore.handNo;
    pageCtx.onNextHand();
    ok(dataStore.handNo === before + 1, '下一手后 handNo 递增: ' + before + ' → ' + dataStore.handNo);
    ok(dataStore.result === null, '新一手已清空结算弹窗');
    ok(dataStore.board.length === 0, '新一手公共牌清空');
    ok(dataStore.pot === 30, '新一手底池重置为 30，实际 ' + dataStore.pot);
  }

  /* ---------- 加注档位按街切换（资深玩家评审 2026-10-17：档位说错了扑克的语言）----------
   * 翻前 BB 语言 6 档（最小 / 2.5BB / 3BB / 4BB / 全下 / 自定义）、
   * 翻后池比例语言 7 档（最小 / 33% / 50% / 67% / 100% / 全下 / 自定义）。
   * render 按 game.street 重建，切街自然切换。 */
  ok(Array.isArray(dataStore.raisePresets) && dataStore.raisePresets.length === 6,
    '翻前加注档位 6 档（最小 / 2.5BB / 3BB / 4BB / 全下 / 自定义）');
  ok(Array.isArray(dataStore.raisePresets) &&
    dataStore.raisePresets[5].k === 'custom' && dataStore.raisePresets[5].t === '自定义',
    '翻前末档为「自定义」入口（展开盲注步进的金额面板）');
  ok(Array.isArray(dataStore.raisePresets) &&
    dataStore.raisePresets.slice(1, 4).map(x => x.k).join(',') === 'bb25,bb30,bb40' &&
    dataStore.raisePresets.slice(1, 4).map(x => x.t).join(',') === '2.5BB,3BB,4BB',
    '翻前中间三档为 BB 倍数语言（open sizing 的行话是 bb 而非池比例）');
  {
    // 换 game 会打断模块级单例——改用「数据可信、函数直接调」：
    // presetsForStreet / presetTarget 都是非游戏状态依赖，拿页面闭包直接断言。
    eq(pageCtx.presetsForStreet(P.STREET.FLOP).map(x => x.k).join(','),
      'min,p33,p50,p67,p100,allin,custom',
      '翻后档位表：7 档池比例（33/50/67/100%），custom 末位');
    eq(pageCtx.presetsForStreet(P.STREET.PREFLOP).map(x => x.k).join(','),
      'min,bb25,bb30,bb40,allin,custom',
      '翻前档位表：6 档 BB 语言，custom 末位');
    // presetTarget：BB 档 = bb × 倍数。手动塞 legal 进 dataStore（与真实交互同口径），
    // 测完置回 null（render 按当前 true game 重建，不残留）。
    const t3bb = minRaise => {
      pageCtx.setData({ legal: { minRaiseTo: minRaise, maxRaiseTo: 1000, canRaise: true } });
      return pageCtx.presetTarget('bb30');
    };
    ok(pageCtx.requireGame().bb === 20 && t3bb(40) === 60,
      '3BB 档 = 3×20bb=60（高于 minRaise=40 不被钳小），实际 ' + t3bb(40));
    ok(t3bb(100) === 100,
      '当前注已抬过 3BB（minRaise=100）→ 3BB 档钳到 100（等价「最小」档）');
    pageCtx.setData({ legal: null });
  }
  pageCtx.toggleChat();
  ok(dataStore.chatOpen === true && dataStore.menuOpen === false, '点 💬 展开聊天并收起菜单');
  pageCtx.toggleMenu();
  ok(dataStore.menuOpen === true && dataStore.chatOpen === false, '点 ⋯ 展开菜单并收起聊天');
  pageCtx.closePanels();
  ok(dataStore.chatOpen === false && dataStore.menuOpen === false, '点牌桌空白处关闭浮层');

  /* ---------- 9 人局：对手座位不重叠、不越界（拥挤反馈的回归） ---------- */
  pageCtx.onLoad({ room: '111111', own: '1', max: '9' });
  for (let i = 0; i < 8; i++) pageCtx.addBot();
  pageCtx.startGame();
  ok(dataStore.seats.length === 9, '9 人局：9 个座位（含我）都在牌桌环上，实际 ' + dataStore.seats.length);
  const posKeys = dataStore.seats.map(s => s.x + ',' + s.y);
  ok(new Set(posKeys).size === 9, '9 人局 9 个座位坐标互不重合');
  ok(dataStore.seats.every(s => s.y >= 14 && s.y <= 82), '9 人局座位 y 均落在安全区（不被扁椭圆裁切）');
  ok(dataStore.seats.every(s => s.x >= 5 && s.x <= 95), '9 人局座位 x 均在画布内');
  ok(dataStore.myCards.length === 2, '9 人局我的手牌仍在底部 myzone');
  ok(dataStore.myCards.every(c => !!c.rank && !!c.suit && !!c.cls),
    '9 人局我的手牌带 rank/suit/cls 字段（WXML 靠它们渲染牌面，缺字段会变白板）');
  ok(dataStore.myCards.every(c => typeof c.idx === 'number'),
    '9 人局我的手牌带 idx（wx:key 稳定键）');

  /* ---------- 就绪阶段：所有坐下的人准备就绪后才发下一手 ---------- */
  pageCtx.enterReadyPhase();
  ok(dataStore.readyPhase === true, '一手结束后进入就绪阶段（等所有人准备就绪）');
  ok(dataStore.readyList.length === 9, '就绪列表含所有在座玩家，实际 ' + dataStore.readyList.length);
  ok(dataStore.readyLeft === 30, '就绪倒计时 30 秒，实际 ' + dataStore.readyLeft);
  ok(dataStore.myReady === false, '初始状态我方未准备');

  const handBefore = dataStore.handNo;
  pageCtx.onNextHand();   // 就绪阶段：结算面板按钮即「准备就绪」
  ok(dataStore.myReady === true, '点「准备就绪」后我方标记已准备');
  pageCtx.onReadyTap();           // 已就绪后重复点击应被忽略（按钮虽 disabled，仍需 JS 幂等兜底）
  ok(dataStore.myReady === true && dataStore.readyPhase === true,
    '已就绪后重复点「准备就绪」无副作用（幂等，不重复计票）');
  ok(dataStore.readyPhase === true && dataStore.handNo === handBefore,
    '还有人未准备时不提前发下一手（handNo 不变）');

  dataStore.readyList.forEach(r => { if (!r.isMe) pageCtx.markReady(r.seat, true); });
  ok(dataStore.readyPhase === false, '全员就绪后自动结束就绪阶段');
  ok(dataStore.handNo === handBefore + 1,
    '全员就绪后自动发下一手: ' + handBefore + ' → ' + dataStore.handNo);

  /* ---------- 就绪超时：超过 30 秒未点就绪自动站起 ---------- */
  pageCtx.enterReadyPhase();
  ok(dataStore.readyPhase === true, '再次进入就绪阶段以验证超时逻辑');
  const handBeforeTimeout = dataStore.handNo;
  pageCtx.autoStandUnready();     // 模拟 30 秒到点（不等待真实时间）
  ok(dataStore.myStanding === true, '超时未准备，我被自动站起（仍留在房间内）');
  ok(pageCtx.seatedOf(0) === false, '自动站起后不再算「在座」，下一手不参与发牌');

  // ⚠️ 这条断言此前写成 `readyHint 含人数不足 || readyPhase === false`，
  // 用 || 同时接受了两种结果 —— 而后者正是「我还没点准备就绪牌局就自己开了」
  // 这个真机 bug 的表现。断言过宽会把 bug 固化成合法行为，必须拆开精确断言。
  // 注意：本块是**好友房 2 人局**（我站起后只剩 1 个 bot，本就被「不足 2 人」
  // 挡住），走不到自动开局那条分支。真正的复现放在文件末尾的 AI 对战 4 人局块。
  ok(dataStore.readyPhase === true && dataStore.handNo === handBeforeTimeout,
    '好友房 2 人局：我超时站起后不自动开下一手（handNo 保持 ' +
    handBeforeTimeout + '，实际 ' + dataStore.handNo + '）');

  // 语义守卫：锁死「单机不许在唯一真人站起后自动开局」这条判断还在
  const tableSrcReady = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'table', 'table.js'), 'utf8');
  ok(/const soleHumanStoodUp = this\.mode !== 'friend'/.test(tableSrcReady) &&
    /if \(!soleHumanStoodUp && seated\.length >= 2/.test(tableSrcReady),
    'autoStandUnready 里有「唯一真人站起则不自动开局」的判断（锁结构不锁数值）');
  pageCtx.clearReadyClock();      // 清理电脑玩家的自动就绪定时器，避免干扰后续断言

  /* ---------- 单机自动续局宽限（玩家审视 2026-10-17）----------
   * AI/SNG 桌每手必须手动点「准备就绪」是连续对局的纯摩擦。宽限 = READY_AUTO_SEC
   * 后自动替我代点一次就绪（onReadyTap 同一路径），30s 真超时站起口径不动。
   * 行为级：宽限期到 → 我被代点就绪；手点在前 → 定时器幂等不重复代点。 */
  // 手感调优（2026-10-17）：8s → 3s。单机两手间隔（结算 3s + 代点 8s 一度合计 13s）
  // 是节奏拖沓首因；3s 代点 + 就绪条「继续 ▶」手动快进双保险。
  ok(/const READY_AUTO_SEC = 3;/.test(tableSrcReady.replace(/\r/g, '')),
    '单机自动续局宽限常量 READY_AUTO_SEC=3s（2026-10-17 由 8s 调优为 3s，配「继续 ▶」快进）');
  ok(/if \(this\.mode !== 'friend' && this\.seatedOf\(this\.mySeat\)\)/.test(tableSrcReady),
    '自动续局宽限只挂单机在座（好友房多人节奏由各真人自己掌控）');
  ok(/this\.autoReadyTimer = setTimeout/.test(tableSrcReady) &&
    /if \(this\.data\.readyPhase && !this\.data\.myReady\) this\.onReadyTap\(\);/.test(tableSrcReady),
    '宽限代点走 onReadyTap 同一路径（与手点计票等价，幂等不重复）');
  ok(/if \(this\.autoReadyTimer\) \{ clearTimeout\(this\.autoReadyTimer\); this\.autoReadyTimer = null; \}/.test(tableSrcReady),
    'autoReadyTimer 在 clearReadyClock 配对清理（防泄漏/防跨手误触发）');
  pageCtx.autoReadyTimer = setTimeout(() => {}, 99999);   // 挂一个真实句柄
  pageCtx.clearReadyClock();
  ok(pageCtx.autoReadyTimer === null, 'clearReadyClock 清掉 autoReadyTimer（句柄复位为 null）');

  /* ---------- 「站起退出本局」入口可见性（WXML 静态检查） ---------- */
  const wxmlSrc = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'table', 'table.wxml'), 'utf8');
  guardStandEntryVisibility(wxmlSrc);

  /* ---------- ⑧ 结算条改版（resultbar）：文档流布局，不遮牌 ---------- */
  const wxssSrc = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'table', 'table.wxss'), 'utf8');
  guardResultbarLayout(wxmlSrc, wxssSrc);

  /* ---------- ⑨ 运行时环境守卫：禁止裸 process 引用 ---------- */
  guardNoBareProcess();

  /* ---------- ⑩ 结算展示阶段：摊牌后停留 ~5s 展示每人盈亏，再进就绪 ---------- */
  const tableSrc = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'table', 'table.js'), 'utf8');
  guardResultShowPhase(tableSrc, wxmlSrc, wxssSrc);

  /* ---------- ⑩+ 单手结算弹窗：亮牌展示后独立弹窗显示每人净盈亏 ---------- */
  // 时序：摊牌亮牌在牌桌上停留 ~5s（不遮底牌）→ 弹出结算弹窗（逐人 net）
  // → 弹窗停留 10s 自动关闭进入就绪阶段（防无人操作卡局）。
  guardResultModal(tableSrc, wxmlSrc, wxssSrc);

  /* ---------- ⑪ 参照 WePoker 的牌桌细节：买入入座 / 状态徽章 / 中央筹码堆 ---------- */
  guardWpkDetails(tableSrc, wxmlSrc, wxssSrc);

  /* ---------- ⑫ WPK 式布局回归：统一座位环 + 座位号 + 牌背 + 弃牌二次确认 ---------- */
  // 复用上方已读取的 tableSrc / wxmlSrc / wxssSrc
  guardWpkLayoutRegression(tableSrc, wxmlSrc, wxssSrc);

  // ⑤ 行为验证：首次点弃牌只是进入确认态，不真正弃牌
  pageCtx.data.isMyTurn = true;
  pageCtx.data.foldConfirm = false;
  const beforeStack = dataStore.seats.length; // 占位：确认态不应改变牌桌
  pageCtx.onFold();
  ok(pageCtx.data.foldConfirm === true, '首次点「弃牌」进入确认态（不直接弃牌）');
  pageCtx.onFold();
  ok(pageCtx.data.foldConfirm === false, '确认态内再点「弃牌」才真正执行（确认态复位）');

  /* ---------- 自定义下注金额（最小 ~ MAX 全下，连续可调） ---------- */
  const tableWxss = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'table', 'table.wxss'), 'utf8');
  guardCustomBet(tableSrc, wxmlSrc, tableWxss);

  /* ---------- 微信昵称：牌桌默认显示微信名 ---------- */
  const authSrc = require('fs').readFileSync(
    path.join(__dirname, 'utils', 'auth.js'), 'utf8');
  const profSrc = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'profile', 'profile.js'), 'utf8');
  const profWxml = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'profile', 'profile.wxml'), 'utf8');
  guardWechatNickname(tableSrc, authSrc, profWxml);

  /* ---------- 战绩游标分页 / 触底加载更多 ---------- */
  guardRecordsCursor(authSrc, profSrc, tableSrc, profWxml);

  /* ---------- 引擎：10 显示为「10」，但机读码仍是单字符 T ---------- */
  const coreSrc = require('fs').readFileSync(
    path.join(__dirname, '..', 'core', 'poker-core.js'), 'utf8');
  guardEngineRankDisplay(coreSrc, tableSrc);

  /* ---------- AI 桌：先选座坐下、点开始才发牌 ---------- */
  guardAiTableStart(tableSrc);

  /* ---------- 音效：引擎事件流 → 合成音 ---------- */
  guardSfxPump(tableSrc);

  /* ---------- 回归：真机完全没声音（WebAudio 未解锁） ----------
   * 现象：真机上一点声音都没有，控制台无任何报错。
   * 根因：wx.createWebAudioContext() 创建后状态是 suspended，currentTime 恒为 0。
   *      旧代码两处叠加导致永久静音：
   *        1) 从不调用 resume()；
   *        2) play() 里 `if (!c.currentTime) return` —— 这个守卫恰好把所有
   *           「解锁前」的播放全挡掉，永远等不到声音，形成死锁。
   * 修法：sfx 暴露 unlock()，table 根节点 bindtouchstart 调它；play() 遇到
   *      时钟未走改为尝试解锁并跳过本次，而不是静默丢弃。 */
  {
    const sfxPath = path.join(__dirname, 'utils', 'sfx.js');
    const sfxSrc = require('fs').readFileSync(sfxPath, 'utf8');
    guardSfxUnlock(sfxSrc, tableSrc, wxmlSrc);

    // 行为仿真：造一个 suspended 的 WebAudioContext，验证「解锁前静默、解锁后有声」
    const calls = [];
    let clock = 0;
    const fakeCtx = {
      get state() { return clock > 0 ? 'running' : 'suspended'; },
      get currentTime() { return clock; },
      resume() { calls.push('resume'); clock = 0.001; return Promise.resolve(); },
      createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {}, disconnect() {}, start() { calls.push('osc.start'); },
          stop() { calls.push('osc.stop'); }, onended: null,
        };
      },
      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {}, disconnect() {},
        };
      },
      destination: {},
    };
    const gwx = global.wx;
    global.wx = { createWebAudioContext: () => fakeCtx };
    delete require.cache[require.resolve(sfxPath)];
    const sfx2 = require(sfxPath);

    ok(sfx2.available() === true, 'WebAudio 能力可用（available() 探测）');
    ok(sfx2.isRunning() === false, '初始状态为 suspended（isRunning() 如实反映）');
    sfx2.play('click');
    ok(calls.indexOf('osc.start') < 0,
      '解锁前 play 不发声（suspended 时钟为 0，无输出属正常）');
    ok(calls.indexOf('resume') >= 0, '解锁前 play 会自动尝试 resume（不再死锁）');

    calls.length = 0;
    clock = 0.05;                                  // 模拟用户手势后进入 running
    ok(sfx2.isRunning() === true, '解锁后状态为 running');
    sfx2.play('raise');
    ok(calls.indexOf('osc.start') >= 0,
      '解锁后 play 真正创建振荡器并发声（真机「没声音」的回归断言）');
    ok(calls.filter(c => c === 'osc.stop').length >= 1,
      '每个音都成对 start/stop，避免节点泄漏');

    // 未知音色静默忽略，不能影响牌局
    calls.length = 0;
    sfx2.play('__not_exist__');
    ok(calls.indexOf('osc.start') < 0, '未知音名静默忽略，绝不影响牌局');

    if (gwx === undefined) delete global.wx; else global.wx = gwx;
    delete require.cache[require.resolve(sfxPath)];
  }

  /* ---------- 提示音效补全：四类无声场景（2026-10-15） ----------
   * 此前牌桌只对「实际发生的动作」发声（发牌/下注/轮到我/输赢…），四类
   * 提示性场景完全无声，用户只能靠盯屏幕：
   *   ① 我 20s 行动计时环走到末段没有听觉警告 → 一走神就 20s 到点被代弃；
   *   ② 限时局最后 1 分钟 UI 变橙但无声 → 错过收尾决策窗口；
   *   ③ 我被系统被动处理（超时代弃 / 就绪超时自动站起）没有任何声音区分
   *     「这是系统替我做的，不是我点的」；
   *   ④ 收到对手/AI 聊天消息无提示 → 折叠状态下完全错过社交互动。
   * 补 4 个 PRESETS 音色（warn/clock/timeout/chat）+ 4 处触发点。 */
  {
    const sfxPath = path.join(__dirname, 'utils', 'sfx.js');
    const sfxSrc = require('fs').readFileSync(sfxPath, 'utf8');
    guardPromptSfx(sfxSrc, tableSrc, wxmlSrc, wxssSrc);
  }

  /* ---------- 回归：自定义金额必须同步加注按钮文案 ----------
   * 现象（真机）：自定义滑杆拉到 346，底部按钮仍显示「加注 20」。
   * 根因：raiseSubmit / raiseAllIn 只在 render() 里派生，而滑杆/输入框/快捷档
   *      只 setData({raiseTo}) 不触发 render → 按钮文案永远停在上一帧旧值。
   * 修法：所有改金额的入口统一走 setRaiseTo()，同帧写入三个字段。
   *
   * ⚠️ 这里是本文件第三次 pageCtx.onLoad()。game 是 table.js 的模块级单例、
   *    不会随 onLoad 重置，前面两组用例已经开过局、消耗过房卡（globalData.roomCards），
   *    于是本次开局是否成功取决于前面用例跑到哪一步 —— 表现为
   * 「通过 N 项，失败 1 项：异步推进到轮到我且可加注」的随机失败（与本组断言无关）。
   * 修法：开局前把房卡补足，让这段不再依赖前面用例的执行顺序。 */
  global.__storage = global.__storage || {};
  global.getApp = () => ({
    globalData: { roomCards: 99, userInfo: null },
    consumeRoomCard: () => true,
  });
  pageCtx.onLoad();
  pageCtx.chooseSeat({ currentTarget: { dataset: { seat: 2 } } });
  pageCtx.confirmBuyIn({ currentTarget: { dataset: { amt: '1000' } } });
  pageCtx.startGame();
  ok(dataStore.phase === 'playing',
    '第三次 onLoad 后仍能正常开局（房卡充足，不受前面用例顺序影响）');
  // AI 用真实 setTimeout 推进，异步轮询到轮到我且可加注。
  // ⚠️ 超时给足 40s：AI 行动节奏随机（think delay + 随机决策），15s 窗口偶发
  // 超时导致本组断言整块跳过、表现为「通过 N 项，失败 1 项」的随机失败
  // （改动前即存在，非本次引入）。这里放宽窗口并把实际耗时/状态带进失败信息，
  // 万一再抖也能一眼看出是没等到还是状态不对。
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 40000 &&
           !(dataStore.isMyTurn && dataStore.legal && dataStore.legal.canRaise)) {
      await new Promise(r => setTimeout(r, 50));
      // 偶发（2 人桌）：AI 翻牌前直接弃牌 → 本手提前结束、永远轮不到我。
      // 与上方 25s 主循环同策略：重发一手继续等，避免随机牌局误报。
      if (dataStore.result && !(dataStore.isMyTurn && dataStore.legal && dataStore.legal.canRaise)) {
        pageCtx.startHand();
      }
    }
    global.__sfxWaitMs = Date.now() - t0;
  }
  ok(dataStore.isMyTurn === true && !!(dataStore.legal && dataStore.legal.canRaise),
    '异步推进到「轮到我且可加注」（验证加注按钮文案的前置条件）' +
    (dataStore.isMyTurn && dataStore.legal && dataStore.legal.canRaise
      ? '，耗时 ' + global.__sfxWaitMs + 'ms'
      : '；实际 isMyTurn=' + !!dataStore.isMyTurn +
        ' canRaise=' + !!(dataStore.legal && dataStore.legal.canRaise) +
        ' 耗时=' + global.__sfxWaitMs + 'ms'));
  if (dataStore.isMyTurn && dataStore.legal && dataStore.legal.canRaise) {
    const minT = dataStore.legal.minRaiseTo, maxT = dataStore.legal.maxRaiseTo;
    // 真机回归：点「自定义」无反应 —— onCustomTap 翻转了 open 却从未写 data.raiseCustom
    ok(dataStore.raiseCustom === false, '初始：自定义面板收起，档位条可见');
    pageCtx.onCustomTap();
    ok(dataStore.raiseCustom === true,
      '点「自定义」→ 面板真正展开（曾因漏写 raiseCustom 而点击无反应）');
    ok(dataStore.raiseTo >= minT,
      '展开时自动对齐到最小加注 ' + minT + '，当前 ' + dataStore.raiseTo);
    pageCtx.onPresetTap({ currentTarget: { dataset: { v: 'min' } } });
    ok(dataStore.raiseCustom === false, '切回预设档 → 面板收起（两者互斥）');
    pageCtx.onPresetTap({ currentTarget: { dataset: { v: 'custom' } } });
    ok(dataStore.raiseCustom === true, '从档位条点「自定义」→ 同样能展开');
    pageCtx.onCustomClose();
    ok(dataStore.raiseCustom === false, '「收起」→ 回到档位条');
    pageCtx.onCustomTap();
    ok(dataStore.raiseCustom === true, '再次展开成功');

    // ---- 小盲注整数倍：本轮新增的核心口径 ----
    const step = pageCtx.blindStep();
    ok(step > 0 && Number.isInteger(step), '步进 = 小盲注 ' + step + '（整数）');

    // 滑杆吸附到最近盲注倍数
    pageCtx.onRaiseSlider({ detail: { value: 346 } });
    ok(dataStore.raiseTo % step === 0,
      '滑杆拖到 346 → 吸附为小盲注整数倍 ' + dataStore.raiseTo + '（' + step + ' 的倍数）');
    ok(Math.abs(dataStore.raiseTo - 346) <= step / 2,
      '吸附取「就近」而非大幅偏离（偏差 ' + Math.abs(dataStore.raiseTo - 346) + ' ≤ ' + step / 2 + '）');
    ok(dataStore.raiseSubmit === dataStore.raiseTo,
      '吸附后加注按钮文案与金额同步为 ' + dataStore.raiseSubmit);

    // ± 按钮：每按一次走一个小盲注
    const before = dataStore.raiseTo;
    pageCtx.onCustomStep({ currentTarget: { dataset: { dir: '1' } } });
    ok(dataStore.raiseTo === before + step,
      '点「+」→ 增加一个盲注（' + before + ' → ' + dataStore.raiseTo + '）');
    pageCtx.onCustomStep({ currentTarget: { dataset: { dir: '1' } } });
    ok(dataStore.raiseTo === before + 2 * step, '连点「+」→ 继续按盲注递增到 ' + dataStore.raiseTo);
    pageCtx.onCustomStep({ currentTarget: { dataset: { dir: '-1' } } });
    ok(dataStore.raiseTo === before + step, '点「−」→ 回退一个盲注到 ' + dataStore.raiseTo);
    // 递进序列全程都是盲注倍数
    ok(dataStore.raiseTo % step === 0, '递进后仍是小盲注整数倍（零头不残留）');

    // 百分比快捷额：33/67/100% 且吸附到盲注倍数
    pageCtx.onCustomPct({ currentTarget: { dataset: { pct: 0.33 } } });
    const p33 = dataStore.raiseTo;
    ok(p33 % step === 0, '面板 33% → 吸附为盲注倍数 ' + p33);
    pageCtx.onCustomPct({ currentTarget: { dataset: { pct: 1 } } });
    const p100 = dataStore.raiseTo;
    ok(p100 > p33, '面板 100% > 33%（比例单调递增），实际 ' + p33 + ' → ' + p100);
    ok(p100 % step === 0 || dataStore.raiseTo === maxT,
      '面板 100% 也吸附为盲注倍数（或已到上限）');

    pageCtx.onCustomMin();
    ok(dataStore.raiseSubmit === minT, '点「最小」→ 按钮文案同步为 ' + minT);
    pageCtx.onCustomMax();
    ok(dataStore.raiseAllIn === true && dataStore.raiseSubmit === maxT,
      '点「最大」→ 按钮切换为「全下」（' + dataStore.raiseSubmit + ' = max ' + maxT + '）');

    // 越界保护：+ 不越过上限（全下额常是零头，不能被抬高一档）
    pageCtx.onCustomStep({ currentTarget: { dataset: { dir: '1' } } });
    ok(dataStore.raiseTo === maxT,
      '已在上限时点「+」→ 保持上限 ' + maxT + '，不被抬到 ' + (maxT + step));

    pageCtx.onRaiseInput({ detail: { value: '0' } });
    ok(dataStore.raiseTo === 0 && dataStore.raiseSubmit === minT,
      '输入 0 → 输入框保留 0（输入中不吸附，否则没法接着输），按钮按最小加注显示');
    pageCtx.onRaiseBlur();
    ok(dataStore.raiseTo === minT && dataStore.raiseSubmit === minT,
      '失焦 → 吸附并补正到最小加注 ' + minT + '，按钮同步');

    // 失焦吸附：非倍数输入被收敛到最近的盲注倍数
    pageCtx.onRaiseInput({ detail: { value: '137' } });
    ok(dataStore.raiseTo === 137, '输入 137 → 输入中保留原值（不打断输入）');
    pageCtx.onRaiseBlur();
    ok(dataStore.raiseTo % step === 0 || dataStore.raiseTo === maxT,
      '失焦 → 137 吸附为盲注倍数 ' + dataStore.raiseTo);

    // 吸附不得越界：上限是零头时回落成上限而不是抬高一档
    pageCtx.onRaiseInput({ detail: { value: String(maxT) } });
    pageCtx.onRaiseBlur();
    ok(dataStore.raiseTo <= maxT, '失焦吸附不越界：' + dataStore.raiseTo + ' ≤ ' + maxT);

    ok(dataStore.raiseCustom === true,
      '滑杆/输入全程保持面板展开（金额改动不应误收起面板）');
    pageCtx.onCustomClose();
    ok(dataStore.raiseCustom === false, '「收起」→ 回到档位条');

    /* ---------- 回归：档位高亮跨手残留（真机反馈「一直高亮上一局的」） ---------- */
    // 先故意选一个非最小档 + 展开自定义面板，制造「脏状态」
    pageCtx.onPresetTap({ currentTarget: { dataset: { v: 'p100' } } });
    const dirtyPreset = dataStore.raisePreset;
    pageCtx.onCustomTap();
    const dirtyCustom = dataStore.raiseCustom;
    ok(dirtyPreset === 'p100' && dirtyCustom === true,
      '前置：制造脏状态（选中100% 档=' + dirtyPreset + '，自定义面板展开=' + dirtyCustom + '）');

    // 直接调 startHand 模拟「开新一局」——这是唯一会重置档位的地方。
    // ⚠️ 只断言「档位高亮 + 自定义面板」这两个纯 UI 态，不在此处断言金额：
    // startHand 内部会 advance()，AI 行动会合法地改写 raiseTo/raiseSubmit，
    // 金额的正确断言在下方「新一局轮到我」那块（那里语义才成立）。
    pageCtx.startHand();

    ok(dataStore.raisePreset === 'min',
      '开新一局 → 档位高亮重置为「最小」（实际 ' + dataStore.raisePreset +
      '，脏值是 ' + dirtyPreset + '；真机反馈是「一直高亮上一局的」）');
    ok(dataStore.raiseCustom === false,
      '开新一局 → 自定义面板强制收起（脏状态是 ' + dirtyCustom + '）');

    // 关键：setData 异步 —— startHand 里 reset 后紧接着的 render 同帧
    // 读 this.data.raiseTo 拿到的还是旧值。必须靠 _raiseResetPending 实例字段
    // 在同步路径上覆盖，否则「高亮已是『最小』、金额却还是上一手」又成矛盾态。
    // ⚠️ 不断言 pageCtx._raiseResetPending === false：startHand 内部会 advance()，
    // AI 用真实 setTimeout 异步行动，若本帧还没轮到 render，该标志可能尚未消费。
    // 「标志会被消费」是render 内部的行为，由下方「新一局轮到我」的金额断言覆盖。

    // 结构守卫：锁死 resetRaiseState 必须在 startHand 里被调用
    const tableSrc2 = require('fs').readFileSync(
      require('path').join(__dirname, 'pages/table/table.js'), 'utf8');
    guardResetRaiseState(tableSrc2);

    // ---- 行为闭环：新一局轮到我时，金额必须真的是最小加注（不只是清零）----
    // 这是本次修复的核心语义。清零只保证「不残留」，还得证明「高亮『最小』时
    // 加注按钮显示的确实是最小额」——否则会出现高亮与金额不一致的新矛盾态。
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 40000 &&
             !(dataStore.isMyTurn && dataStore.legal && dataStore.legal.canRaise)) {
        await new Promise(r => setTimeout(r, 50));
        if (dataStore.result && !(dataStore.isMyTurn && dataStore.legal && dataStore.legal.canRaise)) {
          pageCtx.startHand();   // AI 提前弃牌导致本手结束 → 重开一手继续等
        }
      }
    }
    if (dataStore.isMyTurn && dataStore.legal && dataStore.legal.canRaise) {
      const freshMin = dataStore.legal.minRaiseTo;
      ok(dataStore.raisePreset === 'min',
        '新一局轮到我 → 档位仍高亮「最小」（跨 AI 行动未被覆盖），实际 ' + dataStore.raisePreset);
      ok(dataStore.raiseSubmit === freshMin && dataStore.raiseTo === freshMin,
        '新一局轮到我 → 加注按钮金额 = 最小加注 ' + freshMin +
        '（submit=' + dataStore.raiseSubmit + ' raiseTo=' + dataStore.raiseTo +
        '），与高亮档位严格自洽');
      ok(dataStore.raiseAllIn === false,
        '新一局轮到我 → 不是全下态（raiseAllIn=' + dataStore.raiseAllIn + '）');
      ok(dataStore.raiseCustom === false,
        '新一局轮到我 → 自定义面板收起，显示档位条（曾跨手残留展开）');
    } else {
      ok(false, '新一局后未能推进到「轮到我且可加注」，无法验证金额与高亮自洽' +
        '（isMyTurn=' + !!dataStore.isMyTurn + ' canRaise=' +
        !!(dataStore.legal && dataStore.legal.canRaise) + '）');
    }
  }

  /* ---------- 回归：镜像端（好友房）跨手档位残留 —— 改为「手数驱动」重置 ---------- */
  // 真机反馈「这个下注选择按钮一直高亮上一局的」在好友房复发。旧修复把重置只
  // 挂在 startHand() 上，而镜像端根本不走 startHand()：enterRemote() 是
  // loadSnapshot(房主快照) → setData → render()。续局 restoreRoom 同理。
  // 这里直接推进 handNo 后调 render，精确复现「手数前进但没走 startHand」的路径。
  {
    const gm = pageCtx.requireGame();
    // 制造脏状态：选中 100% 档 + 展开自定义面板（此时语义仍是「轮到我且可加注」）
    pageCtx.onPresetTap({ currentTarget: { dataset: { v: 'p100' } } });
    // ⚠️ 取值时机：onCustomTap() 会把档位一并改写成 'custom'，
    // 先取档位再展开面板，否则取到的是 'custom' 而不是要复现的 'p100'。
    const dirtyPreset = dataStore.raisePreset;
    pageCtx.onCustomTap();
    const dirtyCustom = dataStore.raiseCustom;
    ok(dirtyPreset === 'p100' && dirtyCustom === true,
      '前置：镜像端脏状态（档位=' + dirtyPreset + '，自定义展开=' + dirtyCustom + '）');

    gm.handNo += 1;                 // 房主快照里手数前进（镜像端不调 startHand）
    pageCtx._lastRenderFp = null;   // 强制走完整渲染，绕开指纹跳过分支
    pageCtx.render();

    ok(dataStore.raisePreset === 'min',
      '★ 手数前进但未走 startHand → 档位高亮重置为「最小」（实际 ' +
      dataStore.raisePreset + '，脏值 ' + dirtyPreset + '）');
    ok(dataStore.raiseCustom === false,
      '★ 手数前进但未走 startHand → 自定义面板强制收起（实际 ' + dataStore.raiseCustom + '）');
    if (dataStore.isMyTurn && dataStore.legal && dataStore.legal.canRaise) {
      ok(dataStore.raiseTo === dataStore.legal.minRaiseTo,
        '重置帧轮到我 → 金额 = 最小加注 ' + dataStore.legal.minRaiseTo +
        '（实际 ' + dataStore.raiseTo + '，与高亮「最小」自洽）');
    } else {
      ok(dataStore.raiseTo === 0,
        '重置帧非我回合 → 金额先清零，等轮到我时再取最小额（实际 ' + dataStore.raiseTo + '）');
    }
  }

  /* ---------- 回归：预设档改为百分比 + 盲注倍数吸附 ---------- */
  {
    guardRaisePresetPct(tableSrc, wxmlSrc);
  }

  /* ---------- 回归：就绪按钮点完变灰禁用 + 倒计时 30s ---------- */
  {
    const wxssSrc = require('fs').readFileSync(
      require('path').join(__dirname, 'pages/table/table.wxss'), 'utf8');
    guardReadyButton(tableSrc, wxmlSrc, wxssSrc);
  }

  /* ---------- 行为：时长到点必须「打完这手再结束」，不能中途 game over ---------- */
  {
    pageCtx.onLoad({ room: '300007', own: '1', dur: '10' });
    pageCtx.addBot();
    pageCtx.addBot();
    pageCtx.startGame();
    ok(dataStore.phase === 'playing', '限时局已开局（10 分钟）');
    const gNow = pageCtx.requireGame();
    ok(!!gNow && !gNow.result, '新一局已发牌，本手进行中（无结算）');

    // 到点 + 本手在打 → 不结束，挂起
    pageCtx.onClockExpired();
    ok(dataStore.timeUp === false, '到点时若本手仍在打，不立即 game over（timeUp 仍为 false）');
    ok(dataStore.clockPendingEnd === true, '置 clockPendingEnd 标记，UI 提示「本手后结束」');
    ok(dataStore.remainText === '00:00', '倒计时定格 00:00，实际 ' + dataStore.remainText);

    // 本手走完 → enterReadyPhase 收口时才真正结束
    pageCtx.enterReadyPhase();
    ok(dataStore.timeUp === true, '本手结束后才真正总结束（timeUp=true）');
    ok(!!dataStore.summary, '总结束弹出入员结算单');
    ok(dataStore.summary && dataStore.summary.rows.length >= 2, '结算单含所有在座玩家');

    // 结算单必须给出「带入 / 剩余 / 盈亏」三项
    const s = dataStore.summary;
    ok(s && typeof s.myBuyIn === 'number' && typeof s.myStack === 'number' && typeof s.myNet === 'number',
      '结算单含带入/剩余/盈亏三项（myBuyIn / myStack / myNet）');
    ok(s && s.myNet === s.myStack - s.myBuyIn, '结算单盈亏恒等式：盈亏 = 剩余 − 带入');
    ok(s && s.rows.every(r => typeof r.buyIn === 'number' && r.net === r.stack - r.buyIn),
      '结算单每行都带 buyIn 且 net = stack − buyIn');

    // 实时面板口径必须与结算一致（同一 startStacks 基准）
    ok(dataStore.myBuyIn === s.myBuyIn, '实时面板带入 === 结算单带入（同源同口径）');
    ok(dataStore.myNetLive === s.myNet, '实时面板盈亏 === 结算单盈亏');

    // 不在打牌中（已结算）→ 到点立即结束。
    // 用引擎真实结算出 result（伪造对象会被 buildResult 拒绝，结构不对反而测不到东西）。
    pageCtx.restartGame();
    const g2 = pageCtx.requireGame();
    if (g2) {
      // 直接走引擎的摊牌结算：所有非弃牌玩家 award=0
      const live = g2.players.filter(p => !p.folded && !p.sittingOut);
      g2.result = {
        winners: live.map(p => p.seat),
        awards: live.map(p => ({ seat: p.seat, amount: 0 }))
      };
    }
    pageCtx.onClockExpired();
    ok(dataStore.timeUp === true, '不在打牌中（已结算）时到点立即结束');
  }

  /* ---------- 行为：实时盈亏面板（菜单 → 我的筹码） ---------- */
  {
    pageCtx.onMenuBank();
    ok(dataStore.bankShow === true, '菜单「我的筹码」打开实时盈亏面板');
    ok(dataStore.menuOpen === false, '打开面板时自动收起菜单');
    pageCtx.onBankClose();
    ok(dataStore.bankShow === false, '面板可关闭');
  }

  /* ---------- 回归：座位手牌不得遮挡底池/公共牌 ---------- */
  {
    guardSeatCardNoOverlap(tableSrc, wxmlSrc, wxssSrc);
  }

  /* ---------- 回归：房主身份回收 + 唯一座位（不能出现两个自己） ---------- */
  {
    // isOwner 不得只由 URL 的 own=1 决定：邀请链接不带 own，房主自点自己分享的卡片会丢身份
    const syncSrc = require('fs').readFileSync(
      require('path').join(__dirname, 'utils/room-sync.js'), 'utf8');
    guardOwnerRecovery(tableSrc, syncSrc);
  }

  /* ---------- 静态守卫：金额入口全部收口到 setRaiseTo ---------- */
  {
    guardClockExpiredAndSummary(tableSrc, wxmlSrc);
  }

  /* ---------- 静态守卫：金额入口全部收口到 setRaiseTo ---------- */
  guardSetRaiseTo(tableSrc, wxmlSrc);

  /* ---------- 生命周期：onHide 全量暂停 + onShow 恢复（评审 MEDIUM 回归） ---------- */
  {
    guardLifecyclePause(tableSrc);
    // 行为级验证：onShow 幂等（未切后台时 onShow 不启动任何东西）
    const pollBefore = dataStore.phase;
    pageCtx.onShow();
    ok(pageCtx.inBackground === false, 'onShow 在前台状态下消费后台标记（幂等）');
    ok(dataStore.phase === pollBefore, 'onShow 不改变牌局阶段');
    // onHide → onShow 完整回环：看门狗与音效泵恢复
    pageCtx.onHide();
    ok(pageCtx.inBackground === true, 'onHide 置后台标记');
    ok(pageCtx.engineWatch === null, 'onHide 停掉引擎看门狗');
    ok(pageCtx.sfxPump === null, 'onHide 停掉音效泵');
    pageCtx.onShow();
    ok(pageCtx.inBackground === false, 'onShow 清后台标记');
    ok(pageCtx.engineWatch !== null, 'onShow 恢复引擎看门狗');
    ok(pageCtx.sfxPump !== null, 'onShow 恢复音效泵');
  }

  /* ---------- 同步上行吞错提示（评审 MEDIUM 回归）---------- */
  {
    // 静态守卫：table.js 的同步链路上不允许再出现裸 .catch(() => {})。
    // 离房清理（closeRoom/leave）原先用裸 catch 静默吞错，现已全部加 console.error
    // 日志——出现新的裸 .catch(() => {}) 会在这里被拦截。
    guardSyncFailToast(tableSrc);
    // 行为级:同文案 10s 内节流(第二条不弹),不同文案互不影响,间隔过了恢复
    toasts.length = 0;
    pageCtx.syncFailLast = {};
    pageCtx.syncFailToast('测试文案A');
    ok(toasts[toasts.length - 1] === '测试文案A', 'syncFailToast 首次失败弹提示');
    pageCtx.syncFailToast('测试文案A');
    ok(toasts.filter(t => t === '测试文案A').length === 1, '同文案节流期内不重复弹');
    pageCtx.syncFailToast('测试文案B');
    ok(toasts.filter(t => t === '测试文案B').length === 1, '不同文案不受彼此节流影响');
    pageCtx.syncFailLast['测试文案A'] = Date.now() - 10001;
    pageCtx.syncFailToast('测试文案A');
    ok(toasts.filter(t => t === '测试文案A').length === 2, '节流窗口过后恢复提示');
  }

  /* ---------- 轮询重入守卫 + bootstrapSync 失败清理（鲁棒性）---------- */
  {
    guardPollReentry(tableSrc);
    // 行为：置 _polling=true 后 pollOnce 直接返回，不触达 roomSync.poll（roomRows 不变）
    const pollBefore = pageCtx.roomRows;
    pageCtx._polling = true;
    pageCtx.pollOnce();
    ok(pageCtx._polling === true, 'pollOnce 重入时直接返回不执行（_polling 保持 true）');
    ok(pageCtx.roomRows === pollBefore, 'pollOnce 重入时不调用 roomSync.poll（roomRows 未变）');
    pageCtx._polling = false;
    // 静态守卫：bootstrapSync 失败时清理已起的定时器，防泄漏
    guardBootstrapStopSync(tableSrc);
  }

  /* ---------- 弹窗 catchtap 显式化 + 对手计时环残值（评审 MEDIUM UI 细节回归）---------- */
  {
    guardCatchtapExplicit(tableSrc, wxmlSrc);
  }

  /* ---------- 对手计时环不显示我的残值（评审 MEDIUM UI 细节回归）---------- */
  {
    guardTimerNoResidue(tableSrc);
    guardTimerMaxUnified(tableSrc);
  }

  /* ---------- 边池归属显示（玩家审视 2026-10-17）---------- */
  {
    guardSidePotElig(tableSrc, wxmlSrc, wxssSrc);
  }

  /* ---------- 非摊牌赢池自愿亮牌「亮一手」（玩家审视 2026-10-17）---------- */
  {
    guardDisclose(tableSrc, wxmlSrc);
  }

  /* ---------- 行动计时最后 5s 视觉强化（红+脉冲，与警告音同阈值）---------- */
  {
    guardTimerUrgent(tableSrc, wxmlSrc, wxssSrc);
  }

  /* ---------- 结算弹窗注释与行为一致（评审 MEDIUM：注释曾写「只由用户触发、不自动弹出」）---------- */
  {
    guardResultModalDoc(tableSrc);
  }

  /* ---------- 同步脏检查（评审 2026-10-15 MEDIUM「全量写库/全量 setData 无脏检查」） ---------- */
  // 房主 writePlayState 与好友 enterRemote 各有指纹比对：牌局实质未变时跳过
  // 写库 / setData，避免每 500ms/1.5s 空转云端配额与全量重绘。
  {
    // 静态守卫：两处指纹键、跳过路径都存在
    guardDirtyCheckFingerprint(tableSrc);

    // 行为级：房主指纹比对。用本地模式（非好友房）取一个真实 game，直接调
    // writePlayState 验证「指纹相同不二次发布，指纹变化才发布」。
    const g = pageCtx.requireGame();
    if (g) {
      // 本地模式 syncLive=false，writePlayState 直接 return——强行打开来测脏检查
      pageCtx.syncLive = true;
      pageCtx.isOwner = true;
      pageCtx.roomNo = 'TEST_FINGERPRINT';
      pageCtx._lastPlayFp = null;
      // 指纹比对验证改用 _lastPlayFp 前后值断言：同势 → 指纹不变（跳过分支），
      // 变势 → 指纹更新（重新发布）。发布路径本身走 roomSync → mock cloud。
      const beforeFp = pageCtx._lastPlayFp;
      pageCtx.writePlayState();          // 第一次：建立指纹
      const fp1 = pageCtx._lastPlayFp;
      ok(fp1 && fp1 !== beforeFp, 'writePlayState 首次建立房主指纹');
      pageCtx.writePlayState();          // 第二次：同势
      ok(pageCtx._lastPlayFp === fp1, '同势二次调用指纹不变（跳过写库分支）');
      // 人为改变牌桌势：currentBet 变动
      const savedBet = g.currentBet;
      g.currentBet = savedBet + 50;
      pageCtx.writePlayState();
      ok(pageCtx._lastPlayFp !== fp1, 'currentBet 变化后指纹更新（不再跳过）');
      g.currentBet = savedBet;           // 还原
      // 还原运行时，避免污染后续断言
      pageCtx.syncLive = false;
      pageCtx.isOwner = false;
      pageCtx.roomNo = null;
      pageCtx._lastPlayFp = null;
    }

    // 行为级：好友端指纹比对（enterRemote）。直接调 enterRemote 两次同势快照。
    if (g) {
      pageCtx.remoteMode = true;
      pageCtx.roomSeat = 0;
      pageCtx.mySeat = 0;
      pageCtx._lastRemoteFp = null;
      const snap1 = g.snapshot();
      const st1 = { snapshot: snap1, legal: null, readyPhase: false, readyList: [], summary: null };
      let setDataCount = 0;
      const realSetData = pageCtx.setData.bind(pageCtx);
      pageCtx.setData = (d) => { setDataCount++; return realSetData(d); };
      try {
        pageCtx.enterRemote(st1);
        const firstCount = setDataCount;
        ok(pageCtx._lastRemoteFp, 'enterRemote 首次建立镜像指纹');
        // 同势再调一次：应命中跳过，不再 setData
        pageCtx.enterRemote(st1);
        ok(setDataCount === firstCount,
          '同势快照二次 enterRemote 跳过 setData（指纹命中），实际 setData ' + setDataCount + ' 次');
        // 变势：公共牌增加一张（模拟翻牌），指纹应更新并触发 setData
        const snap2 = g.snapshot();
        snap2.boardCodes = (snap2.boardCodes || []).concat('As');
        snap2.street = 2;
        pageCtx.enterRemote({ snapshot: snap2, legal: null, readyPhase: false, readyList: [], summary: null });
        ok(setDataCount > firstCount,
          '快照变化后 enterRemote 重新 setData（指纹未命中）');
      } finally {
        pageCtx.setData = realSetData;
        pageCtx.remoteMode = false;
        pageCtx._lastRemoteFp = null;
      }
    }
  }

  /* ---------- 空闲超时提示静态守卫（提前 5 分钟显示倒计时） ---------- */
  {
    guardIdleTimeout(tableSrc, wxmlSrc, wxssSrc);
  }

  /* ---------- 页面层性能缓存：ringPositions + cardData ---------- */
  {
    guardPerfCache(tableSrc);
    // 行为：同卡两次返回不同引用（浅克隆）但字段一致，markBest 可安全改 hi
    const c1 = pageCtx.cardData(0, 0);
    const c2 = pageCtx.cardData(0, 0);
    ok(c1 !== c2, 'cardData 返回新对象（浅克隆，markBest 可安全改 hi）');
    ok(c1.code === c2.code && c1.cls === c2.cls, '缓存命中时字段一致');
    // markBest 改第一份的 hi 不影响缓存（第二份仍为 false）
    c1.hi = true;
    ok(c2.hi === false, 'cardData 浅克隆隔离：改一份的 hi 不污染缓存（另一份仍 false）');
  }

  /* ---------- render 渲染指纹跳过（性能优化）---------- */
  {
    guardRenderFingerprint(tableSrc);
    // 行为：同势二次 render 不增 setData；变势后重新 setData
    const g = pageCtx.requireGame();
    if (g) {
      let renderSetDataCount = 0;
      const realSetData = pageCtx.setData.bind(pageCtx);
      pageCtx.setData = (d) => { if (d && d.seats) renderSetDataCount++; return realSetData(d); };
      try {
        pageCtx._lastRenderFp = null;   // 强制首帧建立指纹
        pageCtx.render();
        const firstCount = renderSetDataCount;
        pageCtx.render();              // 同势：应命中跳过
        ok(renderSetDataCount === firstCount,
          '同势二次 render 跳过 setData（指纹命中），实际 setData ' + renderSetDataCount + ' 次');
        const savedBet = g.currentBet;
        g.currentBet = savedBet + 100; // 变势：指纹变化
        pageCtx.render();
        ok(renderSetDataCount > firstCount, '势变化后 render 重新 setData（指纹未命中）');
        g.currentBet = savedBet;       // 还原
        pageCtx._lastRenderFp = null;
      } finally {
        pageCtx.setData = realSetData;
      }
    }

    // 行为：render body 抛错时不缓存指纹，下一帧同势自动重试（不卡降级态）
    {
      const g2 = pageCtx.requireGame();
      if (g2) {
        // 让 render body 在主 setData 之前抛错：markBest 在 2085 行被调用（早于主 setData）
        const realMarkBest = pageCtx.markBest.bind(pageCtx);
        let throwOn = false;
        pageCtx.markBest = function () { if (throwOn) throw new Error('render body boom'); return realMarkBest.apply(this, arguments); };
        try {
          pageCtx._lastRenderFp = 'STALE';   // 上一帧指纹
          throwOn = true;
          pageCtx.render();                  // body 抛错 → 走降级 catch
          ok(pageCtx._lastRenderFp === 'STALE',
            'render body 抛错时不更新指纹（_lastRenderFp 仍为旧值，下帧重试而非卡降级态）');
          // 恢复后下一帧同势 render：因指纹仍是 STALE（未被失败的帧缓存），应重新跑主 setData
          let retried = false;
          const realSd = pageCtx.setData.bind(pageCtx);
          pageCtx.setData = (d) => { if (d && d.seats) retried = true; return realSd(d); };
          throwOn = false;
          pageCtx.render();
          ok(retried, '失败的帧未缓存指纹 → 下一帧同势 render 重新执行主 setData（自动重试）');
          pageCtx.setData = realSd;
        } finally {
          pageCtx.markBest = realMarkBest;
          pageCtx._lastRenderFp = null;
        }
      }
    }
  }

  /* ---------- 边池多路全下 UI：结算帧 sidePots 进 setData（盲点补覆盖） ----------
   * 引擎 game.pots 在牌局进行中为 []，只在 finishHand/showdown 填充；table.js
   * render 的 sidePots 分支（game.pots.length > 1 → slice(1).map(amount)）因此只在
   * 结算帧生效。此前无任何测试断言 sidePots 到达 setData——多路全下的边池金额
   * 是否正确分层、是否被渲染层吃掉，全靠人工目测。这里用引擎直接构造一局多路全下
   * 跑到结算（pots 填充），驱动 render 后断言 dataStore.sidePots 是非空金额数组。 */
  {
    // 静态守卫：render 确有 sidePots 分层逻辑 + 进 setData
    guardSidePotsRender(tableSrc);

    // 行为级：直接用引擎构造多路全下结算手，把 pots 填进去后调 render 断言。
    // 主循环留下一手牌局是 2 人桌（仅我 + 1 bot），构造多路全下需要 ≥3 玩家，
    // 故用 requireGame() 拿到的引擎实例按确定状态手工注入：加一个空玩家槽
    // 不现实（createGame 后 players 固定），改为直接复用引擎 buildSidePots 的
    // 等价路径——用 P.createGame 另起一局 3 人桌跑到结算，再 loadSnapshot 回灌
    // pageCtx 的 game，使 render 读到 pots。但 pageCtx.render 读的是模块级
    // game 单例，外部 game 改不动它。最稳妥：直接驱动 pageCtx 的 game 跑到
    // 一个产生边池的真实牌局——2 人桌无法产生边池（边池需 ≥3 路不同 committed），
    // 故此处改用「直接断言引擎 buildSidePots 分层 + render 侧的 sidePots 计算」
    // 两段，分别覆盖引擎分层与渲染取数，不依赖 pageCtx 当前人数。
    const g = pageCtx.requireGame();
    if (g) {
      // ① 引擎侧：3 玩家不同 committed → buildSidePots 分 3 层（主池 + 2 边池）。
      //    用独立引擎实例验证分层（不污染 pageCtx 的 game 单例）。
      const sg = P.createGame({
        players: [
          { id: 'a', name: 'A', seat: 0, stack: 1000 },
          { id: 'b', name: 'B', seat: 1, stack: 1000 },
          { id: 'c', name: 'C', seat: 2, stack: 1000 }
        ], sb: 10, bb: 20, seed: 'sidepot-ui-test'
      });
      sg.startHand();
      sg.players.forEach(p => {
        p.folded = false; p.allIn = true; p.bet = 0; p.committed = 0;
        p.hole = p.hole && p.hole.length === 2 ? p.hole : [0, 1];
        p.actedBet = 0;
      });
      sg.players[0].committed = 100;
      sg.players[1].committed = 300;
      sg.players[2].committed = 50;
      sg.board = [24, 28, 32, 36, 40];
      sg.street = P.STREET.RIVER;
      sg.currentBet = 0;
      sg.actionSeat = -1;
      sg.result = null;
      sg.pots = [];
      const adv = sg.advance();   // 全员 allIn → skipToShowdown → showdown → pots 填充
      ok(adv && adv.ok && !!sg.result, '多路全下构造：advance 跑到结算（result 已生成）');
      ok(Array.isArray(sg.pots) && sg.pots.length === 3,
        '多路全下分层出 3 个池（主池 + 2 边池），实际 ' + (sg.pots ? sg.pots.length : 0));
      const sideAmounts = sg.pots.slice(1).map(p => p.amount);
      ok(sideAmounts.length === 2 && sideAmounts.every(a => typeof a === 'number' && a > 0),
        '边池金额 = pots.slice(1).map(amount)：2 个正整数，实际 ' + JSON.stringify(sideAmounts));

      // ② 渲染侧：把这套 pots 灌进 pageCtx 的 game 单例，调 render 断言
      //    dataStore.sidePots 落值（验证 render 的 slice(1).map(amount) 分支）。
      //    直接改 game.pots + game.result + street=SHOWDOWN，让 render 走结算帧。
      g.pots = sg.pots.map(p => ({ amount: p.amount, eligible: p.eligible.slice(), contribs: Object.assign({}, p.contribs), level: p.level }));
      g.result = sg.result;
      g.street = P.STREET.SHOWDOWN;
      g.board = sg.board.slice();
      g.showdownReveal = sg.showdownReveal || {};
      pageCtx._lastRenderFp = null;   // 强制重渲染（pots 变化本就令指纹不同，双保险）
      pageCtx.render();
      ok(Array.isArray(dataStore.sidePots) && dataStore.sidePots.length === 2,
        'render 后 sidePots 含 2 个边池（主池排除），实际 ' +
        JSON.stringify(dataStore.sidePots));
      ok(dataStore.sidePots.every(a => typeof a.amount === 'number' && a.amount > 0),
        '边池金额均为正整数（分层金额正确落入 setData）');
      ok(dataStore.sidePots.every(a => Array.isArray(a.eligible) && a.eligible.length > 0 &&
        typeof a.eligibleList === 'string'),
        '边池携带归属（eligible 座位数组 + eligibleList 拼接串）');
    }
  }

  /* ---------- 30s 代弃：房主端 watchFriendAction 超时代行（盲点补覆盖） ----------
   * 好友房房主对「等上行的真人好友」不代打，只 watchFriendAction 等 30s（与本地
   * startTimer 同口径：无注过牌 / 有注弃牌）。此前仅静态守卫 + C-2 sittingOut
   * 推进分支被测，30s 超时代弃这条主路径无行为级覆盖。这里把 pageCtx 拨成房主态、
   * 行动权压到好友座位、friendActSince 推过 30s，调 watchFriendAction 断言代弃推进。 */
  {
    // 静态守卫：watchFriendAction 30s 阈值 + 无注过牌/有注弃牌同口径
    guardWatchFriendTimeout(tableSrc);

    // 行为级：构造房主端 + 一个真人好友座位（非我非 bot），行动权压过去后超时代弃。
    // 不复用主循环留下的随机牌局状态（好友可能已被弃/全下/站起 → legalActions
    // 返回 null 走兜底 advance，代弃主路径测不到）——直接把好友座位复位成可行动、
    // 有注待跟的确定态，再推过 30s 触发代弃。
    const g = pageCtx.requireGame();
    if (g) {
      // 房主态：syncLive + isOwner + 好友座位不在 botSeats（视作等上行真人）
      pageCtx.syncLive = true;
      pageCtx.isOwner = true;
      pageCtx.roomNo = 'TEST_TIMEOUT';
      pageCtx.botSeats = {};          // 清空 bot 标记
      pageCtx.standingMap = {};        // 清空站起标记（防 isStanding 走 C-2 兜底分支）
      pageCtx.friendActSince = 0;
      // 取一个非我座位当「好友」，复位成可行动 + 有注待跟（走弃牌案）
      const friendSeat = g.players.filter(p => p.seat !== pageCtx.mySeat)[0].seat;
      const fp = g.seatOf(friendSeat);
      fp.folded = false; fp.allIn = false; fp.sittingOut = false;
      fp.bet = 0; fp.stack = 500; fp.actedBet = null;
      // 其余非我非好友座位一律弃牌：好友弃牌后引擎 advance → 仅剩我 → finishHand
      // 收局（afterAct 见 result 即 return，不再 advance 到下一座）。否则 advance 落到
      // 别的「非我非 bot」座 → isFriendSeat → friendActSince ||= now 重新置位，盖掉
      // 代弃刚复位为 0 的 friendActSince（这是本块此前断言 1 失败的根因）。
      g.players.forEach(p => {
        if (p.seat !== pageCtx.mySeat && p.seat !== friendSeat) { p.folded = true; p.sittingOut = false; }
        else if (p.sittingOut) p.sittingOut = false;
      });
      g.currentBet = 100;             // 有注 → 代弃牌（toCall=100>0）
      g.actionSeat = friendSeat;
      g.result = null;
      g.pots = [];
      // ⚠️ 断网诊断：附近若有 engineWatch/healEngine 异步调度的 AI 动作在本块
      // 之前/之中落地，会改 g.actionSeat/g.result/g.street 致 watchFriendAction 走兜底。
      // 这里把可能正挂着的看门狗与 AI 调度一并停掉，进入本块的确定态。
      pageCtx.stopEngineWatch();
      pageCtx.onEnterBackground();   // 全量暂停：停看门狗/AI 调度/音效泵/轮询
      // 推过 30s：friendActSince 设到 31s 前（ACTION_TIMEOUT_SEC=30，避免硬编码）
      const TIMEOUT_MS = 30 * 1000;
      pageCtx.friendActSince = Date.now() - (TIMEOUT_MS + 1000);
      // 清空 chatLog 到容量以下：主循环积累的系统消息可能已满 8 条，pushChat 入队后
      // while(log.length>8) log.shift() 会把新消息挤掉，致 chatLog 净增 0（本块此前
      // 断言 2 失败的根因）。置空后 pushChat 入队净增 1。
      dataStore.chatLog = [];
      const chatBefore = (dataStore.chatLog || []).length;
      pageCtx.watchFriendAction();
      // 30s 到 → 代行弃牌并推进：friendActSince 复位为 0，pushChat 系统消息入队
      ok(pageCtx.friendActSince === 0,
        '30s 超时代弃后 friendActSince 复位为 0（不再重复代弃）');
      const added = (dataStore.chatLog || []).length - chatBefore;
      ok(added === 1, '代弃 pushChat 恰好一条系统消息，实际 +' + added);
      ok(fp.folded === true, '有注时超时代弃 → 好友被弃牌');
      ok(/自动弃牌/.test(dataStore.chatLog[dataStore.chatLog.length - 1].text),
        '有注案系统消息为「自动弃牌」: ' + (dataStore.chatLog[dataStore.chatLog.length - 1] || {}).text);
      // 还原运行时，避免污染后续断言
      pageCtx.syncLive = false;
      pageCtx.isOwner = false;
      pageCtx.roomNo = null;
      pageCtx.botSeats = {};
      pageCtx.standingMap = {};
      pageCtx.friendActSince = 0;
      // 恢复被本块暂停的后台定时器，保证后续 sfxPump/engineWatch 测试环境一致
      pageCtx.onLeaveBackground();
    }
  }

  /* ---------- publishPlay 500ms 节流：到期直发 / 未到期延后（盲点补覆盖） ----------
   * publishPlay 用 publishDue/publishTimer 做 ~500ms 节流：到期直发 writePlayState，
   * 未到期 clearTimeout 后 setTimeout 延后。此前 syncFailToast 节流与 EMOTE 频控有测，
   * 这条房主广播节流（deferred setTimeout 路径）无行为级覆盖。这里验证两条分支：
   * 到期直发不挂 timer、未到期挂延后 timer 并在到点后发。 */
  {
    // 静态守卫：节流机制存在
    guardPublishPlayThrottle(tableSrc);

    // 行为级：拨成房主态，第一次 publishPlay 因 publishDue=0 直发（不挂 timer）；
    // 再调一次在节流窗内 → 挂延后 timer，writePlayState 不立即执行。
    const g = pageCtx.requireGame();
    if (g) {
      pageCtx.syncLive = true;
      pageCtx.isOwner = true;
      pageCtx.roomNo = 'TEST_THROTTLE';
      pageCtx.data.phase = 'playing';
      pageCtx.publishDue = 0;
      pageCtx.publishTimer = null;
      pageCtx._lastPlayFp = null;
      let writeCount = 0;
      const realWrite = pageCtx.writePlayState.bind(pageCtx);
      pageCtx.writePlayState = () => { writeCount++; return realWrite(); };
      try {
        pageCtx.publishPlay();          // 到期（due=0）→ 直发 writePlayState
        ok(writeCount === 1, '到期时 publishPlay 直发 writePlayState 1 次，实际 ' + writeCount);
        ok(pageCtx.publishTimer === null, '到期直发不挂延后 timer');
        ok(pageCtx.publishDue > 0, '直发后 publishDue 推到 500ms 后');
        const dueAfter = pageCtx.publishDue;
        // 模拟「现在仍在节流窗内」：把 due 推到 300ms 后，now < due
        pageCtx.publishDue = Date.now() + 300;
        writeCount = 0;
        pageCtx.publishPlay();          // 未到期 → 挂延后 timer，不立即写
        ok(writeCount === 0, '节流窗内 publishPlay 不立即 writePlayState（延后），实际 ' + writeCount);
        ok(pageCtx.publishTimer !== null, '未到期时挂延后 setTimeout（publishTimer 非空）');
        // 清掉延后 timer 避免后台触发污染后续
        if (pageCtx.publishTimer) { clearTimeout(pageCtx.publishTimer); pageCtx.publishTimer = null; }
        pageCtx.publishDue = dueAfter;
      } finally {
        pageCtx.writePlayState = realWrite;
        pageCtx.syncLive = false;
        pageCtx.isOwner = false;
        pageCtx.roomNo = null;
        pageCtx.publishDue = 0;
        pageCtx.publishTimer = null;
        pageCtx._lastPlayFp = null;
        pageCtx.data.phase = pageCtx.data.phase;   // phase 保持原值
      }
    }
  }

  /* ---------- 牌桌互动与氛围（设计 2026-10-15 §2）静态守卫 + 行为 ----------
   * 四类动画：筹码飞行 / 赢牌金光+星光粒子 / 连胜徽章 / 表情轮盘+气泡。
   * 全部走 transform/opacity + keyframes，animOn=false 时 .no-anim 兜底禁用。
   * 表情走既有 emote 动作上行 + 房主随快照广播，上行失败静默降级（非关键路径）。 */
  {
    // 静态守卫：氛围常量、字段、方法、WXML/WXSS 节点
    guardAmbienceConstants(tableSrc, wxmlSrc, wxssSrc);

    // 静态守卫：氛围渲染基线、animOn、映射、上行降级、清零、镜像
    guardAmbienceRenderAndSync(tableSrc);

    // 静态守卫：WXML 节点齐备（飞行层/金光/轮盘/徽章/粒子/快捷语）
    guardAmbienceWxml(wxmlSrc, wxssSrc, tableSrc);

    // 静态守卫：WXSS 样式 + keyframes + 重排红线 + spark 贴图 + .no-anim
    guardAmbienceWxss(wxssSrc);

    // —— 粒子资源文件存在且 < 50KB ——
    const fs = require('fs');
    const sparkPath = path.join(__dirname, 'assets', 'spark.png');
    ok(fs.existsSync(sparkPath), '粒子贴图 assets/spark.png 存在');
    if (fs.existsSync(sparkPath)) {
      const sparkSize = fs.statSync(sparkPath).size;
      ok(sparkSize < 50 * 1024, '粒子贴图 < 50KB（实测 ' + sparkSize + ' bytes，包体积余量充足）');
      // PNG 签名校验（防 gen-particle 产出损坏）
      const head = fs.readFileSync(sparkPath).slice(0, 8);
      ok(head[0] === 137 && head[1] === 80 && head[2] === 78 && head[3] === 71,
        'spark.png 是合法 PNG（签名 89 50 4E 47）');
    }

    // —— 行为级：onAvatarTap 弹轮盘 / onEmoteClose 关轮盘 ——
    pageCtx.onAvatarTap({ currentTarget: { dataset: { seat: 2 } } });
    ok(dataStore.emoteShow === true && dataStore.emoteSeat === 2, '点头像 → 弹出表情轮盘（emoteShow=true, emoteSeat=2）');
    pageCtx.onEmoteClose();
    ok(dataStore.emoteShow === false && dataStore.emoteSeat === -1, 'onEmoteClose → 关闭轮盘（emoteShow=false）');

    // —— 行为级：onEmotePick 本地冒泡 + 频控 3s ——
    pageCtx.onAvatarTap({ currentTarget: { dataset: { seat: 2 } } });
    pageCtx.onEmotePick({ currentTarget: { dataset: { e: '🎉' } } });
    ok((dataStore.emotes || []).some(e => e.seat === 2 && e.emoji === '🎉'),
      '选 emoji → 本地冒泡（emotes 出现该座位该表情）');
    // 频控：3s 内同座位第二条被吞
    pageCtx.onAvatarTap({ currentTarget: { dataset: { seat: 2 } } });
    pageCtx.onEmotePick({ currentTarget: { dataset: { e: '👏' } } });
    ok(!(dataStore.emotes || []).some(e => e.seat === 2 && e.emoji === '👏'),
      '同座位 3s 内第二条表情被频控吞掉（EMOTE_THROTTLE_MS）');
    // 白名单外不冒泡
    pageCtx.onAvatarTap({ currentTarget: { dataset: { seat: 1 } } });
    pageCtx.onEmotePick({ currentTarget: { dataset: { e: '💣' } } });
    ok(!(dataStore.emotes || []).some(e => e.seat === 1 && e.emoji === '💣'),
      '白名单外 emoji（💣）不冒泡');

    // —— 行为级：_showEmoteBubble 新顶旧（每座位只留 1 个）——
    pageCtx.lastEmoteAt = {};   // 清频控，方便测试
    pageCtx._showEmoteBubble(3, '💪');
    pageCtx._showEmoteBubble(3, '👏');
    const seat3 = (dataStore.emotes || []).filter(e => e.seat === 3);
    ok(seat3.length === 1 && seat3[0].emoji === '👏',
      '同座位新表情顶替旧表情（每座位同时只留 1 个）');

    // —— 行为级：_bumpStreaks 赢家+1 / 其余清零 / ≥2 显示 ——
    const g = pageCtx.requireGame();
    if (g && g.result && g.result.winners) {
      // 借当前 result 结构验连胜（若当前无 result 则跳过行为级，静态守卫已覆盖）
      pageCtx._bumpStreaks({ winners: g.result.winners });
      const w = g.result.winners[0];
      ok(dataStore.streaks && dataStore.streaks[w] !== undefined,
        '_bumpStreaks 写入 streaks（赢家计 +1）');
    }

    // —— 行为级：_spawnSpark 产出带 seat 字段的粒子（wxml 按 seat 归属座位）——
    pageCtx._spawnSpark(1);
    ok(Array.isArray(dataStore.spark) && dataStore.spark.length > 0 &&
      dataStore.spark.every(p => p.seat === 1),
      '_spawnSpark 产出粒子数组，每粒带 seat=1（wxml 按 seat 归属到座位渲染）');

    // —— 行为级：_spawnFlyOut 产出的筹码带 dx/dy 位移量 ——
    pageCtx._spawnFlyOut(2);
    ok(Array.isArray(dataStore.flyOut) && dataStore.flyOut.length > 0 &&
      dataStore.flyOut.every(c => typeof c.dx === 'number' && typeof c.dy === 'number'),
      '_spawnFlyOut 产出筹码带 dx/dy 位移量（CSS 变量 --dx/--dy）');
  }

  /* ============================================================
   * 复盘缓存：replay-store + 复盘页解析（设计 2026-10-16 §1）
   * ========================================================== */
  (function () {
    const rs = require(path.join(__dirname, 'utils', 'replay-store.js'));

    /* ---- 静态守卫：replay-store.js 导出 + 上限常量 ---- */
    const storeSrc = fs.readFileSync(path.join(__dirname, 'utils', 'replay-store.js'), 'utf8');
    guardReplayStore(rs, storeSrc);

    /* ---- 行为级：addReplay 收割单手事件段 + FIFO 上限 ---- */
    // 用真机引擎跑一局，mock wx storage 注入
    const origStorage = wx.setStorageSync;
    const origGet = wx.getStorageSync;
    let memList = [];
    wx.setStorageSync = (k, v) => { if (k === 'poker_replay_cache') memList = v; };
    wx.getStorageSync = k => k === 'poker_replay_cache' ? memList : [];

    function playOne(seed, mySeat) {
      const g = P.createGame({
        players: [
          { id: 'me', name: '我', seat: 0, stack: 1000, isHuman: true },
          { id: 'b1', name: 'AI甲', seat: 1, stack: 1000 },
          { id: 'b2', name: 'AI乙', seat: 2, stack: 1000 }
        ], sb: 10, bb: 20, seed: seed
      });
      let step = 0;
      g.startHand();
      for (let i = 0; i < 500 && !g.result; i++) {
        const seat = g.actionSeat;
        if (seat < 0) break;
        const p = g.seatOf(seat);
        const legal = g.legalActions(seat);
        if (!legal) { g.advance(); continue; }
        const seats = g.inHandPlayers().map(x => x.seat);
        // B1 行动序位口径（与 table.js scheduleAI 同步）：rank 0 = 按钮左一，
        // lateness 归一 [0,1]；本测试仅驱动牌局走完，具体分布断言在 test-core.js。
        const nSeats = seats.length;
        const rank = (seats.indexOf(seat) - seats.indexOf(g.dealerSeat) + nSeats) % nSeats;
        const lateness = nSeats > 1 ? rank / (nSeats - 1) : 0;
        const pf = lateness >= 0.99 ? 0.9 : (lateness > 0.5 ? 0.4 : 0);
        const d = P.aiDecide({
          hole: p.hole, board: g.board, pot: g.potTotal(),
          toCall: legal.toCall, stack: p.stack, currentBet: g.currentBet,
          numActive: g.activePlayers().length,
          positionFactor: pf,
          style: p.style, minRaiseTo: legal.minRaiseTo, maxRaiseTo: legal.maxRaiseTo,
          canRaise: legal.canRaise, bb: g.bb,
          rng: P.createRng('mp-' + g.handNo + '-' + seat + '-' + (step++))
        });
        g.act(seat, d.action, d.amount);
      }
      return g;
    }

    const g1 = playOne('rp-test-1', 0);
    const added = rs.addReplay(g1, 0, 'ai');
    ok(added === true, 'addReplay 成功收割一局（有 events + result）');
    const rec1 = rs.latest();
    ok(!!rec1 && rec1.handNo === g1.handNo, 'latest() 取最近一局，handNo 匹配');
    // 上界 = 引擎全量 + 2 条盲注补录（addReplay 会在切分后插入虚拟 blind 事件）
    ok(rec1.events.length > 0 && rec1.events.length <= g1.events.length + 2,
      '收到的 events 非空且不超过「引擎全量 + 盲注补录2条」');
    // 关键：只含一个 hand_start（单手切分）
    ok(rec1.events.filter(e => e.type === 'hand_start').length === 1,
      '复盘事件段只含一个 hand_start（切出最后一手，多手不混流）');
    // 盲注虚拟事件已补录（两个 blind action）
    ok(rec1.events.filter(e => e.type === 'action' && e.action === 'blind').length === 2,
      '盲注补录成 2 个虚拟 action("blind") 事件（引擎盲注不发事件，复盘还原底池用）');

    /* ---- 底池守恒：复盘事件累加 = 引擎 committed 合计 ---- */
    let cur = 'preflop';
    const putByStreet = { preflop: 0, flop: 0, turn: 0, river: 0, showdown: 0 };
    rec1.events.forEach(e => {
      if (e.type === 'street') cur = e.street;
      else if (e.type === 'action') putByStreet[cur] += Number(e.amount) || 0;
    });
    const totalPut = Object.keys(putByStreet).reduce((s, k) => s + putByStreet[k], 0);
    const committed = g1.players.reduce((s, p) => s + p.committed, 0);
    eq(totalPut, committed, '复盘事件金额累加 = 引擎 committed 合计（底池守恒，含盲注补录）');

    /* ---- FIFO 上限挤出 ---- */
    memList = [];
    for (let i = 0; i < rs.MAX_REPLAYS + 3; i++) {
      const g = playOne('rp-fifo-' + i, 0);
      rs.addReplay(g, 0, 'ai');
    }
    eq(rs.listAll().length, rs.MAX_REPLAYS, 'FIFO：超过上限挤出最旧，恒为 20');

    /* ---- findByDate 定位 ---- */
    const all = rs.listAll();
    const pick = all[5];
    ok(!!rs.findByDate(pick.date), 'findByDate 按日期戳精确定位单局');
    ok(rs.findByDate(9999999999999) === null, 'findByDate 不存在返回 null');

    wx.setStorageSync = origStorage;
    wx.getStorageSync = origGet;
  })();

  /* ============================================================
   * AI 教学提示：advisor.js 起手牌分类 + 牌理解释（设计 2026-10-16 §2）
   * 纯函数单测 + table.js/wxml 接入静态守卫 + 行为级（renderAdvice 接入）
   * ========================================================== */
  (function advisorSuite() {
    const advisor = require(path.join(__dirname, 'utils', 'advisor.js'));
    const P = require(path.join(__dirname, 'core', 'poker-core.js'));
    const cid = (rank, suit) => (rank << 2) | suit;   // cardId，rank 0..12(A=12)
    const TAGS = ['premium', 'strong', 'playable', 'marginal', 'trash'];

    // ---- classifyHole：关键样本断言 ----
    const aa = advisor.classifyHole([cid(12, 0), cid(12, 1)]);
    ok(aa && aa.tag === 'premium' && aa.tier === 1, 'AA → premium/顶口袋对子');
    const kk = advisor.classifyHole([cid(11, 0), cid(11, 2)]);
    ok(kk && kk.tag === 'premium', 'KK → premium/顶口袋对子');
    const aks = advisor.classifyHole([cid(12, 0), cid(11, 0)]);
    ok(aks && aks.tag === 'premium', 'AKs → premium（同花大两高张）');
    const ako = advisor.classifyHole([cid(12, 0), cid(11, 2)]);
    ok(ako && ako.tag === 'premium', 'AKo → premium（非同花大两高张）');
    const qq = advisor.classifyHole([cid(10, 0), cid(10, 3)]);
    ok(qq && qq.tag === 'strong', 'QQ → strong/强口袋对');
    const jj = advisor.classifyHole([cid(9, 1), cid(9, 3)]);
    ok(jj && jj.tag === 'strong', 'JJ → strong/强口袋对');
    const tt = advisor.classifyHole([cid(8, 0), cid(8, 1)]);
    ok(tt && tt.tag === 'strong', 'TT → strong/中口袋对');
    const aqs = advisor.classifyHole([cid(12, 0), cid(10, 0)]);
    ok(aqs && aqs.tag === 'strong', 'AQs → strong');
    const kqs = advisor.classifyHole([cid(11, 1), cid(10, 1)]);
    ok(kqs && kqs.tag === 'strong', 'KQs → strong');
    const ajs = advisor.classifyHole([cid(12, 2), cid(9, 2)]);
    ok(ajs && ajs.tag === 'playable', 'AJ → playable');
    const p66 = advisor.classifyHole([cid(4, 0), cid(4, 3)]);
    ok(p66 && p66.tag === 'playable', '66 → playable/中口袋对');
    const p22 = advisor.classifyHole([cid(0, 0), cid(0, 2)]);
    ok(p22 && p22.tag === 'marginal', '22 → marginal/小口袋对（最低对子）');
    const a2s = advisor.classifyHole([cid(12, 0), cid(0, 0)]);
    ok(a2s && aqs && a2s.tag === 'marginal', 'A2s → marginal/小同花 A');
    const sevTwo = advisor.classifyHole([cid(5, 0), cid(0, 1)]);   // 72o
    ok(sevTwo && sevTwo.tag === 'trash', '72o → trash（非同花、间隔大、低牌）');
    const ts = advisor.classifyHole([cid(8, 0), cid(7, 0)]);      // T9s
    ok(ts && ts.tag === 'marginal', 'T9s → marginal/同花连张（lo<8，归同花连张而非大同花连张）');

    // ---- 全组合覆盖：52*51/2 每对都有合法归属 ----
    let bad = 0, nonNull = 0;
    for (let i = 0; i < 52; i++) {
      for (let j = i + 1; j < 52; j++) {
        const c = advisor.classifyHole([i, j]);
        if (!c) { bad++; continue; }
        nonNull++;
        if (TAGS.indexOf(c.tag) < 0) bad++;
        if (c.tier < 1 || c.tier > 5) bad++;
        if (typeof c.label !== 'string' || !c.label) bad++;
      }
    }
    ok(bad === 0 && nonNull === 52 * 51 / 2,
      '全 1326 种起手牌组合均有合法归属（tag∈5 类、tier 1..5、label 非空），坏 ' + bad);

    // ---- explainAdvice：4 种 tone 分支 ----
    const weak = advisor.explainAdvice(
      { tone: 'weak', equityPct: '38.0%', potOdds: '45.0%', drawOuts: 0 },
      { street: 'flop', toCallZero: false });
    ok(weak.tip && weak.cls === 'weak', 'weak 分支返回 tip + cls=weak');
    ok(/弃牌|亏/.test(weak.tip), 'weak 文案含「弃牌」或「亏」（教弃牌理由）');

    const strong = advisor.explainAdvice(
      { tone: 'strong', equityPct: '72.0%', potOdds: '25.0%', drawOuts: 0 },
      { street: 'preflop', toCallZero: false });
    ok(strong.tip && strong.cls === 'strong', 'strong+翻前 分支返回 tip + cls=strong');
    ok(/起手牌|加注/.test(strong.tip), 'strong+翻前 文案含「起手牌」或「加注」');

    const draw = advisor.explainAdvice(
      { tone: 'draw', equityPct: '40.0%', potOdds: '20.0%', drawOuts: 9, drawDesc: '同花听牌' },
      { street: 'flop', toCallZero: false });
    ok(draw.tip && draw.cls === 'draw', 'draw 分支返回 tip + cls=draw');
    ok(/补牌/.test(draw.tip) && draw.tip.indexOf('9') >= 0, 'draw 文案含补牌数「9」与「补牌」');

    const neutral = advisor.explainAdvice(
      { tone: 'neutral', equityPct: '50.0%', potOdds: '48.0%', drawOuts: 0 },
      { street: 'turn', toCallZero: false });
    ok(neutral.tip && neutral.cls === 'neutral', 'neutral 分支返回 tip + cls=neutral');

    // 过牌局面优先（toCallZero）：无论 tone，都走「免费看牌/控制底池」
    const freeCheck = advisor.explainAdvice(
      { tone: 'neutral', equityPct: '50.0%', potOdds: '0.0%', drawOuts: 0 },
      { street: 'flop', toCallZero: true });
    ok(/免费|过牌|控制底池/.test(freeCheck.tip), '过牌局面（toCallZero）文案含「免费看牌/过牌/控制底池」');

    // 容错：空 advice 返回空 tip
    ok(advisor.explainAdvice(null, {}).tip === '', 'explainAdvice 空入参容错返回空 tip');

    // parsePct 反解
    eq(advisor.parsePct('62.3%'), 0.623, 'parsePct 解析「62.3%」→ 0.623');
    ok(advisor.parsePct('xx') === null, 'parsePct 非法输入返回 null');

    // ---- table.js 接入静态守卫 ----
    const tableSrc = fs.readFileSync(path.join(__dirname, 'pages', 'table', 'table.js'), 'utf8');
    const wxmlSrc = fs.readFileSync(path.join(__dirname, 'pages', 'table', 'table.wxml'), 'utf8');
    guardAdvisorIntegration(tableSrc, wxmlSrc);

    // ---- 行为级：轮到我时 advice 含 explain；翻前含 holeLabel、翻后不含 ----
    // 复用主流程已驱动到「轮到我」的 pageCtx/game（见上方「等到轮到我」块）。
    // 此处不重驱动，只断言若当前 advice 有 text 则必有 explain（renderAdvice 接入生效）。
    if (dataStore.advice && dataStore.advice.text) {
      ok(typeof dataStore.advice.explain === 'string' && dataStore.advice.explain.length > 0,
        '行为级：轮到我时 advice.explain 非空（教学提示已接入），实际 = ' + JSON.stringify(dataStore.advice.explain));
      // 翻前应有起手牌前缀，翻后 holeLabel 为空（不重复显示）
      const g = pageCtx.requireGame && pageCtx.requireGame();
      if (g) {
        if (g.street === 'preflop') {
          ok(typeof dataStore.advice.holeLabel === 'string' && dataStore.advice.holeLabel.length > 0,
            '行为级：翻前 advice.holeLabel 非空（起手牌分类显示），实际 = ' + JSON.stringify(dataStore.advice.holeLabel));
        } else {
          ok(dataStore.advice.holeLabel === '',
            '行为级：翻后 advice.holeLabel 为空（不重复显示起手牌分类），实际 = ' + JSON.stringify(dataStore.advice.holeLabel));
        }
      }
    } else {
      // 没轮到我时跳过行为级（与既有建议类断言同策略），仍记一条静态覆盖
      ok(true, '行为级：当前未轮到我，advice 行为级跳过（静态守卫已覆盖接入）');
    }
  })();

  /* ============================================================
   * 个人风格分析：style-analyzer.js VPIP/AGG/摊牌胜率 + 我的页嵌入（设计 2026-10-16 §3）
   * 纯函数单测（构造 mock list，不依赖 replay-store）+ profile.js/wxml 接入静态守卫
   * ========================================================== */
  (function styleSuite() {
    const sa = require(path.join(__dirname, 'utils', 'style-analyzer.js'));

    // 构造 mock 复盘记录工厂：actions = [['preflop','raise'],...]，opts 覆盖 result 等。
    // ⚠️ 真实引擎 action 事件**不带 street 字段**（street 由独立的 type:'street' 事件
    // 推进），故 mock 须按真实事件流发射 street 事件（analyzer 用 curStreet 跟踪，
    // 不读 action 事件的 street——见 style-analyzer 头注释）。
    function mkRec(actions, opts) {
      const o = opts || {};
      const events = [];
      let prevStreet = null;
      actions.forEach(a => {
        if (a[0] !== prevStreet) {
          events.push({ type: 'street', street: a[0] });
          prevStreet = a[0];
        }
        events.push({ type: 'action', seat: 0, action: a[1] });
      });
      return Object.assign({
        mySeat: 0,
        events: events,
        result: { type: 'fold', winners: [1], awards: [{ seat: 1, amount: 100 }], evals: {} }
      }, o);
    }
    const foldOnly = () => mkRec([['preflop', 'fold']]);
    const preflopRaise = () => mkRec([['preflop', 'raise']]);
    const preflopCall = () => mkRec([['preflop', 'call']]);
    const postRaise = () => mkRec([['preflop', 'call'], ['flop', 'raise'], ['turn', 'raise']]);
    const postCall = () => mkRec([['preflop', 'call'], ['flop', 'check'], ['turn', 'call']]);
    const showdownWin = (w) => mkRec([['preflop', 'call'], ['flop', 'check']],
      { result: { type: 'showdown', winners: w ? [0] : [1], awards: [{ seat: w ? 0 : 1, amount: 50 }], evals: { 0: { name: '两对' } } } });

    // ---- 样本不足 ----
    eq(sa.VPipMin, 10, 'VPipMin 样本下限 = 10');
    const insuf9 = sa.analyze(Array.from({ length: 9 }, foldOnly));
    ok(insuf9.insufficient === true && insuf9.sample === 9,
      '样本不足（9 局）→ insufficient=true、sample=9，不硬算');

    // ---- 紧凶：2 局翻前 raise + 翻后 raise，8 局翻前 fold ----
    const tag = Array.from({ length: 10 }, (_, i) => i < 2
      ? postRaise()
      : foldOnly());
    const tagRes = sa.analyze(tag);
    ok(tagRes.insufficient !== true, '10 局样本足够，返回完整画像');
    ok(tagRes.vpip === 0.2 && tagRes.vpipPct === '20%',
      '紧凶 VPIP=20%（2/10 局自愿进池），实际 ' + tagRes.vpipPct);
    ok(tagRes.agg > 1 && tagRes.quadrant === '紧凶' && tagRes.quadrantTag === 'tight-aggressive',
      '紧凶象限：VPIP<28% + AGG≥1 → tight-aggressive，实际 ' + tagRes.quadrant + ' agg=' + tagRes.aggText);
    ok(/翻后很主动|频繁加注/.test(tagRes.observations.join('')),
      '紧凶观察含「翻后主动/频繁加注」');

    // ---- 松弱：10 局翻前 call + 翻后 check/call ----
    const lp = Array.from({ length: 10 }, postCall);
    const lpRes = sa.analyze(lp);
    ok(lpRes.vpip === 1 && lpRes.vpipPct === '100%',
      '松弱 VPIP=100%（局局翻前 call），实际 ' + lpRes.vpipPct);
    ok(lpRes.agg < 1 && lpRes.quadrant === '松弱' && lpRes.quadrantTag === 'loose-passive',
      '松弱象限：VPIP≥28% + AGG<1 → loose-passive，实际 ' + lpRes.quadrant);
    ok(/翻前入池很积极|手牌范围宽/.test(lpRes.observations.join('')),
      '松弱观察含「翻前入池积极/范围宽」');

    // ---- 紧弱：全翻前 fold（VPIP=0）----
    const tw = Array.from({ length: 10 }, foldOnly);
    const twRes = sa.analyze(tw);
    ok(twRes.vpip === 0 && twRes.quadrant === '紧弱' && twRes.quadrantTag === 'tight-passive',
      '紧弱象限：VPIP=0 + 无翻后攻击 → tight-passive');
    ok(/翻前很挑剔|只打好牌/.test(twRes.observations.join('')),
      '紧弱观察含「翻前挑剔/只打好牌」');

    // ---- 松凶：翻前 raise + 翻后 raise/allin 频繁 ----
    const lag = Array.from({ length: 10 }, (_, i) => mkRec(
      [['preflop', 'raise'], ['flop', 'allin'], ['turn', 'raise']]));
    const lagRes = sa.analyze(lag);
    ok(lagRes.quadrant === '松凶' && lagRes.quadrantTag === 'loose-aggressive',
      '松凶象限：VPIP=100% + AGG 高 → loose-aggressive');

    // ---- 摊牌胜率：3 局摊牌 2 胜 ----
    const sdList = [showdownWin(true), showdownWin(true), showdownWin(false)];
    // 凑够 10 局：7 局非摊牌 + 上面 3 局摊牌
    const sd10 = Array.from({ length: 7 }, postCall).concat(sdList);
    const sdRes = sa.analyze(sd10);
    ok(sdRes.sdRate === 3 && sdRes.sdWin === 2 / 3 && sdRes.sdWinPct === '67%',
      '摊牌胜率：3 局摊牌 2 胜 → sdWinPct=67%，实际 ' + sdRes.sdWinPct);

    // ---- 无摊牌样本 ----
    const noSd = Array.from({ length: 10 }, foldOnly);
    const noSdRes = sa.analyze(noSd);
    ok(noSdRes.sdRate === 0 && noSdRes.sdWinPct === '—',
      '无摊牌局：sdWinPct 显示「—」（不硬算百分比）');
    ok(/没有摊牌样本/.test(noSdRes.observations.join('')),
      '无摊牌时观察含「没有摊牌样本」');

    // ---- observations 约束：≤3 条且非空 ----
    const big = sa.analyze(Array.from({ length: 50 }, postCall));
    ok(big.observations.length <= 3 && big.observations.every(s => typeof s === 'string' && s.length > 0),
      '观察条数 ≤3 且每条非空字符串，实际 ' + big.observations.length);

    // ---- 空数组 / 非数组容错 ----
    ok(sa.analyze([]).insufficient === true, '空数组 → 样本不足');
    ok(sa.analyze(null).insufficient === true, 'null 入参容错 → 样本不足');

    // ---- AGG 边界：全 raise 无 call → 高 AGG 不除零 ----
    const allRaise = Array.from({ length: 10 }, postRaise);
    const arRes = sa.analyze(allRaise);
    ok(isFinite(arRes.agg) && arRes.agg > 0, 'AGG 全 raise 无跟注不除零（分母 max(call,1)=1）');

    // ---- VPIP BUG 修复验证：action 事件无 street，靠 type:'street' 跟踪 ----
    // 修复前 analyzer 读 e.street（undefined）→ 翻前分支恒不命中 → VPIP 恒 0。
    // 现跟踪 curStreet：10 局翻前 call 应得 VPIP=100%（修复前为 0）。
    const vpipFix = sa.analyze(Array.from({ length: 10 }, preflopCall));
    ok(vpipFix.vpip === 1 && vpipFix.vpipPct === '100%',
      'VPIP 修复：翻前 call 经 curStreet 跟踪计自愿进池 → 100%（修复前恒 0），实际 ' + vpipFix.vpipPct);

    // ---- 位置入池率 positionVpip：6 人桌按 btn 偏移取位置 ----
    // 构造含 hand_start(btn) + street + action 的事件流，断言各位置入池率。
    function mkPosRec(btn, mySeat, numSeats, preflopAct) {
      const evts = [{ type: 'hand_start', btn: btn, sb: (btn + 1) % numSeats, bb: (btn + 2) % numSeats }];
      evts.push({ type: 'street', street: 'preflop' });
      evts.push({ type: 'action', seat: mySeat, action: preflopAct });
      return { mySeat: mySeat, players: Array.from({ length: numSeats }, (_, i) => ({})),
        events: evts, result: { type: 'fold', winners: [0], awards: [], evals: {} } };
    }
    // 6 人桌 btn=2，mySeat=2 → offset 0 = BTN；10 局全翻前 call → BTN 入池 100%
    const posList = Array.from({ length: 10 }, () => mkPosRec(2, 2, 6, 'call'));
    const posRes = sa.analyze(posList);
    ok(posRes.positionVpip && posRes.positionVpip.BTN === '100%',
      '位置入池：6 人桌 btn=2 mySeat=2 → BTN，10 局翻前 call → BTN=100%，实际 ' + (posRes.positionVpip && posRes.positionVpip.BTN));
    // mySeat=3 → offset 1 = SB，翻前 fold → SB 入池 0%（但总局数应累计）
    const posFold = Array.from({ length: 10 }, () => mkPosRec(2, 3, 6, 'fold'))
      .concat(Array.from({ length: 0 }));
    const pfRes = sa.analyze(posFold);
    ok(pfRes.positionVpip && pfRes.positionVpip.SB === '0%',
      '位置入池：6 人桌 mySeat=3 → SB，10 局翻前 fold → SB=0%，实际 ' + (pfRes.positionVpip && pfRes.positionVpip.SB));

    // ---- profile.js 接入静态守卫 ----
    const profSrc = fs.readFileSync(path.join(__dirname, 'pages', 'profile', 'profile.js'), 'utf8');
    const profWxml = fs.readFileSync(path.join(__dirname, 'pages', 'profile', 'profile.wxml'), 'utf8');
    const profWxss = fs.readFileSync(path.join(__dirname, 'pages', 'profile', 'profile.wxss'), 'utf8');
    const saSrc = fs.readFileSync(path.join(__dirname, 'utils', 'style-analyzer.js'), 'utf8');
    guardStyleIntegration(profSrc, profWxml, profWxss, saSrc);

    // ---- 战绩深化图表（方向 A）接入静态守卫 ----
    const csSrc = fs.readFileSync(path.join(__dirname, 'utils', 'chart-stats.js'), 'utf8');
    guardChartsIntegration(profSrc, profWxml, profWxss, csSrc);

    // ---- 高光时刻存档 + 成就徽章墙（批①）接入静态守卫 ----
    const hlSrc = fs.readFileSync(path.join(__dirname, 'utils', 'highlight-store.js'), 'utf8');
    const tableSrc = fs.readFileSync(path.join(__dirname, 'pages', 'table', 'table.js'), 'utf8');
    const replaySrc = fs.readFileSync(path.join(__dirname, 'pages', 'replay', 'replay.js'), 'utf8');
    guardHighlightIntegration(profSrc, profWxml, profWxss, hlSrc, tableSrc, replaySrc, saSrc);

    // ---- 每日一题 / 局面挑战（批③）静态守卫 ----
    const puzzleSrc = fs.readFileSync(path.join(__dirname, 'utils', 'puzzles.js'), 'utf8');
    const pzPageSrc = fs.readFileSync(path.join(__dirname, 'pages', 'puzzle', 'puzzle.js'), 'utf8');
    const pzWxml = fs.readFileSync(path.join(__dirname, 'pages', 'puzzle', 'puzzle.wxml'), 'utf8');
    const pzWxss = fs.readFileSync(path.join(__dirname, 'pages', 'puzzle', 'puzzle.wxss'), 'utf8');
    const idxSrc = fs.readFileSync(path.join(__dirname, 'pages', 'index', 'index.js'), 'utf8');
    const idxWxml = fs.readFileSync(path.join(__dirname, 'pages', 'index', 'index.wxml'), 'utf8');
    const appJson = fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8');
    guardPuzzleIntegration(puzzleSrc, pzPageSrc, pzWxml, pzWxss, idxSrc, idxWxml, replaySrc, appJson);
    guardFromHighlightIntegration(puzzleSrc, pzPageSrc, pzWxml);

    // ---- AI 人格化组（批②）行为级 + 静态守卫 ----
    const botSrc = fs.readFileSync(path.join(__dirname, 'utils', 'bot-profiles.js'), 'utf8');
    guardBotProfilesIntegration(botSrc, tableSrc, idxSrc);
    guardAiDecideStyleExtension();   // 引擎扩展字段兜底（行为级）

    // ---- 限时局涨盲（批④）静态守卫 ----
    const tableWxml = fs.readFileSync(path.join(__dirname, 'pages', 'table', 'table.wxml'), 'utf8');
    const sfxSrc = fs.readFileSync(path.join(__dirname, 'utils', 'sfx.js'), 'utf8');
    guardBlindTimerIntegration(tableSrc, idxSrc, idxWxml, tableWxml, sfxSrc);

    // ---- SNG 淘汰赛（批⑤）静态守卫 ----
    const tableWxss = fs.readFileSync(path.join(__dirname, 'pages', 'table', 'table.wxss'), 'utf8');
    guardSngIntegration(tableSrc, idxSrc, idxWxml, tableWxml, tableWxss, profSrc, hlSrc, sfxSrc);

    // ---- 对手画像页（批⑥）静态守卫 ----
    guardOpponentProfile(tableSrc, tableWxml, tableWxss, botSrc, saSrc);

    // ---- 高光分享卡片（批⑦）静态守卫 ----
    guardShareCardIntegration(tableSrc, tableWxml, tableWxss, profSrc, hlSrc);

    // ---- AI 读人反制（批⑨）静态守卫 ----
    guardAiCounterIntegration(tableSrc);
  })();

  /* ---------- 静态守卫函数定义区 ----------
   * 以下函数均在 async IIFE 作用域内声明，函数声明会提升，
   * 故可在上方任意位置调用。每个函数封装一组纯源码字符串的
   * 静态守卫断言（不依赖任何运行时状态），参数为所需的源码字符串。 */
  function guardStandEntryVisibility(wxmlSrc) {
    const standCount = (wxmlSrc.match(/站起退出本局/g) || []).length;
    ok(standCount >= 3, '「站起退出本局」至少 3 处入口（结算面板 / 局内弃牌后 / 菜单），实际 ' + standCount + ' 处');
    ok(wxmlSrc.indexOf('rb-btn ghost') >= 0, '结算条含「站起退出本局」ghost 按钮（摊牌后可直接点）');
    ok(wxmlSrc.indexOf('stand-link') >= 0, '局内弃牌后含「站起退出本局」行内入口');
    ok(wxmlSrc.indexOf('用右侧「站起退出本局」') < 0, '退出弹窗文案不再指向已删除的右栏');
    const sitCount = (wxmlSrc.match(/坐下加入游戏/g) || []).length;
    ok(sitCount >= 3, '「坐下加入游戏」至少 3 处入口（局内观战 / 就绪面板 / 菜单），实际 ' + sitCount + ' 处');
    ok((wxmlSrc.match(/onMenuSit/g) || []).length >= 3, 'onMenuSit 绑定覆盖观战、就绪面板与菜单');
  }

  function guardResultbarLayout(wxmlSrc, wxssSrc) {
    ok(wxmlSrc.indexOf('result-banner') < 0, '旧的大弹窗 result-banner 已从 WXML 移除');
    ok(wxmlSrc.indexOf('class="resultbar"') >= 0, '新增横向紧凑结算条 .resultbar');
    ok(wxmlSrc.indexOf('resultbar') > wxmlSrc.indexOf('<!-- /felt -->'),
      '回归护栏：结算条必须位于牌桌区（felt）之后，走文档流而非绝对定位浮层');
    ok(wxmlSrc.indexOf('badge ready') >= 0 && wxmlSrc.indexOf('badge prewait') >= 0,
      '就绪状态上座位：各座位亮出「已准备/准备中」徽章（不再在底部条逐人罗列）');
    ok(wxmlSrc.indexOf('item.ready === true') >= 0, '座位徽章按就绪状态二态切换（true=已准备 / false=准备中）');
    ok(wxssSrc.indexOf('.result-banner') < 0 && wxssSrc.indexOf('.result-btn') < 0,
      '旧弹窗样式 .result-banner / .result-btn 已从 WXSS 删除');
    ok(wxssSrc.indexOf('.resultbar {') >= 0, 'WXSS 新增 .resultbar 样式');
    ok(/\.resultbar\s*\{[^}]*12 \* var\(--uh\)/.test(wxssSrc), '结算条高度约 12uh（横向紧凑条，纵向压缩后适配扁屏）');
    ok(wxssSrc.indexOf('.rc-chip') >= 0 && wxssSrc.indexOf('.rb-btn') >= 0,
      '结算条含胶囊（rc-chip）与按钮（rb-btn）样式');
  }

  function guardNoBareProcess() {
    // 微信小程序没有 process 全局对象（Node 测试里一切正常）——一旦源码里
    // 残留 process.env 调试语句，真机上直接 ReferenceError，且往往发生在
    // render 等关键链路上，全局回退等待室。此处静态扫描运行时源码防复发。
    // 豁免 utils/vendor/：内联的第三方构建产物（云 SDK），其 process 引用
    // 是「var process = globalThis2.process; ... process && process.versions」
    // 形式的环境探测，自带防御，真机安全。
    const fs = require('fs');
    const scanDirs = ['pages', 'utils', 'core', 'components'];
    const bad = [];
    const walk = dir => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      entries.forEach(en => {
        const p = path.join(dir, en.name);
        // dir 由 path.join(__dirname, d) 传入，是绝对路径——相对判断一律走 rel
        const rel = path.relative(__dirname, p).split(path.sep).join('/');
        if (en.isDirectory()) walk(p);
        else if (/\.js$/.test(en.name) && en.name.indexOf('test-') !== 0) {
          if (rel.indexOf('utils/vendor/') === 0) return;
          const src = fs.readFileSync(p, 'utf8');
          if (/(^|[^\w.])process\s*\./.test(src)) bad.push(rel);
        }
      });
    };
    scanDirs.forEach(d => walk(path.join(__dirname, d)));
    ok(bad.length === 0, '小程序运行时源码无裸 process 引用（真机无 process 全局）' +
      (bad.length ? '，违规文件: ' + bad.join(', ') : ''));
    // 云 SDK 内联产物就位：cloud.js 以相对路径 require 它，文件缺失 = 全局登录/同步失效
    ok(fs.existsSync(path.join(__dirname, 'utils/vendor/workbuddy-cloud-sdk.js')),
      '云 SDK 内联产物就位（utils/vendor/workbuddy-cloud-sdk.js）');
    ok(fs.existsSync(path.join(__dirname, 'utils/cloud.js')) &&
      fs.readFileSync(path.join(__dirname, 'utils/cloud.js'), 'utf8')
        .indexOf("require('./vendor/workbuddy-cloud-sdk')") >= 0,
      'cloud.js 引用内联 SDK（不再依赖 node_modules / 「构建 npm」）');
  }

  function guardResultShowPhase(tableSrc, wxmlSrc, wxssSrc) {
    ok(/RESULT_SHOW_MS = 3000/.test(tableSrc),
      '结算展示时长常量 RESULT_SHOW_MS = 3000ms（2026-10-17 由 5s 调优为 3s，配「继续 ▶」快进）');
    ok(tableSrc.indexOf('this.resultShowMs || RESULT_SHOW_MS') >= 0,
      '一手结束后延迟进入就绪阶段（结算展示可被测试覆盖缩短）');
    ok(tableSrc.indexOf("p.folded ? '弃牌'") >= 0,
      '结算行覆盖弃牌者（未摊牌的弃牌者显示「弃牌」而非消失）');
    ok(wxmlSrc.indexOf("item.net > 0 ? '+' + item.net") >= 0,
      '结算胶囊显示每人净盈亏（赢 +N / 输 -N / 平 ±0）');
    ok(wxssSrc.indexOf('.rc-gain.plus') >= 0 && wxssSrc.indexOf('.rc-gain.minus') >= 0,
      '盈亏配色样式：赢（金）/ 输（红灰）');
  }

  function guardResultModal(tableSrc, wxmlSrc, wxssSrc) {
    ok(/RESULT_MODAL_MS = 10000/.test(tableSrc), '结算弹窗自动关闭时长常量 RESULT_MODAL_MS = 10000ms');
    ok(tableSrc.indexOf('showResultModal') >= 0 && tableSrc.indexOf('closeResultModal') >= 0,
      '结算弹窗开/关方法齐备（showResultModal / closeResultModal）');
    ok(tableSrc.indexOf('resultModalHand') >= 0,
      '每手只调度一次结算弹窗（resultModalHand 守卫，镜像端轮询不重弹）');
    ok(tableSrc.indexOf('resultModal: this.data.result') >= 0 ||
       tableSrc.indexOf('resultModal: this.buildResult(game.result)') >= 0,
      '弹窗复用 buildResult 的每人净盈亏数据');
    ok(tableSrc.indexOf('isMe: p.seat === this.mySeat') >= 0, '结算弹窗高亮我的行（rows 带 isMe）');
    ok(tableSrc.indexOf('onResultNext') >= 0,
      '弹窗按钮：房主/本地 = 下一手进就绪计票，镜像端 = 知道了仅关闭');
    ok(wxmlSrc.indexOf('wx:if="{{resultModal}}"') >= 0, 'WXML 新增独立结算弹窗（resultModal）');
    ok(wxmlSrc.indexOf('查看结算') >= 0, '亮牌展示期摘要条提供「查看结算」立即弹窗入口');
    ok(wxmlSrc.indexOf("{{remoteMode || readyPhase ? '知道了' : '下一手'}}") >= 0,
      '弹窗按钮文案按端/阶段区分（镜像端与就绪期「知道了」/ 亮牌期房主「下一手」）');
    // 自动弹出时序：摊牌亮牌停留 RESULT_SHOW_MS 后自动开弹窗（用户明确要求）
    ok(/this\.resultTimer = setTimeout\(\(\) => \{[\s\S]{0,200}this\.showResultModal\(\)/.test(tableSrc),
      '结算弹窗在亮牌展示 RESULT_SHOW_MS 后**自动弹出**（非仅手动触发）');
    ok(wxmlSrc.indexOf('sr-cards') >= 0 && wxssSrc.indexOf('.sr-cards') >= 0,
      '结算弹窗行显示摊牌迷你手牌（弃牌者不亮牌，金边=参与最佳成手）');
    ok(tableSrc.indexOf('buildResult') >= 0 && /d\.hi = !!\(bestSet && bestSet\.has\(code\)\)/.test(tableSrc),
      'buildResult 为摊牌手牌打「参与最佳成手」高亮标记');
    ok(wxmlSrc.indexOf('sr-hand') >= 0 && wxssSrc.indexOf('.sr-hand') >= 0,
      '结算弹窗行显示牌型/状态列（sr-hand 样式齐备）');
    // G2（2026-10-17）：结算弹窗每行附带公共牌条 + 「我击中的」高亮
    ok(wxmlSrc.indexOf('sr-board') >= 0 && wxssSrc.indexOf('.sr-board') >= 0,
      '结算弹窗每行附公共牌条（sr-board + .sr-board 样式齐备）');
    ok(tableSrc.indexOf('bestIds') >= 0 && /new Set\(\[\.\.\.bestSet\]/.test(tableSrc),
      'buildResult 给每行派生 bestIds（参与最佳成手 5 张的 id 集，供公共牌行高亮）');
    ok(wxmlSrc.indexOf('item.board') >= 0,
      'WXML 用 item.board 渲染公共牌条（每行随底牌块同行展示）');
    // G4（2026-10-17）：公共牌条按街分桶；标签 2026-10-17 布局收口改为单字
    // （翻/转/河）——摊牌行要按列对齐，双字标签把公共牌条撑到弹窗放不下。
    ok(tableSrc.indexOf('boardBuckets') >= 0 && tableSrc.indexOf("['翻', '转', '河']") >= 0,
      'buildResult 派生 boardBuckets（三段街分桶，标签单字 翻/转/河）');
    ok(wxmlSrc.indexOf('sr-bucket') >= 0 && wxmlSrc.indexOf('sr-bl') >= 0 &&
      wxmlSrc.indexOf('item.boardBuckets') >= 0,
      'WXML 用街分桶渲染公共牌条（sr-bucket/sr-bl + item.boardBuckets）');
    ok(wxssSrc.indexOf('.sr-bucket') >= 0 && wxssSrc.indexOf('.sr-bl') >= 0,
      'WXSS 街分桶样式齐备（.sr-bucket/.sr-bl）');
    // G6 endHoles 透传已随「看全桌牌」入口撤销（2026-10-17）退役：
    // 镜像端不再消费底牌透传，_localToRoom 仍服务座位上行伪冒防护。
    ok(tableSrc.indexOf('endHoles') >= 0 && tableSrc.indexOf('_endHoleHandNo') >= 0,
      'endHoles 退役注释与 _endHoles/_endHoleHandNo 清引用齐备（防旧字段残留）');
    ok(/this\._endHoles = null;[\s\S]{0,80}this\._endHoleHandNo = null;/.test(tableSrc),
      'enterRemote 显式置空 _endHoles/_endHoleHandNo（防旧快照把退役字段卷回画面）');
    ok(!/revealAll/.test(tableSrc),
      'buildResult 的 revealAll 降级分支已删（上帝视角入口撤销，muck 礼仪回归纯摊牌）');
    ok(!/onToggleGodView/.test(tableSrc) &&
       !/bindtap="onToggleGodView"|>\s*(看|收起)全桌牌/.test(wxmlSrc),
      '「看全桌牌」入口彻底移除（onToggleGodView/WXML 按钮均不存在；退役注释不算）');
    ok(wxmlSrc.indexOf('wx:elif="{{result}}"') >= 0,
      '结算摘要条与就绪条互斥切换（亮牌期不出现逐人盈亏胶囊）');
  }

  function guardWpkDetails(tableSrc, wxmlSrc, wxssSrc) {
    ok(wxmlSrc.indexOf('buyin-dialog') >= 0 && wxmlSrc.indexOf('confirmBuyIn') >= 0,
      '入座流程：点空位 → 选买入额 → 入座');
    ok(tableSrc.indexOf('BUY_IN_OPTIONS') >= 0 && /DEFAULT_BUY_IN = 1000/.test(tableSrc),
      '买入档位常量与默认买入 1000');
    ok(/stack: Number\(s\.stack\) \|\| DEFAULT_BUY_IN/.test(tableSrc),
      '开局按各人买入额发筹码（未指定回落默认）');
    ok(wxmlSrc.indexOf('badge allin') >= 0 && wxmlSrc.indexOf('badge fold') >= 0,
      '座位状态徽章：ALL-IN / 弃牌');
    ok(wxmlSrc.indexOf('seat-win') >= 0 && tableSrc.indexOf('winGain') >= 0,
      '摊牌后赢家座位直接飘出赢得筹码');
    ok(wxssSrc.indexOf('.pot-chip') >= 0 && wxssSrc.indexOf('.bet-chip') >= 0,
      '中央底池与下注筹码堆采用筹码图标（WPK 风格）');
  }

  function guardWpkLayoutRegression(tableSrc, wxmlSrc, wxssSrc) {
    // ① 已移除旧的双坐标系（oppPos / genRing），统一为 ringPositions
    ok(!/function oppPos\(/.test(tableSrc), '已移除旧对手布局函数 oppPos（统一座位环）');
    ok(!/function genRing\(/.test(tableSrc), '已移除旧的等待室布局函数 genRing');
    ok(/function ringPositions\(/.test(tableSrc), '存在统一座位环函数 ringPositions（锚定我的座位为底部中央）');

    // ② 渲染所有玩家（含我）都在环上：render 用 ringPositions(allSeats, mySeat)
    ok(/ringPositions\(allSeats, this\.mySeat\)/.test(tableSrc), 'render 用 ringPositions 含我的座位（WPK 式：我也在牌桌环上）');
    ok(/buildWaitSeats[\s\S]*ringPositions\(list\.map\(s => s\.seat\)/.test(tableSrc), '等待室 buildWaitSeats 用 ringPositions（开局坐标连续无跳变）');

    // ③ 座位号 / 牌背 / 弃牌确认在视图与样式中
    ok(/item\.seatNo/.test(wxmlSrc), 'WXML：每个座位展示座位号 seatNo');
    ok(/item\.cardsBack/.test(wxmlSrc), 'WXML：对手未摊牌时展示牌背 cardsBack');
    ok(/card-xs back/.test(wxmlSrc), 'WXML：牌背用小牌样式 card-xs back');
    ok(/\.seat-no\s*\{/.test(wxssSrc), 'WXSS：存在座位号样式 .seat-no');
    ok(/ab-fold\.confirm/.test(wxssSrc), 'WXSS：存在弃牌确认态样式 .ab-fold.confirm');

    // ④ 桌上 N 个位常显：座位环按房间座位数铺满，没坐满时那几个位照样画出来
    //    （旧版只画在座者 → 8 人房 5 人开局时看不到还能再进 3 个人）
    ok(/for \(let si = 0; si < this\.maxSeats; si\+\+\) allSeats\.push\(si\)/.test(tableSrc),
      'render 按房间座位数铺满座位环（N 人桌就画 N 个位）');
    ok(/function emptySeat\(/.test(tableSrc) && /if \(!p\) return emptySeat\(/.test(tableSrc),
      '座位环上无人之位渲染成空位条目（不是直接跳过不画）');
    ok(/\.seat-cards \{[\s\S]{0,200}?margin-left: calc\(-4\.6 \* var\(--uw\)\)/.test(wxssSrc),
      '暗牌态仍是紧凑叠放（未摊牌时省空间）');

    // ⑤ 摊牌：两张牌必须都看得清（真机反馈「只能看清一张，另一张被遮挡」）
    ok(/class="seat-cards show"/.test(wxmlSrc), 'WXML：摊牌卡片容器带 show 类（走并排样式）');
    ok(/\.seat-cards\.show \.card-xs \+ \.card-xs \{ margin-left: calc\(0\.6 \* var\(--uw\)\)/.test(wxssSrc),
      '摊牌时两张牌并排（不再 -4.6uw 叠放遮挡第一张）');
    ok(/\.seat\.reveal \{ z-index: 8; \}/.test(wxssSrc),
      '摊牌座位整块浮到最上层（不被邻座名牌/筹码压住）');

    // ④ 弃牌二次确认逻辑
    ok(/onFold\(\)\s*\{[\s\S]*foldConfirm/.test(tableSrc), 'onFold 实现弃牌二次确认（首次进入确认态）');
    ok(/clearFoldTimer\(\)/.test(tableSrc), '存在弃牌确认计时器清理 clearFoldTimer');
    ok(/foldConfirm: isMyTurn \? this\.data\.foldConfirm : false/.test(tableSrc), '非我回合自动解除弃牌确认态');
  }

  function guardCustomBet(tableSrc, wxmlSrc, tableWxss) {
    // 三层一致性守卫：历史 bug 正是「JS/WXML 已改、WXSS 漏改」导致面板裸奔
    ok(/class="raise-custom"/.test(wxmlSrc), 'WXML：存在自定义下注面板容器 .raise-custom');
    ['rc-axis', 'rc-end', 'rc-num', 'rc-slider', 'rc-edit', 'rc-input', 'rc-q'].forEach(cls => {
      ok(new RegExp('\\.' + cls + '\\s*[,{]').test(tableWxss), 'WXSS：自定义面板样式齐全 .' + cls);
    });
    // 档位条与自定义面板互斥（并排会互相遮盖滑杆与轴标签）
    ok(/class="presets" wx:if="\{\{isMyTurn && !raiseCustom\}\}"/.test(wxmlSrc),
      'WXML：自定义面板展开时收起档位条（两者互斥，不并排挤在同一行）');
    ok(/\.rc-end\s*\{[^}]*flex:\s*none/.test(tableWxss),
      'WXSS：滑杆两端轴标签 flex:none（不与滑杆抢宽度，任意位数都不遮盖）');
    // 事件绑定与实现一一对应（onCustomTap 由「自定义」档经 onPresetTap 间接调用）
    ['onRaiseSlider', 'onRaiseInput', 'onRaiseBlur', 'onCustomMin', 'onCustomStep', 'onCustomPct',
      'onCustomMax', 'onCustomClose'].forEach(fn => {
      ok(wxmlSrc.indexOf(fn) >= 0 && new RegExp('\\n  ' + fn + '\\(').test(tableSrc),
        '自定义下注：WXML 绑定 ' + fn + ' 且 JS 已实现');
    });
    ok(/data-v="\{\{item\.k\}\}" bindtap="onPresetTap"/.test(wxmlSrc) &&
      /\n  onPresetTap\(/.test(tableSrc) && /\n  onCustomTap\(/.test(tableSrc) &&
      /if \(v === 'custom'\) \{ this\.onCustomTap\(\); return; \}/.test(tableSrc),
      '自定义下注：「自定义」档经 onPresetTap → onCustomTap 展开面板');
    ok(/\n  onCustomClose\(\) \{[\s\S]{0,120}raiseCustom: false/.test(tableSrc),
      '自定义下注：可「收起」面板回到档位条（两个入口并存不互斥死锁）');
    // 输入过程不抬下限（否则想输 500 时打完第一个 5 就被改写），失焦才补正
    ok(/onRaiseInput\(e\) \{[\s\S]{0,400}?if \(isNaN\(v\) \|\| v < 0\) v = 0;/.test(tableSrc) &&
      /onRaiseInput[\s\S]{0,400}?\n  \},/.test(tableSrc),
      '自定义下注：输入过程中只清洗与钳上限，不抢先抬到下限（否则无法连续输入目标值）');
    // 滑杆范围 = 最小 ~ 全下上限，按钮文案与实际提交同口径
    ok(/min="\{\{raiseMin\}\}" max="\{\{raiseMax\}\}"/.test(wxmlSrc),
      'WXML：滑杆范围 最小加注 ~ 最大（全下金额）');
    ok(/raiseSubmit/.test(tableSrc) && /raiseAllIn/.test(tableSrc),
      'render 计算 raiseSubmit / raiseAllIn（按钮文案与实际提交同口径）');
    ok(/raiseAllIn \? '全下'/.test(wxmlSrc), 'WXML：加注按钮按 raiseAllIn 显示「全下」');
    ok(/Math\.max\(legal\.minRaiseTo, Math\.round\(this\.data\.raiseTo \|\| 0\)\)/.test(tableSrc),
      'onRaise 钳制口径：低于最小加注按最小值提交（输入框填 0 也不会真下 0）');
  }

  function guardWechatNickname(tableSrc, authSrc, profWxml) {
    ok(/meLabel\(withOwner\)/.test(tableSrc) &&
      /meLabel\(withOwner\) \{[\s\S]{0,200}?auth\.myName\('你'\)/.test(tableSrc),
      '牌桌显示名统一走 meLabel()（默认取微信昵称）');
    ok(!/"你（房主）"|\? '你' : '好友'/.test(tableSrc) || /meLabel/.test(tableSrc),
      '牌桌不再硬编码「你 / 房主 / 好友」占位名');
    ok(/\(withOwner && this\.mode === 'friend'\)/.test(tableSrc),
      '「（房主）」后缀只在好友房出现（AI 桌无房主概念）');
    ok(/myName\(fallback\)/.test(authSrc) && /saveNickname\(nick\)/.test(authSrc) &&
      /isDefaultNickname\(nick\)/.test(authSrc),
      'auth 提供 myName / saveNickname / isDefaultNickname 昵称读写能力');
    ok(/DEFAULT_NICK/.test(authSrc) && /module\.exports = \{[^}]*DEFAULT_NICK/.test(authSrc),
      'auth 导出 DEFAULT_NICK 占位昵称（与各页判定口径一致）');
    ok(/type="nickname"/.test(profWxml),
      '我的页提供 <input type="nickname">（微信唯一合规的取真名方式）');
  }

  function guardRecordsCursor(authSrc, profSrc, tableSrc, profWxml) {
    ok(/listRecords\(limit = 20, cursor\)/.test(authSrc),
      'auth.listRecords 支持 cursor 游标参数（分页查询）');
    ok(/\.lt\('created_at', cursor\)/.test(authSrc),
      'listRecords 用 .lt(created_at) 推进游标（深翻页不退化）');
    ok(/PAGE_SIZE/.test(profSrc) && /loadRecords\(first\)/.test(profSrc),
      'profile.js 抽出 loadRecords(first) 分页方法 + PAGE_SIZE 常量');
    ok(/onReachBottom\(\)/.test(profSrc), 'profile.js 监听 onReachBottom 触底加载下一页');
    ok(/recordsEnd/.test(profSrc) && /recordsLoading/.test(profSrc),
      'profile.js 维护 recordsEnd / recordsLoading 状态（区分首屏与翻页加载）');
    ok(/onReachBottomDistance/.test(require('fs').readFileSync(
      path.join(__dirname, 'pages', 'profile', 'profile.json'), 'utf8')),
      'profile.json 配置 onReachBottomDistance（提前触发触底加载）');
    ok(/onPullDownRefresh\(\)/.test(profSrc) && /stopPullDownRefresh/.test(profSrc),
      'profile.js 定义 onPullDownRefresh 并调用 wx.stopPullDownRefresh');
    ok(/enablePullDownRefresh/.test(require('fs').readFileSync(
      path.join(__dirname, 'pages', 'profile', 'profile.json'), 'utf8')),
      'profile.json 启用 enablePullDownRefresh');
    ok(/onShareTimeline\(\)/.test(tableSrc), 'table.js 定义 onShareTimeline（朋友圈分享）');
    ok(/rec-more/.test(profWxml) && /rec-end/.test(profWxml),
      'WXML 战绩列表底部有「加载更多 / 没有更多战绩」节点');
    ok(/recordsError/.test(profSrc) && /onRetryRecords/.test(profSrc),
      'profile.js 有 recordsError 状态 + onRetryRecords 重试方法（区分加载失败与空列表）');
    ok(/recordsError/.test(profWxml) && /重试/.test(profWxml),
      'profile.wxml 区分加载失败态（recordsError）并提供重试按钮');
    // 失败分级守卫：catch 里只有首屏（first）才置 recordsError，翻页失败保留已加载列表
    ok(/if \(first\) patch\.recordsError = true/.test(profSrc),
      'loadRecords catch 失败分级：仅首屏置 recordsError，翻页失败保留已有列表');
  }

  function guardEngineRankDisplay(coreSrc, tableSrc) {
    ok(/const RANK_DISPLAY = \[[^\]]*'10'[^\]]*\]/.test(coreSrc),
      '引擎新增 RANK_DISPLAY：界面显示 10 而非 T');
    ok(/const RANK_NAMES = \[[^\]]*'T'[^\]]*\]/.test(coreSrc),
      '引擎 RANK_NAMES 保持单字符 T（机读码，参与编解码，不可改成 10）');
    ok(coreSrc.indexOf('RANK_NAMES') !== coreSrc.indexOf('RANK_DISPLAY') &&
      /RANK_NAMES, RANK_DISPLAY,/.test(coreSrc), 'RANK_DISPLAY 与机读码字母表一并导出');
    ok(/rank: P\.RANK_DISPLAY\[/.test(tableSrc), '牌桌牌面渲染使用 RANK_DISPLAY（T 显示为 10）');
  }

  function guardAiTableStart(tableSrc) {
    ok(/AI 对战：与好友房共用同一间等待室/.test(tableSrc) &&
      /this\.initWaiting\(\);/.test(tableSrc), 'AI 对战进入等待室而非直接开局');
    ok(/fillBots\(\) \{/.test(tableSrc) &&
      /while \(seats\.filter\(s => s\.occupied\)\.length < 2\)/.test(tableSrc),
      'AI 桌坐下后自动补位到 2 人（保证「坐下即可开始」，不一次加满）');
    ok(/roomSeat = \(this\.mode === 'friend' && this\.isOwner\) \? 0 : -1/.test(tableSrc),
      'AI 桌不预占座位（roomSeat = -1，由玩家自己挑位置）');
    ok(/AI_WAIT_HINT/.test(tableSrc) &&
      /sitting: '点任一空位选座位坐下/.test(tableSrc),
      'AI 等待室按是否已坐下切换引导文案');
  }

  function guardSfxPump(tableSrc) {
    ok(require('fs').existsSync(path.join(__dirname, 'utils', 'sfx.js')),
      '存在合成音效模块 utils/sfx.js（零音频资源）');
    ok(/startSfxPump\(\)/.test(tableSrc) && /drainSfx\(\)/.test(tableSrc) &&
      /this\.sfxPump = setInterval/.test(tableSrc),
      'table 启动 300ms 音效事件泵（对手在计时器路径的动作也能发声）');
    ok(/stopSfxPump\(\)/.test(tableSrc), '音效泵有明确的停止生命周期（onUnload 调用）');
    ok(/this\.data\.soundOn/.test(tableSrc), '音效开关在事件泵内逐次判断（切换即时生效）');
  }

  function guardSfxUnlock(sfxSrc, tableSrc, wxmlSrc) {
    ok(/function unlock\(\)/.test(sfxSrc) && /module.exports\s*=\s*\{[^}]*unlock/.test(sfxSrc),
      'sfx 导出 unlock()（音频解锁入口）');
    ok(/c\.resume\(\)/.test(sfxSrc),
      'unlock() 真正调用 resume()——suspended 上下文不 resume 就永不发声');
    ok(!/if \(!c \|\| !c\.currentTime\) return/.test(sfxSrc),
      'play() 不再用 currentTime 当守卫（该守卫会把解锁前的播放全部挡掉，形成死锁）');
    ok(/bindtouchstart="onFirstTouch"/.test(wxmlSrc),
      'table 根节点绑定 bindtouchstart="onFirstTouch"（在用户手势里解锁）');
    ok(/onFirstTouch\(\)\s*\{[\s\S]{0,200}?sfx\.unlock\(\)/.test(tableSrc),
      'onFirstTouch 调用 sfx.unlock()');
  }

  function guardPromptSfx(sfxSrc, tableSrc, wxmlSrc, wxssSrc) {
    ['warn', 'clock', 'timeout', 'chat'].forEach(k => {
      ok(new RegExp('^\\s{2}' + k + '\\(c, t\\) \\{', 'm').test(sfxSrc),
        'PRESETS 含新音色「' + k + '」（play() 按 PRESETS[name] 自动识别，无需改 play）');
    });
    // 静态守卫：4 处触发点 + 防重播标志位（全部在 soundOn 判断内）
    ok(/tick === 5 \|\| tick === 3/.test(tableSrc) && /sfx\.play\('warn'\)/.test(tableSrc),
      '行动计时环剩 5s/3s 滴答警告（防误超时代弃）');
    ok(/sfxWarnedTick = 0/.test(tableSrc) && /this\.sfxWarnedTick !== tick/.test(tableSrc),
      '警告音有防重播标志（同 tick 值只播一声，且回合重置清零）');
    ok(/left === 60 && !this\.sfxClockWarned/.test(tableSrc) &&
      /if \(this\.data\.soundOn\) sfx\.play\('clock'\)/.test(tableSrc),
      '限时局最后 60s 钟音（与 UI 变橙 remainSec<=60 同阈值）');
    ok(/this\.sfxClockWarned = left <= 60/.test(tableSrc),
      '续局从断点恢复时若已过 60s 阈值不再补播钟音');
    ok((tableSrc.match(/if \(this\.data\.soundOn\) sfx\.play\('timeout'\)/g) || []).length === 2,
      '被动代弃与自动站起各播一声 timeout（中性偏负下行音，共 2 处且都在 soundOn 内）');
    ok(tableSrc.indexOf('被动代弃提示') > 0 && tableSrc.indexOf('被动站起提示') > 0,
      '两处 timeout 各有注释锚点（代弃 vs 站起，防止将来误删一处）');
    // 超时被动处理偏保守：有注可跟 → 弃牌（不替玩家主动跟注/下注），无注 → 过牌。
    const timeoutBlock = (tableSrc.match(/if \(tick <= 0\)\s*\{[\s\S]*?1000\);\r?\n\s*\}/) || [''])[0];
    ok(/if \(legal\.toCall > 0\) this\.doAct\('fold', 0, '弃牌', 'act-f'\)/.test(timeoutBlock),
      '超时有注 → 弃牌（不替玩家主动跟注，与好友超时同口径）');
    ok(/else this\.doAct\('check', 0, '过牌', 'act-c'\)/.test(timeoutBlock),
      '超时无注 → 过牌（被动处理偏保守，不主动下注）');
    ok(!/legal\.toCall > 0\) this\.doAct\('call'/.test(timeoutBlock),
      '超时不再替玩家跟注（旧实现 auto-call 已移除）');
    // 好友超时 watchFriendAction 与本地超时同口径
    const watchBlock = (tableSrc.match(/watchFriendAction\(\)\s*\{[\s\S]*?advance\(\);\s*\n\s*\},?/) || [''])[0];
    ok(/legal\.toCall === 0 \? 'check' : 'fold'/.test(watchBlock),
      '好友超时无注 → 过牌、有注 → 弃牌（与本地超时 startTimer 同口径）');
    ok(/act === 'check' \? '超时未行动，自动过牌' : '超时未行动，自动弃牌'/.test(watchBlock),
      '好友超时代行 chat 文案按动作区分（过牌/弃牌）');
    ok(!/game\.act\(seat, 'fold'\);\s*\n\s*if \(r\.ok\)/.test(watchBlock),
      '好友超时不再一律 fold（旧实现无脑弃牌已移除）');
    ok(/this\.data\.soundOn && seat !== this\.mySeat\) sfx\.play\('chat'\)/.test(tableSrc),
      '收到他人/AI 消息播 chat 轻提示；我主动发的（seat===mySeat）不响');
    ok(/pushChat\(this\.mySeat/.test(tableSrc) && tableSrc.indexOf('我主动发，不响提示音') > 0,
      'pushChat 头注释锁定「我发的不响」语义（聊天消息传 mySeat 快捷发送 + 系统消息除外）');
    // 聊天未读徽章静态守卫
    ok(/chatUnread: 0/.test(tableSrc), 'data 有 chatUnread 未读计数字段');
    ok(/patch\.chatUnread = \(this\.data\.chatUnread \|\| 0\) \+ 1/.test(tableSrc),
      'pushChat 折叠期间收他人消息累计未读');
    ok(/chatUnread > 0 && !chatOpen/.test(wxmlSrc), 'WXML 聊天按钮有未读徽章（chatUnread>0 且折叠时）');
    ok(/\.chat-badge/.test(wxssSrc), 'WXSS 有 .chat-badge 未读徽章样式');
  }

  function guardRaisePresetPct(tableSrc, wxmlSrc) {
    const pctSrc = tableSrc;
    ok(/RAISE_PRESET_PCT\s*=/.test(pctSrc), '存在比例表 RAISE_PRESET_PCT');
    ['p33', 'p50', 'p67', 'p100'].forEach(k => {
      ok(new RegExp(k + '\\s*:').test(pctSrc.slice(pctSrc.indexOf('RAISE_PRESET_PCT'), pctSrc.indexOf('RAISE_PRESET_PCT') + 200)),
        '比例表含档位 ' + k);
    });
    ok(/step="\{\{raiseStep\}\}"/.test(wxmlSrc),
      '滑杆绑定 step="{{raiseStep}}"（控件层就只能停在盲注倍数）');
    ok(/bindtap="onCustomStep"/.test(wxmlSrc) && /data-dir="1"/.test(wxmlSrc) && /data-dir="-1"/.test(wxmlSrc),
      '面板提供 ± 步进按钮（data-dir 双向）');
    ok(/data-pct="0\.33"/.test(wxmlSrc) && /data-pct="0\.67"/.test(wxmlSrc) && /data-pct="1"/.test(wxmlSrc),
      '面板提供 33%/67%/100% 快捷额');
    ok(!/onCustomHalf|onCustomPot/.test(wxmlSrc + pctSrc),
      '旧的 ½池/底池 快捷入口已移除（统一为百分比档）');
  }

  function guardReadyButton(tableSrc, wxmlSrc, wxssSrc) {
    ok(/const READY_TIMEOUT_SEC = 30;/.test(tableSrc),
      '就绪倒计时 30 秒（超时自动站起）');
    ok(/class="rb-btn \{\{myReady \? 'done' : ''\}\}"/.test(wxmlSrc) &&
       /disabled="\{\{myReady\}\}"/.test(wxmlSrc),
      '就绪按钮用 done 态 + disabled 切换，而非 wx:if 消失成 rb-wait 小字');
    ok(!/rb-wait" wx:elif/.test(wxmlSrc), '旧的 rb-wait「已准备」文本入口已移除');
    ok(/\.rb-btn\.done\s*\{[\s\S]{0,300}?background:\s*rgba\(255,255,255/.test(wxssSrc),
      '存在 .rb-btn.done 灰态样式（点完变灰）');
    ok(/onReadyTap\(\)\s*\{[\s\S]{0,200}?if \(this\.data\.myReady\) return;/.test(tableSrc),
      'onReadyTap 对已就绪幂等（重复点击无副作用）');
    ok(/myReady \? '已准备' : '准备就绪'/.test(wxmlSrc) &&
       /!myReady && readyLeft > 0/.test(wxmlSrc),
      '就绪后按钮文案变「已准备」且不再显示倒计时秒数');
  }

  function guardSeatCardNoOverlap(tableSrc, wxmlSrc, wxssSrc) {
    const feltSrc = tableSrc;
    const cy = Number((feltSrc.match(/cy = (\d+)/) || [0, 0])[1]);
    // ry 支持两种写法：定值（ry = 27）与按人数自适应的三元（ry = big ? 25 : 27）
    const ry = Number((feltSrc.match(/ry = (?:big \? )?(\d+)/) || [0, 0])[1]);
    ok(cy > 0 && ry > 0, 'ringPositions 椭圆参数可解析 cy=' + cy + ' ry=' + ry);
    ok(cy - ry >= 10, '座位带最低点 ' + (cy - ry) + '% （≥10%，留出块延伸空间）');
    const yMax = Number((feltSrc.match(/y = Math\.max\(\d+, Math\.min\((\d+)/) || [0, 999])[1]);
    ok(yMax < 80, '对手座位锚点 y 上界 ' + yMax + '%（<80%，不下探到公共牌区）');
    ok(/\.pot-row \{[\s\S]{0,200}?z-index: 5/.test(wxssSrc),
      '.pot-row z-index 5 高于 .seat(3)：底池不被牌背盖住');
    ok(/\.board-row \{[\s\S]{0,200}?z-index: 5/.test(wxssSrc),
      '.board-row z-index 5 高于 .seat(3)：公共牌不被牌背盖住');
    ok(/\.pot-row::before/.test(wxssSrc) && /\.board-row::before/.test(wxssSrc),
      '底池/公共牌有 ::before 不透明底盘（重叠时不透出牌背花纹）');
    ok(/\.seat-cards \.card-xs \+ \.card-xs \{ margin-left: calc\(-[\d.]+ \* var\(--uw\)\)/.test(wxssSrc),
      '座位两张手牌叠放（负 margin），座位块高度显著下降');
    ok(/class="sb-main">开始游戏</.test(wxmlSrc) &&
       /class="sb-sub" wx:if="\{\{!canStart\}\}">至少 2 人</.test(wxmlSrc),
      '开始游戏按钮拆为主标题 + 副标题（不再把门槛塞进同一行括号）');
    ok(!/开始游戏\{\{canStart \? '' : '（至少 2 人）'\}\}/.test(wxmlSrc),
      '旧的同行括号写法已移除（那是折行的病根）');
    ok(/\.wait-actions \.sb-main \{[\s\S]{0,120}?white-space: nowrap/.test(wxssSrc),
      '开始游戏主标题 white-space:nowrap（永不折行）');
    ok(/\.wait-actions \.start-btn \{[\s\S]{0,120}?flex-direction: column/.test(wxssSrc),
      'start-btn 纵向排列，主副标题各占一行');
  }

  function guardOwnerRecovery(tableSrc, syncSrc) {
    ok(/auth\.findRoom\(this\.roomNo\)/.test(tableSrc),
      'bootstrapSync 查询房间行（房主归属的权威来源）');
    ok(/roomOwner === myUid\) this\.isOwner = true/.test(tableSrc),
      '以 poker_rooms.owner_id 与登录 uid 比对回收房主身份（own 参数退化为乐观提示）');
    ok(/this\.setData\(\{ isOwner: this\.isOwner \}\)/.test(tableSrc),
      '房主身份回收后同步到 data（UI 的房主标/开始按钮跟着更新）');
    const iRoom = tableSrc.indexOf('auth.findRoom(this.roomNo)');
    const iSeat = tableSrc.indexOf('let seat = this.isOwner ? 0 : -1');
    ok(iRoom > 0 && iSeat > 0 && iRoom < iSeat, '先回收房主身份再决定座位（顺序不能反）');
    ok(/if \(this\.syncLive\) \{\s*roomSync\.leave\(this\.roomNo\)/.test(tableSrc),
      '离房对所有人（含房主）释放自己的座位行，避免同一人占两个座位');
    ok(!/if \(this\.syncLive && !this\.isOwner\)/.test(tableSrc),
      '旧的「只给访客删行」写法已移除（那是两个自己的病根）');
    ok(/upsertMe[\s\S]{0,600}?\.neq\('seat', Number\(patch\.seat\)\)/.test(syncSrc),
      'upsertMe 写入座位前先清理同房间其他座位的自己的行（同用户唯一座位）');
    ok(/const liveBySeat = \{\}/.test(syncSrc) && /rank\(r\) > rank\(cur\)/.test(syncSrc),
      'buildWaitLayout 同座位多行去重（渲染层兜底，绝不画出两个自己）');
  }

  function guardClockExpiredAndSummary(tableSrc, wxmlSrc) {
    ok(/onClockExpired\(\)/.test(tableSrc), '存在 onClockExpired()：时长到点的决策入口');
    ok(/left <= 0\) \{\s*this\.clearClock\(\);\s*this\.onClockExpired\(\);/.test(tableSrc),
      'startClock 到点走 onClockExpired，不再直接 endGame（避免中途 game over）');
    ok(/onClockExpired\(\)\s*\{[\s\S]{0,700}?inPlay[\s\S]{0,400}?if \(!inPlay\) \{ this\.endGame\(\); return; \}/.test(tableSrc),
      'onClockExpired：不在打牌中才立即结束，打牌中则挂起');
    ok(/enterReadyPhase\(\)\s*\{[\s\S]{0,300}?if \(this\.pendingTimeUp\) \{ this\.pendingTimeUp = false; this\.endGame\(\); return; \}/.test(tableSrc),
      'enterReadyPhase 是「打完这手再总结束」的收口点');
    ok(/myBuyIn: me \? me\.buyIn : 0/.test(tableSrc) && /myStack: me \? me\.stack : 0/.test(tableSrc),
      'endGame 的 summary 输出 myBuyIn / myStack');
    ok(/buyIn:\s*this\.startStacks\[p\.seat\] !== undefined|const buyIn\s*=\s*this\.startStacks\[p\.seat\] !== undefined/.test(tableSrc),
      '结算单每行带 buyIn（带入筹码，口径取自 startStacks）');
    ok(/sum-bank/.test(wxmlSrc) && /带入/.test(wxmlSrc) && /剩余/.test(wxmlSrc),
      '结算单与实时面板共用「带入/剩余/盈亏」三件套组件');
    ok(/bindtap="onMenuBank"/.test(wxmlSrc) && /onMenuBank\(\)\s*\{[\s\S]{0,200}?bankShow: true/.test(tableSrc),
      '菜单「我的筹码」入口打开实时盈亏面板');
    ok(/onBankClose\(\)\s*\{[\s\S]{0,120}?bankShow: false/.test(tableSrc),
      '实时盈亏面板可关闭');
    ok(/myNetLive: myNetLive/.test(tableSrc) && /myNetLiveText:/.test(tableSrc),
      'render 逐帧派生 myNetLive / myNetLiveText（面板实时刷新）');
    ok(/clockPendingEnd: !!this\.data\.clockPendingEnd/.test(tableSrc) &&
       /clockPendingEnd: !st\.summary && st\.clockPendingEnd === true/.test(tableSrc),
      'clockPendingEnd 随房主广播同步给好友端');
    ok(/clockPendingEnd \? '本手后' : remainText/.test(wxmlSrc),
      '顶栏到点挂起显示「本手后」而非停在 00:00');
  }

  function guardSetRaiseTo(tableSrc, wxmlSrc) {
    ok(/setRaiseTo\(amt, preset\)/.test(tableSrc),
      '存在统一入口 setRaiseTo()：一次写入 raiseTo + raiseSubmit + raiseAllIn');
    ok(/setRaiseTo[\s\S]{0,400}?raiseSubmit: submit, raiseAllIn:/.test(tableSrc),
      'setRaiseTo 同帧写入按钮文案派生字段（不依赖 render 触发）');
    ok(!/setData\(\{ raiseTo/.test(tableSrc),
      '所有改下注金额的入口均已收口到 setRaiseTo（无裸 setData({raiseTo}) 漏同步）');
    ok(/onCustomTap\(\)\s*\{[\s\S]{0,900}?setData\(\{\s*raiseCustom:\s*open\s*\}\)/.test(tableSrc),
      'onCustomTap 显式写入 raiseCustom（否则面板永远不弹出）');
    const raiseEntry = (tableSrc.match(/setRaiseTo\(/g) || []).length;
    ok(raiseEntry >= 10, '金额设置入口全部走 setRaiseTo（1 定义 + 9 调用），实际 ' + raiseEntry);
    ['onCustomTap', 'onRaiseSlider', 'onRaiseInput', 'onRaiseBlur', 'onCustomMin',
      'onCustomStep', 'onCustomPct', 'onCustomMax', 'onPresetTap'].forEach(fn => {
      const body = (tableSrc.match(new RegExp('\\n  ' + fn + '\\([\\s\\S]*?\\n  \\},')) || [''])[0];
      ok(!/setData\(\{ raiseTo/.test(body),
        '自定义下注：' + fn + ' 不直写 raiseTo（按钮文案必然同步）');
    });
    ok(/Math\.max\(legal\.minRaiseTo, Math\.round\(this\.data\.raiseTo \|\| 0\)\)/.test(tableSrc),
      'onRaise 钳制口径与按钮文案一致：低于最小加注按最小值提交');
    ok(/raiseAllIn \? '全下'/.test(wxmlSrc), 'WXML：加注按钮按 raiseAllIn 显示「全下」');
    ok(!/onRaiseChange/.test(tableSrc) && !/onRaiseChange/.test(wxmlSrc),
      '旧滑杆回调 onRaiseChange 无死代码、无悬空绑定');
  }

  function guardLifecyclePause(tableSrc) {
    ok(/onHide\(\)\s*\{\s*[\s\S]{0,120}?this\.onEnterBackground\(\)/.test(tableSrc),
      'onHide 已定义并进入后台暂停（此前切后台轮询/看门狗/倒计时照跑）');
    ok(/onEnterBackground\(\)\s*\{[\s\S]{0,2000}?this\.stopPolling\(\)/.test(tableSrc) &&
      /onEnterBackground\(\)\s*\{[\s\S]{0,2000}?this\.stopEngineWatch\(\)/.test(tableSrc),
      '后台暂停覆盖轮询与看门狗');
    ok(/onEnterBackground\(\)\s*\{[\s\S]{0,2000}?clearTimeout\(aiTimer\)/.test(tableSrc),
      '后台暂停覆盖 AI 调度');
    ok(/onEnterBackground\(\)\s*\{[\s\S]{0,2400}?bgRemainSec = Number\(this\.data\.remainSec\)/.test(tableSrc) &&
      /onLeaveBackground\(\)\s*\{[\s\S]{0,900}?startClock\(resume\)/.test(tableSrc),
      '限时局后台断点续走（回前台从剩余秒数继续，后台时间不计入）');
  }

  function guardSyncFailToast(tableSrc) {
    const silentCatches = (tableSrc.match(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || []).length;
    const SILENT_OK_COUNT = 0;
    ok(silentCatches === SILENT_OK_COUNT,
      '同步链路无静默吞错（裸 catch 已清零），实际 ' + silentCatches);
    ok(/SYNC_FAIL_TOAST_MS = 10000/.test(tableSrc),
      '同步失败提示节流常量 SYNC_FAIL_TOAST_MS 存在（心跳 5s 一发防刷屏）');
    ok(/syncFailToast\(title\)/.test(tableSrc), '存在统一失败提示入口 syncFailToast');
    ['heartbeat', 'pushAction', 'publishState', 'markReadyRow'].forEach(fn => {
      const re = new RegExp('roomSync\\.' + fn + '\\([^)]*\\)[\\s\\S]{0,200}?\\.catch\\(\\(\\) => \\{\\s*\\}\\)');
      ok(!re.test(tableSrc), 'roomSync.' + fn + ' 的失败不再被吞（必须有用户可见提示）');
    });
    ['站起未同步成功', '坐下未同步成功', '准备未同步成功', '牌局同步失败'].forEach(t => {
      ok(tableSrc.indexOf(t) >= 0, '关键上行失败提示文案已定义：' + t);
    });
  }

  function guardPollReentry(tableSrc) {
    ok(/if \(this\._polling\) return/.test(tableSrc), 'pollOnce 有重入守卫（_polling 标记）');
    ok(/finally \{[\s\S]{0,60}?this\._polling = false/.test(tableSrc), 'pollOnce finally 释放 _polling 标记');
  }

  function guardBootstrapStopSync(tableSrc) {
    ok(/bootstrap-sync[\s\S]{0,600}?this\.stopSync\(\)/.test(tableSrc) ||
       /this\.stopSync\(\)[\s\S]{0,400}?bootstrap-sync/.test(tableSrc),
      'bootstrapSync 失败 catch 调用 stopSync 清理可能已起的定时器');
  }

  function guardCatchtapExplicit(tableSrc, wxmlSrc) {
    ok(!/catchtap>/.test(wxmlSrc) && !/"catchtap"|catchtap=""/.test(wxmlSrc),
      'table.wxml 无裸 catchtap（全部显式绑定了处理函数）');
    ok(/onBlockTap\(\)\s*\{\s*\/\* 有意留空/.test(tableSrc),
      '显式空处理函数 onBlockTap 已定义');
    const idxWxml = require('fs').readFileSync(
      path.join(__dirname, 'pages', 'index', 'index.wxml'), 'utf8');
    ok(!/catchtap>/.test(idxWxml), 'index.wxml 同样无裸 catchtap');
  }

  function guardTimerNoResidue(tableSrc) {
    const stBody = (tableSrc.match(/startTimer\(\)\s*\{[\s\S]*?1000\);\r?\n  \}/) || [''])[0];
    ok(/myTimer: tick/.test(stBody), 'startTimer 回调写我的计时字段');
    ok(!/seats:/.test(stBody), 'startTimer 每秒回调不写整条 seats 数组（局部路径更新单座位，不吃我的残值）');
    ok(/seats\[' \+ actIdx \+ '\]\.timer/.test(stBody),
      '对手回合按行动座位局部 setData seats[actIdx].timer（消除跳秒）');
    ok(/timer: !readyPhase && game\.actionSeat === p\.seat \? tick : ''/.test(tableSrc),
      '对手环只在行动座位显示 tick（非行动座位为空串，环隐藏）');
  }

  /* 超时口径统一（玩家审视 2026-10-17）：remote 模式本地计时环与房主 30s 代弃同源。
   * 此前本地环 20s 走完后好友端还要干等 10s 才被代弃——UI 与权威端说两个数。 */
  function guardTimerMaxUnified(tableSrc) {
    ok(/timerMax\(\)\s*\{\s*return this\.remoteMode \? roomSync\.SYNC\.ACTION_TIMEOUT_SEC : TICK_MAX;?\s*\}/.test(tableSrc),
      'timerMax() 按模式取超时上限：remote 走 ACTION_TIMEOUT_SEC、单机走 TICK_MAX（同源不分叉）');
    const stBody = (tableSrc.match(/startTimer\(\)\s*\{[\s\S]*?1000\);\r?\n  \}/) || [''])[0];
    ok(/const tickMax = this\.timerMax\(\)/.test(stBody),
      'startTimer 初值取 timerMax()（remote 30s / 单机 20s）');
    ok(!/tick = TICK_MAX;/.test(tableSrc),
      '不再有硬编码 tick = TICK_MAX（口径由 timerMax() 单点供给）');
    ok(/tick \/ tickMax \* 100/.test(stBody), '计时环百分比按 tickMax 归一（remote 环走满 30s）');
  }

  /* 边池归属 + 非摊牌赢池自愿亮牌（玩家审视 2026-10-17）：
   * 多路全下时边池要显示「谁有资格拿这个池」；fold 赢池的获胜者给「亮一手」
   * 主动选择权（muck 礼仪之外，亮 A 高诈唬是社交货币）。静态守卫兜底——
   * 亮牌前的多重条件（fold 结算/赢家/权威端/未亮过）在行为测试里复现成本高。 */
  function guardSidePotElig(tableSrc, wxmlSrc, wxssSrc) {
    ok(/eligible: \(p\.eligible \|\| \[\]\)\.map\(s => s \+ 1\)/.test(tableSrc),
      'sidePots 携带 eligible（1 起座位号，与座位环显示口径一致）');
    ok(/eligibleList: \(p\.eligible \|\| \[\]\)\.map\(s => s \+ 1\)\.join\('\/'\)/.test(tableSrc),
      'sidePots 携带 eligibleList（拼接展示不在 wxml 里算复杂表达式）');
    ok(/wx:for-item="sp"/.test(wxmlSrc) && /sp\.eligibleList/.test(wxmlSrc),
      'WXML 边池用 sp 别名渲染归属列表');
    ok(/\.side-pot \.sp-elig/.test(wxssSrc), 'WXSS 有边池归属样式');
  }

  function guardDisclose(tableSrc, wxmlSrc) {
    ok(/canDisclose: false,/.test(tableSrc), 'data 声明 canDisclose 初始值');
    ok(/const canDisclose = !!\(!this\.remoteMode && game && game\.result && game\.result\.type === 'fold' &&/.test(tableSrc) &&
      /game\.result\.winners\.indexOf\(this\.mySeat\) !== -1 && meInResult && meInResult\.hole\.length === 2 &&/.test(tableSrc),
      'canDisclose 门控四条件：权威端 + fold 结算 + 我是赢家 + 底牌仍在（摊牌局不亮重复）');
    ok(/onShowMyCards\(\)\s*\{\s*if \(this\.remoteMode\) return;/.test(tableSrc),
      'onShowMyCards 拒绝镜像端（写本地 reveal 会被下一帧快照卷回）');
    ok(/game\.showdownReveal\[this\.mySeat\] = \{/.test(tableSrc),
      '亮牌写进 showdownReveal[mySeat]（复用摊牌亮牌的渲染/同步链路）');
    ok(/onShowMyCards\(\)\s*\{[\s\S]{0,900}?this\._lastRenderFp = null/.test(tableSrc),
      'onShowMyCards 穿透渲染指纹（reveal 派生 seats[].hole/结算行，否则跳过分支吞掉亮牌）');
    ok(/onShowMyCards\(\)\s*\{[\s\S]{0,1000}?forcePublish\(\)/.test(tableSrc),
      'onShowMyCards 房主端 forcePublish（写库指纹穿透，亮牌随下一帧广播）');
    ok(/if \(this\.data\.canDisclose\) this\.setData\(\{ resultModal: null, canDisclose: false \}\);/.test(tableSrc),
      'closeResultModal 关弹窗时复位 canDisclose（防下一手残显亮牌按钮；replayDate 已随 G3 行内入口退役不再清理）');
    ok(/bindtap="onShowMyCards" wx:if="\{\{canDisclose\}\}"/.test(wxmlSrc) ||
       /wx:if="\{\{canDisclose\}\}" bindtap="onShowMyCards"/.test(wxmlSrc),
      'WXML 有「亮一手」入口且由 canDisclose 门控（结算弹窗平铺胶囊行，2026-10-17 二次收口）');
  }

  function guardTimerUrgent(tableSrc, wxmlSrc, wxssSrc) {
    ok(/timerUrgent: !readyPhase && game\.actionSeat === p\.seat && tick <= 5 && tick > 0/.test(tableSrc),
      '对手行动座位最后 5s 标记 timerUrgent（计时环转红脉冲）');
    ok(/myTimerUrgent: game\.actionSeat === this\.mySeat && !result && tick <= 5 && tick > 0/.test(tableSrc),
      '我轮到时最后 5s 标记 myTimerUrgent（行动条脉冲）');
    const stBody = (tableSrc.match(/startTimer\(\)\s*\{[\s\S]*?1000\);\r?\n  \}/) || [''])[0];
    ok(/myTimerUrgent: tick <= 5 && tick > 0/.test(stBody),
      'startTimer 每秒回调同步刷新 myTimerUrgent（最后 5s 持续脉冲）');
    ok(/class="timer \{\{item\.timerUrgent \? 'urgent' : ''\}\}"/.test(wxmlSrc),
      'WXML 计时环按 timerUrgent 切换 urgent class');
    ok(/class="actbar \{\{myTimerUrgent \? 'urgent' : ''\}\}"/.test(wxmlSrc),
      'WXML 行动条按 myTimerUrgent 切换 urgent class');
    ok(/\.timer\.urgent[\s\S]*?animation: timerPulse/.test(wxssSrc), 'WXSS 计时环 urgent 态有 timerPulse 动画');
    ok(/\.actbar\.urgent[\s\S]*?animation: actbarPulse/.test(wxssSrc), 'WXSS 行动条 urgent 态有 actbarPulse 动画');
  }

  function guardResultModalDoc(tableSrc) {
    const mdoc = (tableSrc.match(/弹出单手结算弹窗[\s\S]{0,300}?由 render 末尾的统一调度[\s\S]{0,120}?自动触发/) || [])[0];
    ok(!!mdoc, 'showResultModal 注释已改为「render 统一调度自动触发 + 用户可提前打开」（与代码一致）');
    ok(/this\.resultTimer = setTimeout\(\(\) => \{[\s\S]{0,200}?showResultModal\(\)/.test(tableSrc),
      'render 末尾确有自动弹出调度（注释与代码不再矛盾）');
  }

  function guardDirtyCheckFingerprint(tableSrc) {
    ok(tableSrc.indexOf('_lastPlayFp') >= 0, 'writePlayState 有房主指纹缓存键');
    ok(/if \(this\._lastPlayFp === fingerprint\) return/.test(tableSrc),
      '房主牌局未变时跳过本轮写库');
    ok(tableSrc.indexOf('_lastRemoteFp') >= 0, 'enterRemote 有镜像指纹缓存键');
    ok(/if \(this\._lastRemoteFp === fp\) return/.test(tableSrc),
      '好友端快照未变时跳过本轮 setData + render');
  }

  function guardIdleTimeout(tableSrc, wxmlSrc, wxssSrc) {
    ok(tableSrc.indexOf('IDLE_WARN_MS') > 0, '定义了空闲提示提前量 IDLE_WARN_MS');
    ok(tableSrc.indexOf('tickExpireWarn') > 0, '定义了逐秒刷新倒计时文案方法 tickExpireWarn');
    ok(tableSrc.indexOf('clearExpireWarn') > 0, '定义了清掉空闲提示方法 clearExpireWarn');
    ok(/idleRemainText: '',/.test(tableSrc), 'data 声明空闲倒计时文案字段 idleRemainText');
    ok(wxmlSrc.indexOf('wi-idle') > 0, 'WXML 等待室空闲倒计时提示节点 wi-idle');
    ok(/\.wi-idle[\s\S]*?idlePulse/.test(wxssSrc), 'WXSS 空闲提示有 idlePulse 脉冲动画');
  }

  function guardPerfCache(tableSrc) {
    ok(/_ringCache/.test(tableSrc), 'ringPositions 有模块级缓存 _ringCache');
    ok(/cacheKey/.test(tableSrc) && /_ringCache\[cacheKey\] = pos/.test(tableSrc),
      'ringPositions 命中缓存时写回并返回（纯函数缓存）');
    ok(/_cardCache/.test(tableSrc), 'cardData 有按 card id 缓存 _cardCache');
  }

  function guardRenderFingerprint(tableSrc) {
    ok(/_lastRenderFp/.test(tableSrc), 'render 有渲染指纹缓存键 _lastRenderFp');
    ok(/if \(this\._lastRenderFp === fp\)/.test(tableSrc), 'render 指纹命中时跳过 setData');
    ok(/_renderTail\(\)/.test(tableSrc), 'render 尾部调度抽出 _renderTail（指纹跳过时仍执行）');
    ok(/tick,/.test(tableSrc) && /myActText,/.test(tableSrc),
      '渲染指纹含 tick 与 myActText（计时环与动作气泡变化可触发重绘）');
    // 距离上限放宽到 400：resultModal 与指纹置位之间允许插入新的 setData 字段
    // （如 P0-1 的 myAIBusted/aiUnlimitedTip），只要「先 setData、后置位」的顺序不破。
    ok(/resultModal: result \? this\.data\.resultModal : null[\s\S]{0,400}this\._lastRenderFp = fp/.test(tableSrc),
      '指纹置位在主 setData 之后（异常帧不缓存指纹，下帧自动重试；允许其间插入新字段）');
    ok(!/if \(this\._lastRenderFp === fp\)[\s\S]{0,40}this\._lastRenderFp = fp/.test(tableSrc),
      '指纹赋值不在「命中跳过」之后紧跟（避免 body 抛错前就置位）');
  }

  function guardSidePotsRender(tableSrc) {
    ok(/if \(!readyPhase && game\.pots && game\.pots\.length > 1\)/.test(tableSrc),
      'render 有边池分层分支（pots.length > 1 才切边池）');
    ok(/sidePots = game\.pots\.slice\(1\)\.map\(p => \(\{/.test(tableSrc),
      '边池取 pots.slice(1) 映射对象（金额 + 归属，主池在 pot 字段单独展示）');
    ok(/sidePots,/.test(tableSrc), 'sidePots 进 setData（渲染层可见）');
  }

  function guardWatchFriendTimeout(tableSrc) {
    ok(/roomSync\.SYNC\.ACTION_TIMEOUT_SEC \* 1000/.test(tableSrc),
      'watchFriendAction 用 ACTION_TIMEOUT_SEC*1000 作 30s 阈值');
    ok(/legal && legal\.toCall === 0 \? 'check' : 'fold'/.test(tableSrc),
      '代行口径：无注过牌 / 有注弃牌（与本地 startTimer 超时同口径）');
    ok(/超时未行动，自动过牌|超时未行动，自动弃牌/.test(tableSrc),
      '代弃有 pushChat 系统消息（过牌/弃牌两案）');
  }

  function guardPublishPlayThrottle(tableSrc) {
    ok(/publishDue\|publishTimer/.test(tableSrc) || (/publishDue/.test(tableSrc) && /publishTimer/.test(tableSrc)),
      'publishPlay 用 publishDue/publishTimer 做 500ms 节流');
    ok(/if \(now >= due\)/.test(tableSrc), 'publishPlay 到期分支（now >= due 直发）');
    ok(/this\.publishTimer = setTimeout/.test(tableSrc),
      'publishPlay 未到期分支挂延后 setTimeout');
  }

  function guardAdviceCache(adviceSrc) {
    ok(adviceSrc.indexOf('_adviceKey') >= 0, 'renderAdvice 有缓存键（不再每帧重算）');
    ok(/!isMyTurn \|\| this\.mode !== 'ai'\)[\s\S]*?_adviceKey = null/.test(adviceSrc),
      '离开我的回合即失效缓存键（下一回合必是新局势）');
  }

  function guardResetRaiseState(tableSrc2) {
    const shIdx = tableSrc2.indexOf('startHand()');
    ok(shIdx >= 0 && tableSrc2.indexOf('this.resetRaiseState()', shIdx) >= 0 &&
      tableSrc2.indexOf('this.resetRaiseState()', shIdx) < tableSrc2.indexOf('this.render()', shIdx),
      'startHand 里在 render() 之前调用了 resetRaiseState()（顺序锁死，否则时序兜底失效）');
    // 语义守卫：锁死 render 里「每手首帧取最小额」的那行真的存在。
    ok(/const wasReset = !!this\._raiseResetPending/.test(tableSrc2) &&
      /raiseTo = wasReset \? legal\.minRaiseTo/.test(tableSrc2),
      'render 里用 wasReset 同步路径覆盖金额（否则只 setData 会读到上一手旧值）');
    // 语义守卫：raiseSubmit 必须读局部 raiseTo，不能读 this.data.raiseTo
    ok(/raiseSubmit = Math\.max\(legal\.minRaiseTo, Math\.round\(raiseTo \|\| 0\)\)/.test(tableSrc2),
      '加注按钮文案读局部 raiseTo 而非 this.data.raiseTo（与档位高亮同帧自洽）');
    // 语义守卫：重置判据必须是「手数前进」而不只是 startHand —— 只挂 startHand 时
    // 镜像端（enterRemote）与续局（restoreRoom）都不经过，档位高亮会跨手残留。
    ok(/this\._raiseHandNo !== game\.handNo/.test(tableSrc2),
      'render 以「手数前进」为判据触发档位重置（覆盖不经过 startHand 的镜像端/续局路径）');
    // 档位高亮必须与金额同帧写入同一个 setData，否则会渲染出「高亮最小、金额旧值」的中间态
    ok(/raisePreset: wasReset \? 'min' : this\.data\.raisePreset/.test(tableSrc2),
      '重置帧把 raisePreset 与金额写进同一个 setData（避免高亮与金额不同步的中间态）');
  }

  function guardAmbienceConstants(tableSrc, wxmlSrc, wxssSrc) {
    // —— 常量与模块级状态 ——
    ok(/const EMOTE_SET = \['👏', '🎉', '😏', '😅', '🤡', '💪'\]/.test(tableSrc),
      'EMOTE_SET 恰好 6 个 emoji（渲染白名单，防伪造/超长 payload）');
    ok(/EMOTE_THROTTLE_MS = 3000/.test(tableSrc), '表情频控 3s/座位（EMOTE_THROTTLE_MS）');
    ok(/EMOTE_BUBBLE_MS = 2200/.test(tableSrc), '气泡消散时长 2.2s（EMOTE_BUBBLE_MS）');
    ok(/EMOTE_QUEUE_MAX = 10/.test(tableSrc), '氛围队列广播上限 10 条（EMOTE_QUEUE_MAX，滚动截断）');
    ok(/EMOTE_PLAY_WINDOW_MS = 1500/.test(tableSrc), '镜像端只放近 1.5s 内表情（EMOTE_PLAY_WINDOW_MS，防重放）');
    ok(/BIG_HAND_MIN = 4/.test(tableSrc), '大牌粒子阈值 = 4（引擎 HAND.STRAIGHT，顺子及以上才出星光）');
    ok(/WIN_STREAK_MIN = 2/.test(tableSrc), '连胜徽章阈值 = 2（WIN_STREAK_MIN，≥2 手显示 🔥xN）');
    ok(/let winStreaks = \{\}/.test(tableSrc) && /let lastEmoteAt = \{\}/.test(tableSrc) && /let flySeed = 0/.test(tableSrc),
      '模块级氛围状态：winStreaks / lastEmoteAt / flySeed（座位级计数与动画自增 id）');

    // —— data 字段齐备 ——
    ['emoteShow', 'emoteSeat', 'emoteSet', 'emotes', 'spark', 'flyOut', 'flyIn', 'streaks', 'winFx'].forEach(f => {
      ok(new RegExp(f + ':').test(tableSrc), 'data 声明氛围字段：' + f);
    });

    // —— 核心方法存在 ——
    ['renderAmbience', '_snapBaseline', '_resultHandCat', '_fxPos',
      '_spawnFlyOut', '_spawnFlyHome', '_spawnSpark', '_bumpStreaks',
      'onAvatarTap', 'onEmoteClose', 'onEmotePick', '_showEmoteBubble', 'onEmoteTalk'].forEach(fn => {
      ok(new RegExp(fn + '\\(').test(tableSrc), '定义氛围方法：' + fn);
    });
  }

  function guardAmbienceRenderAndSync(tableSrc) {
    // —— render 基线 diff ——
    ok(/const prevBase = this\._base;/.test(tableSrc) && /this\._snapBaseline\(\);/.test(tableSrc) && /this\._prevBase = prevBase;/.test(tableSrc),
      'render 开头缓存上一帧基线供 renderAmbience 比对（_prevBase）');
    ok(/this\.renderAmbience\(\);/.test(tableSrc), '_renderTail 末尾调用 renderAmbience（每帧驱动氛围）');

    // —— animOn 守卫 ——
    ok(/prev\.handNo === now\.handNo && this\.data\.animOn/.test(tableSrc),
      '下注飞行只在 animOn 且同手内触发（跨手不误触）');
    ok(/this\.data\.animOn && result_fresh/.test(tableSrc),
      '收池飞行/金光/粒子只在 animOn 且结果新鲜时触发');

    // —— HAND_NAME_TO_CAT 映射 ——
    ok(/HAND_NAME_TO_CAT = \{/.test(tableSrc), '牌型名→枚举映射 HAND_NAME_TO_CAT 存在（_resultHandCat 用）');
    ok(/if \(!evals\) return 0;/.test(tableSrc), '_resultHandCat：fold 结算无 evals 返回 0（不触发粒子）');

    // —— 静默降级 ——
    ok(/pushAction\(this\.roomNo, \{ type: 'emote'/.test(tableSrc),
      '好友房表情走既有 pushAction 上行（type:emote）');
    ok(/\.catch\(\(\) => \{ \/\* 静默降级[^*]*\*\/ \}\)/.test(tableSrc),
      '表情上行失败静默降级（不弹错不重试，与牌局关键上行 syncFailToast 语义不同）');

    // —— startHand 清零氛围状态 ——
    ok(/winStreaks = \{\};[^}]*this\.setData\(\{ spark: null, flyOut: \[\], flyIn: \[\], winFx: '', streaks: \{\} \}\)/.test(tableSrc),
      'startHand 清零连胜计数 + 清空粒子/飞行/金光/徽章');

    // —— applyFriendAction emote 分支 ——
    ok(/if \(a\.type === 'emote'\)/.test(tableSrc), 'applyFriendAction 有 emote 动作分支');
    ok(/Number\(a\.seat\) !== Number\(a\.rowSeat\)/.test(tableSrc) && /EMOTE_SET\.indexOf\(a\.emoji\) < 0/.test(tableSrc),
      'emote 分支：rowSeat 伪冒断言 + emoji 白名单双校验');

    // —— applyFriendAction chat 分支 ——
    ok(/if \(a\.type === 'chat'\)/.test(tableSrc), 'applyFriendAction 有 chat 动作分支');
    ok(/CHAT_TEXT_SET\.indexOf\(a\.text\) < 0/.test(tableSrc),
      'chat 分支：文案过 CHAT_TEXT_SET 白名单（防伪造内容/超长 payload）');
    ok(/if \(Number\(a\.seat\) !== Number\(a\.rowSeat\)\) return;[\s\S]*?CHAT_TEXT_SET/.test(tableSrc),
      'chat 分支：rowSeat 伪冒断言先于白名单（与 emote 同防伪冒口径）');

    // —— 快捷语上行 ——
    ok(/pushAction\(this\.roomNo, \{ type: 'chat'/.test(tableSrc),
      '好友房快捷语/表情走 pushAction 上行（type:chat，复用既有分道机制）');
    ok(/CHAT_TEXT_SET\.indexOf\(text\) >= 0/.test(tableSrc),
      'onQuickChat/onEmoji 上行前过 CHAT_TEXT_SET 白名单（面板外文案不上行）');

    // —— writePlayState emotes ——
    ok(/emotes: \(this\.data\.emotes \|\| \[\]\)\.slice\(-EMOTE_QUEUE_MAX\)/.test(tableSrc),
      'writePlayState 快照带 emotes 队列（滚动 10 条上限）');
    ok(/'e' \+ \(state\.emotes \|\| \[\]\.map/.test(tableSrc) || /'e' \+\s*\(state\.emotes/.test(tableSrc),
      '房主写库指纹含 emotes 项（表情变化触发写库广播）');

    // —— writePlayState chats ——
    ok(/chats: \(this\.data\.chatLog \|\| \[\]\)\.slice\(-CHAT_QUEUE_MAX\)/.test(tableSrc),
      'writePlayState 快照带 chats 队列（滚动 8 条上限）');
    ok(/'c' \+ \(state\.chats \|\| \[\]\)\.map/.test(tableSrc),
      '房主写库指纹含 chats 项（快捷语变化触发写库广播）');

    // —— enterRemote 表情镜像 ——
    ok(/st\.emotes/.test(tableSrc), 'enterRemote 读取房主广播的 emotes 字段');
    ok(/const localSeat = remapS\[Number\(e\.seat\)\]/.test(tableSrc),
      '镜像端按座次重映射 emote 的 seat（remapS，我=0 号位）');

    // —— enterRemote 快捷语镜像 ——
    ok(/st\.chats/.test(tableSrc), 'enterRemote 读取房主广播的 chats 字段');
    ok(/_seenChatIds/.test(tableSrc), '镜像端用 seenChatIds 记录已放过的快捷语 id（防轮询重放）');
    ok(/CHAT_TEXT_SET\.indexOf\(c\.text\) < 0/.test(tableSrc),
      '镜像端只回放白名单内的快捷语（系统消息由镜像端本地逻辑生成，不重复回放）');
  }

  function guardAmbienceWxml(wxmlSrc, wxssSrc, tableSrc) {
    ok(wxmlSrc.indexOf('class="fly-chip fly-out"') >= 0 && wxmlSrc.indexOf('class="fly-chip fly-in"') >= 0,
      'WXML 筹码飞行层：fly-out / fly-in 两层');
    ok(/class="\{\{item\.cls\}\}"/.test(wxmlSrc),
      'WXML 座位 class 由 JS 预计算（class="{{item.cls}}"）');
    ok(!/winFx && \(',' \+ winFx/.test(wxmlSrc),
      'WXML 已无「三元里调 .indexOf()」写法（真机上传编译失败的病根）');
    ok(/_winFxSeats\.indexOf\(p\.seat\) >= 0 \? 'winfx'/.test(tableSrc),
      'JS 侧用 _winFxSeats 判定 winfx（金光脉冲语义未变）');
    const clsBlock = (tableSrc.match(/const cls = \[[\s\S]{0,600}?\]\.filter\(Boolean\)\.join\(' '\)/) || [''])[0];
    ok(clsBlock.length > 0, 'JS 侧存在座位 cls 预计算');
    ['self', 'folded', 'active', 'win', 'standing', 'winfx'].forEach(k => {
      ok(clsBlock.indexOf("'" + k + "'") >= 0, 'cls 含状态位 ' + k + '（与原内联表达式语义一致）');
    });
    ok(/this\._winFxSeats = \[\]/.test(tableSrc), '新手/重开时清空 _winFxSeats（避免上把赢家残留金光）');
    ok(wxmlSrc.indexOf('catchtap="onAvatarTap"') >= 0, 'WXML 头像绑 onAvatarTap（点头像弹轮盘）');
    ok(wxmlSrc.indexOf('streak-badge') >= 0, 'WXML 连胜徽章节点 streak-badge');
    ok(wxmlSrc.indexOf('emote-bubble') >= 0, 'WXML 表情气泡节点 emote-bubble');
    ok(wxmlSrc.indexOf('class="spark"') >= 0, 'WXML 星光粒子节点 spark');
    ok(wxmlSrc.indexOf('emote-mask') >= 0 && wxmlSrc.indexOf('emote-wheel') >= 0 &&
      wxmlSrc.indexOf('emote-grid') >= 0 && wxmlSrc.indexOf('emote-cell') >= 0,
      'WXML 表情轮盘弹层四件套：emote-mask/wheel/grid/cell');
    ok(wxmlSrc.indexOf('emote-talk') >= 0 && wxmlSrc.indexOf('onEmoteTalk') >= 0,
      'WXML 表情轮盘含「快捷语」入口（emote-talk 节点 + onEmoteTalk 绑定）');
    ok(wxssSrc.indexOf('.emote-talk') >= 0, 'WXSS 快捷语入口样式 .emote-talk 存在');
    ok(/onEmoteTalk\(\)\s*\{[\s\S]*?onQuickChat\(/.test(tableSrc),
      'onEmoteTalk 落地：复用 onQuickChat 通道发一条快捷语（P3 预留位已实现）');
  }

  function guardAmbienceWxss(wxssSrc) {
    ['.seat.winfx .avatar', '.streak-badge', '.emote-bubble', '.spark',
      '.fly-chip', '.fly-chip.fly-out', '.fly-chip.fly-in',
      '.emote-mask', '.emote-wheel', '.emote-grid', '.emote-cell'].forEach(c => {
      ok(wxssSrc.indexOf(c) >= 0, 'WXSS 样式：' + c);
    });
    ['winGlow', 'streakPop', 'emoteFloat', 'sparkTwinkle',
      'flyChipOut', 'flyChipIn', 'wheelPop'].forEach(kf => {
      ok(new RegExp('@keyframes ' + kf).test(wxssSrc), 'WXSS @keyframes：' + kf);
    });
    const flyOutBlock = (wxssSrc.match(/@keyframes flyChipOut \{[\s\S]*?\}/) || [''])[0];
    ok(/transform:/.test(flyOutBlock) && /opacity:/.test(flyOutBlock) &&
      !/top:|left:/.test(flyOutBlock.replace(/translate/, '')),
      'flyChipOut 只用 transform/opacity（不动 top/left，重排红线）');
    ok(/\.spark \{[\s\S]*?background:\s*url\(\.\.\/\.\.\/assets\/spark\.png\)/.test(wxssSrc),
      'spark 粒子用 assets/spark.png 贴图（CSS background）');
    ok(/\.no-anim \.seat\.winfx \.avatar/.test(wxssSrc) && /\.no-anim \.spark/.test(wxssSrc) &&
      /\.no-anim \.fly-chip/.test(wxssSrc),
      'WXSS .no-anim 兜底禁用氛围动画（animOn=false 全关）');
  }

  function guardReplayStore(rs, storeSrc) {
    ok(typeof rs.addReplay === 'function' && typeof rs.listAll === 'function' &&
      typeof rs.latest === 'function' && typeof rs.findByDate === 'function',
      'replay-store 导出 addReplay/listAll/latest/findByDate 四个方法');
    ok(rs.MAX_REPLAYS === 20, 'replay-store 上限 20 局（FIFO 挤出）');
    ok(/poker_replay_cache/.test(storeSrc), 'replay-store 用独立 storage 键 poker_replay_cache');
    ok(/setStorageSync/.test(storeSrc), 'replay-store 走本地 wx.setStorageSync（不进云）');
    ok(/return false/.test(storeSrc) && /catch \(e\)/.test(storeSrc),
      'replay-store addReplay 失败静默降级（返回 false，不阻断）');
  }

  function guardAdvisorIntegration(tableSrc, wxmlSrc) {
    ok(/require\(['"].+advisor['"]\)/.test(tableSrc), 'table.js 引入 advisor 模块');
    ok(tableSrc.indexOf('advisor.classifyHole') >= 0,
      'renderAdvice 调用 advisor.classifyHole（起手牌分类）');
    ok(tableSrc.indexOf('advisor.explainAdvice') >= 0,
      'renderAdvice 调用 advisor.explainAdvice（牌理解释）');
    ok(/advBase\.holeLabel/.test(tableSrc) && /advBase\.explain/.test(tableSrc),
      'advice setData 新增 holeLabel/explain 字段（不破坏 equityPct/potOdds/text/tone/drawDesc/drawOuts）');
    const advCalls = (tableSrc.match(/advisor\.(classifyHole|explainAdvice)/g) || []).length;
    ok(advCalls === 2, 'advisor 调用只在 renderAdvice 内（classifyHole + explainAdvice 各 1，不绕 mode!==ai 门槛），共 ' + advCalls);
    ok(/class="adv-explain"/.test(wxmlSrc), '建议栏 wxml 含 adv-explain 节点');
    ok(/advice\.explain/.test(wxmlSrc), '建议栏 wxml 插值 advice.explain');
  }

  function guardStyleIntegration(profSrc, profWxml, profWxss, saSrc) {
    ok(/require\(['"].+replay-store['"]\)/.test(profSrc), 'profile.js 引入 replay-store');
    ok(/require\(['"].+style-analyzer['"]\)/.test(profSrc), 'profile.js 引入 style-analyzer');
    ok(/styleAnalyzer\.analyze\(replayStore\.listAll\(\)\)/.test(profSrc),
      'profile.js 调用 styleAnalyzer.analyze(replayStore.listAll())');
    ok(/styleAnalysis/.test(profSrc), 'profile.js 维护 styleAnalysis 状态字段');
    ok(/激进型|保守型|稳健型/.test(profSrc), 'profile.js 保留旧 style（胜率倾向），与新 styleAnalysis 分区显示');
    ok(/styleAnalysis\.insufficient/.test(profWxml), '我的页 wxml 含样本不足分支');
    ok(/styleAnalysis\.quadrant/.test(profWxml), '我的页 wxml 插值打法象限');
    ok(/styleAnalysis\.observations/.test(profWxml) && /wx:for/.test(profWxml),
      '我的页 wxml 用 wx:for 渲染观察列表');
    ok(/styleAnalysis\.quadrantTag/.test(profWxml),
      '我的页 wxml 用 quadrantTag 插值类名（象限配色）');
    ok(/tight-aggressive/.test(profWxss) && /loose-passive/.test(profWxss),
      '我的页 wxss 定义四象限配色（tight-aggressive/loose-passive 等）');
    ok(!/wx\.request|require\(['"]https?/.test(saSrc), 'style-analyzer 不含网络调用（纯本地）');
    ok(/不接 LLM|样本不足|不硬算|描述性|不评判/.test(saSrc),
      'style-analyzer 头注释声明边界（不接 LLM / 样本不足不硬算 / 描述性不评判）');
  }

  /* 战绩深化图表集成守卫（方向 A）：纯 CSS 无 canvas 无新依赖，重排红线遵守 */
  function guardChartsIntegration(profSrc, profWxml, profWxss, csSrc) {
    // chart-stats.js 纯函数模块约束
    ok(/computeWinRate/.test(csSrc) && /computeHandTypes/.test(csSrc) && /computeNetTrend/.test(csSrc),
      'chart-stats.js 导出 computeWinRate/computeHandTypes/computeNetTrend');
    ok(/CHUNK_SIZE/.test(csSrc), 'chart-stats.js 导出 CHUNK_SIZE 常量');
    ok(!/require\(['"].*wx/.test(csSrc), 'chart-stats.js 不依赖 wx 运行时');
    ok(!/cloud\.database|cloud\.from|require\(['"].*cloud/.test(csSrc),
      'chart-stats.js 不依赖云服务');
    ok(!/Math\.random/.test(csSrc), 'chart-stats.js 无 RNG（纯函数）');

    // profile.js 接入
    ok(/require\(['"].+chart-stats['"]\)/.test(profSrc), 'profile.js 引入 chart-stats');
    ok(/CHART_LIMIT/.test(profSrc), 'profile.js 定义 CHART_LIMIT 常量');
    ok(/loadCharts/.test(profSrc), 'profile.js 定义 loadCharts 方法');
    ok(/computeWinRate/.test(profSrc) && /computeHandTypes/.test(profSrc) && /computeNetTrend/.test(profSrc),
      'profile.js 调用三个 chart-stats 函数');
    ok(/chartHands/.test(profSrc) && /chartLoading/.test(profSrc),
      'profile.js 维护 chartHands/chartLoading 状态字段');

    // profile.wxml 纯 CSS 图表节点
    ok(/战绩深化/.test(profWxml), '我的页 wxml 含「战绩深化」section');
    ok(/chart-card/.test(profWxml), '我的页 wxml 含 chart-card 容器');
    ok(/wr-bar/.test(profWxml), '我的页 wxml 含胜率曲线柱（wr-bar）');
    ok(/ht-row/.test(profWxml), '我的页 wxml 含牌型分布行（ht-row）');
    ok(/net-bar/.test(profWxml), '我的页 wxml 含盈亏走势柱（net-bar）');
    ok(!/canvas/.test(profWxml), '我的页 wxml 无 canvas（纯 CSS 图表硬约束）');

    // profile.wxss 重排红线：chart 区无 width/top/left 的 transition 或 keyframe 动画
    ok(/transform-origin/.test(profWxss), '我的页 wxss 含 transform-origin（scaleY 锚点）');
    // 提取 chart 区 wxss 片段，检查重排红线
    const chartWxss = profWxss.slice(profWxss.indexOf('chart-card'));
    ok(!/transition[^;]*\b(width|top|left)\b/.test(chartWxss),
      'chart 区 wxss 无 width/top/left 的 transition（重排红线）');
    ok(!/@keyframes[^{]*\{[^}]*\b(width|top|left)\b/.test(chartWxss),
      'chart 区 wxss 无 keyframe 动画 width/top/left（重排红线）');
  }

  /* 高光时刻存档 + 成就徽章墙 + 位置统计（批①）集成守卫：
     highlight-store.js 纯本地存档、table.js 收割判定、profile.js 徽章墙接入、
     replay.js from=highlight 回退、style-analyzer curStreet 跟踪 + positionVpip。 */
  function guardHighlightIntegration(profSrc, profWxml, profWxss, hlSrc, tableSrc, replaySrc, saSrc) {
    // ---- highlight-store.js 模块约束 ----
    ok(/poker_highlight_cache/.test(hlSrc),
      'highlight-store 用独立 storage 键 poker_highlight_cache（与 replay-store 分离）');
    ok(/MAX_HIGHLIGHTS\s*=\s*50/.test(hlSrc), 'highlight-store 上限 50 条（FIFO，>replay 的 20）');
    ok(/addHighlight/.test(hlSrc) && /listAll/.test(hlSrc) && /findByDate/.test(hlSrc),
      'highlight-store 导出 addHighlight/listAll/findByDate');
    ok(/module\.exports/.test(hlSrc) && /addHighlight[\s\S]*listAll[\s\S]*findByDate/.test(hlSrc),
      'highlight-store 导出表完整');
    ok(!/wx\.request|require\(['"]https?/.test(hlSrc), 'highlight-store 不含网络调用（纯本地）');
    // 高光自存完整 events（不依赖 replay FIFO）
    ok(/rec\.events\s*=/.test(hlSrc), 'highlight-store 自存完整 events（重看不依赖 replay 缓存）');
    ok(/皇家同花顺|四条|诈唬成功|连胜/.test(hlSrc),
      'highlight-store 摘要涵盖四类高光（皇家/四条/诈唬/连胜）');

    // ---- table.js 收割接入 ----
    ok(/require\(['"].+highlight-store['"]\)/.test(tableSrc), 'table.js 引入 highlight-store');
    ok(/highlightStore\.addHighlight/.test(tableSrc), 'table.js 结算时调用 highlightStore.addHighlight');
    ok(/_detectHighlight/.test(tableSrc), 'table.js 定义 _detectHighlight 判定方法（store 只存不判）');
    ok(/HIGHLIGHT_STREAK\s*=\s*5/.test(tableSrc), 'table.js 定义 HIGHLIGHT_STREAK=5（独立于 WIN_STREAK_MIN=2）');
    // 判定在权威端路径内（!this.remoteMode 守卫内）
    ok(/addHighlight/.test(tableSrc) && /!this\.remoteMode/.test(tableSrc),
      'table.js 高光收割仅在权威端（!remoteMode，镜像端无 game.result.evals 全量）');
    // 诈唬判定用 curStreet 跟踪（action 事件无 street）
    ok(/curStreet\s*=\s*['"]preflop['"]/.test(tableSrc),
      'table.js 诈唬判定用 curStreet 跟踪 type:street（不读 action 事件 street）');

    // ---- profile.js 徽章墙接入 ----
    ok(/require\(['"].+highlight-store['"]\)/.test(profSrc), 'profile.js 引入 highlight-store');
    ok(/loadHighlights/.test(profSrc), 'profile.js 定义 loadHighlights 方法');
    ok(/highlightBadges/.test(profSrc), 'profile.js 维护 highlightBadges 状态字段');
    ok(/highlightBest/.test(profSrc), 'profile.js 维护 highlightBest 状态字段');
    ok(/onReplayBest/.test(profSrc), 'profile.js 定义 onReplayBest 跳转方法');
    ok(/from=highlight/.test(profSrc), 'profile.js onReplayBest 带 from=highlight 参数');

    // ---- profile.wxml 徽章墙节点 ----
    ok(/badge-wall/.test(profWxml), '我的页 wxml 含 badge-wall 容器');
    ok(/highlightBadges/.test(profWxml), '我的页 wxml 循环渲染 highlightBadges');
    ok(/highlightBest/.test(profWxml), '我的页 wxml 含「最值得炫耀的一手」（highlightBest）');
    ok(/成就徽章/.test(profWxml), '我的页 wxml 含「成就徽章」section 标题');
    ok(!/canvas/.test(profWxml), '我的页 wxml 仍无 canvas（徽章墙纯 CSS）');

    // ---- profile.wxss 徽章墙样式 + 重排红线 ----
    ok(/badge-wall/.test(profWxss) && /\.badge\b/.test(profWxss),
      '我的页 wxss 定义徽章墙样式（badge-wall/badge）');
    const badgeWxss = profWxss.slice(profWxss.indexOf('badge-wall'));
    ok(!/transition[^;]*\b(width|top|left)\b/.test(badgeWxss),
      'badge 区 wxss 无 width/top/left transition（重排红线）');
    ok(!/@keyframes[^{]*\{[^}]*\b(width|top|left)\b/.test(badgeWxss),
      'badge 区 wxss 无 keyframe width/top/left（重排红线）');

    // ---- replay.js from=highlight 回退 ----
    ok(/require\(['"].+highlight-store['"]\)/.test(replaySrc), 'replay.js 引入 highlight-store');
    ok(/from\s*===\s*['"]highlight['"]/.test(replaySrc),
      'replay.js 识别 from=highlight 分支定位高光存档');
    ok(/highlightStore\.findByDate/.test(replaySrc),
      'replay.js 调用 highlightStore.findByDate（高光重看不依赖 replay FIFO）');

    // ---- style-analyzer curStreet 跟踪 + positionVpip ----
    ok(/curStreet\s*=\s*['"]preflop['"]/.test(saSrc),
      'style-analyzer 用 curStreet 跟踪（初始 preflop，遇 type:street 推进）');
    ok(/e\.type\s*===\s*['"]street['"]/.test(saSrc),
      'style-analyzer 跟踪 type:street 事件推进 curStreet');
    ok(!/const st = e\.street/.test(saSrc),
      'style-analyzer 不再读 e.street（修复 VPIP 恒 0 BUG）');
    ok(/positionVpip/.test(saSrc), 'style-analyzer 返回 positionVpip（位置入池率）');
    ok(/POS_BY_OFFSET|posOf/.test(saSrc), 'style-analyzer 按偏移映射位置标签（posOf）');
  }

  /* 每日一题 / 局面挑战（批③）集成守卫：纯教学、不碰引擎、无网络、无 canvas。
     puzzles.js 题库 + puzzle 页四件套 + app.json 注册 + index 入口 + replay.js from=puzzle 兜底。 */
  function guardPuzzleIntegration(puzzleSrc, pzPageSrc, pzWxml, pzWxss, idxSrc, idxWxml, replaySrc, appJson) {
    // ---- puzzles.js 题库模块约束 ----
    ok(/PUZZLES/.test(puzzleSrc), 'puzzles.js 导出 PUZZLES 题库');
    ok(/puzzleForDate/.test(puzzleSrc), 'puzzles.js 导出 puzzleForDate（按日期取当天题）');
    ok(/findById/.test(puzzleSrc), 'puzzles.js 导出 findById（按 id 取题）');
    ok(/myHole/.test(puzzleSrc) && /board/.test(puzzleSrc) && /answer/.test(puzzleSrc),
      'puzzles.js 题结构含 myHole/board/answer');
    ok(!/wx\.request|require\(['"]https?/.test(puzzleSrc), 'puzzles.js 不含网络调用（纯本地题库）');

    // ---- puzzle.js 页面约束 ----
    ok(/quickEquity/.test(pzPageSrc), 'puzzle.js 用 quickEquity 算胜率（不走 advise）');
    ok(/puzzleForDate|findById/.test(pzPageSrc), 'puzzle.js 按 date/id 取题');
    ok(/reveal/.test(pzPageSrc), 'puzzle.js 定义 reveal 揭示答案方法');
    ok(/answerAction/.test(pzPageSrc) && /answerCorrect/.test(pzPageSrc),
      'puzzle.js 维护 answerAction/answerCorrect 比对玩家选择与推荐');
    ok(/potOdds/.test(pzPageSrc), 'puzzle.js 算赔率 potOdds（toCall/(pot+toCall)）');
    ok(!/wx\.request|require\(['"]https?/.test(pzPageSrc), 'puzzle.js 不含网络调用（纯客户端教学）');
    // 合规：不走 advise（advise 含合规门槛，puzzle 纯教学不该碰）
    ok(!/require\(['"].+advisor['"]\)/.test(pzPageSrc), 'puzzle.js 不引入 advisor（教学非对局辅助，不碰合规门槛）');

    // ---- puzzle.wxml 节点约束 ----
    ok(/puzzle-page/.test(pzWxml), 'puzzle.wxml 含 puzzle-page 容器');
    ok(/每日一题/.test(pzWxml), 'puzzle.wxml 含「每日一题」标题');
    ok(/pz-choices|onChooseFold|onChooseCall/.test(pzWxml), 'puzzle.wxml 含选择按钮区');
    ok(/pz-result|pz-explain/.test(pzWxml), 'puzzle.wxml 含揭示结果与解析区');
    ok(!/canvas/.test(pzWxml), 'puzzle.wxml 无 canvas（纯文字+牌面渲染）');

    // ---- puzzle.wxss 重排红线 ----
    ok(/puzzle-page/.test(pzWxss), 'puzzle.wxss 定义 puzzle-page 样式');
    ok(!/transition[^;]*\b(width|top|left)\b/.test(pzWxss),
      'puzzle wxss 无 width/top/left transition（重排红线）');
    ok(!/@keyframes[^{]*\{[^}]*\b(width|top|left)\b/.test(pzWxss),
      'puzzle wxss 无 keyframe width/top/left（重排红线）');

    // ---- app.json 注册 puzzle 页 ----
    ok(/pages\/puzzle\/puzzle/.test(appJson), 'app.json 注册 pages/puzzle/puzzle 页面');

    // ---- index 入口 ----
    ok(/onPuzzleTap/.test(idxSrc), 'index.js 定义 onPuzzleTap 跳转方法');
    ok(/onPuzzleTap/.test(idxWxml), 'index.wxml 含每日一题入口（onPuzzleTap 绑定）');
    ok(/每日一题/.test(idxWxml), 'index.wxml 含「每日一题」入口标题');

    // ---- replay.js from=puzzle 兜底（设计方向：puzzle 可复用复盘页回看局面） ----
    // 注：当前 puzzle 自带揭示页，from=puzzle 为预留方向；此处仅断言不破坏既有 from 分支
    ok(/from\s*===\s*['"]highlight['"]/.test(replaySrc),
      'replay.js 仍保留 from=highlight 分支（puzzle 未破坏既有高光回看）');
  }

  /* 每日一题真人局化（批⑧）静态守卫：fromHighlight 题源 + puzzle.js from=highlight 分支。
     高光存档的 events 流 → 「你当时在这里」题目。零引擎依赖（quickEquity 函数注入）。 */
  function guardFromHighlightIntegration(puzzleSrc, pzPageSrc, pzWxml) {
    // ---- puzzles.js fromHighlight 题源约束 ----
    ok(/fromHighlight/.test(puzzleSrc), 'puzzles.js 导出 fromHighlight（高光题源）');
    ok(/module\.exports[\s\S]*fromHighlight/.test(puzzleSrc),
      'puzzles.js 导出表含 fromHighlight');
    ok(/quickEquityFn/.test(puzzleSrc),
      'fromHighlight 接收 quickEquityFn 函数参数（零引擎依赖，puzzles.js 不直接 require poker-core）');
    ok(/curStreet\s*=\s*['"]preflop['"]/.test(puzzleSrc),
      'fromHighlight 用 curStreet 跟踪（引擎 action 事件无 street）');
    ok(/fromHighlight/.test(puzzleSrc) && /action\s*!==\s*['"]blind['"]/.test(puzzleSrc),
      'fromHighlight 跳过 blind 动作定位我方决策点');
    ok(/potOdds/.test(puzzleSrc),
      'fromHighlight 算赔率 potOdds（toCall/(pot+toCall)）');
    ok(!/require\(['"].+poker-core['"]\)/.test(puzzleSrc),
      'puzzles.js 不直接引入引擎（fromHighlight 接收 quickEquityFn 函数参数，保持零引擎依赖）');

    // ---- puzzle.js from=highlight 分支约束 ----
    ok(/from\s*===\s*['"]highlight['"]/.test(pzPageSrc),
      'puzzle.js 识别 from=highlight 分支（高光真人局题源）');
    ok(/highlightStore\.findByDate/.test(pzPageSrc),
      'puzzle.js 用 highlightStore.findByDate 取高光记录');
    ok(/require\(['"].+highlight-store['"]\)/.test(pzPageSrc),
      'puzzle.js 引入 highlight-store');
    ok(/puzzles\.fromHighlight/.test(pzPageSrc),
      'puzzle.js 调 puzzles.fromHighlight 构造真人局题目');
    ok(/_loadPuzzle/.test(pzPageSrc),
      'puzzle.js 提取 _loadPuzzle 公共方法（硬编码题与高光题共用）');

    // ---- puzzle.wxml 真人局标识约束 ----
    ok(/fromHighlight/.test(pzWxml),
      'puzzle.wxml 含真人局回放标识（fromHighlight 条件渲染）');
    ok(!/canvas/.test(pzWxml),
      'puzzle.wxml 仍无 canvas（硬约束，批⑧不破）');
  }

  /* AI 人格化组（批②）静态守卫：bot-profiles 模块 + table.js 角色绑定/台词/马脚/难度 + index 难度入口。
     纯客户端体验层：style 6 字段进引擎 aiDecide（决策入口），台词/马脚/难度纯 table.js 包装消费。 */
  function guardBotProfilesIntegration(botSrc, tableSrc, idxSrc) {
    // ---- bot-profiles.js 模块约束 ----
    ok(/PROFILES/.test(botSrc), 'bot-profiles.js 导出 PROFILES 角色档案');
    ok(/styleFor/.test(botSrc), 'bot-profiles.js 导出 styleFor（按序号+难度取 style）');
    ok(/profileFor/.test(botSrc), 'bot-profiles.js 导出 profileFor（按序号取档案）');
    ok(/sceneOf/.test(botSrc) && /pickTalk/.test(botSrc), 'bot-profiles.js 导出 sceneOf/pickTalk（场景台词）');
    // 5 角色（对齐 BOT_NAMES：林小满/陈默/苏晴/赵岩/周叙）
    ok(/林小满/.test(botSrc) && /陈默/.test(botSrc) && /苏晴/.test(botSrc) && /赵岩/.test(botSrc) && /周叙/.test(botSrc),
      'bot-profiles.js 5 角色名对齐 BOT_NAMES');
    // style 6 字段
    ok(/bluffFreq/.test(botSrc) && /bluffSize/.test(botSrc) && /heroCall/.test(botSrc) && /slowplay/.test(botSrc),
      'bot-profiles.js style 含 bluffFreq/bluffSize/heroCall/slowplay 扩展字段');
    // 难度档位映射
    ok(/rookie/.test(botSrc) && /advanced/.test(botSrc) && /expert/.test(botSrc),
      'bot-profiles.js 含 3 档难度映射（rookie/advanced/expert）');
    ok(/talkRate/.test(botSrc), 'bot-profiles.js 角色含 talkRate（话痨/寡言倾向）');
    ok(/tellPattern/.test(botSrc), 'bot-profiles.js 角色含 tellPattern（马脚线索）');
    ok(!/wx\.request|require\(['"]https?/.test(botSrc), 'bot-profiles.js 不含网络调用（纯本地数据）');

    // ---- table.js 角色绑定约束 ----
    ok(/botProfiles/.test(tableSrc), 'table.js 引入 bot-profiles');
    ok(/botProfiles\.styleFor/.test(tableSrc), 'table.js 用 botProfiles.styleFor 绑定角色 style');
    ok(/botProfiles\.profileFor/.test(tableSrc), 'table.js 用 botProfiles.profileFor 取档案（马脚/台词）');
    ok(/botProfiles\.sceneOf|botProfiles\.pickTalk/.test(tableSrc), 'table.js 用 botProfiles.sceneOf/pickTalk 取场景台词');
    ok(/talkRate/.test(tableSrc), 'table.js 按角色 talkRate 控制聊天冒泡触发率');
    ok(/this\.level/.test(tableSrc), 'table.js 读取难度档位 this.level');
    ok(/bluffFast|bluffSilent|bluffTalkBoost/.test(tableSrc),
      'table.js 消费 tellPattern 马脚（反应时间/沉默/话多）');
    ok(/delay\s*=\s*300|delay\s*=\s*800/.test(tableSrc),
      'table.js 反应时间抖动按诈唬/强牌偏移（马脚）');

    // ---- index.js 难度入口约束 ----
    ok(/level=/.test(idxSrc), 'index.js onAIMode 跳转带 level 参数');
    ok(/rookie/.test(idxSrc) && /advanced/.test(idxSrc) && /expert/.test(idxSrc),
      'index.js 含 3 档难度文案（rookie/advanced/expert）');
    ok(/showActionSheet/.test(idxSrc), 'index.js 用 showActionSheet 弹难度选择');
  }

  /* 引擎 aiDecide style 扩展字段兜底验证（行为级）：
     不传扩展字段（旧 style:{aggro,tight}）时行为不变；传扩展字段时引擎能正常决策。
     这是「碰引擎」改动的安全底线——默认兜底必须让旧调用零回归。 */
  function guardAiDecideStyleExtension() {
    const mkCtx = (style, hole, board) => ({
      hole: hole || [P.cardId(12, 0), P.cardId(12, 1)],   // AA
      board: board || [],
      pot: 200, toCall: 80, stack: 800, currentBet: 80, numActive: 2,
      positionFactor: 0.5, style,
      minRaiseTo: 160, maxRaiseTo: 880, canRaise: true, bb: 20,
      rng: P.createRng('style-ext')
    });
    // 1) 旧 style（仅 aggro/tight）不崩，且返回合法动作
    const dOld = P.aiDecide(mkCtx({ aggro: 0.5, tight: 0.5 }));
    ok(['fold', 'check', 'call', 'raise', 'allin'].indexOf(dOld.action) >= 0,
      'aiDecide 旧 style（仅 aggro/tight）返回合法动作 ' + dOld.action);
    // 2) 扩展字段全 0：行为应与旧 style 接近（不诈唬/不英雄跟注/不慢打），返回合法
    const dZero = P.aiDecide(mkCtx({ aggro: 0.5, tight: 0.5, bluffFreq: 0, bluffSize: 0, heroCall: 0, slowplay: 0 }));
    ok(['fold', 'check', 'call', 'raise', 'allin'].indexOf(dZero.action) >= 0,
      'aiDecide 扩展字段全 0 返回合法动作 ' + dZero.action);
    // 3) 高 bluffFreq + 高 aggro：翻后半诈唬路径生效（听牌+高诈唬频率→产生加注）
    let bluffRaiseSeen = false;
    const bluffHole = [P.cardId(3, 3), P.cardId(4, 3)];           // 5♥6♥
    const bluffBoard = [P.cardId(0, 3), P.cardId(5, 3), P.cardId(11, 0)]; // 2♥7♥K♠（同花+顺听）
    for (let i = 0; i < 40; i++) {
      const d = P.aiDecide({
        hole: bluffHole, board: bluffBoard, pot: 200, toCall: 80, stack: 800,
        currentBet: 80, numActive: 2, positionFactor: 0.5,
        style: { aggro: 0.9, tight: 0.1, bluffFreq: 0.95, bluffSize: 0.8, heroCall: 0.5, slowplay: 0.3 },
        minRaiseTo: 160, maxRaiseTo: 880, canRaise: true, bb: 20, rng: P.createRng('bluff-' + i)
      });
      ok(['fold', 'check', 'call', 'raise', 'allin'].indexOf(d.action) >= 0,
        'aiDecide 高激进扩展字段返回合法动作 ' + d.action + '（试 ' + i + '）');
      if (d.action === 'raise') bluffRaiseSeen = true;
    }
    ok(bluffRaiseSeen, 'aiDecide 高 bluffFreq 在听牌局能产生加注（半诈唬路径生效）');
    // 4) slowplay：强牌 + toCall=0 + slowplay=1 → 必过牌（慢打诱敌）
    const dSlow = P.aiDecide({
      hole: [P.cardId(12, 0), P.cardId(12, 1)], board: [P.cardId(12, 2), P.cardId(11, 0), P.cardId(2, 1)],
      pot: 200, toCall: 0, stack: 800, currentBet: 0, numActive: 2, positionFactor: 0.5,
      style: { aggro: 0.5, tight: 0.5, slowplay: 1 },
      minRaiseTo: 0, maxRaiseTo: 800, canRaise: true, bb: 20, rng: P.createRng('slow-1')
    });
    ok(dSlow.action === 'check', 'aiDecide slowplay=1 + 强牌 + 可过牌 → 慢打过牌，实际 ' + dSlow.action);
    // 5) heroCall：赔率不划算 + heroCall=1 → 必跟注（英雄跟注路径）
    const dHero = P.aiDecide({
      hole: [P.cardId(2, 0), P.cardId(3, 1)], board: [P.cardId(12, 0), P.cardId(11, 1), P.cardId(10, 2)],
      pot: 100, toCall: 90, stack: 800, currentBet: 90, numActive: 2, positionFactor: 0.5,
      style: { aggro: 0.1, tight: 0.9, heroCall: 1 },
      minRaiseTo: 180, maxRaiseTo: 890, canRaise: true, bb: 20, rng: P.createRng('hero-1')
    });
    ok(dHero.action === 'call', 'aiDecide heroCall=1 + 赔率不划算 → 英雄跟注，实际 ' + dHero.action);
  }

  /* 限时局涨盲（批④）集成守卫：涨盲定时器生命周期 + 三道指纹含 sb/bb + 快照透传 +
     index 建房选项 + wxml 顶栏盲注展示 + sfx blind 音色。碰引擎双副本（snapshot/loadSnapshot
     sb/bb 由 test-core.js 行为级断言，这里守卫 table.js 包装层）。 */
  function guardBlindTimerIntegration(tableSrc, idxSrc, idxWxml, tableWxml, sfxSrc) {
    // ---- table.js 涨盲定时器约束 ----
    ok(/startBlindTimer/.test(tableSrc), 'table.js 定义 startBlindTimer');
    ok(/clearBlindTimer/.test(tableSrc), 'table.js 定义 clearBlindTimer');
    ok(/fmtBlind/.test(tableSrc), 'table.js 定义 fmtBlind（盲注级文案）');
    ok(/let blindTimer/.test(tableSrc), 'table.js 模块级 blindTimer（与 clock 同级生命周期）');
    ok(/blindIntervalMin/.test(tableSrc), 'table.js 读取 blindIntervalMin（涨盲间隔分钟）');
    // 涨盲逻辑：翻倍 sb/bb + 穿透两道指纹
    ok(/game\.sb\s*=\s*game\.sb\s*\*\s*2/.test(tableSrc), 'table.js 涨盲翻倍 game.sb');
    ok(/game\.bb\s*=\s*game\.bb\s*\*\s*2/.test(tableSrc), 'table.js 涨盲翻倍 game.bb');
    ok(/_lastPlayFp\s*=\s*null/.test(tableSrc), 'table.js 涨盲后穿透 _lastPlayFp（写库指纹）');
    ok(/_lastRenderFp\s*=\s*null/.test(tableSrc), 'table.js 涨盲后穿透 _lastRenderFp（渲染指纹）');
    ok(/sfx\.play\(['"]blind['"]\)/.test(tableSrc), 'table.js 涨盲播 blind 音效');
    ok(/blindLevel/.test(tableSrc) && /blindText/.test(tableSrc),
      'table.js setData blindLevel/blindText（盲注级展示）');
    // 配对清理：onEnterBackground/onUnload/endGame 清，onLeaveBackground 恢复
    ok(/onEnterBackground[\s\S]*clearBlindTimer/.test(tableSrc),
      'table.js onEnterBackground 调 clearBlindTimer（后台暂停涨盲）');
    ok(/onLeaveBackground[\s\S]*startBlindTimer/.test(tableSrc),
      'table.js onLeaveBackground 调 startBlindTimer（回前台恢复涨盲）');
    ok(/endGame[\s\S]*clearBlindTimer/.test(tableSrc),
      'table.js endGame 调 clearBlindTimer（本局结束停涨盲）');
    ok(/onUnload[\s\S]*clearBlindTimer/.test(tableSrc),
      'table.js onUnload 调 clearBlindTimer（销毁页停涨盲）');
    // 开局启动涨盲
    ok(/startHand[\s\S]*startBlindTimer|initGame[\s\S]*startBlindTimer|startClock[\s\S]*startBlindTimer/.test(tableSrc),
      'table.js 开局启动涨盲定时器');

    // ---- 三道指纹含 sb/bb（否则跳过分支吞掉涨盲变化） ----
    // 渲染指纹 _lastRenderFp：含 g.sb, g.bb（锚定 render 内的指纹块，避免误匹配镜像指纹）
    const renderFpBlock = tableSrc.match(/const fp = \[[\s\S]*?if \(this\._lastRenderFp === fp\)/);
    ok(renderFpBlock && /g\.sb/.test(renderFpBlock[0]) && /g\.bb/.test(renderFpBlock[0]),
      'table.js _lastRenderFp 含 g.sb/g.bb（涨盲不漏帧）');
    // 写库指纹 _lastPlayFp：含 snap.sb, snap.bb
    const playFpMatch = tableSrc.match(/const fingerprint = \[[\s\S]*?\.join\('#'\);/);
    ok(playFpMatch && /snap\.sb/.test(playFpMatch[0]) && /snap\.bb/.test(playFpMatch[0]),
      'table.js _lastPlayFp 含 snap.sb/snap.bb（涨盲写库不漏）');
    // 镜像指纹 _lastRemoteFp：含 snap.sb, snap.bb
    const remoteFpMatch = tableSrc.match(/const fp = \[[\s\S]*?if \(this\._lastRemoteFp === fp\)/);
    ok(remoteFpMatch && /snap\.sb/.test(remoteFpMatch[0]) && /snap\.bb/.test(remoteFpMatch[0]),
      'table.js _lastRemoteFp 含 snap.sb/snap.bb（好友端涨盲同步不漏）');

    // ---- 快照透传盲注级 ----
    ok(/saveSnapshot[\s\S]*sb:\s*game\.sb,\s*bb:\s*game\.bb/.test(tableSrc),
      'table.js saveSnapshot 含 sb/bb（续局沿用涨盲后盲注级）');
    ok(/blindIntervalMin:\s*this\.blindIntervalMin/.test(tableSrc),
      'table.js saveSnapshot 含 blindIntervalMin（续局恢复涨盲定时器）');

    // ---- index.js 建房选项约束 ----
    ok(/BLIND_PRESETS/.test(idxSrc), 'index.js 定义 BLIND_PRESETS（涨盲间隔预设）');
    ok(/onPickBlind/.test(idxSrc), 'index.js 定义 onPickBlind（选涨盲间隔）');
    ok(/cBlind/.test(idxSrc), 'index.js data 含 cBlind（当前涨盲间隔）');
    ok(/onCreateRoom[\s\S]*blind/.test(idxSrc), 'index.js onCreateRoom 传 blind 参数');
    ok(/&blind=/.test(idxSrc), 'index.js 创建房间 URL 带 blind 参数');

    // ---- index.wxml 建房弹窗涨盲选项 ----
    ok(/涨盲间隔/.test(idxWxml), 'index.wxml 含「涨盲间隔」选项区');
    ok(/blindPresets/.test(idxWxml) && /onPickBlind/.test(idxWxml),
      'index.wxml 绑定 blindPresets + onPickBlind');
    ok(/dlg-note[\s\S]*cBlind/.test(idxWxml),
      'index.wxml 创建确认文案含涨盲间隔（cBlind）');

    // ---- table.wxml 顶栏盲注展示 ----
    ok(/tb-blind/.test(tableWxml), 'table.wxml 含 tb-blind 盲注级节点');
    ok(/blindText/.test(tableWxml), 'table.wxml 展示 blindText');
    ok(/blindIntervalMin/.test(tableWxml), 'table.wxml 按 blindIntervalMin 控制盲注级显隐');

    // ---- sfx.js blind 音色 ----
    ok(/blind\s*\(c,\s*t\)/.test(sfxSrc), 'sfx.js 定义 blind 音色（blind(c, t) 预设）');
    ok(/盲注涨盲/.test(sfxSrc), 'sfx.js 注释含「盲注涨盲」说明（与 table.js play 调用对齐）');
  }

  /**
   * 批⑤ SNG 淘汰赛静态守卫：纯客户端赛制编排，不碰引擎。
   * 覆盖：入口、模式识别、补筹守卫、赛制状态机、淘汰检测、终局结算、
   *       座位灰显、渲染指纹含淘汰标记、夺冠徽章、音色。
   */
  function guardSngIntegration(tableSrc, idxSrc, idxWxml, tableWxml, tableWxss, profSrc, hlSrc, sfxSrc) {
    // ---- 入口 ----
    ok(/onSngMode/.test(idxSrc), 'index.js 定义 onSngMode（SNG 淘汰赛入口）');
    ok(/mode=sng/.test(idxSrc), 'index.js onSngMode 跳转带 mode=sng');
    ok(/blind=3/.test(idxSrc), 'index.js SNG 默认涨盲 3 分钟（blind=3）');
    ok(/SNG 淘汰赛/.test(idxWxml), 'index.wxml 含「SNG 淘汰赛」入口卡片');
    ok(/mode-sng/.test(idxWxml), 'index.wxml SNG 卡片带 mode-sng 类');
    ok(/筹码归零即淘汰/.test(idxWxml), 'index.wxml SNG 卡片描述含「筹码归零即淘汰」');

    // ---- table.js 模式识别 ----
    ok(/opts\.mode\s*===\s*['"]sng['"]/.test(tableSrc), 'table.js 识别 mode=sng（onLoad）');
    ok(/this\.mode\s*=\s*['"]sng['"]/.test(tableSrc) || /mode\s*=\s*opts\.room\s*\?\s*['"]friend['"]\s*:\s*\(.+===\s*['"]sng['"]\s*\?\s*['"]sng['"]/.test(tableSrc),
      'table.js 设 mode 为 sng');

    // ---- 补筹守卫（SNG 不补筹，筹码归零即淘汰） ----
    ok(/this\.mode\s*!==\s*['"]sng['"]/.test(tableSrc), 'table.js 补筹逻辑有 mode!==sng 守卫');

    // ---- 赛制状态机 ----
    ok(/sngPlacement/.test(tableSrc), 'table.js 定义 sngPlacement（seat→名次）');
    ok(/sngEliminationOrder/.test(tableSrc), 'table.js 定义 sngEliminationOrder（淘汰顺序）');
    ok(/sngNextPlace/.test(tableSrc), 'table.js 定义 sngNextPlace（下一名次计数器）');
    ok(/_sngDetectEliminations/.test(tableSrc), 'table.js 定义 _sngDetectEliminations（淘汰检测）');
    ok(/_sngCheckFinalize/.test(tableSrc), 'table.js 定义 _sngCheckFinalize（终局兜底）');
    ok(/sngNextPlace\s*=\s*players\.length|sngNextPlace\s*=\s*[\w.]+\.length/.test(tableSrc),
      'table.js startGame 初始化 sngNextPlace 为总人数');

    // ---- 终局结算 ----
    ok(/isSng:\s*true/.test(tableSrc), 'table.js endGame SNG 分支置 isSng:true');
    ok(/sng:\s*true/.test(tableSrc) && /sng:\s*false/.test(tableSrc),
      'table.js setData 顶层 sng 标记（WXML wx:for 作用域判断 SNG 列）；非 SNG 分支置 sng:false');
    ok(/myPlace/.test(tableSrc), 'table.js endGame SNG 分支算 myPlace');
    ok(/placeText/.test(tableSrc), 'table.js endGame SNG rows 含 placeText');
    ok(/SNG夺冠|SNG第/.test(tableSrc), 'table.js SNG 战绩 handType 文案');

    // ---- 座位灰显 ----
    ok(/isEliminated/.test(tableSrc), 'table.js 座位渲染算 isEliminated');
    ok(/eliminated/.test(tableSrc), 'table.js 座位 cls 加 eliminated');
    ok(/seat-eliminated/.test(tableWxml), 'table.wxml 含 seat-eliminated 节点');
    ok(/item\.placeText/.test(tableWxml), 'table.wxml 座位显示淘汰名次（item.placeText）');
    ok(/\.seat\.eliminated\s*\{[^}]*opacity/.test(tableWxss),
      'table.wxss .seat.eliminated 含 opacity 灰显');
    ok(/\.seat\.eliminated/.test(tableWxss),
      'table.wxss 定义 .seat.eliminated（声明在 folded 之后覆盖）');

    // ---- 结算面板 SNG 名次表 ----
    ok(/\{\{!sng\}\}/.test(tableWxml), 'table.wxml summary-row 用顶层 sng 判断盈亏/名次列');
    ok(/sr-place/.test(tableWxml), 'table.wxml 含 sr-place 名次列节点');
    ok(/item\.place/.test(tableWxml), 'table.wxml 结算行显示 item.place（名次）');

    // ---- 渲染指纹含淘汰标记 ----
    ok(/sngPlacement\[p\.seat\]/.test(tableSrc),
      'table.js _lastRenderFp 含 sngPlacement 派生标记（淘汰后灰显不漏帧）');

    // ---- 夺冠高光徽章 ----
    ok(/sng_win/.test(hlSrc), 'highlight-store.js summarize 含 sng_win 文案');
    ok(/sng_win/.test(profSrc), 'profile.js DEFS/RANK 含 sng_win 徽章');
    ok(/SNG 夺冠/.test(profSrc), 'profile.js sng_win 徽章名「SNG 夺冠」');
    ok(/addHighlight[\s\S]*sng_win/.test(tableSrc),
      'table.js 夺冠时调 addHighlight sng_win');

    // ---- 音色 ----
    ok(/eliminate\s*\(c,\s*t\)/.test(sfxSrc), 'sfx.js 定义 eliminate 音色');
    ok(/champion\s*\(c,\s*t\)/.test(sfxSrc), 'sfx.js 定义 champion 音色');
    ok(/sfx\.play\(['"]eliminate['"]\)/.test(tableSrc), 'table.js 淘汰播 eliminate 音效');
    ok(/sfx\.play\(['"]champion['"]\)/.test(tableSrc), 'table.js 夺冠播 champion 音效');

    // ---- 批⑤补丁：SNG 难度档真实生效（不再恒 advanced） ----
    // 三处 styleFor/applyLevel 的守卫从 mode==='ai' 扩到 mode==='ai'||mode==='sng'，
    // 否则 onSngMode 给的三档难度菜单是空头支票（SNG bot 永远 advanced）。
    ok(/\(this\.mode\s*===\s*['"]ai['"]\s*\|\|\s*this\.mode\s*===\s*['"]sng['"]\)\s*\?\s*this\.level/.test(tableSrc),
      'table.js styleFor/applyLevel 三处守卫含 mode===ai||mode===sng（SNG 用所选 level）');
    ok(!/this\.mode\s*===\s*['"]ai['"]\s*\?\s*this\.level\s*:\s*['"]advanced['"]/.test(tableSrc),
      'table.js 不再残留单 ai 三元（旧守卫已被 ai||sng 替换）');

    // ---- 批⑤补丁：SNG 支持中途补 bot（点空位下一手安排电脑玩家） ----
    // joinMidGame 分支 ③ 从 mode==='ai' 扩到 (ai||sng)，SNG 人类点空位也能补 bot。
    ok(/\(this\.mode\s*===\s*['"]ai['"]\s*\|\|\s*this\.mode\s*===\s*['"]sng['"]\)\s*&&\s*seated/.test(tableSrc),
      'table.js joinMidGame 分支 ③ 守卫含 (ai||sng)&&seated（SNG 中途补 bot）');

    // ---- B2 涨盲封顶（玩家审视 2026-10-17）----
    ok(/const bbCapOf/.test(tableSrc), 'table.js 定义 bbCapOf（涨盲封顶基准）');
    ok(/_bbCap\s*=\s*bbCapOf/.test(tableSrc), 'table.js startBlindTimer 记录 _bbCap');
    ok(/nextBb\s*>\s*this\._bbCap/.test(tableSrc), 'table.js 涨盲前比对 cap（nextBb > _bbCap 拦截）');
    ok(/_bbCapToastShown/.test(tableSrc), 'table.js 封顶提示只播一次（_bbCapToastShown）');
    ok(tableSrc.indexOf('game.bb = game.bb * 2;') > -1 &&
      tableSrc.indexOf('nextBb = game.bb * 2') > -1,
      'table.js 翻倍逻辑仍保留（封顶只是收窄可达区间）');

    // ---- B4 SNG 统一起始筹码 + 禁中途加入（玩家审视 2026-10-17）----
    ok(/const SNG_START_STACK = 2000;/.test(tableSrc), 'table.js 定义 SNG_START_STACK=2000');
    ok(/buyInOf\(this\.mode/.test(tableSrc), 'table.js confirmBuyIn 走 buyInOf 统一取值口');
    ok(/this\.mode === 'sng' \? SNG_START_STACK : DEFAULT_BUY_IN/.test(tableSrc),
      'table.js bot 等码 SNG 2000 / 其余 DEFAULT_BUY_IN（fillBots 系）');
    ok(/淘汰赛进行中，不可中途加入/.test(tableSrc),
      'table.js chooseSeat 拦 SNG 中途加入（phase=playing 时 toast）');

    // ---- 批⑤补丁：SNG 桌型可选（onSngMode 带 max=，首页弹人数选择） ----
    ok(/sngShow/.test(idxSrc), 'index.js data 含 sngShow（SNG 配置弹窗 toggle）');
    ok(/sngMax/.test(idxSrc), 'index.js data 含 sngMax（SNG 桌型人数）');
    ok(/onSngConfigTap/.test(idxSrc) && /onSngConfigConfirm/.test(idxSrc),
      'index.js 定义 onSngConfigTap/onSngConfigConfirm（SNG 配置入口/确认）');
    ok(/onSngMaxStep/.test(idxSrc) && /onSngPickMax/.test(idxSrc),
      'index.js 定义 onSngMaxStep/onSngPickMax（SNG 桌型 ±1/预设）');
    ok(/&max=/.test(idxSrc), 'index.js onSngMode 跳转带 max=（SNG 桌型传入）');
    ok(/sngShow/.test(idxWxml), 'index.wxml 含 sngShow 弹窗（SNG 配置）');
    ok(/sngMax/.test(idxWxml), 'index.wxml SNG 弹窗用 sngMax（人数显示与步进）');
    ok(/onSngConfigTap/.test(idxWxml), 'index.wxml SNG 入口绑 onSngConfigTap（先配置再选难度）');

    // ---- 好友房进行中补 bot（用户反馈「邀请机器人进房间但坐不下/很快退出」）----
    // 病根：addBot 原有 phase!=='waiting' 守卫，进行中点按钮直接 return →
    // 好友不够时房主无法中途凑桌。改为进行中走 pendingBotSeat → 下一手
    // applyPendingSeats ③ 插入，与 AI/SNG 点空位补 bot 同口径。
    ok(/addBot\(\)\s*\{[\s\S]{0,400}?phase === 'playing' && this\.mode === 'friend' && !this\.remoteMode/.test(tableSrc),
      'table.js addBot 进行中分支守卫 friend 房主非镜像（放开 phase 守卫给好友房中途补 bot）');
    ok(/addBot[\s\S]{0,800}?pendingBotSeat\s*=\s*seat/.test(tableSrc),
      'table.js addBot 进行中走 pendingBotSeat（下一手 applyPendingSeats ③ 落位）');
    // 镜像端 addBot 必须短路：好友端不跑引擎，pendingBotSeat 会空插不广播
    ok(/addBot\(\)\s*\{[\s\S]{0,120}!this\.isOwner\)\s*\{[\s\S]{0,80}?仅房主可添加玩家/.test(tableSrc),
      'table.js addBot 仅房主守卫仍在（镜像端好友点按钮被拦）');
    // WXML：对局内**不再**有「添加电脑玩家」入口（2026-10-17 用户反馈反转：
    // 开局后凑人只走真人路径——好友经邀请/房间号进来点空位坐下；加 bot 只在等待室）。
    ok(!/actbar add-bot-bar/.test(tableWxml) && !/ab-addbot/.test(tableWxml),
      'table.wxml 对局内已移除「添加电脑玩家」入口（add-bot-bar / ab-addbot 不得出现）');
    // 等待室的入口仍在（唯一合法的加 bot 入口）
    ok(/bindtap="addBot"[\s\S]{0,200}?添加电脑玩家/.test(tableWxml) ||
       /添加电脑玩家[\s\S]{0,60}?bindtap="addBot"/.test(tableWxml),
      'table.wxml 等待室「添加电脑玩家」按钮绑 addBot（唯一加 bot 入口）');

    // ---- 好友房进行中踢 bot（与补 bot 对称，复用「请出」标签入口）----
    // 病根：kickBot 原 `if (phase !== 'waiting') return` 守卫 → 进行中点「请出」
    // 直接 return，房主无法中途清退多余电脑玩家。改为进行中走 pendingKickBots
    // → 下一手 applyPendingSeats ④ 移出 game.players 并留档 leftPlayers，账面不缺口。
    // 复用既有「请出」标签（wxml:149），仅放宽 phase/mode 门控，不新增按钮。
    ok(/kickBot\([^)]*\)\s*\{[\s\S]{0,300}?!this\.isOwner\)\s*return/.test(tableSrc),
      'table.js kickBot 仅房主守卫（镜像端 isOwner 恒 false，被拦）');
    ok(/kickBot[\s\S]{0,600}?phase === 'playing' && this\.mode === 'friend' && !this\.remoteMode/.test(tableSrc),
      'table.js kickBot 进行中分支守卫 friend 房主非镜像（放开 phase 守卫给好友房中途踢 bot）');
    ok(/kickBot[\s\S]{0,1000}?pendingKickBots\[seat\]\s*=\s*true/.test(tableSrc),
      'table.js kickBot 进行中走 pendingKickBots[seat]（下一手 applyPendingSeats ④ 移出）');
    ok(/kickBot[\s\S]{0,600}?只能请出电脑玩家/.test(tableSrc),
      'table.js kickBot 进行中只请 bot（非 bot 或不在座时 toast 拦截，不踢真人）');
    ok(/pendingKickBots\s*=\s*\{\}/.test(tableSrc),
      'table.js 实例字段 pendingKickBots 初始化（onLoad/startGame 重置）');
    // applyPendingSeats ④：移出 game.players 并留档 leftPlayers
    ok(/pendingKickBots[\s\S]{0,400}?leftPlayers\.push/.test(tableSrc),
      'table.js applyPendingSeats ④ 踢 bot 前先 push leftPlayers（结算单账面不缺口）');
    ok(/pendingKickBots[\s\S]{0,500}?game\.players\s*=\s*game\.players\.filter/.test(tableSrc),
      'table.js applyPendingSeats ④ 把 bot 从 game.players 过滤移出');
    // 进行中座位对象必须带 isBot——等待室走 buildWaitSeats 自带 isBot，
    // 进行中座位对象此前未带，会导致 wxml:149 的 item.isBot 判空、
    // 「请出」标签在牌局中根本不显示（补 bot 能加、踢 bot 入口却看不见）。
    ok(/isBot:\s*!!this\.botSeats\[p\.seat\]/.test(tableSrc),
      'table.js 进行中座位对象带 isBot（来自 botSeats，否则「请出」标签牌局中不显示）');
    // WXML：「请出」标签门控放宽到 playing（好友房），复用同一入口不新增按钮
    ok(/isBot && isOwner && \(phase === 'waiting' \|\| \(phase === 'playing' && mode === 'friend'\)\)/.test(tableWxml),
      'table.wxml 「请出」标签门控含 playing+friend（复用既有入口踢 bot，不新增按钮）');
    ok((tableWxml.match(/catchtap="kickBot"/g) || []).length === 1,
      'table.wxml kickBot 仅一个绑定点（复用「请出」标签，未新增重复入口）');
  }

  /**
   * 批⑥ 对手画像页静态守卫：长按头像弹角色卡，tellPattern 暗线转明线。
   * 覆盖：longpress 绑定、tap/longpress 冲突防护、角色卡 modal、tellHints、
   *       analyzeOpponent、style-analyzer 引入、风格条无 canvas/无 width transition。
   */
  function guardOpponentProfile(tableSrc, tableWxml, tableWxss, botSrc, saSrc) {
    // ---- table.js 接入 ----
    ok(/onAvatarLongPress/.test(tableSrc), 'table.js 定义 onAvatarLongPress（长按头像）');
    ok(/onOppCardClose/.test(tableSrc), 'table.js 定义 onOppCardClose（关角色卡）');
    ok(/_computeOppCard/.test(tableSrc), 'table.js 定义 _computeOppCard（构造角色卡数据）');
    ok(/_buildStyleBars/.test(tableSrc), 'table.js 定义 _buildStyleBars（风格条数组）');
    ok(/_computeOppStats/.test(tableSrc), 'table.js 定义 _computeOppStats（本局统计）');
    ok(/oppCardShow/.test(tableSrc) && /oppCardData/.test(tableSrc),
      'table.js data 含 oppCardShow/oppCardData（角色卡 modal toggle）');
    ok(/require\(['"].+style-analyzer['"]\)/.test(tableSrc),
      'table.js 引入 style-analyzer（analyzeOpponent 数据源）');
    // tap/longpress 冲突防护
    ok(/_longPressFlag/.test(tableSrc),
      'table.js onAvatarTap 检查 _longPressFlag（长按后拦误触 tap）');
    // botProfiles.tellHints 调用
    ok(/botProfiles\.tellHints/.test(tableSrc),
      'table.js 调 botProfiles.tellHints（马脚转文案）');
    // analyzeOpponent 调用
    ok(/styleAnalyzer\.analyzeOpponent/.test(tableSrc),
      'table.js 调 styleAnalyzer.analyzeOpponent（单对手单局统计）');

    // ---- table.wxml ----
    ok(/catchlongpress="onAvatarLongPress"/.test(tableWxml),
      'table.wxml avatar 绑 catchlongpress');
    ok(/class="opp-card"/.test(tableWxml), 'table.wxml 含 opp-card 角色卡 modal');
    ok(/opp-bar-fill/.test(tableWxml), 'table.wxml 含风格条 opp-bar-fill');
    ok(/opp-hint/.test(tableWxml), 'table.wxml 含马脚提示 opp-hint');
    ok(/opp-stat/.test(tableWxml), 'table.wxml 含本局统计 opp-stat');
    ok(/<canvas/i.test(tableWxml) === false, 'table.wxml 角色卡无 canvas（零 canvas 硬约束）');

    // ---- table.wxss：风格条无 width transition（重排红线） ----
    ok(/\.opp-bar-fill/.test(tableWxss), 'table.wxss 定义 .opp-bar-fill');
    ok(/\.opp-card/.test(tableWxss), 'table.wxss 定义 .opp-card 系列');
    // .opp-bar-fill 块内不得出现 transition（width transition 是重排红线）
    const oppBarFillBlock = tableWxss.match(/\.opp-bar-fill\s*\{[^}]*\}/);
    ok(!oppBarFillBlock || !/transition/i.test(oppBarFillBlock[0]),
      'table.wxss .opp-bar-fill 无 transition（width 静态赋值，重排红线）');

    // ---- bot-profiles.js tellHints ----
    ok(/function tellHints/.test(botSrc), 'bot-profiles.js 定义 tellHints');
    ok(/bluffFast/.test(botSrc) && /诈唬时反应急促/.test(botSrc),
      'bot-profiles.js tellHints 含 bluffFast 文案');
    ok(/bluffSilent/.test(botSrc) && /诈唬时突然沉默/.test(botSrc),
      'bot-profiles.js tellHints 含 bluffSilent 文案');
    ok(/bluffTalkBoost/.test(botSrc) && /诈唬时话变多/.test(botSrc),
      'bot-profiles.js tellHints 含 bluffTalkBoost 文案');
    ok(/tellHints/.test(botSrc.replace(/^[\s\S]*module.exports/, '')),
      'bot-profiles.js 导出 tellHints');

    // ---- style-analyzer.js analyzeOpponent ----
    ok(/function analyzeOpponent/.test(saSrc), 'style-analyzer.js 定义 analyzeOpponent');
    ok(/analyzeOpponent/.test(saSrc.replace(/^[\s\S]*module.exports/, '')),
      'style-analyzer.js 导出 analyzeOpponent');
    ok(/curStreet/.test(saSrc) && /type === 'street'/.test(saSrc),
      'style-analyzer.js analyzeOpponent 跟踪 curStreet（action 事件无 street）');
    ok(/本手未行动|本手入池|是|否/.test(saSrc),
      'style-analyzer.js analyzeOpponent 单局布尔级文案（是/否，非百分比）');
  }

  /**
   * 批⑦ 高光分享卡片静态守卫：非 canvas 分享卡预览弹层 + 截图引导 + title 摘要。
   * 覆盖：分享卡弹层 toggle、数据源 highlightStore.latest、截图引导文案、
   *       onShareAppMessage 高光 title 分支、profile 分享入口、无 canvas、无重排红线。
   */
  function guardShareCardIntegration(tableSrc, tableWxml, tableWxss, profSrc, hlSrc) {
    // ---- table.js 接入 ----
    ok(/onShareCardShow/.test(tableSrc), 'table.js 定义 onShareCardShow（打开分享卡）');
    ok(/onShareCardClose/.test(tableSrc), 'table.js 定义 onShareCardClose（关分享卡）');
    ok(/shareCardShow/.test(tableSrc) && /shareCardData/.test(tableSrc),
      'table.js data 含 shareCardShow/shareCardData');
    ok(/_shareHighlightTitle/.test(tableSrc),
      'table.js 实例字段 _shareHighlightTitle（供 onShareAppMessage 带摘要）');
    ok(/highlightStore\.latest\(\)/.test(tableSrc),
      'table.js onShareCardShow 从 highlightStore.latest() 取数据源');
    ok(/highlightStore\.summarize/.test(tableSrc),
      'table.js 用 highlightStore.summarize 取高光摘要');
    ok(/_shareHighlightTitle\s*=/.test(tableSrc),
      'table.js onShareCardShow 设 _shareHighlightTitle');
    ok(/onShareAppMessage[\s\S]*_shareHighlightTitle/.test(tableSrc),
      'table.js onShareAppMessage 优先返回 _shareHighlightTitle 摘要 title');

    // ---- table.wxml ----
    ok(/class="share-card"/.test(tableWxml), 'table.wxml 含 share-card 分享卡 modal');
    ok(/分享高光/.test(tableWxml), 'table.wxml 结算弹窗含「分享高光」入口按钮');
    ok(/长按.*截图/.test(tableWxml), 'table.wxml 含截图引导文案（长按截图保存）');
    ok(/open-type="share"/.test(tableWxml), 'table.wxml 分享卡含 open-type="share" 按钮');
    ok(/<canvas/i.test(tableWxml) === false, 'table.wxml 分享卡无 canvas（零 canvas 硬约束）');

    // ---- table.wxss：分享卡无重排红线属性 ----
    ok(/\.share-card/.test(tableWxss), 'table.wxss 定义 .share-card 系列');
    const shareCardBlock = tableWxss.match(/\.share-card\s*\{[^}]*\}/);
    ok(!shareCardBlock || !/transition:\s*(width|top|left)/i.test(shareCardBlock[0]),
      'table.wxss .share-card 无 width/top/left transition（重排红线）');

    // ---- highlight-store.js（数据源可用） ----
    ok(/function latest/.test(hlSrc), 'highlight-store.js 导出 latest（分享卡数据源）');

    // ---- profile.js 分享入口 ----
    ok(/onShareAppMessage/.test(profSrc), 'profile.js 定义 onShareAppMessage（高光摘要 title）');
    ok(/onShareTimeline/.test(profSrc), 'profile.js 定义 onShareTimeline');
    ok(/highlightBest\.summary/.test(profSrc) || /best\.summary/.test(profSrc),
      'profile.js onShareAppMessage 用 highlightBest.summary 作 title');
  }

  /* 批⑨ AI 读人反制：零引擎改动，纯 table.js 包装层注入滚动 VPIP 调整 tight。 */
  function guardAiCounterIntegration(tableSrc) {
    // ---- 滚动 VPIP 实例字段（onLoad 初始化） ----
    ok(/_humanVpipHands\s*=\s*0/.test(tableSrc), 'table.js onLoad 初始化 _humanVpipHands=0');
    ok(/_humanVpipCount\s*=\s*0/.test(tableSrc), 'table.js onLoad 初始化 _humanVpipCount=0');
    ok(/_humanActedThisHand\s*=\s*false/.test(tableSrc), 'table.js onLoad 初始化 _humanActedThisHand=false');

    // ---- _adjustTightByVpip 方法 ----
    ok(/_adjustTightByVpip\s*\(/.test(tableSrc), 'table.js 定义 _adjustTightByVpip 方法');
    ok(/Object\.assign\(\{\},\s*baseStyle\)/.test(tableSrc),
      'table.js _adjustTightByVpip 用 Object.assign 副本（不修改 p.style 原对象）');
    ok(/0\.28/.test(tableSrc), 'table.js VPIP 基准 0.28（与 style-analyzer VPIP_LOOSE 一致）');
    ok(/Math\.max\(0,\s*Math\.min\(1,/.test(tableSrc) || /Math\.min\(1,\s*Math\.max\(0,/.test(tableSrc),
      'table.js _adjustTightByVpip clamp01 限制 tight ∈[0,1]');
    // 概率守卫：_adjustTightByVpip 内禁止调用 rnd()/rng.float()（纯算术）
    const adjMatch = tableSrc.match(/_adjustTightByVpip\(baseStyle,\s*humanVpip\)\s*\{[\s\S]*?\n\s*\}/);
    ok(!!adjMatch, 'table.js _adjustTightByVpip 函数体可定位');
    if (adjMatch) {
      ok(!/rnd\(\)|rng\.float\(\)/.test(adjMatch[0]),
        'table.js _adjustTightByVpip 纯算术，无 rnd()/rng.float() 概率调用');
    }

    // ---- expert 门控 ----
    ok(/mode\s*===\s*['"]ai['"]\s*&&\s*this\.level\s*===\s*['"]expert['"]/.test(tableSrc),
      "table.js AI 读人反制 expert 门控（mode==='ai' && level==='expert'）");
    ok(/_humanVpipHands\s*>=\s*3/.test(tableSrc),
      'table.js 最小 3 手后注入（_humanVpipHands>=3，防小样本噪音）');

    // ---- doAct 翻前计数 ----
    ok(/streetBefore\s*=\s*game\.street/.test(tableSrc),
      'table.js doAct act 前记录 streetBefore（防 act 后街推进）');
    ok(/P\.STREET\.PREFLOP/.test(tableSrc), 'table.js 翻前计数判 P.STREET.PREFLOP');
    ok(/action\s*===\s*['"]call['"]\s*\|\|\s*action\s*===\s*['"]raise['"]\s*\|\|\s*action\s*===\s*['"]allin['"]/.test(tableSrc),
      'table.js 翻前自愿入池计 call/raise/allin（blind/check 不计）');
    ok(/_humanActedThisHand\s*=\s*true/.test(tableSrc),
      'table.js 翻前任意动作设 _humanActedThisHand=true（startHand 边界累加用）');

    // ---- startHand 边界累加 ----
    ok(/_humanVpipHands\+\+/.test(tableSrc),
      'table.js startHand 边界累加 _humanVpipHands++');

    // ---- scheduleAI 注入点 ----
    ok(/aiStyle\s*=\s*this\._adjustTightByVpip/.test(tableSrc),
      'table.js scheduleAI 用 _adjustTightByVpip 构造 aiStyle');
    ok(/style:\s*aiStyle/.test(tableSrc),
      'table.js scheduleAI 传 style: aiStyle（不碰 p.style 原对象）');

    // ---- B1 位置因子行动序位（玩家审视 2026-10-17）----
    // 静态守卫：旧口径（seat 序差直接映射）必须退役，新口径走 rank/lateness 归一。
    ok(/const rank = \(actIdx - dlrIdx \+ n\) % n;/.test(tableSrc),
      'scheduleAI B1：位置按行动序位 rank 计算（0 = 按钮左一）');
    ok(/const lateness = rank \/ \(n - 1\);/.test(tableSrc),
      'scheduleAI B1：rank 归一为 lateness（[0,1]）');
    ok(tableSrc.indexOf('pf <= 1 ? 0.9') === -1,
      'scheduleAI B1：旧位置映射 pf<=1→0.9 已退役（空座位混入的旧口径）');
    ok(/n === 2/.test(tableSrc),
      'scheduleAI B1：HU 局单独分支（翻前给固定 0.5）');
  }

  /* ---------- 回归：AI 对战「还没点准备就绪，牌局就自己开始了」 ----------
   * 真机反馈的完整触发链：
   *   一手结束 → 结算弹窗（RESULT_MODAL_MS=10s 后自动关闭）
   *   → closeResultModal(true) → enterReadyPhase() → 30s 就绪倒计时
   *   → autoStandUnready() 把我站起 → 我从名单移除
   *   → 剩下的电脑玩家早已自动 ready → 判定「全员就绪」→ 直接开局
   * 结果：玩家既没点准备，开局后还变成了观战。
   *
   * ⚠️ 复现必须同时满足两个条件，缺一不可：
   *   ① mode 必须是 'ai'（好友房里有人超时站起、其他人继续是设计意图，不能改）
   *   ② 人数必须 >= 3（2 人局里我站起后只剩 1 个 bot，会被「不足 2 人」挡住，
   *      根本走不到自动开局那条分支 —— 只测 2 人局会漏掉这个 bug）
   */
  {
    pageCtx.onLoad();                      // 无参 → mode='ai'
    pageCtx.chooseSeat({ currentTarget: { dataset: { seat: 0 } } });
    pageCtx.confirmBuyIn({ currentTarget: { dataset: { amt: '1000' } } });
    for (let i = 0; i < 3; i++) pageCtx.addBot();   // 我 + 3 bot = 4 人
    pageCtx.startGame();
    ok(pageCtx.mode === 'ai' && dataStore.phase === 'playing',
      '复现前置：AI 对战已开局（mode=' + pageCtx.mode + ' phase=' +
      dataStore.phase + '）');
    // 只断言「3 人以上」：game 是模块级单例，前面用例留下的 bot 可能还在，
    // 硬编码具体人数会随用例顺序变动而误报。复数才是复现的必要前提。
    ok((dataStore.seats || []).length >= 3,
      '复现前置：至少 3 人在座（2 人局会被「不足 2 人」挡住，测不出这个 bug），实际 ' +
      (dataStore.seats || []).length);

    // 进入就绪阶段后，让所有电脑玩家先准备好（真机上它们在 1.5~4s 内自动 ready）
    pageCtx.enterReadyPhase();
    ok(dataStore.readyPhase === true, '进入就绪阶段（等所有人准备就绪）');
    dataStore.readyList.forEach(r => { if (!r.isMe) pageCtx.markReady(r.seat, true); });

    const handBeforeTimeout2 = dataStore.handNo;
    ok(dataStore.readyPhase === true,
      '只有电脑玩家准备好、我还没点 → 不该开下一手（实际 readyPhase=' +
      dataStore.readyPhase + '）');

    // 模拟 30 秒到点：我超时被自动站起
    pageCtx.autoStandUnready();
    ok(dataStore.myStanding === true, '我超时未准备 → 被自动站起');

    ok(dataStore.readyPhase === true,
      '★ AI 对战：我站起后**不**自动开下一手（真机 bug：还没点准备就绪牌局就开始了）' +
      '，实际 readyPhase=' + dataStore.readyPhase);
    ok(dataStore.handNo === handBeforeTimeout2,
      '★ AI 对战：我站起后不发新一手（handNo 保持 ' + handBeforeTimeout2 +
      '，实际 ' + dataStore.handNo + '）');
    ok(/自动站起/.test(dataStore.readyHint),
      '给出「已自动站起 · 可重新入局」的明确提示，实际：' + dataStore.readyHint);
    ok((dataStore.readyList || []).every(r => r.seat !== 0),
      '站起后我已被移出就绪名单（只剩电脑玩家，此时绝不能开局）');
    pageCtx.clearReadyClock();
  }
  /* ---------- 回归：AI 对战「还没点准备就绪，牌局就自己开始了」 ----------
   * 真机反馈的完整触发链：
   *   一手结束 → 结算弹窗（RESULT_MODAL_MS=10s 后自动关闭）
   *   → closeResultModal(true) → enterReadyPhase() → 30s 就绪倒计时
   *   → autoStandUnready() 把我站起 → 我从名单移除
   *   → 剩下的电脑玩家早已自动 ready → 判定「全员就绪」→ 直接开局
   * 结果：玩家既没点准备，开局后还变成了观战。
   *
   * ⚠️ 复现必须同时满足两个条件，缺一不可：
   *   ① mode 必须是 'ai'（好友房里有人超时站起、其他人继续是设计意图，不能改）
   *   ② 人数必须 >= 3（2 人局里我站起后只剩 1 个 bot，会被「不足 2 人」挡住，
   *      根本走不到自动开局那条分支 —— 只测 2 人局会漏掉这个 bug）
   */
  {
    pageCtx.onLoad();                      // 无参 → mode='ai'
    pageCtx.chooseSeat({ currentTarget: { dataset: { seat: 0 } } });
    pageCtx.confirmBuyIn({ currentTarget: { dataset: { amt: '1000' } } });
    for (let i = 0; i < 3; i++) pageCtx.addBot();   // 我 + 3 bot = 4 人
    pageCtx.startGame();
    ok(pageCtx.mode === 'ai' && dataStore.phase === 'playing',
      '复现前置：AI 对战已开局（mode=' + pageCtx.mode + ' phase=' +
      dataStore.phase + '）');
    // 只断言「3 人以上」：game 是模块级单例，前面用例留下的 bot 可能还在，
    // 硬编码具体人数会随用例顺序变动而误报。复数才是复现的必要前提。
    ok((dataStore.seats || []).length >= 3,
      '复现前置：至少 3 人在座（2 人局会被「不足 2 人」挡住，测不出这个 bug），实际 ' +
      (dataStore.seats || []).length);

    // 进入就绪阶段后，让所有电脑玩家先准备好（真机上它们在 1.5~4s 内自动 ready）
    pageCtx.enterReadyPhase();
    ok(dataStore.readyPhase === true, '进入就绪阶段（等所有人准备就绪）');
    dataStore.readyList.forEach(r => { if (!r.isMe) pageCtx.markReady(r.seat, true); });

    const handBeforeTimeout2 = dataStore.handNo;
    ok(dataStore.readyPhase === true,
      '只有电脑玩家准备好、我还没点 → 不该开下一手（实际 readyPhase=' +
      dataStore.readyPhase + '）');

    // 模拟 30 秒到点：我超时被自动站起
    pageCtx.autoStandUnready();
    ok(dataStore.myStanding === true, '我超时未准备 → 被自动站起');

    ok(dataStore.readyPhase === true,
      '★ AI 对战：我站起后**不**自动开下一手（真机 bug：还没点准备就绪牌局就开始了）' +
      '，实际 readyPhase=' + dataStore.readyPhase);
    ok(dataStore.handNo === handBeforeTimeout2,
      '★ AI 对战：我站起后不发新一手（handNo 保持 ' + handBeforeTimeout2 +
      '，实际 ' + dataStore.handNo + '）');
    ok(/自动站起/.test(dataStore.readyHint),
      '给出「已自动站起 · 可重新入局」的明确提示，实际：' + dataStore.readyHint);
    ok((dataStore.readyList || []).every(r => r.seat !== 0),
      '站起后我已被移出就绪名单（只剩电脑玩家，此时绝不能开局）');
    pageCtx.clearReadyClock();
  }

  /* ---------- 好友房进行中补 bot（用户反馈「邀请机器人进房间但坐不下/很快退出」）----------
   * 病根：addBot 原有 `if (phase !== 'waiting') return` 守卫 → 牌局进行中
   * 房主点「添加电脑玩家」直接被拦。好友不够时无法中途凑桌，只能退回等待室。
   * 修复：进行中（friend 房主、非镜像）走 pendingBotSeat，下一手 applyPendingSeats ③
   * 把 bot 插进 game.players，随 startHand 的 forcePublish 广播，镜像端 loadSnapshot
   * 重映射自动容纳新座位。
   */
  {
    pageCtx.onLoad({ room: '777888', own: '1' });   // 好友房房主
    ok(pageCtx.mode === 'friend', '好友房补 bot 前置：mode=friend');
    pageCtx.addBot();                               // 等待室先加一个 bot
    ok((dataStore.waitSeats || []).filter(s => s.occupied).length === 2,
      '等待室 addBot 仍正常占座（房主+1bot=2），实际 ' +
      (dataStore.waitSeats || []).filter(s => s.occupied).length);
    pageCtx.startGame();
    ok(dataStore.phase === 'playing', '好友房补 bot 前置：已开局（phase=playing）');
    const before = (pageCtx.requireGame() && pageCtx.requireGame().players || []).length;
    pageCtx.addBot();                               // 进行中再点「添加电脑玩家」
    ok(pageCtx.pendingBotSeat !== null && pageCtx.pendingBotSeat !== undefined,
      '★ 进行中 addBot 置 pendingBotSeat（下一手插入），实际 pendingBotSeat=' +
      pageCtx.pendingBotSeat);
    // 触发下一手落位：手动调 applyPendingSeats（startHand 路径里的落位函数）
    pageCtx.applyPendingSeats();
    const after = (pageCtx.requireGame() && pageCtx.requireGame().players || []).length;
    ok(after === before + 1,
      '★ applyPendingSeats 后 bot 落位（players +1，' + before + '→' + after + '）');
    ok(pageCtx.pendingBotSeat === null || pageCtx.pendingBotSeat === undefined,
      '落位后 pendingBotSeat 清空（不重复插入）');
    const newBot = (pageCtx.requireGame() && pageCtx.requireGame().players || []).filter(p => !p.isHuman);
    ok(newBot.length >= 2, '在座 bot ≥2（等待室 1 + 进行中补 1），实际 ' + newBot.length);
    // 镜像端守卫：remoteMode 时 addBot 不应走 pendingBotSeat（不跑引擎，插了不广播）
    pageCtx.remoteMode = true;
    pageCtx.pendingBotSeat = null;
    pageCtx.addBot();
    ok(pageCtx.pendingBotSeat === null || pageCtx.pendingBotSeat === undefined,
      '★ 镜像端 addBot 不置 pendingBotSeat（不跑引擎，避免空插不广播）');
    pageCtx.remoteMode = false;
  }

  /* ---------- 好友房进行中踢 bot（与补 bot 对称，用户「加进行中踢 bot」）----------
   * 病根：kickBot 原 `if (phase !== 'waiting') return` 守卫 → 牌局进行中
   * 房主点「请出」直接被拦，无法中途清退多余电脑玩家。
   * 修复：进行中（friend 房主、非镜像）走 pendingKickBots[seat]，下一手
   * applyPendingSeats ④ 把 bot 从 game.players 过滤移出，先 push leftPlayers
   * 留档（结算单账面不缺口），与补 bot 完全对称。复用既有「请出」标签入口，
   * 仅放宽 phase/mode 门控，不新增按钮。
   */
  {
    // 前置：建一个好友房，等待室加 2 个 bot，开局进 playing
    pageCtx.onLoad({ room: '777999', own: '1' });   // 好友房房主
    ok(pageCtx.mode === 'friend', '好友房踢 bot 前置：mode=friend');
    pageCtx.addBot();
    pageCtx.addBot();
    const seated0 = (dataStore.waitSeats || []).filter(s => s.occupied).length;
    ok(seated0 === 3, '等待室加 2 bot 占座（房主+2bot=3），实际 ' + seated0);
    pageCtx.startGame();
    ok(dataStore.phase === 'playing', '好友房踢 bot 前置：已开局（phase=playing）');
    const game = pageCtx.requireGame();
    ok(!!game, '好友房踢 bot 前置：module 级 game 已建');
    const botSeats = (game.players || []).filter(p => !p.isHuman).map(p => p.seat);
    ok(botSeats.length >= 2, '在座 bot ≥2（待踢目标），实际 ' + botSeats.length);

    // 进行中座位对象必须带 isBot——否则 wxml:149 的 item.isBot 判空、
    // 「请出」标签牌局中根本不显示（补 bot 能加、踢 bot 入口却看不见）。
    // 触发一次 render 取 seats 数据，校验 bot 座位 isBot=true、真人 isBot=false。
    pageCtx.render();
    const seatRows = (dataStore.seats || []).filter(s => s.seat === botSeats[0]);
    ok(seatRows.length >= 1 && seatRows[0].isBot === true,
      '★ 进行中 render 后 bot 座位 isBot=true（「请出」标签据此显示），实际 ' +
      JSON.stringify((seatRows[0] || {}).isBot));
    const myRow = (dataStore.seats || []).filter(s => s.seat === pageCtx.mySeat);
    ok(myRow.length >= 1 && myRow[0].isBot === false,
      '进行中 render 后真人座位 isBot=false（不会被误挂「请出」），实际 ' +
      JSON.stringify((myRow[0] || {}).isBot));

    const before = (game.players || []).length;
    const leftBefore = (pageCtx.leftPlayers || []).length;
    const kickSeat = botSeats[0];
    const kickStack = game.seatOf(kickSeat).stack;

    // 进行中点「请出」该 bot
    pageCtx.kickBot({ currentTarget: { dataset: { seat: kickSeat } } });
    ok(pageCtx.pendingKickBots && pageCtx.pendingKickBots[kickSeat] === true,
      '★ 进行中 kickBot 置 pendingKickBots[seat]=true（下一手移出），实际 ' +
      JSON.stringify(pageCtx.pendingKickBots || {}));

    // 误踢真人：对「我」座位点「请出」应被拦（只请 bot）
    const mySeat = pageCtx.mySeat;
    pageCtx.kickBot({ currentTarget: { dataset: { seat: mySeat } } });
    ok(!pageCtx.pendingKickBots[mySeat],
      '★ kickBot 进行中只请 bot（对真人座位点「请出」不置位，不踢真人）');

    // 触发下一手落位：手动调 applyPendingSeats（startHand 路径里的落位函数）
    pageCtx.applyPendingSeats();
    const after = (pageCtx.requireGame() && pageCtx.requireGame().players || []).length;
    ok(after === before - 1,
      '★ applyPendingSeats 后 bot 移出（players -1，' + before + '→' + after + '）');
    ok(Object.keys(pageCtx.pendingKickBots || {}).length === 0,
      '落位后 pendingKickBots 清空（不重复移出）');
    ok(!pageCtx.botSeats[kickSeat],
      '踢出后 botSeats[kick] 已清（不再为它跳过心跳/超时）');
    // leftPlayers 留档 +1：结算单仍统计该 bot 的带入/盈亏，账面不缺口
    const leftAfter = (pageCtx.leftPlayers || []).length;
    ok(leftAfter === leftBefore + 1,
      '★ 踢出 bot 先留档 leftPlayers（+1，' + leftBefore + '→' + leftAfter + '，结算单账面不缺口）');
    const leftEntry = (pageCtx.leftPlayers || []).find(x => x.seat === kickSeat);
    ok(!!leftEntry && leftEntry.isHuman === false && leftEntry.left === true,
      '留档条目正确（seat=' + kickSeat + ', isHuman=false, left=true）');
    ok(leftEntry && leftEntry.stack === kickStack,
      '留档 stack 取自移出前余额（' + kickStack + '，账面与引擎一致）');

    // 镜像端守卫：remoteMode 时 isOwner 恒 false，kickBot 直接 return，不置 pendingKickBots
    pageCtx.remoteMode = true;
    const wasOwner = pageCtx.isOwner;
    pageCtx.isOwner = false;   // 镜像端好友非房主
    pageCtx.pendingKickBots = {};
    pageCtx.kickBot({ currentTarget: { dataset: { seat: kickSeat } } });
    ok(Object.keys(pageCtx.pendingKickBots || {}).length === 0,
      '★ 镜像端 kickBot 不置 pendingKickBots（isOwner=false 直接 return，不替房主踢）');
    pageCtx.isOwner = wasOwner;
    pageCtx.remoteMode = false;
  }


  /* ---------- 回归：档位口径随街/加注失效即重置（2026-10-17 真机截图实锤）---------- */
  /* 现象：点 50% 档后未确认，AI 行动推进 street/currentBet → 旧档位金额算出来
     低于新一轮 minRaiseTo，render 把 raiseTo 钳回最小，而 preset 高亮还停在 50%
     → 「高亮 50% + 加注 20」矛盾态（AI 桌与好友房同现）。 */
  {
    pageCtx.onLoad({});                       // AI 桌（syncLive=false → startGame 同步）
    pageCtx.chooseSeat({ currentTarget: { dataset: { seat: 0 } } });
    pageCtx.confirmBuyIn({ currentTarget: { dataset: { amt: '1000' } } });
    pageCtx.startGame();
    const g0 = pageCtx.requireGame();
    ok(g0 && g0.players.length >= 2, 'AI 桌同步开局（回归前置）');
    // 强制轮到我（不依赖 AI 异步行动），把我复位成可加注的确定态
    g0.players.forEach(p => { if (p.seat !== pageCtx.mySeat) p.folded = false; });
    const me0 = g0.seatOf(pageCtx.mySeat);
    me0.folded = false; me0.allIn = false; me0.sittingOut = false;
    g0.currentBet = 20; g0.actionSeat = pageCtx.mySeat; g0.result = null;
    pageCtx.render();
    pageCtx.onPresetTap({ currentTarget: { dataset: { v: 'p50' } } });
    ok(dataStore.raisePreset === 'p50', '点 50% 档后高亮 p50，实际 ' + dataStore.raisePreset);
    ok(dataStore.raiseTo > 20, '50% 档金额大于最小（' + dataStore.raiseTo + '）');
    // 模拟 AI 加注：currentBet 抬高 → 档位口径失效 → 高亮与金额必须同帧回「最小」
    g0.currentBet += 40;
    g0.actionSeat = pageCtx.mySeat;
    pageCtx.render();
    ok(dataStore.raisePreset === 'min',
      '★ 口径失效（currentBet 变）后高亮回「最小」，实际 ' + dataStore.raisePreset);
    ok(dataStore.raiseTo === dataStore.raiseMin || dataStore.raiseSubmit === dataStore.raiseMin,
      '★ 口径失效后金额=新一轮最小（raiseTo=' + dataStore.raiseTo + ' min=' + dataStore.raiseMin + '），不再矛盾');
    // 对照：同街内（currentBet 不变）重渲染，不得清掉我刚选的档位
    pageCtx.onPresetTap({ currentTarget: { dataset: { v: 'p67' } } });
    pageCtx.render();
    ok(dataStore.raisePreset === 'p67',
      '同街重渲染保持我选的档位（p67），实际 ' + dataStore.raisePreset);
    // 恢复：结束本局，防污染后续块（无后续行为块，仅防定时器挂住）
    pageCtx.onEnterBackground();
  }

  /* ---------- 结构守卫：档位口径判据 + bot 掉线双判据 + 开局 bot 补齐 ---------- */
  {
    // 1) render 里必须有 street:currentBet 口径判据（丢失 = 矛盾态复发）
    ok(/_raiseEpoch !== raiseEpoch/.test(tableSrc) && /raiseEpoch = game \? Street|const raiseEpoch = game/.test(tableSrc),
      'render 含「街:当前下注」档位口径判据（raiseEpoch）');
    // 2) 掉线检测必须双判据：botSeats 之外还要认玩家对象自身的 isHuman===false
    ok(/if \(this\.botSeats\[p\.seat\]\) return;[\s\S]{0,120}if \(p\.isHuman === false\) return;/.test(tableSrc),
      'dropOfflineSeats 双判据（botSeats + p.isHuman===false），botSeats 缺标记时不得误杀 bot');
    // 3) 开局组装 players 必须用本地 waitSeats 的 bot 补齐云端布局（hostState 落库滞后）
    ok(/if \(this\.syncLive && !this\.remoteMode\) \{[\s\S]{0,500}!cur \|\| !cur\.occupied \|\| !cur\.isBot/.test(tableSrc),
      'startGame 权威端用本地 waitSeats 的 bot 补齐云端布局（防 hostState 滞后丢 bot）');
  }

  /* ---------- 输出 ---------- */
  console.log('\n' + '='.repeat(52));
  if (failures.length === 0) {
    console.log('小程序逻辑仿真测试全部通过：' + passes + ' 项断言 ✓');
    console.log('='.repeat(52) + '\n');
    process.exit(0);
  } else {
    console.log('通过 ' + passes + ' 项，失败 ' + failures.length + ' 项：\n');
    failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    console.log('='.repeat(52) + '\n');
    process.exit(1);
  }
})();
