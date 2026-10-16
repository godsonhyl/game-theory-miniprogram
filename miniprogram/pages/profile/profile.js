const app = getApp();
const { auth, DEFAULT_NICK, NICK_MAX } = require('../../utils/auth');
const replayStore = require('../../utils/replay-store');           // 复盘缓存（本地存量）
const styleAnalyzer = require('../../utils/style-analyzer');       // 个人风格分析（吃复盘缓存存量）
const chartStats = require('../../utils/chart-stats');             // 战绩深化图表数据（方向 A，纯客户端）
const highlightStore = require('../../utils/highlight-store');     // 高光时刻存档（本地存量）

const PAGE_SIZE = 20;   // 战绩每页条数（游标分页，触底加载下一页）
const CHART_LIMIT = 100; // 战绩深化图表取样上限（单次拉取、不分页）

Page({
  data: {
    loading: true,
    nickname: DEFAULT_NICK,
    initial: '玩',
    editing: false,      // 昵称编辑态
    nickInput: '',
    nickDefault: true,   // 昵称仍是占位值（尚未用微信名设置过）
    nickMax: NICK_MAX,
    stats: { hands: 0, wins: 0, net: 0, netText: '0' },
    style: '稳健型',
    styleAnalysis: null,  // 个人风格画像（第三期）：吃本地复盘缓存的行为统计，非云端胜率代理
    vpipMin: styleAnalyzer.VPipMin,   // 样本下限常量，注入 wxml 供「样本不足」展示
    posVpipList: null,    // 位置入池率数组 [{label,pct}]（wxml 循环用，避免循环内点访问页面 data）
    records: [],
    recordsLoading: false,   // 战绩加载中（区分首屏 loading 与翻页 loading）
    recordsEnd: false,       // 已加载到底（无更多战绩），隐藏触底加载条
    recordsError: false,     // 战绩加载失败（与「没有记录」区分，提供重试入口）
    // 战绩深化图表（方向 A）：胜率曲线 / 牌型分布 / 盈亏走势，纯 CSS 渲染
    chartLoading: false,
    chartHands: 0,
    chartWinRate: null,       // 胜率曲线分块数组
    chartWinPct: 0,           // 总胜率%
    chartHandTypes: [],        // 牌型分布
    chartNet: null,           // 盈亏走势柱数组
    chartNetSum: 0,           // 净盈亏总和
    chartNetSumText: '0',     // 净盈亏带符号文案
    // 高光时刻徽章墙：4 类成就计数 + 最值得炫耀的一手（高光存档派生，纯本地）
    highlightBadges: [],
    highlightBest: null
  },

  onShow() {
    this.loadFromCloud();
  },

  /** 下拉刷新：重新拉取档案与战绩后收起刷新动画 */
  async onPullDownRefresh() {
    await this.loadFromCloud();
    wx.stopPullDownRefresh();
  },

  async loadFromCloud() {
    // 档案取自登录态（已在 app 登录时载入）
    const p = app.globalData.profile;
    if (p) {
      const nickname = p.nickname || DEFAULT_NICK;
      const isDefault = auth.isDefaultNickname(nickname);
      const hands = p.total_hands || 0;
      const wins = p.total_wins || 0;
      const net = p.total_net || 0;
      const rate = hands ? wins / hands : 0;

      this.setData({
        nickname,
        initial: nickname.slice(0, 1),
        nickDefault: isDefault,
        // 从没设过昵称 → 直接展开输入框，并在下面给出「点此填入微信昵称」的引导
        editing: isDefault,
        nickInput: isDefault ? '' : nickname,
        stats: { hands, wins, net, netText: (net >= 0 ? '+' : '') + net },
        style: rate >= 0.65 ? '激进型' : (rate <= 0.3 ? '保守型' : '稳健型')
      });
    }

    // 历史战绩从云端拉取（首页，从最新开始）
    this._recordCursor = null;   // 翻页游标：上一页最后一条的 created_at
    this.setData({ records: [], recordsEnd: false, recordsError: false });
    await this.loadRecords(true);
    // 风格画像：吃本地复盘缓存的行为统计（第三期），与云端战绩独立、无网络。
    this.loadStyleAnalysis();
    // 战绩深化图表：吃云端战绩流水，纯客户端聚合（方向 A），不阻塞主链路
    this.loadCharts();
    // 高光时刻徽章墙：吃本地高光存档（纯客户端，无网络）
    this.loadHighlights();
  },

  /**
   * 拉取战绩（游标分页）。first=true 为首屏加载（带 loading 骨架），
   * 否则为触底加载下一页（带底部加载条，不清空已有列表）。
   */
  async loadRecords(first) {
    if (this.data.recordsLoading) return;     // 防连点：上一页还没回不来
    if (!first && this.data.recordsEnd) return; // 已到底，不再请求
    this.setData({ recordsLoading: true, loading: first, recordsError: false });
    try {
      const rows = await auth.listRecords(PAGE_SIZE, this._recordCursor);
      const mapped = rows.map(r => ({
        id: r.id,
        handNo: r.hand_no,
        net: r.net,
        hole: this.formatCards(r.hole_cards),
        board: this.formatCards(r.board),
        handType: r.hand_type || (r.won ? '获胜' : '未中牌')
      }));
      // 游标推进：用本页最后一条的 created_at 作为下一页起点
      const last = rows[rows.length - 1];
      this._recordCursor = last ? last.created_at : null;
      const merged = first ? mapped : this.data.records.concat(mapped);
      this.setData({
        loading: false,
        recordsLoading: false,
        records: merged,
        // 不足一页 = 已到底（云端按 created_at 倒序，返回 < PAGE_SIZE 即无更多）
        recordsEnd: rows.length < PAGE_SIZE
      });
    } catch (err) {
      // 失败分级：首屏失败 → 整块替换成「加载失败 + 重试」空态；翻页失败 → 保留
      // 已加载的列表（仅 toast 提示），否则一次触底的瞬时网络抖动会丢掉已加载的全部记录。
      const patch = { loading: false, recordsLoading: false };
      if (first) patch.recordsError = true;
      this.setData(patch);
      wx.showToast({ title: (err && err.message) || '读取战绩失败', icon: 'none' });
    }
  }

  /** 风格画像：吃本地复盘缓存的行为统计（第三期）。样本不足时 analyze 返回
   *  insufficient 态，UI 显示「样本不足」不硬算——避免小样本误导（设计硬约束）。
   *  位置入池率 positionVpip 是 {BTN:'50%',…} 对象，转成 wxml 友好的数组
   *  [{label,pct}]（wxml 循环内只访问 item 别名，不点访问页面 data——check-wxml 规则）。 */
  loadStyleAnalysis() {
    const res = styleAnalyzer.analyze(replayStore.listAll());
    let posList = null;
    if (res && res.positionVpip) {
      posList = ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO'].map(k => ({
        label: k, pct: res.positionVpip[k] || '—'
      }));
    }
    this.setData({ styleAnalysis: res, posVpipList: posList });
  },

  /** 战绩深化图表（方向 A）：拉取最近 CHART_LIMIT 手战绩流水，纯客户端聚合
   *  后交给 wxml 用 transform: scaleY / width:{{x}}% 渲染。非关键路径，失败静默
   *  降级（与 replay-store 同级，不弹 toast、不 console.error 刷屏）。 */
  async loadCharts() {
    this.setData({ chartLoading: true });
    try {
      const rows = await auth.listRecords(CHART_LIMIT, null);
      const winRate = chartStats.computeWinRate(rows);
      const handTypes = chartStats.computeHandTypes(rows);
      const net = chartStats.computeNetTrend(rows);
      this.setData({
        chartLoading: false,
        chartHands: rows.length,
        chartWinRate: winRate.chunks,
        chartWinPct: winRate.overallPct,
        chartHandTypes: handTypes,
        chartNet: net.bars,
        chartNetSum: net.sum,
        chartNetSumText: net.sumText
      });
    } catch (err) {
      // 图表属非关键路径，失败仅静默清空（不弹 toast、不刷屏）
      this.setData({ chartLoading: false, chartHands: 0 });
    }
  },

  /** 战绩加载失败后重试 */
  onRetryRecords() {
    this.setData({ recordsError: false });
    this.loadRecords(true);
  },

  /** 高光时刻徽章墙：从本地高光存档派生 4 类成就计数 + 最值得炫耀的一手。
   *  徽章数 = listAll().filter(type===X).length（单条记录派生计数，天然一致，不另维护计数器）。
   *  最值得炫耀的一手 = 取最高级别（皇家同花顺 > 四条 > 诈唬成功 > 连胜5）的最近一条。 */
  loadHighlights() {
    const list = highlightStore.listAll();
    const DEFS = [
      { key: 'royal_flush', name: '皇家同花顺', icon: '👑', type: 'royal_flush' },
      { key: 'quads', name: '四条', icon: '4', type: 'quads' },
      { key: 'bluff_success', name: '诈唬成功', icon: '🎭', type: 'bluff_success' },
      { key: 'streak5', name: '连胜 5 局', icon: '🔥', type: 'streak5' }
    ];
    // 优先级序：取「最值得炫耀的一手」时用——皇家 > 四条 > 诈唬 > 连胜
    const RANK = { royal_flush: 0, quads: 1, bluff_success: 2, streak5: 3 };
    const badges = DEFS.map(d => {
      const count = list.filter(r => r.type === d.type).length;
      return { key: d.key, name: d.name, icon: d.icon, count, unlocked: count > 0 };
    });
    let best = null;
    let bestRank = 99;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      const rk = RANK[r.type];
      if (rk === undefined) continue;
      if (rk < bestRank) { bestRank = rk; best = r; if (rk === 0) break; }
    }
    this.setData({ highlightBadges: badges, highlightBest: best });
  },

  /** 点「最值得炫耀的一手」跳复盘页重看（经 from=highlight 分支定位高光存档） */
  onReplayBest() {
    const best = this.data.highlightBest;
    if (!best) return;
    wx.navigateTo({ url: '/pages/replay/replay?date=' + best.date + '&from=highlight' });
  },

  /** 列表触底：加载下一页战绩 */
  onReachBottom() {
    this.loadRecords(false);
  },

  onEditNick() {
    this.setData({
      editing: true,
      nickInput: auth.isDefaultNickname(this.data.nickname) ? '' : this.data.nickname
    });
  },

  onNickInput(e) {
    this.setData({ nickInput: e.detail.value });
  },

  onCancelNick() {
    this.setData({ editing: false, nickInput: '' });
  },

  /** 保存昵称（<input type="nickname"> 填入的就是微信昵称） */
  async onSaveNick() {
    const v = (this.data.nickInput || '').trim();
    if (!v) { wx.showToast({ title: '昵称不能为空', icon: 'none' }); return; }
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      const row = await auth.saveNickname(v);
      const nick = (row && row.nickname) || v;
      wx.hideLoading();
      this.setData({
        editing: false,
        nickname: nick,
        initial: nick.slice(0, 1),
        nickDefault: false,
        nickInput: ''
      });
      // 同步登录态，下次进牌桌立即用新名字
      app.globalData.profile = Object.assign({}, app.globalData.profile, { nickname: nick });
      wx.showToast({ title: '已更新', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    }
  },

  /** 'As Ks' / 'AsKs' → 'A♠ K♠'（10 显示为 '10♠'） */
  formatCards(codeStr) {
    if (!codeStr) return '';
    // 解析用的机读码字母表：必须与引擎保持一致，历史战绩里存的就是这种单字符格式
    const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    const RANK_TEXT = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const SUITS = { s: '♠', c: '♣', d: '♦', h: '♥' };
    return String(codeStr)
      .replace(/\s+/g, '')
      .split('')
      .reduce((acc, ch, i, arr) => {
        const rankIdx = RANKS.indexOf(ch);
        if (rankIdx >= 0) return acc + RANK_TEXT[rankIdx];
        const suit = SUITS[ch];
        if (suit) return acc + suit + ' ';
        return acc;
      }, '')
      .trim();
  }
});
