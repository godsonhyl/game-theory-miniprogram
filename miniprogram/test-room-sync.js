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
  q.eq = (a, b) => { q._filters.push([a, b]); return q; };
  q.order = col => { q._order = col; return q; };
  q.limit = () => q;
  q.single = () => { q._single = true; return q; };
  q.maybeSingle = () => { q._maybeSingle = true; return q; };
  q.then = (resolve, reject) => {
    let out;
    try {
      const rows = store[table] || [];
      const mine = r => r.owner_id === uidAtBuild;
      const match = r => q._filters.every(f => String(r[f[0]]) === String(f[1]));
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
  const r1 = roomSync.pendingActions(rows, 0);
  eq(r1.actions.map(a => a.seq), [3, 5, 9], 'pendingActions 按序号升序取出');
  eq(r1.nextSeq, 9, 'nextSeq = 最大已见序号');
  const r2 = roomSync.pendingActions(rows, 5);
  eq(r2.actions.map(a => a.seq), [9], 'appliedSeq=5 时只消费 5 以后的');
  eq(r2.nextSeq, 9, 'nextSeq 仍是 9');
  const r3 = roomSync.pendingActions(rows, 99);
  eq(r3.actions.length, 0, '无新动作');
  eq(r3.nextSeq, 99, '无新动作时 nextSeq 保持');
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
  const pa = roomSync.pendingActions(rows, 0);
  eq(pa.actions.length, 1, '房主能看到 1 条待消费好友动作');

  currentUid = 'uid_friend';
  await roomSync.leave('800001');
  eq(store.poker_room_seats.filter(r => r.owner_id === 'uid_friend').length, 0, '离座删除自己的行');
  eq(store.poker_room_seats.length, 1, 'RLS：离座删不掉别人的行');

  /* ---------- 降级：库报错时不影响页面（模拟 update 抛错） ---------- */
  const brokenDb = {
    from: () => ({ update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) })
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
    if (host.appliedSeq > 0) appliedAdvanced = true;
  }

  ok(friendActed, '好友：本手轮到过并完成行动（三人局必行动）');
  ok(appliedAdvanced, '房主：appliedSeq 已推进（消化过好友动作）');
  ok(!!host.data.result, '一手牌走到结算');

  if (host.data.result) {
    // 给镜像一拍：房主广播有 ~500ms 节流，需等节流窗口过完再轮询
    await sleep(650);
    currentUid = 'uid_friend';
    await friend.pollOnce();
    ok(!!friend.data.result, '好友：镜像同步到结算');
    ok(!!friend.data.result && friend.data.result.rows.length > 0, '好友：结算条有数据');
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

    /* ---- 好友镜像新手数 ---- */
    currentUid = 'uid_friend';
    await friend.pollOnce();
    eq(friend.data.handNo, host.data.handNo, '好友：镜像手数与房主一致');
    ok(friend.data.myCards.length === 2, '好友：新一手拿到底牌');
  }

  /* ---- 房主中途离开 → 好友看到房间解散 ---- */
  currentUid = 'uid_host';
  store.poker_room_seats = store.poker_room_seats.filter(r => r.owner_id !== 'uid_host');
  currentUid = 'uid_friend';
  global.__navBack = false;
  await friend.pollOnce();
  ok(global.__navBack === true, '好友：房主行消失 → 离开房间');

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
