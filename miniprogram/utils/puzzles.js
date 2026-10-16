/**
 * 每日一题 / 局面挑战题库（纯客户端，教学非对局）
 *
 * 定位：给玩家一个「指定街的局面 + 跟/弃二选一」的练习题，揭示胜率与赔率。
 * 纯教学——不是实时对局辅助（advise 那种合规硬约束的「行动建议」），而是
 * 事后静态局面教学，胜率/赔率输出无合规风险（不是对局中给建议）。
 *
 * 数据源与边界（设计批③硬约束）：
 * - 纯本地：题库硬编码在本文件，无云端表、无新 wx API、无新隐私权限、无新合规面、不接 LLM。
 * - 不碰引擎双副本：只用引擎的 quickEquity 算胜率（只读函数），不改引擎。
 * - 按日期 key 取当天题、循环（题库 < 一年天数则按 modulo 循环），同一天同题。
 * - 题结构：{ id, dateKey, title, desc, setup:{myHole,board,pot,toCall,stack,
 *   currentBet,numActive,street}, answer:{action,reason}, minEquity }。
 *
 * 局面用「半成品 game」呈现：puzzle 页用 P.createGame 建空壳后手动设 board/
 * players[].hole/currentBet/pot，跳过 startHand 直入指定街（game 对象字段都是
 * 普通属性可外部赋值）。胜率用 quickEquity(hole,board,opponents,iters) 算
 * （不走 advise——advise 需完整 game 对象且含合规门槛），赔率 potOdds =
 * toCall/(pot+toCall)（同 advise 口径）。
 */

/** 题库（硬编码）。每题给一个 dateKey 占位串，实际按「一年中的第几天」取。 */
const PUZZLES = [
  {
    id: 'p1',
    title: '顶对 vs 湿牌面',
    desc: '你拿着 A♠K♥，翻牌 Q♠J♠2♣，你顶对带顶踢，但牌面有顺子+同花听牌的可能。对手全下，你要跟吗？',
    setup: {
      myHole: [48, 47],      // A♠ K♥
      board: [40, 36, 1],    // Q♠ J♠ 2♣
      pot: 200, toCall: 200, stack: 800,
      currentBet: 400, numActive: 2, street: 'flop',
      opponents: 1
    },
    answer: { action: 'fold', reason: '顶对顶踢很强，但 Q♠J♠2♣ 给对手顺子+同花双听牌。对手全下示强，你只有一对、且可能在听牌被反超。赔率约 33%，顶对胜率难支撑，建议弃牌。' },
    minEquity: 0.50
  },
  {
    id: 'p2',
    title: '同花听牌值不值',
    desc: '你拿着 9♠8♠，翻牌 A♠6♠2♥。你有坚果同花听牌（再来一张♠就成花）。底池 300，对手下注 150，要跟吗？',
    setup: {
      myHole: [28, 24],      // 9♠ 8♠
      board: [48, 16, 3],    // A♠ 6♠ 2♥
      pot: 300, toCall: 150, stack: 600,
      currentBet: 150, numActive: 2, street: 'flop',
      opponents: 1
    },
    answer: { action: 'call', reason: '坚果同花听牌：9 张♠成花（约 35% 翻到河）。赔率 150/(300+150)=33%，胜率约 56%（含后手同花的隐含价值）高于赔率，值得跟注。' },
    minEquity: 0.33
  },
  {
    id: 'p3',
    title: '两对小牌面',
    desc: '你拿着 A♦A♣，翻牌 K♦7♦2♠。你有超对（口袋 AA），但翻牌有 K——对手可能顶对。底池 100，对手下注 80，要跟吗？',
    setup: {
      myHole: [50, 49],      // A♦ A♣
      board: [46, 22, 0],    // K♦ 7♦ 2♠
      pot: 100, toCall: 80, stack: 500,
      currentBet: 80, numActive: 2, street: 'flop',
      opponents: 1
    },
    answer: { action: 'call', reason: '口袋 AA 是翻前最强牌，翻牌出 K 后仍是超对（KK 才顶你）。赔率 80/180=44%，AA 对随机范围胜率约 88%，胜率远超赔率。可以跟，甚至可考虑加注试探对手强度。' },
    minEquity: 0.60
  },
  {
    id: 'p4',
    title: '顺子听牌的犹豫',
    desc: '你拿着 J♣T♣，翻牌 9♦8♠2♥。你有开路顺子听牌（Q 或 7 成顺）。底池 240，对手下注 120，要跟吗？',
    setup: {
      myHole: [37, 33],      // J♣ T♣
      board: [30, 24, 3],    // 9♦ 8♠ 2♥
      pot: 240, toCall: 120, stack: 400,
      currentBet: 120, numActive: 2, street: 'flop',
      opponents: 1
    },
    answer: { action: 'call', reason: '开路顺子听牌：8 张牌成顺（4 张 Q + 4 张 7，约 32% 翻到河）。赔率 120/360=33%，胜率约 55%（含两对/三条后手）高于赔率，边缘但值得跟注。' },
    minEquity: 0.30
  },
  {
    id: 'p5',
    title: '河牌面对三连牌面',
    desc: '你拿着 K♠Q♠，翻牌转牌 A♥K♦4♠9♣。你有顶对 K 但牌面 A 出现了，对手全程领打。河牌前对手全下，要跟吗？',
    setup: {
      myHole: [44, 40],      // K♠ Q♠
      board: [51, 46, 8, 29], // A♥ K♦ 4♠ 9♣
      pot: 500, toCall: 300, stack: 300,
      currentBet: 300, numActive: 2, street: 'turn',
      opponents: 1
    },
    answer: { action: 'call', reason: '你顶对 K 踢 Q 在转牌胜率约 80%（对手若只有顶对 A 踢小牌或听牌未中）。赔率 300/800=37%，胜率远超。注意——若对手范围里含两对/三条则需重新评估，但纯按赔率+胜率，顶对 K 值得跟。' },
    minEquity: 0.45
  },
  {
    id: 'p6',
    title: '同花成牌的加注',
    desc: '你拿着 5♥6♥，翻牌 2♥7♥9♥。你成花了！对手下注 100，底池 200。你该怎么打？',
    setup: {
      myHole: [15, 19],     // 5♥ 6♥
      board: [3, 23, 31],   // 2♥ 7♥ 9♥
      pot: 200, toCall: 100, stack: 700,
      currentBet: 100, numActive: 2, street: 'flop',
      opponents: 1
    },
    answer: { action: 'raise', reason: '你已成坚果同花（5♥6♥ 连花，9♥ 是当前最高花）。胜率约 88%，对手主动下注示有牌，加注可扩大底池从强牌上多赢。注意对手若有更高同花听牌（A♥x）需提防，但成花后主动加注扩大价值是对的。' },
    minEquity: 0.75
  },
  {
    id: 'p7',
    title: '口袋对的小心',
    desc: '你拿着 8♠8♣，翻牌 A♠K♥7♦。翻前你加注被跟，翻牌出两张大牌。对手过牌给你，你该下注还是过牌？',
    setup: {
      myHole: [24, 25],     // 8♠ 8♣
      board: [48, 47, 22],  // A♠ K♥ 7♦
      pot: 180, toCall: 0, stack: 500,
      currentBet: 0, numActive: 2, street: 'flop',
      opponents: 1
    },
    answer: { action: 'check', reason: '口袋 88 在 A K 7 牌面上是中 pocket，两张大牌出现后你的对子很脆弱——对手跟了翻前加注，范围里 A/K 不少。胜率约 65%但被加注后难应对。过牌控池（control pot），看一张免费转牌，避免陷入两难。控池是小对子的标准打法。' },
    minEquity: 0.40
  },
  {
    id: 'p8',
    title: '高牌赔率的诱惑',
    desc: '你拿着 A♠Q♠，翻牌 9♦7♣4♥。你完全没中，只有 A 高。对手下注 50，底池 100。要跟吗？',
    setup: {
      myHole: [48, 40],     // A♠ Q♠
      board: [30, 21, 11], // 9♦ 7♣ 4♥
      pot: 100, toCall: 50, stack: 400,
      currentBet: 50, numActive: 2, street: 'flop',
      opponents: 1
    },
    answer: { action: 'fold', reason: 'A 高在 9 7 4 牌面上没有成手，胜率约 52%但改善到顶对后还可能被反超（对手范围里两对/三条）。赔率 50/150=33%，A 高面对对手下注范围胜率不够稳。弃牌，别拿高牌硬接。' },
    minEquity: 0.33
  }
];

/** 按日期取当天题：一年中第几天 % 题库长度 → 循环。同一天返回同一题。 */
function puzzleForDate(d) {
  const date = d instanceof Date ? d : new Date();
  // 一年中的第几天（0-based）作为 key
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  const dayOfYear = Math.floor(diff / 86400000);
  return PUZZLES[dayOfYear % PUZZLES.length];
}

/** 按 id 取题（puzzle 页 onLoad 定位 / 跳特定题用）。 */
function findById(id) {
  return PUZZLES.filter(p => p.id === id)[0] || null;
}

module.exports = { PUZZLES, puzzleForDate, findById };
