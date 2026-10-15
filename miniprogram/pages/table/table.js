/**
 * 牌桌页逻辑
 *
 * 架构说明（重要）：
 *   AI 对战 / 好友房房主端：引擎跑在本机（权威端），渲染 + 驱动引擎。
 *   好友房好友端（remoteMode）：不跑引擎——把房主广播的快照镜像成本地
 *   game 对象，按「我 = 本地 0 号位」重映射座位后，复用同一套渲染与操作逻辑；
 *   我的动作经 room-sync 上行，由房主端消化后随下一帧广播回来。
 *   所有合法性判断以权威端（房主）为准，本地仅用于即时 UI 反馈。
 */
const P = require('../../core/poker-core.js');
const app = getApp();
const { auth } = require('../../utils/auth');
const { settings } = require('../../utils/settings');
const roomSync = require('../../utils/room-sync');
const sfx = require('../../utils/sfx');   // 合成音效（发牌/下注/加注/全下/获胜…）

/**
 * 单次行动倒计时（秒）：计时环按此值计算进度。
 * 远端好友的行动超时更长（SYNC.ACTION_TIMEOUT_SEC），由房主端代弃牌防卡死。
 */
const TICK_MAX = 20;

/** 同类同步失败提示的最短间隔：心跳 5s 一发，10s 节流意味着最多偶发弹一次，
 *  连续失败也只保持「约两条一次」的频率，不把 toast 叠成提示帘。 */
const SYNC_FAIL_TOAST_MS = 10000;

/**
 * 统一座位环坐标（WPK 式）：
 *   - 「我」锚定在椭圆底部中央（y 最大），底部区域完全留给我的手牌 + 操作条；
 *   - 其余对手全部铺在「上方半圆」（左 200° → 顶 270° → 右 340°），
 *     绝不下探到下半区，避免与 myzone / 行动按钮堆叠。
 * 按相对座位号（顺时针从我左侧起）排序，牌桌左右邻接关系符合直觉。
 * 等待室与游戏中共用同一套坐标 → 点「开始游戏」瞬间所有座位位置完全连续、无跳变。
 */
function ringPositions(seatSet, mySeat) {
  const arr = seatSet.slice().sort((a, b) => a - b);
  const total = arr.length;
  if (total === 0) return {};
  const idxMe = Math.max(0, arr.indexOf(mySeat));
  const cx = 50, cy = 46, rx = 43, ry = 31;
  const pos = {};
  if (total === 1) {
    pos[arr[0]] = { x: 50, y: 82 };
    return pos;
  }
  // 锚点（我）固定在底部中央
  pos[mySeat] = { x: 50, y: 82 };
  // 对手按顺时针座次（从我左侧开始）依次排到上方半圆
  const opp = [];
  for (let k = 1; k < total; k++) opp.push(arr[(idxMe + k) % total]);
  const O = opp.length;
  opp.forEach((s, k) => {
    const t = (k + 1) / (O + 1);            // 第 1 个 ≈ 左上，最后 1 个 ≈ 右上
    const ang = 200 + t * 140;              // 200°(左上) → 270°(顶) → 340°(右上)
    const rad = ang * Math.PI / 180;
    let x = cx + rx * Math.cos(rad);
    let y = cy + ry * Math.sin(rad);        // 上方半圆：sin<0 → y<cy
    x = Math.max(10, Math.min(90, +x.toFixed(1)));
    y = Math.max(12, Math.min(80, +y.toFixed(1)));
    pos[s] = { x, y };
  });
  return pos;
}

/** 电脑玩家名（AI 桌的预设对手；NAMES[0] 是「我」的占位，组局时按 mySeat 覆盖） */
const BOT_NAMES = ['林小满', '陈默', '苏晴', '赵岩', '周叙'];
const NAMES = ['你'].concat(BOT_NAMES);

/** AI 桌等待室提示：按是否已坐下切换（好友房用的是 seatHint，互不干扰） */
const AI_WAIT_HINT = {
  sitting: '点任一空位选座位坐下，坐下后自动安排 AI 对手',
  seated: '点「开始游戏」发牌；想多人混战可继续「添加电脑玩家」'
};
const QUICK_TALK = ['打得不错', '运气真好', '好牌！', '跟一手', '谢谢', '再想想'];
const EMOJIS = ['👍', '😂', '😮', '🔥', '💰', '😢'];

/** 花色配色（四色牌）：0♠ 黑 / 1♣ 绿 / 2♦ 蓝 / 3♥ 红 */
const SUIT_CLS = ['s-spade', 's-club', 's-diamond', 's-heart'];

/** 好友房空闲超时：创建后超过该时长仍无人加入（仅房主一人），自动销毁 */
const ROOM_TTL_MS = 30 * 60 * 1000;

/**
 * 就绪超时（秒）：上一手结束后，所有人需点「准备就绪」才发下一手；
 * 超过该时长仍未准备的人，自动站起（退出本局，但保留在房间内）。
 */
const READY_TIMEOUT_SEC = 60;

/**
 * 结算展示时序（毫秒）：一手结束（摊牌亮牌）后，先在牌桌上停留亮牌
 * RESULT_SHOW_MS ≈ 5 秒（看各家底牌与赢家），随后**直接进就绪阶段**——
 * 「每人盈亏」结算弹窗不自动弹出，由用户点「查看结算」主动打开
 * （摘要条 / 就绪条都有入口，与「准备就绪」并存）。
 * 弹窗打开后 RESULT_MODAL_MS 自动关闭（防挂屏）；亮牌展示期内打开的，
 * 关闭时顺带进就绪；就绪期内打开的只关弹窗、不重置就绪计票。
 * 镜像端就绪阶段以房主广播为准。
 */
const RESULT_SHOW_MS = 5000;
const RESULT_MODAL_MS = 10000;

/**
 * 买入额（WePoker 式入座流程）：点空位 → 选买入额 → 入座。
 * 买入额随座位同步到云端，房主开局时按各人买入发筹码。
 */
const DEFAULT_BUY_IN = 1000;
const BUY_IN_OPTIONS = [500, 1000, 2000, 5000];

/** 好友房牌局快照（中途退出 → 再次进入续局） */
const snapshot = require('../../utils/room-snapshot');

let game = null;
let timer = null;
let clock = null;         // 游戏时长倒计时（房间设定，到点自动结束本局）
let expireTimer = null;   // 好友房超时销毁计时器
let readyTimer = null;    // 「准备就绪」倒计时（超时未准备自动站起）
let tick = 20;
let aiStep = 0;
let aiTimer = null;
let foldTimer = null;   // 弃牌二次确认自动复位计时器
let myActText = '';
let myActCls = '';

Page({
  data: {
    mode: 'ai',          // 'ai' = AI 对战；'friend' = 好友房
    pageTitle: 'AI 对战',
    roomNo: '',
    handNo: 1,
    streetCn: '翻牌前',
    pot: 0,
    sidePots: [],
    board: [],
    boardPlaceholders: [],
    seats: [],
    legal: null,
    raiseTo: 0,
    raisePreset: '',
    isMyTurn: false,
    foldConfirm: false,   // 弃牌二次确认：首次点「弃牌」进入确认态，再点才真正弃牌
    currentPlayerName: '',
    advice: {},
    result: null,
    resultModal: null,    // 单手结算弹窗（每人净盈亏）：亮牌展示后弹出

    // 等待室（好友房）：创建房间后为空房间，好友坐下、房主点开始才发牌
    phase: 'playing',     // 'waiting'（空房间）| 'playing'（牌桌）；initGame/等待室会显式设定
    waitSeats: [],        // 座位占用情况（自选座位：点空位入座，开局前可换座）
    canStart: false,      // 至少 2 人坐下才可开始
    ownerSeat: 0,         // 房主默认坐 0 号位（可在等待室换座）
    isOwner: true,        // 是否房主（访客从分享卡片进入时只有观看/等待权限）
    syncLive: false,      // 跨设备同步是否可用（false = 本地引擎模拟降级）
    seatHint: '',         // 等待室选座提示（好友房）
    waitHint: '',         // 等待室选座提示（AI 桌：引导挑座位后才发牌）
    rootStyle: '',        // JS 实测视口变量（--uh/--uw），注入页面根节点

    // 用户设置（参考主流 App 的 Table Appearance 自定义）
    fourColor: true,      // 四色牌
    soundOn: true,        // 音效 + 震动反馈
    animOn: true,         // 牌桌动画

    // 房间参数（创建时设定，不可中途修改）
    maxSeats: 6,          // 限定人数
    durationMin: 0,       // 游戏时长（分钟），0 = 不限时
    remainSec: 0,         // 剩余秒数
    remainText: '',       // 倒计时展示（mm:ss / h:mm:ss）
    timeUp: false,        // 时长已到，游戏结束
    summary: null,        // 结束时的全员盈亏统计

    // 站起 / 坐下：退出「游戏」≠ 退出「房间」
    myStanding: false,    // 我已站起：退出当前牌局但仍在房间内观战
    mySeated: true,       // 我是否算「在座」（含「已坐下、下一手入局」的待入局状态）
    canStand: false,      // 当前可否站起（已弃牌或本手已结束）

    // 就绪阶段：上一手结束后，等所有坐下的人点「准备就绪」才发下一手
    readyPhase: false,    // 当前是否处于等待就绪阶段
    readyList: [],        // 参与者就绪情况 [{seat,name,isMe,isBot,ready}]
    myReady: false,       // 我是否已准备
    readyLeft: 0,         // 我的就绪倒计时剩余秒（超时自动站起）
    readyHint: '',        // 就绪阶段提示文案

    // 入座买入（WePoker 式）：点空位 → 选买入额 → 入座，买入额随座位同步
    buyInShow: false,     // 买入选择弹窗
    buyInSeat: -1,        // 准备入座的座位号
    buyInValue: DEFAULT_BUY_IN,
    buyInOptions: BUY_IN_OPTIONS.map(v => ({ v: v, t: String(v) })),

    // 行动计时环
    timerMax: 20,

    // 我的区域（微扑克式：手牌与操作集中在屏幕下半区）
    myCards: [],          // 我的两张底牌
    myStack: 0,
    myBet: 0,
    myFolded: false,
    myActive: false,      // 轮到我行动
    myTimer: '',
    myTimerPct: 0,
    myDealer: false,
    mySB: false,
    myBB: false,
    myActText: '',
    myActCls: '',

    // 加注档位（主流 App 的 bet sizing chips，替代占位很大的滑杆）
    raisePresets: [
      { k: 'min', t: '最小' },
      { k: 'half', t: '½池' },
      { k: 'pot', t: '底池' },
      { k: 'allin', t: '全下' },
      { k: 'custom', t: '自定义' }
    ],
    // 自定义下注面板：数值范围 0 ~ raiseMax（MAX = 全下金额）
    raiseCustom: false,
    raiseMin: 0,
    raiseMax: 0,
    // 实际会提交的加注额 / 是否等价于全下（与 onRaise 同口径，仅用于按钮文案）
    raiseSubmit: 0,
    raiseAllIn: false,

    // 折叠面板：聊天与菜单默认收起，不抢占主视觉（微扑克：社区折叠在边栏）
    chatOpen: false,
    menuOpen: false,

    // 社交：快捷聊天 + 表情
    chatLog: [],          // 最近聊天/表情（最多 8 条）
    quickChat: QUICK_TALK,
    chatEmojis: EMOJIS,

    // 新手引导 / 教学
    helpShow: false,
    helpRows: [
      { name: '翻牌前', desc: '每人两张底牌，大小盲先行下注' },
      { name: '翻牌', desc: '发出 3 张公共牌，开始第二轮下注' },
      { name: '转牌', desc: '第 4 张公共牌，再一轮下注' },
      { name: '河牌', desc: '第 5 张公共牌，最后一轮下注' },
      { name: '摊牌', desc: '7 张牌取最大 5 张组合比大小' }
    ],
    coachShow: false,
    coachTip: '轮到你时：看右侧「牌力分析」的胜率与赔率，胜率高于赔率再跟注。'
  },

  onLoad(options) {
    const opts = options || {};
    this.mode = opts.room ? 'friend' : 'ai';
    this.roomNo = opts.room || '';
    // own=1 表示从「我的房间」或创建流程进入（房主）；分享/输入房间号进入视为访客
    this.isOwner = this.mode === 'friend' ? opts.own === '1' : true;
    this.roomClosed = false;   // 每次进出页面重置：房间是否已被本页关闭
    this.myStanding = false;   // 每次进出页面重置：默认坐在局内
    this.pendingSit = false;   // 「坐下加入游戏」待下一手生效
    this.standingMap = {};     // 其他座位（电脑玩家）的站起状态：seat → true
    this.readyMap = {};        // 就绪阶段各座位是否已准备：seat → true
    this.botReadyTimers = [];  // 电脑玩家自动「准备就绪」的定时器
    // 跨设备同步状态（好友房）：mySeat = 本地渲染座位（好友镜像端恒 0）；
    // roomSeat = 云端座位号（自选座位，-1 = 未选座）
    this.mySeat = 0;
    // 好友房房主沿用 0 号位（房间是自己的）；AI 桌与好友访客一样不预占，
    // 进等待室后由玩家自己挑位置坐下
    this.roomSeat = (this.mode === 'friend' && this.isOwner) ? 0 : -1;
    this.remoteMode = false;   // 好友端镜像模式：不跑引擎，只渲染房主广播
    this.syncLive = false;
    this.roomRows = [];        // 最近一次轮询到的座位行
    this.hostState = null;     // 房主广播的房间公开状态
    this.appliedSeqBySeat = {};// 房主已消化的好友动作序号（按来源行座位分道，防跨设备时钟偏差丢动作）
    this.hostStaleSince = 0;   // 好友端：房主心跳疑似停滞的起始时刻（超宽限判房间僵死）
    this.botSeats = {};        // 机器人座位（不会上行动作，超时不管）
    this.pendingSitMap = {};   // 好友「坐下」待下一手生效：seat → true
    this.pollTimer = null;
    this.hbTimer = null;
    this.publishTimer = null;
    this.friendActSince = 0;   // 房主端：好友行动开始时刻（超 30s 代弃牌）
    this.sawHost = false;      // 好友端：是否见过房主行（用于判断房间解散）
    this.inBackground = false; // 前后台切换状态（onHide/onShow 配对消费）
    this.bgRemainSec = undefined; // 限时局切后台时的剩余秒数（回前台断点续走）
    // 房间参数：限定人数与游戏时长（创建房间时设定）
    this.maxSeats = Math.min(9, Math.max(2, Number(opts.max) || 6));
    this.durationMin = Math.max(0, Number(opts.dur) || 0);
    this.startStacks = {};     // 座位 → 起始筹码（结算盈亏用）
    this.buyInStack = {};      // 座位 → 买入额（入座时选定，开局按此发筹码）
    this.chatSeq = this.chatSeq || 0;
    const s = settings.get();
    this.setData({
      mode: this.mode,
      roomNo: this.roomNo,
      isOwner: this.isOwner,
      maxSeats: this.maxSeats,
      durationMin: this.durationMin,
      remainSec: this.durationMin * 60,
      remainText: this.durationMin ? this.fmtRemain(this.durationMin * 60) : '',
      timeUp: false,
      summary: null,
      myStanding: false,
      mySeated: true,
      canStand: false,
      readyPhase: false,
      readyList: [],
      myReady: false,
      readyLeft: 0,
      readyHint: '',
      pageTitle: this.mode === 'friend' ? '好友房' : 'AI 对战',
      fourColor: s.fourColor,
      soundOn: s.sound,
      animOn: s.animation
    });
    this.updateViewport();
    // 音效事件泵：300ms 轮询消化引擎事件流（game.events）→ 播音效。
    // 与渲染解耦——对手在计时器/看门狗路径里的动作也能及时发声。
    this.sfxSeq = 0;          // 已消费的事件序号（首手从 0 开始，天然不播历史音）
    this.startSfxPump();
    // 音频解锁：WebAudio 上下文初始 suspended，必须在一次真实手势里 resume()。
    // 挂根节点 touchstart（捕获阶段，卡在所有按钮之前），用户第一次碰屏幕就解锁，
    // 之后发牌/下注音才真的出声。once 语义由 sfx.unlock 内部幂等保证。
    this.sfxUnlockBound = true;
    if (this.mode === 'friend' && wx.showShareMenu) {
      wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] });
    }
    if (this.mode === 'friend') {
      // 好友房：先尝试跨设备同步（入座 + 轮询/心跳）；失败则保持本地引擎模拟。
      // 本地快照续局（房主）与同步引导并行，互不影响。
      this.bootstrapSync();
      if (!this.restoreRoom()) this.initWaiting();
    } else {
      // AI 对战：与好友房共用同一间等待室——先挑座位坐下、点「开始游戏」才发牌，
      // 不再一进就自动开局。差别只在：无房间号、不跨设备同步、坐下后自动补 AI 对手。
      this.initWaiting();
    }
  },

  /**
   * 分享面板 / 切后台返回后，部分机型（荣耀、vivo、华为等）会把横屏页
   * 重置回竖屏（微信已知问题），导致 vh 布局全部放大爆掉。
   * onShow 重新锁回横屏（延迟 100ms 兼容部分机型不生效）。
   */
  onShow() {
    if (wx.setPageOrientation) {
      setTimeout(() => {
        wx.setPageOrientation({ orientation: 'landscape' });
      }, 100);
    }
    this.updateViewport();
    // 从后台切回：iOS 会把 WebAudio 上下文挂起（currentTime 停走），
    // 这里补一次解锁尝试；用户下一次触摸也会再触发 onFirstTouch。
    if (this.sfxUnlockBound) { try { sfx.unlock(); } catch (e) {} }
    this.onLeaveBackground();
  },

  /**
   * onHide（切后台/跳分享面板）：全量暂停定时器与云端轮询。
   * 评审 2026-10-15 MEDIUM：此前切后台时轮询/看门狗/倒计时/AI 调度照跑——
   * 后台 JS 定时器被挂起后节奏失真（回来一次性补跑）、云端心跳白写、
   * 限时局的时长在后台偷走。心跳不在暂停列表：房主掉线 15s 判离线是
   * 房间语义（真·退后台超过 15s 本就该判离线），不能因切后台豁免。
   */
  onHide() {
    this.onEnterBackground();
  },

  /** 切后台：停轮询/看门狗/AI 调度/个人计时环/时长倒计时/音效泵 */
  onEnterBackground() {
    if (!this.inBackground) {
      this.inBackground = true;
      this.saveSnapshot();   // 后台被系统直接回收时（不走 onUnload）也能续局
    }
    this.stopPolling();
    this.stopEngineWatch();
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
    this.stopSfxPump();
    // 限时局：记下剩余秒数，回前台从断点继续（后台时间不计入牌局时长）
    if (clock) {
      this.bgRemainSec = Number(this.data.remainSec) || 0;
      this.clearClock();
    }
  },

  /** 回前台：恢复被 onEnterBackground 暂停的一切（幂等：没暂停过就不动） */
  onLeaveBackground() {
    if (!this.inBackground) return;
    this.inBackground = false;
    // 回前台：先补一轮轮询再看缺什么（好友端后台期间可能错过房主广播）
    if (this.syncLive && this.roomNo && !this.pollTimer) this.startPolling();
    // 看门狗在 initGame 启动、onEnterBackground 停掉；此处不区分模式——
    // healEngine 内部自判「好友房仅房主端驱动」，双模式重启它最简单且幂等
    if (!this.engineWatch) this.startEngineWatch();
    if (!this.sfxPump) this.startSfxPump();
    if (this.durationMin && this.bgRemainSec !== undefined) {
      const resume = this.bgRemainSec;
      this.bgRemainSec = undefined;
      if (resume > 0 && !this.data.timeUp) this.startClock(resume);
    }
    // 回到页面的下一拍补一次全量刷新（好友端可能错过后台期间的房主广播）
    if (this.syncLive && this.roomNo) this.pollOnce();
    this.render();
  },

  /**
   * 首次触摸 → 解锁音频上下文（见 sfx.js unlock 注释）。
   * 绑定在根节点的 bindtouchstart 上，用 capture 语义先于按钮执行；
   * 不做任何业务逻辑，纯音频解锁，重复触发由 unlock() 幂等吸收。
   */
  onFirstTouch() {
    try { sfx.unlock(); } catch (e) { /* 音效不可用也不能影响牌局 */ }
  },

  /**
   * 弹窗内容层的点按吞没：拦住冒泡，防止误触底下的遮罩关闭（bindtap=onHelpClose 等）。
   * 裸 catchtap（无属性值）在 WXML 校验里属「无保证行为」——空属性是否生效随
   * 基础库版本漂移（评审 2026-10-15 MEDIUM），显式绑定空函数才是稳定写法。
   */
  onBlockTap() { /* 有意留空：只吞冒泡，不做任何事 */ },

  /** 视口尺寸变化（转屏 / 分窗）时重算布局变量 */
  onResize(res) {
    this.updateViewport(res);
  },

  /**
   * JS 实测视口 → CSS 变量（样式不再依赖原生 vh/vw，防转屏后尺寸错乱）：
   *   --uh：纵向 1% 基准，横屏下 = 视口高/100；
   *         若被异常切回竖屏，取 min(宽,高)/100 兜底，页面按宽度等比缩放不爆版。
   *   --uw：横向 1% 基准 = 视口宽/100。
   */
  updateViewport(info) {
    let w = 0, h = 0;
    if (info && info.size) {
      w = info.size.windowWidth;
      h = info.size.windowHeight;
    } else if (wx.getWindowInfo) {
      const i = wx.getWindowInfo();
      w = i.windowWidth;
      h = i.windowHeight;
    }
    if (!w || !h) return;
    const uw = w / 100;
    const uh = Math.min(w, h) / 100;
    this.setData({
      rootStyle: '--uh:' + uh.toFixed(3) + 'px;--uw:' + uw.toFixed(3) + 'px;'
    });
  },

  /**
   * 我这一位的显示名：默认取我的昵称（微信名），没设过才回落「你」。
   * 「（房主）」只在好友房里才有意义——AI 桌没有房主，别往名字后面堆后缀。
   */
  meLabel(withOwner) {
    const n = auth.myName('你');
    return (withOwner && this.mode === 'friend') ? n + '（房主）' : n;
  },

  /**
   * 等待室座位 → 牌桌座位环渲染数据：给每个座位算出环形坐标（与游戏中共用
   * ringPositions，锚定在我的座位 → 开局时座位位置连续无跳变），并补齐渲染字段。
   */
  buildWaitSeats(source) {
    const list = source || [];
    // 锚定座位：我若已入座则以我的座位为底部中央，否则用房主位（稳定布局）
    const anchor = this.roomSeat >= 0 ? this.roomSeat
      : (this.isOwner ? this.data.ownerSeat : 0);
    const pos = ringPositions(list.map(s => s.seat), anchor);
    return list.map(s => {
      const p = pos[s.seat] || { x: 50, y: 20 };
      const empty = !s.occupied;
      const name = s.isMe ? this.meLabel(s.isOwner) : (s.name || '');
      return {
        seat: s.seat,
        seatNo: s.seat + 1,
        x: p.x, y: p.y,
        empty,
        occupied: !!s.occupied,
        isMe: !!s.isMe,
        isOwner: !!s.isOwner,
        isBot: !!s.isBot,
        name: empty ? '' : name,
        initial: empty ? '' : (name ? name.slice(0, 1) : '?'),
        // 等待室展示买入额（机器人与未指定者回落到默认买入）
        stack: empty ? '' : (Number(s.stack) || DEFAULT_BUY_IN),
        // 以下字段游戏中才用，其余给安全默认值避免渲染异常
        bet: 0, folded: false, active: false, win: false, standing: false, allIn: false,
        isDealer: false, isSB: false, isBB: false,
        cardsBack: false, showCards: false, hole: [], actText: '', actCls: ''
      };
    });
  },

  /**
   * 进入等待室：房主坐 0 号位；访客（从分享卡片进入）自动落座 1 号位并等待房主开始。
   * 注意：访客落座仅本地可见——真实跨设备同步需要服务端房间状态（当前为本地引擎模拟）。
   * 等待室与牌桌共用同一张桌：座位环（seats）在此一并渲染，空座位带「坐下」按钮。
   */
  initWaiting() {
    const owner = this.data.ownerSeat;
    const guestSeat = 1;
    const ws = [];
    // 好友房：房主坐 0 号位、访客自动落 1 号位。
    // AI 桌：一张空桌——没有人预占，玩家自己挑哪个位置坐下（选座是这里的核心）。
    const presetByRole = this.mode === 'friend';
    // 按房间设定的限定人数生成座位（2 / 4 / 6）
    for (let i = 0; i < this.maxSeats; i++) {
      const isOwnerSeat = presetByRole && i === owner;
      const isGuestSeat = presetByRole && !this.isOwner && i === guestSeat;
      if (isOwnerSeat || isGuestSeat) this.buyInStack[i] = DEFAULT_BUY_IN;
      ws.push({
        seat: i,
        occupied: isOwnerSeat || isGuestSeat,
        isOwner: isOwnerSeat,
        isMe: isOwnerSeat ? this.isOwner : isGuestSeat,
        isBot: false,
        name: isOwnerSeat ? (this.isOwner ? this.meLabel(true) : '房主') : (isGuestSeat ? this.meLabel(false) : ''),
        isHost: isOwnerSeat,
        stack: (isOwnerSeat || isGuestSeat) ? DEFAULT_BUY_IN : 0
      });
    }
    this.setData({
      phase: 'waiting',
      waitSeats: ws,
      seats: this.buildWaitSeats(ws),
      canStart: this.canStartOf(ws),
      syncLive: this.syncLive,
      seatHint: this.syncLive && !this.isOwner && this.roomSeat < 0 ? '点击空位入座' : '',
      waitHint: this.mode === 'friend' ? '' : AI_WAIT_HINT.sitting
    });
    if (this.isOwner) this.armExpire();   // 仅房主侧计时：30 分钟无人加入自动销毁
  },

  /** 可开始条件：必须自己是房主（AI 桌即本人），且至少 2 人坐下 */
  canStartOf(seats) {
    return this.isOwner && (seats || []).filter(s => s.occupied).length >= 2;
  },

  /**
   * AI 桌自动补位：玩家坐下后把同桌补到能开局的最少人数（2 人）。
   * 不替玩家一次加满——想打多人桌由他自己点「添加电脑玩家」逐步加，
   * 但至少保证「坐下即可开始」，不会卡在按钮是灰的状态。
   */
  fillBots() {
    if (this.mode === 'friend') return;
    const seats = (this.data.waitSeats || []).slice();
    let botNo = seats.filter(s => s.isBot).length;
    while (seats.filter(s => s.occupied).length < 2) {
      const empty = seats.find(s => !s.occupied);
      if (!empty) break;   // 座位数为 1 的极端情况：无法补位
      empty.occupied = true;
      empty.isBot = true;
      empty.name = this.botLabel(botNo);
      empty.stack = DEFAULT_BUY_IN;
      botNo++;
    }
    this.setData({
      waitSeats: seats,
      seats: this.buildWaitSeats(seats),
      canStart: this.canStartOf(seats)
    });
  },

  // ---------- 跨设备同步（poker_room_seats：每人行 + 房主广播） ----------

  /**
   * 同步引导（好友房进入时调用，异步）：
   *   房主 → 占 0 号位并广播等待室布局；好友 → 先不占座（roomSeat=-1），
   *   在等待室点空位入座。随后启动轮询与心跳。
   * 任何一步失败都静默降级为「本地引擎模拟」，不卡界面。
   */
  async bootstrapSync() {
    if (this.mode !== 'friend' || !this.roomNo) return;
    try {
      // 房主恢复之前选过的座位；好友未选座时为 -1（进等待室再点空位）
      let seat = this.isOwner ? 0 : -1;
      let rows = [];
      try { rows = await roomSync.poll(this.roomNo); } catch (e) { rows = []; }
      if (this.isOwner) {
        const mine = rows.filter(r => r.is_host)[0];
        if (mine && mine.seat >= 0) seat = mine.seat;
        // 房主重进房间：把历史动作序号先推到最新，避免重放离开期间积压的动作
        this.appliedSeqBySeat = roomSync.pendingActions(rows, {}).nextBySeat;
      }
      // 名字：广播给同桌好友看的那份，默认用我的微信昵称；
      // ensureProfile 顺带把登录态里的档案补齐（否则 myName 只能回落兜底名）
      try {
        const p = await auth.ensureProfile();
        if (p) app.globalData.profile = p;
      } catch (e) { /* 档案读取失败用兜底名，不阻断同步 */ }
      const name = auth.myName(this.isOwner ? '房主' : '好友');
      // 买入额：房主沿用上次选择（重进房间不重置），好友入座时再选
      const mineRow = rows.filter(r => r.is_host)[0];
      const joinStack = this.isOwner && mineRow && mineRow.stack ? mineRow.stack : DEFAULT_BUY_IN;
      this.buyInStack[seat] = joinStack;
      await roomSync.join(this.roomNo, {
        seat: seat,
        name: name,
        isHost: this.isOwner,
        stack: joinStack
      });
      this.roomSeat = seat;
      this.mySeat = this.isOwner ? seat : 0;
      this.syncLive = true;
      this.setData({ syncLive: true, seatHint: !this.isOwner ? '点击空位入座' : '' });
      this.startPolling();
      this.startHeartbeat();
      if (this.isOwner) this.publishWait();
      await this.pollOnce();
    } catch (e) {
      // 云端表不可用（旧应用未建表 / 网络异常）→ 本地引擎模拟
      this.syncLive = false;
      this.setData({ syncLive: false, seatHint: '' });
      console.error('[table] 跨设备同步不可用，已降级本地模式',
        JSON.stringify({ stage: 'bootstrap-sync', message: e && e.message }));
    }
  },

  startPolling() {
    this.stopPolling();
    if (!this.syncLive || !this.roomNo) return;
    this.pollTimer = setInterval(() => { this.pollOnce(); }, roomSync.SYNC.POLL_MS);
  },

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },

  /** 同步写的失败提示统一收口：同文案 10s 内只提示一次（心跳 5s 一发、
   *  每发都弹 toast 会把界面刷成提示帘）。降级路径除外——降级已有
   *  专门的「已转本地模式」提示，这里不再叠加。 */
  syncFailToast(title) {
    this.syncFailLast = this.syncFailLast || {};
    const now = Date.now();
    if (now - (this.syncFailLast[title] || 0) < SYNC_FAIL_TOAST_MS) return;
    this.syncFailLast[title] = now;
    console.error('[table] 同步上行失败', JSON.stringify({ room: this.roomNo, title }));
    wx.showToast({ title, icon: 'none' });
  },

  startHeartbeat() {
    this.stopHeartbeat();
    if (!this.syncLive || !this.roomNo) return;
    this.hbTimer = setInterval(() => {
      roomSync.heartbeat(this.roomNo)
        .catch(() => this.syncFailToast('网络不稳定，同步可能延迟'));
    }, roomSync.SYNC.HEARTBEAT_MS);
  },

  stopHeartbeat() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  },

  stopSync() {
    this.stopPolling();
    this.stopHeartbeat();
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; }
  },

  /** 同步丢失（云端报错）：停掉轮询，退回本地模式 */
  onSyncLost() {
    if (!this.syncLive) return;
    this.syncLive = false;
    this.stopSync();
    this.setData({ syncLive: false });
    wx.showToast({ title: '云端同步中断，已转本地模式', icon: 'none' });
  },

  /**
   * 轮询一次房间：
   *   房主 → 消费好友动作（按座位分道的 appliedSeqBySeat 消化）、合并就绪计票、好友超时代弃牌、广播状态；
   *   好友 → 读取房主广播：等待室布局 / 牌局快照镜像。
   */
  async pollOnce() {
    if (!this.syncLive || !this.roomNo) return;
    let rows;
    try {
      rows = await roomSync.poll(this.roomNo);
    } catch (e) {
      this.onSyncLost();
      return;
    }
    this.roomRows = rows;
    const st = roomSync.hostStateOf(rows);
    this.hostState = st;

    if (this.isOwner) {
      if (!st && this.data.phase === 'playing') this.publishPlay();
      if (this.data.phase === 'waiting') { this.renderWait(); return; }
      this.dropOfflineSeats(rows);
      const { actions, nextBySeat } = roomSync.pendingActions(rows, this.appliedSeqBySeat);
      Object.keys(nextBySeat).forEach(s => { this.appliedSeqBySeat[s] = nextBySeat[s]; });
      actions.forEach(a => this.applyFriendAction(a));
      if (this.data.readyPhase) this.mergeFriendReady(rows);
      this.watchFriendAction();
      this.healEngine();
      this.publishPlay();
      return;
    }

    // ---- 好友端 ----
    const host = roomSync.hostRow(rows);
    if (!host) {
      if (this.sawHost) {
        // 房主行消失（离开/解散）→ 退回首屏
        this.sawHost = false;
        wx.showToast({ title: '房主已离开，房间解散', icon: 'none' });
        this.leaveRoom();
      }
      return;
    }
    // 房主心跳僵死检测：行还在但心跳超时——房主可能已崩溃/杀进程，
    // 其行不会自己消失。给 HOST_STALE_EXIT_MS 宽限（覆盖一次长轮询/切后台恢复），
    // 仍未恢复则判房间僵死退出，好友端绝不无限干等。
    if (!roomSync.isOnline(host, Date.now())) {
      this.hostStaleSince = this.hostStaleSince || Date.now();
      if (Date.now() - this.hostStaleSince >= roomSync.SYNC.HOST_STALE_EXIT_MS) {
        this.hostStaleSince = 0;
        wx.showToast({ title: '房主长时间无响应，房间已解散', icon: 'none' });
        this.leaveRoom();
        return;
      }
    } else {
      this.hostStaleSince = 0;
    }
    this.sawHost = true;
    if (!st) { if (this.data.phase === 'waiting') this.renderWait(); return; }
    if (st.kind === 'waiting') {
      this.remoteMode = false;
      if (this.data.phase !== 'waiting') {
        // 房主退回等待室（重开一局）→ 好友同步退回
        this.clearResultTimer();
        this.clearResultModalTimer();
        this.setData({ phase: 'waiting', result: null, summary: null, timeUp: false, resultModal: null });
        if (game) game.result = null;
      }
      this.renderWait();
      return;
    }
    this.enterRemote(st);
  },

  /** 等待室布局：真人来自各自的行（在线才算占座），机器人来自房主广播 */
  renderWait() {
    if (this.data.phase !== 'waiting') return;
    const source = this.syncLive
      ? roomSync.buildWaitLayout(this.roomRows, this.hostState, this.maxSeats, this.roomSeat)
      : (this.data.waitSeats || []);
    const seats = this.buildWaitSeats(source);
    const occupiedCount = seats.filter(s => s.occupied).length;
    this.setData({
      waitSeats: source,
      seats: seats,
      canStart: this.isOwner && occupiedCount >= 2,
      seatHint: this.roomSeat < 0 ? '点击空位入座' : ''
    });
  },

  /** 房主广播等待室布局（只含机器人；真人身位在各自行里）。
   *  必须只在等待阶段广播：开局后残留的异步回调（如换座 .then）若把
   *  kind:'waiting' 写回去，会清掉 playing 快照，好友端会被踢回等待室。 */
  publishWait() {
    if (this.data.phase !== 'waiting') return;
    if (!this.syncLive || !this.isOwner || !this.roomNo) return;
    const bots = (this.data.waitSeats || [])
      .filter(s => s.isBot)
      .map(s => ({ seat: s.seat, kind: 'bot', name: s.name }));
    // 任何一处静默吞错都会让好友端 UI 与权威端静默撕裂；改回去前先读评审报告 MEDIUM 一节。
    roomSync.publishState(this.roomNo, { kind: 'waiting', seats: bots })
      .catch(() => this.syncFailToast('布局广播失败，好友端可能暂看不到'));
  },

  /**
   * 点座位：WePoker 式入座流程——先选买入额，再落座。
   * 点自己的座位可改买入额；点已占用座位给出提示。
   */
  chooseSeat(e) {
    if (this.data.phase !== 'waiting') return;
    const seat = Number(e.currentTarget.dataset.seat);
    if (isNaN(seat)) return;
    const source = (this.data.waitSeats || []);
    const target = source.filter(s => s.seat === seat)[0];
    if (!target) return;
    if (target.occupied && !target.isMe) { wx.showToast({ title: '该座已有人', icon: 'none' }); return; }

    // 弹窗选买入额（默认沿用上次选择或默认买入）
    this.setData({
      buyInShow: true,
      buyInSeat: seat,
      buyInValue: this.buyInStack[seat] || DEFAULT_BUY_IN
    });
  },

  /** 选买入额档位 */
  onBuyInPick(e) {
    const v = Number(e.currentTarget.dataset.v);
    if (!v) return;
    this.setData({ buyInValue: v });
  },

  cancelBuyIn() {
    this.setData({ buyInShow: false, buyInSeat: -1 });
  },

  /** 确认入座：记录买入额 → 本地即时反馈 → 同步云端（RLS 只能改自己的行） */
  confirmBuyIn() {
    const seat = this.data.buyInSeat;
    const buyIn = Number(this.data.buyInValue) || DEFAULT_BUY_IN;
    if (seat < 0) { this.setData({ buyInShow: false }); return; }
    this.setData({ buyInShow: false, buyInSeat: -1 });
    this.sitSeat(seat, buyIn);
  },

  /** 落座（含换座）：本地即时反馈 + 云端同步，买入额随行写入 */
  sitSeat(seat, buyIn) {
    const prev = this.roomSeat;
    this.roomSeat = seat;
    if (this.isOwner) this.mySeat = seat;
    this.buyInStack[seat] = buyIn;
    if (prev >= 0 && prev !== seat) delete this.buyInStack[prev];   // 换座：旧座位买入额作废
    // 本地即时反馈：更新等待室布局与牌桌座位环（下一轮轮询会以云端为准）
    const seats = (this.data.waitSeats || []).map(s => {
      if (s.seat === seat) {
        return {
          seat: s.seat, occupied: true, isBot: false, isMe: true, isOwner: this.isOwner,
          name: this.meLabel(this.isOwner), isHost: this.isOwner, stack: buyIn
        };
      }
      if (s.seat === prev) {
        return { seat: s.seat, occupied: false, isBot: false, isMe: false, isOwner: false, name: '', isHost: false, stack: 0 };
      }
      return s;
    });
    this.setData({
      waitSeats: seats,
      seats: this.buildWaitSeats(seats),
      seatHint: '',
      waitHint: this.mode === 'friend' ? '' : AI_WAIT_HINT.seated
    });
    // AI 桌：坐下后立刻补一个对手，保证「开始游戏」直接可点
    this.fillBots();
    if (!this.syncLive) return;   // 本地模式：仅本地生效，不走云端换座
    roomSync.moveSeat(this.roomNo, seat, buyIn)
      .then(() => { if (this.isOwner) this.publishWait(); })
      .catch(() => wx.showToast({ title: '换座同步失败', icon: 'none' }));
  },

  /** 掉线检测：原在局里的真人座位心跳超时 → 视为站起，不卡牌局 */
  dropOfflineSeats(rows) {
    if (this.data.phase !== 'playing' || !game) return;
    const live = {};
    roomSync.activeSeats(rows, Date.now()).forEach(r => { live[r.seat] = true; });
    let dirty = false;
    game.players.forEach(p => {
      if (this.botSeats[p.seat]) return;              // 机器人不受心跳影响
      if (p.seat === this.mySeat) return;             // 我自己
      if (live[p.seat]) return;                       // 在线
      if (p.sittingOut) return;
      p.sittingOut = true;
      this.standingMap[p.seat] = true;                // 同步到 UI：头像下显示「观战」
      this.pushChat(p.seat, p.name, '掉线，自动站起');
      dirty = true;
    });
    // 中途站起若恰好轮到该座位 / 引擎推进落在他头上 → 立即代弃推进，防全桌冻结（C-2）
    if (dirty && !game.result && game.actionSeat >= 0) {
      const seat = game.actionSeat;
      if (!this.botSeats[seat] && seat !== this.mySeat && this.standingMap[seat]) this.advance();
    }
  },

  /**
   * 房主消化一个好友动作。
   * 座位一律取动作来源行自己的座位（a.rowSeat，由 pendingActions 绑定），
   * 不信任 payload 里的 seat——否则任何好友可替他人（含房主）行动/站起。
   * payload seat 与 rowSeat 不一致视为伪冒，整条丢弃。
   */
  applyFriendAction(a) {
    if (!game) return;
    if (a.type === 'act' && Number(a.seat) !== Number(a.rowSeat)) return;   // 座位伪冒 → 丢弃
    const seat = Number(a.rowSeat);
    if (a.type === 'act') {
      if (game.actionSeat === seat && !game.result) {
        const r = game.act(seat, a.action, a.amount || 0);
        if (r.ok) this.afterAct();
      }
      // 动作过期（已不是该座行动 / 本手已结束）→ 丢弃
      return;
    }
    if (a.type === 'stand') {
      if (Number(a.seat) !== Number(a.rowSeat)) return;   // 座位伪冒 → 丢弃
      const p = game.seatOf(seat);
      if (p && !p.sittingOut) {
        p.sittingOut = true;
        this.standingMap[seat] = true;
        this.pushChat(seat, p.name, '站起观战');
        if (this.data.readyPhase) {
          // 就绪阶段站起 → 退出计票，其余人齐了就直接发下一手
          const seated = (this.data.readyList || []).filter(x => x.seat !== seat);
          this.setData({ readyList: seated });
          this.renderReady();
          this.checkAllReady();
        }
        // 牌局进行中站起：若行动权恰好在他手上 → 立即代弃推进，防全桌冻结（C-2）
        if (this.data.phase === 'playing' && !game.result && game.actionSeat === seat) this.advance();
        this.render();
        this.forcePublish();   // 站起是关键状态：穿透节流立即广播，镜像端马上回显
      }
      return;
    }
    if (a.type === 'sit') {
      if (Number(a.seat) !== Number(a.rowSeat)) return;   // 座位伪冒 → 丢弃
      // 坐下下一手生效：先记下，startHand 时清理 sittingOut
      this.pendingSitMap[seat] = true;
      delete this.standingMap[seat];
      const p = game.seatOf(seat);
      if (p) this.pushChat(seat, p.name, '重新入局（下一手生效）');
      this.forcePublish();
      return;
    }
  },

  /** 立即广播一次（忽略 500ms 节流与脏检查）：站起/坐下/结算等关键状态变化用。
   *  must force：多数调用点的变动已进指纹（sittingOut/bet 等）；站起/坐下若
   *  不改任何指纹字段（罕见），靠这里旁路脏检查保证一定写出去。 */
  forcePublish() {
    this.publishDue = 0;
    this._lastPlayFp = null;   // 作废指纹 → writePlayState 必然重新写库
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; }
    this.publishPlay();
  },

  /** 就绪计票合并：好友的 ready_hand === 下一手手数 即视为已准备 */
  mergeFriendReady(rows) {
    if (!game) return;
    const ready = roomSync.readySeats(rows, game.handNo + 1, Date.now());
    let changed = false;
    Object.keys(ready).forEach(s => {
      if (!this.readyMap[s]) { this.readyMap[s] = true; changed = true; }
    });
    if (changed) {
      this.renderReady();
      this.checkAllReady();
      this.publishPlay();
    }
  },

  /** 远端好友行动超时（30s）：房主代弃牌，防止牌局卡死 */
  watchFriendAction() {
    if (!game || game.result || game.actionSeat < 0) { this.friendActSince = 0; return; }
    const seat = game.actionSeat;
    if (seat === this.mySeat || this.botSeats[seat]) { this.friendActSince = 0; return; }
    const now = Date.now();
    if (this.isStanding(seat)) {
      // 该座位已被判站起/掉线（sittingOut → legalActions 返回 null，act 会被拒）：
      // 不能干等 30s——立即走 advance 的中途站起弃牌推进，否则全桌冻结（C-2）。
      this.friendActSince = 0;
      this.advance();
      return;
    }
    if (!this.friendActSince) this.friendActSince = now;
    if (now - this.friendActSince >= roomSync.SYNC.ACTION_TIMEOUT_SEC * 1000) {
      this.friendActSince = 0;
      const p = game.seatOf(seat);
      const r = game.act(seat, 'fold');
      if (r.ok) {
        this.pushChat(seat, p ? p.name : '', '超时未行动，自动弃牌');
        this.afterAct();
      } else {
        // 代弃被拒（座位已不可行动）：罕见但必须兜底，否则 watchFriendAction 每 1.5s 空转
        console.error('[table] 好友超时代弃被引擎拒绝', JSON.stringify({ seat, error: r.error }));
        this.advance();
      }
    }
  },

  /** 某个座位是否是「等上行的真人好友」（房主端不代打，只等待） */
  isFriendSeat(seat) {
    return this.syncLive && !this.botSeats[seat] && seat !== this.mySeat;
  },

  /**
   * 引擎自愈（房主端每次轮询检查）：轮到的本机 AI 座位却没有任何调度器在跑
   * （开局链路曾异常/定时器丢失）→ 重新挂上，保证牌局永不无声停滞。
   */
  healEngine() {
    if (!game || game.result || this.data.readyPhase) return;
    if (this.data.timeUp || this.data.summary) return;   // 本局已结束，不再驱动
    const seat = game.actionSeat;
    if (seat < 0 || seat === this.mySeat) return;
    if (this.isFriendSeat(seat)) return;          // 真人好友由 watchFriendAction 兜底
    if (this.isStanding(seat)) return;            // 站起者由 advance 的自动弃牌处理
    if (!aiTimer) this.scheduleAI();
  },

  /**
   * 引擎看门狗：AI 对战没有轮询循环可挂自愈，独立起 1.5s 定时巡检。
   * 好友房轮询里也会调 healEngine，看门狗属双保险（aiTimer 槽位防重复调度）。
   */
  startEngineWatch() {
    this.stopEngineWatch();
    this.engineWatch = setInterval(() => {
      try { this.healEngine(); } catch (e) { /* 巡检本身不许抛错 */ }
    }, 1500);
  },

  stopEngineWatch() {
    if (this.engineWatch) { clearInterval(this.engineWatch); this.engineWatch = null; }
  },

  /** 房主广播牌局状态（节流 ~500ms，好友 1.5s 轮询，无需每次渲染都写库） */
  publishPlay() {
    if (!this.syncLive || !this.isOwner || !this.roomNo) return;
    if (this.data.phase !== 'playing' || !game) return;
    const now = Date.now();
    if (this.publishTimer) clearTimeout(this.publishTimer);
    const due = this.publishDue || 0;
    if (now >= due) {
      this.publishDue = now + 500;
      this.writePlayState();
    } else {
      this.publishTimer = setTimeout(() => {
        this.publishTimer = null;
        this.publishDue = Date.now() + 500;
        this.writePlayState();
      }, due - now);
    }
  },

  writePlayState() {
    if (!this.syncLive || !this.isOwner || !this.roomNo || !game) return;
    const snap = game.snapshot();
    const state = {
      kind: 'playing',
      snapshot: snap,
      legal: game.actionSeat >= 0 ? game.legalActions(game.actionSeat) : null,
      seqBySeat: this.appliedSeqBySeat,   // 调试口：房主已消化的动作序号（按座位分道）
      readyPhase: this.data.readyPhase,
      readyList: this.data.readyList || [],
      readyLeft: this.data.readyLeft || 0,
      readyHint: this.data.readyHint || '',
      summary: this.data.summary || null,
      handNo: game.handNo
    };
    // 脏检查（评审 2026-10-15 MEDIUM「房主全量写库无脏检查」）：房主 500ms 节流后
    // 仍会因每次 render / 轮询而调到这里；若牌局实质未变（同手同街同注同池同动作
    // 座位），整条状态与上一帧逐字节相同——写库纯属空转，徒增云端配额与 RTT。
    // 以 snapshot 的关键字段拼出指纹，与上一帧比对：未变则跳过本轮写库；变动或
    // 就绪/结算这类「牌桌外」状态变化仍照写（forcePublish 会绕过本检查）。
    const fingerprint = [
      snap.handNo, snap.street, snap.currentBet, snap.pot,
      snap.actionSeat, snap.boardCodes.join(','),
      (snap.players || []).map(p => p.seat + ':' + p.stack + ':' + p.bet + ':' +
        (p.folded ? 1 : 0) + (p.allIn ? 1 : 0) + (p.sittingOut ? 1 : 0) +
        (p.hole ? p.hole.join('.') : '')).join('|'),
      this.data.readyPhase ? 'r' + (this.data.readyList || []).map(x => x.seat + (x.ready ? 1 : 0)).join(',') : '',
      this.data.summary ? 's' + JSON.stringify(this.data.summary) : ''
    ].join('#');
    if (this._lastPlayFp === fingerprint) return;
    this._lastPlayFp = fingerprint;
    // 房间公开状态写库失败必须提示：好友端下一帧就看不到牌局了，用户却完全不知情。
    // 与其它上行共用 syncFailToast 节流，避免半路复活时连续失败屏被 toast 刷屏。
    roomSync.publishState(this.roomNo, state)
      .catch(() => this.syncFailToast('牌局同步失败，好友端可能暂看不到'));
  },

  /**
   * 好友端进入镜像：把房主广播的快照装进本地 game 对象，
   * 按「我 = 本地 0 号位」重映射座位，之后复用同一套渲染与操作逻辑。
   */
  enterRemote(st) {
    const snap = st && st.snapshot;
    if (!snap) return;
    if (!game) {
      game = P.createGame({ players: [], sb: 10, bb: 20, dealerSeat: 0, seed: 'mirror-' + this.roomNo });
    }
    game.loadSnapshot(snap, this.roomSeat, { legal: st.legal });
    this.remoteMode = true;
    this.mySeat = 0;

    // 站起/坐下状态以权威端为准（sittingOut 重映射后在 0 号位）
    const me0 = game.seatOf(0);
    this.myStanding = !!me0 && !!me0.sittingOut;
    this.pendingSit = false;
    this.standingMap = {};

    // 就绪名单座位号跟随快照重映射（房主坐标 → 本地「我=0」坐标），
    // 否则镜像端座位徽章对不上座位（就绪状态上座位的渲染依赖 seat 匹配）。
    const remapS = {};
    let nextLocal = 1;
    ((snap.players && snap.players.map(p => p.seat)) || []).sort((a, b) => a - b).forEach(s => {
      remapS[s] = (s === this.roomSeat) ? 0 : nextLocal++;
    });
    const list = (st.readyList || [])
      .map(x => Object.assign({}, x, { seat: remapS[Number(x.seat)] !== undefined ? remapS[Number(x.seat)] : -1 }))
      .filter(x => x.seat >= 0);
    const myEntry = list.filter(x => Number(x.seat) === 0)[0];
    // 房主已离开结算阶段（进入就绪 / 结算清空）→ 收起本地结算弹窗
    const hostLeftResult = st.readyPhase || !snap.result;
    if (hostLeftResult) this.clearResultModalTimer();
    const patch = {
      phase: 'playing',
      remoteMode: true,
      readyPhase: !!st.readyPhase,
      readyList: list,
      myReady: !!(myEntry && myEntry.ready),
      readyLeft: st.readyLeft || 0,
      readyHint: st.readyHint || '',
      summary: st.summary || null,
      timeUp: !!st.summary
    };
    if (hostLeftResult && this.data.resultModal) patch.resultModal = null;
    // 脏检查（评审 2026-10-15 MEDIUM「镜像端每 1.5s 全量 setData 无脏检查」）：
    // 好友端 1.5s 轮询拿到房主快照；若牌局实质未变，loadSnapshot 后渲染出的 patch
    // 与上一帧逐字段相同——整帧 setData 纯属空转，触发全量 diff/重绘、低端机掉帧。
    // 以快照的关键牌桌字段拼出指纹，与上一帧比对：未变则跳过 setData + render。
    // 牌桌外字段（就绪名单/结算/计时）变化照常更新——指纹覆盖它们，不会被吞。
    const fp = [
      snap.handNo, snap.street, snap.currentBet, snap.pot, snap.actionSeat,
      snap.boardCodes.join(','),
      (snap.players || []).map(p => p.seat + ':' + p.stack + ':' + p.bet + ':' +
        (p.folded ? 1 : 0) + (p.allIn ? 1 : 0) + (p.sittingOut ? 1 : 0)).join('|'),
      !!st.readyPhase, (st.readyList || []).map(x => x.seat + (x.ready ? 1 : 0)).join(','),
      st.readyLeft, st.readyHint, JSON.stringify(st.summary || null),
      snap.result ? 'r' + JSON.stringify(snap.result.winners) : '',
      (snap.reveal && JSON.stringify(snap.reveal)) || ''
    ].join('#');
    if (this._lastRemoteFp === fp) return;
    this._lastRemoteFp = fp;
    this.setData(patch);
    this.render();
    // 镜像端不驱动引擎：若轮到我，只起本地计时环做视觉反馈
    if (game.actionSeat === 0 && !game.result) this.startTimer();
  },

  // ---------- 牌局快照：中途退出后可重新进入续局 ----------

  /** 存快照：座位、剩余筹码、第几手、上一手庄位（仅房主侧，续局用） */
  saveSnapshot() {
    if (this.mode !== 'friend' || !this.isOwner || !this.roomNo || this.data.phase !== 'playing' || !game) return;
    snapshot.save(this.roomNo, {
      handNo: game.handNo,
      dealerSeat: this.prevDealerSeat,
      startStacks: this.startStacks,   // 盈亏口径跟随续局保持连续
      remainSec: this.data.remainSec,  // 倒计时剩余时间，续局接着倒数
      standing: this.myStanding,   // 续局时保留「已站起观战」状态
      pendingSit: this.pendingSit, // 续局时保留「已坐下、下一手入局」状态
      seats: game.players.map(p => ({
        seat: p.seat, name: p.name, stack: p.stack, isMe: !!p.isHuman, style: p.style
      }))
    });
  },

  clearSnapshot() {
    snapshot.clear(this.roomNo);
  },

  /**
   * 重新进入房间时恢复牌局：用快照里的座位与筹码重建牌桌，重发当前这一手。
   * 仅房主侧生效（访客本地无该房间的牌局数据）。
   */
  restoreRoom() {
    if (this.mode !== 'friend' || !this.roomNo || !this.isOwner) return false;
    const snap = snapshot.load(this.roomNo);
    if (!snap) return false;
    this.myStanding = !!snap.standing;   // 站起观战状态随续局恢复
    this.pendingSit = !!snap.pendingSit; // 「已坐下待入局」状态随续局恢复

      const players = snap.seats.map(s => ({
        id: s.isMe ? 'me' : 'p' + s.seat,
        // 续局：我的名字始终用当前昵称（快照里存的是上一局的名字，可能已改过）
        name: s.isMe ? auth.myName('你') : (s.name || '玩家'),
      seat: s.seat,
      stack: s.stack > 0 ? s.stack : 1000,
      isHuman: !!s.isMe,
      style: s.style || { aggro: 0.5, tight: 0.35 }
    }));
    this.setData({ phase: 'playing' });
    try {
      const started = this.initGame(players, snap);
      if (!started || !game || !game.handNo) throw new Error('engine not started');
    } catch (e) {
      // 续局失败（快照损坏/引擎异常）：清掉快照回到等待室，绝不无声卡死
      console.error('[table] 续局失败，回退等待室', JSON.stringify({
        stage: 'restore-room', message: e && e.message, stack: e && e.stack
      }));
      game = null;
      this.clearSnapshot();
      this.initWaiting();
      wx.showToast({ title: '续局失败，请重新开局', icon: 'none' });
      return true;
    }
    this.startClock(snap.remainSec);   // 倒计时接着上次剩余时间继续
    wx.showToast({ title: '已回到房间 · 第 ' + snap.handNo + ' 手', icon: 'none' });
    return true;
  },

  /** 启动/重置空闲销毁倒计时（仅好友房、房间号存在时生效） */
  armExpire() {
    this.clearExpire();
    if (this.mode === 'friend' && this.roomNo) {
      expireTimer = setTimeout(() => this.destroyRoom(), ROOM_TTL_MS);
    }
  },

  clearExpire() {
    if (expireTimer) { clearTimeout(expireTimer); expireTimer = null; }
  },

  /** 超时无人加入：关闭云端房间并退到首页 */
  destroyRoom() {
    if (this.data.phase !== 'waiting') return;
    this.roomClosed = true;
    this.clearExpire();
    this.clearClock();
    if (this.roomNo) {
      auth.closeRoom(this.roomNo).catch(() => {});   // 销毁云端房间，不影响本地退出
    }
    wx.showToast({ title: '房间超时已自动解散', icon: 'none' });
    this.onBack();
  },

  /** 房主添加电脑玩家，模拟好友进入并坐下 */
  addBot() {
    if (this.data.phase !== 'waiting') return;
    if (!this.isOwner) {
      wx.showToast({ title: '仅房主可添加玩家', icon: 'none' });
      return;
    }
    const seats = this.data.waitSeats.slice();
    if (seats.filter(s => s.occupied).length >= this.maxSeats) {
      wx.showToast({ title: '已达限定人数', icon: 'none' }); return;
    }
    const empty = seats.find(s => !s.occupied);
    if (!empty) { wx.showToast({ title: '房间已满', icon: 'none' }); return; }
    const botNo = seats.filter(s => s.isBot).length + 1;
    empty.occupied = true;
    empty.isBot = true;
    // 好友房沿用「好友N」（等真人来了换号的占位叫法）；AI 桌用预设对手名
    empty.name = this.botLabel(botNo - 1);
    empty.stack = Number(empty.stack) || DEFAULT_BUY_IN;
    const occupiedCount = seats.filter(s => s.occupied).length;
    this.setData({
      waitSeats: seats,
      seats: this.buildWaitSeats(seats),
      canStart: this.canStartOf(seats)
    });
    // 第一位好友坐下 → 房间「有人进去了」，取消自动销毁
    if (occupiedCount >= 2) this.clearExpire();
    this.publishWait();   // 广播机器人布局，好友端同步可见
  },

  /** 房主请出某个电脑玩家（腾出空位） */
  kickBot(e) {
    if (this.data.phase !== 'waiting') return;
    const seat = e.currentTarget.dataset.seat;
    const seats = this.data.waitSeats.slice();
    const t = seats.find(s => s.seat === seat);
    if (!t || !t.isBot) return;
    t.occupied = false;
    t.isBot = false;
    t.name = '';
    let n = 0;
    seats.forEach(s => { if (s.isBot) s.name = this.botLabel(n++); });
    const occupiedCount = seats.filter(s => s.occupied).length;
    this.setData({
      waitSeats: seats,
      seats: this.buildWaitSeats(seats),
      canStart: this.canStartOf(seats)
    });
    this.publishWait();
  },

  /** 电脑玩家的名字：AI 桌用预设对手名，好友房叫「好友N」 */
  botLabel(idx) {
    return this.mode === 'friend' ? ('好友' + (idx + 1)) : BOT_NAMES[idx % BOT_NAMES.length];
  },

  /** 复制房间号 */
  copyRoom() {
    wx.setClipboardData({
      data: this.roomNo,
      success: () => wx.showToast({ title: '房间号已复制', icon: 'success' })
    });
  },

  /**
   * 顶栏返回：
   *  - 牌局进行中 → 二次确认（按钮文案 ≤4 字，真机限制），确认后存快照离开，房间保留；
   *  - 等待室      → 房主空等放弃则关闭房间，访客离开不影响房间。
   */
  onBack() {
    if (this.mode === 'friend' && this.data.phase === 'playing') {
      wx.showModal({
        title: '退出房间？',
        content: '房间会保留，可从首页「我的房间」重新进入；若只是不想打这一局，点「站起退出本局」即可留在房间内',
        confirmText: '退出',
        cancelText: '留下',
        success: res => { if (res.confirm) this.leaveRoom(); },
        fail: () => this.leaveRoom()   // 弹窗异常时兜底离开，避免卡死在牌桌
      });
      return;
    }
    this.leaveRoom();
  },

  /** 真正离开页面：正常导航栈直接返回；分享卡片冷启动进桌时栈为空，兜底回首页 */
  leaveRoom() {
    if (this.mode === 'friend') {
      if (this.data.phase === 'waiting') {
        // 房主空等（无人加入）离开 → 视为放弃房间，关闭云端房间清理残留
        const cnt = this.data.waitSeats.filter(s => s.occupied).length;
        if (this.isOwner && !this.roomClosed && cnt <= 1 && this.roomNo) {
          this.roomClosed = true;
          auth.closeRoom(this.roomNo).catch(() => {});
          this.clearSnapshot();
        }
      } else {
        this.saveSnapshot();   // 牌局进行中离开：暂存本地快照，云端房间保持 active
      }
      // 好友离房释放自己的座位行；房主保留行（房间仍在，可回来续局）
      if (this.syncLive && !this.isOwner) {
        roomSync.leave(this.roomNo).catch(() => {});
      }
      this.stopSync();
    }
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/index/index' })
    });
  },

  /**
   * 房主点开始：按已坐下座位构建玩家并发牌（访客无权限，只能等待）。
   * 防卡死三道闸：
   *   1) _starting 防抖：连点/异步间隙内重复触发只走一次；
   *   2) 组局来源兜底：云端布局异常（<2 人）时回退本地等待室布局；
   *   3) initGame 全程 try/catch：任何异常都回退等待室并提示，绝不无声卡死。
   */
  async startGame() {
    if (this.data.phase !== 'waiting') return;
    if (this._starting) return;
    if (!this.isOwner) {
      wx.showToast({ title: '等待房主开始', icon: 'none' });
      return;
    }
    this.clearExpire();   // 已开始对局，停止空闲销毁倒计时
    if (!this.data.canStart) {
      wx.showToast({ title: '至少 2 人才能开始', icon: 'none' });
      return;
    }
    this._starting = true;
    if (this.data.soundOn) sfx.play('click');
    try {
      // 开局前先拉一次最新座位布局（加机器人/好友入座后可能还没轮到轮询）
      if (this.syncLive) {
        try { await this.pollOnce(); } catch (e) { this.onSyncLost(); }
      }
      const toPlayer = s => ({
        id: s.isMe ? 'me' : (s.isBot ? 'bot' + s.seat : 'p' + s.seat),
        // 我的名字用微信昵称（好友端能看到）；他人沿用云端广播/等待室里的名字
        name: s.isMe ? (s.name || this.meLabel(false)) : (s.name || '玩家'),
        seat: s.seat,
        // 按各自买入额发筹码（未指定者回落到默认买入）
        stack: Number(s.stack) || DEFAULT_BUY_IN,
        isHuman: !s.isBot,     // 真人（含好友）的底牌进快照，供镜像端渲染
        style: { aggro: 0.3 + Math.random() * 0.5, tight: 0.25 + Math.random() * 0.45 }
      });
      // 有跨设备同步时按云端布局组局（真人行 + 机器人）；否则用本地等待室布局
      let players = (this.syncLive
        ? roomSync.buildWaitLayout(this.roomRows, this.hostState, this.maxSeats, this.roomSeat)
        : (this.data.waitSeats || [])).filter(s => s.occupied).map(toPlayer);
      // 兜底：云端布局异常（如 state 残留 playing 导致机器人丢失）→ 用本地布局重试
      if (players.length < 2) {
        players = (this.data.waitSeats || []).filter(s => s.occupied).map(toPlayer);
      }
      if (players.length < 2) {
        wx.showToast({ title: '坐下的人数不足', icon: 'none' });
        return;   // 留在等待室，用户可继续加人
      }

      // 我的渲染座位必须与「me」玩家一致（换座后云端行滞后时防错位）
      const mePlayer = players.filter(p => p.id === 'me')[0];
      if (mePlayer) this.mySeat = mePlayer.seat;

      // 记录机器人座位：房主端不为它们等待上行，超时也不管
      this.botSeats = {};
      players.forEach(p => { if (p.id.indexOf('bot') === 0) this.botSeats[p.seat] = true; });
      this.pendingSitMap = {};

      this.setData({ phase: 'playing' });
      let started = false;
      try {
        started = this.initGame(players);
      } catch (err) {
        console.error('[table] 开局异常，回退等待室', JSON.stringify({
          stage: 'start-game', message: err && err.message, stack: err && err.stack
        }));
      }
      if (!started || !game || !game.handNo) {
        game = null;
        this.setData({ phase: 'waiting' });
        this.renderWait();   // 恢复等待室座位环与操作条，用户可直接重试
        if (started === false) {
          wx.showToast({ title: '开局失败，请重试', icon: 'none' });
        }
        return;
      }
      this.startClock();   // 开始游戏才启动时长倒计时
      this.publishPlay();  // 立即广播，让好友进入镜像
    } finally {
      this._starting = false;
    }
  },

  /**
   * 游戏时长倒计时：到点自动结束本局并统计盈亏（0 = 不限时，不启动）
   * @param {number} [fromSec] 续局时传入剩余秒数，接着上次继续倒数
   */
  startClock(fromSec) {
    this.clearClock();
    if (!this.durationMin) {
      this.setData({ timeUp: false, remainSec: 0, remainText: '' });
      return;
    }
    let left = (typeof fromSec === 'number' && fromSec > 0) ? fromSec : this.durationMin * 60;
    if (left <= 0) {
      this.setData({ timeUp: true, remainSec: 0, remainText: '00:00' });
      return;
    }
    // 续局从断点恢复时，若已过最后 1 分钟阈值则不再补播钟音
    this.sfxClockWarned = left <= 60;
    this.setData({ timeUp: false, remainSec: left, remainText: this.fmtRemain(left) });
    clock = setInterval(() => {
      left--;
      if (left <= 0) {
        this.clearClock();
        this.endGame();
        return;
      }
      // 限时局最后 1 分钟：与 UI 变橙（remainSec <= 60）同阈值，钟音一声
      if (left === 60 && !this.sfxClockWarned) {
        this.sfxClockWarned = true;
        if (this.data.soundOn) sfx.play('clock');
      }
      this.setData({ remainSec: left, remainText: this.fmtRemain(left) });
    }, 1000);
  },

  clearClock() {
    if (clock) { clearInterval(clock); clock = null; }
  },

  /** 剩余秒 → mm:ss（超过 1 小时显示 h:mm:ss） */
  fmtRemain(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const mm = String(m).padStart(2, '0');
    const sss = String(ss).padStart(2, '0');
    return h > 0 ? (h + ':' + mm + ':' + sss) : (mm + ':' + sss);
  },

  /**
   * 时长到点：结束本局，统计所有参与人盈亏（当前筹码 − 起始筹码），按盈亏排名。
   * 结束的是「这一局」，不是退出房间——房间仍在，可再来一局或返回。
   */
  endGame() {
    if (!game) return;
    if (timer) { clearInterval(timer); timer = null; }
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    this.clearReadyClock();

    const rows = game.players.map(p => ({
      seat: p.seat,
      name: p.name,
      stack: p.stack,
      // 盈亏基准 = 起始筹码。兜底不再是常数 1000（站起观战者/续局快照缺项者曾被
      // 凭空记 ±几百的假盈亏），而是该玩家当前筹码——即「无基准记录则视为 0 盈亏」，
      // 与 startStacks 的记账语义一致（评审 2026-10-15 MEDIUM）。
      net: p.stack - (this.startStacks[p.seat] !== undefined ? this.startStacks[p.seat] : p.stack),
      isMe: !!p.isHuman
    })).sort((a, b) => b.net - a.net);

    const me = rows.filter(r => r.isMe)[0];
    this.setData({
      timeUp: true,
      isMyTurn: false,
      legal: null,
      readyPhase: false,
      readyList: [],
      myReady: false,
      readyLeft: 0,
      readyHint: '',
      summary: {
        title: '本局结束 · 时长已到',
        sub: '共 ' + game.handNo + ' 手 · 全员盈亏结算',
        rows: rows,
        myNet: me ? me.net : 0,
        myNetText: me ? ((me.net >= 0 ? '+' : '') + me.net) : '0'
      }
    });

    // 到点也记一笔战绩（盈亏 = 结束时相对起始筹码的变化）
    const meP = game.seatOf(this.mySeat);
    if (meP) {
      this.pendingRecord = {
        tableId: this.roomNo || 'ai',
        handNo: game.handNo,
        seat: this.mySeat,
        hole: meP.hole.map(c => P.cardToCode(c)).join(' '),
        board: game.board.map(c => P.cardToCode(c)).join(' '),
        handType: '时长结束',
        net: me ? me.net : 0,
        won: me ? me.net > 0 : false
      };
      this.uploadRecord();
    }
  },

  /** 结束后「再来一局」：重置筹码与倒计时，同一批玩家继续 */
  restartGame() {
    if (this.remoteMode) {
      wx.showToast({ title: '等待房主开始下一局', icon: 'none' });
      return;
    }
    if (!game) return;
    const players = game.players.map(p => ({
      id: p.id, name: p.name, seat: p.seat, stack: 1000,
      isHuman: !!p.isHuman, style: p.style
    }));
    this.setData({ summary: null, timeUp: false });
    this.initGame(players);   // startHand 内部会清理就绪状态
    this.startClock();
  },

  onSummaryClose() {
    this.setData({ summary: null });
  },

  /** 转发内容：好友房带房间号，好友点开即自动加入 */
  onShareAppMessage() {
    if (this.mode === 'friend') {
      return {
        title: '来「博弈论」和我打一局，房间号 ' + this.roomNo,
        path: '/pages/index/index?room=' + this.roomNo
      };
    }
    return { title: '博弈论 · AI 对战', path: '/pages/index/index' };
  },

  onUnload() {
    if (timer) clearInterval(timer);
    if (aiTimer) clearTimeout(aiTimer);
    this.clearClock();
    this.clearExpire();
    this.clearReadyClock();
    this.clearResultTimer();
    this.clearResultModalTimer();
    this.clearFoldTimer();
    this.stopEngineWatch();
    this.stopSfxPump();
    this.stopSync();
    // 系统返回手势 / 页面被直接销毁时静默存快照，保证下次进入能续局
    this.saveSnapshot();
  },

  initGame(players, snap) {
    const ps = players || NAMES.map((name, i) => ({
      id: 'u' + i,
      // AI 桌：我的座位用微信昵称，其余沿用预设对手名（NAMES[0] 是「我」的占位）
      name: i === this.mySeat ? auth.myName('你') : name,
      seat: i,
      stack: 1000,
      isHuman: i === this.mySeat,
      style: { aggro: 0.3 + Math.random() * 0.5, tight: 0.25 + Math.random() * 0.45 }
    }));
    game = P.createGame({
      players: ps,
      sb: 10,
      bb: 20,
      dealerSeat: ps[ps.length - 1].seat,
      seed: 'mp-' + Date.now()
    });
    if (snap) {
      // 续局：回退到上一手庄位与手数，startHand 轮转后即重发快照记录的那一手
      if (snap.dealerSeat !== undefined && snap.dealerSeat !== null) game.dealerSeat = snap.dealerSeat;
      game.handNo = Math.max(0, (snap.handNo || 1) - 1);
    }
    // 起始筹码：新建牌局记录当前值，续局沿用快照里的原始起始值（盈亏口径一致）
    if (snap && snap.startStacks) {
      this.startStacks = snap.startStacks;
    } else {
      this.startStacks = {};
      game.players.forEach(p => { this.startStacks[p.seat] = p.stack; });
    }
    // AI 练习模式首手给出教练提示，操作一次后自动收起
    this.setData({ coachShow: this.mode === 'ai' });
    // 引擎看门狗：双模式通用巡检，任何一环掉链 1.5s 内自动接上
    this.startEngineWatch();
    return this.startHand();
  },

  /** 发一手牌；返回是否成功开局（失败时上层据此回退等待室，防无声卡死） */
  startHand() {
    this.clearResultTimer();     // 上一手的结算展示定时器作废（防串手）
    this.clearResultModalTimer();
    this.resultModalHand = -1;   // 新一手允许重新调度结算弹窗（手数可能轮回重置）
    // 「坐下加入游戏」下一手才生效：本手发牌前正式落座并入局
    if (this.pendingSit) {
      this.pendingSit = false;
      this.myStanding = false;
    }
    // 跨设备：好友的「坐下」上行到本手才生效（清 sittingOut 正式入局）
    if (this.pendingSitMap && game) {
      Object.keys(this.pendingSitMap).forEach(s => {
        const p = game.seatOf(Number(s));
        if (p) p.sittingOut = false;
      });
      this.pendingSitMap = {};
    }
    // 新的一手开始，清理上一手的就绪状态与结算弹窗
    this.clearReadyClock();
    this.readyMap = {};
    this.setData({
      readyPhase: false, readyList: [], myReady: false, readyLeft: 0, readyHint: '',
      resultModal: null
    });

    // 演示：筹码不足自动补充；同步修正起始筹码，避免补充额被算成盈亏
    game.players.forEach(p => {
      if (p.stack < 20) {
        const add = 1000 - p.stack;
        p.stack = 1000;
        if (this.startStacks[p.seat] !== undefined) this.startStacks[p.seat] += add;
      }
    });
    game.players.forEach(p => { p.net = 0; });

    const prevDealer = game.dealerSeat;   // 供快照记录：恢复时从这里轮转到下一庄位
    const r = game.startHand();
    if (!r.ok) {
      wx.showToast({ title: r.error, icon: 'none' });
      return false;
    }
    this.prevDealerSeat = prevDealer;
    myActText = '';
    myActCls = '';
    this.render();
    this.forcePublish();   // 新手牌是关键状态：穿透节流立即广播，好友马上看到发牌

    this.advance();
    return true;
  },

  /**
   * 推进下一个行动者：轮到我时起计时器，否则排 AI。
   * 若我已站起观战，则视为弃牌并直接跳过（站起者不参与本手）。
   * 渲染异常不允许打断引擎推进（render 内部已自捕获，这里再兜一层）。
   */
  advance() {
    if (!game || game.result) return;
    try {
      const seat = game.actionSeat;
      // 已站起的人（含超时未准备被自动站起者）不参与本手：轮到即自动弃牌跳过。
      // ⚠️ sittingOut 置位后 legalActions 返回 null，act 会被拒——
      // 必须先代弃（此时还没标 sittingOut，legal 仍合法）或直接由引擎
      // 推进路径处理，否则该座位永远轮空 → 全桌冻结（C-2 核心守卫）。
      if (this.isStanding(seat)) {
        const p = game.seatOf(seat);
        if (p && p.sittingOut && !p.folded) {
          // 已被标 sittingOut：走引擎推进路径（advance 内部按弃牌跳过）
          game.advanceInHand();
          this.afterAct();
          return;
        }
        const r = game.act(seat, 'fold');
        if (r.ok) { this.afterAct(); return; }
      }
      if (seat === this.mySeat) {
        this.startTimer();
        return;
      }
      // 跨设备：真人好友的座位等动作上行（房主 1.5s 轮询消费，30s 超时代弃）
      if (this.isFriendSeat(seat)) {
        this.friendActSince = this.friendActSince || Date.now();
        this.render();
        return;
      }
      this.scheduleAI();
    } catch (e) {
      console.error('[table] advance 异常', JSON.stringify({
        stage: 'advance', seat: game.actionSeat, message: e && e.message, stack: e && e.stack
      }));
    }
  },

  /**
   * 站起：退出当前牌局（不退出房间），不再参与发牌与行动，可随时坐下重新入局。
   * 规则与主流 App 一致：需先弃牌或等本手结束才能离桌，避免中途抽身影响牌局。
   */
  standUp() {
    if (!game || this.myStanding) return;
    const me = game.seatOf(this.mySeat);
    if (!me) return;
    if (!(me.folded || game.result)) {
      wx.showToast({ title: '本手结束后或弃牌后可站起', icon: 'none' });
      return;
    }
    this.myStanding = true;
    this.pendingSit = false;
    this.pushChat(this.mySeat, this.meLabel(false), '站起观战');
    if (this.remoteMode) {
      // 镜像端：站起动作上行，房主把该座位标记 sittingOut。
      // 站起/坐下的上行失败必须提示——沉默失败会把 UI 观战态与权威端撕裂整个房间。
      roomSync.pushAction(this.roomNo, { type: 'stand', seat: this.roomSeat })
        .catch(() => this.syncFailToast('站起未同步成功，请检查网络'));
    }
    wx.showToast({ title: '已退出本局，可坐下重新加入', icon: 'none' });
    if (this.data.readyPhase) {
      if (this.remoteMode) {
        // 镜像端：退出计票由房主处理，本地先把我的条目摘掉
        const list = (this.data.readyList || []).filter(x => Number(x.seat) !== Number(this.roomSeat));
        this.setData({ readyList: list, myReady: false });
      } else {
        // 就绪阶段站起 → 退出计票，其余人齐了就直接发下一手
        const seated = (this.data.readyList || []).filter(x => this.seatedOf(x.seat));
        this.setData({ readyList: seated });
        this.renderReady();
        this.checkAllReady();
      }
    }
    this.render();
  },

  /**
   * 坐下：重新入局，但「下一手」才生效——不会中途插进已经开始的牌局。
   * 当前本手仍保持观战（轮到我自动弃牌），下一手发牌时正式落座。
   */
  sitDown() {
    if (!game) return;
    if (!this.myStanding && !this.pendingSit) return;   // 已在局内
    this.pendingSit = true;
    this.myStanding = true;    // 本手仍观战，startHand 时才转为入局
    this.pushChat(this.mySeat, this.meLabel(false), '重新入局');
    if (this.remoteMode) {
      // 镜像端：坐下的上行由房主记 pendingSitMap，下一手 startHand 才生效。
      // 同上：上行失败必须让用户知道，否则到下一手才发现自己没入局。
      roomSync.pushAction(this.roomNo, { type: 'sit', seat: this.roomSeat })
        .catch(() => this.syncFailToast('坐下未同步成功，请重试'));
    }
    wx.showToast({ title: '下一手开始发牌入局', icon: 'none' });
    if (this.data.readyPhase) {
      if (this.remoteMode) { this.render(); return; }   // 镜像端就绪状态以房主广播为准
      this.enterReadyPhase();   // 就绪阶段坐下 → 重新计票（我也要点「准备就绪」）
      return;
    }
    this.render();
  },

  // ---------- 渲染 ----------
  // 渲染与引擎严格解耦：render 内任何异常都只降级本帧画面并打日志，
  // 绝不向上抛——否则 startHand→render→advance 链路断掉，牌局无声冻结。
  render() {
    try {
      const showdown = game.street === P.STREET.SHOWDOWN;
      const result = game.result;
      // 就绪阶段：上一手的牌全部收走（公共牌/底牌/赢家特效），桌面清空等下一局，
      // 就绪状态以徽章形式挂在各个座位上（不再在底部条里逐人罗列）。
      const readyPhase = this.data.readyPhase;
      const readyLs = readyPhase ? (this.data.readyList || []) : [];

      // 公共牌
      // 摊牌高亮：以「我的最佳成手 5 张」为依据，把构成牌型的牌标出来
      const myReveal = game.showdownReveal ? game.showdownReveal[this.mySeat] : null;
      const bestSet = (result && myReveal && myReveal.hand) ? new Set(myReveal.hand) : null;

      const board = readyPhase ? [] : this.markBest(game.board.map((card, i) => this.cardData(card, i)), bestSet);
      const placeholders = readyPhase ? 0 : Math.max(0, 3 - game.board.length);
      const placeholdersArr = [];
      for (let i = 0; i < placeholders; i++) placeholdersArr.push({ phkey: i });

      // 边池
      let sidePots = [];
      if (!readyPhase && game.pots && game.pots.length > 1) {
        sidePots = game.pots.slice(1).map(p => p.amount);
      }

      // 站起观战：仍在房间内，但不参与发牌与行动
      const standing = this.myStanding === true;
      // 已坐下但待下一手入局时同样算「在座」（需点就绪），只是本手仍不参与
      const mySeated = this.pendingSit || !standing;
      const me = game.seatOf(this.mySeat);
      const canStand = !!me && !standing && (!!me.folded || !!result);

      // 座位环：所有玩家（含「我」）都渲染在椭圆上——「我」锚定在底部中央，
      // 与等待室共用同一套坐标系（ringPositions）→ 开局瞬间座位位置完全连续、无跳变。
      // 我的底牌仍单独展示在底部我的操作区（myzone），座位卡只放身份/筹码/下注/状态。
      const allSeats = game.players.map(p => p.seat);
      const pos = ringPositions(allSeats, this.mySeat);
      const seats = game.players.map(p => {
        const pp = pos[p.seat] || { x: 50, y: 20 };
        const isMe = p.seat === this.mySeat;
        const isWinner = !readyPhase && result && result.winners.indexOf(p.seat) !== -1;
        const name = p.name || '玩家';
        // 就绪徽章数据：true=已准备 / false=准备中 / null=不显示（非就绪阶段或不在就绪名单）
        const rEntry = readyLs.filter(x => Number(x.seat) === Number(p.seat))[0];
        const readyFlag = rEntry ? !!rEntry.ready : null;
        // 对手手中暗牌：未摊牌、未弃牌、有底牌 → 显示两张小牌背（WPK 式：一眼看出谁还在手）
        const cardsBack = !readyPhase && !isMe && !p.folded && !showdown && p.hole.length === 2;
        return {
          seat: p.seat,
          seatNo: p.seat + 1,
          name: name,
          initial: name.slice(0, 1),
          x: pp.x,
          y: pp.y,
          stack: p.stack,
          bet: readyPhase ? 0 : p.bet,
          allIn: readyPhase ? false : p.allIn,
          folded: readyPhase ? false : p.folded,
          standing: this.isStanding(p.seat),
          active: !readyPhase && game.actionSeat === p.seat && !result,
          isDealer: game.dealerSeat === p.seat,
          isSB: game.sbSeat === p.seat,
          isBB: game.bbSeat === p.seat,
          isMe,
          ready: readyPhase ? readyFlag : null,
          // 对手底牌：平时不展示（德扑常识），仅摊牌时亮出；我在底部 myzone 单独展示
          cardsBack,
          showCards: !readyPhase && !isMe && showdown && !p.folded && p.hole.length === 2,
          hole: readyPhase ? [] : this.markBest(p.hole.map((card, ci) => this.cardData(card, ci)), bestSet),
          win: !!isWinner,
          // 摊牌后赢家座位直接飘出赢得的筹码数（WPK 式结算反馈）
          winGain: isWinner ? result.awards.filter(a => a.seat === p.seat).reduce((s, a) => s + a.amount, 0) : 0,
          timer: !readyPhase && game.actionSeat === p.seat ? tick : '',
          timerPct: !readyPhase && game.actionSeat === p.seat ? Math.round(tick / TICK_MAX * 100) : 0,
          actText: !readyPhase && p.seat === this.mySeat ? myActText : '',
          actCls: !readyPhase && p.seat === this.mySeat ? myActCls : ''
        };
      });

      // 我的信息（底部 myzone：手牌 + 筹码 + 状态）。就绪阶段底牌收走，等下一手再发
      const meP = game.seatOf(this.mySeat);
      const myCards = readyPhase ? [] : this.markBest(
        (meP && !standing) ? meP.hole.map((card, i) => this.cardData(card, i)) : [], bestSet);

      // 操作区（站起观战时不参与行动）
      const isMyTurn = game.actionSeat === this.mySeat && !result && !standing;
      let legal = null;
      let raiseTo = 0;
      if (isMyTurn) {
        // 镜像端优先用房主下发的合法性（快照带不了 canRaise 细节），取不到再本地算
        legal = (game.remoteLegal && game.remoteLegal.seat === this.mySeat)
          ? game.remoteLegal
          : game.legalActions(this.mySeat);
        if (legal) raiseTo = this.data.raiseTo >= legal.minRaiseTo ? this.data.raiseTo : legal.minRaiseTo;
      }
      // 自定义下注面板的上下限：MAX = 全下金额（raiseTo 可达上限），最小值由合法下注决定
      const raiseMin = (isMyTurn && legal) ? legal.minRaiseTo : 0;
      const raiseMax = (isMyTurn && legal) ? legal.maxRaiseTo : 0;
      // 非我回合 / 不可加注时收起自定义面板，避免残留数值误导
      const raiseCustom = isMyTurn && legal && legal.canRaise ? this.data.raiseCustom : false;
      // 实际会提交的加注额（与 onRaise 钳制同口径，仅用于按钮文案）：
      // 数字输入框能填出低于下限的值，而失焦补正未必先触发；到达上限则等价全下。
      let raiseSubmit = 0, raiseAllIn = false;
      if (isMyTurn && legal && legal.canRaise) {
        raiseSubmit = Math.max(legal.minRaiseTo, Math.round(this.data.raiseTo || 0));
        raiseAllIn = raiseSubmit >= legal.maxRaiseTo;
      }

      const curPlayer = game.actionSeat >= 0 ? game.seatOf(game.actionSeat) : null;

      this.setData({
        handNo: game.handNo,
        streetCn: readyPhase ? '等待下一局' : P.STREET_CN[game.street],
        pot: readyPhase ? 0 : game.potTotal(),
        sidePots,
        board,
        boardPlaceholders: placeholdersArr,
        seats,
        legal,
        raiseTo,
        raiseMin,
        raiseMax,
        raiseCustom,
        raiseSubmit,
        raiseAllIn,
        isMyTurn,
        // 非我回合时自动解除弃牌确认态（下一手/对手行动后不再误触发）
        foldConfirm: isMyTurn ? this.data.foldConfirm : false,
        myStanding: standing,
        mySeated: mySeated,
        canStand: canStand,
        // 我的区域（底部）
        myCards,
        myStack: meP ? meP.stack : 0,
        myBet: meP ? meP.bet : 0,
        myFolded: meP ? !!meP.folded : false,
        myActive: game.actionSeat === this.mySeat && !result,
        myTimer: game.actionSeat === this.mySeat ? tick : '',
        myTimerPct: game.actionSeat === this.mySeat ? Math.round(tick / TICK_MAX * 100) : 0,
        myDealer: game.dealerSeat === this.mySeat,
        mySB: game.sbSeat === this.mySeat,
        myBB: game.bbSeat === this.mySeat,
        myActText: myActText,
        myActCls: myActCls,
        currentPlayerName: curPlayer ? curPlayer.name : '',
        result: result ? this.buildResult(result) : null,
        // 结算清空时同步收起弹窗（新一手/回等待室），有结算时保留现状
        resultModal: result ? this.data.resultModal : null
      });

      this.renderAdvice(isMyTurn);
    } catch (e) {
      // 降级渲染：清掉可能半更新的座位/公共牌，保住基本框架，引擎照常推进
      console.error('[table] render 异常，已降级本帧', JSON.stringify({
        stage: 'render', mySeat: this.mySeat, message: e && e.message, stack: e && e.stack
      }));
      try {
        this.setData({
          seats: [], board: [], boardPlaceholders: [], sidePots: [],
          legal: null, isMyTurn: false, myActive: false, advice: {}
        });
      } catch (e2) { /* 连降级都失败时放弃本帧 */ }
    }
    // 结算展示调度（本地端与镜像端统一走这里）：
    // 摊牌亮牌先在牌桌上停留 RESULT_SHOW_MS 让各家牌面完整可见，之后**自动弹出**
    // 「每人盈亏」结算弹窗；弹窗停留 RESULT_MODAL_MS 自动关闭并进入就绪阶段
    // （防无人操作卡局）。就绪条上另留「查看结算」入口可随时回看明细。
    // 每手只调度一次（resultModalHand 守卫，防镜像端 2s 轮询重复挂表、重弹）。
    if (game && game.result && !this.data.readyPhase && !this.data.timeUp &&
        this.resultModalHand !== game.handNo) {
      this.resultModalHand = game.handNo;
      this.clearResultTimer();
      this.resultTimer = setTimeout(() => {
        this.resultTimer = null;
        this.showResultModal();   // 镜像端仅开弹窗，就绪阶段以房主广播为准
      }, this.resultShowMs || RESULT_SHOW_MS);
    }
    // 房主端：每次渲染后节流广播最新状态，好友端 1.5s 内看到
    this.publishPlay();
  },

  /** 牌 ID → 渲染数据（花色配色：四色牌时 ♠黑 / ♣绿 / ♦蓝 / ♥红） */
  cardData(card, idx) {
    const s = P.suitOf(card);
    return {
      idx: idx || 0,                 // 供 wx:key 使用的稳定键
      code: P.cardToCode(card),      // 摊牌时用于判断是否属于最佳成手 5 张（机读码，恒为 "Th" 形式）
      hi: false,                     // 是否属于最佳 5 张（摊牌高亮）
      rank: P.RANK_DISPLAY[P.rankOf(card)],   // 界面显示文本（10 显示 "10"，非 "T"）
      suit: P.SUIT_CHARS[s],
      cls: SUIT_CLS[s]
    };
  },

  /** 摊牌时把「最佳成手 5 张」标出来：传入 code 集合，给牌数据打 hi 标记 */
  markBest(cards, bestSet) {
    if (!bestSet) return cards;
    return cards.map(c => {
      c.hi = bestSet.has(c.code);
      return c;
    });
  },

  /** 操作反馈：震动（音效由 sfx 事件泵按动作类型精确发声，这里不再叠 click） */
  feedback() {
    if (this.data.soundOn && wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  },

  // ---------- 音效：引擎事件流 → 合成音（utils/sfx.js） ----------

  /** 启动音效事件泵（300ms 轮询；声音开关在 drainSfx 内逐次判断，切换即时生效） */
  startSfxPump() {
    this.stopSfxPump();
    this.sfxPump = setInterval(() => {
      try { this.drainSfx(); } catch (e) { /* 音效绝不影响牌局 */ }
    }, 300);
  },

  stopSfxPump() {
    if (this.sfxPump) { clearInterval(this.sfxPump); this.sfxPump = null; }
  },

  /**
   * 消化引擎事件流（game.events，seq 单调递增）→ 音效：
   *   hand_start/deal → 发牌　action(fold/check/call/raise/allin) → 对应动作音
   *   hand_end → 我赢 = 胜利琶音，否则中性收尾音。
   * 「轮到我」提示不依赖 turn 事件（镜像端事件流为空），统一用 isMyTurn
   * 的 false→true 边沿检测——本地端与镜像端行为一致。
   * 快照续局/镜像重建会把 events 重置，序号超界时回收敛到当前长度（不补播历史音）。
   */
  drainSfx() {
    if (this.data.phase !== 'playing') return;
    const events = (game && game.events) || [];
    if (this.sfxSeq > events.length) this.sfxSeq = events.length;   // 重建后收敛
    if (this.data.soundOn) {
      while (this.sfxSeq < events.length) {
        const e = events[this.sfxSeq++];
        switch (e.type) {
          case 'hand_start':
          case 'deal':
            sfx.play('deal');
            break;
          case 'action':
            if (e.action === 'fold') sfx.play('fold');
            else if (e.action === 'check') sfx.play('check');
            else if (e.action === 'allin') sfx.play('allin');
            else if (e.action === 'raise') sfx.play('raise');
            else sfx.play('bet');          // call / 其他下注类
            break;
          case 'hand_end':
            sfx.play((e.winners || []).indexOf(this.mySeat) >= 0 ? 'win' : 'end');
            break;
          // turn 事件不在此处理：统一走下方 isMyTurn 边沿（镜像端也有）
        }
      }
      // 轮到我行动：false→true 边沿播提示音（含镜像端；只在游戏中且无结算时）
      const myTurn = !!this.data.isMyTurn;
      if (myTurn && !this.sfxWasMyTurn && !(game && game.result)) sfx.play('turn');
      this.sfxWasMyTurn = myTurn;
    } else {
      this.sfxSeq = events.length;         // 静音模式也要推进序号，开声音后不补播
      this.sfxWasMyTurn = !!this.data.isMyTurn;
    }
  },

  /** 发送一条聊天 / 表情（seat === mySeat = 我主动发，不响提示音） */
  pushChat(seat, name, text) {
    const log = this.data.chatLog.slice();
    log.push({ id: ++this.chatSeq, seat: seat, name: name, text: text });
    while (log.length > 8) log.shift();
    this.setData({ chatLog: log });
    // 收到他人/AI 消息时轻提示；我自己发的（快捷聊天/表情、我的站起/入局系统消息）不响
    if (this.data.soundOn && seat !== this.mySeat) sfx.play('chat');
  },

  onQuickChat(e) {
    this.pushChat(this.mySeat, this.meLabel(false), e.currentTarget.dataset.t);
    this.feedback();
  },

  onEmoji(e) {
    this.pushChat(this.mySeat, this.meLabel(false), e.currentTarget.dataset.e);
    this.feedback();
  },

  // ---------- 折叠面板（聊天 / 菜单）----------
  // 微扑克式：社区与次要操作默认折叠，主视觉只留牌桌 + 我的操作区
  toggleChat() {
    this.setData({ chatOpen: !this.data.chatOpen, menuOpen: false });
  },

  toggleMenu() {
    this.setData({ menuOpen: !this.data.menuOpen, chatOpen: false });
  },

  closePanels() {
    if (this.data.chatOpen || this.data.menuOpen) this.setData({ chatOpen: false, menuOpen: false });
  },

  onMenuHelp() {
    this.setData({ menuOpen: false, helpShow: true });
  },

  onMenuStand() {
    this.setData({ menuOpen: false });
    this.standUp();
  },

  onMenuSit() {
    this.setData({ menuOpen: false });
    this.sitDown();
  },

  onMenuBack() {
    this.setData({ menuOpen: false });
    this.onBack();
  },

  /** 新手引导：规则/下注轮次说明 */
  onHelp() {
    this.setData({ helpShow: true });
  },

  onHelpClose() {
    this.setData({ helpShow: false });
  },

  onCoachClose() {
    this.setData({ coachShow: false });
  },

  buildResult(res) {
    // 结算行覆盖「所有投入过筹码的人」：含弃牌者（他们输掉的盲注/下注也要显示），
    // 每人给出净盈亏 net = 赢得 - 投入，输赢一目了然。
    const rows = game.players
      .filter(p => p.committed > 0 || res.winners.indexOf(p.seat) !== -1)
      .map(p => {
        const rv = game.showdownReveal[p.seat];
        const win = res.winners.indexOf(p.seat) !== -1;
        const gain = res.awards.filter(a => a.seat === p.seat).reduce((s, a) => s + a.amount, 0);
        const net = gain - p.committed;
        const holeTxt = rv
          ? rv.hole.map(code => this.codeToStr(code)).join(' ')
          : p.hole.map(c => P.cardToStr(c)).join(' ');
        // 摊牌结算弹窗里的「手牌牌面」：只亮真正摊牌（rv 存在）的座位，
        // 弃牌者的牌不公开（muck 不亮牌，扑克通行礼仪），此时 cards 为空数组、
        // 由 .sr-cards 的固定宽度占位保持各行「牌型 / 盈亏」两列仍对齐。
        // hi 标记 = 该底牌参与了最佳成手 5 张（摊牌时金边高亮，便于看懂为什么赢）。
        const bestSet = (rv && rv.hand) ? new Set(rv.hand) : null;
        const cards = ((rv && rv.hole) ? rv.hole : [])
          .map((code, ci) => {
            const id = P.codeToCard(code);
            if (id < 0) return null;
            const d = this.cardData(id, ci);
            d.hi = !!(bestSet && bestSet.has(code));
            return d;
          })
          .filter(Boolean);
        return {
          seat: p.seat,
          name: p.name,
          icon: win ? '🏆 ' : '',
          hand: rv ? holeTxt + ' → ' + rv.name : holeTxt,
          cards,                    // 结算弹窗的迷你手牌（弃牌为空）
          // 结算条胶囊用的短文本：摊牌显示牌型名；弃牌/未摊牌给状态文案
          short: rv ? rv.name : (p.folded ? '弃牌' : (holeTxt || '未摊牌')),
          committed: p.committed,   // 本手总投入（飞筹动画的筹码量）
          isMe: p.seat === this.mySeat,   // 结算弹窗高亮我的行
          win,
          gain,
          net                       // 净盈亏：正 = 赢，负 = 输
        };
      });

    // 我的座位可能因云端行滞后/他端换座而不在引擎里（seatOf 取不到），
    // 结算不能因此崩掉——缺失时按 0 投入兜底，战绩底牌留空。
    const me = game.seatOf(this.mySeat);
    const myGain = res.awards.filter(a => a.seat === this.mySeat).reduce((s, a) => s + a.amount, 0);
    const myLost = me ? Math.max(0, (me.committed || 0) - myGain) : 0;
    const won = res.winners.indexOf(this.mySeat) !== -1;

    // 准备上云的战绩记录
    this.pendingRecord = {
      tableId: this.roomNo || 'ai',
      handNo: game.handNo,
      seat: this.mySeat,
      hole: me ? me.hole.map(c => P.cardToCode(c)).join(' ') : '',
      board: game.board.map(c => P.cardToCode(c)).join(' '),
      handType: (game.showdownReveal[this.mySeat] && game.showdownReveal[this.mySeat].name) || (won ? '获胜' : '未中牌'),
      net: myGain - myLost,
      won
    };

    return {
      title: res.type === 'showdown' ? '摊牌结算' : '牌局结束',
      rows,
      netText: won ? '你赢得 ' + myGain + ' 筹码' : '你输掉 ' + myLost + ' 筹码'
    };
  },

  /** 战绩写入云端（失败不打断对局，仅提示） */
  async uploadRecord() {
    if (!this.pendingRecord) return;
    const rec = this.pendingRecord;
    this.pendingRecord = null;
    try {
      await auth.saveRecord(rec);
    } catch (err) {
      console.error('[table] 战绩上传失败', JSON.stringify({
        stage: 'save-record',
        message: err && err.message ? err.message : '未知错误'
      }));
      wx.showToast({ title: '战绩同步失败，不影响本局', icon: 'none' });
    }
  },

  /** 'As' → 'A♠'；'Th' → '10♥' */
  codeToStr(code) {
    // 解析仍按机读码（单字符点数）走，只有输出改用显示文本
    const r = P.RANK_NAMES.indexOf(code[0]);
    const s = P.SUIT_NAMES.indexOf(code[1]);
    return (r < 0 || s < 0) ? code : P.RANK_DISPLAY[r] + P.SUIT_CHARS[s];
  },

  renderAdvice(isMyTurn) {
    // 合规硬约束（README 第 0.3 节）：行动建议 = 实时外挂辅助，
    // 仅允许在「练习模式」（AI 对战/教学）输出；好友房与匹配对战必须关闭。
    // 引擎侧 advise() 同样有 practiceMode 开关双保险（服务器接入后以房间配置为准）。
    if (!isMyTurn || this.mode !== 'ai') {
      this._adviceKey = null;   // 离开我的回合即失效：回到我回合必然是新局势
      this.setData({ advice: {} });
      return;
    }
    // 缓存键（评审 2026-10-15 MEDIUM「每帧 1800 次蒙特卡洛」）：轮到我期间 render
    // 会被各种事件反复触发（AI 动作回调/setData 回流/前后台切换），而 my 牌面、
    // 公共牌、下注局势一个都不会变——1800 次蒙特卡洛每帧重算纯属白烧 CPU（低端
    // 机可感掉帧）。局势完全一致时直接复用上一次结果，两个附带收益：
    // 胜率数字不再在两次 render 间因 RNG 抖动；iters 也不虚标。
    const me = game.seatOf(this.mySeat);
    const key = [
      game.handNo, game.street, game.currentBet, game.potTotal(),
      game.activePlayers().length,
      me ? me.hole.join(',') : '', game.board.join(',')
    ].join('|');
    if (this._adviceKey === key) {
      // 同局势复用；万一 advice 被别处清掉（如降级渲染），用缓存补写回来
      const c = this._adviceResult;
      if (c && (!this.data.advice || !this.data.advice.text)) this.setData({ advice: c });
      return;
    }
    this._adviceKey = key;
    const a = P.advise(game, this.mySeat, { practiceMode: true });
    this._adviceResult = a ? {
      equityPct: a.equityPct,
      potOdds: a.potOdds,
      text: a.text,
      tone: a.tone,
      drawDesc: a.draws.outs > 0 ? a.draws.desc : '',
      drawOuts: a.draws.outs
    } : null;
    if (!a) { this.setData({ advice: {} }); return; }
    this.setData({ advice: this._adviceResult });
  },

  // ---------- 我的操作 ----------
  onPresetTap(e) {
    const legal = this.data.legal;
    if (!legal) return;
    const v = e.currentTarget.dataset.v;
    // 「自定义」档：展开自定义下注面板（与预设档互斥）
    if (v === 'custom') { this.onCustomTap(); return; }
    // 选预设档时收起自定义面板
    this.setData({ raiseCustom: false });
    const curBet = game.currentBet;
    const pot = game.potTotal();
    let target;
    if (v === 'min') target = legal.minRaiseTo;
    else if (v === 'half') target = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, curBet * 2 + pot * 0.5));
    else if (v === 'pot') target = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, curBet * 2 + pot));
    else target = legal.maxRaiseTo;

    this.setRaiseTo(target, v);
  },

  // 展开/收起自定义下注面板
  /**
   * 统一设置下注金额：连同按钮文案派生的 raiseSubmit / raiseAllIn 一起写入。
   *
   * ⚠️ 必须走这个方法，不能直接 setData({raiseTo})：
   * 加注按钮读的是 raiseSubmit / raiseAllIn（不是 raiseTo），而这两个字段
   * 若只在 render() 里算，滑杆/输入框改动就不触发 render，按钮文案会一直
   * 停在上一帧的旧值（曾出现：滑杆拉到 346，按钮仍显示「加注 20」）。
   * 口径与 onRaise 的提交钳制严格一致：低于最小按最小，达上限算全下。
   */
  setRaiseTo(amt, preset) {
    const l = this.data.legal || {};
    const min = Number(l.minRaiseTo) || 0;
    const max = Number(l.maxRaiseTo) || 0;
    const v = Math.round(Number(amt) || 0);
    const submit = min ? Math.max(min, v) : v;
    const patch = { raiseTo: v, raiseSubmit: submit, raiseAllIn: !!(max && submit >= max) };
    if (preset !== undefined) patch.raisePreset = preset;
    this.setData(patch);
    return patch;
  },

  onCustomTap() {
    const legal = this.data.legal;
    if (!legal || !legal.canRaise) return;
    const open = !this.data.raiseCustom;
    // 展开时若当前金额低于最小下注，自动对齐到最小（避免直接全下 0 这种非法值）
    const raiseTo = open && this.data.raiseTo < legal.minRaiseTo ? legal.minRaiseTo : this.data.raiseTo;
    // ⚠️ 必须显式写 raiseCustom：setRaiseTo 只负责金额三件套（raiseTo/Submit/AllIn），
    // 不碰展开态。漏写这里会导致点「自定义」面板永远不弹出（曾表现为点击无反应）。
    this.setData({ raiseCustom: open });
    this.setRaiseTo(raiseTo, open ? 'custom' : this.data.raisePreset);
  },

  // 滑杆拖动：0 ~ MAX 任意值（MAX = 全下）
  onRaiseSlider(e) {
    this.setRaiseTo(e.detail.value, 'custom');
  },

  // 数字输入：只做清洗与上限。不在输入过程中抬到下限 —— 否则想输「500」时
  // 刚打完第一个「5」就会被改写成最小加注，后面根本没法接着输。
  // 上下限直接读 legal（唯一真源），不依赖 render 派生的 raiseMin/raiseMax 快照。
  onRaiseInput(e) {
    const l = this.data.legal || {};
    const max = l.maxRaiseTo || this.data.raiseMax || 0;
    let v = parseInt(e.detail.value, 10);
    if (isNaN(v) || v < 0) v = 0;
    if (max && v > max) v = max;
    this.setRaiseTo(v, 'custom');
  },

  // 失焦：把低于最小加注的值补到下限，保证界面上显示的数字始终合法
  onRaiseBlur() {
    const l = this.data.legal || {};
    const min = l.minRaiseTo || this.data.raiseMin || 0;
    if (min && this.data.raiseTo < min) this.setRaiseTo(min, 'custom');
  },

  // 收起自定义面板 → 恢复档位条（两者互斥，收起即回到「最小/½池/底池/全下」）
  onCustomClose() {
    this.setData({ raiseCustom: false });
  },

  onCustomMin() { const l = this.data.legal; if (l) this.setRaiseTo(l.minRaiseTo, 'custom'); },
  onCustomHalf() {
    const l = this.data.legal; if (!l) return;
    const target = Math.min(l.maxRaiseTo, Math.max(l.minRaiseTo, game.currentBet * 2 + game.potTotal() * 0.5));
    this.setRaiseTo(target, 'custom');
  },
  onCustomPot() {
    const l = this.data.legal; if (!l) return;
    const target = Math.min(l.maxRaiseTo, Math.max(l.minRaiseTo, game.currentBet * 2 + game.potTotal()));
    this.setRaiseTo(target, 'custom');
  },
  onCustomMax() { const l = this.data.legal; if (l) this.setRaiseTo(l.maxRaiseTo, 'custom'); },

  onFold() {
    if (!this.data.isMyTurn) return;
    // 弃牌二次确认（防误触）：首次点击进入确认态，2.2s 内再点才真正弃牌
    if (!this.data.foldConfirm) {
      this.setData({ foldConfirm: true });
      if (foldTimer) clearTimeout(foldTimer);
      foldTimer = setTimeout(() => { foldTimer = null; this.setData({ foldConfirm: false }); }, 2200);
      return;
    }
    if (foldTimer) { clearTimeout(foldTimer); foldTimer = null; }
    this.setData({ foldConfirm: false });
    this.doAct('fold', 0, '弃牌', 'act-f');
  },

  clearFoldTimer() {
    if (foldTimer) { clearTimeout(foldTimer); foldTimer = null; }
  },

  onCheckOrCall() {
    const legal = this.data.legal;
    if (!legal) return;
    if (legal.toCall > 0) this.doAct('call', 0, '跟注', 'act-c');
    else this.doAct('check', 0, '过牌', 'act-c');
  },

  onRaise() {
    const legal = this.data.legal;
    if (!legal || !legal.canRaise) return;
    // 提交前把金额钳到合法区间 [minRaiseTo, maxRaiseTo]。
    // 滑杆本身 min=raiseMin 不会拖出非法值，但数字输入框能（清空后键入 0），
    // 且 bindblur 的补正只在失焦时发生——点「加注」按钮可能先走这里，故必须兜底。
    const amt = Math.max(legal.minRaiseTo, Math.round(this.data.raiseTo || 0));
    if (amt >= legal.maxRaiseTo) {
      this.doAct('allin', 0, '全下', 'act-a');
    } else {
      this.doAct('raise', amt, '加注 ' + amt, 'act-r');
    }
  },

  doAct(action, amount, text, cls) {
    if (this.data.timeUp) return;   // 本局已结束（时长到点），不再接受行动
    if (game.actionSeat !== this.mySeat || game.result) return;
    // 任何行动都先解除弃牌确认态（防确认态残留到下一回合）
    if (this.data.foldConfirm) { this.setData({ foldConfirm: false }); this.clearFoldTimer(); }
    const res = game.act(this.mySeat, action, amount);
    if (!res.ok) {
      wx.showToast({ title: res.error, icon: 'none' });
      return;
    }
    myActText = text;
    myActCls = cls;
    this.feedback();                       // 震动反馈
    if (this.data.coachShow) this.setData({ coachShow: false });   // 已上手，收起教练提示
    if (this.remoteMode) {
      // 镜像端：本地乐观执行做即时反馈，动作上行给房主（下一帧广播回来校正）
      roomSync.pushAction(this.roomNo, {
        type: 'act', seat: this.roomSeat, action: action, amount: amount || 0
      }).catch(() => wx.showToast({ title: '动作发送失败', icon: 'none' }));
      this.render();
      return;
    }
    this.afterAct();
  },

  onNextHand() {
    if (this.data.timeUp) { this.setData({ summary: this.data.summary || null }); return; }
    if (this.data.readyPhase) { this.onReadyTap(); return; }   // 就绪阶段：按钮即「准备就绪」
    if (this.remoteMode) { this.onReadyTap(); return; }        // 镜像端：等房主发牌，点了就算准备
    if (game && game.result) {
      // 结算展示阶段点「下一手」：关掉结算弹窗（若开着），直接进入就绪计票
      this.closeResultModal(true);
      return;
    }
    this.uploadRecord();   // 异步上云，不阻塞下一手
    this.startHand();
  },

  // ---------- AI ----------
  afterAct() {
    this.render();
    if (game.result) {
      this.uploadRecord();
      // 亮牌展示 → 结算弹窗的时序由 render 末尾统一调度（本地端与镜像端同路径，
      // 见 scheduleResultModal），这里不再另挂定时器，避免双份调度互相踩。
      return;
    }
    this.advance();
  },

  /** 清除结算展示定时器（跳过 / 发新手牌 / 退出页面时） */
  clearResultTimer() {
    if (this.resultTimer) { clearTimeout(this.resultTimer); this.resultTimer = null; }
  },

  /** 清除结算弹窗自动关闭定时器 */
  clearResultModalTimer() {
    if (this.resultModalTimer) { clearTimeout(this.resultModalTimer); this.resultModalTimer = null; }
  },

  /**
   * 弹出单手结算弹窗（每人净盈亏 + 摊牌手牌）。通常由 render 末尾的统一调度
   * 在亮牌展示 RESULT_SHOW_MS 后自动触发，也可由用户点「查看结算」提前打开
   * （摘要条 / 就绪条都有入口）。打开后 RESULT_MODAL_MS 自动关闭；
   * 若关闭时尚未进就绪阶段（亮牌展示期内点开），顺带进入就绪；
   * 已在就绪阶段则只关弹窗——enterReadyPhase 会清空就绪计票，绝不能误调。
   */
  showResultModal() {
    this.clearResultTimer();
    if (!this.data.result || this.data.timeUp) return;
    if (this.data.resultModal) return;
    this.setData({ resultModal: this.data.result });
    this.clearResultModalTimer();
    this.resultModalTimer = setTimeout(() => {
      this.resultModalTimer = null;
      this.closeResultModal(true);
    }, RESULT_MODAL_MS);
  },

  /**
   * 关闭结算弹窗。proceed=true 且尚未进就绪阶段时，顺带进入就绪（跳过剩余展示）；
   * 已在就绪阶段只关弹窗。镜像端只关弹窗——就绪阶段由房主广播驱动。
   */
  closeResultModal(proceed) {
    this.clearResultTimer();
    this.clearResultModalTimer();
    if (this.data.resultModal) this.setData({ resultModal: null });
    if (proceed && !this.remoteMode && !this.data.readyPhase) this.enterReadyPhase();
  },

  /** 「查看结算」入口（结算摘要条 / 就绪条上的按钮）：手动打开结算弹窗 */
  onShowResult() {
    this.showResultModal();
  },

  /** 结算弹窗按钮：亮牌展示期内 = 下一手（进就绪计票）；就绪期/镜像端 = 知道了（仅关闭） */
  onResultNext() {
    this.closeResultModal(!this.remoteMode);
  },

  // ---------- 就绪阶段：所有人准备就绪后才发下一手 ----------

  /** 某座位是否已站起（站起者退出本局，但仍在房间内） */
  isStanding(seat) {
    if (seat === this.mySeat) return !!this.myStanding;
    return !!this.standingMap[seat];
  },

  /** 引擎引用（测试注入用：跨端引擎行为断言，业务代码不要调用） */
  requireGame() {
    return game;
  },

  /** 某座位是否算「在座」：我已坐下但待下一手入局时，同样算在座并需点就绪 */
  seatedOf(seat) {
    if (seat === this.mySeat) return this.pendingSit || !this.myStanding;
    return !this.standingMap[seat];
  },

  /**
   * 进入就绪阶段：列出所有在座的人，等齐「准备就绪」才发下一手。
   * 电脑玩家模拟真人点击（1.5~4s 内自动就绪）。
   */
  enterReadyPhase() {
    if (!game || this.data.timeUp) return;   // 时长已到或牌局已结束，不再开下一手
    if (this.remoteMode) return;             // 镜像端的就绪状态以房主广播为准
    this.clearReadyClock();

    const list = game.players.map(p => ({
      seat: p.seat,
      name: p.name,
      isMe: !!p.isHuman,
      isBot: !p.isHuman,
      ready: false
    })).filter(x => this.seatedOf(x.seat));

    this.readyMap = {};
    list.forEach(x => { this.readyMap[x.seat] = false; });

    // 跨设备：好友可能已经点了准备（ready_hand = 下一手），直接合入计票
    if (this.syncLive) {
      const ready = roomSync.readySeats(this.roomRows, game.handNo + 1, Date.now());
      list.forEach(x => { if (ready[x.seat]) this.readyMap[x.seat] = true; });
    }

    this.setData({ readyPhase: true, readyList: list, myReady: false, readyHint: '' });
    this.renderReady();
    this.startReadyClock();
    this.render();   // 同步底部状态行（等待准备就绪 / 已坐下待入局）
    this.publishPlay();

    list.forEach(x => {
      if (!x.isBot) return;
      const delay = 1500 + Math.random() * 2500;
      this.botReadyTimers.push(setTimeout(() => this.markReady(x.seat, true), delay));
    });
  },

  /** 标记某人已准备 / 未准备，并在齐人后立即发下一手 */
  markReady(seat, v) {
    if (!this.data.readyPhase) return;
    this.readyMap[seat] = !!v;
    if (seat === this.mySeat) this.feedback();
    this.renderReady();
    this.checkAllReady();
  },

  /** 渲染就绪列表与提示文案 */
  renderReady() {
    const list = (this.data.readyList || []).map(x => {
      return { seat: x.seat, name: x.name, isMe: x.isMe, isBot: x.isBot, ready: !!this.readyMap[x.seat] };
    });
    const ok = list.filter(x => x.ready).length;
    const me = list.filter(x => x.isMe)[0];
    let hint;
    if (ok >= list.length) {
      hint = list.length >= 2 ? '全部就绪，即将发下一手…' : '至少需要 2 人入局，等待玩家坐下…';
    } else {
      hint = '已就绪 ' + ok + '/' + list.length + ' · 超时未准备将自动站起';
    }
    this.setData({ readyList: list, myReady: me ? !!me.ready : false, readyHint: hint });
  },

  /** 所有在座的人都已就绪（且不少于 2 人）→ 发下一手 */
  checkAllReady() {
    const list = this.data.readyList || [];
    if (!list.length) return;
    if (!list.every(x => !!this.readyMap[x.seat])) return;
    if (list.length < 2) return;   // 不足 2 人不开牌，等有人坐下后重新计票
    this.finishReadyPhase();
  },

  finishReadyPhase() {
    this.clearReadyClock();
    this.setData({ readyPhase: false, readyLeft: 0, readyHint: '', myReady: false });
    this.uploadRecord();
    this.startHand();
  },

  startReadyClock() {
    this.clearReadyClock();
    let left = READY_TIMEOUT_SEC;
    this.setData({ readyLeft: left });
    readyTimer = setInterval(() => {
      left--;
      this.setData({ readyLeft: left > 0 ? left : 0 });
      if (left <= 0) {
        this.clearReadyClock();
        this.autoStandUnready();
      }
    }, 1000);
  },

  clearReadyClock() {
    if (readyTimer) { clearInterval(readyTimer); readyTimer = null; }
    (this.botReadyTimers || []).forEach(t => clearTimeout(t));
    this.botReadyTimers = [];
  },

  /**
   * 就绪超时：未点「准备就绪」的人自动站起（退出本局，仍保留在房间内）。
   * 站起后重新计票：仍在座且都已就绪的人够 2 人就直接发下一手。
   */
  autoStandUnready() {
    const list = this.data.readyList || [];
    const unready = list.filter(x => !this.readyMap[x.seat]);
    if (!unready.length) return;

    unready.forEach(x => {
      if (x.seat === this.mySeat) {
        this.myStanding = true;
        this.pendingSit = false;
        this.pushChat(this.mySeat, this.meLabel(false), '超时未准备，已自动站起');
        wx.showToast({ title: '超时未准备，已自动站起', icon: 'none' });
        if (this.data.soundOn) sfx.play('timeout');   // 被动站起提示（区别于主动站起）
      } else {
        this.standingMap[x.seat] = true;
        this.pushChat(x.seat, x.name, '超时未准备，已自动站起');
      }
    });

    const seated = list.filter(x => this.seatedOf(x.seat));
    this.setData({ readyList: seated });

    if (seated.length >= 2 && seated.every(x => !!this.readyMap[x.seat])) {
      this.finishReadyPhase();
      return;
    }
    this.renderReady();
    if (seated.length < 2) {
      this.setData({ readyHint: '人数不足 2 人 · 菜单「坐下加入游戏」可重新入局' });
    }
    this.render();
  },

  /** 我点「准备就绪」（未坐下时先提示坐下） */
  onReadyTap() {
    if (!this.data.readyPhase) return;
    if (this.data.soundOn) sfx.play('click');
    if (this.remoteMode) {
      // 镜像端：写自己行的 ready_hand（下一手手数），房主轮询合入计票
      if (!game) return;
      const nextHand = game.handNo + 1;
      // 就绪标记上行失败必须提示：房主收不到就绪 → 永远不发下一手，好友只会干等
      roomSync.markReadyRow(this.roomNo, nextHand)
        .catch(() => this.syncFailToast('准备未同步成功，请重试'));
      const list = (this.data.readyList || []).map(x =>
        Number(x.seat) === Number(this.roomSeat) ? Object.assign({}, x, { ready: true }) : x);
      this.setData({ myReady: true, readyList: list });
      return;
    }
    if (!this.seatedOf(this.mySeat)) {
      wx.showToast({ title: '你已站起，请先坐下', icon: 'none' });
      return;
    }
    this.markReady(this.mySeat, true);
  },

  scheduleAI() {
    const seat = game.actionSeat;
    const p = game.seatOf(seat);
    if (!p) return;

    aiTimer = setTimeout(() => {
      aiTimer = null;   // 先释放槽位：本帧若失败，看门狗可重新调度
      try {
        if (game.result || game.actionSeat !== seat) return;
        const legal = game.legalActions(seat);
        if (!legal) return;

        const seats = game.inHandPlayers().map(x => x.seat);
        const pf = (seats.indexOf(seat) - seats.indexOf(game.dealerSeat) + seats.length) % seats.length;
        const d = P.aiDecide({
          hole: p.hole,
          board: game.board,
          pot: game.potTotal(),
          toCall: legal.toCall,
          stack: p.stack,
          currentBet: game.currentBet,
          numActive: game.activePlayers().length,
          positionFactor: pf <= 1 ? 0.9 : (pf <= 3 ? 0.4 : 0),
          style: p.style,
          minRaiseTo: legal.minRaiseTo,
          maxRaiseTo: legal.maxRaiseTo,
          // 加注权 & 大盲一并交给 AI：退化路径的估算区间不精确，
          // 传全后 aiDecide 的夹取永远落在引擎合法区间内
          canRaise: legal.canRaise,
          bb: game.bb,
          rng: P.createRng('mp-' + game.handNo + '-' + seat + '-' + (aiStep++))
        });

        const res = game.act(seat, d.action, d.amount);
        if (!res.ok) {
          // 非法动作：记日志后放弃本帧；定时器槽已释放，看门狗会用新随机数重试
          console.error('[table] AI 动作被引擎拒绝', JSON.stringify({
            stage: 'ai-act', seat, action: d.action, amount: d.amount, error: res.error
          }));
          this.render();
          return;
        }

        // 把 AI 的动作写回座位数据用于气泡展示。
        // 注意：seats 只含对手，下标 ≠ 座位号，必须按 seat 查出实际下标。
        const idx = game.players.filter(p => p.seat !== this.mySeat).findIndex(p => p.seat === seat);
        if (idx < 0) { this.afterAct(); return; }
        this.setData({
          ['seats[' + idx + '].actText']: this.actLabel(d),
          ['seats[' + idx + '].actCls']: this.actClsOf(d.action)
        }, () => this.afterAct());

        // AI 偶尔在聊天区冒泡（不再用 toast 打断牌局）
        if (d.reason && Math.random() < 0.35) {
          this.pushChat(seat, p.name, this.pickTalk(d));
        }
      } catch (e) {
        console.error('[table] AI 行动异常，等待看门狗重试', JSON.stringify({
          stage: 'ai-schedule', seat, message: e && e.message, stack: e && e.stack
        }));
      }
    }, 620 + Math.random() * 520);
  },

  actLabel(d) {
    if (d.action === 'fold') return '弃牌';
    if (d.action === 'check') return '过牌';
    if (d.action === 'call') return '跟注';
    if (d.action === 'allin') return '全下';
    return '加注 ' + d.amount;
  },

  actClsOf(action) {
    if (action === 'fold') return 'act-f';
    if (action === 'raise') return 'act-r';
    if (action === 'allin') return 'act-a';
    return '';
  },

  pickTalk(d) {
    if (d.action === 'fold') return QUICK_TALK[Math.floor(Math.random() * 2)];
    if (d.action === 'allin') return '好牌！';
    if (d.action === 'raise') return '打得不错';
    return QUICK_TALK[Math.floor(Math.random() * QUICK_TALK.length)];
  },

  // ---------- 计时器 ----------
  /**
   * 行动计时环（20s）。tick 是「本回合残值」的全局单值（TICK_MAX 起倒数）：
   *   - 轮到我 → 残值写到 myTimer/myTimerPct（myzone 专属字段，每秒 setData）；
   *   - 轮到对手 → 残值只进整帧 render 的 seats[].timer；本回调**不**写对手
   *     字段——曾经每秒把我的残值 setData 给对手计时环（评审 2026-10-15
   *     MEDIUM），导致「对手环用我的剩余秒数跳」；对手环等下一帧 render 刷新，
   *     牺牲的流畅度换正确性（对手到点由房主 30s 代弃兜底，不依赖本地环）。
   */
  startTimer() {
    if (timer) clearInterval(timer);
    tick = TICK_MAX;
    this.sfxWarnedTick = 0;   // 倒计时警告已播到的 tick 值（0=未播），防每秒重复
    timer = setInterval(() => {
      tick--;
      if (game.actionSeat === this.mySeat) {
        // 我已移出 seats 数组（渲染在底部 myzone），计时写到我的专属字段
        this.setData({
          myTimer: tick,
          myTimerPct: Math.max(0, Math.round(tick / TICK_MAX * 100))
        });
        // 行动倒计时警告：剩余 5s/3s 各滴答一声，避免误超时代弃
        if ((tick === 5 || tick === 3) && this.sfxWarnedTick !== tick) {
          this.sfxWarnedTick = tick;
          if (this.data.soundOn) sfx.play('warn');
        }
      }
      if (tick <= 0) {
        clearInterval(timer);
        const legal = game.legalActions(this.mySeat);
        if (legal && game.actionSeat === this.mySeat && !game.result) {
          if (this.data.soundOn) sfx.play('timeout');   // 被动代弃提示
          if (legal.toCall > 0) this.doAct('call', 0, '跟注', 'act-c');
          else this.doAct('check', 0, '过牌', 'act-c');
        }
      }
    }, 1000);
  }
});
