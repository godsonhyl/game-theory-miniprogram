/**
 * 好友房牌局快照
 *
 * 用途：牌局中途退出时，把「座位 / 剩余筹码 / 第几手 / 上一手庄位」暂存本地；
 * 再次进入同一房间时据此续局，避免退出即牌局归零。
 *
 * 说明：仅为本地体验优化（当前好友房是本地引擎模拟，无服务端房间状态）。
 * 接入服务端后，房间与牌局状态应以服务端为准，本模块可整体移除。
 */
const SNAP_PREFIX = 'poker_room_snap_';
const SNAP_TTL_MS = 24 * 60 * 60 * 1000;   // 超过 24 小时的快照视为过期

function key(roomNo) { return SNAP_PREFIX + roomNo; }

/** 写入快照（失败静默：快照只影响续局体验，不阻断主流程） */
function save(roomNo, snap) {
  if (!roomNo || !snap) return false;
  try {
    wx.setStorageSync(key(roomNo), Object.assign({ ts: Date.now() }, snap));
    return true;
  } catch (e) {
    return false;
  }
}

/** 读取快照；不存在或已过期返回 null（过期顺手清理） */
function load(roomNo) {
  if (!roomNo) return null;
  let snap = null;
  try { snap = wx.getStorageSync(key(roomNo)); } catch (e) { return null; }
  if (!snap || !snap.seats || !snap.seats.length) return null;
  if (!snap.ts || Date.now() - snap.ts > SNAP_TTL_MS) {
    clear(roomNo);
    return null;
  }
  return snap;
}

function clear(roomNo) {
  if (!roomNo) return;
  try { wx.removeStorageSync(key(roomNo)); } catch (e) {}
}

module.exports = { SNAP_PREFIX, SNAP_TTL_MS, save, load, clear };
