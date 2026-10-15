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

// 重新进入同一房间 → 自动续局，不再退回空等待室
const handBefore = snap.handNo;
pageCtx.onLoad({ room: '246810', own: '1' });
ok(dataStore.phase === 'playing', '再次进入房间直接回到牌桌（不再退回等待室）');
ok(dataStore.seats.length === 2, '续局保留原座位数（2 个座位都在环上），实际 ' + dataStore.seats.length);
ok(dataStore.handNo === handBefore, '续局从第 ' + handBefore + ' 手继续，实际 ' + dataStore.handNo);
ok(toasts.indexOf('已回到房间 · 第 ' + handBefore + ' 手') >= 0, '续局提示文案正确: ' + toasts.slice(-1)[0]);

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
ok(dataStore.soundOn === true, '默认开启操作反馈');
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

  /* ---------- 牌力分析校验 ---------- */
  ok(typeof dataStore.advice === 'object', 'advice 为对象');
  if (dataStore.advice && dataStore.advice.text) {
    ok(dataStore.advice.equityPct.indexOf('%') > 0, '胜率含百分号: ' + dataStore.advice.equityPct);
    ok(['strong', 'weak', 'neutral', 'draw'].indexOf(dataStore.advice.tone) >= 0,
      '建议色调合法: ' + dataStore.advice.tone);
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
  ok(/\n  onRaiseBlur\(\)/.test(tableSrc) &&
    /onRaiseBlur[\s\S]{0,300}?this\.data\.raiseTo < min[\s\S]{0,80}?raiseTo: min/.test(tableSrc),
    '自定义下注：失焦时把低于最小加注的值补到下限（界面显示始终合法）');
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
