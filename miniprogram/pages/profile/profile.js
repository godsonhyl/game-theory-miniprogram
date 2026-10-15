const app = getApp();
const { auth, DEFAULT_NICK, NICK_MAX } = require('../../utils/auth');

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
    records: []
  },

  onShow() {
    this.loadFromCloud();
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

    // 历史战绩从云端拉取
    try {
      const rows = await auth.listRecords(20);
      this.setData({
        loading: false,
        records: rows.map((r, i) => ({
          id: r.id,
          handNo: r.hand_no,
          net: r.net,
          hole: this.formatCards(r.hole_cards),
          board: this.formatCards(r.board),
          handType: r.hand_type || (r.won ? '获胜' : '未中牌')
        }))
      });
    } catch (err) {
      this.setData({ loading: false });
      wx.showToast({ title: err.message || '读取战绩失败', icon: 'none' });
    }
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
