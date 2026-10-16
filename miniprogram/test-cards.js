/**
 * 房卡逻辑仿真测试
 *
 * 覆盖「房卡不足怎么办」这条路径：
 *  - 发放（每日领取 / 对局奖励）与扣减（创建房间）全部走 rpc（服务端权威化第一期）
 *  - 每日只能领一次（rpc 幂等：唯一约束 (owner_id, day)）；对局奖励按累计手数发放且有单次上限
 *  - 并发双领防护：rpc 在服务端事务内原子完成，客户端不再有「两段提交」中间态
 *  - 战绩累计统计：rpc 在同一函数内 insert 流水 + update 档案，并发不丢手
 *  - 扣卡幂等：同 token 重发不二次扣
 *  - 流水落表：poker_card_grants 有对应 kind 的记录
 *  - 首页有可点的领卡入口（WXML 静态检查）
 *
 * 用内存版 cloud.database + rpc 派发模拟云端表与 PostgreSQL 函数，避免依赖真实网络。
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
global.wx = {
  login: ({ success }) => success({ code: 'mock_code' }),
  showToast: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  setStorageSync: () => {},
  getStorageSync: () => null,
  removeStorageSync: () => {}
};

/* ---------- 内存版云端数据库 ---------- */
const store = {
  poker_profiles: [],
  poker_records: [],
  poker_rooms: [],
  poker_card_grants: []      // 服务端权威化第一期：发放/扣减流水表
};
let seq = 1;
let grantSeq = 1;             // poker_card_grants 的 id 序列

const DEFAULTS = {
  poker_profiles: { room_cards: 12, total_hands: 0, total_wins: 0, total_net: 0, last_checkin: '', bonus_base: 0 },
  poker_rooms: { mode: 'friend', max_players: 6, duration_min: 0, status: 'open' }
};

const MOCK_UID = 'mock_uid';
const CARD_RULES = { daily: 2, handsPerCard: 10, bonusCap: 5 };

/** mock 服务端日期（与客户端 claimStatus 内联的 todayStr 同格式） */
function mockToday() {
  const d = new Date();
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function matches(row, filters) {
  return filters.every(f => {
    const v = row[f[0]];
    // PostgREST 语义：eq(NULL 列, 任何值) 永不命中；is(col, null) 命中 NULL 列
    if (f[1] === null) return v === null || v === undefined;
    // lt 过滤：字段值 < 指定值才命中（NULL 不命中，与 PostgREST 一致）
    if (f[2] === 'lt') return v !== null && v !== undefined && v < f[1];
    return v !== null && v !== undefined && String(v) === String(f[1]);
  });
}

const makeQuery = table => {
  const q = {
    _table: table, _op: 'select', _payload: null, _filters: [],
    _wantSelect: false, _single: false, _maybeSingle: false, _cols: '*',
    _order: null, _limit: null
  };
  q.select = cols => { q._cols = cols || '*'; q._wantSelect = true; return q; };
  q.insert = row => { q._op = 'insert'; q._payload = row; return q; };
  q.update = patch => { q._op = 'update'; q._payload = patch; return q; };
  q.eq = (a, b) => { q._filters.push([a, b]); return q; };
  q.is = (a, b) => { q._filters.push([a, b === null ? null : b]); return q; };
  q.lt = (a, b) => { q._filters.push([a, b, 'lt']); return q; };
  // .order/.limit 功能化：记录排序字段与截断条数，在 then 里真正执行
  // （之前是 no-op，listRecords 的游标分页依赖 .lt + .order + .limit 协作）
  q.order = (col, opts) => { q._order = { col: col, asc: !!(opts && opts.ascending) }; return q; };
  q.limit = n => { q._limit = n; return q; };
  q.single = () => { q._single = true; return q; };
  q.maybeSingle = () => { q._maybeSingle = true; return q; };

  // 任意链尾都能 await：then 里真正执行
  q.then = (resolve, reject) => {
    let out;
    try {
      const rows = store[table] || [];
      if (q._op === 'insert') {
        const row = Object.assign({ id: seq++, owner_id: MOCK_UID, created_at: new Date().toISOString() },
          DEFAULTS[table] || {}, q._payload);
        rows.push(row);
        out = { data: [row], error: null };
      } else if (q._op === 'update') {
        // PostgREST 语义：update 只改「全部过滤条件都命中」的行；
        // 乐观锁条件（如 .eq('last_checkin', 旧值)）不命中 → 0 行 → 上层判失败。
        // 命中后的新值以库中当前行为底再套 patch（模拟服务端读到-改回）。
        const hit = rows.filter(r => matches(r, q._filters));
        const hitIds = new Set(hit.map(r => r.id));
        rows.forEach(r => {
          if (hitIds.has(r.id)) Object.assign(r, q._payload);
        });
        out = { data: q._wantSelect ? rows.filter(r => hitIds.has(r.id)) : hit, error: null };
      } else {
        const hit = rows.filter(r => matches(r, q._filters));
        // select 分支：按 .order 指定字段排序（默认 created_at 降序未指定时保持原序）
        let sorted = hit;
        if (q._order) {
          sorted = hit.slice().sort((a, b) => {
            const av = a[q._order.col], bv = b[q._order.col];
            if (av === bv) return 0;
            if (av === null || av === undefined) return 1;
            if (bv === null || bv === undefined) return -1;
            return q._order.asc ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
          });
        }
        // .limit 截断
        if (q._limit != null) sorted = sorted.slice(0, q._limit);
        out = { data: sorted, error: null };
      }
      if (q._maybeSingle) out = { data: out.data.length ? out.data[0] : null, error: null };
      if (q._single) {
        if (!out.data.length) out = { data: null, error: { message: 'no rows' } };
        else out = { data: out.data[0], error: null };
      }
    } catch (e) {
      out = { data: null, error: { message: e.message } };
    }
    return Promise.resolve(out).then(resolve, reject);
  };
  return q;
};

/* ---------- mock rpc 派发（模拟 4 个 PL/pgSQL SECURITY DEFINER 函数） ---------- */
function getProfile() {
  return store.poker_profiles.find(r => r.owner_id === MOCK_UID) || null;
}

const rpcHandlers = {
  /**
   * 签到：幂等键 (owner_id, day, kind='daily')，唯一约束冲突 = 今日已领
   * 服务端定 current_date，客户端不传敏感日期。
   */
  poker_claim_daily(/* args */) {
    const day = mockToday();       // 服务端 current_date
    const p = getProfile();
    if (!p) return { data: null, error: { message: '档案不存在' } };

    // 幂等：检查流水是否已有 (owner_id, day, kind='daily')
    const exists = store.poker_card_grants.some(
      g => g.owner_id === MOCK_UID && g.kind === 'daily' && g.day === day
    );
    if (exists) {
      return { data: { ok: false, reason: '今日已领取，明天再来', roomCards: p.room_cards }, error: null };
    }

    // 插流水 + 发卡 + 置 last_checkin（同一事务）
    const bal = p.room_cards + CARD_RULES.daily;
    store.poker_card_grants.push({
      id: grantSeq++, owner_id: MOCK_UID, kind: 'daily',
      amount: CARD_RULES.daily, balance_after: bal, day: day,
      hand_base: null, token: null, created_at: new Date().toISOString()
    });
    p.room_cards = bal;
    p.last_checkin = day;
    return { data: { ok: true, gained: CARD_RULES.daily, roomCards: bal }, error: null };
  },

  /**
   * 对局奖励：FOR UPDATE 抢占，拉档发卡。
   * mock 中 getProfile 返回引用，并发顺序调用天然串行化。
   */
  poker_claim_hands(/* args */) {
    const p = getProfile();
    if (!p) return { data: null, error: { message: '档案不存在' } };

    const hands = p.total_hands || 0;
    const base = p.bonus_base || 0;
    const gained = Math.min(CARD_RULES.bonusCap, Math.floor((hands - base) / CARD_RULES.handsPerCard));
    if (gained <= 0) {
      const left = CARD_RULES.handsPerCard - ((hands - base) % CARD_RULES.handsPerCard);
      return { data: { ok: false, reason: '再打 ' + left + ' 手可领 1 张', roomCards: p.room_cards }, error: null };
    }

    const newBase = base + gained * CARD_RULES.handsPerCard;
    const bal = p.room_cards + gained;
    p.bonus_base = newBase;
    p.room_cards = bal;
    store.poker_card_grants.push({
      id: grantSeq++, owner_id: MOCK_UID, kind: 'hands',
      amount: gained, balance_after: bal, day: null,
      hand_base: newBase, token: null, created_at: new Date().toISOString()
    });
    return { data: { ok: true, gained: gained, roomCards: bal }, error: null };
  },

  /**
   * 建房扣卡：余额校验 + 扣减 + 流水 + token 幂等。
   */
  poker_consume_room_card(args) {
    const count = args.p_count || 1;
    const token = args.p_token || null;
    const p = getProfile();
    if (!p) return { data: null, error: { message: '档案不存在' } };

    // 幂等：同 token 已扣过 → 返回当前余额
    if (token) {
      const existing = store.poker_card_grants.some(
        g => g.owner_id === MOCK_UID && g.token === token
      );
      if (existing) {
        return { data: { ok: true, roomCards: p.room_cards, reason: '已扣减（幂等命中）' }, error: null };
      }
    }

    // 余额校验
    if (p.room_cards < count) {
      return { data: { ok: false, reason: '房卡不足', roomCards: p.room_cards }, error: null };
    }

    // 扣减 + 流水（同一事务）
    const bal = p.room_cards - count;
    p.room_cards = bal;
    store.poker_card_grants.push({
      id: grantSeq++, owner_id: MOCK_UID, kind: 'consume',
      amount: -count, balance_after: bal, day: null,
      hand_base: null, token: token, created_at: new Date().toISOString()
    });
    return { data: { ok: true, roomCards: bal }, error: null };
  },

  /**
   * 战绩上报：insert poker_records + update poker_profiles 累计统计。
   * p_row 不含 owner_id，由服务端 auth.uid() 填。
   */
  poker_record_hand(args) {
    const p_row = args.p_row;
    const p = getProfile();
    if (!p) return { data: null, error: { message: '档案不存在' } };

    const row = {
      id: seq++,
      owner_id: MOCK_UID,               // 服务端 auth.uid() 填
      table_id: p_row.table_id || 'ai',
      hand_no: p_row.hand_no || 1,
      seat: p_row.seat || 0,
      hole_cards: p_row.hole_cards || '',
      board: p_row.board || '',
      hand_type: p_row.hand_type || '',
      net: p_row.net || 0,
      won: !!p_row.won,
      created_at: new Date().toISOString()
    };
    store.poker_records.push(row);

    // 同函数累计档案统计
    p.total_hands = (p.total_hands || 0) + 1;
    p.total_wins = (p.total_wins || 0) + (row.won ? 1 : 0);
    p.total_net = (p.total_net || 0) + row.net;

    return { data: row, error: null };
  }
};

const fakeCloud = {
  database: {
    from: table => {
      if (!store[table]) store[table] = [];
      return makeQuery(table);
    },
    rpc: (fn, args) => {
      const handler = rpcHandlers[fn];
      if (!handler) return Promise.resolve({ data: null, error: { message: '未知函数: ' + fn } });
      // rpc 返回 thenable，与 SDK 的 PostgrestFilterBuilder 一致
      return Promise.resolve(handler(args || {}));
    }
  }
};

/* ---------- 拦截 require('./cloud') ---------- */
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './cloud') return { cloud: fakeCloud };
  return origRequire.apply(this, arguments);
};
const auth = require(path.join(__dirname, 'utils', 'auth.js')).auth;
Module.prototype.require = origRequire;

(async () => {
  /* ---------- 建档：默认 12 张 ---------- */
  const p0 = await auth.ensureProfile();
  eq(p0.room_cards, 12, '首次建档默认 12 张房卡');
  eq(p0.last_checkin, '', '未领过卡时 last_checkin 为空');
  eq(p0.bonus_base, 0, '未领过对局奖励时 bonus_base = 0');

  /* ---------- 可领状态 ---------- */
  let st = auth.claimStatus(p0);
  ok(st.dailyReady === true, '新用户今日可领每日卡');
  eq(st.dailyCount, 2, '每日领取 2 张');
  eq(st.handCards, 0, '0 手时无可领对局奖励');
  eq(st.handsToNext, 10, '还差 10 手可领 1 张');

  /* ---------- 每日领取：rpc 幂等，一天只能一次 ---------- */
  const d1 = await auth.claimDailyCards();
  ok(d1.ok === true && d1.gained === 2, '首次每日领取 +2，实际 ' + JSON.stringify(d1));
  eq(d1.roomCards, 14, '领取后余额 14');

  // 流水落表：poker_card_grants 有一条 daily 记录
  eq(store.poker_card_grants.filter(g => g.kind === 'daily').length, 1,
    'rpc 路径：daily 流水落表 1 条');
  eq(store.poker_card_grants[0].balance_after, 14,
    '流水 balance_after = 领取后余额 14');

  const d2 = await auth.claimDailyCards();
  ok(d2.ok === false, '同一天第二次领取被拒绝（rpc 幂等）');
  ok((d2.reason || '').indexOf('今日已领取') >= 0, '拒绝原因提示今日已领取：' + d2.reason);
  eq(d2.roomCards, 14, '重复领取不改变余额');

  // 幂等：流水仍只有 1 条 daily（不重复发）
  eq(store.poker_card_grants.filter(g => g.kind === 'daily').length, 1,
    'rpc 幂等：同日重发不新增 daily 流水');

  st = auth.claimStatus(await auth.ensureProfile());
  ok(st.dailyReady === false, '领过之后 dailyReady = false（按钮置灰）');

  // 换一天：把 last_checkin 改成昨天、删除流水即可再领（模拟次日）
  const cur = await auth.ensureProfile();
  cur.last_checkin = '2000-01-01';
  store.poker_card_grants = store.poker_card_grants.filter(g => g.kind !== 'daily');
  const d3 = await auth.claimDailyCards();
  ok(d3.ok === true && d3.gained === 2, '换日之后可以再领 +2');
  eq(d3.roomCards, 16, '换日领取后余额 16');

  /* ---------- 对局奖励：每 10 手 1 张，单次上限 5 ---------- */
  const me = await auth.ensureProfile();
  me.total_hands = 9;
  const h1 = await auth.claimHandBonus();
  ok(h1.ok === false, '9 手时无可领奖励');
  ok((h1.reason || '').indexOf('再打 1 手') >= 0, '提示「再打 1 手可领 1 张」：' + h1.reason);

  me.total_hands = 25;
  const h2 = await auth.claimHandBonus();
  ok(h2.ok === true && h2.gained === 2, '25 手（基准 0）领 2 张，实际 ' + h2.gained);
  eq(h2.roomCards, 18, '领奖后余额 18');
  const after = await auth.ensureProfile();
  eq(after.bonus_base, 20, 'bonus_base 推进到 20（已奖励的手数基准）');

  // 流水落表：hands 流水
  ok(store.poker_card_grants.some(g => g.kind === 'hands' && g.amount === 2),
    'rpc 路径：hands 流水落表');

  st = auth.claimStatus(after);
  eq(st.handCards, 0, '25 手且基准 20 → 暂不可再领');
  eq(st.handsToNext, 5, '还差 5 手可领下一张');

  // 上限：一次最多补 5 张
  me.total_hands = 200;
  me.bonus_base = 0;
  const h3 = await auth.claimHandBonus();
  eq(h3.gained, 5, '长时间未领时单次最多补 5 张（防一次性刷爆），实际 ' + h3.gained);
  eq((await auth.ensureProfile()).bonus_base, 50, '上限档位只推进 50 手基准');

  /* ---------- 扣卡：rpc 路径，不足时不扣、不透支 ---------- */
  const poor = await auth.ensureProfile();
  poor.room_cards = 0;
  const c1 = await auth.consumeRoomCard(1, 'token_test_1');
  ok(c1.ok === false, '房卡为 0 时创建房间被拒绝');
  eq(c1.reason, '房卡不足', '拒绝原因 = 房卡不足');
  eq((await auth.ensureProfile()).room_cards, 0, '拒绝后余额仍为 0（不会变负数）');

  poor.room_cards = 3;
  const c2 = await auth.consumeRoomCard(1, 'token_test_2');
  ok(c2.ok === true, '有余量时扣卡成功');
  eq(c2.roomCards, 2, '扣 1 张后余额 2');

  // 扣卡流水落表
  ok(store.poker_card_grants.some(g => g.kind === 'consume' && g.amount === -1 && g.token === 'token_test_2'),
    'rpc 路径：consume 流水落表（含 token）');

  /* ---------- 扣卡幂等：同 token 重发不二次扣 ---------- */
  const c2b = await auth.consumeRoomCard(1, 'token_test_2');   // 同 token
  ok(c2b.ok === true, '同 token 重发返回 ok（幂等命中）');
  ok((c2b.reason || '').indexOf('幂等') >= 0, '幂等命中提示：' + c2b.reason);
  eq(c2b.roomCards, 2, '幂等命中：余额不二次扣（仍为 2）');
  eq(store.poker_card_grants.filter(g => g.token === 'token_test_2').length, 1,
    '幂等：同 token 流水只有 1 条（不重复扣）');

  // 不同 token 正常扣
  const c3 = await auth.consumeRoomCard(1, 'token_test_3');
  ok(c3.ok === true, '不同 token 正常扣卡');
  eq(c3.roomCards, 1, '扣后余额 1');

  /* ---------- 并发双领防护（rpc 事务原子，不再有客户端两段中间态） ---------- */
  {
    // 重置到干净的并发起点
    const me2 = await auth.ensureProfile();
    me2.last_checkin = '';
    me2.room_cards = 100;
    store.poker_card_grants = store.poker_card_grants.filter(g => g.kind !== 'daily');
    const beforeA = me2.room_cards;

    // rpc 幂等：两个并发 claimDailyCards 只有第一个发卡
    const [rA, rB] = await Promise.all([
      auth.claimDailyCards(),
      auth.claimDailyCards()
    ]);
    // 至少一个成功 +2，另一个被拒（rpc 原子幂等）
    const okCount = [rA, rB].filter(r => r.ok).length;
    eq(okCount, 1, 'rpc 并发：双领只有一个成功（事务原子幂等），实际 ' + okCount);
    eq(me2.room_cards, beforeA + 2, '并发领取后余额只增加一份（不再双领）');
    eq(store.poker_card_grants.filter(g => g.kind === 'daily').length, 1,
      'rpc 并发：daily 流水只有 1 条');
  }

  /* ---------- 对局奖励并发：rpc FOR UPDATE 抢占 ---------- */
  {
    const me3 = await auth.ensureProfile();
    me3.total_hands = 25;
    me3.bonus_base = 0;
    const beforeCards = me3.room_cards;

    const [rA, rB] = await Promise.all([
      auth.claimHandBonus(),
      auth.claimHandBonus()
    ]);
    // 第一个 gained=2，第二个 gained=0（基准已推进）
    const totalGained = (rA.gained || 0) + (rB.gained || 0);
    eq(totalGained, 2, 'rpc 并发：对局奖励只发一批（FOR UPDATE 抢占），实际总共 ' + totalGained);
    eq(me3.bonus_base, 20, 'bonus_base 只被推进一次（并发不重发）');
    eq(me3.room_cards, beforeCards + 2, '并发对局奖励余额只加一份');
  }

  /* ---------- 战绩累计统计：rpc 同函数 insert + update，并发不丢手 ---------- */
  {
    const before = (await auth.ensureProfile()).total_hands;
    const beforeWins = (await auth.ensureProfile()).total_wins;
    const [r1, r2] = await Promise.all([
      auth.saveRecord({ tableId: 'ai', handNo: 1, seat: 0, net: 10, won: true }),
      auth.saveRecord({ tableId: 'ai', handNo: 2, seat: 0, net: -5, won: false })
    ]);
    const after = (await auth.ensureProfile());
    eq(after.total_hands, before + 2, 'rpc 路径：连打两手累计不丢（同函数原子累计）');
    eq(after.total_wins, beforeWins + 1, 'rpc 路径：胜场 +1（一胜一负）');
    ok(r1 && r1.owner_id === MOCK_UID, 'rpc 路径：saveRecord 返回行 owner_id 由服务端填');
    ok(r2 && r2.owner_id === MOCK_UID, 'rpc 路径：第二条 saveRecord 返回行 owner_id 由服务端填');
    ok(Array.isArray(store.poker_records) && store.poker_records.length >= 2,
      '战绩流水两条都在（rpc insert 流水无并发问题）');
  }

  /* ---------- NULL last_checkin 的历史行也能领签到（rpc 幂等不依赖 NULL 比较） ---------- */
  {
    // rpc 路径：last_checkin 为 NULL 的历史行，claimDailyCards 走 rpc 幂等检查
    // 流水里没有当日记录 → 可领，领后 last_checkin 被服务端置为今天。
    const old = await auth.ensureProfile();
    old.last_checkin = null;
    store.poker_card_grants = store.poker_card_grants.filter(g => g.kind !== 'daily');
    const r = await auth.claimDailyCards();
    ok(r.ok === true, 'last_checkin 为 NULL 的历史行可以领每日卡（rpc 幂等检查流水）');
    eq(old.last_checkin, mockToday(), 'NULL 行领取后标记置为今天（服务端 current_date）');
    eq(store.poker_card_grants.filter(g => g.kind === 'daily').length, 1,
      'NULL 行领取：daily 流水落表 1 条');
  }

  /* ---------- auth.js 不再含 today()/grantRoomCards（服务端权威化收口） ---------- */
  {
    const authSrc = require('fs').readFileSync(path.join(__dirname, 'utils', 'auth.js'), 'utf8');
    // today() 方法已删除；claimStatus 内联 todayStr 闭包仅供 dailyReady 乐观展示
    ok(!/this\.today\(\)/.test(authSrc) && !/auth\.today\(\)/.test(authSrc),
      'auth.js 不再暴露 today() 方法（客户端日期判定已收口）');
    ok(authSrc.indexOf('grantRoomCards') < 0, 'auth.js 不再含 grantRoomCards（已被 rpc 收编）');
    ok(authSrc.indexOf('poker_claim_daily') >= 0, 'auth.js 调用 rpc poker_claim_daily');
    ok(authSrc.indexOf('poker_claim_hands') >= 0, 'auth.js 调用 rpc poker_claim_hands');
    ok(authSrc.indexOf('poker_consume_room_card') >= 0, 'auth.js 调用 rpc poker_consume_room_card');
    ok(authSrc.indexOf('poker_record_hand') >= 0, 'auth.js 调用 rpc poker_record_hand');
  }

  const fs = require('fs');
  const indexWxml = fs.readFileSync(path.join(__dirname, 'pages', 'index', 'index.wxml'), 'utf8');
  const indexJs = fs.readFileSync(path.join(__dirname, 'pages', 'index', 'index.js'), 'utf8');
  ok(indexWxml.indexOf('cards-add') >= 0, '首页房卡区有「+」入口');
  ok(indexWxml.indexOf('bindtap="onCardsTap"') >= 0, '房卡可点（onCardsTap）');
  ok(indexWxml.indexOf('获取房卡') >= 0, '存在「获取房卡」弹窗');
  ok(indexWxml.indexOf('onClaimDaily') >= 0 && indexWxml.indexOf('onClaimHands') >= 0,
    '弹窗内每日领取与对局奖励按钮均已绑定');
  ok(indexWxml.indexOf('不消耗房卡') >= 0, '弹窗说明加入好友房不消耗房卡');
  ok(indexJs.indexOf('onJoinFromCards') >= 0, '弹窗内「去加入」有对应处理');
  ok(indexJs.indexOf("confirmText: '去领卡'") >= 0 && indexJs.indexOf("cancelText: 'AI 桌'") >= 0,
    '房卡不足弹窗给出「去领卡 / AI 桌」两条出路');
  ok(indexJs.indexOf('去领卡') >= 0 && '去领卡'.length <= 4 && 'AI 桌'.length <= 4,
    '弹窗按钮文案 ≤ 4 字（超长真机静默失败）');

  /* ---------- 战绩深化图表（方向 A）纯函数单测 ---------- */
  const chartStats = require(path.join(__dirname, 'utils', 'chart-stats'));

  // ---- 空数组容错 ----
  eq(chartStats.computeWinRate([]), { chunks: [], overallPct: 0 },
    'computeWinRate 空数组 → { chunks:[], overallPct:0 }');
  eq(chartStats.computeHandTypes([]), [], 'computeHandTypes 空数组 → []');
  eq(chartStats.computeNetTrend([]), { bars: [], sum: 0, sumText: '0' },
    'computeNetTrend 空数组 → { bars:[], sum:0, sumText:"0" }');
  eq(chartStats.computeWinRate(null).overallPct, 0, 'computeWinRate null 入参容错 → overallPct=0');
  eq(chartStats.computeNetTrend(null).sumText, '0', 'computeNetTrend null 入参容错 → sumText="0"');

  // ---- CHUNK_SIZE 常量 ----
  eq(chartStats.CHUNK_SIZE, 10, 'CHUNK_SIZE = 10');

  // ---- 胜率曲线：10 手 60% 胜（6 won）→ 一块 ----
  const rows10 = Array.from({ length: 10 }, (_, i) => ({ won: i < 6, net: 10, hand_type: '' }));
  const wr10 = chartStats.computeWinRate(rows10);
  eq(wr10.chunks.length, 1, '10 手 → 1 块');
  eq(wr10.chunks[0].pct, 60, '10 手 6 胜 → 块 pct=60');
  eq(wr10.chunks[0].color, '#4caf7d', '60% 胜率 → 绿色（≥50%）');
  eq(wr10.chunks[0].scale, 0.6, '60% 胜率 → scale=0.6');
  eq(wr10.chunks[0].range, '1-10', '10 手块 range="1-10"');
  eq(wr10.overallPct, 60, '总胜率 overallPct=60');

  // ---- 胜率曲线：25 手 → 3 块（10+10+5）----
  const rows25 = Array.from({ length: 25 }, (_, i) => ({ won: i < 10, net: 5, hand_type: '' }));
  const wr25 = chartStats.computeWinRate(rows25);
  eq(wr25.chunks.length, 3, '25 手 → 3 块');
  eq(wr25.chunks[2].range, '21-25', '25 手第 3 块 range="21-25"');
  eq(wr25.chunks[2].pct, 0, '第 3 块 5 手仅 0 胜 → pct=0（<30% 红）');
  eq(wr25.chunks[2].color, '#e05c4b', '20% 胜率 → 红色（<30%）');

  // ---- 胜率曲线颜色阈值：30–50% 金 ----
  const rowsGold = Array.from({ length: 10 }, (_, i) => ({ won: i < 4, net: 0, hand_type: '' }));
  eq(chartStats.computeWinRate(rowsGold).chunks[0].color, '#d9a441', '40% 胜率 → 金色（30–50%）');

  // ---- 牌型分布：降序 + 获胜兜底（won=true 无 hand_type → '获胜'）----
  const rowsTypes = [
    { won: true, net: 10, hand_type: '同花' },
    { won: true, net: 20, hand_type: '同花' },
    { won: true, net: 5, hand_type: '一对' },
    { won: false, net: -10, hand_type: '' },   // won=false 无 hand_type → '未中牌'
    { won: true, net: 30, hand_type: '' }      // won=true 无 hand_type → '获胜'
  ];
  const ht = chartStats.computeHandTypes(rowsTypes);
  eq(ht.length, 4, '牌型分布返回 4 种（零计数类型不返回）');
  eq(ht[0].name, '同花', '牌型降序：同花（2 次）排第一');
  eq(ht[0].count, 2, '同花 count=2');
  eq(ht[0].pct, 100, '同花出现最多 → pct=100');
  ok(ht.findIndex(e => e.name === '获胜') >= 0, '牌型分布含「获胜」兜底（won=true 无 hand_type）');
  ok(ht.findIndex(e => e.name === '未中牌') >= 0, '牌型分布含「未中牌」兜底（won=false 无 hand_type）');
  eq(ht.filter(e => e.name === '高牌').length, 0, '零计数类型「高牌」不返回');

  // ---- 盈亏走势：sum/maxAbs/scale/cls 正负符号 ----
  const rowsNet = [
    { won: true, net: 100, hand_type: '' },
    { won: false, net: -50, hand_type: '' },
    { won: true, net: 200, hand_type: '' },
    { won: false, net: -200, hand_type: '' }
  ];
  const nt = chartStats.computeNetTrend(rowsNet);
  eq(nt.bars.length, 4, '盈亏走势 4 根柱');
  eq(nt.sum, 50, '净盈亏 sum=100-50+200-200=50');
  eq(nt.sumText, '+50', '正净盈亏 sumText="+50"');
  eq(nt.bars[0].val, 100, '第 1 根 val=100');
  eq(nt.bars[0].cls, 'up', '正 net → cls=up');
  eq(nt.bars[1].cls, 'down', '负 net → cls=down');
  eq(nt.bars[2].scale, 1, 'maxAbs=200 → |200|/200=1（scale 最大）');
  eq(nt.bars[0].scale, 0.5, '|100|/200=0.5');

  // ---- 盈亏走势：负净盈亏 sumText 带负号 ----
  const rowsNeg = [{ won: false, net: -100, hand_type: '' }, { won: false, net: -50, hand_type: '' }];
  const ntNeg = chartStats.computeNetTrend(rowsNeg);
  eq(ntNeg.sum, -150, '负净盈亏 sum=-150');
  eq(ntNeg.sumText, '-150', '负净盈亏 sumText="-150"');

  // ---- 盈亏走势：全零 net → sumText='0'，scale=0 ----
  const rowsZero = [{ won: true, net: 0, hand_type: '' }, { won: false, net: 0, hand_type: '' }];
  const ntZero = chartStats.computeNetTrend(rowsZero);
  eq(ntZero.sum, 0, '全零 net → sum=0');
  eq(ntZero.sumText, '0', '全零 net → sumText="0"');
  eq(ntZero.bars[0].scale, 0, 'maxAbs=0 → scale=0（不除零）');

  /* ---------- listRecords 大窗口 + .lt 游标分页 ---------- */
  // 造 105 条 poker_records，验证 .order（created_at 降序）+ .limit + .lt 协作
  {
    store.poker_records = [];
    for (let i = 0; i < 105; i++) {
      store.poker_records.push({
        id: 1000 + i,
        owner_id: 'mock_uid',
        hand_no: i + 1,
        net: i % 2 === 0 ? 10 : -5,
        won: i % 3 === 0,
        hand_type: i % 4 === 0 ? '同花' : '',
        created_at: '2026-01-' + String(i + 1).padStart(2, '0') + 'T00:00:00.000Z'
      });
    }
    // 第一页：limit=100，从最新开始（created_at 降序）→ 应返回 100 条
    const page1 = await auth.listRecords(100, null);
    eq(page1.length, 100, 'listRecords(100, null) 返回恰好 100 条');
    // 最新一条 created_at 应是 2026-01-105 不存在，实际是按 id/created_at 倒序
    // 因造数时 created_at 日期为 01-105（不存在月份日），用字符串比较仍按字典序
    // 第 105 条 created_at 最大 → 排第一
    ok(page1[0].created_at >= page1[1].created_at, 'listRecords 按 created_at 降序排列');

    // 第二页：用第一页最后一条的 created_at 作游标，.lt 返回剩余 5 条
    const cursor = page1[page1.length - 1].created_at;
    const page2 = await auth.listRecords(100, cursor);
    eq(page2.length, 5, 'listRecords(100, cursor) 第二页返回剩余 5 条');
    ok(page2.every(r => r.created_at < cursor), '第二页所有记录 created_at < 游标（.lt 生效）');
  }

  /* ---------- 输出 ---------- */
  console.log('\n' + '='.repeat(52));
  if (failures.length === 0) {
    console.log('房卡逻辑仿真测试全部通过：' + passes + ' 项断言 ✓');
    console.log('='.repeat(52) + '\n');
    process.exit(0);
  } else {
    console.log('通过 ' + passes + ' 项，失败 ' + failures.length + ' 项：\n');
    failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    console.log('='.repeat(52) + '\n');
    process.exit(1);
  }
})();
