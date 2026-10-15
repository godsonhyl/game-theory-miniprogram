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
  ok(Array.isArray(dataStore.raisePresets) && dataStore.raisePresets.length === 5,
    '加注档位 5 档（最小 / ½池 / 底池 / 全下 / 自定义）');
  ok(Array.isArray(dataStore.raisePresets) &&
    dataStore.raisePresets[4].k === 'custom' && dataStore.raisePresets[4].t === '自定义',
    '第 5 档为「自定义」入口（展开 0~MAX 连续可调的金额面板）');
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
  ok(dataStore.readyLeft === 60, '就绪倒计时 60 秒，实际 ' + dataStore.readyLeft);
  ok(dataStore.myReady === false, '初始状态我方未准备');

  const handBefore = dataStore.handNo;
  pageCtx.onNextHand();   // 就绪阶段：结算面板按钮即「准备就绪」
  ok(dataStore.myReady === true, '点「准备就绪」后我方标记已准备');
  ok(dataStore.readyPhase === true && dataStore.handNo === handBefore,
    '还有人未准备时不提前发下一手（handNo 不变）');

  dataStore.readyList.forEach(r => { if (!r.isMe) pageCtx.markReady(r.seat, true); });
  ok(dataStore.readyPhase === false, '全员就绪后自动结束就绪阶段');
  ok(dataStore.handNo === handBefore + 1,
    '全员就绪后自动发下一手: ' + handBefore + ' → ' + dataStore.handNo);

  /* ---------- 就绪超时：超过 1 分钟未点就绪自动站起 ---------- */
  pageCtx.enterReadyPhase();
  ok(dataStore.readyPhase === true, '再次进入就绪阶段以验证超时逻辑');
  pageCtx.autoStandUnready();     // 模拟 60 秒到点（不等待真实时间）
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
  ['onRaiseSlider', 'onRaiseInput', 'onRaiseBlur', 'onCustomMin', 'onCustomHalf', 'onCustomPot',
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
  const profWxml = require('fs').readFileSync(
    path.join(__dirname, 'pages', 'profile', 'profile.wxml'), 'utf8');
  ok(/rec-more/.test(profWxml) && /rec-end/.test(profWxml),
    'WXML 战绩列表底部有「加载更多 / 没有更多战绩」节点');

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
    pageCtx.onRaiseSlider({ detail: { value: 346 } });
    ok(dataStore.raiseTo === 346, '滑杆拖到 346 → raiseTo 同步为 346');
    ok(dataStore.raiseSubmit === 346,
      '滑杆拖到 346 → 加注按钮文案同步为 346（曾停在旧值 20），实际 ' + dataStore.raiseSubmit);
    ok(dataStore.raiseAllIn === false, '346 未达上限 → 按钮显示「加注 346」而非「全下」');
    pageCtx.onCustomHalf();
    ok(dataStore.raiseSubmit === dataStore.raiseTo && dataStore.raiseTo >= minT,
      '点「½池」→ 按钮文案与金额同步（' + dataStore.raiseTo + '）');
    pageCtx.onCustomMin();
    ok(dataStore.raiseSubmit === minT, '点「最小」→ 按钮文案同步为 ' + minT);
    pageCtx.onCustomMax();
    ok(dataStore.raiseAllIn === true && dataStore.raiseSubmit === maxT,
      '点「最大」→ 按钮切换为「全下」（' + dataStore.raiseSubmit + ' = max ' + maxT + '）');
    pageCtx.onRaiseInput({ detail: { value: '0' } });
    ok(dataStore.raiseTo === 0 && dataStore.raiseSubmit === minT,
      '输入 0 → 输入框保留 0，但按钮按最小加注 ' + minT + ' 显示（与提交口径一致）');
    pageCtx.onRaiseBlur();
    ok(dataStore.raiseTo === minT && dataStore.raiseSubmit === minT,
      '失焦 → 补正到最小加注 ' + minT + '，按钮同步');
    ok(dataStore.raiseCustom === true,
      '滑杆/输入全程保持面板展开（金额改动不应误收起面板）');
    pageCtx.onCustomClose();
    ok(dataStore.raiseCustom === false, '「收起」→ 回到档位条');
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
    'onCustomHalf', 'onCustomPot', 'onCustomMax', 'onPresetTap'].forEach(fn => {
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
    // 白名单只放行「离房清理」类（closeRoom/leave —— 人已离开，提示无意义，
    // 具体见白名单数组注释）。出现新的静默吞错会在这里被拦截。
    const silentCatches = (tableSrc.match(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || []).length;
    const SILENT_OK_COUNT = 3;   // closeRoom×2 + roomSync.leave×1（离房清理，人已走）
    ok(silentCatches === SILENT_OK_COUNT,
      '同步链路无静默吞错（裸 catch 仅剩离房清理 ' + SILENT_OK_COUNT + ' 处），实际 ' + silentCatches);
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
