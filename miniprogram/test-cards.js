/**
 * 房卡逻辑仿真测试
 *
 * 覆盖「房卡不足怎么办」这条路径：
 *  - 发放（每日领取 / 对局奖励）与扣减（创建房间）走同一套乐观锁
 *  - 每日只能领一次；对局奖励按累计手数发放且有单次上限
 *  - 首页有可点的领卡入口（WXML 静态检查）
 *
 * 用内存版 cloud.database 模拟云端表，避免依赖真实网络。
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
  poker_rooms: []
};
let seq = 1;

const DEFAULTS = {
  poker_profiles: { room_cards: 12, total_hands: 0, total_wins: 0, total_net: 0, last_checkin: '', bonus_base: 0 },
  poker_rooms: { mode: 'friend', max_players: 6, duration_min: 0, status: 'open' }
};

function matches(row, filters) {
  return filters.every(f => String(row[f[0]]) === String(f[1]));
}

function makeQuery(table) {
  const q = {
    _table: table, _op: 'select', _payload: null, _filters: [],
    _wantSelect: false, _single: false, _maybeSingle: false, _cols: '*'
  };
  q.select = cols => { q._cols = cols || '*'; q._wantSelect = true; return q; };
  q.insert = row => { q._op = 'insert'; q._payload = row; return q; };
  q.update = patch => { q._op = 'update'; q._payload = patch; return q; };
  q.eq = (a, b) => { q._filters.push([a, b]); return q; };
  q.order = () => q;
  q.limit = () => q;
  q.single = () => { q._single = true; return q; };
  q.maybeSingle = () => { q._maybeSingle = true; return q; };

  // 任意链尾都能 await：then 里真正执行
  q.then = (resolve, reject) => {
    let out;
    try {
      const rows = store[table] || [];
      if (q._op === 'insert') {
        const row = Object.assign({ id: seq++, owner_id: 'mock_uid', created_at: new Date().toISOString() },
          DEFAULTS[table] || {}, q._payload);
        rows.push(row);
        out = { data: [row], error: null };
      } else if (q._op === 'update') {
        const hit = rows.filter(r => matches(r, q._filters));
        hit.forEach(r => Object.assign(r, q._payload));
        // 乐观锁：带 room_cards 条件但没命中 → 返回空数组（上层据此判定「已变动」）
        out = { data: q._wantSelect ? hit : hit, error: null };
        if (!q._wantSelect) out = { data: hit, error: null };
      } else {
        const hit = rows.filter(r => matches(r, q._filters));
        out = { data: hit, error: null };
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
}

const fakeCloud = {
  database: {
    from: table => {
      if (!store[table]) store[table] = [];
      return makeQuery(table);
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

  /* ---------- 每日领取：一天只能一次 ---------- */
  const d1 = await auth.claimDailyCards();
  ok(d1.ok === true && d1.gained === 2, '首次每日领取 +2，实际 ' + JSON.stringify(d1));
  eq(d1.roomCards, 14, '领取后余额 14');

  const d2 = await auth.claimDailyCards();
  ok(d2.ok === false, '同一天第二次领取被拒绝');
  ok((d2.reason || '').indexOf('今日已领取') >= 0, '拒绝原因提示今日已领取：' + d2.reason);
  eq(d2.roomCards, 14, '重复领取不改变余额');

  st = auth.claimStatus(await auth.ensureProfile());
  ok(st.dailyReady === false, '领过之后 dailyReady = false（按钮置灰）');

  // 换一天：把 last_checkin 改成昨天即可再领
  const cur = await auth.ensureProfile();
  cur.last_checkin = '2000-01-01';
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

  st = auth.claimStatus(after);
  eq(st.handCards, 0, '25 手且基准 20 → 暂不可再领');
  eq(st.handsToNext, 5, '还差 5 手可领下一张');

  // 上限：一次最多补 5 张
  me.total_hands = 200;
  me.bonus_base = 0;
  const h3 = await auth.claimHandBonus();
  eq(h3.gained, 5, '长时间未领时单次最多补 5 张（防一次性刷爆），实际 ' + h3.gained);
  eq((await auth.ensureProfile()).bonus_base, 50, '上限档位只推进 50 手基准');

  /* ---------- 扣卡：不足时不扣、不透支 ---------- */
  const poor = await auth.ensureProfile();
  poor.room_cards = 0;
  const c1 = await auth.consumeRoomCard(1);
  ok(c1.ok === false, '房卡为 0 时创建房间被拒绝');
  eq(c1.reason, '房卡不足', '拒绝原因 = 房卡不足');
  eq((await auth.ensureProfile()).room_cards, 0, '拒绝后余额仍为 0（不会变负数）');

  poor.room_cards = 3;
  const c2 = await auth.consumeRoomCard(1);
  ok(c2.ok === true, '有余量时扣卡成功');
  eq(c2.roomCards, 2, '扣 1 张后余额 2');

  // 乐观锁：本次调用读到的仍是旧余额 2，但库中已被改为 99（另一台设备刚领了卡）
  // → 更新条件不匹配、0 行受影响，扣卡作废而不是覆盖掉别人的改动
  const staleCards = (await auth.ensureProfile()).room_cards;   // 2
  const realEnsure = auth.ensureProfile.bind(auth);
  auth.ensureProfile = async () => Object.assign({}, poor, { room_cards: staleCards });
  poor.room_cards = 99;
  const c3 = await auth.consumeRoomCard(1);
  auth.ensureProfile = realEnsure;
  ok(c3.ok === false, '乐观锁：余额已变动时扣卡失败（不覆盖他人改动）');
  eq(c3.reason, '房卡已变动，请重试', '失败原因提示重试');
  eq((await auth.ensureProfile()).room_cards, 99, '并发下余额保持为最新值 ' + staleCards + ' → 99');

  /* ---------- 首页入口（WXML 静态检查） ---------- */
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
