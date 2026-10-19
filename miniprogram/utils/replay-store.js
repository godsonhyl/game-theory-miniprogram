/**
 * 对局复盘缓存（本地，不进云）
 *
 * 用途：把最近 N 手的引擎事件序列 + 结算结果暂存本地，供复盘页逐街重看。
 * 纯解析式复盘——只存 game.events（引擎已记录全量事件：每街发牌/动作/结算），
 * 复盘页直接按事件分组渲染，不重跑引擎（免 AI 决策注入复杂度，无 seed 风险）。
 *
 * 定位同 room-snapshot.js：仅本地体验优化，存储失败静默降级，不阻断主流程。
 * 接入服务端后可整体移除（复盘数据改为服务端事件流）。
 *
 * 上限 MAX_REPLAYS 局、FIFO 挤出最旧；单局约 2~4KB（事件序列），总占 < 100KB。
 * 仅缓存「有我参与且走到结算」的对局——观战/中途退出不缓存（复盘价值低）。
 */
const KEY = 'poker_replay_cache';
const MAX_REPLAYS = 20;

/**
 * 把一局引擎快照成可复盘 payload（结算时调用）。失败/无效返回 null。
 * 本地缓存与云端落库共用这一份，保证两边复盘数据一致。
 * @returns {object|null} 复盘对象（含 handNo/mySeat/sb/bb/players/board/myHole/result/events）
 */
function buildReplayPayload(g, mySeat, mode) {
  if (!g || !g.events || !g.events.length || !g.result) return null;
  try {
    const rec = {
      handNo: g.handNo,
      mode: mode || 'ai',
      mySeat: Number(mySeat) | 0,
      date: Date.now(),
      sb: g.sb,
      bb: g.bb,
      players: g.players.map(p => ({
        seat: p.seat, name: p.name, isBot: !p.isHuman,
        // 结算时刻的剩余筹码 = 复盘盈亏口径（玩家对象无 startStack 字段，
        // 起始筹码基准在 table.js 的 startStacks，结算时 stack 已是结余）。
        endStack: p.stack
      })),
      // ⚠️ 引擎 events 是跨手累计的（startHand 不清 events）——复盘只关心
      // 「最后一手」，必须从最后一个 hand_start 事件切起，否则多手混流、
      // 街归属/底池累计全错。seq 保留引擎原值（供追溯），切分按下标。
      board: (g.board || []).map(c => c),   // 原始 id（复盘页解码）
      myHole: (g.players[mySeat] && g.players[mySeat].hole) || [],
      result: {
        type: g.result.type,
        winners: g.result.winners,
        awards: g.result.awards,
        board: g.result.board,
        evals: g.result.evals
      }
    };

    // 切出最后一手的事件段（含其 hand_start）
    let lastStart = -1;
    for (let i = g.events.length - 1; i >= 0; i--) {
      if (g.events[i].type === 'hand_start') { lastStart = i; break; }
    }
    if (lastStart < 0) return null;   // 没有 hand_start 的残局不可复盘
    const evts = g.events.slice(lastStart).map(e => ({
      type: e.type,
      seq: e.seq,
      street: e.street,
      seat: e.seat,
      action: e.action,
      amount: e.amount,
      cards: e.cards,
      winners: e.winners,
      awards: e.awards,
      btn: e.btn, sb: e.sb, bb: e.bb
    }));

    // 盲注补录：引擎的盲注在 startHand 内部 postBlind，不发事件——底池还原
    // 需要真实投入额（短码时 put = min(盲注, stack)，不能按 sb/bb 额度写死）。
    // 收割发生在结算后：各玩家 committed 已含盲注+动作，无法拆分——务实做法：
    // 按座位号从 hand_start 事件读 sb/bb 座位，金额按 rec.sb/rec.bb 与该座位
    // 本手开始时筹码夹取。
    const committedNow = {};
    g.players.forEach(p => { committedNow[p.seat] = p.committed; });
    const hs = evts[0];
    const blindEvt = (seat, planned) => {
      if (seat === undefined || seat === null || seat < 0) return null;
      const startStack = (g.players[hs.sb] && committedNow[seat] !== undefined)
        ? (g.seatOf(seat).stack + committedNow[seat]) : planned;
      return {
        type: 'action', seat: seat, action: 'blind', amount: Math.min(planned, startStack),
        handNo: g.handNo, seq: -1, street: 'preflop'
      };
    };
    const sbEvt = blindEvt(hs && hs.sb, Number(g.sb) || 0);
    const bbEvt = blindEvt(hs && hs.bb, Number(g.bb) || 0);
    // 插在 hand_start 之后（seq -1 不参与排序，按插入位置）
    if (sbEvt) evts.splice(1, 0, sbEvt);
    if (bbEvt) evts.splice(sbEvt ? 2 : 1, 0, bbEvt);
    rec.events = evts;
    return rec;
  } catch (e) {
    return null;
  }
}

/** 把一局引擎快照成可复盘记录并写入本地缓存。失败静默返回 false。 */
function addReplay(g, mySeat, mode) {
  const rec = buildReplayPayload(g, mySeat, mode);
  if (!rec) return false;
  try {
    const list = listAll();
    list.push(rec);
    while (list.length > MAX_REPLAYS) list.shift();
    wx.setStorageSync(KEY, list);
    return true;
  } catch (e) {
    return false;
  }
}

/** 列出全部缓存（最新在后）。读取异常返回空数组。 */
function listAll() {
  try {
    return wx.getStorageSync(KEY) || [];
  } catch (e) {
    return [];
  }
}

/** 取最近一局（给结算弹窗「复盘」入口用）。无缓存返回 null。 */
function latest() {
  const list = listAll();
  return list.length ? list[list.length - 1] : null;
}

/** 按日期戳取单局（复盘页定位）。不存在返回 null。 */
function findByDate(date) {
  const list = listAll();
  return list.filter(r => r.date === date)[0] || null;
}

/** 清空全部缓存 */
function clear() {
  try { wx.removeStorageSync(KEY); } catch (e) {}
}

module.exports = { KEY, MAX_REPLAYS, buildReplayPayload, addReplay, listAll, latest, findByDate, clear };
