/**
 * 博弈论 · 德州扑克核心引擎（Texas Hold'em Core Engine）
 * ---------------------------------------------------------------
 * 纯逻辑实现，零 DOM / 零网络依赖，可直接被以下环境复用：
 *   - 微信小程序（CommonJS: require('../../core/poker-core.js')）
 *   - Web Worker / Service Worker
 *   - Node.js 服务端权威牌局引擎（推荐）
 *
 * 设计要点：
 *   1. 随机源可注入 + 可复现（seed），便于事件溯源回放与审计。
 *   2. 洗牌使用密码学安全随机（crypto.getRandomValues）做初始种子。
 *   3. 所有金额为整数筹码单位，避免浮点误差。
 *   4. 边池按「承诺额分层」计算并合并同资格层，支持任意多路全下。
 *
 * @version 1.1.0
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PokerCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================================================
   * 一、基础常量
   * ========================================================== */

  // 牌的编码：0..51 → rank = id >> 2, suit = id & 3
  const RANK_NAMES = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const SUIT_CHARS = ['♠', '♣', '♦', '♥'];
  const SUIT_NAMES = ['s', 'c', 'd', 'h'];

  /**
   * 界面渲染用的点数文本：唯一区别是 10 显示成「10」而不是「T」。
   *
   * ⚠️ 务必分清它和 RANK_NAMES 的职责，两者不可合并：
   *   - RANK_NAMES 是**机读码**字母表，参与 cardToCode / codeToCard 的编解码。
   *     它必须固定单字符，否则 "Th" 会变成变长的 "10h"，
   *     codeToCard 的 code[0] 定长解析、profile 页 formatCards 的逐字符切分、
   *     以及跨设备快照里已落库的牌面数据会全部失效。
   *   - RANK_DISPLAY 纯粹是给人看的表示层，改它不影响任何存储与传输格式。
   */
  const RANK_DISPLAY = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

  const HAND = {
    HIGH_CARD: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4,
    FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8
  };

  const STREET = {
    PREFLOP: 'preflop', FLOP: 'flop', TURN: 'turn',
    RIVER: 'river', SHOWDOWN: 'showdown'
  };

  const STREET_CN = {
    preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈',
    river: '河牌圈', showdown: '摊牌'
  };

  const ACTION = {
    FOLD: 'fold', CHECK: 'check', CALL: 'call', RAISE: 'raise', ALLIN: 'allin'
  };

  const ACTION_CN = {
    fold: '弃牌', check: '过牌', call: '跟注', raise: '加注', allin: '全下'
  };

  // 事件流封顶：events 跨手累积、startHand 不清——长会话（多手连续对战）只增不减，
  // drainSfx 每 300ms 读全数组、replay-store 从后向前找 hand_start 线性扫。封顶到
  // 最近 MAX_EVENTS 条，保留复盘所需的「最后一手」完整段（单手约 20-60 事件，
  // 600 留足 ~10 手余量）。截断只在 startHand 手边界发生，绝不切到进行中的当前手。
  const MAX_EVENTS = 600;

  /* ============================================================
   * 二、随机数：xorshift128+（可复现）
   * ========================================================== */

  function cryptoRandomBytes(n) {
    const buf = new Uint8Array(n);
    const scope = (typeof globalThis !== 'undefined' ? globalThis : root) || {};
    if (scope.crypto && typeof scope.crypto.getRandomValues === 'function') {
      scope.crypto.getRandomValues(buf);
      return buf;
    }
    // 退化路径：仅用于无 crypto 环境。生产环境应由服务端持有牌序。
    for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
    return buf;
  }

  /** 字符串 → 4 个 uint32（xmur3 变体），完全确定性 */
  function hash128(str) {
    let h1 = 1779033703 ^ str.length;
    let h2 = 3144134277 ^ str.length;
    let h3 = 1013904242 ^ str.length;
    let h4 = 2773480762 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [
      (h1 ^ h2 ^ h3 ^ h4) >>> 0,
      (h2 ^ h1) >>> 0,
      (h3 ^ h1) >>> 0,
      (h4 ^ h1) >>> 0
    ];
  }

  /**
   * xorshift128+ PRNG。相同 seed → 相同牌序 → 支持按事件流完整回放。
   * 注意：安全性来自「服务端独占 seed + 事件溯源」，而非算法本身。
   */
  function createRng(seed) {
    let s0, s1, s2, s3;
    if (seed === undefined || seed === null || seed === '') {
      const b = cryptoRandomBytes(16);
      s0 = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
      s1 = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
      s2 = (b[8] | (b[9] << 8) | (b[10] << 16) | (b[11] << 24)) >>> 0;
      s3 = (b[12] | (b[13] << 8) | (b[14] << 16) | (b[15] << 24)) >>> 0;
      if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
    } else {
      const h = hash128(String(seed));
      s0 = h[0] || 1; s1 = h[1] || 2; s2 = h[2] || 3; s3 = h[3] || 4;
    }

    function next() {
      let t = s1 << 9;
      let r = (s0 + s3) >>> 0;
      s2 = (s2 ^ s0) >>> 0;
      s3 = (s3 ^ s1) >>> 0;
      s1 = (s1 ^ s2) >>> 0;
      s0 = (s0 ^ s3) >>> 0;
      s2 = (s2 ^ t) >>> 0;
      s3 = ((s3 << 11) | (t >>> 21)) >>> 0;
      return r;
    }

    next.int = function (maxExclusive) {
      if (maxExclusive <= 0) return 0;
      return next() % maxExclusive;
    };
    next.float = function () { return next() / 4294967296; };
    return next;
  }

  /** Fisher–Yates 洗牌（德州扑克无弃牌 burn card） */
  function shuffle(deck, rng) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  /* ============================================================
   * 三、7 张牌评估器
   * ========================================================== */

  function rankOf(card) { return card >> 2; }   // 0..12 → 2..A
  function suitOf(card) { return card & 3; }    // 0..3 → ♠♣♦♥
  function cardId(rank, suit) { return (rank << 2) | suit; }
  function cardToStr(card) { return RANK_NAMES[rankOf(card)] + SUIT_CHARS[suitOf(card)]; }
  function cardToCode(card) { return RANK_NAMES[rankOf(card)] + SUIT_NAMES[suitOf(card)]; }
  /** 'As' → 牌 id（cardToCode 的逆运算，供快照镜像重建底牌/公共牌） */
  function codeToCard(code) {
    if (typeof code !== 'string' || code.length < 2) return -1;
    const r = RANK_NAMES.indexOf(code[0]);
    const s = SUIT_NAMES.indexOf(code[1]);
    return (r < 0 || s < 0) ? -1 : cardId(r, s);
  }

  /**
   * 从 rank 位掩码找最大顺子，返回最大牌的 rank（0..12），无则 -1。
   * ⚠️ 位运算优先级高于 ===，括号不可省略。
   */
  function findStraightHigh(mask) {
    // 先扫普通窗口（6 高 .. A 高），再兜底轮子顺。
    // ⚠️ 顺序不可颠倒：mask 同时含 {A,2,3,4,5,6} 时存在 5 高轮子与 6 高顺两条，
    // 必须取 6 高；轮子抢先返回会错分底池（同花顺同理）。
    for (let hi = 12; hi >= 4; hi--) {
      if (((mask >> (hi - 4)) & 0x1f) === 0x1f) return hi;
    }
    // 轮子顺 A-2-3-4-5（5 高）：A(12) + rank 0..3 全在；其高位索引 3 不在上方循环范围
    if (((mask & (1 << 12)) !== 0) && ((mask & 0x0f) === 0x0f)) return 3;
    return -1;
  }

  /** 能补成顺子的 rank 集合 */
  function straightOutRanks(mask) {
    const windows = [];
    // 轮子顺：A,2,3,4,5
    windows.push([0, 1, 2, 3, 12]);
    // 6 高 .. A 高
    for (let hi = 4; hi <= 12; hi++) {
      const w = [];
      for (let r = hi - 4; r <= hi; r++) w.push(r);
      windows.push(w);
    }
    const outs = new Set();
    windows.forEach(w => {
      const miss = w.filter(r => ((mask >> r) & 1) === 0);
      if (miss.length === 1) outs.add(miss[0]);
    });
    return outs;
  }

  /**
   * 5~7 张牌评估。
   * @returns {{cat, ranks, best, name, score}}
   */
  function evaluate(cards) {
    const n = cards.length;
    const rankMask = new Array(4).fill(0);
    const rankCount = new Array(13).fill(0);
    const suitCards = [[], [], [], []];

    for (let i = 0; i < n; i++) {
      const c = cards[i];
      rankMask[suitOf(c)] |= (1 << rankOf(c));
      rankCount[rankOf(c)]++;
      suitCards[suitOf(c)].push(c);
    }

    // 同花色集合（7 张牌不可能有两个同花色）
    let flushSuit = -1;
    for (let s = 0; s < 4; s++) if (suitCards[s].length >= 5) { flushSuit = s; break; }

    // ① 同花顺 / 皇家同花顺
    if (flushSuit >= 0) {
      const sfHigh = findStraightHigh(rankMask[flushSuit]);
      if (sfHigh >= 0) {
        return pack(HAND.STRAIGHT_FLUSH, [sfHigh],
          pickStraight(suitCards[flushSuit], sfHigh),
          sfHigh === 12 ? '皇家同花顺' : '同花顺');
      }
    }

    // ② 四条
    const trips = [], pairs = [];
    for (let r = 12; r >= 0; r--) {
      if (rankCount[r] === 4) {
        const q = r;
        const kicker = pickKicker(cards, [q], 1);
        return pack(HAND.QUADS, [q, rankOf(kicker[0])],
          cards.filter(c => rankOf(c) === q).concat(kicker), '四条');
      }
      if (rankCount[r] === 3) trips.push(r);
      else if (rankCount[r] === 2) pairs.push(r);
    }

    // ③ 葫芦（一条三条 + 一对，或两条三条取大者）
    if (trips.length > 0 && (pairs.length > 0 || trips.length > 1)) {
      const tripR = trips[0];
      const pairR = trips.length > 1 ? trips[1] : pairs[0];
      const best = cards.filter(c => rankOf(c) === tripR).slice(0, 3)
        .concat(cards.filter(c => rankOf(c) === pairR).slice(0, 2));
      return pack(HAND.FULL_HOUSE, [tripR, pairR], best, '葫芦');
    }

    // ④ 同花
    if (flushSuit >= 0) {
      const sc = suitCards[flushSuit].slice()
        .sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 5);
      return pack(HAND.FLUSH, sc.map(rankOf), sc, '同花');
    }

    // ⑤ 顺子
    const allMask = rankMask[0] | rankMask[1] | rankMask[2] | rankMask[3];
    const stHigh = findStraightHigh(allMask);
    if (stHigh >= 0) {
      return pack(HAND.STRAIGHT, [stHigh], pickStraight(cards, stHigh), '顺子');
    }

    // ⑥ 三条
    if (trips.length > 0) {
      const t = trips[0];
      const kickers = pickKicker(cards, [t], 2);
      return pack(HAND.TRIPS, [t, rankOf(kickers[0]), rankOf(kickers[1])],
        cards.filter(c => rankOf(c) === t).slice(0, 3).concat(kickers), '三条');
    }

    // ⑦ 两对
    if (pairs.length >= 2) {
      const hi = pairs[0], lo = pairs[1];
      const kickers = pickKicker(cards, [hi, lo], 1);
      const best = cards.filter(c => rankOf(c) === hi).slice(0, 2)
        .concat(cards.filter(c => rankOf(c) === lo).slice(0, 2))
        .concat(kickers);
      return pack(HAND.TWO_PAIR, [hi, lo, rankOf(kickers[0])], best, '两对');
    }

    // ⑧ 一对
    if (pairs.length === 1) {
      const p = pairs[0];
      const kickers = pickKicker(cards, [p], 3);
      return pack(HAND.PAIR, [p, rankOf(kickers[0]), rankOf(kickers[1]), rankOf(kickers[2])],
        cards.filter(c => rankOf(c) === p).slice(0, 2).concat(kickers), '一对');
    }

    // ⑨ 高牌
    const top = cards.slice().sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 5);
    return pack(HAND.HIGH_CARD, top.map(rankOf), top, '高牌');
  }

  function pack(cat, ranks, best, name) {
    const base = [0.06, 0.20, 0.33, 0.46, 0.60, 0.72, 0.84, 0.94, 0.99][cat];
    const detail = ranks.length ? (ranks[0] / 12) : 0;
    const score = Math.min(1, base + (cat >= HAND.STRAIGHT ? detail * 0.01 : detail * 0.10));
    return { cat, ranks, best, name, score };
  }

  /**
   * 挑踢脚牌。返回牌 ID（用于组装 best 五张）。
   * ⚠️ 注意：调用方若要比较维度，必须自行 rankOf()，
   *    否则会把牌 ID 当成 rank 用，导致踢脚比较全错。
   */
  function pickKicker(cards, excludedRanks, n) {
    n = n || 1;
    const excluded = {};
    excludedRanks.forEach(r => { excluded[r] = true; });
    return cards.filter(c => !excluded[rankOf(c)])
      .sort((a, b) => rankOf(b) - rankOf(a))
      .slice(0, n);
  }

  function pickStraight(cards, high) {
    const need = new Set();
    if (high === 3) { [12, 0, 1, 2, 3].forEach(r => need.add(r)); }
    else { for (let r = high - 4; r <= high; r++) need.add(r); }
    const found = [], used = new Set();
    cards.forEach(c => {
      if (need.has(rankOf(c)) && !used.has(c)) { found.push(c); used.add(c); }
    });
    return found.slice(0, 5);
  }

  /** 比较两个评估结果：a 更强返回正数 */
  function compare(a, b) {
    if (a.cat !== b.cat) return a.cat - b.cat;
    const len = Math.max(a.ranks.length, b.ranks.length);
    for (let i = 0; i < len; i++) {
      const ra = a.ranks[i] === undefined ? -1 : a.ranks[i];
      const rb = b.ranks[i] === undefined ? -1 : b.ranks[i];
      if (ra !== rb) return ra - rb;
    }
    return 0;
  }

  /** 压成可比较的大整数（用于快速排序） */
  function rankEval(e) {
    let v = e.cat * 1e9;
    for (let i = 0; i < 6; i++) {
      v += (e.ranks[i] === undefined ? 0 : (e.ranks[i] + 1)) * Math.pow(20, 5 - i);
    }
    return v;
  }

  /* ============================================================
   * 四、边池计算
   * ========================================================== */

  /**
   * 平分零头的派发序：按钮左一位（本手首个行动者）优先，按钮本人排最后。
   * TDA 规则：奇数筹码给「离按钮左侧最近、仍在手内的玩家」。
   * dist=0 是按钮本人 → 排队尾；其余按距按钮行动序升序。
   * seats 必须是升序座位号列表（showdown 处已按此构造，可直接复用）。
   */
  function oddChipOrder(ties, dealerSeat, seats) {
    const n = seats.length;
    const key = s => {
      const d = (seats.indexOf(s) - seats.indexOf(dealerSeat) + n) % n;
      return d === 0 ? n : d - 1;
    };
    return ties.slice().sort((a, b) => key(a) - key(b));
  }

  /**
   * 按承诺额分层切分边池，并合并「资格集合完全相同」的相邻层。
   * 例：A 承诺 100、B 承诺 300、C 全下 50
   *   → 主池 150（A/B/C）  +  边池 300（A/B）
   */
  function buildSidePots(players) {
    const levels = [];
    players.forEach(p => {
      if (p.committed > 0 && levels.indexOf(p.committed) === -1) levels.push(p.committed);
    });
    levels.sort((a, b) => a - b);

    const raw = [];
    let prev = 0;
    for (let i = 0; i < levels.length; i++) {
      const lv = levels[i];
      let amount = 0;
      const contribs = {};
      players.forEach(p => {
        const slice = Math.min(p.committed, lv) - Math.min(p.committed, prev);
        if (slice > 0) { contribs[p.seat] = (contribs[p.seat] || 0) + slice; amount += slice; }
      });
      const eligible = players
        .filter(p => !p.folded && p.committed >= lv)
        .map(p => p.seat).sort((a, b) => a - b);
      // 有出资的层一律保留（含资格为空的异常层）：由摊牌/结算侧的防御性退款
      // 按出资原路退回，绝不允许整层随资格判断被静默丢弃 → 筹码凭空蒸发。
      if (amount > 0) {
        raw.push({ amount, eligible, contribs, level: lv });
      }
      prev = lv;
    }

    // 合并相邻且资格相同的层（分层算法会为同一资格集合切成多层）。
    // ⚠️ contribs 必须同步累加——退款兜底按出资退回时口径才对得上。
    const merged = [];
    raw.forEach(pot => {
      const last = merged[merged.length - 1];
      if (last && last.eligible.length === pot.eligible.length &&
        last.eligible.every((s, i) => s === pot.eligible[i])) {
        last.amount += pot.amount;
        last.level = pot.level;
        Object.keys(pot.contribs).forEach(s => {
          last.contribs[s] = (last.contribs[s] || 0) + pot.contribs[s];
        });
      } else {
        merged.push({
          amount: pot.amount, eligible: pot.eligible.slice(),
          contribs: Object.assign({}, pot.contribs), level: pot.level
        });
      }
    });
    return merged;
  }

  /* ============================================================
   * 五、牌力分析：听牌与胜率
   * ========================================================== */

  /**
   * 听牌检测：返回 { outs, desc }
   * outs = 能直接成牌的补牌数。同花按「张」计，顺子按「点数」计，
   * 同时存在时对重叠部分保守扣减（宁可低估也不高估）。
   */
  function detectDraws(hole, board) {
    if (!hole || hole.length < 2) return { outs: 0, desc: '' };
    if (!board || board.length < 3) return { outs: 0, desc: '' };

    // 已成牌（顺子及以上）不再报听牌
    const made = evaluate(hole.concat(board));
    if (made.cat >= HAND.STRAIGHT) return { outs: 0, desc: made.name };

    const all = hole.concat(board);
    const known = {};
    all.forEach(card => { known[card] = 1; });

    const suitCount = [0, 0, 0, 0];
    let mask = 0;
    all.forEach(card => { suitCount[suitOf(card)]++; mask |= (1 << rankOf(card)); });

    const flags = [];
    let outs = 0;
    const outCards = {};

    // 同花听牌：某花色已出现 4 张，其余 9 张同花色均为补牌
    let flushSuit = -1;
    for (let s = 0; s < 4; s++) if (suitCount[s] === 4) { flushSuit = s; break; }
    if (flushSuit >= 0) {
      for (let card = 0; card < 52; card++) {
        if (suitOf(card) === flushSuit && !known[card]) outCards[card] = 1;
      }
      flags.push('同花听牌');
    }

    // 顺子听牌：补齐某条顺子所缺的点数（该点数 4 张均为补牌）
    const stOuts = straightOutRanks(mask);
    stOuts.forEach(r => {
      for (let s = 0; s < 4; s++) {
        const card = cardId(r, s);
        if (!known[card]) outCards[card] = 1;
      }
    });
    if (stOuts.size > 0) {
      flags.push(stOuts.size >= 3 ? '两头顺听牌'
        : (stOuts.size === 2 ? '两头卡顺' : '卡顺听牌'));
    }

    // 对子补牌（2026-10-17 评审补充：原先只算同花/顺子，一对永远显示「无听牌」）。
    // 仅处理到对子为止的成牌（上方已排除顺子及以上，剩下只可能是 PAIR/HIGH）。
    if (made.cat === HAND.PAIR) {
      const pairRank = made.ranks[0];
      const holePair = rankOf(hole[0]) === rankOf(hole[1]);
      const boardHasPair = board.some(c => rankOf(c) === pairRank);
      if (holePair && !boardHasPair) {
        // 纯口袋对：自身点数剩 2 张 → 三条/四条
        for (let s = 0; s < 4; s++) {
          const card = cardId(rankOf(hole[0]), s);
          if (!known[card]) outCards[card] = 1;
        }
        flags.push('口袋对听三条');
      } else {
        // 底对/中对（一张底牌与公共牌成对）：自身点数 + 2 张踢脚 → 两对/三条
        const pairHole = rankOf(hole[0]) === pairRank ? hole[0] : hole[1];
        const other = rankOf(hole[0]) === pairRank ? hole[1] : hole[0];
        [pairRank, rankOf(other)].forEach(r => {
          if (r < 0) return;
          for (let s = 0; s < 4; s++) {
            const card = cardId(r, s);
            if (!known[card]) outCards[card] = 1;
          }
        });
        void pairHole;   // 仅为可读性保留
        flags.push('底对听两对/三条');
      }
    }

    return { outs: Math.min(Object.keys(outCards).length, 15), desc: flags.join(' + ') };
  }

  /**
   * 蒙特卡洛胜率。
   *
   * 实现要点（易错处）：
   *  1. 每次迭代必须「重新洗整副剩余牌」，不能用固定的前缀 ——
   *     否则公共牌与对手手牌会取到同一批牌，导致胜率虚高。
   *  2. 分配顺序：先给对手发手牌，再补公共牌；两者取自同一次洗牌
   *     的不同区间，因此互不重叠。
   *  3. hole 必须恰好 2 张，board 0~5 张，超出即抛错（避免静默算错）。
   *
   * @param {number[]} hole 手牌，必须 2 张
   * @param {number[]} board 公共牌 0~5 张
   * @param {number} opponents 有效对手数
   * @param {number} iters 迭代次数
   */
  function quickEquity(hole, board, opponents, iters, rng) {
    if (!hole || hole.length !== 2) {
      throw new Error('quickEquity: 手牌必须恰好 2 张，实际 ' + (hole ? hole.length : 0));
    }
    if (!board || board.length > 5) {
      throw new Error('quickEquity: 公共牌最多 5 张，实际 ' + (board ? board.length : 0));
    }
    opponents = opponents || 0;
    iters = iters || 1500;
    rng = rng || createRng();

    if (opponents <= 0) {
      return { equity: 1, winRate: 1, iters: 0, ms: 0 };
    }

    // 用 Uint8Array 标记已用牌，避免对象键查找的隐式字符串转换
    const used = new Uint8Array(52);
    hole.forEach(c => { used[c] = 1; });
    board.forEach(c => { used[c] = 1; });
    const rest = [];
    for (let c = 0; c < 52; c++) if (!used[c]) rest.push(c);

    const need = 2 * opponents + (5 - board.length);
    let win = 0, tie = 0;
    const t0 = Date.now();

    // 预分配池跨迭代复用：rest 只读不改（固定未用牌序），每迭代开头用复制循环把
    // rest 灌回 pool 复位到洗牌前干净态，再原地 Fisher-Yates。省去每迭代分配 ~50
    // 元素数组的开销（蒙特卡洛内层热路径：AI 翻牌后 800 iter、建议 1800 iter）。
    // 不变性：每迭代复位后 pool 起态完全一致 → 同 seed 同 rng 同结果（确定性回放）。
    const pool = rest.slice();
    for (let it = 0; it < iters; it++) {
      // 复位：把 rest 重新灌回 pool（pool 上轮已洗乱，需还原成 rest 的有序态）
      for (let i = 0; i < pool.length; i++) pool[i] = rest[i];
      for (let i = 0; i < need && i < pool.length; i++) {
        const j = i + rng.int(pool.length - i);
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }

      // 区间划分：前 2*opponents 张发给对手，其后补齐公共牌
      const fullBoard = board.concat(pool.slice(2 * opponents, need));
      const myRank = rankEval(evaluate(hole.concat(fullBoard)));

      let oppBest = -1, oppTies = 0;
      for (let o = 0; o < opponents; o++) {
        const r = rankEval(evaluate([pool[o * 2], pool[o * 2 + 1]].concat(fullBoard)));
        if (r > oppBest) { oppBest = r; oppTies = 1; }
        else if (r === oppBest) oppTies++;
      }
      if (myRank > oppBest) win++;
      else if (myRank === oppBest) tie += 1 / (oppTies + 1);
    }

    return { equity: (win + tie) / iters, winRate: win / iters, iters, ms: Date.now() - t0 };
  }

  /* ============================================================
   * 六、AI 决策
   * ========================================================== */

  /** 翻牌前起手牌打分（0~40+，越大越强）。
   *  ⚠️ rank 索引表：0='2' … 12='A'（见文件头），A 是 12 号不是 0 号。
   *  历史事故（评审 2026-10-15）：这里曾写 `if (r1===0) v=4` 注释「A」——
   *  实际命中的是 deuce；三条 A/K/Q 分支全是死代码或错位降分。
   *  现统一为「点数越高牌越强」单调映射，无人为特判。 */
  function preflopScore(hole, opts) {
    opts = opts || {};
    const r1 = Math.max(rankOf(hole[0]), rankOf(hole[1]));
    const r2 = Math.min(rankOf(hole[0]), rankOf(hole[1]));
    const suited = suitOf(hole[0]) === suitOf(hole[1]);
    let score;
    if (r1 === r2) {
      // 口袋对：所有对子按点数单调递增（A 对最强）
      score = 10 + r1 * 2.2;
    } else {
      // 高牌为主体：A=12 → 24 分起步，与 K=22、Q=20 拉开档位
      let v = r1 * 2;
      const gap = r1 - r2 - 1;
      if (gap === 1) v -= 1;
      else if (gap === 2) v -= 2;
      else if (gap === 3) v -= 4;
      else if (gap >= 4) v -= 5;
      if (suited) v += 2;
      if (r2 >= 10 && r1 - r2 <= 2) v += 1;   // 双高张（Q 以上连张）略加分
      score = v;
    }
    score += (opts.positionFactor || 0) * 12;
    return score;
  }

  /**
   * AI 决策：返回 { action, amount, reason }
   * style = { aggro 0~1, tight 0~1, bluffFreq 0~1|null, bluffSize 0~1, heroCall 0~1, slowplay 0~1 }
   * 扩展字段全部有默认兜底，仅传 {aggro,tight} 时行为与旧实现完全一致。
   */
  function aiDecide(ctx) {
    const hole = ctx.hole;
    const board = ctx.board || [];
    const pot = ctx.pot || 0;
    const toCall = ctx.toCall || 0;
    const stack = ctx.stack || 0;
    const currentBet = ctx.currentBet || 0;
    const numActive = ctx.numActive || 2;
    const positionFactor = ctx.positionFactor || 0;
    const style = ctx.style || {};
    const aggressive = style.aggro !== undefined ? style.aggro : 0.5;
    const tight = style.tight !== undefined ? style.tight : 0.5;
    const rnd = ctx.rng || Math.random;
    const rndFloat = function () {
      // 优先用注入 rng 的 .float（xorshift128+ 全周期均匀）；退化（Math.random）走原生
      const r = ctx.rng;
      return r && typeof r.float === 'function' ? r.float() : Math.random();
    };
    // 人格化扩展字段（均有默认兜底，旧 style:{aggro,tight} 调用行为完全不变）：
    // bluffFreq  诈唬频率门槛，null 时退回 aggressive*0.35/0.28 的原固定系数
    // bluffSize  诈唬加注尺度 0~1（小=试探，大=重锤），默认 0.5 时加注量与旧实现一致
    // heroCall   英雄跟注概率——赔率不划算时仍跟一手的反诈唬倾向，默认 0 永不触发
    // slowplay   慢打概率——强牌翻后过牌诱敌，默认 0 永不触发
    const bluffFreq = style.bluffFreq !== undefined ? style.bluffFreq : null;
    const bluffSize = style.bluffSize !== undefined ? style.bluffSize : 0.5;
    const heroCall = style.heroCall !== undefined ? style.heroCall : 0;
    const slowplay = style.slowplay !== undefined ? style.slowplay : 0;

    // 引擎给出的合法加注区间。调用方（table.js scheduleAI / 压力测试）都会传入。
    // ⚠️ 退化路径（未传 minRaiseTo）下引擎的真实最小加注额无从得知——它源自
    // 「上一手加注增量」而非大盲，按大盲估算必然错位（评审 2026-10-15 实测
    // 3000 局退化路径 282 次 RAISE 被引擎拒绝）。因此退化路径一律不返回 RAISE，
    // 由 raiseDecision 走全下/跟注兜底——二者无需区间即可保证合法。
    // ctx.canRaise=false（被不足额全下封锁）时同理转跟注/全下。
    const hasRange = ctx.minRaiseTo !== undefined;
    const minRaiseTo = ctx.minRaiseTo || 0;
    const maxRaiseTo = Math.min(ctx.maxRaiseTo !== undefined ? ctx.maxRaiseTo : stack, stack);

    /**
     * 把「理想加注额」夹取到合法区间。
     * ⚠️ 必须夹取：引擎 act() 会严格拒绝非法加注额，
     *    若 AI 给出越界值会导致行动失败、牌局卡死。
     *    无加注权（canRaise=false，被不足额全下封锁）时不得加注。
     */
    const raiseDecision = function (desiredTo, reason) {
      if (ctx.canRaise === false || !hasRange) {
        // 加注权被封锁（他人不足额全下）/ 退化路径无合法区间：
        // 不加注，跟注或跟注全下二选一（均无需区间即可保证合法）。
        // ⚠️ 被封锁时全下仅在「跟注全下」（筹码追不上跟注额）时合法——
        //    act() 对 target > currentBet 的全下一律拒绝（2026-10-17 闸门）。
        if (ctx.canRaise === false) {
          if (stack > 0 && stack <= toCall) {
            return { action: ACTION.ALLIN, amount: stack, reason: reason + '（加注被封锁，跟注全下）' };
          }
          return { action: ACTION.CALL, amount: toCall, reason: reason + '（加注被封锁，跟注）' };
        }
        if (stack > 0 && maxRaiseTo > currentBet) {
          return { action: ACTION.CALL, amount: toCall, reason: reason + '（无合法区间，降级跟注）' };
        }
        return { action: ACTION.CALL, amount: toCall, reason: reason + '（降级跟注）' };
      }
      if (maxRaiseTo <= currentBet) {
        // 已无加注空间 → 只能全下或跟注
        if (stack > 0) return { action: ACTION.ALLIN, amount: stack, reason: reason + '（加注空间不足，转全下）' };
        return { action: ACTION.CALL, amount: toCall, reason };
      }
      let target = Math.round(desiredTo);
      if (target >= maxRaiseTo) {
        return { action: ACTION.ALLIN, amount: stack, reason: reason + '（已达上限，转全下）' };
      }
      if (target < minRaiseTo) target = minRaiseTo;
      return { action: ACTION.RAISE, amount: target, reason };
    };

    if (!hole || hole.length < 2) return { action: ACTION.CHECK, amount: 0, reason: '无手牌' };

    const holeStrength = preflopScore(hole, { positionFactor });

    // ---- 翻牌前 ----
    if (board.length === 0) {
      // 阈值 23（原 26）：原值下中位风格 VPIP 不足两成，全员 limp 观感「机器人」。
      //
      // ⚠️⚠️ 方向曾经写反（2026-10-19 资深玩家 review 发现）：旧式子是
      //     threshold = 23 - tight * 10
      // tight 越大门槛越低 → 「紧」的 bot 反而打得更松，五个 bot 人格
      // （陈默「专等好牌」tight=0.72 入池 ≈90%）与实际打法完全相反；
      // 连带把《专家难度读人反制》的意图也翻了过来（玩家越松 bot 越送）。
      // 现改为 13 + tight * 10 —— **锚定在 tight=0.5 仍是 18/23 的原值不变**，
      // 只把 tight 的影响方向纠正过来：
      //   tight=0.0 → 13（松，宽入池） 0.5 → 18（中位，调参原值） 1.0 → 23（紧）
      // 同时 bar 有下限 6：极松人格在小底池里不会因 potOdds 系数把门槛压到
      // 负数（负门槛会让「任何两张都加注」，那就不是打牌了）。
      const threshold = 13 + tight * 10;
      const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
      // 跟注占筹码比例的压力项（2026-10-19 资深玩家 review）。
      // 病根：旧实现只看 potOdds，而 potOdds 是「跟注 / 底池」——底池一旦被
      // 前面的人做大（实测 pot>320 时约占 20% 的翻前决策），potOdds 反而变小、
      // 门槛被压低，AI 弃牌率从 ~26% 掉到 7%，拿任何两张都跟。真人不会这样：
      // 要跟 400 才能看翻牌和要跟 20，凭的是「这笔钱占我筹码多少」。
      // 故叠加 stackPressure = toCall / stack（0.04 → 无压力，0.25 → 极限），
      // 把门槛抬到最多 +6 分：短码/大注面前必须真是好牌才跟。
      const stackPressure = (toCall > 0 && stack > 0) ? Math.min(1, toCall / stack / 0.25) : 0;
      // 收带项 2 + tight * 3（2026-10-19 第二轮调参）：stackPressure 只对「跟注吃筹码」
      // 的场景生效，但旧口径下各档入池率整体仍远高于真人（中位 78%、极松 92%
      // ≈「任何两张都打」，AI 对打时牌桌几乎无人弃牌）。此项给所有风格加一道基本纪律：
      //   tight=0 → +2（仍有底线，不至于见牌就跟） tight=0.5 → +3.5 tight=1 → +5
      // ⚠️ 试过更强的 3 + tight*2（入池再降 3~6 个点），但把 AQs 从加注降级成跟注、
      // 66/A5o 从跟注变成弃牌，破坏了 A5+D1 那轮定下的行为契约，故取此档。
      // 实测（真实 4 人桌）：tight 1.0→26.8% 0.72→47.0% 0.5→64.0% 0.28→72.8% 0→85.8%
      const bar = Math.max(6, threshold * (1 - potOdds * 0.45) + stackPressure * 6 + 2 + tight * 3);

      // 加注锋线 bar+7（原 +12）：原锋线高于 AA/KK 之外的一切起手分（QQ/AK 全 limp），
      // 收窄至 +7 让中高对与 AK 进入价值加注区（2026-10-17 评审调参）。
      if (holeStrength >= bar + 7) {
        return raiseDecision(
          Math.max(toCall + currentBet * 2, Math.round(pot * 0.75 + currentBet)),
          '强起手加注'
        );
      }
      if (holeStrength >= bar) {
        if (toCall === 0) return { action: ACTION.CHECK, amount: 0, reason: '免费看牌' };
        // 诈唬抢池：bluffFreq 覆盖默认 aggressive*0.35 系数，bluffSize 调加注尺度
        if (rnd() < (bluffFreq !== null ? bluffFreq : aggressive * 0.35)) {
          const scale = 2.2 + bluffSize * 1.6;   // 0.5→2.2，1.0→3.8
          return raiseDecision(Math.max(currentBet * scale, toCall * 4 + currentBet), '抢池 / 诈唬');
        }
        return { action: ACTION.CALL, amount: toCall, reason: '价格可接受，跟注' };
      }
      if (toCall === 0) return { action: ACTION.CHECK, amount: 0, reason: '过牌看翻牌' };
      // 大盲便宜防守：跟随额 ≤ 池 12%。⚠️ 实测该分支在当前底池结构下**几乎never触发**
      // （BB 跟 20 进 30 的池 → 20 > 3.6，条件就不成立），所以入池率并不受它的宽容带
      // 影响 —— 之前把这里从 -9 改成随 tight 收窄，实测数值一格没动，已回滚保持原样。
      // 真正决定入池率的是上面的 threshold 与 bar。
      if (toCall <= pot * 0.12 && holeStrength >= bar - 9) {
        return { action: ACTION.CALL, amount: toCall, reason: '大盲便宜防守' };
      }
      return { action: ACTION.FOLD, amount: 0, reason: '起手强度不足' };
    }

    // ---- 翻牌后：蒙特卡洛胜率 + 赔率决策 ----
    // rng 口径（玩家审视 2026-10-17）：翻后蒙特卡洛优先用 ctx.rng（调用方注入，
    // 种子可复现——同 seed 同动作序列 → 同决策，事件溯源回放时 AI 分叉路径可
    // 逐位还原）；未注入时退回 createRng()（随机种子），与旧实现兼容。
    const mcRng = ctx.rng || createRng();
    // AI 蒙特卡洛精度 800 iter（原 420，std≈±1.7%）：AI 表演延迟 620ms+ 远盖计算增量，
    // 拉近与 advise（1800）的口径差，减少「教练建议跟、同胜率 AI 弃」的矛盾观感。
    const equity = quickEquity(hole, board, Math.max(1, numActive - 1), 800, mcRng).equity;
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    const draw = detectDraws(hole, board);

    // 下注尺度因子（玩家审视 2026-10-17）：对手本次下注相对底池的越大，同样的
    // 胜率越不值跟——「用尺度讲故事」从此对 AI 有效（旧实现无论我下多重的注，
    // 它的 call/fold 线都纹丝不动）。betRatio = toCall / pot（pot 是我决策时点
    // 的池面）：pot 大小注 betRatio≈0.5、池级 ≈1、两倍超池 ≈2。把这条因子叠加到
    // 「跟注所需胜率」上：重注要求更高胜率才跟（阈值收紧 0~0.12），小注放宽
    // 0~0.04。加注线（价值加注 0.66）不吃因子——加注本就是对重注的反抗，
    // 强牌不该因为对手下得重就不加注。
    const betRatio = pot > 0 ? toCall / pot : 0;
    // 0（池级以下）→0；1（池级）→+0.03；2（两倍超池）→+0.09；线形收敛上限 0.12
    const sizeAdj = Math.max(-0.04, Math.min(0.12, (betRatio - 0.5) * 0.06));

    if (toCall === 0) {
      if (equity > 0.72 || (draw.outs >= 8 && equity > 0.42)) {
        // 慢打诱敌：强牌按概率过牌喂对手一手，诱其下注后再反加。仅可过牌时触发
        // （toCall===0，否则在跟注/加注分支）。默认 slowplay=0 永不触发，行为不变。
        if (rndFloat() < slowplay) return { action: ACTION.CHECK, amount: 0, reason: '慢打诱敌' };
        return raiseDecision(
          Math.max(currentBet * 2, Math.round(pot * (0.5 + aggressive * 0.35))),
          '价值下注'
        );
      }
      return { action: ACTION.CHECK, amount: 0, reason: '控池过牌' };
    }

    if (equity > 0.66) {
      return raiseDecision(currentBet * (1.7 + aggressive * 0.6), '价值加注');
    }
    if (equity > potOdds + 0.06 + sizeAdj) {
      // 半诈唬：bluffFreq 覆盖默认 aggressive*0.28 系数
      if (rndFloat() < (bluffFreq !== null ? bluffFreq : aggressive * 0.28) && equity > 0.45) {
        return raiseDecision(currentBet * 2.1, '半诈唬加注');
      }
      return { action: ACTION.CALL, amount: toCall, reason: '赔率合理，跟注' };
    }
    if (draw.outs >= 8 && toCall <= pot * 0.25 && equity > 0.22) {
      return { action: ACTION.CALL, amount: toCall, reason: '听牌隐含赔率好' };
    }
    // 英雄跟注：赔率不划算但按概率仍跟一手（反诈唬倾向）。默认 heroCall=0 永不触发。
    if (rndFloat() < heroCall && toCall <= stack) {
      return { action: ACTION.CALL, amount: toCall, reason: '英雄跟注' };
    }
    return { action: ACTION.FOLD, amount: 0, reason: '成牌率不划算' };
  }

  /* ============================================================
   * 七、行动建议（合规敏感）
   * ========================================================== */

  /**
   * ⚠️ 合规提示：真实竞技对局中向玩家实时输出行动建议，
   *    可能被平台判定为「外挂 / 场外交易辅助」。
   *    建议仅在「练习模式」启用，或改为纯统计反馈。
   */
  function advise(game, seat, opts) {
    // 合规开关（README 第 0.3 节）：行动建议属实时辅助，竞技房（好友房/匹配）
    // 必须关闭。默认不返回任何建议 —— 调用方必须显式传 { practiceMode: true }
    // 才输出，防止新调用点无意间在竞技对局中启用。
    if (!opts || opts.practiceMode !== true) return null;
    const p = game.seatOf(seat);
    if (!p) return null;
    const legal = game.legalActions(seat);
    const board = game.board;
    const numActive = game.activePlayers().length;
    const eq = quickEquity(p.hole, board, Math.max(1, numActive - 1), 1800, createRng());
    const draw = detectDraws(p.hole, board);
    const pot = game.potTotal();
    const potOdds = legal && legal.toCall > 0 ? legal.toCall / (pot + legal.toCall) : 0;
    const ep = (eq.equity * 100).toFixed(1) + '%';
    const pp = (potOdds * 100).toFixed(1) + '%';

    let text, tone;
    if (!legal || legal.toCall === 0) {
      tone = eq.equity > 0.65 ? 'strong' : 'neutral';
      text = eq.equity > 0.65
        ? `胜率 ${ep}，牌力占优，可考虑价值下注扩大战果`
        : `胜率 ${ep}，建议过牌看水，避免无谓投入`;
    } else if (eq.equity > potOdds + 0.12) {
      tone = 'strong';
      text = `胜率 ${ep} 高于所需赔率 ${pp}，可跟注${eq.equity > 0.72 ? '，强牌建议加注' : ''}`;
    } else if (draw.outs >= 8) {
      tone = 'draw';
      text = `${draw.desc}，约 ${draw.outs} 张补牌，隐含赔率合适可跟注`;
    } else if (eq.equity < potOdds * 0.6) {
      tone = 'weak';
      text = `胜率 ${ep} 低于所需赔率 ${pp}，建议弃牌`;
    } else {
      tone = 'neutral';
      text = `胜率 ${ep} 与赔率 ${pp} 接近，按个人风格决定`;
    }

    return {
      seat, equity: eq.equity, equityPct: ep,
      potOdds: pp, draws: draw,
      text, tone, iters: eq.iters, computeMs: eq.ms
    };
  }

  /* ============================================================
   * 八、牌局引擎
   * ========================================================== */

  function createGame(cfg) {
    const players = cfg.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      seat: p.seat !== undefined ? p.seat : i,
      stack: p.stack,
      isHuman: !!p.isHuman,
      style: p.style || {
        aggro: 0.35 + Math.random() * 0.45,
        tight: 0.30 + Math.random() * 0.45
      },
      // 运行时
      hole: [], folded: false, allIn: false,
      bet: 0, committed: 0,
      actedBet: null, canRaise: true, sittingOut: false,
      // 统计
      hands: 0, net: 0
    }));

    const game = {
      players,
      sb: cfg.sb || 10,
      bb: cfg.bb || 20,
      dealerSeat: cfg.dealerSeat || 0,
      seed: cfg.seed,
      rng: createRng(cfg.seed),

      deck: [], board: [],
      pots: [], totalPot: 0,
      street: STREET.PREFLOP,
      currentBet: 0,
      minRaise: cfg.bb || 20,
      lastAggressor: null,
      actionSeat: -1,
      handNo: 0,
      log: [], events: [],
      result: null, over: false,
      showdownReveal: {}
    };

    game.logMsg = function (text, kind) {
      game.log.push({ t: Date.now(), text, kind: kind || 'info' });
      if (game.log.length > 300) game.log.shift();
    };

    game.emit = function (evt) {
      evt.handNo = game.handNo;
      evt.seq = game.events.length;
      game.events.push(Object.freeze(evt));
      return evt;
    };

    game.seatOf = seat => game.players.find(p => p.seat === seat);
    game.activePlayers = () => game.players.filter(p => !p.folded && !p.sittingOut);
    game.inHandPlayers = () => game.players.filter(p => !p.sittingOut);
    game.potTotal = () => game.totalPot + game.players.reduce((s, p) => s + p.bet, 0);

    /* -------- 开新一手 -------- */
    game.startHand = function () {
      if (game.over) return { ok: false, error: '牌局已结束' };

      // events 封顶（手边界）：跨手累积的旧事件只用于复盘回看，保留最近 MAX_EVENTS
      // 条即可。截断发生在新手开始前、本手事件尚未 emit，绝不切到进行中的当前手。
      // 截断后 drainSfx 的 sfxSeq 超界收敛（sfxSeq > length → sfxSeq = length）自动
      // 适配，replay-store 从后向前找最后一个 hand_start 必落在保留段内。
      if (game.events.length > MAX_EVENTS) {
        game.events.splice(0, game.events.length - MAX_EVENTS);
      }

      game.players.forEach(p => {
        p.hole = []; p.folded = false; p.allIn = false;
        p.bet = 0; p.committed = 0; p.actedBet = null; p.canRaise = true;
        // 0 筹码不参与本手：不发牌、不进行动轮、不参与摊牌——否则一手 check 到底
        // 就能 0 成本白抢池（评审 2026-10-15 MEDIUM）。不走 sittingOut：那是
        // 「站起观战」的跨手语义（由坐下动作清除），这里借用 folded 更安全——
        // 演示态补筹（table.js 每手把 <20 拉回 1000）后下一手自然复位重新入局。
        if (p.stack <= 0) p.folded = true;
      });
      game.board = [];
      game.totalPot = 0;
      game.pots = [];
      game.result = null;
      game.showdownReveal = {};
      game.street = STREET.PREFLOP;
      game.handNo++;
      game.currentBet = 0;
      game.minRaise = game.bb;
      game.lastAggressor = null;

      game.deck = [];
      for (let c = 0; c < 52; c++) game.deck.push(c);
      shuffle(game.deck, game.rng);

      const seats = game.inHandPlayers().map(p => p.seat).sort((a, b) => a - b);
      if (seats.length < 2) {
        game.over = true;
        game.logMsg('不足 2 名玩家，牌局结束', 'warn');
        return { ok: false, error: 'not enough players' };
      }

      // 按钮轮转
      const dIdx = seats.indexOf(game.dealerSeat);
      const btnSeat = dIdx === -1 ? seats[0] : seats[(dIdx + 1) % seats.length];
      game.dealerSeat = btnSeat;

      const order = [];
      for (let i = 0; i < seats.length; i++) order.push(seats[(seats.indexOf(btnSeat) + i) % seats.length]);
      // 小盲/大盲：三人及以上 = 按钮左一/左二；两人局（heads-up）庄家即小盲，另一人大盲
      const sbSeat = seats.length === 2 ? btnSeat : order[1 % order.length];
      const bbSeat = seats.length === 2 ? order[1 % order.length] : order[2 % order.length];
      game.sbSeat = sbSeat;
      game.bbSeat = bbSeat;

      const postBlind = (seat, amount) => {
        const p = game.seatOf(seat);
        const put = Math.min(amount, p.stack);
        p.bet = put; p.committed = put; p.stack -= put;
        if (p.stack === 0) p.allIn = true;
        game.currentBet = Math.max(game.currentBet, put);
        return put;
      };
      const sbPaid = postBlind(sbSeat, game.sb);
      const bbPaid = postBlind(bbSeat, game.bb);

      // 发底牌：从按钮左手第一位开始，每人两张，轮两轮。
      // 0 筹码座位刚在上面被标 folded（不参与本手）→ 跳过发牌，保持
      // 「不过牌桌成本」的语义（发了他反而会在 UI 渲染出两张看不见的暗牌）。
      const dealStart = seats.indexOf(btnSeat);
      for (let round = 0; round < 2; round++) {
        for (let k = 1; k <= seats.length; k++) {
          const seat = seats[(dealStart + k) % seats.length];
          const dp = game.seatOf(seat);
          if (!dp.folded) dp.hole.push(game.deck.pop());
        }
      }

      game.logMsg(`—— 第 ${game.handNo} 手 · ${STREET_CN.preflop} ——`);
      game.logMsg(`庄家位 座位${btnSeat}｜小盲 ${sbPaid}｜大盲 ${bbPaid}`, 'dim');
      game.emit({ type: 'hand_start', btn: btnSeat, sb: sbSeat, bb: bbSeat });

      const canActCount = game.activePlayers().filter(p => !p.allIn).length;
      game.minRaise = game.bb;
      game.lastAggressor = null;

      if (canActCount <= 1) {
        // 盲注双全下特例：仍有「有筹码且欠注」的非全下玩家时不得跳过——
        // 他有权决定补齐跟注（2026-10-17 评审：原逻辑静默剥夺第三家跟注权）。
        const owes = game.players.some(p =>
          !p.folded && !p.sittingOut && !p.allIn && p.stack > 0 && p.bet < game.currentBet);
        if (!owes) return skipToShowdown('仅一名可行动玩家，直接发完公共牌');
        // owes 为真时掉落到下方行动位寻找，让欠注者把 call/fold 走完；
        // 其行动后 advance 的同名检查会接管后续跳街。
      }
      // 翻牌前：从大盲左手第一位开始（若该位已全下/弃牌，顺移到下一个可行动的人）
      const bbIdx = order.indexOf(bbSeat);
      game.actionSeat = -1;
      for (let k = 1; k <= order.length; k++) {
        const cand = order[(bbIdx + k) % order.length];
        const p = game.seatOf(cand);
        if (p && !p.folded && !p.allIn) { game.actionSeat = cand; break; }
      }
      if (game.actionSeat === -1) {
        return skipToShowdown('仅一名可行动玩家，直接发完公共牌');
      }
      game.emit({ type: 'turn', seat: game.actionSeat });
      return { ok: true, actionSeat: game.actionSeat, street: game.street };
    };

    /* -------- 合法性 -------- */
    game.legalActions = function (seat) {
      const p = game.seatOf(seat);
      if (!p || p.folded || p.allIn || p.sittingOut) return null;
      const toCall = Math.min(Math.max(0, game.currentBet - p.bet), p.stack);
      const res = {
        seat, toCall, callAmount: toCall,
        canFold: true,
        canCheck: toCall === 0,
        canCall: toCall > 0,
        canRaise: false,
        canAllIn: p.stack > 0,
        minRaiseTo: 0, maxRaiseTo: 0
      };
      const maxTo = p.bet + p.stack;
      if (p.canRaise && maxTo > game.currentBet) {
        res.canRaise = true;
        res.minRaiseTo = Math.min(game.currentBet + game.minRaise, maxTo);
        res.maxRaiseTo = maxTo;
      }
      return res;
    };

    /* -------- 玩家行动 -------- */
    game.act = function (seat, action, amount) {
      if (game.over) return { ok: false, error: '牌局已结束' };
      if (game.actionSeat !== seat) {
        return { ok: false, error: `当前应由座位 ${game.actionSeat} 行动` };
      }
      const p = game.seatOf(seat);
      const legal = game.legalActions(seat);
      if (!legal) return { ok: false, error: '该玩家当前无法行动' };
      amount = Math.floor(Number(amount) || 0);

      switch (action) {
        case ACTION.FOLD:
          p.folded = true;
          game.logMsg(`座位${seat} ${p.name} 弃牌`);
          game.emit({ type: 'action', seat, action: ACTION.FOLD, amount: 0 });
          break;

        case ACTION.CHECK:
          if (!legal.canCheck) return { ok: false, error: '当前需跟注，无法过牌' };
          game.logMsg(`座位${seat} ${p.name} 过牌`);
          game.emit({ type: 'action', seat, action: ACTION.CHECK, amount: 0 });
          break;

        case ACTION.CALL: {
          const put = legal.toCall;
          const shortAllIn = put < (game.currentBet - p.bet);
          p.bet += put; p.stack -= put; p.committed += put;
          if (p.stack === 0) p.allIn = true;
          game.logMsg(`座位${seat} ${p.name} ${p.allIn ? '全下' : '跟注'} ${put}${shortAllIn ? '（不足额）' : ''}`);
          game.emit({ type: 'action', seat, action: p.allIn ? ACTION.ALLIN : ACTION.CALL, amount: put });
          break;
        }

        case ACTION.RAISE:
        case ACTION.ALLIN: {
          let target;
          if (action === ACTION.ALLIN) {
            target = p.bet + p.stack;
            // 加注权被不足额全下封锁时，只允许「纯跟注全下」（总承诺额不超当前注）。
            // 若全下额超过 currentBet 即为变相加注，按 TDA 规则已行动玩家只能跟注或弃牌。
            if (!legal.canRaise && target > game.currentBet) {
              return { ok: false, error: '加注权已被不足额全下封锁，只能跟注或跟注全下' };
            }
          } else {
            if (!legal.canRaise) return { ok: false, error: '当前无权加注（可能被不足额全下封锁）' };
            if (amount > legal.maxRaiseTo) return { ok: false, error: `加注额超过可用筹码 ${legal.maxRaiseTo}` };
            if (amount < legal.minRaiseTo) return { ok: false, error: `最小加注额为 ${legal.minRaiseTo}` };
            target = amount;
          }
          const put = target - p.bet;
          if (put <= 0) return { ok: false, error: '加注额无效' };

          const prevBet = game.currentBet;
          const isFullRaise = (target - prevBet) >= game.minRaise;

          p.bet = target; p.stack -= put; p.committed += put;
          if (p.stack === 0) p.allIn = true;

          // ⚠️ 关键：短全下时 currentBet 只能升高，不能被拉低
          game.currentBet = Math.max(game.currentBet, target);
          // lastAggressor 仅在真实超额（加注/足额全下）时赋值——全下形跟注（target≤prevBet）不算侵略者
          if (target > prevBet) game.lastAggressor = seat;

          if (isFullRaise) {
            game.minRaise = target - prevBet;
            game.players.forEach(q => {
              if (q.seat !== seat && !q.folded && !q.allIn) q.canRaise = true;
            });
          } else {
            // 不足额全下：不重开加注权
            game.players.forEach(q => {
              if (q.seat !== seat && !q.folded && !q.allIn && q.actedBet === prevBet) q.canRaise = false;
            });
          }

          const label = p.allIn ? (isFullRaise ? '全下' : '不足额全下') : '加注';
          game.logMsg(`座位${seat} ${p.name} ${label} 至 ${game.currentBet}`);
          game.emit({
            type: 'action', seat,
            action: p.allIn ? ACTION.ALLIN : ACTION.RAISE,
            amount: put, to: game.currentBet
          });
          break;
        }

        default:
          return { ok: false, error: '未知动作: ' + action };
      }

      p.actedBet = game.currentBet;
      return advance();
    };

    /* -------- 状态机推进 -------- */
    function advance() {
      const alive = game.activePlayers();
      if (alive.length <= 1) {
        return finishHand(alive.length === 1 ? [alive[0].seat] : []);
      }

      const seats = game.inHandPlayers().map(p => p.seat).sort((a, b) => a - b);
      const startIdx = seats.indexOf(game.actionSeat);
      let next = -1;
      // ⚠️ k 从 0 起算（不是 1）：nextStreet() 会把 actionSeat 设为「本街首个应行动者」，
      // 此时该玩家尚未行动（actedBet=null !== currentBet=0），必须从 k=0 命中他本人。
      // 若从 k=1 起算则跳过他、误取其下家，导致翻后行动顺序错位（BB 替 SB 先动、
      // HU 庄家替 BB 先动）。act() 后行动者 actedBet===currentBet，k=0 命中自己即跳过，
      // 自然落到 k=1 的原逻辑——两种情形由同一判据天然区分，无需额外分支。
      for (let k = 0; k <= seats.length; k++) {
        const seat = seats[(startIdx + k + seats.length) % seats.length];
        const p = game.seatOf(seat);
        if (p.folded || p.allIn) continue;
        // 中途站起（牌局进行中被置 sittingOut）：等同弃牌跳过，绝不能把行动权
        // 交给 legalActions 会返回 null 的人——那会让整手牌永久卡死。
        if (p.sittingOut) { p.folded = true; game.logMsg(`座位${seat} ${p.name} 中途站起，按弃牌处理`); continue; }
        if (p.bet < game.currentBet || p.actedBet !== game.currentBet) { next = seat; break; }
      }

      if (next !== -1) {
        game.actionSeat = next;
        game.emit({ type: 'turn', seat: next });
        return { ok: true, actionSeat: next, street: game.street };
      }

      // 本轮下注结束
      collectBets();

      const canAct = game.activePlayers().filter(p => !p.allIn);
      if (canAct.length <= 1) {
        return skipToShowdown('仅剩一名可行动玩家，跳过剩余下注轮');
      }
      return nextStreet();
    }

    function collectBets() {
      game.players.forEach(p => {
        if (p.bet > 0) { game.totalPot += p.bet; p.bet = 0; }
        p.actedBet = null;
        p.canRaise = true;
      });
    }

    function nextStreet() {
      const seats = game.inHandPlayers().map(p => p.seat).sort((a, b) => a - b);
      // 庄位可能因中途站起被移出 seats（btnIdx === -1）：从座位表头顺延，
      // 而不是错位地从 seats[0] 起算——否则翻牌后行动顺序整轮错乱。
      const btnIdx = seats.indexOf(game.dealerSeat);
      // 翻牌后从按钮左一开始；若其已弃牌/全下，顺移到下一个可行动的人（防卡死）
      game.actionSeat = -1;
      for (let k = 1; k <= seats.length; k++) {
        const cand = seats[(btnIdx + k) % seats.length];
        const p = game.seatOf(cand);
        if (p && !p.folded && !p.allIn) { game.actionSeat = cand; break; }
      }
      game.currentBet = 0;
      game.minRaise = game.bb;
      game.lastAggressor = null;

      if (game.actionSeat === -1) {
        return skipToShowdown('无人可行动，直接发完公共牌');
      }

      if (game.street === STREET.PREFLOP) {
        game.street = STREET.FLOP;
        const dealt = [game.deck.pop(), game.deck.pop(), game.deck.pop()];
        game.board.push.apply(game.board, dealt);
        game.logMsg(`翻牌：${dealt.map(cardToStr).join(' ')}　底池 ${game.totalPot}`, 'deal');
        game.emit({ type: 'deal', street: 'flop', cards: dealt });
      } else if (game.street === STREET.FLOP) {
        game.street = STREET.TURN;
        const dealt = game.deck.pop();
        game.board.push(dealt);
        game.logMsg(`转牌：${cardToStr(dealt)}　底池 ${game.totalPot}`, 'deal');
        game.emit({ type: 'deal', street: 'turn', cards: [dealt] });
      } else if (game.street === STREET.TURN) {
        game.street = STREET.RIVER;
        const dealt = game.deck.pop();
        game.board.push(dealt);
        game.logMsg(`河牌：${cardToStr(dealt)}　底池 ${game.totalPot}`, 'deal');
        game.emit({ type: 'deal', street: 'river', cards: [dealt] });
      } else if (game.street === STREET.RIVER) {
        game.street = STREET.SHOWDOWN;
        return showdown();
      }

      game.emit({ type: 'street', street: game.street, pot: game.totalPot });
      return advance();
    }

    function skipToShowdown(reason) {
      game.logMsg(reason, 'dim');
      const timeline = [
        { len: 3, street: STREET.FLOP, cn: '翻牌' },
        { len: 4, street: STREET.TURN, cn: '转牌' },
        { len: 5, street: STREET.RIVER, cn: '河牌' }
      ];
      timeline.forEach(t => {
        if (game.board.length < t.len) {
          while (game.board.length < t.len) game.board.push(game.deck.pop());
          game.street = t.street;
          const from = t.len === 3 ? 0 : (t.len === 4 ? 3 : 4);
          const dealt = game.board.slice(from, t.len);
          game.logMsg(`${t.cn}：${dealt.map(cardToStr).join(' ')}`, 'deal');
          game.emit({ type: 'deal', street: t.street, cards: dealt });
        }
      });
      game.actionSeat = -1;
      return showdown();
    }

    function finishHand(winnerSeats) {
      collectBets();
      const pots = buildSidePots(game.players);
      game.pots = pots;
      const awards = [];

      pots.forEach((pot, i) => {
        const seatsToWin = winnerSeats.filter(s => pot.eligible.indexOf(s) !== -1);
        if (!seatsToWin.length) {
          // 防御性退款（与 showdown 同口径）：无人可赢的池按出资原路退回
          game.logMsg(`池 ${i}（${pot.amount}）无人可赢，按出资退回`, 'warn');
          Object.keys(pot.contribs || {}).forEach(s => {
            game.seatOf(Number(s)).stack += pot.contribs[s];
          });
          return;
        }
        const share = Math.floor(pot.amount / seatsToWin.length);
        let rem = pot.amount - share * seatsToWin.length;
        // 零头派发序与 showdown 同口径：按钮左一优先（TDA 奇数筹码规则）
        const seatList = game.players.map(p => p.seat).sort((a, b) => a - b);
        oddChipOrder(seatsToWin, game.dealerSeat, seatList).forEach(s => {
          let amt = share;
          if (rem > 0) { amt += 1; rem -= 1; }
          const p = game.seatOf(s);
          p.stack += amt;
          p.net += amt - p.committed;
          awards.push({ seat: s, amount: amt, potIndex: i, isMain: i === 0 });
        });
      });

      game.result = { type: 'fold', winners: winnerSeats, awards, board: game.board.slice() };
      game.street = STREET.SHOWDOWN;
      const total = awards.reduce((s, a) => s + a.amount, 0);
      game.logMsg(winnerSeats.length
        ? `牌局结束 · 座位${winnerSeats.join('、')} 赢得 ${total}`
        : '牌局结束 · 无人下注', 'win');
      game.emit({ type: 'hand_end', winners: winnerSeats, awards });
      game.actionSeat = -1;
      return { ok: true, over: true, result: game.result };
    }

    function showdown() {
      // 统一兜底置摊牌街次：skipToShowdown（全下跑马）路径只把 street 置到 RIVER，
      // 若不在此处纠正，渲染层（street===SHOWDOWN 才亮牌）与快照（showAll）都会误判，
      // 出现「桌上不亮牌、结算弹窗里才有牌」的现象。
      game.street = STREET.SHOWDOWN;
      collectBets();
      const pots = buildSidePots(game.players);
      game.pots = pots;

      const evals = {};
      game.activePlayers().forEach(p => {
        const e = evaluate(p.hole.concat(game.board));
        evals[p.seat] = e;
        game.showdownReveal[p.seat] = {
          hole: p.hole.map(cardToCode),
          hand: e.best.map(cardToCode),
          handCn: e.best.map(cardToStr),
          cat: e.cat, name: e.name, ranks: e.ranks.slice()
        };
      });

      const awards = [];
      pots.forEach((pot, i) => {
        let ties = [], bestSeat = null;
        pot.eligible.forEach(seat => {
          const e = evals[seat];
          if (!e) return;
          if (bestSeat === null) { bestSeat = seat; ties = [seat]; return; }
          const cmp = compare(e, evals[bestSeat]);
          if (cmp > 0) { bestSeat = seat; ties = [seat]; }
          else if (cmp === 0) ties.push(seat);
        });
        if (!ties.length) {
          // 防御性退款：整池无人有资格（外部状态污染 / 状态不一致）时按出资原路退回，
          // 绝不静默吞掉整层筹码（历史缺陷：资格为空的层金额直接消失）。
          game.logMsg(`边池 ${i}（${pot.amount}）无摊牌资格者，按出资退回`, 'warn');
          Object.keys(pot.contribs || {}).forEach(s => {
            game.seatOf(Number(s)).stack += pot.contribs[s];
          });
          return;
        }

        const share = Math.floor(pot.amount / ties.length);
        let rem = pot.amount - share * ties.length;
        // 零头按「按钮左一优先」序派发（TDA：奇数筹码给按钮左侧最近的在局玩家），
        // 非按座位号大小——2026-10-17 评审纠正方向性错误。
        const seatList = game.players.map(p => p.seat).sort((a, b) => a - b);
        oddChipOrder(ties, game.dealerSeat, seatList).forEach(s => {
          let amt = share;
          if (rem > 0) { amt += 1; rem -= 1; }
          const p = game.seatOf(s);
          p.stack += amt;
          p.net += amt - p.committed;
          awards.push({ seat: s, amount: amt, potIndex: i, isMain: i === 0 });
        });
      });

      game.activePlayers().forEach(p => {
        const e = evals[p.seat];
        game.logMsg(`座位${p.seat} ${p.name} 摊牌 ${p.hole.map(cardToStr).join('')} → ${e.name}（${e.best.map(cardToStr).join(' ')}）`, 'showdown');
      });
      awards.forEach(a => {
        game.logMsg(`座位${a.seat} 赢得${a.isMain ? '底池' : '边池'} ${a.amount}`, 'win');
      });

      game.result = {
        type: 'showdown',
        winners: Array.from(new Set(awards.map(a => a.seat))).sort((a, b) => a - b),
        awards,
        board: game.board.slice(),
        evals: game.activePlayers().reduce((m, p) => {
          m[p.seat] = { name: evals[p.seat].name, hand: evals[p.seat].best.map(cardToStr) };
          return m;
        }, {})
      };
      game.emit({ type: 'hand_end', winners: game.result.winners, awards });
      game.actionSeat = -1;
      return { ok: true, over: true, result: game.result };
    }

    game.advance = advance;
    game._showdown = showdown;

    /**
     * 外部推进入口：应用层代打/掉线接管时用（不经过 act 的合法性闸门）。
     * 适用场景：座位已被中途标记 sittingOut（legalActions 会返回 null），
     * 但牌局必须继续推进——advance 内部会把 sittingOut 玩家按弃牌跳过。
     * 仅当 game.result 尚未产生时有效（结束后是幂等 no-op）。
     */
    game.advanceInHand = function () {
      if (game.result || game.over) return { ok: false, error: '本手已结束' };
      if (game.actionSeat < 0) return { ok: false, error: '当前无行动者' };
      return advance();
    };

    /**
     * 把云端广播的快照镜像进本地 game 对象（好友端专用：不跑引擎，只做渲染）。
     * 座位重映射规则：myRoomSeat → 本地 0 号位，其余按房间座位号升序依次占 1..N，
     * 这样好友端与房主端复用同一套「我在 0 号位」的渲染与操作逻辑。
     * @param {object} snap 房主广播的 snapshot()
     * @param {number} myRoomSeat 我在云端房间里的座位号
     * @param {object} [opts] { legal } 房主下发的当前行动者合法性（快照里带不了 canRaise 细节）
     */
    game.loadSnapshot = function (snap, myRoomSeat, opts) {
      if (!snap || !Array.isArray(snap.players)) return false;
      const roomSeats = snap.players.map(p => p.seat).sort((a, b) => a - b);
      const remap = {};
      let nextLocal = 1;
      roomSeats.forEach(s => {
        remap[s] = (s === myRoomSeat) ? 0 : nextLocal++;
      });
      const loc = s => (s === undefined || s === null || s < 0) ? -1 : (remap[s] !== undefined ? remap[s] : -1);

      game.players = snap.players.map(p => {
        const hole = Array.isArray(p.hole) ? p.hole.map(codeToCard).filter(c => c >= 0) : [];
        return {
          id: p.id, name: p.name, seat: loc(p.seat),
          stack: p.stack, isHuman: !!p.isHuman,
          style: p.style || { aggro: 0.5, tight: 0.35 },
          hole, folded: !!p.folded, allIn: !!p.allIn,
          bet: p.bet || 0, committed: p.committed || 0,
          actedBet: null, canRaise: true, sittingOut: !!p.sittingOut,
          hands: 0, net: 0
        };
      });
      game.board = (snap.boardCodes || []).map(codeToCard).filter(c => c >= 0);
      game.street = snap.street || STREET.PREFLOP;
      game.currentBet = snap.currentBet || 0;
      // 盲注级恢复（批④涨盲）：镜像端沿用房主广播的 sb/bb，兜底默认 10/20。
      // 续局路径（table.js restoreRoom）也经此恢复；涨盲后 sb/bb 已翻倍，不退回默认。
      game.bb = snap.bb || game.bb || 20;
      game.sb = snap.sb || Math.round(game.bb / 2) || 10;
      game.minRaise = snap.minRaise || game.bb;
      game.actionSeat = loc(snap.actionSeat);
      game.dealerSeat = loc(snap.dealerSeat);
      game.sbSeat = loc(snap.sbSeat);
      game.bbSeat = loc(snap.bbSeat);
      game.handNo = snap.handNo || 0;
      game.pots = (snap.pots || []).map(p => ({ amount: p.amount, eligible: (p.eligible || []).map(loc), level: p.level }));
      game.totalPot = Math.max(0, (snap.pot || 0) - game.players.reduce((s, p) => s + p.bet, 0));
      game.lastAggressor = null;
      game.over = false;

      // 结算与摊牌亮牌：按重映射后的座位号重建（hole/hand 保持 code 字符串，渲染层直接用）
      if (snap.result) {
        const r = snap.result;
        game.result = {
          type: r.type,
          winners: (r.winners || []).map(loc),
          awards: (r.awards || []).map(a => Object.assign({}, a, { seat: loc(a.seat) })),
          board: game.board.slice(),
          evals: r.evals ? Object.keys(r.evals).reduce((m, k) => { m[loc(Number(k))] = r.evals[k]; return m; }, {}) : undefined
        };
      } else {
        game.result = null;
      }
      game.showdownReveal = {};
      if (snap.reveal) {
        Object.keys(snap.reveal).forEach(k => {
          game.showdownReveal[loc(Number(k))] = snap.reveal[k];
        });
      }
      // 房主下发的合法性（供「轮到我了」时直接用，本地镜像算不出 canRaise）
      game.remoteLegal = (opts && opts.legal && loc(opts.legal.seat) === 0) ? opts.legal : null;
      return true;
    };

    /* -------- 序列化（WebSocket 下发到小程序） -------- */
    game.snapshot = function (opts) {
      opts = opts || {};
      const showAll = opts.revealAll || game.street === STREET.SHOWDOWN;
      return {
        handNo: game.handNo,
        street: game.street,
        streetCn: STREET_CN[game.street],
        board: game.board.map(cardToStr),
        boardCodes: game.board.map(cardToCode),
        pot: game.potTotal(),
        currentBet: game.currentBet,
        minRaise: game.minRaise,
        // 盲注级（批④涨盲）：快照带上当前 sb/bb，续局与镜像端据此恢复盲注级，
        // 不退回默认 10/20。涨盲定时器在 table.js 侧翻倍 game.sb/bb，引擎下一手
        // postBlind 自然取新值，无需新增引擎字段。
        sb: game.sb,
        bb: game.bb,
        actionSeat: game.actionSeat,
        dealerSeat: game.dealerSeat,
        sbSeat: game.sbSeat,
        bbSeat: game.bbSeat,
        pots: game.pots.map(p => ({ amount: p.amount, eligible: p.eligible, level: p.level })),
        result: game.result,
        reveal: showAll ? game.showdownReveal : null,
        log: game.log.slice(-40),
        players: game.players.map(p => ({
          seat: p.seat, id: p.id, name: p.name, isHuman: p.isHuman,
          stack: p.stack, bet: p.bet, committed: p.committed,
          folded: p.folded, allIn: p.allIn, sittingOut: !!p.sittingOut,
          // 弃牌者的底牌不下发（even showAll）：mucked 牌不向任何玩家披露（2026-10-17 评审）。
          // 房主本地端不受影响（不经 snapshot）；镜像端弃牌者渲染牌背只需要 holeCount。
          hole: (!p.folded && (p.isHuman || showAll)) ? p.hole.map(cardToCode) : null,
          holeCount: p.hole.length
        }))
      };
    };

    return game;
  }

  /* ============================================================
   * 九、导出
   * ========================================================== */

  return {
    HAND, STREET, STREET_CN, ACTION, ACTION_CN,
    RANK_NAMES, RANK_DISPLAY, SUIT_CHARS, SUIT_NAMES,
    rankOf, suitOf, cardId, cardToStr, cardToCode, codeToCard,
    createRng, shuffle,
    evaluate, compare, rankEval,
    buildSidePots,
    preflopScore, detectDraws, aiDecide, quickEquity, advise,
    createGame
  };
});
