/**
 * 复盘页：逐街回放本局（翻前/翻牌/转牌/河牌/摊牌）。
 *
 * 数据源 = replay-store 缓存的 events 序列（纯解析，不重跑引擎）。
 * 街切换条驱动整页：累计到当前街的公共牌 / 底池 / 动作行。
 * 「上帝视角」开关展开所有玩家底牌（复盘场景正当可见）。
 *
 * 设计：docs/plans/2026-10-16-复盘教学风格分析-design.md
 */
const P = require('../../core/poker-core.js');
const replayStore = require('../../utils/replay-store');

/** 街定义：索引 0..4 对应翻前→摊牌 */
const STREETS = [
  { key: 'preflop', cn: '翻前' },
  { key: 'flop', cn: '翻牌' },
  { key: 'turn', cn: '转牌' },
  { key: 'river', cn: '河牌' },
  { key: 'showdown', cn: '摊牌' }
];

/** 把引擎事件流拆成「每街的公共牌 + 动作行 + 底池」。返回 5 段街数据。
 * 底池口径：street 事件的 pot 字段在街切换瞬间不可靠（非 totalPot 快照），
 * 不取——底池由「每街所有 action 事件金额累加」还原。盲注由 addReplay 在
 * hand_start 后补录成虚拟 action('blind') 事件（短码时按真实投入额夹取），
 * 故此处统一按 action 累加即可，不再对 hand_start 单独加 sb/bb。 */
function buildStreets(rec) {
  const boardByStreet = { preflop: [], flop: [], turn: [], river: [], showdown: [] };
  const putByStreet = { preflop: 0, flop: 0, turn: 0, river: 0, showdown: 0 };
  const actionsByStreet = { preflop: [], flop: [], turn: [], river: [], showdown: [] };

  let curStreet = 'preflop';
  rec.events.forEach(e => {
    if (e.type === 'street') {
      curStreet = e.street;
    } else if (e.type === 'deal') {
      const st = e.street;
      if (boardByStreet[st]) {
        (e.cards || []).forEach(c => { if (boardByStreet[st].indexOf(c) < 0) boardByStreet[st].push(c); });
      }
    } else if (e.type === 'action') {
      const amt = Number(e.amount) || 0;
      actionsByStreet[curStreet].push({
        seat: e.seat, action: e.action, amount: amt,
        blind: e.action === 'blind'   // 盲注行展示用「盲注」文案
      });
      putByStreet[curStreet] += amt;
    }
  });
  // 公共牌 + 底池跨街累计传递（翻牌后继承前面发过的牌与投入）
  const order = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  let putAcc = 0;
  const pots = [];
  const cumBoard = [];
  order.forEach(k => {
    boardByStreet[k].forEach(c => { if (cumBoard.indexOf(c) < 0) cumBoard.push(c); });
    boardByStreet[k] = cumBoard.slice();
  });
  order.forEach(k => {
    putAcc += putByStreet[k];
    pots.push(putAcc);
  });
  return STREETS.map((s, i) => ({
    key: s.key, cn: s.cn,
    board: boardByStreet[s.key],
    pot: pots[i],
    actions: actionsByStreet[s.key]
  }));
}

/** 解码单张牌 id → { rank, suit, cls }（与牌桌页一致口径） */
function decodeCard(id) {
  if (id == null) return null;
  const r = P.rankOf(id), s = P.suitOf(id);
  return {
    code: P.cardToCode(id),
    rank: P.RANK_DISPLAY[r],
    suit: P.SUIT_CHARS[s],
    cls: P.SUIT_NAMES[s]
  };
}

/** 解析事件中的 hole（events 不直接存 hole，从 result.evals / players 取） */
function buildPlayers(rec, godView) {
  const evals = (rec.result && rec.result.evals) || {};
  return rec.players.map(p => {
    const ev = evals[p.seat];
    let hole = [];
    // 上帝视角：摊牌者用 evals.hand（最佳5张含底牌）展示成手；我自己用缓存的 myHole
    if (godView) {
      if (p.seat === rec.mySeat && rec.myHole) hole = rec.myHole.map(decodeCard);
      else if (ev && ev.hand) hole = ev.hand.map(P.codeToCard).map(decodeCard);
    }
    return {
      seat: p.seat, name: p.name, isMe: p.seat === rec.mySeat, isBot: p.isBot,
      hole: hole, handName: ev ? ev.name : ''
    };
  });
}

Page({
  data: {
    date: 0,
    handNo: 0,
    mode: 'ai',
    myNet: 0,
    streets: [],          // 5 段街数据
    streetIdx: 0,         // 当前街索引
    curBoard: [],         // 当前街公共牌（解码后）
    curPot: 0,
    curActions: [],       // 当前街动作行（带玩家名）
    players: [],
    godView: false,       // 上帝视角：展开所有底牌
    showHandResult: false // 摊牌街：是否显示成手/赢家
  },

  onLoad(query) {
    const date = Number(query.date);
    const rec = replayStore.findByDate(date);
    if (!rec) {
      wx.showToast({ title: '复盘记录不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const streets = buildStreets(rec);
    // 我的盈亏 = 我本手的投入金额（盲注+各街动作）的负数 + 获奖金额。
    // 投入金额可精确从 events 反算（含盲注虚拟事件），不依赖 table.js 的
    // startStacks（复盘收割时未存起始筹码）。即 net = 获奖 - 我本手投入。
    const myPut = streets.reduce((s, st) => s + st.actions
      .filter(a => a.seat === rec.mySeat)
      .reduce((t, a) => t + (a.amount || 0), 0), 0);
    const myAward = (rec.result.awards || []).filter(a => a.seat === rec.mySeat)
      .reduce((s, a) => s + (a.amount || 0), 0);
    const myNet = myAward - myPut;
    this._rec = rec;
    this.setData({
      date: rec.date,
      handNo: rec.handNo,
      mode: rec.mode,
      myNet: myNet,
      streets: streets,
      players: buildPlayers(rec, false)
    });
    this.gotoStreet(0);
  },

  /** 切到第 i 街：刷新公共牌 / 底池 / 动作行 */
  gotoStreet(i) {
    const s = this.data.streets[i];
    if (!s) return;
    this.setData({
      streetIdx: i,
      curBoard: s.board.map(decodeCard).filter(Boolean),
      curPot: s.pot,
      curActions: s.actions.map(a => {
        const pl = (this._rec.players.filter(p => p.seat === a.seat)[0]) || {};
        return {
          seat: a.seat,
          name: pl.name,
          isMe: a.seat === this._rec.mySeat,
          action: a.action,
          amount: a.amount || 0,
          cn: { fold: '弃牌', check: '过牌', call: '跟注', raise: '加注', allin: '全下', blind: '盲注' }[a.action] || a.action
        };
      }),
      showHandResult: i === 4   // 摊牌街显示成手
    });
  },

  onStreetPrev() { if (this.data.streetIdx > 0) this.gotoStreet(this.data.streetIdx - 1); },
  onStreetNext() { if (this.data.streetIdx < 4) this.gotoStreet(this.data.streetIdx + 1); },
  onStreetTap(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.gotoStreet(i);
  },

  /** 上帝视角开关：摊牌街展开所有玩家底牌与成手 */
  onGodToggle() {
    this.setData({ godView: !this.data.godView, players: buildPlayers(this._rec, !this.data.godView) });
  },

  onBack() { wx.navigateBack(); }
});
