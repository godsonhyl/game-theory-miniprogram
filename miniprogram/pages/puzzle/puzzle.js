/**
 * 每日一题 / 局面挑战页
 *
 * 定位：纯教学——给玩家一个指定街的局面，让其在「跟/弃（或下注/过牌）」间选择，
 * 揭示胜率与赔率。不是实时对局辅助（advise 那种合规硬约束的「行动建议」），
 * 而是事后静态局面教学，胜率/赔率输出无合规风险。
 *
 * 局面呈现用 quickEquity 算胜率（不走 advise——advise 需完整 game 对象且含合规门槛），
 * 赔率 potOdds = toCall/(pot+toCall)（同 advise 口径）。玩家选了之后揭示：
 * 你的选择 vs 推荐答案 + 胜率/赔率 + 解释文案。题库按日期取当天题（同日同题）。
 *
 * 纯客户端、不碰引擎双副本、无新 wx API、无云端表、不接 LLM、合规门槛不变。
 */
const P = require('../../core/poker-core.js');
const puzzles = require('../../utils/puzzles');

const EQUITY_ITERS = 1200;   // 胜率蒙特卡洛迭代数（教学场景，1200 够稳且快）

/** 动作中文名映射（揭示区展示用） */
const ACTION_CN = {
  call: '跟注', fold: '弃牌', raise: '加注', check: '过牌'
};

Page({
  data: {
    puzzle: null,        // 当前题对象
    myHoleCards: [],     // 我的底牌（解码后 [{rank,suit,cls}]）
    boardCards: [],      // 公共牌（解码后）
    revealed: false,    // 是否已揭示答案
    myChoice: '',       // 玩家选择：call/fold/raise/check
    equityPct: '',      // 胜率%
    potOddsPct: '',     // 赔率%
    answerCorrect: false, // 玩家选择是否与推荐一致
    answerAction: '',    // 推荐动作
    answerReason: ''     // 推荐理由
  },

  onLoad(query) {
    const id = query.id;
    let p = id ? puzzles.findById(id) : null;
    if (!p) p = puzzles.puzzleForDate(new Date());
    if (!p) {
      wx.showToast({ title: '暂无题目', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const myHoleCards = p.setup.myHole.map(decodeCard).filter(Boolean);
    const boardCards = p.setup.board.map(decodeCard).filter(Boolean);
    // 算胜率与赔率（onLoad 即算好，揭示时直接显示；胜率固定不随 RNG 抖动）
    const opponents = Math.max(1, (p.setup.opponents || p.setup.numActive || 2) - 1);
    const eq = P.quickEquity(p.setup.myHole, p.setup.board, opponents,
      EQUITY_ITERS, P.createRng());
    const toCall = p.setup.toCall || 0;
    const potOdds = toCall > 0 ? toCall / (p.setup.pot + toCall) : 0;
    this.setData({
      puzzle: p,
      myHoleCards: myHoleCards,
      boardCards: boardCards,
      equityPct: Math.round(eq.equity * 100) + '%',
      potOddsPct: Math.round(potOdds * 100) + '%',
      answerAction: p.answer.action,
      answerActionCn: ACTION_CN[p.answer.action] || p.answer.action,
      answerReason: p.answer.reason
    });
  },

  /** 玩家选「跟注」 */
  onChooseCall() { this.reveal('call'); },
  /** 玩家选「弃牌」 */
  onChooseFold() { this.reveal('fold'); },
  /** 玩家选「加注」（部分题推荐加注） */
  onChooseRaise() { this.reveal('raise'); },
  /** 玩家选「过牌」（部分题推荐过牌控池） */
  onChooseCheck() { this.reveal('check'); },

  /** 揭示答案：比对玩家选择与推荐，标记正误。 */
  reveal(choice) {
    if (this.data.revealed) return;   // 防重复揭示
    const correct = choice === this.data.answerAction;
    this.setData({
      revealed: true,
      myChoice: choice,
      choiceCn: ACTION_CN[choice] || choice,
      answerCorrect: correct
    });
    // 轻量反馈：答对轻提示、答错中性提示（教学场景不打击）
    wx.showToast({ title: correct ? '答对了 ✓' : '看看解析', icon: 'none', duration: 1200 });
  },

  /** 换一题（随机取题库其他题） */
  onNextPuzzle() {
    const list = puzzles.PUZZLES;
    const cur = this.data.puzzle;
    let next = cur;
    let guard = 0;
    while (next.id === cur.id && guard < 20) {
      // 用题库长度做简单轮换，避免引入 Date.now/RNG（小程序场景 onLoad 即可）
      next = list[(list.indexOf(cur) + 1) % list.length];
      guard++;
    }
    wx.redirectTo({ url: '/pages/puzzle/puzzle?id=' + next.id });
  },

  onBack() { wx.navigateBack(); }
});

/** 解码单张牌 id → { rank, suit, cls }（与复盘页一致口径） */
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
