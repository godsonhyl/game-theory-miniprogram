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
/**
 * 默认值。vibrate 为后加项：读取旧设置时若没有该字段，回退为与旧 sound 一致
 * （即默认开震动），保证老用户升级后体验不跳变；新安装默认全部开。
 */
const DEFAULTS = { fourColor: true, sound: true, vibrate: true, animation: true };

function get() {
  try {
    const saved = wx.getStorageSync(KEY) || {};
    const merged = Object.assign({}, DEFAULTS, saved);
    // 老用户升级：从未存过 vibrate → 与 sound 保持一致（不改变原有体验）
    if (saved && saved.vibrate === undefined && saved.sound !== undefined) {
      merged.vibrate = saved.sound;
    }
    return merged;
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
