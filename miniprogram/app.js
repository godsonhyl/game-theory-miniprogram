const { auth } = require('./utils/auth');

App({
  globalData: {
    user: null,
    profile: null,     // 玩家档案：房卡与累计统计
    loginError: '',
    ready: false
  },

  onLaunch() {
    this.login();
  },

  /** 静默微信登录 */
  async login() {
    try {
      const { user, profile } = await auth.login();
      this.globalData.user = user;
      this.globalData.profile = profile;
      this.globalData.loginError = '';
    } catch (err) {
      this.globalData.loginError = err && err.message ? err.message : '登录失败，请重试';
      console.error('[app] 登录失败', this.globalData.loginError);
    } finally {
      this.globalData.ready = true;
      // 通知首页刷新登录态
      const pages = getCurrentPages();
      pages.forEach(p => { if (p.onCloudReady) p.onCloudReady(); });
    }
  },

  /** 房卡扣减（转发到 auth，内部有乐观锁） */
  async consumeRoomCard(count) {
    const res = await auth.consumeRoomCard(count || 1);
    if (res.ok) this.globalData.profile = { ...this.globalData.profile, room_cards: res.roomCards };
    return res;
  }
});
