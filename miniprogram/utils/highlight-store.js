/**
 * 高光时刻存档（本地，不进云）
 *
 * 用途：把玩家「值得炫耀的一手」单独存档——皇家同花顺 / 四条 / 诈唬成功 / 连胜 5 局。
 * 与 replay-store 同源（结算时收割引擎事件流），但自存完整 events：replay 缓存
 * FIFO 20 局会挤出旧局，高光若依赖 replay 缓存重看必丢；故高光独立存 50 条，
 * 重看不依赖 replay 缓存，直接用本存档的 events 回放（复用复盘页，经 from=highlight 分支）。
 *
 * 判定逻辑在 table.js 收割时做（highlight-store 只存不判），原因：
 * 判定依赖 game.result.evals / winners / winStreaks 等结算态，这些在 showResultModal
 * 收割时刻均已就绪（renderAmbience 的 _bumpStreaks 先于 showResultModal）。store 层
 * 保持单一职责「只存不判」，与 replay-store 同构。
 *
 * 边界：纯本地体验优化、存储失败静默降级，不阻断主流程。无新 wx API（用已有
 * setStorageSync/getStorageSync）、无新云端表、无新隐私权限、无新合规面、不接 LLM。
 * 上限 MAX_HIGHLIGHTS 条 FIFO、单条约 2~4KB（含完整 events），总占 < 200KB，远低于
 * 小程序本地 10MB 上限。徽章数 = listAll().filter(r=>r.type===X).length（单条记录
 * 派生计数，天然一致，不另维护计数器）。
 */
const KEY = 'poker_highlight_cache';
const MAX_HIGHLIGHTS = 50;

/** 把一局高光存档（结算时 table.js 判定后调用）。type 见判定规则。
 *  g=引擎 game（结算态），mySeat=本机玩家座位，mode=对局模式，type=高光类型，
 *  streak=连胜手数（连胜高光由 table.js 传入，store 层不可见模块级 winStreaks）。
 *  失败静默返回 false。 */
function addHighlight(g, mySeat, mode, type, streak) {
  if (!g || !g.events || !g.events.length || !g.result) return false;
  try {
    const me = g.players[mySeat];
    const rec = {
      date: Date.now(),
      type: type || 'quads',
      handNo: g.handNo,
      mode: mode || 'ai',
      mySeat: Number(mySeat) | 0,
      sb: g.sb,
      bb: g.bb,
      players: g.players.map(p => ({
        seat: p.seat, name: p.name, isBot: !p.isHuman, endStack: p.stack
      })),
      board: (g.board || []).map(c => c),
      myHole: (me && me.hole) || [],
      result: {
        type: g.result.type,
        winners: g.result.winners,
        awards: g.result.awards,
        board: g.result.board,
        evals: g.result.evals
      },
      streak: Number(streak) || 0   // 连胜手数（连胜高光用，其余类型为 0）
    };

    // 切出最后一手的事件段（含其 hand_start）——与 replay-store 同口径：
    // 引擎 events 跨手累计、startHand 不清，必须从最后一个 hand_start 切起。
    let lastStart = -1;
    for (let i = g.events.length - 1; i >= 0; i--) {
      if (g.events[i].type === 'hand_start') { lastStart = i; break; }
    }
    if (lastStart < 0) return false;
    const evts = g.events.slice(lastStart).map(e => ({
      type: e.type, seq: e.seq, street: e.street, seat: e.seat,
      action: e.action, amount: e.amount, cards: e.cards,
      winners: e.winners, awards: e.awards,
      btn: e.btn, sb: e.sb, bb: e.bb
    }));

    // 盲注补录：引擎 postBlind 不发事件，与 replay-store 同法补虚拟 action('blind')
    // 金额按 min(盲注额, 当时筹码) 夹取（短码场景）。
    const committedNow = {};
    g.players.forEach(p => { committedNow[p.seat] = p.committed; });
    const hs = evts[0];
    const blindEvt = (seat, planned) => {
      if (seat === undefined || seat === null || seat < 0) return null;
      const startStack = (g.players[hs.sb] && committedNow[seat] !== undefined)
        ? (g.seatOf(seat).stack + committedNow[seat]) : planned;
      return {
        type: 'action', seat: seat, action: 'blind',
        amount: Math.min(planned, startStack),
        handNo: g.handNo, seq: -1, street: 'preflop'
      };
    };
    const sbEvt = blindEvt(hs && hs.sb, Number(g.sb) || 0);
    const bbEvt = blindEvt(hs && hs.bb, Number(g.bb) || 0);
    if (sbEvt) evts.splice(1, 0, sbEvt);
    if (bbEvt) evts.splice(sbEvt ? 2 : 1, 0, bbEvt);
    rec.events = evts;

    rec.summary = summarize(rec, type);

    const list = listAll();
    list.push(rec);
    while (list.length > MAX_HIGHLIGHTS) list.shift();
    wx.setStorageSync(KEY, list);
    return true;
  } catch (e) {
    return false;
  }
}

/** 生成高光摘要文案（profile「最值得炫耀的一手」展示用）。 */
function summarize(rec, type) {
  const evals = rec.result.evals || {};
  const me = evals[rec.mySeat];
  const handName = (me && me.name) || '';
  if (type === 'royal_flush') return '皇家同花顺！';
  if (type === 'quads') return (handName ? '拿到' + handName : '四条');
  if (type === 'streak5') return '连胜 ' + (rec.streak || 5) + ' 局';
  if (type === 'bluff_success') return '诈唬成功，对手弃牌';
  return handName || '高光时刻';
}

/** 列出全部存档（最新在后）。读取异常返回空数组。 */
function listAll() {
  try {
    return wx.getStorageSync(KEY) || [];
  } catch (e) {
    return [];
  }
}

/** 取最近一条高光（profile「最值得炫耀的一手」用）。无存档返回 null。 */
function latest() {
  const list = listAll();
  return list.length ? list[list.length - 1] : null;
}

/** 按日期戳取单条（复盘页定位）。不存在返回 null。 */
function findByDate(date) {
  const list = listAll();
  return list.filter(r => r.date === date)[0] || null;
}

/** 清空全部存档 */
function clear() {
  try { wx.removeStorageSync(KEY); } catch (e) {}
}

module.exports = {
  KEY, MAX_HIGHLIGHTS,
  addHighlight, listAll, latest, findByDate, clear, summarize
};
