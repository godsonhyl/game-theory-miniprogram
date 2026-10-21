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
const highlightStore = require('../../utils/highlight-store');
const sngStore = require('../../utils/sng-store');
const { auth } = require('../../utils/auth');

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
    showHandResult: false, // 摊牌街：是否显示成手/赢家
    // —— 房间复盘模式（进 ended 好友房触发）——
    roomMode: false,       // 是否房间复盘模式
    roomNo: '',            // 房间号
    roomLoading: false,    // 拉取复盘列表加载中
    roomHandCount: 0,      // 房间内复盘局数
    handList: [],          // 每局摘要：{ key, label, handNo, net, isSummary }
    roomSelIdx: -1,        // 当前选中局索引
    // —— SNG 结算模式（战绩页「最近 SNG」/ 房间复盘里的结算记录）——
    sngMode: false,        // 是否 SNG 结算模式
    sngShow: false,        // 当前渲染结算卡（vs 逐手回放）
    sngSummary: null,      // 当前结算单
    sngList: [],           // 本地 SNG 存档（多场可切）
    sngSelIdx: -1,
    sngDateText: ''
  },

  onLoad(query) {
    const from = query.from;   // 来源：默认 replay-store 缓存；'highlight' 高光；'sng' SNG 结算
    if (from === 'sng' || query.sng) { this._enterSngMode(query.id); return; }
    const room = query.room;
    if (room) { this._enterRoomMode(room); return; }
    const date = Number(query.date);
    let rec;
    if (from === 'highlight') {
      rec = highlightStore.findByDate(date);
    } else {
      rec = replayStore.findByDate(date);
      // 高光重看兜底：replay 缓存 FIFO 20 局可能已挤出该局，回退查高光存档
      if (!rec) rec = highlightStore.findByDate(date);
    }
    if (!rec) {
      wx.showToast({ title: '复盘记录不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this._renderRec(rec);
  },

  /**
   * 房间复盘模式：进 ended 好友房触发（table 页 redirectTo 到此）。
   * 拉取该房间的全部云端复盘（poker_hand_replays），列出每一局供选择回看。
   * 仅房主可读（rpc 按 owner_id 校验）；非房主 rows 为空 → 显示「暂无复盘」。
   */
  async _enterRoomMode(room) {
    this.setData({ roomMode: true, roomNo: room, roomLoading: true });
    let rows = [];
    try { rows = await auth.listRoomReplays(room); }
    catch (e) { rows = []; }
    this._roomRows = Array.isArray(rows) ? rows : [];
    if (!this._roomRows.length) {
      this.setData({ roomLoading: false, roomHandCount: 0, handList: [] });
      return;
    }
    // 每局摘要：handNo / 我的净盈亏 / 胜负 / 时间（数组按 hand_no 升序）。
    // SNG 房的「结算」记录（kind=sng-summary，hand_no=N+1）单列出来，点了看结算单。
    const handList = this._roomRows.map(r => {
      const rec = r.payload || {};
      const isSummary = rec.kind === 'sng-summary';
      return {
        key: r.id,
        handNo: rec.handNo || 0,
        isSummary: isSummary,
        label: isSummary ? '结算' : '第' + (rec.handNo || 0) + '局',
        net: isSummary ? (Number(rec.myNet) || 0) : this._handNet(rec),
        createdAt: r.created_at
      };
    });
    this.setData({ roomLoading: false, roomHandCount: handList.length, handList: handList });
    this._loadRoomHand(handList.length - 1);   // 默认选中最新一手
  },

  /** 本地 SNG 结算模式：读取 sng-store 存档（多场可切） */
  _enterSngMode(id) {
    const list = sngStore.list().map(x => Object.assign({}, x, {
      dateText: this._fmtDate(x.ts || x.date)
    }));
    let idx = id ? list.findIndex(x => String(x.id) === String(id)) : 0;
    if (idx < 0) idx = 0;
    this.setData({ sngMode: true, sngList: list, sngSelIdx: idx });
    if (!list.length) {
      wx.showToast({ title: '暂无 SNG 结算记录', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this._renderSngSummary(list[idx]);
  },

  /** 切上一场/下一场 SNG 存档 */
  onSngTap(e) {
    const i = Number(e.currentTarget.dataset.i);
    const rec = this.data.sngList[i];
    if (!rec) return;
    this.setData({ sngSelIdx: i });
    this._renderSngSummary(rec);
  },

  /** 渲染 SNG 结算单（本地存档 / 好友房云端「结算」记录通用） */
  _renderSngSummary(rec) {
    this.setData({
      sngShow: true,
      sngSummary: rec,
      sngDateText: this._fmtDate(rec.ts || rec.date || 0)
    });
  },

  _fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts) || 0);
    if (isNaN(d.getTime())) return '';
    const p2 = n => (n < 10 ? '0' + n : '' + n);
    return (d.getMonth() + 1) + '月' + p2(d.getDate()) + '日 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  },

  /** 单局净盈亏：获奖 - 我本手投入（投入从 events 反算，含盲注虚拟事件） */
  _handNet(rec) {
    const streets = buildStreets(rec);
    const myPut = streets.reduce((s, st) => s + st.actions
      .filter(a => a.seat === rec.mySeat)
      .reduce((t, a) => t + (a.amount || 0), 0), 0);
    const myAward = (rec.result.awards || []).filter(a => a.seat === rec.mySeat)
      .reduce((s, a) => s + (a.amount || 0), 0);
    return myAward - myPut;
  },

  /** 选中房间内第 idx 局并渲染 */
  _loadRoomHand(idx) {
    const row = this._roomRows && this._roomRows[idx];
    const rec = row && row.payload;
    if (!rec) return;
    if (rec.kind === 'sng-summary') this._renderSngSummary(rec);
    else this._renderRec(rec);
    this.setData({ roomSelIdx: idx });
  },

  /** 渲染某一局 rec（本地或云端 payload 通用，结构同源） */
  _renderRec(rec) {
    const streets = buildStreets(rec);
    const myPut = streets.reduce((s, st) => s + st.actions
      .filter(a => a.seat === rec.mySeat)
      .reduce((t, a) => t + (a.amount || 0), 0), 0);
    const myAward = (rec.result.awards || []).filter(a => a.seat === rec.mySeat)
      .reduce((s, a) => s + (a.amount || 0), 0);
    this._rec = rec;
    this.setData({
      sngShow: false,
      date: rec.date || 0,
      handNo: rec.handNo,
      mode: rec.mode,
      myNet: myAward - myPut,
      streets: streets,
      players: buildPlayers(rec, false)
    });
    this.gotoStreet(0);
  },

  /** 房间模式：点每局 chip 切换手 */
  onRoomHandTap(e) {
    const i = Number(e.currentTarget.dataset.i);
    this._loadRoomHand(i);
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
          initial: Array.from(pl.name || '?')[0],   // 按码点取首字符：slice(0,1) 会把 emoji 拦腰截断
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
