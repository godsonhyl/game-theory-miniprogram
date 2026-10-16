/**
 * 跨设备好友房同步（poker_room_seats 表）
 *
 * 模型：
 *   - 每个真人（房主 + 好友）在房间里占一行，RLS 只允许改自己的行；
 *   - 房主那一行的 state 字段承载房间公开状态：
 *       waiting  → { kind:'waiting', seats:[机器人座位] }
 *       playing  → { kind:'playing', snapshot, legal, seqBySeat, readyList, readyLeft, handNo }
 *   - 好友的动作写在自己行的 action 字段上行（{seq, type, ...}），
 *     房主每 1.5s 轮询消费，按「行座位分道」的 seq 消化，避免重复应用；
 *   - 好友的「准备就绪」写自己行的 ready_hand（存的是下一手手数，跨手天然自清理）；
 *   - 心跳 5s；超过 15s 无心跳视为离线，释放座位（房主端不会卡死）。
 *
 * 降级：云端表不可用（旧应用未建表 / 网络异常）时全部调用静默失败，
 * 上层回退到「本地引擎模拟」，不影响界面。
 *
 * ⚠️ 已知边界（hideHoles，评审 2026-10-15 议定封存）：state 里的 snapshot 含
 * 真人底牌（同房好友可读库看到）。评估过「广播前掩码底牌」的方案，不可行——
 * 房主端架构要求好友端看到自己的牌做本地渲染与合法性判断，掩码后无法恢复；
 * 按玩家或按 RLS 过滤字段需要服务端引擎逐玩家下发，属于服务端化改造的一部分。
 * 结论：此处加任何客户端开关都只是伪安全，故此封存，待服务端引擎一并解决；
 * 本实现解决的是「跨设备能一起打」，不是「不可见」。
 */
const { cloud } = require('./cloud');

const T_SEATS = 'poker_room_seats';

const SYNC = {
  POLL_MS: 1500,           // 房主轮询好友动作的间隔
  HEARTBEAT_MS: 5000,      // 心跳间隔
  OFFLINE_MS: 15000,       // 超过该时长无心跳视为离线，释放座位
  ACTION_TIMEOUT_SEC: 30,  // 远端好友行动超时：房主代弃牌，防卡死
  // 房主行存在但心跳僵死时，好友端再等的宽限时长；超时仍未恢复 → 房间判僵死退出
  HOST_STALE_EXIT_MS: 30000
};

/* ---------- 依赖注入（测试用内存库；默认走真实云端） ---------- */
let dbOverride = null;
function configure(opts) {
  dbOverride = (opts && opts.db) || null;
}
function db() {
  return dbOverride || cloud.database;
}

let seqSeed = Date.now();
function nextSeq() {
  seqSeed = Math.max(Date.now(), seqSeed + 1);
  return seqSeed;
}
function nowIso() { return new Date().toISOString(); }

/* ---------- 行级操作（RLS：只能改自己的行） ---------- */

/**
 * 更新自己的行；没有命中则插入（join / moveSeat / 心跳 / 动作上行共用）。
 * 云端不可用时抛错，由上层决定是否降级。
 *
 * 【同座位唯一性收敛】patch 带 seat 时，先把本用户在同房间、**其他座位**的行删掉。
 * 病根（用户 2026-10-16 反馈「有时候重入能看个两个自己」）：
 *   upsertMe 原本只 update「我的行」。一旦同一用户在这个房间留下了两条行
 *   （典型场景：房主从邀请链接重进被判成访客 → 换座到新座位 → 旧行仍在），
 *   update 会同时命中两条，两条都被搬到同一座位 → 云端出现重复行；
 *   buildWaitLayout 按 seat 取 live[0]，就只显示一个，但渲染层的
 *   renderAmbience / 座位环按 rows 逐条遍历时会渲染出两个「自己」。
 * 收敛后同一用户在同房间恒有且仅有一行。
 */
async function upsertMe(roomNo, patch) {
  if (!roomNo) throw new Error('房间号为空');
  // 座位唯一性：RLS 保证只能删自己的行，因此这条 delete 天然只清自己的残留。
  if (patch && patch.seat !== undefined && patch.seat !== null) {
    try {
      await db().from(T_SEATS)
        .delete()
        .eq('room_no', roomNo)
        .neq('seat', Number(patch.seat));
    } catch (e) {
      // 清理失败不阻断主流程：重复行的实际危害由下面的 buildWaitLayout 去重兜底。
      console.error('[room-sync] 清理同座位残留行失败', JSON.stringify({
        stage: 'upsert-dedupe', room: roomNo, seat: patch.seat,
        message: e && e.message
      }));
    }
  }
  const upd = await db().from(T_SEATS)
    .update(Object.assign({ heartbeat_at: nowIso() }, patch))
    .eq('room_no', roomNo)
    .select();
  if (upd.error) throw new Error(upd.error.message || '同步座位失败');
  if (Array.isArray(upd.data) && upd.data.length) return upd.data[0];

  const ins = await db().from(T_SEATS)
    .insert(Object.assign({ room_no: roomNo, heartbeat_at: nowIso() }, patch))
    .select()
    .single();
  if (ins.error) throw new Error(ins.error.message || '加入座位失败');
  return ins.data;
}

/** 入座（房主/好友首次进入房间时调用）。stack = 买入额，房主组局时按此发筹码 */
function join(roomNo, opts) {
  const o = opts || {};
  return upsertMe(roomNo, {
    seat: Number(o.seat) || 0,
    name: o.name || '',
    is_host: !!o.isHost,
    stack: Number(o.stack) || 0
  });
}

/** 换座 / 改买入额（开局前可随时改；RLS 保证只能改自己的行） */
function moveSeat(roomNo, seat, stack) {
  const patch = { seat: Number(seat) || 0 };
  if (stack !== undefined && stack !== null) patch.stack = Number(stack) || 0;
  return upsertMe(roomNo, patch);
}

/** 心跳（纯更新，没有自己的行时不做插入） */
async function heartbeat(roomNo) {
  const r = await db().from(T_SEATS)
    .update({ heartbeat_at: nowIso() })
    .eq('room_no', roomNo)
    .select();
  if (r.error) throw new Error(r.error.message || '心跳失败');
  return r.data || [];
}

/** 离开房间：删除自己的行，释放座位 */
async function leave(roomNo) {
  const r = await db().from(T_SEATS)
    .delete()
    .eq('room_no', roomNo);
  if (r.error) throw new Error(r.error.message || '离座失败');
  return true;
}

/** 动作上行（好友 → 房主）：action 带自增 seq，房主按座位分道消化 */
function pushAction(roomNo, action) {
  return upsertMe(roomNo, {
    action: Object.assign({ seq: nextSeq(), ts: Date.now() }, action || {})
  });
}

/** 房主广播房间公开状态（写在自己行的 state 字段） */
function publishState(roomNo, state) {
  return upsertMe(roomNo, { state: state || null });
}

/** 好友标记「准备就绪」：存下一手手数，跨手天然自清理 */
function markReadyRow(roomNo, readyHand) {
  return upsertMe(roomNo, { ready_hand: Number(readyHand) || 0 });
}

/** 读取房间全部行（好友/房主都能读，RLS 对 select 放开同房可读） */
async function poll(roomNo) {
  const r = await db().from(T_SEATS)
    .select('*')
    .eq('room_no', roomNo)
    .order('seat', { ascending: true });
  if (r.error) throw new Error(r.error.message || '读取房间座位失败');
  return r.data || [];
}

/* ---------- 纯函数（不碰库，供单测与上层共用） ---------- */

/** 行的心跳时间 → ms；缺失/非法返回 0（视为离线） */
function heartbeatMs(row) {
  const hb = row && row.heartbeat_at;
  if (!hb) return 0;
  const t = new Date(hb).getTime();
  return isNaN(t) ? 0 : t;
}

/** 是否在线（心跳在 OFFLINE_MS 内） */
function isOnline(row, nowMs) {
  const hb = heartbeatMs(row);
  return hb > 0 && (nowMs - hb) <= SYNC.OFFLINE_MS;
}

/** 过滤离线行，按座位排序 */
function activeSeats(rows, nowMs) {
  const now = nowMs || Date.now();
  return (rows || []).filter(r => isOnline(r, now)).sort((a, b) => (a.seat || 0) - (b.seat || 0));
}

/** 找房主行 */
function hostRow(rows) {
  return (rows || []).filter(r => r.is_host)[0] || null;
}

/** 取房主广播的房间公开状态 */
function hostStateOf(rows) {
  const h = hostRow(rows);
  return (h && h.state) || null;
}

/**
 * 取出待消费的好友动作：按行携带的 seat 分道、各道按 seq 升序全局排列。
 *
 * seq 只用于「同一行内」区分新旧动作（每行只有一列 action 槽，新动作覆盖旧的），
 * 不再作为房主端的单一全局水位——设备间时钟偏差会让慢钟好友的动作被
 * 全局 appliedSeq 永久跳过。跨行排序仅决定消费展示顺序，消化与否只看
 * 行内 seq 是否大于该行已应用的 seq。
 * 每条动作都绑定来源行自己的座位（rowSeat），不信任 payload 里的 seat。
 *
 * @param {Array} rows 房间全部行
 * @param {Object<string,number>} appliedSeqBySeat 每个座位已应用的最高 seq
 * @returns {{actions: Array<{...action, rowSeat: number}>, nextBySeat: Object}} nextBySeat 只含本轮有消费的座位
 */
function pendingActions(rows, appliedSeqBySeat) {
  const applied = appliedSeqBySeat || {};
  const actions = [];
  const nextBySeat = {};
  (rows || []).forEach(r => {
    const a = r.action;
    if (!a || typeof a !== 'object') return;
    const rowSeat = Number(r.seat);
    const seq = Number(a.seq) || 0;
    if (!(seq > (Number(applied[rowSeat]) || 0))) return;   // 该行无新动作
    actions.push(Object.assign({}, a, { rowSeat }));
    nextBySeat[rowSeat] = seq;
  });
  actions.sort((a, b) => a.seq - b.seq);
  return { actions, nextBySeat };
}

/** 已准备到下一手的座位集合（ready_hand === nextHandNo 且在线） */
function readySeats(rows, nextHandNo, nowMs) {
  const now = nowMs || Date.now();
  const set = {};
  activeSeats(rows, now).forEach(r => {
    if (Number(r.ready_hand) === Number(nextHandNo)) set[r.seat] = true;
  });
  return set;
}

/**
 * 合并等待室座位布局（房主与好友共用）：
 *   真人身位来自各自的行（在线才算占座），机器人与房主身位来自房主广播的 state.seats。
 * @returns {Array<{seat, occupied, name, isHost, isBot, isMe}>}
 */
function buildWaitLayout(rows, hostState, maxSeats, mySeat, nowMs) {
  const now = nowMs || Date.now();
  const live = activeSeats(rows, now);
  /**
   * 同座位去重：同一座位若有**多条**在线行（历史残留 / 并发写竞争），
   * 只认一条，否则牌桌会渲染出两个相同的人（用户反馈「重入能看个两个自己」）。
   * 保留规则：优先自己的行，其次房主行，最后 seat 最小的一条（保证确定性）。
   */
  const liveBySeat = {};
  live.forEach(r => {
    const s = Number(r.seat);
    const cur = liveBySeat[s];
    if (!cur) { liveBySeat[s] = r; return; }
    const rank = (x) => (Number(x.seat) === Number(mySeat) ? 2 : (x.is_host ? 1 : 0));
    if (rank(r) > rank(cur)) liveBySeat[s] = r;
  });
  const broadcast = (hostState && hostState.kind === 'waiting' && Array.isArray(hostState.seats)) ? hostState.seats : [];
  const out = [];
  for (let i = 0; i < maxSeats; i++) {
    const row = liveBySeat[i];
    const bc = broadcast.filter(s => Number(s.seat) === i)[0];
    const occupied = !!row || !!bc;
    out.push({
      seat: i,
      occupied,
      name: row ? (row.name || '玩家') : (bc ? (bc.name || '') : ''),
      isHost: !!row && !!row.is_host,
      isOwner: !!row && !!row.is_host,   // 与本地布局字段对齐（WXML 用 isOwner 显示「房主」标）
      isBot: !row && !!bc && bc.kind === 'bot',
      isMe: !!row && Number(row.seat) === Number(mySeat),
      // 买入额：0 表示未指定（上层回落到默认买入）。机器人为 0。
      stack: (row && Number(row.stack)) || 0
    });
  }
  return out;
}

module.exports = {
  T_SEATS, SYNC, configure,
  join, moveSeat, heartbeat, leave, pushAction, publishState, markReadyRow, poll,
  isOnline, activeSeats, hostRow, hostStateOf, pendingActions, readySeats, buildWaitLayout
};
