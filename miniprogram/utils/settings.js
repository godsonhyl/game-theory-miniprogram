/**
 * 用户设置（本地持久化）
 *
 * 参考主流德州扑克 App 的「Table Appearance / 设置」：
 *   - fourColor：四色牌（黑桃黑 / 梅花绿 / 方块蓝 / 红桃红），提升读牌清晰度；
 *   - sound：操作音效 + 震动反馈；
 *   - animation：牌桌动画（发牌 / 下注 / 光效）开关。
 *
 * 设置仅存本地（wx storage），不进云端。
 */
const KEY = 'poker_settings';
const DEFAULTS = { fourColor: true, sound: true, animation: true };

function get() {
  try {
    const saved = wx.getStorageSync(KEY) || {};
    return Object.assign({}, DEFAULTS, saved);
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function set(patch) {
  const next = Object.assign({}, get(), patch);
  try { wx.setStorageSync(KEY, next); } catch (e) { /* 存储失败不影响运行 */ }
  return next;
}

module.exports = { settings: { get, set, DEFAULTS } };
