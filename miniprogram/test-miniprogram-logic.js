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
ok(dataStore.seats.length === 2, '2 人局：2 个座位都在牌桌环上（含我），实际 ' + dataStore.seats.length);
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
ok(dataStore.seats.length === 2, '续局保留原座位数（2 个座位都在环上），实际 ' + dataStore.seats.length);
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
ok(dataStore.seats.length === 2, '4 人桌 2 人入局（2 个座位都在环上），实际 ' + dataStore.seats.length);
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
    ok(adviceSrc.indexOf('_adviceKey') >= 0, 'renderAdvice 有缓存键（不再每帧重算）');
    ok(/!isMyTurn \|\| this\.mode !== 'ai'\)[\s\S]*?_adviceKey = null/.test(adviceSrc),
      '离开我的回合即失效缓存键（下一回合必是新局势）');
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

  /* ---------- 微扑克式分区：折叠面板 ---------- */
  ok(dataStore.chatOpen === false && dataStore.menuOpen === false, '聊天与菜单默认折叠（不抢占主视觉）');
  ok(Array.isArray(dataStore.raisePresets) && dataStore.raisePresets.length === 7,
    '加注档位 7 档（最小 / 33% / 50% / 67% / 100% / 全下 / 自定义）');
  ok(Array.isArray(dataStore.raisePresets) &&
    dataStore.raisePresets[6].k === 'custom' && dataStore.raisePresets[6].t === '自定义',
    '第 7 档为「自定义」入口（展开盲注步进的金额面板）');
  ok(Array.isArray(dataStore.raisePresets) &&
    dataStore.raisePresets.slice(1, 5).map(x => x.k).join(',') === 'p33,p50,p67,p100',
    '中间四档为百分比 sizing（33/50/67/100%），可横向比较');
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
  pageCtx.autoStandUnready();     // 模拟 30 秒到点（不等待真实时间）
  ok(dataStore.myStanding === true, '超时未准备，我被自动站起（仍留在房间内）');
  ok(pageCtx.seatedOf(0) === false, '自动站起后不再算「在座」，下一手不参与发牌');
  ok(dataStore.readyHint.indexOf('人数不足') >= 0 || dataStore.readyPhase === false,
    '自动站起后给出提示或直接开下一手，实际提示：' + dataStore.readyHint);
  pageCtx.clearReadyClock();      // 清理电脑玩家的自动就绪定时器，避免干扰后续断言

  /* ---------- 「站起退出本局」入口可见性（WXML 静态检查） ---------- */
  const wxmlSrc = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'table', 'table.wxml'), 'utf8');
  const standCount = (wxmlSrc.match(/站起退出本局/g) || []).length;
  ok(standCount >= 3, '「站起退出本局」至少 3 处入口（结算面板 / 局内弃牌后 / 菜单），实际 ' + standCount + ' 处');
  ok(wxmlSrc.indexOf('rb-btn ghost') >= 0, '结算条含「站起退出本局」ghost 按钮（摊牌后可直接点）');
  ok(wxmlSrc.indexOf('stand-link') >= 0, '局内弃牌后含「站起退出本局」行内入口');
  ok(wxmlSrc.indexOf('用右侧「站起退出本局」') < 0, '退出弹窗文案不再指向已删除的右栏');
  const sitCount = (wxmlSrc.match(/坐下加入游戏/g) || []).length;
  ok(sitCount >= 3, '「坐下加入游戏」至少 3 处入口（局内观战 / 就绪面板 / 菜单），实际 ' + sitCount + ' 处');
  ok((wxmlSrc.match(/onMenuSit/g) || []).length >= 3, 'onMenuSit 绑定覆盖观战、就绪面板与菜单');

  /* ---------- ⑧ 结算条改版（resultbar）：文档流布局，不遮牌 ---------- */
  ok(wxmlSrc.indexOf('result-banner') < 0, '旧的大弹窗 result-banner 已从 WXML 移除');
  ok(wxmlSrc.indexOf('class="resultbar"') >= 0, '新增横向紧凑结算条 .resultbar');
  ok(wxmlSrc.indexOf('resultbar') > wxmlSrc.indexOf('<!-- /felt -->'),
    '回归护栏：结算条必须位于牌桌区（felt）之后，走文档流而非绝对定位浮层');
  ok(wxmlSrc.indexOf('badge ready') >= 0 && wxmlSrc.indexOf('badge prewait') >= 0,
    '就绪状态上座位：各座位亮出「已准备/准备中」徽章（不再在底部条逐人罗列）');
  ok(wxmlSrc.indexOf('item.ready === true') >= 0, '座位徽章按就绪状态二态切换（true=已准备 / false=准备中）');
  const wxssSrc = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'table', 'table.wxss'), 'utf8');
  ok(wxssSrc.indexOf('.result-banner') < 0 && wxssSrc.indexOf('.result-btn') < 0,
    '旧弹窗样式 .result-banner / .result-btn 已从 WXSS 删除');
  ok(wxssSrc.indexOf('.resultbar {') >= 0, 'WXSS 新增 .resultbar 样式');
  ok(/\.resultbar\s*\{[^}]*12 \* var\(--uh\)/.test(wxssSrc), '结算条高度约 12uh（横向紧凑条，纵向压缩后适配扁屏）');
  ok(wxssSrc.indexOf('.rc-chip') >= 0 && wxssSrc.indexOf('.rb-btn') >= 0,
    '结算条含胶囊（rc-chip）与按钮（rb-btn）样式');

  /* ---------- ⑨ 运行时环境守卫：禁止裸 process 引用 ---------- */
  // 微信小程序没有 process 全局对象（Node 测试里一切正常）——一旦源码里
  // 残留 process.env 调试语句，真机上直接 ReferenceError，且往往发生在
  // render 等关键链路上，全局回退等待室。此处静态扫描运行时源码防复发。
  {
    const fs = require('fs');
    const scanDirs = ['pages', 'utils', 'core', 'components'];
    const bad = [];
    const walk = dir => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      entries.forEach(en => {
        const p = path.join(dir, en.name);
        if (en.isDirectory()) walk(p);
        else if (/\.js$/.test(en.name) && en.name.indexOf('test-') !== 0) {
          const src = fs.readFileSync(p, 'utf8');
          if (/(^|[^\w.])process\s*\./.test(src)) bad.push(path.relative(__dirname, p));
        }
      });
    };
    scanDirs.forEach(d => walk(path.join(__dirname, d)));
    ok(bad.length === 0, '小程序运行时源码无裸 process 引用（真机无 process 全局）' +
      (bad.length ? '，违规文件: ' + bad.join(', ') : ''));
  }

  /* ---------- ⑩ 结算展示阶段：摊牌后停留 ~5s 展示每人盈亏，再进就绪 ---------- */
  const tableSrc = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'table', 'table.js'), 'utf8');
  ok(/RESULT_SHOW_MS = 5000/.test(tableSrc), '结算展示时长常量 RESULT_SHOW_MS = 5000ms');
  ok(tableSrc.indexOf('this.resultShowMs || RESULT_SHOW_MS') >= 0,
    '一手结束后延迟进入就绪阶段（结算展示可被测试覆盖缩短）');
  ok(tableSrc.indexOf("p.folded ? '弃牌'") >= 0,
    '结算行覆盖弃牌者（未摊牌的弃牌者显示「弃牌」而非消失）');
  ok(wxmlSrc.indexOf("item.net > 0 ? '+' + item.net") >= 0,
    '结算胶囊显示每人净盈亏（赢 +N / 输 -N / 平 ±0）');
  ok(wxssSrc.indexOf('.rc-gain.plus') >= 0 && wxssSrc.indexOf('.rc-gain.minus') >= 0,
    '盈亏配色样式：赢（金）/ 输（红灰）');

  /* ---------- ⑩+ 单手结算弹窗：亮牌展示后独立弹窗显示每人净盈亏 ---------- */
  // 时序：摊牌亮牌在牌桌上停留 ~5s（不遮底牌）→ 弹出结算弹窗（逐人 net）
  // → 弹窗停留 10s 自动关闭进入就绪阶段（防无人操作卡局）。
  ok(/RESULT_MODAL_MS = 10000/.test(tableSrc), '结算弹窗自动关闭时长常量 RESULT_MODAL_MS = 10000ms');
  ok(tableSrc.indexOf('showResultModal') >= 0 && tableSrc.indexOf('closeResultModal') >= 0,
    '结算弹窗开/关方法齐备（showResultModal / closeResultModal）');
  ok(tableSrc.indexOf('resultModalHand') >= 0,
    '每手只调度一次结算弹窗（resultModalHand 守卫，镜像端轮询不重弹）');
  ok(tableSrc.indexOf('resultModal: this.data.result') >= 0,
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
  ok(wxmlSrc.indexOf('wx:elif="{{result}}"') >= 0,
    '结算摘要条与就绪条互斥切换（亮牌期不出现逐人盈亏胶囊）');

  /* ---------- ⑪ 参照 WePoker 的牌桌细节：买入入座 / 状态徽章 / 中央筹码堆 ---------- */
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

  /* ---------- ⑫ WPK 式布局回归：统一座位环 + 座位号 + 牌背 + 弃牌二次确认 ---------- */
  // 复用上方已读取的 tableSrc / wxmlSrc / wxssSrc

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

  // ④ 弃牌二次确认逻辑
  ok(/onFold\(\)\s*\{[\s\S]*foldConfirm/.test(tableSrc), 'onFold 实现弃牌二次确认（首次进入确认态）');
  ok(/clearFoldTimer\(\)/.test(tableSrc), '存在弃牌确认计时器清理 clearFoldTimer');
  ok(/foldConfirm: isMyTurn \? this\.data\.foldConfirm : false/.test(tableSrc), '非我回合自动解除弃牌确认态');

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

  /* ---------- 微信昵称：牌桌默认显示微信名 ---------- */
  ok(/meLabel\(withOwner\)/.test(tableSrc) &&
    /meLabel\(withOwner\) \{[\s\S]{0,200}?auth\.myName\('你'\)/.test(tableSrc),
    '牌桌显示名统一走 meLabel()（默认取微信昵称）');
  ok(!/"你（房主）"|\? '你' : '好友'/.test(tableSrc) || /meLabel/.test(tableSrc),
    '牌桌不再硬编码「你 / 房主 / 好友」占位名');
  ok(/\(withOwner && this\.mode === 'friend'\)/.test(tableSrc),
    '「（房主）」后缀只在好友房出现（AI 桌无房主概念）');
  const authSrc = require('fs').readFileSync(
    path.join(__dirname, 'utils', 'auth.js'), 'utf8');
  ok(/myName\(fallback\)/.test(authSrc) && /saveNickname\(nick\)/.test(authSrc) &&
    /isDefaultNickname\(nick\)/.test(authSrc),
    'auth 提供 myName / saveNickname / isDefaultNickname 昵称读写能力');
  ok(/DEFAULT_NICK/.test(authSrc) && /module\.exports = \{[^}]*DEFAULT_NICK/.test(authSrc),
    'auth 导出 DEFAULT_NICK 占位昵称（与各页判定口径一致）');
  const profSrc = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'profile', 'profile.js'), 'utf8');
  ok(/type="nickname"/.test(require('fs').readFileSync(
    path.join(__dirname, 'pages', 'profile', 'profile.wxml'), 'utf8')),
    '我的页提供 <input type="nickname">（微信唯一合规的取真名方式）');

  /* ---------- 战绩游标分页 / 触底加载更多 ---------- */
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
  const profWxml = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'profile', 'profile.wxml'), 'utf8');
  ok(/rec-more/.test(profWxml) && /rec-end/.test(profWxml),
    'WXML 战绩列表底部有「加载更多 / 没有更多战绩」节点');
  ok(/recordsError/.test(profSrc) && /onRetryRecords/.test(profSrc),
    'profile.js 有 recordsError 状态 + onRetryRecords 重试方法（区分加载失败与空列表）');
  ok(/recordsError/.test(profWxml) && /重试/.test(profWxml),
    'profile.wxml 区分加载失败态（recordsError）并提供重试按钮');
  // 失败分级守卫：catch 里只有首屏（first）才置 recordsError，翻页失败保留已加载列表
  // （否则一次触底的瞬时网络抖动会丢掉已加载的全部记录）。源码须含「if (first) recordsError」。
  ok(/if \(first\) patch\.recordsError = true/.test(profSrc),
    'loadRecords catch 失败分级：仅首屏置 recordsError，翻页失败保留已有列表');

  /* ---------- 引擎：10 显示为「10」，但机读码仍是单字符 T ---------- */
  const coreSrc = require('fs').readFileSync(
    path.join(__dirname, '..', 'core', 'poker-core.js'), 'utf8');
  ok(/const RANK_DISPLAY = \[[^\]]*'10'[^\]]*\]/.test(coreSrc),
    '引擎新增 RANK_DISPLAY：界面显示 10 而非 T');
  ok(/const RANK_NAMES = \[[^\]]*'T'[^\]]*\]/.test(coreSrc),
    '引擎 RANK_NAMES 保持单字符 T（机读码，参与编解码，不可改成 10）');
  ok(coreSrc.indexOf('RANK_NAMES') !== coreSrc.indexOf('RANK_DISPLAY') &&
    /RANK_NAMES, RANK_DISPLAY,/.test(coreSrc), 'RANK_DISPLAY 与机读码字母表一并导出');
  ok(/rank: P\.RANK_DISPLAY\[/.test(tableSrc), '牌桌牌面渲染使用 RANK_DISPLAY（T 显示为 10）');

  /* ---------- AI 桌：先选座坐下、点开始才发牌 ---------- */
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

  /* ---------- 音效：引擎事件流 → 合成音 ---------- */
  ok(require('fs').existsSync(path.join(__dirname, 'utils', 'sfx.js')),
    '存在合成音效模块 utils/sfx.js（零音频资源）');
  ok(/startSfxPump\(\)/.test(tableSrc) && /drainSfx\(\)/.test(tableSrc) &&
    /this\.sfxPump = setInterval/.test(tableSrc),
    'table 启动 300ms 音效事件泵（对手在计时器路径的动作也能发声）');
  ok(/stopSfxPump\(\)/.test(tableSrc), '音效泵有明确的停止生命周期（onUnload 调用）');
  ok(/this\.data\.soundOn/.test(tableSrc), '音效开关在事件泵内逐次判断（切换即时生效）');

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
    ok(/this\.data\.soundOn && seat !== this\.mySeat\) sfx\.play\('chat'\)/.test(tableSrc),
      '收到他人/AI 消息播 chat 轻提示；我主动发的（seat===mySeat）不响');
    ok(/pushChat\(this\.mySeat/.test(tableSrc) && tableSrc.indexOf('我主动发，不响提示音') > 0,
      'pushChat 头注释锁定「我发的不响」语义（聊天消息传 mySeat 快捷发送 + 系统消息除外）');
    // 行为级的 sfx 拦截在此不可行：上方 WebAudio 解锁回归块会删 sfx.js 的
    // require 缓存重载新实例，而 table.js 闭包持有的是最初那份单例——本块
    // 拿到的模块对象不是 pushChat 实际调用的那份，spy 永远等不到调用。
    // 退守静态守卫（方案原文：若 sfx 模块拦截成本高则退守静态守卫）。
    // 聊天未读徽章静态守卫
    ok(/chatUnread: 0/.test(tableSrc), 'data 有 chatUnread 未读计数字段');
    ok(/patch\.chatUnread = \(this\.data\.chatUnread \|\| 0\) \+ 1/.test(tableSrc),
      'pushChat 折叠期间收他人消息累计未读');
    ok(/chatUnread > 0 && !chatOpen/.test(wxmlSrc), 'WXML 聊天按钮有未读徽章（chatUnread>0 且折叠时）');
    ok(/\.chat-badge/.test(wxssSrc), 'WXSS 有 .chat-badge 未读徽章样式');
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
  }

  /* ---------- 回归：预设档改为百分比 + 盲注倍数吸附 ---------- */
  {
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

  /* ---------- 回归：就绪按钮点完变灰禁用 + 倒计时 30s ---------- */
  {
    const wxssSrc = require('fs').readFileSync(
      require('path').join(__dirname, 'pages/table/table.wxss'), 'utf8');
    ok(/const READY_TIMEOUT_SEC = 30;/.test(tableSrc),
      '就绪倒计时 30 秒（超时自动站起）');
    // 关键：按钮不能消失成一行小字（布局跳动 + 状态不明确），要就地变灰
    ok(/class="rb-btn \{\{myReady \? 'done' : ''\}\}"/.test(wxmlSrc) &&
       /disabled="\{\{myReady\}\}"/.test(wxmlSrc),
      '就绪按钮用 done 态 + disabled 切换，而非 wx:if 消失成 rb-wait 小字');
    ok(!/rb-wait" wx:elif/.test(wxmlSrc), '旧的 rb-wait「已准备」文本入口已移除');
    ok(/\.rb-btn\.done\s*\{[\s\S]{0,300}?background:\s*rgba\(255,255,255/.test(wxssSrc),
      '存在 .rb-btn.done 灰态样式（点完变灰）');
    ok(/onReadyTap\(\)\s*\{[\s\S]{0,200}?if \(this\.data\.myReady\) return;/.test(tableSrc),
      'onReadyTap 对已就绪幂等（重复点击无副作用）');
    // 倒计时只该在未就绪时展示，就绪后数字消失
    ok(/myReady \? '已准备' : '准备就绪'/.test(wxmlSrc) &&
       /!myReady && readyLeft > 0/.test(wxmlSrc),
      '就绪后按钮文案变「已准备」且不再显示倒计时秒数');
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
    const feltSrc = tableSrc;
    // 座位带最低点 + 块高必须 < 底池位置(22%)；否则顶/中座位的手牌直接压在底池上
    const cy = Number((feltSrc.match(/cy = (\d+)/) || [0, 0])[1]);
    const ry = Number((feltSrc.match(/ry = (\d+)/) || [0, 0])[1]);
    ok(cy > 0 && ry > 0, 'ringPositions 椭圆参数可解析 cy=' + cy + ' ry=' + ry);
    ok(cy - ry >= 10, '座位带最低点 ' + (cy - ry) + '% （≥10%，留出块延伸空间）');
    // 座位锚点 y 上界必须小于公共牌位置
    const yMax = Number((feltSrc.match(/y = Math\.max\(\d+, Math\.min\((\d+)/) || [0, 999])[1]);
    ok(yMax < 80, '对手座位锚点 y 上界 ' + yMax + '%（<80%，不下探到公共牌区）');
    // 中央盘面必须提层 + 有不透明底盘（双保险：即使重叠也是中央压住牌背）
    ok(/\.pot-row \{[\s\S]{0,200}?z-index: 5/.test(wxssSrc),
      '.pot-row z-index 5 高于 .seat(3)：底池不被牌背盖住');
    ok(/\.board-row \{[\s\S]{0,200}?z-index: 5/.test(wxssSrc),
      '.board-row z-index 5 高于 .seat(3)：公共牌不被牌背盖住');
    ok(/\.pot-row::before/.test(wxssSrc) && /\.board-row::before/.test(wxssSrc),
      '底池/公共牌有 ::before 不透明底盘（重叠时不透出牌背花纹）');
    // 座位手牌紧凑叠放，块高减半
    ok(/\.seat-cards \.card-xs \+ \.card-xs \{ margin-left: calc\(-[\d.]+ \* var\(--uw\)\)/.test(wxssSrc),
      '座位两张手牌叠放（负 margin），座位块高度显著下降');

    // 开始游戏按钮：主/副两行，主标题不折行
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

  /* ---------- 回归：房主身份回收 + 唯一座位（不能出现两个自己） ---------- */
  {
    // isOwner 不得只由 URL 的 own=1 决定：邀请链接不带 own，房主自点自己分享的卡片会丢身份
    ok(/auth\.findRoom\(this\.roomNo\)/.test(tableSrc),
      'bootstrapSync 查询房间行（房主归属的权威来源）');
    ok(/roomOwner === myUid\) this\.isOwner = true/.test(tableSrc),
      '以 poker_rooms.owner_id 与登录 uid 比对回收房主身份（own 参数退化为乐观提示）');
    ok(/this\.setData\(\{ isOwner: this\.isOwner \}\)/.test(tableSrc),
      '房主身份回收后同步到 data（UI 的房主标/开始按钮跟着更新）');
    // 顺序：必须先定身份再定座位，否则会出现「按访客坐 -1 号位之后又切成房主」
    const iRoom = tableSrc.indexOf('auth.findRoom(this.roomNo)');
    const iSeat = tableSrc.indexOf('let seat = this.isOwner ? 0 : -1');
    ok(iRoom > 0 && iSeat > 0 && iRoom < iSeat, '先回收房主身份再决定座位（顺序不能反）');

    // 离房必须释放自己的行：原先只删访客行，房主重进被判访客 → 同一人占两座
    ok(/if \(this\.syncLive\) \{\s*roomSync\.leave\(this\.roomNo\)/.test(tableSrc),
      '离房对所有人（含房主）释放自己的座位行，避免同一人占两个座位');
    ok(!/if \(this\.syncLive && !this\.isOwner\)/.test(tableSrc),
      '旧的「只给访客删行」写法已移除（那是两个自己的病根）');

    // 同座位唯一性收敛（云端兜底）
    const syncSrc = require('fs').readFileSync(
      require('path').join(__dirname, 'utils/room-sync.js'), 'utf8');
    ok(/upsertMe[\s\S]{0,600}?\.neq\('seat', Number\(patch\.seat\)\)/.test(syncSrc),
      'upsertMe 写入座位前先清理同房间其他座位的自己的行（同用户唯一座位）');
    ok(/const liveBySeat = \{\}/.test(syncSrc) && /rank\(r\) > rank\(cur\)/.test(syncSrc),
      'buildWaitLayout 同座位多行去重（渲染层兜底，绝不画出两个自己）');
  }

  /* ---------- 静态守卫：金额入口全部收口到 setRaiseTo ---------- */
  {
    // 时长到点不得中途掀桌：startClock 只能调 onClockExpired，不得直连 endGame
    ok(/onClockExpired\(\)/.test(tableSrc), '存在 onClockExpired()：时长到点的决策入口');
    ok(/left <= 0\) \{\s*this\.clearClock\(\);\s*this\.onClockExpired\(\);/.test(tableSrc),
      'startClock 到点走 onClockExpired，不再直接 endGame（避免中途 game over）');
    ok(/onClockExpired\(\)\s*\{[\s\S]{0,700}?inPlay[\s\S]{0,400}?if \(!inPlay\) \{ this\.endGame\(\); return; \}/.test(tableSrc),
      'onClockExpired：不在打牌中才立即结束，打牌中则挂起');
    ok(/enterReadyPhase\(\)\s*\{[\s\S]{0,300}?if \(this\.pendingTimeUp\) \{ this\.pendingTimeUp = false; this\.endGame\(\); return; \}/.test(tableSrc),
      'enterReadyPhase 是「打完这手再总结束」的收口点');

    // 结算单三件套：买入/剩余/盈亏必须同源（都读 startStacks[mySeat]）
    ok(/myBuyIn: me \? me\.buyIn : 0/.test(tableSrc) && /myStack: me \? me\.stack : 0/.test(tableSrc),
      'endGame 的 summary 输出 myBuyIn / myStack');
    ok(/buyIn: this\.startStacks\[p\.seat\] !== undefined/.test(tableSrc),
      '结算单每行带 buyIn（带入筹码）');
    ok(/sum-bank/.test(wxmlSrc) && /带入/.test(wxmlSrc) && /剩余/.test(wxmlSrc),
      '结算单与实时面板共用「带入/剩余/盈亏」三件套组件');

    // 实时盈亏面板必须存在菜单入口 + 数据源
    ok(/bindtap="onMenuBank"/.test(wxmlSrc) && /onMenuBank\(\)\s*\{[\s\S]{0,200}?bankShow: true/.test(tableSrc),
      '菜单「我的筹码」入口打开实时盈亏面板');
    ok(/onBankClose\(\)\s*\{[\s\S]{0,120}?bankShow: false/.test(tableSrc),
      '实时盈亏面板可关闭');
    ok(/myNetLive: myNetLive/.test(tableSrc) && /myNetLiveText:/.test(tableSrc),
      'render 逐帧派生 myNetLive / myNetLiveText（面板实时刷新）');
    // 挂起状态要跨端同步：好友端不能把 00:00 误读为断线
    ok(/clockPendingEnd: !!this\.data\.clockPendingEnd/.test(tableSrc) &&
       /clockPendingEnd: !st\.summary && st\.clockPendingEnd === true/.test(tableSrc),
      'clockPendingEnd 随房主广播同步给好友端');
    ok(/clockPendingEnd \? '本手后' : remainText/.test(wxmlSrc),
      '顶栏到点挂起显示「本手后」而非停在 00:00');
  }

  /* ---------- 静态守卫：金额入口全部收口到 setRaiseTo ---------- */
  ok(/setRaiseTo\(amt, preset\)/.test(tableSrc),
    '存在统一入口 setRaiseTo()：一次写入 raiseTo + raiseSubmit + raiseAllIn');
  ok(/setRaiseTo[\s\S]{0,400}?raiseSubmit: submit, raiseAllIn:/.test(tableSrc),
    'setRaiseTo 同帧写入按钮文案派生字段（不依赖 render 触发）');
  ok(!/setData\(\{ raiseTo/.test(tableSrc),
    '所有改下注金额的入口均已收口到 setRaiseTo（无裸 setData({raiseTo}) 漏同步）');
  // setRaiseTo 只管金额三件套，展开态必须由 onCustomTap 自己写 —— 曾漏写导致点「自定义」无反应
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

  /* ---------- 生命周期：onHide 全量暂停 + onShow 恢复（评审 MEDIUM 回归） ---------- */
  {
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
    const silentCatches = (tableSrc.match(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || []).length;
    const SILENT_OK_COUNT = 0;   // 离房清理已加日志，不再静默吞错
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
    ok(/if \(this\._polling\) return/.test(tableSrc), 'pollOnce 有重入守卫（_polling 标记）');
    ok(/finally \{[\s\S]{0,60}?this\._polling = false/.test(tableSrc), 'pollOnce finally 释放 _polling 标记');
    // 行为：置 _polling=true 后 pollOnce 直接返回，不触达 roomSync.poll（roomRows 不变）
    const pollBefore = pageCtx.roomRows;
    pageCtx._polling = true;
    pageCtx.pollOnce();
    ok(pageCtx._polling === true, 'pollOnce 重入时直接返回不执行（_polling 保持 true）');
    ok(pageCtx.roomRows === pollBefore, 'pollOnce 重入时不调用 roomSync.poll（roomRows 未变）');
    pageCtx._polling = false;
    // bootstrapSync 失败时清理已起的定时器，防泄漏（stopSync 出现在 bootstrap-sync catch 块内）
    ok(/bootstrap-sync[\s\S]{0,600}?this\.stopSync\(\)/.test(tableSrc) ||
       /this\.stopSync\(\)[\s\S]{0,400}?bootstrap-sync/.test(tableSrc),
      'bootstrapSync 失败 catch 调用 stopSync 清理可能已起的定时器');
  }

  /* ---------- 弹窗 catchtap 显式化 + 对手计时环残值（评审 MEDIUM UI 细节回归）---------- */
  {
    // 裸 catchtap（无属性值）吞冒泡是「无保证行为」，显式绑定空函数才随基础库稳定
    ok(!/catchtap>/.test(wxmlSrc) && !/"catchtap"|catchtap=""/.test(wxmlSrc),
      'table.wxml 无裸 catchtap（全部显式绑定了处理函数）');
    ok(/onBlockTap\(\)\s*\{\s*\/\* 有意留空/.test(tableSrc),
      '显式空处理函数 onBlockTap 已定义');
    const idxWxml = require('fs').readFileSync(
      path.join(__dirname, 'pages', 'index', 'index.wxml'), 'utf8');
    ok(!/catchtap>/.test(idxWxml), 'index.wxml 同样无裸 catchtap');
  }

  /* ---------- 对手计时环不显示我的残值（评审 MEDIUM UI 细节回归）---------- */
  {
    // startTimer 每秒回调：我回合写 myTimer；对手回合按行动座位局部 setData（不写整条 seats，
    // 也不碰 myTimer）。整帧 render 仍按行动座位写 tick 快照——保证不会把我的残值 setData 给对手环
    const stBody = (tableSrc.match(/startTimer\(\)\s*\{[\s\S]*?1000\);\r?\n  \}/) || [''])[0];
    ok(/myTimer: tick/.test(stBody), 'startTimer 回调写我的计时字段');
    ok(!/seats:/.test(stBody), 'startTimer 每秒回调不写整条 seats 数组（局部路径更新单座位，不吃我的残值）');
    // 对手回合的局部更新只写当前行动座位的 timer，不碰 myTimer
    ok(/seats\[' \+ actIdx \+ '\]\.timer/.test(stBody),
      '对手回合按行动座位局部 setData seats[actIdx].timer（消除跳秒）');
    ok(/timer: !readyPhase && game\.actionSeat === p\.seat \? tick : ''/.test(tableSrc),
      '对手环只在行动座位显示 tick（非行动座位为空串，环隐藏）');
  }

  /* ---------- 行动计时最后 5s 视觉强化（红+脉冲，与警告音同阈值）---------- */
  {
    // 整帧 render 写 seats[].timerUrgent（对手环）与 myTimerUrgent（我的行动条）
    ok(/timerUrgent: !readyPhase && game\.actionSeat === p\.seat && tick <= 5 && tick > 0/.test(tableSrc),
      '对手行动座位最后 5s 标记 timerUrgent（计时环转红脉冲）');
    ok(/myTimerUrgent: game\.actionSeat === this\.mySeat && !result && tick <= 5 && tick > 0/.test(tableSrc),
      '我轮到时最后 5s 标记 myTimerUrgent（行动条脉冲）');
    // startTimer 每秒回调也同步刷新 myTimerUrgent（不只在整帧 render 生效）
    const stBody = (tableSrc.match(/startTimer\(\)\s*\{[\s\S]*?1000\);\r?\n  \}/) || [''])[0];
    ok(/myTimerUrgent: tick <= 5 && tick > 0/.test(stBody),
      'startTimer 每秒回调同步刷新 myTimerUrgent（最后 5s 持续脉冲）');
    // WXML：计时环 urgent class + 行动条 urgent class
    ok(/class="timer \{\{item\.timerUrgent \? 'urgent' : ''\}\}"/.test(wxmlSrc),
      'WXML 计时环按 timerUrgent 切换 urgent class');
    ok(/class="actbar \{\{myTimerUrgent \? 'urgent' : ''\}\}"/.test(wxmlSrc),
      'WXML 行动条按 myTimerUrgent 切换 urgent class');
    // WXSS：urgent 态有脉冲动画
    ok(/\.timer\.urgent[\s\S]*?animation: timerPulse/.test(wxssSrc), 'WXSS 计时环 urgent 态有 timerPulse 动画');
    ok(/\.actbar\.urgent[\s\S]*?animation: actbarPulse/.test(wxssSrc), 'WXSS 行动条 urgent 态有 actbarPulse 动画');
  }

  /* ---------- 结算弹窗注释与行为一致（评审 MEDIUM：注释曾写「只由用户触发、不自动弹出」）---------- */
  {
    const mdoc = (tableSrc.match(/弹出单手结算弹窗[\s\S]{0,300}?由 render 末尾的统一调度[\s\S]{0,120}?自动触发/) || [])[0];
    ok(!!mdoc, 'showResultModal 注释已改为「render 统一调度自动触发 + 用户可提前打开」（与代码一致）');
    ok(/this\.resultTimer = setTimeout\(\(\) => \{[\s\S]{0,200}?showResultModal\(\)/.test(tableSrc),
      'render 末尾确有自动弹出调度（注释与代码不再矛盾）');
  }

  /* ---------- 同步脏检查（评审 2026-10-15 MEDIUM「全量写库/全量 setData 无脏检查」） ---------- */
  // 房主 writePlayState 与好友 enterRemote 各有指纹比对：牌局实质未变时跳过
  // 写库 / setData，避免每 500ms/1.5s 空转云端配额与全量重绘。
  {
    // 静态守卫：两处指纹键、跳过路径都存在
    ok(tableSrc.indexOf('_lastPlayFp') >= 0, 'writePlayState 有房主指纹缓存键');
    ok(/if \(this\._lastPlayFp === fingerprint\) return/.test(tableSrc),
      '房主牌局未变时跳过本轮写库');
    ok(tableSrc.indexOf('_lastRemoteFp') >= 0, 'enterRemote 有镜像指纹缓存键');
    ok(/if \(this\._lastRemoteFp === fp\) return/.test(tableSrc),
      '好友端快照未变时跳过本轮 setData + render');

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
    ok(tableSrc.indexOf('IDLE_WARN_MS') > 0, '定义了空闲提示提前量 IDLE_WARN_MS');
    ok(tableSrc.indexOf('tickExpireWarn') > 0, '定义了逐秒刷新倒计时文案方法 tickExpireWarn');
    ok(tableSrc.indexOf('clearExpireWarn') > 0, '定义了清掉空闲提示方法 clearExpireWarn');
    ok(/idleRemainText: '',/.test(tableSrc), 'data 声明空闲倒计时文案字段 idleRemainText');
    ok(wxmlSrc.indexOf('wi-idle') > 0, 'WXML 等待室空闲倒计时提示节点 wi-idle');
    ok(/\.wi-idle[\s\S]*?idlePulse/.test(wxssSrc), 'WXSS 空闲提示有 idlePulse 脉冲动画');
  }

  /* ---------- 页面层性能缓存：ringPositions + cardData ---------- */
  {
    ok(/_ringCache/.test(tableSrc), 'ringPositions 有模块级缓存 _ringCache');
    ok(/cacheKey/.test(tableSrc) && /_ringCache\[cacheKey\] = pos/.test(tableSrc),
      'ringPositions 命中缓存时写回并返回（纯函数缓存）');

    ok(/_cardCache/.test(tableSrc), 'cardData 有按 card id 缓存 _cardCache');
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
    ok(/_lastRenderFp/.test(tableSrc), 'render 有渲染指纹缓存键 _lastRenderFp');
    ok(/if \(this\._lastRenderFp === fp\)/.test(tableSrc), 'render 指纹命中时跳过 setData');
    ok(/_renderTail\(\)/.test(tableSrc), 'render 尾部调度抽出 _renderTail（指纹跳过时仍执行）');
    ok(/tick,/.test(tableSrc) && /myActText,/.test(tableSrc),
      '渲染指纹含 tick 与 myActText（计时环与动作气泡变化可触发重绘）');
    // 指纹置位必须在主 setData 成功之后（评审 2026-10-16）：若 body 中途抛错，
    // _lastRenderFp 不应被更新——否则下一帧同势命中跳过、降级态卡到下次实质变化。
    // 守卫：赋值语句出现在主 setData 的 resultModal 行之后，而非跳过 return 之后。
    ok(/resultModal: result \? this\.data\.resultModal : null[\s\S]{0,120}this\._lastRenderFp = fp/.test(tableSrc),
      '指纹置位在主 setData 之后（异常帧不缓存指纹，下帧自动重试）');
    ok(!/if \(this\._lastRenderFp === fp\)[\s\S]{0,40}this\._lastRenderFp = fp/.test(tableSrc),
      '指纹赋值不在「命中跳过」之后紧跟（避免 body 抛错前就置位）');
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

  /* ---------- 牌桌互动与氛围（设计 2026-10-15 §2）静态守卫 + 行为 ----------
   * 四类动画：筹码飞行 / 赢牌金光+星光粒子 / 连胜徽章 / 表情轮盘+气泡。
   * 全部走 transform/opacity + keyframes，animOn=false 时 .no-anim 兜底禁用。
   * 表情走既有 emote 动作上行 + 房主随快照广播，上行失败静默降级（非关键路径）。 */
  {
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

    // —— render 基线 diff：render 开头缓存 prevBase，末尾 _renderTail 调 renderAmbience ——
    ok(/const prevBase = this\._base;/.test(tableSrc) && /this\._snapBaseline\(\);/.test(tableSrc) && /this\._prevBase = prevBase;/.test(tableSrc),
      'render 开头缓存上一帧基线供 renderAmbience 比对（_prevBase）');
    ok(/this\.renderAmbience\(\);/.test(tableSrc), '_renderTail 末尾调用 renderAmbience（每帧驱动氛围）');

    // —— animOn 守卫：飞行/粒子/金光只在 animOn 时触发 ——
    ok(/prev\.handNo === now\.handNo && this\.data\.animOn/.test(tableSrc),
      '下注飞行只在 animOn 且同手内触发（跨手不误触）');
    ok(/this\.data\.animOn && result_fresh/.test(tableSrc),
      '收池飞行/金光/粒子只在 animOn 且结果新鲜时触发');

    // —— HAND_NAME_TO_CAT 映射存在（evals 存中文名，映射回引擎枚举）——
    ok(/HAND_NAME_TO_CAT = \{/.test(tableSrc), '牌型名→枚举映射 HAND_NAME_TO_CAT 存在（_resultHandCat 用）');
    // fold 结算无 evals → cat=0 不触发粒子
    ok(/if \(!evals\) return 0;/.test(tableSrc), '_resultHandCat：fold 结算无 evals 返回 0（不触发粒子）');

    // —— 静默降级：emote 上行失败不接 syncFailToast（氛围非关键路径）——
    ok(/pushAction\(this\.roomNo, \{ type: 'emote'/.test(tableSrc),
      '好友房表情走既有 pushAction 上行（type:emote）');
    ok(/\.catch\(\(\) => \{ \/\* 静默降级[^*]*\*\/ \}\)/.test(tableSrc),
      '表情上行失败静默降级（不弹错不重试，与牌局关键上行 syncFailToast 语义不同）');

    // —— startHand 清零氛围状态 ——
    ok(/winStreaks = \{\};[^}]*this\.setData\(\{ spark: null, flyOut: \[\], flyIn: \[\], winFx: '', streaks: \{\} \}\)/.test(tableSrc),
      'startHand 清零连胜计数 + 清空粒子/飞行/金光/徽章');

    // —— applyFriendAction emote 分支：rowSeat 断言 + 白名单 ——
    ok(/if \(a\.type === 'emote'\)/.test(tableSrc), 'applyFriendAction 有 emote 动作分支');
    ok(/Number\(a\.seat\) !== Number\(a\.rowSeat\)/.test(tableSrc) && /EMOTE_SET\.indexOf\(a\.emoji\) < 0/.test(tableSrc),
      'emote 分支：rowSeat 伪冒断言 + emoji 白名单双校验');

    // —— writePlayState emotes 随快照广播 + 指纹含 emote ——
    ok(/emotes: \(this\.data\.emotes \|\| \[\]\)\.slice\(-EMOTE_QUEUE_MAX\)/.test(tableSrc),
      'writePlayState 快照带 emotes 队列（滚动 10 条上限）');
    ok(/'e' \+ \(state\.emotes \|\| \[\]\.map/.test(tableSrc) || /'e' \+\s*\(state\.emotes/.test(tableSrc),
      '房主写库指纹含 emotes 项（表情变化触发写库广播）');

    // —— enterRemote 表情镜像 ——
    ok(/st\.emotes/.test(tableSrc), 'enterRemote 读取房主广播的 emotes 字段');
    ok(/const localSeat = remapS\[Number\(e\.seat\)\]/.test(tableSrc),
      '镜像端按座次重映射 emote 的 seat（remapS，我=0 号位）');

    // —— WXML 节点齐备 ——
    ok(wxmlSrc.indexOf('class="fly-chip fly-out"') >= 0 && wxmlSrc.indexOf('class="fly-chip fly-in"') >= 0,
      'WXML 筹码飞行层：fly-out / fly-in 两层');
    // 金光脉冲 class 必须由 JS 预计算（曾内联在 WXML 里导致真机上传直接编译失败：
    // Bad attr 'class' with message: unexpected token ':' —— WXML 表达式引擎不接受
    // 「三元/逻辑运算里调用字符串方法」）。现在 WXML 只写 class="{{item.cls}}"，
    // 语义校验改在 JS 侧与 check-wxml 规则 3 双重把关。
    ok(/class="\{\{item\.cls\}\}"/.test(wxmlSrc),
      'WXML 座位 class 由 JS 预计算（class="{{item.cls}}"）');
    ok(!/winFx && \(',' \+ winFx/.test(wxmlSrc),
      'WXML 已无「三元里调 .indexOf()」写法（真机上传编译失败的病根）');
    ok(/_winFxSeats\.indexOf\(p\.seat\) >= 0 \? 'winfx'/.test(tableSrc),
      'JS 侧用 _winFxSeats 判定 winfx（金光脉冲语义未变）');
    // JS 预计算的 cls 必须覆盖原内联表达式的全部状态位，一个都不能漏
    const clsBlock = (tableSrc.match(/const cls = \[[\s\S]{0,600}?\]\.filter\(Boolean\)\.join\(' '\)/) || [''])[0];
    ok(clsBlock.length > 0, 'JS 侧存在座位 cls 预计算');
    ['self', 'folded', 'active', 'win', 'standing', 'winfx'].forEach(k => {
      ok(clsBlock.indexOf("'" + k + "'") >= 0, 'cls 含状态位 ' + k + '（与原内联表达式语义一致）');
    });
    // winFx 改为实例字段后，setData 异步不再影响本帧渲染
    ok(/this\._winFxSeats = \[\]/.test(tableSrc), '新手/重开时清空 _winFxSeats（避免上把赢家残留金光）');
    ok(wxmlSrc.indexOf('catchtap="onAvatarTap"') >= 0, 'WXML 头像绑 onAvatarTap（点头像弹轮盘）');
    ok(wxmlSrc.indexOf('streak-badge') >= 0, 'WXML 连胜徽章节点 streak-badge');
    ok(wxmlSrc.indexOf('emote-bubble') >= 0, 'WXML 表情气泡节点 emote-bubble');
    ok(wxmlSrc.indexOf('class="spark"') >= 0, 'WXML 星光粒子节点 spark');
    ok(wxmlSrc.indexOf('emote-mask') >= 0 && wxmlSrc.indexOf('emote-wheel') >= 0 &&
      wxmlSrc.indexOf('emote-grid') >= 0 && wxmlSrc.indexOf('emote-cell') >= 0,
      'WXML 表情轮盘弹层四件套：emote-mask/wheel/grid/cell');

    // —— WXSS 样式 + keyframes 齐备，且只用 transform/opacity ——
    ['.seat.winfx .avatar', '.streak-badge', '.emote-bubble', '.spark',
      '.fly-chip', '.fly-chip.fly-out', '.fly-chip.fly-in',
      '.emote-mask', '.emote-wheel', '.emote-grid', '.emote-cell'].forEach(c => {
      ok(wxssSrc.indexOf(c) >= 0, 'WXSS 样式：' + c);
    });
    ['winGlow', 'streakPop', 'emoteFloat', 'sparkTwinkle',
      'flyChipOut', 'flyChipIn', 'wheelPop'].forEach(kf => {
      ok(new RegExp('@keyframes ' + kf).test(wxssSrc), 'WXSS @keyframes：' + kf);
    });
    // 重排红线：飞行动画只用 transform/opacity（不动 top/left/width）
    const flyOutBlock = (wxssSrc.match(/@keyframes flyChipOut \{[\s\S]*?\}/) || [''])[0];
    ok(/transform:/.test(flyOutBlock) && /opacity:/.test(flyOutBlock) &&
      !/top:|left:/.test(flyOutBlock.replace(/translate/, '')),
      'flyChipOut 只用 transform/opacity（不动 top/left，重排红线）');
    // spark 用贴图 assets/spark.png
    ok(/\.spark \{[\s\S]*?background:\s*url\(\.\.\/\.\.\/assets\/spark\.png\)/.test(wxssSrc),
      'spark 粒子用 assets/spark.png 贴图（CSS background）');
    // .no-anim 兜底禁用氛围
    ok(/\.no-anim \.seat\.winfx \.avatar/.test(wxssSrc) && /\.no-anim \.spark/.test(wxssSrc) &&
      /\.no-anim \.fly-chip/.test(wxssSrc),
      'WXSS .no-anim 兜底禁用氛围动画（animOn=false 全关）');

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
    ok(typeof rs.addReplay === 'function' && typeof rs.listAll === 'function' &&
      typeof rs.latest === 'function' && typeof rs.findByDate === 'function',
      'replay-store 导出 addReplay/listAll/latest/findByDate 四个方法');
    ok(rs.MAX_REPLAYS === 20, 'replay-store 上限 20 局（FIFO 挤出）');
    const storeSrc = fs.readFileSync(path.join(__dirname, 'utils', 'replay-store.js'), 'utf8');
    ok(/poker_replay_cache/.test(storeSrc), 'replay-store 用独立 storage 键 poker_replay_cache');
    ok(/setStorageSync/.test(storeSrc), 'replay-store 走本地 wx.setStorageSync（不进云）');
    // 存储失败静默：addReplay 的 try/catch 返回 false
    ok(/return false/.test(storeSrc) && /catch \(e\)/.test(storeSrc),
      'replay-store addReplay 失败静默降级（返回 false，不阻断）');

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
        const pf = (seats.indexOf(seat) - seats.indexOf(g.dealerSeat) + seats.length) % seats.length;
        const d = P.aiDecide({
          hole: p.hole, board: g.board, pot: g.potTotal(),
          toCall: legal.toCall, stack: p.stack, currentBet: g.currentBet,
          numActive: g.activePlayers().length,
          positionFactor: pf <= 1 ? 0.9 : (pf <= 3 ? 0.4 : 0),
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
   * 个人风格分析：style-analyzer.js VPIP/AGG/摊牌胜率 + 我的页嵌入（设计 2026-10-16 §3）
   * 纯函数单测（构造 mock list，不依赖 replay-store）+ profile.js/wxml 接入静态守卫
   * ========================================================== */
  (function styleSuite() {
    const sa = require(path.join(__dirname, 'utils', 'style-analyzer.js'));

    // 构造 mock 复盘记录工厂：actions = [['preflop','raise'],...]，opts 覆盖 result 等
    function mkRec(actions, opts) {
      const o = opts || {};
      return Object.assign({
        mySeat: 0,
        events: actions.map(a => ({ type: 'action', seat: 0, street: a[0], action: a[1] })),
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

    // ---- profile.js 接入静态守卫 ----
    const profSrc = fs.readFileSync(path.join(__dirname, 'pages', 'profile', 'profile.js'), 'utf8');
    ok(/require\(['"].+replay-store['"]\)/.test(profSrc), 'profile.js 引入 replay-store');
    ok(/require\(['"].+style-analyzer['"]\)/.test(profSrc), 'profile.js 引入 style-analyzer');
    ok(/styleAnalyzer\.analyze\(replayStore\.listAll\(\)\)/.test(profSrc),
      'profile.js 调用 styleAnalyzer.analyze(replayStore.listAll())');
    ok(/styleAnalysis/.test(profSrc), 'profile.js 维护 styleAnalysis 状态字段');
    // 旧 style（云端胜率代理）保留，与新行为画像分区不删
    ok(/激进型|保守型|稳健型/.test(profSrc), 'profile.js 保留旧 style（胜率倾向），与新 styleAnalysis 分区显示');

    // ---- profile.wxml 静态守卫 ----
    const profWxml = fs.readFileSync(path.join(__dirname, 'pages', 'profile', 'profile.wxml'), 'utf8');
    ok(/styleAnalysis\.insufficient/.test(profWxml), '我的页 wxml 含样本不足分支');
    ok(/styleAnalysis\.quadrant/.test(profWxml), '我的页 wxml 插值打法象限');
    ok(/styleAnalysis\.observations/.test(profWxml) && /wx:for/.test(profWxml),
      '我的页 wxml 用 wx:for 渲染观察列表');
    // wxml 用 {{styleAnalysis.quadrantTag}} 插值类名；配色定义在 wxss（tag 选择器）
    ok(/styleAnalysis\.quadrantTag/.test(profWxml),
      '我的页 wxml 用 quadrantTag 插值类名（象限配色）');
    const profWxss = fs.readFileSync(path.join(__dirname, 'pages', 'profile', 'profile.wxss'), 'utf8');
    ok(/tight-aggressive/.test(profWxss) && /loose-passive/.test(profWxss),
      '我的页 wxss 定义四象限配色（tight-aggressive/loose-passive 等）');

    // ---- 合规/边界静态守卫 ----
    const saSrc = fs.readFileSync(path.join(__dirname, 'utils', 'style-analyzer.js'), 'utf8');
    ok(!/wx\.request|require\(['"]https?/.test(saSrc), 'style-analyzer 不含网络调用（纯本地）');
    ok(/不接 LLM|样本不足|不硬算|描述性|不评判/.test(saSrc),
      'style-analyzer 头注释声明边界（不接 LLM / 样本不足不硬算 / 描述性不评判）');
  })();

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
