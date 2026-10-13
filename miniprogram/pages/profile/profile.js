const app = getApp();
const { auth } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    nickname: '玩家',
    initial: '玩',
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
      const nickname = p.nickname || '玩家';
      const hands = p.total_hands || 0;
      const wins = p.total_wins || 0;
      const net = p.total_net || 0;
      const rate = hands ? wins / hands : 0;

      this.setData({
        nickname,
        initial: nickname.slice(0, 1),
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

  /** 'As Ks' / 'AsKs' → 'A♠ K♠' */
  formatCards(codeStr) {
    if (!codeStr) return '';
    const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    const SUITS = { s: '♠', c: '♣', d: '♦', h: '♥' };
    return String(codeStr)
      .replace(/\s+/g, '')
      .split('')
      .reduce((acc, ch, i, arr) => {
        const rankIdx = RANKS.indexOf(ch);
        if (rankIdx >= 0) return acc + ch;
        const suit = SUITS[ch];
        if (suit) return acc + suit + ' ';
        return acc;
      }, '')
      .trim();
  }
});
