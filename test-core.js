/**
 * 引擎自测：牌型评估 / 边池 / 下注状态机 / 胜率 / 复现性
 * 运行： node test-core.js
 *
 * rank 索引：0='2' 1='3' 2='4' 3='5' 4='6' 5='7' 6='8' 7='9' 8='T' 9='J' 10='Q' 11='K' 12='A'
 * suit 索引：0=♠ 1=♣ 2=♦ 3=♥
 */
const P = require('./core/poker-core.js');

let pass = 0;
const fails = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass++; else fails.push(label + '\n        got: ' + a + '\n        exp: ' + b);
}
function ok(cond, label) {
  if (cond) pass++; else fails.push(label);
}
const group = t => console.log('  ' + t);

const c = (r, s) => P.cardId(r, s);
// ⚠️ 记法：H.S5 是「5♠」，不是 rank 5（rank 5 是 7）。数字只表示花色。
const H = {
  SA: c(12, 0), SK: c(11, 0), SQ: c(10, 0), SJ: c(9, 0), ST: c(8, 0), S9: c(7, 0),
  S8: c(6, 0), S7: c(5, 0), S6: c(4, 0), S5: c(3, 0), S4: c(2, 0), S3: c(1, 0), S2: c(0, 0),
  HA: c(12, 3), HK: c(11, 3), HQ: c(10, 3), HJ: c(9, 3), HT: c(8, 3), H9: c(7, 3),
  H8: c(6, 3), H7: c(5, 3), H6: c(4, 3), H5: c(3, 3), H4: c(2, 3), H3: c(1, 3), H2: c(0, 3),
  DA: c(12, 2), DK: c(11, 2), DQ: c(10, 2), DJ: c(9, 2), D6: c(4, 2), D5: c(3, 2),
  D4: c(2, 2), D3: c(1, 2), D2: c(0, 2),
  CA: c(12, 1), CK: c(11, 1), CQ: c(10, 1), CJ: c(9, 1), CT: c(8, 1),
  C7: c(5, 1), C6: c(4, 1), C5: c(3, 1), C4: c(2, 1), C3: c(1, 1), C2: c(0, 1)
};

/** 防呆：测试手牌不得有重复牌 */
function uniq(cards, label) {
  const s = new Set(cards);
  if (s.size !== cards.length) fails.push('[测试数据错误] 重复牌: ' + label + ' → ' + cards.map(x => P.cardToCode(x)).join(' '));
}
const ev = (cards, label) => { uniq(cards, label); return P.evaluate(cards); };
const val = (cards, label) => { const e = ev(cards, label); return [e.cat, e.ranks]; };

console.log('\n【1】牌型评估');
group('— 同花顺 / 皇家同花顺');
eq(val([H.SA, H.SK, H.SQ, H.SJ, H.ST], 'royal'), [8, [12]], '皇家同花顺 A高');
eq(ev([H.SA, H.SK, H.SQ, H.SJ, H.ST], 'royal').name, '皇家同花顺', '名称为皇家同花顺');
eq(val([H.S9, H.ST, H.SJ, H.SQ, H.SK], 'sfK'), [8, [11]], 'K 高同花顺');
eq(ev([H.S9, H.ST, H.SJ, H.SQ, H.SK], 'sfK').name, '同花顺', '非皇家时名称为同花顺');
eq(val([H.S9, H.ST, H.SJ, H.SQ, H.SK, H.S3, H.D2], 'sf7'), [8, [11]], '7 张牌仍取 K 高同花顺');
eq(val([H.SA, H.SK, H.SQ, H.SJ, H.ST, H.H2, H.D2], 'sf8'), [8, [12]], '7 张仍取 A 高同花顺');
// 回归：同花里缺一张关键牌就不是同花顺
eq(val([H.SA, H.SK, H.SQ, H.SJ, H.S9], 'flushOnly'), [5, [12, 11, 10, 9, 7]], 'A K Q J 9 同花缺10 → 只是同花');

group('— 四条 / 葫芦');
eq(val([H.SA, H.HA, H.CA, H.DA, H.SK, H.SQ, H.D3], 'quadsA'), [7, [12, 11]], '四条 A + K 踢脚');
eq(val([H.SK, H.CK, H.HK, H.HQ, H.CQ, H.DQ, H.D2], 'twoTrips'), [6, [11, 10]], '两条三条取高者 KKK-QQ');
eq(val([H.SK, H.CK, H.HK, H.HA, H.CA, H.SQ, H.DJ], 'boatK'), [6, [11, 12]], '葫芦 K 带 AA');

group('— 顺子（牌面须混合花色，否则会构成同花顺；且点数必须连续）');
eq(val([H.SA, H.C2, H.C3, H.D4, H.H5], 'wheel'), [4, [3]], 'A-2-3-4-5 轮子顺（混合花色），最大牌记 5');
eq(val([H.SA, H.C2, H.C3, H.D4, H.H5, H.HJ, H.SQ], 'wheel7'), [4, [3]], '7 张含两对 A 但已成顺 → 按顺子');
// 3-4-5-6-7 → 7 高顺（混合花色）
eq(val([H.C3, H.C4, H.D5, H.H6, H.S7], 'sevenHigh'), [4, [5]], '3-4-5-6-7 → 7 高顺');
eq(val([H.C3, H.C4, H.D5, H.H6, H.S7, H.DJ, H.SQ], 'sevenHigh7'), [4, [5]], '7 张仍取 7 高顺');
// 2-3-4-6-7 缺 5 → 不是顺子（7 张里最大 5 张为 Q,J,7,6,4）
eq(val([H.C2, H.C3, H.D4, H.H6, H.S7, H.DJ, H.SQ], 'gap2'), [0, [10, 9, 5, 4, 2]], '2-3-4-6-7 缺 5 → 不是顺子');

group('— 同花 / 三条 / 两对 / 一对 / 高牌');
eq(val([H.HA, H.HJ, H.H9, H.H5, H.H3, H.C7, H.D6], 'flush'), [5, [12, 9, 7, 3, 1]], '同花取最高 5 张');
eq(val([H.HA, H.CA, H.SK, H.SQ, H.HJ, H.H2, H.D3], 'pairA'), [1, [12, 11, 10, 9]], '一对 A + KQ 踢脚');
eq(val([H.HA, H.CA, H.SK, H.CK, H.SQ, H.HJ, H.D2], '2pairAK'), [2, [12, 11, 10]], '两对 A-K + Q 踢脚');
eq(val([H.SK, H.CK, H.HK, H.SQ, H.HJ, H.H2, H.D3], 'tripsK'), [3, [11, 10, 9]], '三条 K（回归：位运算优先级）');
// HA HJ H9 H5 C7 C6 D4 → 红桃 A,J,9,5（4 张不足同花），最大 5 张为 A,J,9,7,6
eq(val([H.HA, H.HJ, H.H9, H.H5, H.C7, H.C6, H.D4], 'high'), [0, [12, 9, 7, 5, 4]], '高牌取最大的 5 张');
console.log('\n【2】牌型比较');
ok(P.compare(ev([H.HA, H.CA, H.SK, H.SQ, H.SJ], 'pA'),
  ev([H.HK, H.CK, H.HQ, H.HJ, H.HT], 'pK')) > 0, '一对 A > 一对 K');
eq(P.compare(ev([H.HA, H.CA, H.SK, H.SQ, H.SJ], 'x1'),
  ev([H.HA, H.CA, H.SK, H.SQ, H.SJ], 'x2')), 0, '完全同牌力 → 0');
// 踢脚比较：一对 A+KQJ > 一对 A+KQ8
ok(P.compare(ev([H.HA, H.CA, H.SK, H.SQ, H.SJ], 'k1'),
  ev([H.HA, H.CA, H.SK, H.SQ, H.S8], 'k2')) > 0, '一对 A 踢脚 J > 8');
// 两对比较：AA-KK > AA-QQ
ok(P.compare(ev([H.SA, H.HA, H.CK, H.HK, H.SQ], 'tp1'),
  ev([H.SA, H.HA, H.CQ, H.HQ, H.SK], 'tp2')) > 0, '两对 AA-KK > AA-QQ');
ok(P.compare(ev([H.HA, H.H2, H.H3, H.H4, H.H5], 'c5'),
  ev([H.S6, H.S5, H.S4, H.S3, H.S2], 'c6')) < 0, '轮子顺(5高) < 6 高顺');
ok(P.compare(ev([H.SA, H.C2, H.C3, H.D4, H.H5], 'c7'),
  ev([H.SA, H.SK, H.SQ, H.SJ, H.ST], 'c8')) < 0, '轮子顺 < 皇家同花顺');
ok(P.compare(ev([H.HA, H.HJ, H.H9, H.H5, H.H3, H.C7, H.D6], 'c9'),
  ev([H.HK, H.HJ, H.H9, H.H5, H.H3, H.C7, H.D6], 'c10')) > 0, '同花 A 高 > 同花 K 高');
eq(P.compare(ev([H.SK, H.CK, H.HK, H.HQ, H.CQ, H.DQ, H.D2], 'c11'),
  ev([H.SK, H.CK, H.HK, H.HQ, H.CQ, H.DQ, H.D2], 'c12')), 0, '两条三条完全相同 → 0');

console.log('\n【3】边池分层（额度 100/300/50）');
const mk = (seat, committed, folded) => ({ index: seat, seat, committed, folded: !!folded });

let pots = P.buildSidePots([mk(0, 100), mk(1, 300), mk(2, 50)]);
eq(pots.map(p => p.amount), [150, 100, 200], '分层金额 150/100/200');
eq(pots.map(p => p.eligible), [[0, 1, 2], [0, 1], [1]], '资格人数 3→2→1');
eq(pots.reduce((s, p) => s + p.amount, 0), 450, '总额守恒 450');

pots = P.buildSidePots([mk(0, 100), mk(1, 300), mk(2, 50, true)]);
eq(pots.map(p => p.amount), [250, 200], 'C 弃牌：主池合并资格 250 + 边池 200');
eq(pots.map(p => p.eligible), [[0, 1], [1]], '弃牌者无资格但筹码计入池');

pots = P.buildSidePots([mk(0, 100), mk(1, 100)]);
eq(pots.map(p => [p.amount, p.eligible]), [[200, [0, 1]]], '等额全下只有主池');

pots = P.buildSidePots([mk(0, 10), mk(1, 10), mk(2, 10)]);
eq(pots[0].amount, 30, '三人等额小盲级投入 30');

pots = P.buildSidePots([mk(0, 20), mk(1, 80), mk(2, 200), mk(3, 500)]);
eq(pots.map(p => p.amount), [80, 180, 240, 300], '四路 20/80/200/500 → 80/180/240/300');
eq(pots.map(p => p.eligible.length), [4, 3, 2, 1], '资格人数 4→3→2→1');
eq(pots.reduce((s, p) => s + p.amount, 0), 800, '总额守恒 800');

pots = P.buildSidePots([mk(0, 20), mk(1, 20, true), mk(2, 20, true)]);
eq(pots.map(p => [p.amount, p.eligible]), [[60, [0]]], '仅 1 席未弃牌 → 单池 60 且独享');

console.log('\n【4】下注合法性');
const mkPlayer = (seat, stack, isHuman) => ({ id: 'p' + seat, name: 'P' + seat, seat, stack, isHuman: !!isHuman });

// 3 人桌，dealerSeat=0 → 按钮在座位1，小盲座位2，大盲座位0，座位1 先行动
let g = P.createGame({ players: [mkPlayer(0, 1000), mkPlayer(1, 1000), mkPlayer(2, 1000)], sb: 10, bb: 20, dealerSeat: 0, seed: 'legal' });
ok(g.startHand().ok, '开局成功');
eq(g.dealerSeat, 1, '按钮轮转到座位1');
eq(g.players.map(p => p.bet), [20, 0, 10], '盲注 20/0/10');
ok(g.players.every(p => p.hole.length === 2), '每人 2 张底牌');
eq(g.deck.length, 46, '牌堆剩 46 张（52 - 3 人 × 2 张）');
eq(g.actionSeat, 1, '翻牌前从大盲左手第一位（座位1）开始');

ok(!g.act(0, 'call', 0).ok, '非行动玩家不能操作');
ok(!g.act(1, 'blah', 0).ok, '未知动作被拒');

let L = g.legalActions(1);
eq(L.toCall, 20, '座位1 需跟注 20');
eq(L.minRaiseTo, 40, '最小加注 = 20 + 20 = 40');
eq(L.canCheck, false, '面对下注不能过牌');
ok(!g.act(1, 'check', 0).ok, '过牌被拒');
ok(!g.act(1, 'raise', 25).ok, '低于最小加注被拒');
ok(!g.act(1, 'raise', 99999).ok, '超过筹码被拒');

ok(g.act(1, 'raise', 60).ok, '合法加注至 60');
eq(g.currentBet, 60, 'currentBet 更新为 60');
eq(g.minRaise, 40, '最小加注幅度更新为 40');
L = g.legalActions(g.actionSeat);
eq(L.toCall, 50, '座位2 需跟注 50（60 - 10）');
eq(L.minRaiseTo, 100, '最小加注上移至 100（60 + 40）');

// 不足额全下：3 人桌 seat0=大盲(1000) seat2=小盲(30，短码)
// 座位顺序 btn=1 → 翻牌前由 seat1 先行动
g = P.createGame({ players: [mkPlayer(0, 1000), mkPlayer(1, 1000), mkPlayer(2, 30)], sb: 10, bb: 20, dealerSeat: 0, seed: 'short' });
g.startHand();
eq(g.actionSeat, 1, '翻牌前 seat1 先行动');
ok(g.act(1, 'raise', 200).ok, 'seat1 加注至 200');
eq(g.currentBet, 200, 'currentBet = 200');
// 下一位是短码 seat2（小盲已投 10，剩 20）
eq(g.actionSeat, 2, '轮到短码 seat2');
ok(g.act(2, 'call', 0).ok, '短码 seat2 跟注 → 不足额全下');
ok(g.seatOf(2).allIn, 'seat2 已 all-in');
ok(g.seatOf(2).stack === 0, 'seat2 筹码归零');
eq(g.seatOf(2).committed, 30, 'seat2 总投入 30（小盲 10 + 20）');
eq(g.players.reduce((s, p) => s + p.committed, 0), 250, '当前已投入 200+30 = 250');

// 关键回归：短码全下不得把 currentBet 拉低到 30。
// 此时 seat0 仍需跟注到 200，引擎不得因短码而降低跟注额。
ok(g.currentBet === 200, '不足额全下后 currentBet 仍为 200，未被拉低，实际 ' + g.currentBet);
const seat0Legal = g.legalActions(0);
eq(seat0Legal.toCall, 180, 'seat0 仍需跟注 180（200 - 20），实际 ' + seat0Legal.toCall);
ok(g.actionSeat === 0, '行动权回到 seat0');

ok(g.act(0, 'call', 0).ok, 'seat0 跟注 180');
// 仅剩一名可行动玩家 → 引擎应发完公共牌直接摊牌
let guard = 0;
while (!g.result && guard++ < 50 && g.actionSeat !== -1) {
  const s = g.actionSeat;
  const lg = g.legalActions(s);
  if (!lg) break;
  g.act(s, lg.canCheck ? 'check' : 'call', 0);
}
ok(g.result, '不足额全下 → 跳过剩余下注轮，牌局正常结束');
eq(g.result.type, 'showdown', '因无人可继续行动，走摊牌而非弃牌收池');
eq(g.board.length, 5, '公共牌已发满 5 张');
eq(g.result.awards.reduce((s, a) => s + a.amount, 0),
  g.players.reduce((s, p) => s + p.committed, 0), '不足额全下场景筹码守恒');
ok(g.pots.length >= 2, '短码 vs 深码产生边池，实际 ' + g.pots.length);
ok(g.players.every(p => p.stack >= 0), '无负筹码');

console.log('\n【5】蒙特卡洛胜率');
const pct = (r) => (r.equity * 100).toFixed(1) + '%';

// 无对手 → 恒为 100%
ok(P.quickEquity([H.HA, H.CA], [], 0, 100).equity === 1, '无对手 → 100%');

// 彩虹牌面 7-8-9-2-3 上，AA 只有「一对 A」而非葫芦，胜率约 80%
const rainbow = [H.S7, H.S8, H.S9, H.H2, H.D3];
const aaRainbow = P.quickEquity([H.HA, H.CA], rainbow, 1, 2000);
const akRainbow = P.quickEquity([H.HK, H.HA], rainbow, 1, 2000);
ok(aaRainbow.equity > 0.75, 'AA on 彩虹面 ≈ 一对 A，胜率约 80%，实得 ' + pct(aaRainbow));
ok(aaRainbow.equity > akRainbow.equity + 0.2,
  '同牌面 AA 显著优于 AK：' + pct(aaRainbow) + ' vs ' + pct(akRainbow));

// 已成三条的牌面：手牌 KK 只有一对 K，面对三条 A 仍有约 10% 被反超（对手能抓到 K）
const tripsBoard = [H.HA, H.CA, H.DA, H.S2, H.D3];
const tripsEquity = P.quickEquity([H.SK, H.HK], tripsBoard, 2, 2000);
ok(tripsEquity.equity > 0.80 && tripsEquity.equity < 0.98,
  'KK on AAA-2-3（三条 A）vs 2 家仍约 90%（对手可反超），实得 ' + pct(tripsEquity));

// 手牌成对 + 公共牌成对 → 中等强度
// 高牌 QJ on AA-KK-3：落后两对，但仍可抓到第三对 / 更大两对 / 顺子，
// 数学上约 55~60% 击败对手的「当前最佳」，属正常区间。
const twoPairBoard = [H.HA, H.CA, H.SK, H.CK, H.D3];
const tpEquity = P.quickEquity([H.HQ, H.HJ], twoPairBoard, 2, 2000);
ok(tpEquity.equity > 0.40 && tpEquity.equity < 0.72,
  'QJ on AA-KK-3 vs 2 家 ≈ 57%（高牌靠反超），实得 ' + pct(tpEquity));

// 结构性约束：公共牌已是坚果牌时，对手无法超越 → 全部平局分池
// equity 语义 = 期望赢得的底池份额，因此 1/(1+对手数)，而非 0
const nutsBoard = [H.SA, H.SK, H.SQ, H.SJ, H.ST];
eq(P.evaluate(nutsBoard).cat, 8, '公共牌 As Ks Qs Js Ts 构成皇家同花顺');
const nutsEquity = P.quickEquity([H.C7, H.C6], nutsBoard, 2, 2000);
ok(nutsEquity.winRate === 0,
  '72 on 公共牌皇家同花顺 → 赢牌率为 0（无牌能超越），实得 ' + pct(nutsEquity));
ok(Math.abs(nutsEquity.equity - 1 / 3) < 0.02,
  '但 equity = 1/3（三方平局分池），实得 ' + pct(nutsEquity));

const quadsBoard = [H.SA, H.HA, H.CA, H.DA, H.SK];
const quadsEquity = P.quickEquity([H.C2, H.D2], quadsBoard, 1, 2000);
ok(quadsEquity.equity < 0.51,
  '22 on 公共牌四条A vs 1 家 → 只能平分，equity ≈ 50%，实得 ' + pct(quadsEquity));

// 反向验证：公共牌 A K Q 彩虹面时，JT 同时握有同花听牌 + 顺子听牌（8 outs），
// 面对 2 个对手反超概率确实可达 80%+，这里只校验它显著高于「无听牌」的对照组
const flopBoard = [H.SA, H.SK, H.SQ];
const drawEquity = P.quickEquity([H.CJ, H.ST], flopBoard, 2, 3000);
const noDrawEquity = P.quickEquity([H.C2, H.C3], flopBoard, 2, 3000);
ok(drawEquity.equity > 0.6,
  'JT on A-K-Q（同花+顺子双重听牌）vs 2 家 → 反超概率高，实得 ' + pct(drawEquity));
ok(drawEquity.equity > noDrawEquity.equity + 0.3,
  '听牌 JT ' + pct(drawEquity) + ' 显著优于无听牌 23 ' + pct(noDrawEquity));

// 大牌 vs 随机杂牌（等张数对比，避免误记绝对区间）
const aaVs1 = P.quickEquity([H.HA, H.CA], [], 1, 6000);
const loVs1 = P.quickEquity([H.H2, H.C7], [], 1, 6000);
ok(aaVs1.equity > 0.80 && aaVs1.equity < 0.92, 'AA vs 1 家随机 ≈ 85%，实得 ' + pct(aaVs1));
ok(loVs1.equity < 0.45, '72o vs 1 家随机胜率低，实得 ' + pct(loVs1));

const aaVs3 = P.quickEquity([H.HA, H.CA], [], 3, 6000);
ok(aaVs3.equity > 0.50 && aaVs3.equity < 0.70, 'AA vs 3 家 ≈ 57%，实得 ' + pct(aaVs3));

// 对手越多，同一手牌胜率必须单调下降（结构性约束，比绝对值更可靠）
const e1 = P.quickEquity([H.HA, H.CA], [], 1, 5000).equity;
const e2 = P.quickEquity([H.HA, H.CA], [], 2, 5000).equity;
const e3 = P.quickEquity([H.HA, H.CA], [], 3, 5000).equity;
ok(e1 > e2 && e2 > e3, '胜率随对手数单调下降：1家' + pct({ equity: e1 }) + ' > 2家' + pct({ equity: e2 }) + ' > 3家' + pct({ equity: e3 }));

// 统计稳定性
const m1 = P.quickEquity([H.HA, H.CA], [], 1, 4000).equity;
const m2 = P.quickEquity([H.HA, H.CA], [], 1, 4000).equity;
ok(Math.abs(m1 - m2) < 0.03, '蒙特卡洛稳定，两次差 ' + Math.abs(m1 - m2).toFixed(4));

console.log('\n【6】听牌检测');
// 注意：牌面若已成顺/成花，detectDraws 会直接返回该牌型而不是听牌，
// 因此以下用例都需逐一确认「尚未成牌」。

// A♥Q♥ on 7♥5♥9♣ → 4 张♥ 同花听牌（9 outs）；无顺子结构
let d = P.detectDraws([H.HA, H.HQ], [H.H7, H.H5, H.C9]);
eq(d.outs, 9, 'AQ♥ on 7♥5♥9♣ → 纯同花听牌 9 outs');
ok(d.desc === '同花听牌', '描述为纯同花听牌：' + d.desc);

// 9♠8♠ on 7♠6♠4♣ → 4 张♠ 同花听牌 + 顺子结构
// 98 on 彩虹 7-6-4：缺 5（成 4-5-6-7-8）与 T（成 6-7-8-9-T）
d = P.detectDraws([H.H9, H.H8], [H.C7, H.C6, H.D4]);
eq(d.outs, 8, '98 on 7-6-4（彩虹）→ 两头顺 8 outs');
ok(/两头顺|两头卡顺/.test(d.desc), '描述为两头顺类：' + d.desc);

// 复合听牌：同花 + 顺子同时存在
d = P.detectDraws([H.HA, H.HQ], [H.HJ, H.HT, H.C9]);
ok(d.outs >= 9, 'AQ♥ on J♥T♥9♣ → 同花听牌叠加顺子结构，outs=' + d.outs);
ok(/同花/.test(d.desc), '描述含同花：' + d.desc);

// 高牌无听牌
d = P.detectDraws([H.HA, H.CK], [H.C7, H.C6, H.D5]);
eq(d.outs, 0, 'AK 高牌无听牌');

d = P.detectDraws([H.HA, H.HK], [H.CT, H.D9, H.S8]);
eq(d.outs, 0, '不成顺不成花 → 无听牌');

// 已成牌 → 不再报听牌
d = P.detectDraws([H.SA, H.C2, H.C3, H.D4, H.S5], 'madeWheel');
eq(d.outs, 0, '已成轮子顺 → 不再报听牌');
eq(d.desc, '顺子', '已成牌时描述为牌型名');

d = P.detectDraws([H.HA, H.HQ], [H.HJ, H.HT, H.C9, H.H2, H.S3]);
eq(d.outs, 0, '河牌圈不输出听牌');

console.log('\n【7】压力测试：2000 手全自动对局');
let hands = 0;
const errors = [];
for (let round = 0; round < 2000; round++) {
  const n = 2 + (round % 5);
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({
      id: 'p' + i, name: 'P' + i, seat: i,
      // 首座固定 1000，其他座阶梯额度，制造差异额度以产生边池
      stack: i === 0 ? 1000 : 1000 + (round % 7) * 400,
      style: { aggro: ((round * 7 + i * 13) % 100) / 100, tight: ((round * 11 + i * 3) % 100) / 100 }
    });
  }
  const gg = P.createGame({ players, sb: 10, bb: 20, dealerSeat: round % n, seed: 'stress-' + round });
  if (!gg.startHand().ok) continue;
  hands++;

  let step = 0;
  while (!gg.result && step++ < 400) {
    const s = gg.actionSeat;
    if (s === -1) break;
    const me = gg.seatOf(s);
    const seats = gg.inHandPlayers().map(p => p.seat);
    const pf = (seats.indexOf(s) - seats.indexOf(gg.dealerSeat) + seats.length) % seats.length;
    const legal = gg.legalActions(s);
    if (!legal) { errors.push('手' + hands + ' 无合法动作'); break; }
    const d2 = P.aiDecide({
      hole: me.hole, board: gg.board, pot: gg.potTotal(),
      toCall: legal.toCall, stack: me.stack, currentBet: gg.currentBet,
      numActive: gg.activePlayers().length,
      positionFactor: n === 2 ? 0.5 : (pf <= 1 ? 0.9 : (pf <= 3 ? 0.4 : 0)),
      style: me.style,
      // 把合法区间交给 AI，由其自行夹取
      minRaiseTo: legal.minRaiseTo, maxRaiseTo: legal.maxRaiseTo,
      rng: P.createRng('ai' + round + step)
    });
    const res = gg.act(s, d2.action, d2.amount);
    if (!res.ok) {
      errors.push('手' + hands + ' 座位' + s + ' ' + d2.action + '@' + d2.amount +
        ' 区间[' + legal.minRaiseTo + ',' + legal.maxRaiseTo + '] → ' + res.error);
      break;
    }
  }
  if (!gg.result) { errors.push('手' + hands + ' 未结束（死锁）'); continue; }
  const tin = gg.players.reduce((s, p) => s + p.committed, 0);
  const tout = gg.result.awards.reduce((s, a) => s + a.amount, 0);
  if (tin !== tout) errors.push('手' + hands + ' 筹码不守恒 in=' + tin + ' out=' + tout);
  if (!gg.players.every(p => p.stack >= 0)) errors.push('手' + hands + ' 负筹码');
  gg.pots.forEach((pool, i) => {
    if (!gg.result.awards.some(a => a.potIndex === i)) errors.push('手' + hands + ' 池' + i + ' 无赢家');
  });
}
eq(hands, 2000, '完成 2000 局');
ok(errors.length === 0, '零错误零死锁' + (errors.length ? '：\n      ' + errors.slice(0, 6).join('\n      ') : ''));

console.log('\n【8】事件溯源与序列化');
const ge = P.createGame({ players: [mkPlayer(0, 1000, true), mkPlayer(1, 1000), mkPlayer(2, 1000)], sb: 10, bb: 20, dealerSeat: 0, seed: 'evt' });
ge.startHand();
ge.act(ge.actionSeat, 'raise', 60);
ge.act(ge.actionSeat, 'call', 0);
ge.act(ge.actionSeat, 'check', 0);
ok(ge.events.length >= 5, '事件流已记录 ' + ge.events.length + ' 条');
ok(ge.events.every(e => Object.isFrozen(e)), '事件对象不可变（frozen）');
ok(ge.events.every((e, i) => e.seq === i && e.handNo === 1), '事件序号连续且带手牌号');
ok(ge.events.some(e => e.type === 'hand_start'), '含 hand_start');
ok(ge.events.some(e => e.type === 'action' && e.action === 'raise'), '含 raise 动作事件');
ok(ge.events.some(e => e.type === 'turn'), '含 turn 轮次事件');

const snap = ge.snapshot();
eq(snap.players.length, 3, 'snapshot 含全部玩家');
ok(!!snap.streetCn, '街道中文名: ' + snap.streetCn);
ok(snap.players.find(p => p.isHuman).hole !== null, '本人可见底牌');
ok(JSON.parse(JSON.stringify(snap)).players.length === 3, 'JSON 往返无损');
ok(typeof snap.pot === 'number' && snap.pot > 0, '底池金额 ' + snap.pot);

console.log('\n【9】种子复现（事件溯源前提）');
function dealOf(seed) {
  const gg = P.createGame({
    players: [mkPlayer(0, 1000), mkPlayer(1, 1000), mkPlayer(2, 1000), mkPlayer(3, 1000)],
    sb: 10, bb: 20, dealerSeat: 0, seed
  });
  gg.startHand();
  return gg.players.map(p => p.hole.join(',')).join('|') + '#' + gg.deck.slice(0, 5).join(',');
}
eq(dealOf('seed-A'), dealOf('seed-A'), '相同 seed → 完全相同牌序');
eq(dealOf('seed-A'), dealOf('seed-A'), '重复调用仍一致');
ok(dealOf('seed-A') !== dealOf('seed-B'), '不同 seed → 不同牌序');

// 回放：同 seed + 同动作序列 → 同结果
// ⚠️ 动作序列必须与局面匹配（面对下注不能 check），
//    否则 act 被拒会中断牌局，导致不同 seed 都返回 'none' 而「假性一致」。
const SCRIPT = ['raise', 'call', 'call', 'check', 'check', 'check', 'check', 'check', 'check'];
function play(seed, acts) {
  const gg = P.createGame({ players: [mkPlayer(0, 1000), mkPlayer(1, 1000), mkPlayer(2, 1000)], sb: 10, bb: 20, dealerSeat: 0, seed });
  if (!gg.startHand().ok) return 'start-fail';
  let ai = 0, n = 0;
  while (!gg.result && n++ < 200) {
    const s = gg.actionSeat;
    if (s === -1) break;
    const lg = gg.legalActions(s);
    if (!lg) break;
    const step = acts[ai++] || (lg.canCheck ? 'check' : 'call');
    // 动作与局面不匹配时回退为合法动作，避免脚本中断掩盖真实行为
    const eff = (step === 'check' && !lg.canCheck) ? 'call'
      : (step === 'raise' && !lg.canRaise ? 'call' : step);
    const amt = eff === 'raise' ? Math.min(lg.maxRaiseTo, lg.minRaiseTo) : 0;
    if (!gg.act(s, eff, amt).ok) break;
  }
  return gg.result ? JSON.stringify(gg.result.awards) : 'none';
}
const r1 = play('replay-1', SCRIPT);
const r2 = play('replay-1', SCRIPT);
ok(r1 !== 'none', '回放脚本能跑完整手牌（结果=' + r1.slice(0, 30) + '…）');
eq(r1, r2, '同 seed + 同动作 → 同结果');

// 不同 seed 结果「几乎必然」不同，但不能 100% 保证（可能撞出相同牌局），
// 因此采样多组 seed，只要多数不同即可证明 seed 确实参与了牌序生成。
let diffCount = 0, completed = 0;
for (let k = 0; k < 12; k++) {
  const a = play('s-' + k, SCRIPT);
  const b = play('s-' + k + '-x', SCRIPT);
  if (a === 'none') continue;
  completed++;
  if (a !== b) diffCount++;
}
ok(completed >= 11, '12 组回放中 ' + completed + ' 组跑完');
ok(diffCount >= 8, '12 组配对中 ' + diffCount + ' 组结果不同（seed 确实影响牌局走向）');

// 更本质的验证：底牌 + 牌堆顺序在同 seed 下完全一致，不同 seed 下几乎必然不同
let dealDiff = 0;
for (let k = 0; k < 20; k++) {
  if (dealOf('d-' + k) !== dealOf('d-' + k + '-alt')) dealDiff++;
}
eq(dealDiff, 20, '20 组配对中底牌全部不同（seed 确实决定发牌顺序）');

console.log('\n【10】行动建议模块');
const ga = P.createGame({ players: [mkPlayer(0, 1000, true), mkPlayer(1, 1000)], sb: 10, bb: 20, dealerSeat: 0, seed: 'adv' });
ga.startHand();
ga.act(ga.actionSeat, 'call', 0);
ga.act(ga.actionSeat, 'check', 0);
const adv = P.advise(ga, 0);
ok(adv && typeof adv.text === 'string' && adv.text.length > 0, '建议文本生成: ' + (adv ? adv.text.slice(0, 34) : 'null'));
ok(adv.equity >= 0 && adv.equity <= 1, '胜率区间合法: ' + adv.equityPct);
ok(['strong', 'weak', 'neutral', 'draw'].indexOf(adv.tone) !== -1, '色调字段合法: ' + adv.tone);

console.log('\n' + '='.repeat(52));
if (fails.length === 0) {
  console.log('全部通过：' + pass + ' 项断言 ✓');
  console.log('='.repeat(52) + '\n');
  process.exit(0);
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项：\n');
  fails.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  console.log('='.repeat(52) + '\n');
  process.exit(1);
}
