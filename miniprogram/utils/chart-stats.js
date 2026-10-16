/**
 * 战绩深化图表数据计算（方向 A，纯客户端、零新依赖）
 *
 * 定位：给「我的」页加三张纯 CSS 图表——胜率曲线 / 牌型分布 / 盈亏走势。
 * 吃 auth.listRecords 返回的 poker_records 流水（与战绩列表同源），纯函数
 * 聚合后交给 wxml 用 transform: scaleY / width:{{x}}% 渲染。
 *
 * 设计硬约束（与 style-analyzer 同口径）：
 * - 纯函数、零状态、零 wx 依赖、零 cloud 依赖、零 RNG——可直接单测。
 * - 不碰引擎双副本，不碰 auth.js，不碰 sync 链路。
 * - 不引新色：沿用仓库既有色系（绿 #4caf7d / 金 #d9a441 / 红 #e05c4b / 灰 #8fa8a0）。
 * - 重排红线：动态视觉只靠 transform: scaleY + opacity，不动画 width/top/left。
 * - 无 canvas、无图表库——仓库零 canvas 先例、零图表依赖，这是硬约束。
 *
 * rows 是 auth.listRecords 返回的 record 数组，每行字段含
 * won(boolean) / net(number) / hand_type(string|null) / created_at。
 */

/** 每块手数：胜率曲线按 CHUNK_SIZE 手一块聚合 */
const CHUNK_SIZE = 10;

/**
 * 胜率曲线：rows 按 CHUNK_SIZE 切块，每块算 wins/len*100。
 * 返回 { chunks, overallPct }。
 * - chunks: 每项 { pct, color, scale, range }
 *   color 阈值：≥50% 绿 / 30–50% 金 / <30% 红
 *   scale = pct/100（给 transform: scaleY 用）
 *   range = 该块手数范围字符串如 "1-10"
 * - overallPct: 总胜率（0–100 整数）
 * 空 rows 返回 { chunks: [], overallPct: 0 }。
 */
function computeWinRate(rows) {
  if (!Array.isArray(rows) || !rows.length) return { chunks: [], overallPct: 0 };
  const chunks = [];
  let totalWins = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const slice = rows.slice(i, i + CHUNK_SIZE);
    const wins = slice.filter(r => r && r.won).length;
    const pct = Math.round(wins / slice.length * 100);
    const color = pct >= 50 ? '#4caf7d' : pct >= 30 ? '#d9a441' : '#e05c4b';
    const scale = pct / 100;
    const start = i + 1;
    const end = i + slice.length;
    chunks.push({ pct, color, scale, range: start + '-' + end });
    totalWins += wins;
  }
  const overallPct = Math.round(totalWins / rows.length * 100);
  return { chunks, overallPct };
}

/**
 * 牌型分布：按每行 hand_type 分组计数。
 * hand_type 为空时按 won 兜底：won 真 → '获胜'，否 → '未中牌'。
 * （'获胜'/'未中牌' 与 table.js 的 HAND_NAME 兜底口径一致。）
 * 降序排，pct = count/maxCount*100，零计数类型不返回。
 * 每项 { name, count, pct }。空 rows 返回 []。
 */
function computeHandTypes(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const counts = {};
  rows.forEach(r => {
    if (!r) return;
    let name = r.hand_type;
    if (!name) name = r.won ? '获胜' : '未中牌';
    counts[name] = (counts[name] || 0) + 1;
  });
  const entries = Object.keys(counts)
    .map(name => ({ name, count: counts[name] }))
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count);
  const maxCount = entries.length ? entries[0].count : 1;
  return entries.map(e => ({
    name: e.name,
    count: e.count,
    pct: Math.round(e.count / maxCount * 100)
  }));
}

/**
 * 盈亏走势：逐手 { val, scale, cls }。
 * val = net（整数筹码）；maxAbs = max(|net|)；
 * scale = maxAbs>0 ? |net|/maxAbs : 0（给 transform: scaleY 用）；
 * cls = net>=0 ? 'up' : 'down'（正柱绿、负柱红）。
 * 另返回 sum（净盈亏总和，整数）与 sumText（带符号字符串）。
 * 空 rows 返回 { bars: [], sum: 0, sumText: '0' }。
 */
function computeNetTrend(rows) {
  if (!Array.isArray(rows) || !rows.length) return { bars: [], sum: 0, sumText: '0' };
  const bars = rows.map(r => {
    const val = (r && typeof r.net === 'number') ? r.net : 0;
    return { val, cls: val >= 0 ? 'up' : 'down' };
  });
  let maxAbs = 0;
  bars.forEach(b => { const a = Math.abs(b.val); if (a > maxAbs) maxAbs = a; });
  bars.forEach(b => { b.scale = maxAbs > 0 ? Math.abs(b.val) / maxAbs : 0; });
  let sum = 0;
  bars.forEach(b => { sum += b.val; });
  const sumText = sum > 0 ? '+' + sum : '' + sum;
  return { bars, sum, sumText };
}

module.exports = {
  CHUNK_SIZE,
  computeWinRate,
  computeHandTypes,
  computeNetTrend
};
