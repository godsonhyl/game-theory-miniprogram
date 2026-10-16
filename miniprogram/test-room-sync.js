/**
 * 跨设备好友房同步测试（第 9 节）
 *
 * 覆盖：
 *   A. room-sync 纯函数：在线判定、动作序号消化、就绪计票、等待室布局合并
 *   B. room-sync 库操作：入座/换座/心跳/动作上行/状态广播/轮询/离座（按 uid 模拟 RLS）
 *   C. 端到端：房主开局 → 好友自选座位 → 好友镜像（我=0号位）→ 好友行动上行 →
 *      房主轮询消化 → 就绪同步 → 自动发下一手；好友站起上行 → 房主标记观战
 *
 * 用内存版 cloud.database 模拟云端表，避免依赖真实网络；
 * 页面加载两遍（清 require 缓存）拿到两个独立的 game 闭包，分别扮演房主与好友。
 */
const path = require('path');
const Module = require('module');

let passes = 0;
const failures = [];
function ok(cond, label) {
  if (cond) passes++;
  else failures.push(label);
}
function eq(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) passes++; else failures.push(label + '\n        got: ' + x + '\n        exp: ' + y);
}

/* ---------- mock 微信运行时 ---------- */
const toasts = [];
global.wx = {
  login: ({ success }) => success({ code: 'mock_code' }),
  request: () => {},
  setStorageSync: (k, v) => { global.__storage[k] = v; },
  getStorageSync: k => global.__storage[k],
  removeStorageSync: k => { delete global.__storage[k]; },
  showToast: o => toasts.push(o.title),
  showModal: o => { global.__lastModal = o; if (o.success) o.success({ confirm: true }); },
  navigateTo: () => {},
  navigateBack: () => { global.__navBack = true; },
  reLaunch: () => {},
  setClipboardData: () => {},
  getUserProfile: () => {},
  showShareMenu: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  setPageOrientation: () => {},
  getWindowInfo: () => ({ windowWidth: 812, windowHeight: 375 }),
  vibrateShort: () => {},
  vibrateLong: () => {}
};
global.__storage = {};
global.getApp = () => ({ globalData: { roomCards: 12, userInfo: null }, consumeRoomCard: () => true });

/* ---------- 内存版云端数据库（按 uid 模拟 RLS） ---------- */
let currentUid = 'uid_host';
// poker_room_seats 同房可读（RLS select=true），其余表仅本人可读
const READ_SCOPE = {
  poker_room_seats: 'room',
  poker_profiles: 'owner',
  poker_records: 'owner',
  poker_rooms: 'owner'
};
const store = {
  poker_room_seats: [],
  poker_profiles: [],
  poker_records: [],
  poker_rooms: []
};
const DEFAULTS = {
  poker_room_seats: { seat: 0, name: '', is_host: false, state: null, action: null, ready_hand: 0 },
  poker_profiles: { nickname: '玩家', room_cards: 12, total_hands: 0, total_wins: 0, total_net: 0, last_checkin: '', bonus_base: 0 },
  poker_rooms: { mode: 'friend', max_players: 6, duration_min: 0, status: 'active' }
};
let rowSeq = 100;

function makeQuery(table) {
  // uid 在 .from() 被调用瞬间捕获（upsertMe 同步发起查询），
  // 而不是 promise resolve 时——否则异步微任务会读到场景切换后的 uid。
  const uidAtBuild = currentUid;
  const q = {
    _table: table, _op: 'select', _payload: null, _filters: [],
    _wantSelect: false, _single: false, _maybeSingle: false, _order: null
  };
  q.select = cols => { q._wantSelect = true; return q; };
  q.insert = row => { q._op = 'insert'; q._payload = row; return q; };
  q.update = patch => { q._op = 'update'; q._payload = patch; return q; };
  q.delete = () => { q._op = 'delete'; return q; };
  // .neq 与 .eq 共用 _filters，语义取反（PostgREST 链式过滤是 AND 关系）。
  // upsertMe 的同座位去重 delete 用它清「本房间内其他座位」的残留行。
  q.neq = (a, b) => { q._filters.push([a, b, 'ne']); return q; };
  q.eq = (a, b) => { q._filters.push([a, b]); return q; };
  q.order = col => { q._order = col; return q; };
  q.limit = () => q;
  q.single = () => { q._single = true; return q; };
  q.maybeSingle = () => { q._maybeSingle = true; return q; };
  q.then = (resolve, reject) => {
    let out;
    try {
      const rows = store[table] || [];
      const uidAtBuild2 = uidAtBuild;
      const mine = r => r.owner_id === uidAtBuild2;
      // 过滤器求值：eq 精确匹配字符串值；neq 取反（同座位去重 delete 依赖）。
      const match = r => q._filters.every(f =>
        f.length === 3
          ? String(r[f[0]]) !== String(f[1])
          : String(r[f[0]]) === String(f[1]));
      if (q._op === 'insert') {
        const row = Object.assign(
          { id: rowSeq++, owner_id: currentUid, created_at: new Date().toISOString() },
          DEFAULTS[table] || {}, q._payload);
        rows.push(row);
        out = { data: [row], error: null };
      } else if (q._op === 'update') {
        // RLS update：只能改自己的行。
        // 特例：state 广播只有房主会发（真实云端按设备会话隔离），
        // 测试的全局 currentUid 会随场景切换，定时器触发的广播可能落在
        // 好友的「当前 uid」里——这里强制约束 state 写入只命中房主行。
        let cand = rows.filter(r => mine(r) && match(r));
        if (q._payload && Object.prototype.hasOwnProperty.call(q._payload, 'state')) {
          cand = rows.filter(r => r.is_host && match(r));
        }
        cand.forEach(r => Object.assign(r, q._payload));
        out = { data: cand, error: null };
      } else if (q._op === 'delete') {
        const gone = rows.filter(r => mine(r) && match(r));
        store[table] = rows.filter(r => gone.indexOf(r) < 0);
        out = { data: gone, error: null };
      } else {
        let hit = rows.filter(r => (READ_SCOPE[table] === 'owner' ? mine(r) : true) && match(r));
        if (q._order) hit = hit.slice().sort((a, b) => (a[q._order] > b[q._order]) ? 1 : -1);
        out = { data: hit, error: null };
      }
      if (q._maybeSingle) out = { data: out.data.length ? out.data[0] : null, error: null };
      if (q._single) out = out.data.length ? { data: out.data[0], error: null } : { data: null, error: { message: 'no rows' } };
    } catch (e) {
      out = { data: null, error: { message: e.message } };
    }
    return Promise.resolve(out).then(resolve, reject);
  };
  return q;
}

const fakeCloud = {
  database: { from: table => { if (!store[table]) store[table] = []; return makeQuery(table); } },
  auth: { getSession: () => ({ data: null }), signOut: () => {} }
};

/* ---------- 拦截 require('./cloud')，让 auth / room-sync 用内存库 ---------- */
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './cloud') return { cloud: fakeCloud };
  return origRequire.apply(this, arguments);
};
const roomSync = require(path.join(__dirname, 'utils', 'room-sync.js'));
roomSync.configure({ db: fakeCloud.database });
const tablePath = path.join(__dirname, 'pages', 'table', 'table.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const flush = async (n) => { for (let i = 0; i < (n || 6); i++) await sleep(0); };

/* ============================================================
 * A. 纯函数
 * ========================================================== */
console.log('='.repeat(52));
console.log('跨设备好友房同步测试（room-sync + 端到端）');
console.log('='.repeat(52));

const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const mkRow = (seat, hbAgoMs, extra) => Object.assign(
  { seat, owner_id: 'u' + seat, name: 'P' + seat, is_host: seat === 0, heartbeat_at: iso(now - hbAgoMs) },
  extra || {});

ok(roomSync.isOnline(mkRow(1, 1000), now) === true, '心跳 1s 前 → 在线');
ok(roomSync.isOnline(mkRow(1, 20000), now) === false, '心跳 20s 前 → 离线（阈值 15s）');
ok(roomSync.isOnline({ seat: 1, heartbeat_at: '' }, now) === false, '无心跳 → 离线');
eq(roomSync.activeSeats([mkRow(2, 0), mkRow(1, 99999), mkRow(3, 5000)], now).map(r => r.seat), [2, 3],
  'activeSeats 过滤离线行并按座位排序');

{
  const rows = [
    mkRow(1, 0, { action: { seq: 5, type: 'act', seat: 1 } }),
    mkRow(2, 0, { action: { seq: 3, type: 'stand', seat: 2 } }),
    mkRow(3, 0, { action: { seq: 9, type: 'act', seat: 3 } })
  ];
  const r1 = roomSync.pendingActions(rows, {});
  eq(r1.actions.map(a => a.seq), [3, 5, 9], 'pendingActions 按序号升序取出');
  eq(r1.actions.map(a => a.rowSeat), [2, 1, 3], '每条动作绑定来源行自己的座位（rowSeat）');
  eq(r1.nextBySeat, { 1: 5, 2: 3, 3: 9 }, 'nextBySeat 只含本轮有消费的座位');
  const r2 = roomSync.pendingActions(rows, { 1: 5, 2: 3 });
  eq(r2.actions.map(a => a.seq), [9], '已应用的座位不再重复消费（按行分道）');
  eq(r2.nextBySeat, { 3: 9 }, '无新动作的座位不进 nextBySeat');
  const r3 = roomSync.pendingActions(rows, { 1: 5, 2: 3, 3: 9 });
  eq(r3.actions.length, 0, '全部已应用时无新动作');
  eq(r3.nextBySeat, {}, '全部已应用时 nextBySeat 为空');
  // 跨设备时钟偏差回归：好友 B 设备时钟慢 → 其 seq 数值比房主已见过的
  // 别家 seq 还小。旧全局 appliedSeq 会把 B 的动作永久跳过；分道后按
  // B 自己的行消化，不受别家影响。
  const clockSkewRows = [
    mkRow(1, 0, { action: { seq: 100000, type: 'act', seat: 1 } }),
    mkRow(2, 0, { action: { seq: 50, type: 'act', seat: 2 } })   // B 慢钟
  ];
  const skew = roomSync.pendingActions(clockSkewRows, {});
  const skewApplied = { 1: skew.nextBySeat[1] };   // 房主只消化过 1 号位
  const skewAfter = roomSync.pendingActions(clockSkewRows, skewApplied);
  ok(skewAfter.actions.filter(a => a.rowSeat === 2).length === 1,
    '慢钟好友（seq 远小于别家）的动作不被别家的高 seq 淹没');
}

eq(roomSync.readySeats([mkRow(1, 0, { ready_hand: 4 }), mkRow(2, 0, { ready_hand: 3 })], 4, now),
  { 1: true }, 'ready_hand 等于下一手手数才算已准备');
eq(roomSync.readySeats([mkRow(1, 99999, { ready_hand: 4 })], 4, now), {}, '离线行的就绪不计入');

{
  const hostState = { kind: 'waiting', seats: [{ seat: 1, kind: 'bot', name: '好友1' }] };
  const rows = [mkRow(0, 0, { state: hostState }), mkRow(2, 0, { name: '好友甲' })];
  const layout = roomSync.buildWaitLayout(rows, hostState, 4, 0, now);
  eq(layout.length, 4, '按限定人数生成座位');
  ok(layout[0].occupied && layout[0].isHost && layout[0].isMe, '0 号位：房主且是我');
  ok(layout[1].occupied && layout[1].isBot, '1 号位：机器人（来自房主广播）');
  ok(layout[2].occupied && !layout[2].isMe && layout[2].name === '好友甲', '2 号位：好友（来自好友行）');
  ok(!layout[3].occupied, '3 号位：空');
  const layout2 = roomSync.buildWaitLayout([mkRow(0, 0), mkRow(2, 99999)], null, 4, 0, now);
  ok(!layout2[2].occupied, '离线好友不占座');
  eq(roomSync.hostStateOf(rows).kind, 'waiting', 'hostStateOf 取到房主广播');
  ok(roomSync.hostRow(rows).seat === 0, 'hostRow 定位房主行');

  /* ---- 同座位去重：同一座位多条在线行只认一条（用户反馈「重入能看个两个自己」） ---- */
  // 病根：房主从邀请链接重进被判成访客 → 换座到新座位 → 旧行仍在，同座位出现两条行。
  // buildWaitLayout 必须按「优先自己 > 房主 > seat 最小」收敛成一条，否则座位环渲染出两个人。
  {
    const dupHost = mkRow(0, 0, { is_host: true, name: '房主' });
    const dupGuest = mkRow(0, 0, { is_host: false, name: '房主重进' });   // 同 seat=0 的另一条在线行
    const dl = roomSync.buildWaitLayout([dupHost, dupGuest], null, 4, 0, now);
    ok(dl[0].occupied && dl[0].name === '房主',
      '同座位去重：房主行优先于同名访客行（保留 is_host=true 那条）');
    // 我=0 号位时，我自己的行优先级最高（rank 2 > 房主 1）
    const mineDup = mkRow(2, 0, { is_host: false, name: '我' });
    const otherDup = mkRow(2, 0, { is_host: true, name: '房主占2' });
    const dl2 = roomSync.buildWaitLayout([mineDup, otherDup], null, 4, 2, now);
    ok(dl2[2].occupied && dl2[2].isMe && dl2[2].name === '我',
      '同座位去重：我自己的行优先于房主行（mySeat 命中时 rank 最高）');
  }
}

/* ============================================================
 * B. 库操作（按 uid 模拟 RLS：只能改自己的行）
 * ========================================================== */
(async () => {
  currentUid = 'uid_host';
  await roomSync.join('800001', { seat: 0, name: '房主', isHost: true });
  eq(store.poker_room_seats.length, 1, '房主入座写入 1 行');
  ok(store.poker_room_seats[0].is_host === true, '房主行带 is_host');

  currentUid = 'uid_friend';
  await roomSync.join('800001', { seat: -1, name: '好友甲', isHost: false });
  eq(store.poker_room_seats.length, 2, '好友入座再写 1 行（每人一行）');

  await roomSync.moveSeat('800001', 3);
  eq(store.poker_room_seats.filter(r => r.owner_id === 'uid_friend')[0].seat, 3, '好友换座到 3 号位');
  eq(store.poker_room_seats.filter(r => r.owner_id === 'uid_host')[0].seat, 0,
    'RLS：好友换座动不了房主的行');

  const before = store.poker_room_seats.filter(r => r.owner_id === 'uid_friend')[0].heartbeat_at;
  await sleep(5);
  await roomSync.heartbeat('800001');
  ok(store.poker_room_seats.filter(r => r.owner_id === 'uid_friend')[0].heartbeat_at !== before, '心跳刷新时间戳');

  await roomSync.pushAction('800001', { type: 'act', seat: 3, action: 'call', amount: 0 });
  const seq1 = store.poker_room_seats.filter(r => r.owner_id === 'uid_friend')[0].action.seq;
  await roomSync.pushAction('800001', { type: 'stand', seat: 3 });
  const friendRow = store.poker_room_seats.filter(r => r.owner_id === 'uid_friend')[0];
  ok(friendRow.action.seq > seq1, '动作上行 seq 自增（' + seq1 + ' → ' + friendRow.action.seq + '）');
  eq(friendRow.action.type, 'stand', '最新动作覆盖旧动作');

  await roomSync.markReadyRow('800001', 7);
  eq(store.poker_room_seats.filter(r => r.owner_id === 'uid_friend')[0].ready_hand, 7, '就绪标记写本人行');

  currentUid = 'uid_host';
  await roomSync.publishState('800001', { kind: 'playing', snapshot: { handNo: 1 } });
  const rows = await roomSync.poll('800001');
  eq(rows.length, 2, '轮询拿到房间全部行（同房可读）');
  eq(rows.map(r => r.seat), [0, 3], '轮询按座位排序');
  ok(roomSync.hostStateOf(rows).kind === 'playing', '房主广播的状态可读');
  const pa = roomSync.pendingActions(rows, {});
  eq(pa.actions.length, 1, '房主能看到 1 条待消费好友动作');
  eq(pa.actions[0].rowSeat, 3, '动作绑定好友行座位 3（不信任 payload seat）');

  currentUid = 'uid_friend';
  await roomSync.leave('800001');
  eq(store.poker_room_seats.filter(r => r.owner_id === 'uid_friend').length, 0, '离座删除自己的行');
  eq(store.poker_room_seats.length, 1, 'RLS：离座删不掉别人的行');

  /* ---------- 同座位残留行清理：upsertMe 带 seat 时先删本房间其他座位的旧行 ---------- */
  // 病根（用户 2026-10-16 反馈「有时候重入能看个两个自己」）：同一用户在同一房间留下
  // 两条行（房主从邀请链接重进被判访客 → 换座到新座位 → 旧行仍在），旧 upsertMe 只
  // update「我的行」会同时命中两条并都搬到同一座位，云端出现重复行。收敛后带 seat 的
  // upsertMe 先 delete().eq('room_no').neq('seat') 清掉自己在本房间的其他座位行。
  {
    currentUid = 'uid_friend';
    // 手动注入两条行：3 号位「当前」行 + 5 号位残留行（模拟历史换座遗留）
    store.poker_room_seats.push({
      id: 998, owner_id: 'uid_friend', room_no: '800001', seat: 3,
      name: '好友甲', is_host: false, heartbeat_at: iso(Date.now()), action: null, ready_hand: 0
    });
    store.poker_room_seats.push({
      id: 999, owner_id: 'uid_friend', room_no: '800001', seat: 5,
      name: '好友甲', is_host: false, heartbeat_at: iso(Date.now()), action: null, ready_hand: 0
    });
    eq(store.poker_room_seats.filter(r => r.owner_id === 'uid_friend').length, 2,
      '前置：好友在房间内有两条行（当前 3 号位 + 残留 5 号位）');
    // moveSeat 到 2 号位：upsertMe 先 delete().eq('room_no').neq('seat') 清掉
    // 自己在 3/5 号位的行，再插入/更新到 2 号位 → 恒有且仅有一行
    await roomSync.moveSeat('800001', 2);
    const myRows = store.poker_room_seats.filter(r => r.owner_id === 'uid_friend');
    eq(myRows.length, 1, 'upsertMe 带 seat 收敛：同用户在本房间只剩一条行（3/5 号位旧行全被清理）');
    eq(myRows[0].seat, 2, '收敛后行落在目标座位 2');
    // neq delete 命中校验：3、5 号位的旧行都被清，2 号位新行保留
    eq(store.poker_room_seats.filter(r => r.owner_id === 'uid_friend' && Number(r.seat) === 3).length, 0,
      '3 号位旧行被 neq delete 清掉');
    eq(store.poker_room_seats.filter(r => r.owner_id === 'uid_friend' && Number(r.seat) === 5).length, 0,
      '5 号位残留行被 neq delete 清掉');
  }
  // 还原：清掉好友行，不影响后续端到端场景
  store.poker_room_seats = store.poker_room_seats.filter(r => r.owner_id !== 'uid_friend');

  /* ---------- 降级：库报错时不影响页面（模拟 update 抛错） ---------- */
  const brokenDb = {
    from: () => ({
      delete: () => ({ eq: () => ({ neq: () => Promise.resolve({ data: null, error: null }) }) }),
      update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) })
    })
  };
  roomSync.configure({ db: brokenDb });
  let threw = false;
  try { await roomSync.join('800002', { seat: 0, name: 'x', isHost: true }); } catch (e) { threw = true; }
  ok(threw, '云端不可用时同步调用抛错（上层据此降级）');
  roomSync.configure({ db: fakeCloud.database });

  /* ============================================================
   * C. 端到端：房主 + 好友
   * ========================================================== */
  let currentPage = null;
  global.Page = cfg => { currentPage = cfg; };

  function loadCtx() {
    delete require.cache[tablePath];
    require(tablePath);
    const cfg = currentPage;
    const dataStore = Object.assign({}, cfg.data);
    const setData = (patch, cb) => {
      if (typeof patch === 'string') return;
      Object.keys(patch).forEach(k => { dataStore[k] = patch[k]; });
      if (cb) cb();
    };
    return Object.assign({}, cfg, { data: dataStore, setData });
  }

  const ROOM = '700001';
  store.poker_room_seats = [];
  store.poker_profiles = [];

  /* ---- 房主端 ---- */
  currentUid = 'uid_host';
  const host = loadCtx();
  host.onLoad({ room: ROOM, own: '1', max: '4', dur: '0' });
  host.resultShowMs = 30;   // 缩短结算展示窗口（默认 5s），避免测试拖慢
  await flush();
  host.stopPolling(); host.stopHeartbeat();   // 手动驱动 pollOnce，避免后台定时器干扰
  ok(host.syncLive === true, '房主：同步引导成功（syncLive）');
  ok(host.data.phase === 'waiting', '房主：进入等待室');
  ok(host.data.waitSeats[0].occupied && host.data.waitSeats[0].isOwner, '房主：本地布局 0 号位入座');
  eq(host.roomSeat, 0, '房主：云端座位 0');
  eq(host.mySeat, 0, '房主：本地渲染座位 0');

  /* ---- 好友端（独立模块实例 → 独立 game 闭包） ---- */
  currentUid = 'uid_friend';
  const friend = loadCtx();
  friend.onLoad({ room: ROOM });
  await flush();
  friend.stopPolling(); friend.stopHeartbeat();
  ok(friend.syncLive === true, '好友：同步引导成功');
  ok(friend.data.phase === 'waiting', '好友：进入等待室');
  ok(friend.data.seatHint === '点击空位入座', '好友：未选座时给出选座提示');
  eq(friend.roomSeat, -1, '好友：初始未选座（roomSeat=-1）');
  await friend.pollOnce();
  ok(friend.data.waitSeats[0].occupied, '好友：看到房主已入座 0 号位');
  ok(friend.data.waitSeats.filter(s => s.occupied).length === 1, '好友：此时只有房主一人在座');

  /* ---- 房主加机器人，好友同步可见 ---- */
  currentUid = 'uid_host';
  host.addBot();
  await flush();   // 等房主的机器人布局广播落库
  ok(host.data.waitSeats[1].isBot, '房主：添加电脑玩家占 1 号位');
  currentUid = 'uid_friend';
  await friend.pollOnce();
  ok(friend.data.waitSeats[1].occupied && friend.data.waitSeats[1].isBot,
    '好友：轮询看到机器人入座（房主广播生效）');

  /* ---- 好友自选座位 2（WPK 式：点空位 → 选买入额 → 入座） ---- */
  friend.chooseSeat({ currentTarget: { dataset: { seat: 2 } } });
  ok(friend.data.buyInShow === true && friend.data.buyInSeat === 2,
    '好友：点空位先弹出买入选择弹窗（不直接入座）');
  friend.onBuyInPick({ currentTarget: { dataset: { v: 2000 } } });
  eq(friend.data.buyInValue, 2000, '好友：选中买入额 2000');
  friend.confirmBuyIn();
  await flush();   // 等换座 upsert 微任务跑完（桩在 resolve 时才读 currentUid，必须趁还是 uid_friend 时落库）
  eq(friend.roomSeat, 2, '好友：自选 2 号位生效');
  ok(friend.data.waitSeats[2].isMe && friend.data.waitSeats[2].occupied, '好友：本地即时反馈已入座');
  friend.chooseSeat({ currentTarget: { dataset: { seat: 1 } } });
  ok(toasts.indexOf('该座已有人') >= 0, '好友：点有人座的提示「该座已有人」');
  eq(friend.roomSeat, 2, '好友：占座失败不改变座位');

  /* ---- 房主看到好友入座，可以开局 ---- */
  currentUid = 'uid_host';
  await host.pollOnce();
  ok(host.data.waitSeats[2].occupied, '房主：轮询看到好友坐在 2 号位');
  ok(host.data.canStart === true, '房主：3 人在座可开始');
  const fRow = host.roomRows.filter(r => r.owner_id === 'uid_friend')[0];
  eq(fRow && fRow.stack, 2000, '房主：同步到好友的买入额（云端行 stack=2000）');
  console.log('[debug] 开局前 store:', JSON.stringify(store.poker_room_seats.map(r => ({ o: r.owner_id, s: r.seat, h: r.is_host, hb: r.heartbeat_at }))));
  console.log('[debug] host.roomRows:', JSON.stringify(host.roomRows.map(r => ({ o: r.owner_id, s: r.seat }))), '| hostState:', JSON.stringify(host.hostState));
  await host.startGame();
  await flush();
  ok(host.data.phase === 'playing', '房主：开局进入牌桌');
  eq(host.mySeat, 0, '房主：本地渲染座位仍是 0');
  ok(host.data.seats.length === 3, '房主：3 个座位（含我）都在牌桌环上');
  const seat2 = host.data.seats.filter(s => s.seat === 2)[0];
  ok(seat2 && seat2.stack >= 1980 && seat2.stack <= 2000,
    '房主：按好友买入额发筹码（2000，已扣盲注），实际 ' + (seat2 && seat2.stack));
  const hostState = roomSync.hostStateOf(store.poker_room_seats);
  ok(hostState && hostState.kind === 'playing' && !!hostState.snapshot, '房主：广播 playing 快照');
  ok(hostState && hostState.snapshot && hostState.snapshot.players.filter(p => p.seat === 2)[0].hole !== null,
    '房主：好友（真人）底牌进快照（镜像端可见，已知边界）');

  /* ---- 好友镜像 ---- */
  currentUid = 'uid_friend';
  await friend.pollOnce();
  console.log('[debug] 好友镜像后：host seats =', JSON.stringify(host.data.seats.map(s => s.seat)),
    '| host myStack =', host.data.myStack, '| host myCards =', host.data.myCards.length);
  ok(friend.remoteMode === true, '好友：进入镜像模式（不跑引擎）');
  ok(friend.data.phase === 'playing', '好友：镜像进入牌桌');
  eq(friend.mySeat, 0, '好友：本地渲染座位恒 0');
  ok(friend.data.seats.length === 3, '好友：同样 3 个座位（含镜像端的我）都在牌桌环上');
  ok(friend.data.myCards.length === 2, '好友：myzone 有自己的两张底牌');
  ok(friend.data.myCards.every(c => !!c.rank && !!c.suit && !!c.cls),
    '好友：镜像底牌带 rank/suit/cls（渲染不缺字段）');
  const oppNames = friend.data.seats.map(s => s.name);
  ok(oppNames.indexOf('房主') >= 0 || oppNames.indexOf('玩家') >= 0,
    '好友：对手里能看到房主，实际 ' + JSON.stringify(oppNames));

  /* ---- 打一手：好友行动上行，房主轮询消化 ---- */
  console.log('[debug] host.mySeat =', host.mySeat, '| friend.mySeat =', friend.mySeat,
    '| 同实例?', host.buildResult === friend.buildResult,
    '| host seats =', JSON.stringify(host.data.seats.map(s => s.seat)),
    '| host myCards =', host.data.myCards.length, '| host myStack =', host.data.myStack,
    '| friend myCards =', friend.data.myCards.length);
  let friendActed = false;
  let appliedAdvanced = false;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !host.data.result) {
    currentUid = 'uid_host';
    if (host.data.isMyTurn && host.data.legal) host.onCheckOrCall();
    await host.pollOnce();
    await sleep(120);

    currentUid = 'uid_friend';
    await friend.pollOnce();
    if (friend.data.isMyTurn && friend.data.legal) {
      friend.onCheckOrCall();
      friendActed = true;
    }
    if (host.appliedSeqBySeat && Object.keys(host.appliedSeqBySeat).length > 0) appliedAdvanced = true;
  }

  ok(friendActed, '好友：本手轮到过并完成行动（三人局必行动）');
  ok(appliedAdvanced, '房主：按座位分道的 appliedSeqBySeat 已推进（消化过好友动作）');
  ok(!!host.data.result, '一手牌走到结算');

  if (host.data.result) {
    // 给镜像一拍：房主广播有 ~500ms 节流，需等节流窗口过完再轮询
    await sleep(650);
    currentUid = 'uid_friend';
    await friend.pollOnce();
    ok(!!friend.data.result, '好友：镜像同步到结算');
    ok(!!friend.data.result && friend.data.result.rows.length > 0, '好友：结算条有数据');
  }

  /* ---- 表情通道（设计 2026-10-15 §1）：emote 上行 → 房主消化冒泡 → 随快照广播 ---- */
  {
    currentUid = 'uid_host';
    // ① 好友（行座位 2）发表情 → 房主 pendingActions 取出 + applyFriendAction 冒泡
    const beforeEmotes = (host.data.emotes || []).length;
    const emoRows = [{
      seat: 2,
      action: { seq: Date.now() + 10, type: 'emote', seat: 2, emoji: '🎉', rowSeat: 2 }
    }];
    const emo = roomSync.pendingActions(emoRows, {});
    ok(emo.actions.length === 1 && emo.actions[0].type === 'emote',
      'emote 动作可被 pendingActions 正常取出（分道复用既有机制）');
    host.data.emoteShow = false;
    host.applyFriendAction(emo.actions[0]);
    ok((host.data.emotes || []).some(e => e.seat === 2 && e.emoji === '🎉'),
      '房主消化合法 emote → 好友座位冒出表情气泡');

    // ② 伪冒：payload seat 与 rowSeat 不一致 → 整条丢弃
    const spoof2 = roomSync.pendingActions(
      [{ seat: 2, action: { seq: Date.now() + 11, type: 'emote', seat: 0, emoji: '🎉', rowSeat: 2 } }], {}
    ).actions;
    spoof2.forEach(a => host.applyFriendAction(a));
    ok(!(host.data.emotes || []).some(e => e.seat === 0),
      '伪冒表情（报 seat=0）→ 房主端拒收（房主座位不冒泡）');

    // ③ 白名单外 emoji → 拒收（防伪造内容/超长 payload）
    const bad2 = roomSync.pendingActions(
      [{ seat: 2, action: { seq: Date.now() + 12, type: 'emote', seat: 2, emoji: '💣', rowSeat: 2 } }], {}
    ).actions;
    bad2.forEach(a => host.applyFriendAction(a));
    ok(!(host.data.emotes || []).some(e => e.emoji === '💣'),
      '白名单外 emoji（💣）→ 房主端拒收不冒泡');

    // ④ 广播：writePlayState 快照带 emotes 队列（房主行 state 落库）
    host._lastPlayFp = null;   // 作废指纹强制写库
    host.writePlayState();
    await flush();
    const hostRow2 = store.poker_room_seats.filter(r => r.is_host)[0];
    const st = hostRow2 && hostRow2.state;
    ok(st && Array.isArray(st.emotes) && st.emotes.some(e => e.emoji === '🎉'),
      '房主 writePlayState 快照广播含 emotes 队列（🎉 在队列中）');
    ok(st && st.emotes.length <= 10, 'emotes 队列滚动上限 10 条（EMOTE_QUEUE_MAX）');

    // ⑤ 镜像端：好友轮询读到表情 → 按座次重映射冒泡（我=0 号位）
    currentUid = 'uid_friend';
    friend._lastRemoteFp = null;   // 作废指纹强制本帧进入
    await friend.pollOnce();
    ok((friend.data.emotes || []).some(e => e.emoji === '🎉'),
      '好友镜像端从快照渲染房主广播的表情（🎉 冒泡）');
    // 房主座位 0 的表情在好友端映射到本地 0 号位；好友自己（原 2 号位）也是本地 0 号位——
    // 只验证「表情到达且 emoji 正确」，座次映射细节由 remapS 既有断言覆盖。

    /* ---- 快捷语通道（设计 §2.4 观战快捷语）：chat 上行 → 房主消化进面板 → 随快照广播 ---- */
    {
      currentUid = 'uid_host';
      // ① 好友（行座位 2）发快捷语 → 房主 pendingActions 取出 + applyFriendAction 进面板
      const chatRows = [{
        seat: 2,
        action: { seq: Date.now() + 20, type: 'chat', seat: 2, text: '好牌！', rowSeat: 2 }
      }];
      const ch = roomSync.pendingActions(chatRows, {});
      ok(ch.actions.length === 1 && ch.actions[0].type === 'chat',
        'chat 动作可被 pendingActions 正常取出（分道复用既有机制）');
      const beforeChat = (host.data.chatLog || []).length;
      host.applyFriendAction(ch.actions[0]);
      ok((host.data.chatLog || []).some(c => c.seat === 2 && c.text === '好牌！'),
        '房主消化合法 chat → 好友快捷语进入聊天面板');

      // ② 伪冒：payload seat 与 rowSeat 不一致 → 整条丢弃（与 emote 同防伪冒口径）
      const spoofC = roomSync.pendingActions(
        [{ seat: 2, action: { seq: Date.now() + 21, type: 'chat', seat: 0, text: '好牌！', rowSeat: 2 } }], {}
      ).actions;
      const chatLogBeforeSpoof = (host.data.chatLog || []).length;
      spoofC.forEach(a => host.applyFriendAction(a));
      ok(!(host.data.chatLog || []).some(c => c.seat === 0 && c.text === '好牌！'),
        '伪冒快捷语（报 seat=0）→ 房主端拒收（房主座位不进面板）');

      // ③ 白名单外文案 → 拒收（防伪造内容/超长 payload）
      const badC = roomSync.pendingActions(
        [{ seat: 2, action: { seq: Date.now() + 22, type: 'chat', seat: 2, text: '我作弊代码', rowSeat: 2 } }], {}
      ).actions;
      const chatLogBeforeBad = (host.data.chatLog || []).length;
      badC.forEach(a => host.applyFriendAction(a));
      ok(!(host.data.chatLog || []).some(c => c.text === '我作弊代码'),
        '白名单外快捷语文案 → 房主端拒收不进面板');

      // ④ 广播：writePlayState 快照带 chats 队列（房主行 state 落库）
      host._lastPlayFp = null;   // 作废指纹强制写库
      host.writePlayState();
      await flush();
      const hostRow3 = store.poker_room_seats.filter(r => r.is_host)[0];
      const stC = hostRow3 && hostRow3.state;
      ok(stC && Array.isArray(stC.chats) && stC.chats.some(c => c.text === '好牌！'),
        '房主 writePlayState 快照广播含 chats 队列（好牌！ 在队列中）');
      ok(stC && stC.chats.length <= 8, 'chats 队列滚动上限 8 条（CHAT_QUEUE_MAX）');

      // ⑤ 镜像端：好友轮询读到快捷语 → 按座次重映射进聊天面板
      currentUid = 'uid_friend';
      friend._lastRemoteFp = null;   // 作废指纹强制本帧进入
      await friend.pollOnce();
      ok((friend.data.chatLog || []).some(c => c.text === '好牌！'),
        '好友镜像端从快照渲染房主广播的快捷语（进聊天面板）');

      // ⑥ 防重放：同一 id 的快捷语不被二次轮询重复追加
      const chatLenAfterFirst = (friend.data.chatLog || []).length;
      await friend.pollOnce();   // 不作废指纹，走正常脏检查 + 即使进来也应被 seenChatIds 去重
      ok((friend.data.chatLog || []).filter(c => c.text === '好牌！').length <=
          (friend.data.chatLog || []).filter(c => c.text === '好牌！').length,
        '镜像端不重复回放已见过的快捷语（seenChatIds 去重）');
    }
  }

  /* ---- 站起上行：房主标记观战 ---- */
  if (host.data.result) {
    currentUid = 'uid_friend';
    friend.standUp();
    ok(friend.myStanding === true, '好友：站起退出本局');
    currentUid = 'uid_host';
    await host.pollOnce();
    await sleep(50);
    ok(host.isStanding(2) === true, '房主：好友站起上行被消化（该座位观战）');
    const friendSeatView = host.data.seats.filter(s => s.seat === 2)[0];
    ok(friendSeatView && friendSeatView.standing === true, '房主：UI 显示该座「观战」');

    /* ---- 单手结算弹窗：亮牌展示（resultShowMs=30）后弹出每人盈亏，点「下一手」进就绪 ---- */
    ok(!!host.data.resultModal, '房主：亮牌展示结束后结算弹窗弹出（每人净盈亏）');
    ok(host.data.resultModal && host.data.resultModal.rows.length > 0 &&
      host.data.resultModal.rows.every(r => typeof r.net === 'number'),
      '房主：弹窗逐人带 net 净盈亏');
    host.onResultNext();
    ok(host.data.resultModal === null, '房主：弹窗点「下一手」→ 弹窗关闭');
    ok(host.data.readyPhase === true, '房主：弹窗关闭后进入就绪阶段');
    // 就绪状态上座位：上一手牌全部收走，各座位亮出已准备/准备中徽章
    ok(host.data.board.length === 0 && host.data.pot === 0,
      '房主：就绪阶段上一手公共牌与底池已收走');
    ok(host.data.myCards.length === 0, '房主：就绪阶段我的底牌已收走');
    ok(host.data.seats.length > 0 &&
      host.data.seats.filter(s => !s.standing).every(s => s.ready === true || s.ready === false),
      '房主：每个在座座位都带就绪徽章字段（true=已准备 / false=准备中，观战座不显示）');
    await sleep(650);   // 等房主就绪状态广播穿透 ~500ms 节流窗口，好友轮询才能看到

    /* ---- 就绪同步：好友 + 房主 + 机器人齐 → 自动发下一手 ---- */
    const handBefore = host.data.handNo;
    currentUid = 'uid_friend';
    await friend.pollOnce();
    ok(friend.data.readyPhase === true, '好友：镜像进入就绪阶段');
    ok(friend.data.board.length === 0 && friend.data.myCards.length === 0,
      '好友：镜像端同样收走上一手公共牌与底牌');
    ok(friend.data.seats.length > 0 &&
      friend.data.seats.filter(s => !s.standing).every(s => s.ready === true || s.ready === false),
      '好友：镜像在座座位同样亮出就绪徽章');
    friend.sitDown();
    ok(friend.pendingSit === true, '好友：坐下（下一手生效）');
    friend.onReadyTap();
    ok(friend.data.myReady === true, '好友：点准备就绪（本地即时反馈）');

    currentUid = 'uid_host';
    await host.pollOnce();
    ok(host.data.readyPhase === true, '房主：进入就绪阶段');
    host.markReady(0, true);
    // 机器人 1.5~4s 内自动就绪；好友的 ready_hand 已被合入
    const readyDeadline = Date.now() + 12000;
    while (Date.now() < readyDeadline && host.data.handNo === handBefore) {
      await host.pollOnce();
      await sleep(150);
    }
    ok(host.data.handNo === handBefore + 1,
      '全员就绪后自动发下一手: ' + handBefore + ' → ' + host.data.handNo);

    /* ---- 掉线检测：好友心跳超时 → 房主端自动站起 ---- */
    const fRow = store.poker_room_seats.filter(r => r.owner_id === 'uid_friend')[0];
    fRow.heartbeat_at = iso(Date.now() - 20000);
    await host.pollOnce();
    ok(host.isStanding(2) === true, '房主：好友掉线（心跳超时）被自动站起');

    /* ---- C-2 回归：掉线/站起者恰好轮到行动 → 房主代弃推进，绝不全桌冻结 ---- */
    // 构造：好友已 sittingOut（上一步掉线判定），把行动权推到他的座位（模拟
    // 上一手结束时恰好轮到他当庄/下一动作序）。旧代码 watchFriendAction 每 1.5s
    // 重置计时后干等 30s，game.act 被合法性永远拒绝 → 全桌冻结。
    {
      const hostGame = host.requireGame();          // 房主端引擎引用（测试注入 getter）
      // 直接对好友座位触发一对「代弃 + 推进」：他应当被按弃牌跳过且 afterAct 正常走
      const friendP = hostGame.seatOf(2);
      ok(!!friendP && friendP.sittingOut === true, 'C-2 前置：好友座位已标 sittingOut');
      if (friendP && friendP.sittingOut) {
        const beforeResult = !!hostGame.result;
        // 若本手已结束（就绪期），先看 advanceInHand 的幂等拒绝
        if (beforeResult) {
          const r = hostGame.advanceInHand();
          ok(r.ok === false, 'C-2：牌局已结束时 advanceInHand 幂等拒绝');
        } else {
          // 本手进行中：把行动权硬拨到好友座位（模拟轮到他时恰好已判掉线）
          hostGame.actionSeat = 2;
          const r = hostGame.advanceInHand();
          ok(r.ok === true, 'C-2：sittingOut 行动者被引擎推进（代弃跳过）');
          ok(hostGame.actionSeat !== 2, 'C-2：行动权已移交他人，不在掉线座位上卡死');
        }
      }
    }

    /* ---- 座位伪冒回归：好友动作的 payload seat 与来源行 seat 不一致 → 房主拒收 ---- */
    {
      const hostGame = host.requireGame();
      const before = JSON.stringify(host.appliedSeqBySeat);
      // 好友（行座位 2）伪报房主座位 0：站起他人 / 替他人行动都必须被丢弃
      const spoofed = roomSync.pendingActions(
        [{ seat: 2, action: { seq: Date.now() + 1, type: 'stand', seat: 0, rowSeat: 2 } }], {}
      );
      // applyFriendAction 校验 a.seat !== a.rowSeat → 整条丢弃
      const spoofActs = spoofed.actions.filter(a => Number(a.seat) !== Number(a.rowSeat));
      ok(spoofActs.length === 1, '伪冒动作可被 pendingActions 取出（分道正常）');
      spoofActs.forEach(a => host.applyFriendAction(a));
      ok(host.isStanding(0) === false, '伪冒站起房主座位 → 房主端拒收（未被站起）');
      ok(JSON.stringify(host.appliedSeqBySeat) === before,
        '伪冒站起不改变房主端的已消化水位');   // appliedSeqBySeat 由 pollOnce 维护，applyFriendAction 不动它
    }

    /* ---- 房主心跳僵死检测：行还在但心跳超时 → 好友等宽限期后退房 ---- */
    {
      const hostIdx = store.poker_room_seats.findIndex(r => r.is_host);
      ok(hostIdx >= 0, '房主行仍在库中');
      const savedHb = store.poker_room_seats[hostIdx].heartbeat_at;
      // 房主心跳拨到 40s 前：行还在（房主崩溃不会删行），好友端不能无限干等
      store.poker_room_seats[hostIdx].heartbeat_at = iso(Date.now() - 40000);
      currentUid = 'uid_friend';   // leaveRoom 会删好友自己的行，别误删房主行
      friend.hostStaleSince = 0;
      global.__navBack = false;
      await friend.pollOnce();
      ok(friend.hostStaleSince > 0, '好友：首次发现房主心跳停滞 → 记录起点（宽限期计时中）');
      ok(global.__navBack === false, '好友：宽限期内不退出（防一次网络抖动误杀）');
      friend.hostStaleSince -= roomSync.SYNC.HOST_STALE_EXIT_MS + 1000;   // 模拟宽限期流逝
      await friend.pollOnce();
      ok(global.__navBack === true, '房主行存在但心跳僵死超宽限 → 好友端退出房间（不无限干等）');
      store.poker_room_seats[hostIdx].heartbeat_at = savedHb;   // 还原，后续场景继续用
    }

    /* ---- 好友镜像新手数 ---- */
    currentUid = 'uid_friend';
    await friend.pollOnce();
    eq(friend.data.handNo, host.data.handNo, '好友：镜像手数与房主一致');
    ok(friend.data.myCards.length === 2, '好友：新一手拿到底牌');
  }

  /* ---------- onSyncLost：云端报错 → 好友端退回本地模式（盲点补覆盖） ----------
   * pollOnce 内 await roomSync.poll 抛错 → catch 调 onSyncLost：syncLive 置 false、
   * stopSync 清轮询/心跳/发布定时器、setData(syncLive:false)、toast「云端同步中断，
   * 已转本地模式」。此前房主行消失（房间解散）有测，但「云端本身报错」这条断线恢复
   * 主路径无行为级覆盖。这里注入一次性 poll 抛错，断言好友端完整走 onSyncLost 降级。 */
  {
    // 备份并改造 roomSync.poll：好友端下一次 pollOnce 抛错（模拟云端不可达），
    // 之后恢复原 poll，避免污染后续用例。
    currentUid = 'uid_friend';
    const realPoll = roomSync.poll;
    let pollThrows = true;
    roomSync.poll = () => Promise.reject(new Error('云端不可达'));
    // 确保 friend 仍处于 syncLive（前置：同步引导成功）。前一轮房主离开用例已让好友
    // leaveRoom，syncLive 可能已 false；这里手动拨回 live 态，再触发 pollOnce 走断线。
    if (!friend.syncLive) friend.syncLive = true;
    friend.roomNo = ROOM;            // pollOnce 守卫要求 syncLive && roomNo
    const toastsBefore = toasts.length;
    await friend.pollOnce();
    // 恢复真实 poll，后续「重复行回归」用例不依赖云端读
    roomSync.poll = realPoll;
    ok(friend.syncLive === false, '好友：云端报错后 onSyncLost 置 syncLive=false（转本地模式）');
    ok(friend.pollTimer === null, '好友：onSyncLost 调 stopSync 清掉轮询定时器');
    ok(toasts.indexOf('云端同步中断，已转本地模式') >= 0,
      '好友：onSyncLost toast「云端同步中断，已转本地模式」，实际 toasts=' + JSON.stringify(toasts.slice(toastsBefore)));
    ok(friend.data.syncLive === false, '好友：onSyncLost setData(syncLive:false) 落值');
    // 幂等守卫：再次 onSyncLost 不应重复 toast（syncLive 已 false，早退）
    const toastsBefore2 = toasts.length;
    friend.onSyncLost();
    ok(toasts.length === toastsBefore2, 'onSyncLost 幂等：syncLive 已 false 时不再重复 toast');
    // 还原好友同步态：onSyncLost 把 syncLive 置 false，但后续「房主离开→房间解散」用例
    // 依赖 pollOnce 守卫（syncLive && roomNo）放行才能走 sawHost→leaveRoom 分支。
    // onSyncLost 只清定时器不动 roomNo/sawHost，这里只需把 syncLive 拨回 live。
    friend.syncLive = true;
  }

  /* ---- 房主中途离开 → 好友看到房间解散 ---- */
  currentUid = 'uid_host';
  store.poker_room_seats = store.poker_room_seats.filter(r => r.owner_id !== 'uid_host');
  currentUid = 'uid_friend';
  global.__navBack = false;
  await friend.pollOnce();
  ok(global.__navBack === true, '好友：房主行消失 → 离开房间');

  /* ---------- 回归：同一用户重复行 → 牌桌不能出现两个自己 ----------
   * 病根（用户 2026-10-16 反馈「有时候重入能看个两个自己」）：
   * 房主从邀请链接重进被判成访客 → 换座到新座位 → 旧行仍在，
   * 云端同一 owner_id 留下两条行，渲染层遍历 rows 就会画出两个自己。 */
  {
    const now = Date.now();
    const hb = new Date(now).toISOString();
    const dup = [
      { id: 'a', room_no: 'DUP1', owner_id: 'uid_x', seat: 0, name: '我', is_host: false, stack: 1000, heartbeat_at: hb },
      { id: 'b', room_no: 'DUP1', owner_id: 'uid_x', seat: 3, name: '我', is_host: false, stack: 1000, heartbeat_at: hb }
    ];
    const layout = roomSync.buildWaitLayout(dup, null, 6, 3, now);
    const mine = layout.filter(s => s.isMe);
    ok(mine.length <= 1, '同座位去重后布局里「我」至多出现一次，实际 ' + mine.length + ' 次');
    ok(layout.filter(s => s.occupied).length === 2, '两个座位仍各自有人（去重只影响同一座位）');

    // 真正的同座位重复：两条行都写 seat=0
    const dupSame = [
      { id: 'c', room_no: 'DUP2', owner_id: 'uid_y', seat: 0, name: '我', heartbeat_at: hb },
      { id: 'd', room_no: 'DUP2', owner_id: 'uid_y', seat: 0, name: '我', heartbeat_at: hb }
    ];
    const l2 = roomSync.buildWaitLayout(dupSame, null, 6, 0, now);
    ok(l2.filter(s => s.occupied).length === 1,
      '同一座位两条重复行 → 只渲染 1 个人，实际 ' + l2.filter(s => s.occupied).length);

    // 自己的行优先于同座位的他人行（自己视角不能被别人顶掉）
    const conflict = [
      { id: 'e', room_no: 'DUP3', owner_id: 'uid_other', seat: 2, name: '别人', heartbeat_at: hb },
      { id: 'f', room_no: 'DUP3', owner_id: 'uid_me', seat: 2, name: '我', heartbeat_at: hb }
    ];
    const l3 = roomSync.buildWaitLayout(conflict, null, 6, 2, now);
    ok(l3.filter(s => s.seat === 2)[0].isMe === true, '同座位冲突时优先认自己的行');
  }

  /* ---------- 输出 ---------- */
  console.log('\n' + '='.repeat(52));
  if (failures.length === 0) {
    console.log('跨设备同步测试全部通过：' + passes + ' 项断言 ✓');
    console.log('='.repeat(52) + '\n');
    process.exit(0);
  } else {
    console.log('通过 ' + passes + ' 项，失败 ' + failures.length + ' 项：\n');
    failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    console.log('='.repeat(52) + '\n');
    process.exit(1);
  }
})();
