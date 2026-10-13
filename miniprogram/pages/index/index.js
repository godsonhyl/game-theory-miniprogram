const app = getApp();
const { auth } = require('../../utils/auth');
const { settings } = require('../../utils/settings');
const snapshot = require('../../utils/room-snapshot');

Page({
  data: {
    loading: true,
    loginError: '',
    nickname: '玩家',
    initial: '玩',
    roomCards: 0,
    rankEnabled: false,   // 快速匹配默认关闭，待合规确认
    joinShow: false,      // 加入房间弹窗
    joinNo: '',           // 输入的房间号
    stats: { hands: 0, wins: 0, net: 0, netText: '0', rate: '0%' },
    myRooms: [],        // 我创建的、仍在进行中的房间
    createShow: false,  // 创建房间弹窗（人数 + 时长）
    cMax: 6,            // 限定人数：2 / 4 / 6
    cDur: 0,            // 游戏时长（分钟）：30 / 60 / 120 / 0=不限时
    setShow: false,     // 设置弹窗（参考主流 App 的 Table Appearance）
    cardsShow: false,   // 房卡弹窗（免费获取途径）
    claim: { dailyReady: true, dailyCount: 2, handCards: 0, handsPerCard: 10, handsToNext: 10 },
    sFourColor: true,   // 四色牌
    sSound: true,       // 音效 + 震动
    sAnim: true,        // 牌桌动画
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
    // 从好友分享卡片进入：自动填入房间号并尝试加入
    const room = options && options.room;
    if (room) {
      this.setData({ joinShow: true, joinNo: room });
      this.tryJoin(room);
    }
  },

  onShow() {
    this.syncFromCloud();
    const s = settings.get();
    this.setData({ sFourColor: s.fourColor, sSound: s.sound, sAnim: s.animation });
  },

  /** 打开创建房间弹窗（先选人数与时长，再建房） */
  onCreateTap() {
    this.setData({ createShow: true });
  },

  onCreateClose() {
    this.setData({ createShow: false });
  },

  /** 选择限定人数 */
  onPickMax(e) {
    this.setData({ cMax: Number(e.currentTarget.dataset.max) });
  },

  /** 选择游戏时长（分钟，0 = 不限时） */
  onPickDur(e) {
    this.setData({ cDur: Number(e.currentTarget.dataset.d) });
  },

  /** 确认创建：带上人数与时长 */
  onCreateConfirm() {
    this.setData({ createShow: false });
    this.onCreateRoom(this.data.cMax, this.data.cDur);
  },

  /** 时长（分钟）→ 展示文案 */
  durText(min) {
    const m = Number(min) || 0;
    if (!m) return '不限时';
    if (m < 60) return m + ' 分钟';
    return (m / 60) + ' 小时';
  },

  /** 打开设置弹窗 */
  onSettingsTap() {
    const s = settings.get();
    this.setData({ setShow: true, sFourColor: s.fourColor, sSound: s.sound, sAnim: s.animation });
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
    if (key === 'animation') patch.animation = !this.data.sAnim;
    const next = settings.set(patch);
    this.setData({
      sFourColor: next.fourColor,
      sSound: next.sound,
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

    const nickname = p.nickname || '玩家';
    const hands = p.total_hands || 0;
    const wins = p.total_wins || 0;
    const net = p.total_net || 0;

    this.setData({
      loading: false,
      loginError: '',
      nickname,
      initial: nickname.slice(0, 1),
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
    this.loadMyRooms();
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
  async onCreateRoom(maxPlayers, durationMin) {
    if (this.creatingRoom) return;   // 防连点：一次点击只建一个房
    this.creatingRoom = true;
    const max = maxPlayers || 6;
    const dur = durationMin || 0;
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

      // 2. 扣房卡（乐观锁）。失败则回滚关闭房间
      const cost = await app.consumeRoomCard(1);
      if (!cost.ok) {
        auth.closeRoom(room.room_no).catch(() => {});
        wx.hideLoading();
        this.syncFromCloud();
        this.showNoCards();
        return;
      }
      this.setData({ roomCards: cost.roomCards });
      wx.hideLoading();

      const roomUrl = '/pages/table/table?room=' + room.room_no + '&own=1' +
        '&max=' + max + '&dur=' + dur;
      wx.showModal({
        title: '房间已创建',
        content: '房间号 ' + room.room_no + '\n' + max + ' 人桌 · ' + this.durText(dur) +
          '\n\n把房间号发给好友即可一起对战',
        confirmText: '进入房间',
        cancelText: '复制房号',   // 微信限制：按钮文案 ≤ 4 个字
        success: res => {
          if (res.confirm) {
            wx.navigateTo({ url: roomUrl });
          } else if (res.cancel) {
            wx.setClipboardData({
              data: room.room_no,
              success: () => wx.showToast({ title: '房间号已复制', icon: 'success' })
            });
          }
        },
        fail: () => {
          // 兜底：弹窗本身失败时，也要让用户拿到房间号并进入
          wx.setClipboardData({
            data: room.room_no,
            success: () => wx.navigateTo({ url: roomUrl })
          });
        }
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
    this.tryJoin(no);
  },

  /** 按房间号查云端房间并进入 */
  async tryJoin(roomNo) {
    // 登录未完成时先等登录（分享冷启动时 onLaunch 的 login 可能仍在进行）
    if (!app.globalData.ready) {
      wx.showLoading({ title: '登录中…' });
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

    wx.showLoading({ title: '查找房间…' });
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
  },

  /** AI 对战（无需房卡） */
  onAIMode() {
    wx.navigateTo({ url: '/pages/table/table?mode=ai' });
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

  /** 拉取「我创建的」进行中的房间（非关键路径，失败静默） */
  async loadMyRooms() {
    try {
      const rooms = await auth.listMyRooms();
      this.setData({
        myRooms: (rooms || []).map(r => {
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
      // 房间列表非首屏必需，错误不阻塞首页
    }
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
