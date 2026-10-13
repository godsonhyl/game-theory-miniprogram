/**
 * 牌桌页逻辑
 *
 * 架构说明（重要）：
 *   当前为「单机演示」——引擎直接跑在小程序内。
 *   正式接入服务端后，引擎应运行在服务端，
 *   本页只负责渲染 game.snapshot() 下发的状态 + 发送用户动作。
 *   所有合法性判断以服务端返回为准，本地引擎仅用于即时 UI 反馈。
 */
const P = require('../../core/poker-core.js');
const app = getApp();
const { auth } = require('../../utils/auth');
const { settings } = require('../../utils/settings');

const MY_SEAT = 0;

/** 单次行动倒计时（秒）：计时环按此值计算进度 */
const TICK_MAX = 20;

/**
 * 对手座位坐标（微扑克式分区：上半区只放对手，下半区留给我的手牌与操作）。
 * 我（seat 0）不再出现在椭圆上——我的信息统一渲染在底部 myzone，
 * 因此椭圆底部中央天然留空，9 人时也不会挤压。
 * 键 = 对手人数（= 总人数 - 1），每组左右镜像对称。
 */
const OPP_LAYOUT = {
  1: [{ x: 50, y: 12 }],
  2: [{ x: 28, y: 16 }, { x: 72, y: 16 }],
  3: [{ x: 16, y: 30 }, { x: 50, y: 9 }, { x: 84, y: 30 }],
  4: [{ x: 14, y: 30 }, { x: 34, y: 9 }, { x: 66, y: 9 }, { x: 86, y: 30 }],
  5: [{ x: 11, y: 36 }, { x: 24, y: 12 }, { x: 50, y: 6 }, { x: 76, y: 12 }, { x: 89, y: 36 }],
  6: [{ x: 9, y: 40 }, { x: 16, y: 18 }, { x: 36, y: 7 }, { x: 64, y: 7 }, { x: 84, y: 18 }, { x: 91, y: 40 }],
  7: [{ x: 8, y: 46 }, { x: 14, y: 22 }, { x: 34, y: 8 }, { x: 50, y: 6 }, { x: 66, y: 8 }, { x: 86, y: 22 }, { x: 92, y: 46 }],
  8: [{ x: 20, y: 74 }, { x: 6, y: 48 }, { x: 12, y: 24 }, { x: 32, y: 8 },
      { x: 68, y: 8 }, { x: 88, y: 24 }, { x: 94, y: 48 }, { x: 80, y: 74 }]
};

/**
 * 取对手座位坐标（渲染用）。
 * 横屏毡布是「宽扁椭圆」，直接把椭圆 y 当百分比会让上下两端座位溢出被裁，
 * 因此把 y 线性压缩到安全区 [19, 62]（毡布高度的百分比）。
 */
function oppPos(i, n) {
  const layout = OPP_LAYOUT[n] || OPP_LAYOUT[8];
  const p = layout[i] || layout[layout.length - 1] || { x: 50, y: 20 };
  return { x: p.x, y: 19 + p.y * 0.58 };
}

const NAMES = ['你', '林小满', '陈默', '苏晴', '赵岩', '周叙'];
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
    currentPlayerName: '',
    advice: {},
    result: null,

    // 等待室（好友房）：创建房间后为空房间，好友坐下、房主点开始才发牌
    phase: 'playing',     // 'waiting'（空房间）| 'playing'（牌桌）
    waitSeats: [],        // 6 个座位占用情况
    canStart: false,      // 至少 2 人坐下才可开始
    ownerSeat: 0,         // 房主固定坐 0 号位
    isOwner: true,        // 是否房主（访客从分享卡片进入时只有观看/等待权限）
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
    myActText: '',
    myActCls: '',

    // 加注档位（主流 App 的 bet sizing chips，替代占位很大的滑杆）
    raisePresets: [
      { k: 'min', t: '最小' },
      { k: 'half', t: '½池' },
      { k: 'pot', t: '底池' },
      { k: 'allin', t: '全下' }
    ],

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
    // 房间参数：限定人数与游戏时长（创建房间时设定）
    this.maxSeats = Math.min(9, Math.max(2, Number(opts.max) || 6));
    this.durationMin = Math.max(0, Number(opts.dur) || 0);
    this.startStacks = {};     // 座位 → 起始筹码（结算盈亏用）
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
    if (this.mode === 'friend' && wx.showShareMenu) {
      wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] });
    }
    if (this.mode === 'friend') {
      // 好友房：若本地留有本房间的牌局快照（中途退出过），直接续局；否则进入等待室
      if (!this.restoreRoom()) this.initWaiting();
    } else {
      this.initGame();      // AI 对战：直接进入牌桌
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
  },

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
   * 进入等待室：房主坐 0 号位；访客（从分享卡片进入）自动落座 1 号位并等待房主开始。
   * 注意：访客落座仅本地可见——真实跨设备同步需要服务端房间状态（当前为本地引擎模拟）。
   */
  initWaiting() {
    const owner = this.data.ownerSeat;
    const guestSeat = 1;
    const seats = [];
    // 按房间设定的限定人数生成座位（2 / 4 / 6）
    for (let i = 0; i < this.maxSeats; i++) {
      const isOwnerSeat = i === owner;
      const isGuestSeat = !this.isOwner && i === guestSeat;
      seats.push({
        seat: i,
        occupied: isOwnerSeat || isGuestSeat,
        isOwner: isOwnerSeat,
        isMe: isOwnerSeat ? this.isOwner : isGuestSeat,
        isBot: false,
        name: isOwnerSeat ? (this.isOwner ? '你（房主）' : '房主') : (isGuestSeat ? '你' : '')
      });
    }
    const occupiedCount = seats.filter(s => s.occupied).length;
    this.setData({
      phase: 'waiting',
      waitSeats: seats,
      canStart: this.isOwner && occupiedCount >= 2
    });
    if (this.isOwner) this.armExpire();   // 仅房主侧计时：30 分钟无人加入自动销毁
  },

  // ---------- 牌局快照：中途退出后可重新进入续局 ----------

  /** 存快照：座位、剩余筹码、第几手、上一手庄位 */
  saveSnapshot() {
    if (this.mode !== 'friend' || !this.roomNo || this.data.phase !== 'playing' || !game) return;
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
      name: s.name,
      seat: s.seat,
      stack: s.stack > 0 ? s.stack : 1000,
      isHuman: !!s.isMe,
      style: s.style || { aggro: 0.5, tight: 0.35 }
    }));
    this.setData({ phase: 'playing' });
    this.initGame(players, snap);
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
    empty.name = '好友' + botNo;
    const occupiedCount = seats.filter(s => s.occupied).length;
    this.setData({ waitSeats: seats, canStart: occupiedCount >= 2 });
    // 第一位好友坐下 → 房间「有人进去了」，取消自动销毁
    if (occupiedCount >= 2) this.clearExpire();
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
    seats.forEach(s => { if (s.isBot) s.name = '好友' + (++n); });
    const occupiedCount = seats.filter(s => s.occupied).length;
    this.setData({ waitSeats: seats, canStart: occupiedCount >= 2 });
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
    }
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/index/index' })
    });
  },

  /** 房主点开始：按已坐下座位构建玩家并发牌（访客无权限，只能等待） */
  startGame() {
    if (this.data.phase !== 'waiting') return;
    if (!this.isOwner) {
      wx.showToast({ title: '等待房主开始', icon: 'none' });
      return;
    }
    this.clearExpire();   // 已开始对局，停止空闲销毁倒计时
    if (!this.data.canStart) {
      wx.showToast({ title: '至少 2 人才能开始', icon: 'none' });
      return;
    }
    const players = this.data.waitSeats
      .filter(s => s.occupied)
      .map(s => ({
        id: s.isMe ? 'me' : 'bot' + s.seat,
        name: s.name,
        seat: s.seat,
        stack: 1000,
        isHuman: s.isMe,
        style: { aggro: 0.3 + Math.random() * 0.5, tight: 0.25 + Math.random() * 0.45 }
      }));

    this.setData({ phase: 'playing' });
    this.initGame(players);
    this.startClock();   // 开始游戏才启动时长倒计时
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
    this.setData({ timeUp: false, remainSec: left, remainText: this.fmtRemain(left) });
    clock = setInterval(() => {
      left--;
      if (left <= 0) {
        this.clearClock();
        this.endGame();
        return;
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
      net: p.stack - (this.startStacks[p.seat] !== undefined ? this.startStacks[p.seat] : 1000),
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
    const meP = game.seatOf(MY_SEAT);
    if (meP) {
      this.pendingRecord = {
        tableId: this.roomNo || 'ai',
        handNo: game.handNo,
        seat: MY_SEAT,
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
    // 系统返回手势 / 页面被直接销毁时静默存快照，保证下次进入能续局
    this.saveSnapshot();
  },

  initGame(players, snap) {
    const ps = players || NAMES.map((name, i) => ({
      id: 'u' + i,
      name,
      seat: i,
      stack: 1000,
      isHuman: i === MY_SEAT,
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
    this.startHand();
  },

  startHand() {
    // 「坐下加入游戏」下一手才生效：本手发牌前正式落座并入局
    if (this.pendingSit) {
      this.pendingSit = false;
      this.myStanding = false;
    }
    // 新的一手开始，清理上一手的就绪状态
    this.clearReadyClock();
    this.readyMap = {};
    this.setData({
      readyPhase: false, readyList: [], myReady: false, readyLeft: 0, readyHint: ''
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
      return;
    }
    this.prevDealerSeat = prevDealer;
    myActText = '';
    myActCls = '';
    this.render();

    this.advance();
  },

  /**
   * 推进下一个行动者：轮到我时起计时器，否则排 AI。
   * 若我已站起观战，则视为弃牌并直接跳过（站起者不参与本手）。
   */
  advance() {
    if (!game || game.result) return;
    const seat = game.actionSeat;
    // 已站起的人（含超时未准备被自动站起者）不参与本手：轮到即自动弃牌跳过
    if (this.isStanding(seat)) {
      const r = game.act(seat, 'fold');
      if (r.ok) { this.afterAct(); return; }
    }
    if (seat === MY_SEAT) {
      this.startTimer();
      return;
    }
    this.scheduleAI();
  },

  /**
   * 站起：退出当前牌局（不退出房间），不再参与发牌与行动，可随时坐下重新入局。
   * 规则与主流 App 一致：需先弃牌或等本手结束才能离桌，避免中途抽身影响牌局。
   */
  standUp() {
    if (!game || this.myStanding) return;
    const me = game.seatOf(MY_SEAT);
    if (!me) return;
    if (!(me.folded || game.result)) {
      wx.showToast({ title: '本手结束后或弃牌后可站起', icon: 'none' });
      return;
    }
    this.myStanding = true;
    this.pendingSit = false;
    this.pushChat(MY_SEAT, '你', '站起观战');
    wx.showToast({ title: '已退出本局，可坐下重新加入', icon: 'none' });
    if (this.data.readyPhase) {
      // 就绪阶段站起 → 退出计票，其余人齐了就直接发下一手
      const seated = (this.data.readyList || []).filter(x => this.seatedOf(x.seat));
      this.setData({ readyList: seated });
      this.renderReady();
      this.checkAllReady();
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
    this.pushChat(MY_SEAT, '你', '重新入局');
    wx.showToast({ title: '下一手开始发牌入局', icon: 'none' });
    if (this.data.readyPhase) {
      this.enterReadyPhase();   // 就绪阶段坐下 → 重新计票（我也要点「准备就绪」）
      return;
    }
    this.render();
  },

  // ---------- 渲染 ----------
  render() {
    const showdown = game.street === P.STREET.SHOWDOWN;
    const result = game.result;

    // 公共牌
    // 摊牌高亮：以「我的最佳成手 5 张」为依据，把构成牌型的牌标出来
    const myReveal = game.showdownReveal ? game.showdownReveal[MY_SEAT] : null;
    const bestSet = (result && myReveal && myReveal.hand) ? new Set(myReveal.hand) : null;

    const board = this.markBest(game.board.map((card, i) => this.cardData(card, i)), bestSet);
    const placeholders = Math.max(0, 3 - game.board.length);
    const placeholdersArr = [];
    for (let i = 0; i < placeholders; i++) placeholdersArr.push({ phkey: i });

    // 边池
    let sidePots = [];
    if (game.pots && game.pots.length > 1) {
      sidePots = game.pots.slice(1).map(p => p.amount);
    }

    // 站起观战：仍在房间内，但不参与发牌与行动
    const standing = this.myStanding === true;
    // 已坐下但待下一手入局时同样算「在座」（需点就绪），只是本手仍不参与
    const mySeated = this.pendingSit || !standing;
    const me = game.seatOf(MY_SEAT);
    const canStand = !!me && !standing && (!!me.folded || !!result);

    // 座位：只渲染对手（我在底部 myzone），按对手人数取对称布局，9 人也不挤
    const opps = game.players.filter(p => p.seat !== MY_SEAT);
    const seats = opps.map((p, i) => {
      const pos = oppPos(i, opps.length);
      const isWinner = result && result.winners.indexOf(p.seat) !== -1;
      return {
        seat: p.seat,
        name: p.name,
        initial: p.name.slice(0, 1),
        x: pos.x,
        y: pos.y,
        stack: p.stack,
        bet: p.bet,
        allIn: p.allIn,
        folded: p.folded,
        standing: this.isStanding(p.seat),
        active: game.actionSeat === p.seat && !result,
        isDealer: game.dealerSeat === p.seat,
        // 对手底牌平时不展示（德扑常识：对手牌是暗的），仅摊牌时亮出
        showCards: showdown && !p.folded && p.hole.length === 2,
        hole: this.markBest(p.hole.map((card, ci) => this.cardData(card, ci)), bestSet),
        win: !!isWinner,
        timer: game.actionSeat === p.seat ? tick : '',
        timerPct: game.actionSeat === p.seat ? Math.round(tick / TICK_MAX * 100) : 0,
        actText: p.seat === MY_SEAT ? myActText : '',
        actCls: p.seat === MY_SEAT ? myActCls : ''
      };
    });

    // 我的信息（底部 myzone：手牌 + 筹码 + 状态）
    const meP = game.seatOf(MY_SEAT);
    const myCards = this.markBest(
      (meP && !standing) ? meP.hole.map((card, i) => this.cardData(card, i)) : [], bestSet);

    // 操作区（站起观战时不参与行动）
    const isMyTurn = game.actionSeat === MY_SEAT && !result && !standing;
    let legal = null;
    let raiseTo = 0;
    if (isMyTurn) {
      legal = game.legalActions(MY_SEAT);
      if (legal) raiseTo = this.data.raiseTo >= legal.minRaiseTo ? this.data.raiseTo : legal.minRaiseTo;
    }

    const curPlayer = game.actionSeat >= 0 ? game.seatOf(game.actionSeat) : null;

    this.setData({
      handNo: game.handNo,
      streetCn: P.STREET_CN[game.street],
      pot: game.potTotal(),
      sidePots,
      board,
      boardPlaceholders: placeholdersArr,
      seats,
      legal,
      raiseTo,
      isMyTurn,
      myStanding: standing,
      mySeated: mySeated,
      canStand: canStand,
      // 我的区域（底部）
      myCards,
      myStack: meP ? meP.stack : 0,
      myBet: meP ? meP.bet : 0,
      myFolded: meP ? !!meP.folded : false,
      myActive: game.actionSeat === MY_SEAT && !result,
      myTimer: game.actionSeat === MY_SEAT ? tick : '',
      myTimerPct: game.actionSeat === MY_SEAT ? Math.round(tick / TICK_MAX * 100) : 0,
      myActText: myActText,
      myActCls: myActCls,
      currentPlayerName: curPlayer ? curPlayer.name : '',
      result: result ? this.buildResult(result) : null
    });

    this.renderAdvice(isMyTurn);
  },

  /** 牌 ID → 渲染数据（花色配色：四色牌时 ♠黑 / ♣绿 / ♦蓝 / ♥红） */
  cardData(card, idx) {
    const s = P.suitOf(card);
    return {
      idx: idx || 0,                 // 供 wx:key 使用的稳定键
      code: P.cardToCode(card),      // 摊牌时用于判断是否属于最佳成手 5 张
      hi: false,                     // 是否属于最佳 5 张（摊牌高亮）
      rank: P.RANK_NAMES[P.rankOf(card)],
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

  /** 操作反馈：震动 + 音效开关（音效暂以震动表达，避免引入音频资源） */
  feedback() {
    if (this.data.soundOn && wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  },

  /** 发送一条聊天 / 表情 */
  pushChat(seat, name, text) {
    const log = this.data.chatLog.slice();
    log.push({ id: ++this.chatSeq, seat: seat, name: name, text: text });
    while (log.length > 8) log.shift();
    this.setData({ chatLog: log });
  },

  onQuickChat(e) {
    this.pushChat(MY_SEAT, '你', e.currentTarget.dataset.t);
    this.feedback();
  },

  onEmoji(e) {
    this.pushChat(MY_SEAT, '你', e.currentTarget.dataset.e);
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
    const rows = game.activePlayers().map(p => {
      const rv = game.showdownReveal[p.seat];
      const win = res.winners.indexOf(p.seat) !== -1;
      const gain = res.awards.filter(a => a.seat === p.seat).reduce((s, a) => s + a.amount, 0);
      const holeTxt = rv
        ? rv.hole.map(code => this.codeToStr(code)).join(' ')
        : p.hole.map(c => P.cardToStr(c)).join(' ');
      return {
        seat: p.seat,
        name: p.name,
        icon: win ? '🏆 ' : '',
        hand: rv ? holeTxt + ' → ' + rv.name : holeTxt,
        win,
        gain
      };
    });

    const me = game.seatOf(MY_SEAT);
    const myGain = res.awards.filter(a => a.seat === MY_SEAT).reduce((s, a) => s + a.amount, 0);
    const myLost = Math.max(0, me.committed - myGain);
    const won = res.winners.indexOf(MY_SEAT) !== -1;

    // 准备上云的战绩记录
    this.pendingRecord = {
      tableId: this.roomNo || 'ai',
      handNo: game.handNo,
      seat: MY_SEAT,
      hole: me.hole.map(c => P.cardToCode(c)).join(' '),
      board: game.board.map(c => P.cardToCode(c)).join(' '),
      handType: (game.showdownReveal[MY_SEAT] && game.showdownReveal[MY_SEAT].name) || (won ? '获胜' : '未中牌'),
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

  /** 'As' → 'A♠' */
  codeToStr(code) {
    const r = P.RANK_NAMES.indexOf(code[0]);
    const s = P.SUIT_NAMES.indexOf(code[1]);
    return (r < 0 || s < 0) ? code : P.RANK_NAMES[r] + P.SUIT_CHARS[s];
  },

  renderAdvice(isMyTurn) {
    if (!isMyTurn) {
      this.setData({ advice: {} });
      return;
    }
    const a = P.advise(game, MY_SEAT);
    if (!a) { this.setData({ advice: {} }); return; }
    this.setData({
      advice: {
        equityPct: a.equityPct,
        potOdds: a.potOdds,
        text: a.text,
        tone: a.tone,
        drawDesc: a.draws.outs > 0 ? a.draws.desc : '',
        drawOuts: a.draws.outs
      }
    });
  },

  // ---------- 我的操作 ----------
  onPresetTap(e) {
    const legal = this.data.legal;
    if (!legal) return;
    const v = e.currentTarget.dataset.v;
    const curBet = game.currentBet;
    const pot = game.potTotal();
    let target;
    if (v === 'min') target = legal.minRaiseTo;
    else if (v === 'half') target = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, curBet * 2 + pot * 0.5));
    else if (v === 'pot') target = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, curBet * 2 + pot));
    else target = legal.maxRaiseTo;

    this.setData({ raiseTo: Math.round(target), raisePreset: v });
  },

  onRaiseChange(e) {
    this.setData({ raiseTo: e.detail.value, raisePreset: '' });
  },

  onFold() {
    this.doAct('fold', 0, '弃牌', 'act-f');
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
    const me = game.seatOf(MY_SEAT);
    // 拉到最大即视为全下
    if (this.data.raiseTo >= legal.maxRaiseTo) {
      this.doAct('allin', 0, '全下', 'act-a');
    } else {
      this.doAct('raise', this.data.raiseTo, '加注 ' + this.data.raiseTo, 'act-r');
    }
  },

  doAct(action, amount, text, cls) {
    if (this.data.timeUp) return;   // 本局已结束（时长到点），不再接受行动
    if (game.actionSeat !== MY_SEAT || game.result) return;
    const res = game.act(MY_SEAT, action, amount);
    if (!res.ok) {
      wx.showToast({ title: res.error, icon: 'none' });
      return;
    }
    myActText = text;
    myActCls = cls;
    this.feedback();                       // 震动反馈
    if (this.data.coachShow) this.setData({ coachShow: false });   // 已上手，收起教练提示
    this.afterAct();
  },

  onNextHand() {
    if (this.data.timeUp) { this.setData({ summary: this.data.summary || null }); return; }
    if (this.data.readyPhase) { this.onReadyTap(); return; }   // 就绪阶段：按钮即「准备就绪」
    this.uploadRecord();   // 异步上云，不阻塞下一手
    this.startHand();
  },

  // ---------- AI ----------
  afterAct() {
    this.render();
    if (game.result) {
      this.uploadRecord();
      this.enterReadyPhase();   // 上一手结束 → 等所有人「准备就绪」才发下一手
      return;
    }
    this.advance();
  },

  // ---------- 就绪阶段：所有人准备就绪后才发下一手 ----------

  /** 某座位是否已站起（站起者退出本局，但仍在房间内） */
  isStanding(seat) {
    if (seat === MY_SEAT) return !!this.myStanding;
    return !!this.standingMap[seat];
  },

  /** 某座位是否算「在座」：我已坐下但待下一手入局时，同样算在座并需点就绪 */
  seatedOf(seat) {
    if (seat === MY_SEAT) return this.pendingSit || !this.myStanding;
    return !this.standingMap[seat];
  },

  /**
   * 进入就绪阶段：列出所有在座的人，等齐「准备就绪」才发下一手。
   * 电脑玩家模拟真人点击（1.5~4s 内自动就绪）。
   */
  enterReadyPhase() {
    if (!game || this.data.timeUp) return;   // 时长已到或牌局已结束，不再开下一手
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

    this.setData({ readyPhase: true, readyList: list, myReady: false, readyHint: '' });
    this.renderReady();
    this.startReadyClock();
    this.render();   // 同步底部状态行（等待准备就绪 / 已坐下待入局）

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
    if (seat === MY_SEAT) this.feedback();
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
      if (x.seat === MY_SEAT) {
        this.myStanding = true;
        this.pendingSit = false;
        this.pushChat(MY_SEAT, '你', '超时未准备，已自动站起');
        wx.showToast({ title: '超时未准备，已自动站起', icon: 'none' });
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
    if (!this.seatedOf(MY_SEAT)) {
      wx.showToast({ title: '你已站起，请先坐下', icon: 'none' });
      return;
    }
    this.markReady(MY_SEAT, true);
  },

  scheduleAI() {
    const seat = game.actionSeat;
    const p = game.seatOf(seat);
    if (!p) return;

    aiTimer = setTimeout(() => {
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
        rng: P.createRng('mp-' + game.handNo + '-' + seat + '-' + (aiStep++))
      });

      const res = game.act(seat, d.action, d.amount);
      if (!res.ok) { this.render(); return; }

      // 把 AI 的动作写回座位数据用于气泡展示。
      // 注意：seats 只含对手，下标 ≠ 座位号，必须按 seat 查出实际下标。
      const idx = game.players.filter(p => p.seat !== MY_SEAT).findIndex(p => p.seat === seat);
      if (idx < 0) { this.afterAct(); return; }
      this.setData({
        ['seats[' + idx + '].actText']: this.actLabel(d),
        ['seats[' + idx + '].actCls']: this.actClsOf(d.action)
      }, () => this.afterAct());

      // AI 偶尔在聊天区冒泡（不再用 toast 打断牌局）
      if (d.reason && Math.random() < 0.35) {
        this.pushChat(seat, p.name, this.pickTalk(d));
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
  startTimer() {
    if (timer) clearInterval(timer);
    tick = TICK_MAX;
    timer = setInterval(() => {
      tick--;
      if (game.actionSeat === MY_SEAT) {
        // 我已移出 seats 数组（渲染在底部 myzone），计时写到我的专属字段
        this.setData({
          myTimer: tick,
          myTimerPct: Math.max(0, Math.round(tick / TICK_MAX * 100))
        });
      }
      if (tick <= 0) {
        clearInterval(timer);
        const legal = game.legalActions(MY_SEAT);
        if (legal && game.actionSeat === MY_SEAT && !game.result) {
          if (legal.toCall > 0) this.doAct('call', 0, '跟注', 'act-c');
          else this.doAct('check', 0, '过牌', 'act-c');
        }
      }
    }, 1000);
  }
});
