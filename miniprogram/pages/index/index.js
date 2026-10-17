const app = getApp();
const { auth, DEFAULT_NICK } = require('../../utils/auth');
const { settings } = require('../../utils/settings');
const snapshot = require('../../utils/room-snapshot');

/**
 * 创建好友房的可调范围。
 * 人数：2–9 逐人可调（9 是引擎与座位环的实际上限，牌桌侧会再夹一次）。
 * 时长：10 分钟为一档，10–300 分钟；0 表示不限时。
 */
const C_MAX_MIN = 2;
const C_MAX_MAX = 9;
const C_MAX_DEF = 6;
const MAX_PRESETS = [2, 4, 6, 9];
const DUR_STEP = 10;
const DUR_MIN = 10;
const DUR_MAX = 300;
const DUR_DEF = 30;
const DUR_PRESETS = [
  { v: 10, t: '10 分' },
  { v: 30, t: '30 分' },
  { v: 60, t: '1 小时' },
  { v: 120, t: '2 小时' }
];
/**
 * 涨盲间隔（分钟）：每 N 分钟 sb/bb 翻倍，逼迫僵局推进。
 * 0 = 不涨盲（保持现行为）。10 分钟为一档，0/10/15/20/30 可选。
 * 仅好友房生效；AI 对战用不到（AI 不存筹码僵局）。
 */
const BLIND_PRESETS = [
  { v: 0, t: '不涨盲' },
  { v: 10, t: '10 分' },
  { v: 15, t: '15 分' },
  { v: 20, t: '20 分' },
  { v: 30, t: '30 分' }
];
const BLIND_DEF = 0;

Page({
  data: {
    loading: true,
    loginError: '',
    roomsLoading: false,  // 我的房间：加载中
    roomsError: false,    // 我的房间：加载失败（区分「真的没有」与「加载失败」）
    nickname: DEFAULT_NICK,
    initial: '玩',
    nickDefault: true,    // 昵称仍是建档占位值 → 顶部显示引导条
    roomCards: 0,
    rankEnabled: false,   // 快速匹配默认关闭，待合规确认
    joinShow: false,      // 加入房间弹窗
    joinNo: '',           // 输入的房间号
    stats: { hands: 0, wins: 0, net: 0, netText: '0', rate: '0%' },
    myRooms: [],        // 我创建的、仍在进行中的房间
    createShow: false,  // 创建房间弹窗（人数 + 时长）
    cMax: C_MAX_DEF,    // 限定人数：2–9，逐人可调
    cDur: DUR_DEF,      // 游戏时长（分钟）：10 的倍数，0 = 不限时
    cDurLast: DUR_DEF,  // 关掉「不限时」时恢复的时长
    durLabel: '30 分钟', // 时长展示文案（WXML 不能调方法，故随 cDur 一起维护）
    maxPresets: MAX_PRESETS,
    durPresets: DUR_PRESETS,
    cBlind: BLIND_DEF,      // 涨盲间隔（分钟）：0 = 不涨盲
    blindPresets: BLIND_PRESETS,
    sngShow: false,     // SNG 配置弹窗（人数）
    sngMax: C_MAX_DEF,  // SNG 桌型：2–9，逐人可调，默认 6
    setShow: false,     // 设置弹窗（参考主流 App 的 Table Appearance）
    cardsShow: false,   // 房卡弹窗（免费获取途径）
    claim: { dailyReady: true, dailyCount: 2, handCards: 0, handsPerCard: 10, handsToNext: 10 },
    sFourColor: true,   // 四色牌
    sSound: true,       // 音效
    sVibrate: true,      // 震动反馈
    sAnim: true,         // 牌桌动画
    createdShow: false,  // 创建房间成功弹窗
    createdRoomNo: '',
    createdRoomUrl: '',
    createdDesc: '',
    handRanks: [
      { name: '皇家同花顺', desc: 'A K Q J 10 同花色' },
      { name: '同花顺', desc: '同花色的连续 5 张' },
      { name: '四条', desc: '四张同点数 + 1 张' },
      { name: '葫芦', desc: '三条 + 一对' },
      { name: '同花', desc: '5 张同花色' },
      { name: '顺子', desc: '连续 5 张（A 可当 1）' },
      { name: '三条 / 两对 / 一对', desc: '常见成型' }
    ]
  },

  onLoad(options) {
    // 从好友分享卡片进入：自动填入房间号并尝试加入。
    // 分享参数是外部输入：非 6 位数字直接当房间号弹窗处理（不自动 tryJoin，
    // 否则脏参数会带着 loading/登录等待白跑一趟云端查询）
    const room = options && options.room;
    if (room && /^\d{6}$/.test(String(room))) {
      this.setData({ joinShow: true, joinNo: String(room) });
      this.tryJoin(String(room));
    } else if (room) {
      this.setData({ joinShow: true, joinNo: '' });
      wx.showToast({ title: '分享链接无效', icon: 'none' });
    }
  },

  onShow() {
    this.syncFromCloud();
    const s = settings.get();
    this.setData({ sFourColor: s.fourColor, sSound: s.sound, sVibrate: s.vibrate, sAnim: s.animation });
  },

  /** 下拉刷新：重新拉取档案与房间列表后收起刷新动画 */
  async onPullDownRefresh() {
    await this.syncFromCloud();
    wx.stopPullDownRefresh();
  },

  /** 打开创建房间弹窗（人数与时长均可自定义） */
  onCreateTap() {
    this.setData({ createShow: true });
  },

  /** 打开 SNG 配置弹窗（选桌型，再弹难度 ActionSheet） */
  onSngConfigTap() {
    this.setData({ sngShow: true });
  },

  onSngConfigClose() {
    this.setData({ sngShow: false });
  },

  /** SNG 桌型 ±1（复用 setMax 的夹取口径，仅写 sngMax） */
  onSngMaxStep(e) {
    const step = Number(e.currentTarget.dataset.step) || 0;
    const v = Math.min(C_MAX_MAX, Math.max(C_MAX_MIN, this.data.sngMax + step));
    this.setData({ sngMax: v });
  },

  /** SNG 桌型预设（2 / 4 / 6 / 9） */
  onSngPickMax(e) {
    const v = Number(e.currentTarget.dataset.max);
    const clamped = Math.min(C_MAX_MAX, Math.max(C_MAX_MIN, isNaN(v) ? C_MAX_DEF : Math.round(v)));
    this.setData({ sngMax: clamped });
  },

  /** SNG 配置确认：关弹窗后弹难度档 ActionSheet */
  onSngConfigConfirm() {
    this.setData({ sngShow: false });
    this.onSngMode();
  },

  onCreateClose() {
    this.setData({ createShow: false });
  },

  /**
   * 弹窗内容层的点按吞没（catchtap 绑定目标）：拦住冒泡防误触遮罩关闭。
   * 裸 catchtap 是无保证写法（评审 2026-10-15 MEDIUM），显式绑定空函数才稳。
   */
  onBlockTap() { /* 有意留空：只吞冒泡 */ },

  /** 设定限定人数，夹到 2–9 */
  setMax(n) {
    const v = Number(n);
    const clamped = Math.min(C_MAX_MAX, Math.max(C_MAX_MIN, isNaN(v) ? C_MAX_DEF : Math.round(v)));
    this.setData({ cMax: clamped });
  },

  /** 预设人数（2 / 4 / 6 / 9） */
  onPickMax(e) {
    this.setMax(e.currentTarget.dataset.max);
  },

  /** 人数 ±1（dataset.step = 1 / -1） */
  onMaxStep(e) {
    this.setMax(this.data.cMax + (Number(e.currentTarget.dataset.step) || 0));
  },

  /**
   * 设定时长（分钟）：对齐到 10 分钟一档，夹到 10–300。
   * 注意 0 是合法入参（步进到下限时的边界值），只有 NaN 才回落到默认档。
   */
  setDur(min) {
    const raw = Number(min);
    const base = isNaN(raw) ? DUR_DEF : raw;
    const m = Math.min(DUR_MAX, Math.max(DUR_MIN, Math.round(base / DUR_STEP) * DUR_STEP));
    this.setData({ cDur: m, cDurLast: m, durLabel: this.durText(m) });
  },

  /** 切到「不限时」（保留 cDurLast，便于切回） */
  setUnlimited() {
    this.setData({ cDur: 0, durLabel: '不限时' });
  },

  /** 预设时长 */
  onPickDur(e) {
    this.setDur(e.currentTarget.dataset.d);
  },

  /** 时长 ±10 分钟（从「不限时」起步时，按上次的有限时长接续） */
  onDurStep(e) {
    const step = Number(e.currentTarget.dataset.step) || 0;
    const base = this.data.cDur > 0 ? this.data.cDur : (this.data.cDurLast || DUR_DEF);
    this.setDur(base + step * DUR_STEP);
  },

  /** 「不限时」开关：关掉时恢复上一次的有限时长 */
  onToggleUnlimited() {
    if (this.data.cDur === 0) this.setDur(this.data.cDurLast || DUR_DEF);
    else this.setUnlimited();
  },

  /** 预设涨盲间隔（0 / 10 / 15 / 20 / 30 分） */
  onPickBlind(e) {
    const v = Number(e.currentTarget.dataset.b);
    if (isNaN(v)) return;
    this.setData({ cBlind: Math.max(0, v) });
  },

  /** 确认创建：带上人数、时长与涨盲间隔 */
  onCreateConfirm() {
    this.setData({ createShow: false });
    this.onCreateRoom(this.data.cMax, this.data.cDur, this.data.cBlind);
  },

  /** 时长（分钟）→ 展示文案（90 → 「1 小时 30 分钟」） */
  durText(min) {
    const m = Number(min) || 0;
    if (!m) return '不限时';
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (!h) return m + ' 分钟';
    return r ? (h + ' 小时 ' + r + ' 分钟') : (h + ' 小时');
  },

  /** 打开设置弹窗 */
  onSettingsTap() {
    const s = settings.get();
    this.setData({ setShow: true, sFourColor: s.fourColor, sSound: s.sound, sVibrate: s.vibrate, sAnim: s.animation });
  },

  onSettingsClose() {
    this.setData({ setShow: false });
  },

  /** 开关：四色牌 / 音效 / 动画，即时持久化 */
  onToggle(e) {
    const key = e.currentTarget.dataset.k;
    const patch = {};
    if (key === 'fourColor') patch.fourColor = !this.data.sFourColor;
    if (key === 'sound') patch.sound = !this.data.sSound;
    if (key === 'vibrate') patch.vibrate = !this.data.sVibrate;
    if (key === 'animation') patch.animation = !this.data.sAnim;
    const next = settings.set(patch);
    this.setData({
      sFourColor: next.fourColor,
      sSound: next.sound,
      sVibrate: next.vibrate,
      sAnim: next.animation
    });
  },

  /** app 登录完成后回调（app.login 在 finally 里触发） */
  onCloudReady() {
    this.syncFromCloud();
  },

  async syncFromCloud() {
    const g = app.globalData;
    if (!g.ready) return;

    if (g.loginError) {
      this.setData({ loading: false, loginError: g.loginError });
      return;
    }

    const p = g.profile;
    if (!p) { this.setData({ loading: false }); return; }

    const nickname = p.nickname || DEFAULT_NICK;
    const hands = p.total_hands || 0;
    const wins = p.total_wins || 0;
    const net = p.total_net || 0;

    this.setData({
      loading: false,
      loginError: '',
      nickname,
      initial: nickname.slice(0, 1),
      nickDefault: auth.isDefaultNickname(nickname),
      roomCards: p.room_cards || 0,
      claim: auth.claimStatus(p),
      stats: {
        hands,
        wins,
        net,
        netText: (net >= 0 ? '+' : '') + net,
        rate: hands ? Math.round(wins / hands * 100) + '%' : '0%'
      }
    });
    return this.loadMyRooms();   // 返回 promise，供 onPullDownRefresh await 等列表就绪
  },

  /** 重试登录 */
  async onRetryLogin() {
    this.setData({ loading: true, loginError: '' });
    await app.login();
    this.syncFromCloud();
  },

  /**
   * 好友房：云端建房 → 扣房卡（先建房后扣卡，失败不损失房卡）
   *
   * ⚠️ 踩坑记录：wx.showModal 的 confirmText/cancelText 在真机上最多 4 个字符，
   * 超长会导致弹窗静默失败（除非监听 fail 回调，否则界面毫无反应）。
   * 「复制房间号」5 个字曾导致建房成功但无任何弹窗、房卡被白白消耗。
   */
  async onCreateRoom(maxPlayers, durationMin, blindIntervalMin) {
    if (this.creatingRoom) return;   // 防连点：一次点击只建一个房
    this.creatingRoom = true;
    const max = maxPlayers || 6;
    const dur = durationMin || 0;
    const blind = Math.max(0, Number(blindIntervalMin) || 0);   // 批④：涨盲间隔
    wx.showLoading({ title: '创建房间中…', mask: true });
    try {
      // 0. 余额预检（不足时给出获取途径，而不是死路一条）
      const profile = app.globalData.profile;
      if (!profile || (profile.room_cards || 0) < 1) {
        wx.hideLoading();
        this.showNoCards();
        return;
      }

      // 1. 云端建房（带上限定人数与游戏时长）
      const room = await auth.createRoom('friend', max, dur);

      // 2. 扣房卡（乐观锁）。失败（不足/并发变动）或抛异常（网络断）都回滚关闭房间——
      //    否则重试一次就在云端泄漏一个 active 房间，占用首页「我的房间」坑位
      let cost;
      try {
        cost = await app.consumeRoomCard(1);
      } catch (cardErr) {
        auth.closeRoom(room.room_no).catch(e => console.error('[index] 扣卡异常回滚关房失败',
          JSON.stringify({ stage: 'createRoom-cardErr', room: room.room_no, err: e && e.message })));
        throw cardErr;
      }
      if (!cost.ok) {
        auth.closeRoom(room.room_no).catch(e => console.error('[index] 扣卡失败回滚关房失败',
          JSON.stringify({ stage: 'createRoom-noCard', room: room.room_no, err: e && e.message })));
        wx.hideLoading();
        this.syncFromCloud();
        this.showNoCards();
        return;
      }
      this.setData({ roomCards: cost.roomCards });
      wx.hideLoading();

      const roomUrl = '/pages/table/table?room=' + room.room_no + '&own=1' +
        '&max=' + max + '&dur=' + dur + '&blind=' + blind;
      // 创建成功：用自定义弹窗（wx.showModal 只有两个按钮，放不下「分享」），
      // 直接给「邀请好友（原生分享）/ 复制房号 / 进入房间」三个出口，少一次跳转。
      this.setData({
        createdShow: true,
        createdRoomNo: room.room_no,
        createdRoomUrl: roomUrl,
        createdDesc: max + ' 人桌 · ' + this.durText(dur) + (blind ? ' · 每 ' + blind + ' 分涨盲' : '')
      });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({
        title: '创建房间失败',
        content: (err && err.message) || '请检查网络后重试',
        confirmText: '知道了',
        showCancel: false
      });
    } finally {
      this.creatingRoom = false;
    }
  },

  /** 转发内容：从创建成功弹窗点「邀请好友」时，分享卡片带房间号，好友点开自动填入并加入 */
  onShareAppMessage() {
    const no = this.data.createdRoomNo;
    if (no) {
      return {
        title: '来「博弈论」和我打一局，房间号 ' + no,
        path: '/pages/index/index?room=' + no
      };
    }
    return { title: '博弈论 · 好友房德州扑克', path: '/pages/index/index' };
  },

  /** 分享到朋友圈：与 onShareAppMessage 同路径（有房间号时带 query） */
  onShareTimeline() {
    const no = this.data.createdRoomNo;
    if (no) {
      return { title: '来「博弈论」和我打一局，房间号 ' + no, query: 'room=' + no };
    }
    return { title: '博弈论 · 好友房德州扑克' };
  },

  /** 创建成功弹窗：关闭 */
  onCreatedClose() {
    this.setData({ createdShow: false });
  },

  /** 创建成功弹窗：进入房间 */
  onCreatedEnter() {
    const url = this.data.createdRoomUrl;
    this.setData({ createdShow: false });
    if (url) wx.navigateTo({ url });
  },

  /** 创建成功弹窗：复制房号 */
  onCreatedCopy() {
    wx.setClipboardData({
      data: this.data.createdRoomNo,
      success: () => wx.showToast({ title: '房间号已复制', icon: 'success' })
    });
  },

  /**
   * 房卡不足时的引导弹窗。
   * 按钮文案 ≤ 4 字（真机超限会静默失败）；confirm = 去领卡，cancel = 转 AI 桌（不耗房卡）。
   */
  showNoCards() {
    const c = this.data.claim || {};
    const tip = c.dailyReady
      ? '今日可免费领 ' + (c.dailyCount || 2) + ' 张'
      : ('再打 ' + (c.handsToNext || 10) + ' 手可领 1 张');
    wx.showModal({
      title: '房卡不足',
      content: '创建好友房需要 1 张房卡。\n' + tip + '，也可以先玩 AI 对战（不消耗房卡）。',
      confirmText: '去领卡',
      cancelText: 'AI 桌',
      success: res => {
        if (res.confirm) this.setData({ cardsShow: true });
        else if (res.cancel) this.onAIMode();
      }
    });
  },

  /** 房卡弹窗：免费获取途径 */
  onCardsTap() {
    this.setData({ cardsShow: true });
  },

  onCardsClose() {
    this.setData({ cardsShow: false });
  },

  /** 领取后刷新本地档案与展示 */
  async refreshProfile() {
    try {
      app.globalData.profile = await auth.ensureProfile();
      this.syncFromCloud();
    } catch (e) {
      wx.showToast({ title: '刷新房卡失败', icon: 'none' });
    }
  },

  async onClaimDaily() {
    wx.showLoading({ title: '领取中…', mask: true });
    try {
      const r = await auth.claimDailyCards();
      wx.hideLoading();
      if (!r.ok) {
        wx.showToast({ title: r.reason || '今日已领取', icon: 'none' });
        return;
      }
      wx.showToast({ title: '+' + r.gained + ' 张房卡', icon: 'success' });
      this.setData({ roomCards: r.roomCards });
      this.refreshProfile();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '领取失败', icon: 'none' });
    }
  },

  async onClaimHands() {
    wx.showLoading({ title: '领取中…', mask: true });
    try {
      const r = await auth.claimHandBonus();
      wx.hideLoading();
      if (!r.ok) {
        wx.showToast({ title: r.reason || '暂无可领', icon: 'none' });
        return;
      }
      wx.showToast({ title: '+' + r.gained + ' 张房卡', icon: 'success' });
      this.setData({ roomCards: r.roomCards });
      this.refreshProfile();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '领取失败', icon: 'none' });
    }
  },

  /** 房卡弹窗里「去加入」：关掉领卡面板，打开加入房间弹窗 */
  onJoinFromCards() {
    this.setData({ cardsShow: false, joinShow: true, joinNo: '' });
  },

  /** 好友房入口：创建 / 加入 */
  onFriendTap() {
    wx.showActionSheet({
      itemList: ['创建房间（消耗 1 张房卡）', '加入房间（输入房间号）'],
      success: res => {
        if (res.tapIndex === 0) this.onCreateTap();
        else this.setData({ joinShow: true, joinNo: '' });
      }
    });
  },

  /** 加入房间弹窗：输入房间号 */
  onJoinInput(e) {
    this.setData({ joinNo: e.detail.value });
  },

  onJoinCancel() {
    this.setData({ joinShow: false, joinNo: '' });
  },

  onJoinConfirm() {
    const no = (this.data.joinNo || '').trim();
    if (!/^\d{6}$/.test(no)) {
      wx.showToast({ title: '请输入 6 位数字房间号', icon: 'none' });
      return;
    }
    if (this.joining) return;   // 防连点：上一次加入仍在进行
    this.joining = true;
    this.tryJoin(no);
  },

  /** 按房间号查云端房间并进入 */
  async tryJoin(roomNo) {
    try {
    // 登录未完成时先等登录（分享冷启动时 onLaunch 的 login 可能仍在进行）
    if (!app.globalData.ready) {
      wx.showLoading({ title: '登录中…', mask: true });
      await new Promise(resolve => {
        const t = setInterval(() => {
          if (app.globalData.ready) { clearInterval(t); resolve(); }
        }, 200);
      });
      wx.hideLoading();
    }
    if (app.globalData.loginError) {
      wx.showToast({ title: '登录未完成，无法加入房间', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '查找房间…', mask: true });
    try {
      const room = await auth.findRoom(roomNo);
      wx.hideLoading();
      if (!room) {
        wx.showToast({ title: '房间不存在或已结束', icon: 'none' });
        return;
      }
      this.setData({ joinShow: false, joinNo: '' });
      wx.navigateTo({ url: '/pages/table/table?room=' + roomNo });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: err.message || '查询房间失败', icon: 'none' });
    }
    } finally {
      this.joining = false;
    }
  },

  /** AI 对战·快速入桌（P1-4）：点卡片直接开局，省去「难度 ActionSheet → 等待室
   *  → 选座 → 补位 → 开始」五步。默认进阶难度 + 5 bot（与历史首局体验同口径）；
   *  要换难度 → 长按卡片出 ActionSheet。 */
  onAIQuick() {
    wx.navigateTo({ url: '/pages/table/table?mode=ai&level=advanced&bots=5&quick=1' });
  },

  /** AI 对战·手动入口（长按触发）：弹难度选择（新手 / 进阶 / 高手），默认进阶。
   *  其余调用处（新手流程/关闭房卡弹窗等「先玩 AI 桌」回退）保持直进等待室。 */
  onAIMode() {
    wx.showActionSheet({
      itemList: ['新手 · 对手较温和', '进阶 · 均衡对手', '高手 · 对手更狡猾'],
      success: res => {
        const levels = ['rookie', 'advanced', 'expert'];
        const level = levels[res.tapIndex] || 'advanced';
        wx.navigateTo({ url: '/pages/table/table?mode=ai&level=' + level + '&bots=5&quick=1' });
      },
      fail: () => {
        // 用户取消 ActionSheet（tapIndex 不存在）→ 默认进阶直进，不阻断入口
        wx.navigateTo({ url: '/pages/table/table?mode=ai&level=advanced&bots=5&quick=1' });
      }
    });
  },

  /** SNG 淘汰赛（批⑤）：纯客户端赛制编排，不消耗房卡。
   *  涨盲默认 3 分钟（天然推进僵局），筹码归零即淘汰，最后一人夺冠。
   *  难度档位（rookie/advanced/expert）现在真实生效——table.js 的
   *  styleFor/applyLevel 均按 mode==='ai'||mode==='sng' 读 this.level，
   *  故选「高手场」时 bot 真按 expert 档绑定角色风格，不再是恒 advanced。
   *  桌型默认 6 人桌（SNG 标准）；可选桌型见 onSngConfigConfirm 后拼接的 max=。 */
  onSngMode() {
    wx.showActionSheet({
      itemList: ['新手场 · 对手较温和', '进阶场 · 均衡对手', '高手场 · 对手更狡猾'],
      success: res => {
        const levels = ['rookie', 'advanced', 'expert'];
        const level = levels[res.tapIndex] || 'advanced';
        const max = this.data.sngMax || 6;
        wx.navigateTo({ url: '/pages/table/table?mode=sng&level=' + level + '&blind=3&max=' + max });
      },
      fail: () => {
        const max = this.data.sngMax || 6;
        wx.navigateTo({ url: '/pages/table/table?mode=sng&level=advanced&blind=3&max=' + max });
      }
    });
  },

  /** 每日一题 / 局面挑战（纯教学，无房卡消耗） */
  onPuzzleTap() {
    wx.navigateTo({ url: '/pages/puzzle/puzzle' });
  },

  /** 快速匹配（合规待定，默认关闭） */
  onRankMode() {
    wx.showModal({
      title: '暂未开放',
      content: '随机匹配涉及陌生人社交对局，需先确认平台合规政策后再开放',
      showCancel: false
    });
  },

  onGoProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  /**
   * 拉取「我创建的」进行中的房间（非关键路径，失败静默）。
   * 顺手清理僵尸房：限时房到期 / 不限时房超 24 小时的，自动关闭云端房间
   * 并清掉本地续局快照（30 分钟空闲销毁只在房主停留在等待室时生效，
   * 退出页面后无人兜底，这里就是兜底入口）。
   */
  async loadMyRooms() {
    // 列表为非首屏必需，但需区分「加载中 / 加载失败 / 真的没有」三种状态，
    // 否则用户分不清是网络挂了还是没有进行中的房间。
    this.setData({ roomsLoading: true, roomsError: false });
    try {
      const rooms = await auth.listMyRooms();
      const now = Date.now();
      const kept = [];
      const stale = [];
      (rooms || []).forEach(r => {
        if (auth.roomExpired(r, now)) stale.push(r.room_no);
        else kept.push(r);
      });
      stale.forEach(no => {
        snapshot.clear(no);
        auth.closeRoom(no).catch(e => console.error('[index] 僵尸房清理关房失败',
          JSON.stringify({ stage: 'loadMyRooms-stale', room: no, err: e && e.message })));
      });
      this.setData({
        roomsLoading: false,
        roomsError: false,
        myRooms: kept.map(r => {
          // 本地若有该房间的牌局快照，说明中途退出过，进入后可续局
          const snap = snapshot.load(r.room_no);
          const live = !!snap;
          return {
            roomNo: r.room_no,
            mode: r.mode,
            maxPlayers: r.max_players || 6,
            durationMin: r.duration_min || 0,
            durText: this.durText(r.duration_min),
            createdAt: r.created_at,
            live: live,
            liveText: live ? '继续第 ' + snap.handNo + ' 手' : '等待中'
          };
        })
      });
    } catch (e) {
      // 房间列表非首屏必需，错误不阻塞首页，但要告诉用户「加载失败」可重试
      this.setData({ roomsLoading: false, roomsError: true });
    }
  },

  /**
   * 删除房间：关闭云端房间 + 清除本地续局快照。
   * catchtap 阻止冒泡，不会触发卡片的进入房间。
   */
  onRetryRooms() {
    this.loadMyRooms();
  },

  onCloseRoom(e) {
    const room = e.currentTarget.dataset.room;
    if (!room) return;
    wx.showModal({
      title: '删除房间',
      content: '房间 ' + room + ' 将被关闭并从列表移除，好友将无法再加入',
      confirmText: '删除',
      cancelText: '取消',
      confirmColor: '#e5484d',
      success: res => {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中…', mask: true });
        auth.closeRoom(room)
          .then(() => {
            snapshot.clear(room);
            wx.hideLoading();
            wx.showToast({ title: '已删除', icon: 'success' });
            this.loadMyRooms();
          })
          .catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '删除失败，请重试', icon: 'none' });
          });
      }
    });
  },

  /** 点击「我的房间」卡片，直接进入对应房间（own=1 标记为房主，可续局/开牌） */
  onEnterRoom(e) {
    const d = e.currentTarget.dataset;
    const room = d.room;
    if (!room) return;
    // 带上房间创建时的人数与时长设置，保证续局沿用同一规则
    const url = '/pages/table/table?room=' + room + '&own=1' +
      '&max=' + (d.max || 6) + '&dur=' + (d.dur || 0);
    wx.navigateTo({ url });
  }
});
