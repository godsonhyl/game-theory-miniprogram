/**
 * SNG 结算存档（本地，不进云）
 *
 * 用途：SNG 终局结算弹窗是一闪而过的——手快关掉、被来电/切后台打断、或
 * 「再来一局」直接盖掉，玩家就再也看不到「带入 / 剩余 / 盈亏 / 名次」这份
 * 结算单。本模块把结算单原样留档，供复盘页随时回看。
 *
 * 数据只存「结算摘要」（名次表 + 我的三项），不存逐手 events：
 * 逐手回放仍由 replay-store / poker_hand_replays 负责，两者职责不重叠。
 *
 * 边界：纯本地体验优化；存储失败静默降级，绝不阻断结算主流程。
 * 上限 MAX_RECORDS 场（FIFO），单条约 2KB，总占 < 20KB。
 */
const KEY = 'poker_sng_summaries';
const MAX_RECORDS = 10;

function readAll() {
  try {
    const v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

/** 存一场 SNG 结算。rec 由 table.js endGame 组装；失败返回 false。
 *  同一 id 覆盖（重入保护），新记录置顶。 */
function save(rec) {
  if (!rec || !Array.isArray(rec.rows) || !rec.rows.length) return false;
  try {
    const id = rec.id || Date.now();
    const item = Object.assign({}, rec, { id: id, ts: rec.ts || Date.now() });
    const list = readAll().filter(x => String(x.id) !== String(id));
    list.unshift(item);
    wx.setStorageSync(KEY, list.slice(0, MAX_RECORDS));
    return true;
  } catch (e) {
    return false;
  }
}

function list() { return readAll(); }

function latest() { return readAll()[0] || null; }

function findById(id) {
  return readAll().filter(x => String(x.id) === String(id))[0] || null;
}

function clear() {
  try { wx.removeStorageSync(KEY); } catch (e) { /* 清空失败无副作用 */ }
}

module.exports = { save: save, list: list, latest: latest, findById: findById, clear: clear };
