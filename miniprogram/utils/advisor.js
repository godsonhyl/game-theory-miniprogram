/**
 * AI 教学提示文案（第二期，设计 docs/plans/2026-10-16-复盘教学风格分析-design.md ②）
 *
 * 定位：把引擎 advise() 的胜率/赔率数字翻译成「新手能读懂的牌理」。
 * 引擎 advise() 只说结论（「胜率高可跟注」「胜率低建议弃牌」），不讲为什么；
 * 这里补两层教学性内容，引擎不产、也不该产（引擎纯逻辑，文案是表现层）：
 *   1) classifyHole —— 翻前起手牌分类标签：新手看到「胜率 63%」无法对应到
 *      「这手该不该玩」，分类标签（顶口袋对子/同花连张/垃圾牌）补这个直觉。
 *   2) explainAdvice —— 各街动作的牌理解释：把「胜率 vs 赔率」翻译成一句牌理
 *      （如「胜率低于所需赔率，长期跟注必亏，弃牌省筹码」）。
 *
 * 合规（与设计文档一致，门槛不变）：
 *   - 纯客户端规则文案，**不接 LLM/外部服务**——无网络、无新隐私权限。
 *   - 本模块只被 table.js 的 renderAdvice 调用，而 renderAdvice 有
 *     `mode !== 'ai'` 守卫（好友房/匹配关闭），引擎 advise() 另有 practiceMode
 *     开关双保险。advisor 不新增任何调用点、不绕过门槛。
 *   - 不碰引擎双副本：只吃引擎返回的标量 + 我的底牌 id，复用 rankOf/suitOf
 *     取编码，不自己算牌（避免与引擎编码分叉）。
 *
 * 纯函数、零状态、零 RNG、零 wx 依赖——可直接单测。
 */
const P = require('../core/poker-core.js');

/** 翻前起手牌分类。hole = 两张牌 id（0..51）。返回 { label, tag, tier }。
 *  tag ∈ {premium,strong,playable,marginal,trash}，tier 1..5（1 最强，供 UI 配色）。
 *  分桶用经典起手牌表（静态规则、无 RNG），边界取舍按「新手友好」偏保守：
 *  小同花 A、同花连张归 marginal 而非 playable（它们好看但需位置与读牌功底，
 *  新手易高估）；AKo 归 premium（大非同花两高张实战占优，与多数教学表一致）。 */
function classifyHole(hole) {
  if (!hole || hole.length < 2) return null;
  const r1 = P.rankOf(hole[0]);      // 0..12（2..A）
  const r2 = P.rankOf(hole[1]);
  const s1 = P.suitOf(hole[0]);       // 0..3
  const s2 = P.suitOf(hole[1]);
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  const suited = s1 === s2;          // 同花
  const pair = r1 === r2;           // 口袋对子
  const gap = hi - lo;               // 间隔（0=对子/连张）

  // 对子：按点数分档
  if (pair) {
    if (hi >= 11) return { label: '顶口袋对子', tag: 'premium', tier: 1 };   // AA KK
    if (hi === 10) return { label: '强口袋对', tag: 'strong', tier: 2 };     // QQ
    if (hi === 9) return { label: '强口袋对', tag: 'strong', tier: 2 };     // JJ
    if (hi === 8) return { label: '中口袋对', tag: 'strong', tier: 2 };     // TT
    if (hi >= 4) return { label: '中口袋对', tag: 'playable', tier: 3 };    // 99..66
    if (hi >= 2) return { label: '小口袋对', tag: 'playable', tier: 3 };    // 55..33
    return { label: '小口袋对', tag: 'marginal', tier: 4 };                  // 22
  }
  // 非对子
  // AK（同花与非同花）——大两高张，实战占优
  if (hi === 12 && lo === 11) {
    return { label: suited ? 'AK 同花' : 'AK 大高张', tag: 'premium', tier: 1 };
  }
  // AQ：同花强，非同花仍可
  if (hi === 12 && lo === 10) {
    return { label: suited ? 'AQ 同花' : 'AQ 高张', tag: suited ? 'strong' : 'strong', tier: 2 };
  }
  // AJ
  if (hi === 12 && lo === 9) {
    return { label: suited ? 'AJ 同花' : 'AJ 高张', tag: 'playable', tier: 3 };
  }
  // KQ
  if (hi === 11 && lo === 10) {
    return { label: suited ? 'KQ 同花' : 'KQ 高张', tag: 'strong', tier: 2 };
  }
  // KJ
  if (hi === 11 && lo === 9) {
    return { label: 'KJ 同花', tag: 'playable', tier: 3 };
  }
  // 同花连张（gap ≤ 2 且都 ≥ 8）——好看但需位置，归 playable
  if (suited && gap <= 2 && lo >= 8) {
    return { label: '大同花连张', tag: 'playable', tier: 3 };
  }
  // 小同花 A（A2s..A9s）——有 nut 同花潜力，但需翻牌配合
  if (hi === 12 && suited && lo < 8) {
    return { label: '小同花 A', tag: 'marginal', tier: 4 };
  }
  // 任意两张同花且都 ≥ T（10）——同花高张
  if (suited && lo >= 8 && gap <= 3) {
    return { label: '同花高张', tag: 'marginal', tier: 4 };
  }
  // 非同花两高张（都 ≥ T）但间隔大
  if (!suited && hi >= 10 && lo >= 8 && gap <= 4) {
    return { label: '高张非同花', tag: 'marginal', tier: 4 };
  }
  // 同花连张但低牌（如 67s）
  if (suited && gap <= 2) {
    return { label: '同花连张', tag: 'marginal', tier: 4 };
  }
  // 其余：垃圾牌
  return { label: '垃圾牌', tag: 'trash', tier: 5 };
}

/** 解析 equityPct 字符串「62.3%」→ 0.623。失败返回 null。 */
function parsePct(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/([\d.]+)%/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return isNaN(v) ? null : v / 100;
}

/** 各街动作的牌理解释。
 *  advice = renderAdvice 已精简后写入 data.advice 的对象
 *           { equityPct, potOdds, text, tone, drawDesc, drawOuts }。
 *  ctx = { street, toCallZero }。street ∈ preflop/flop/turn/river/showdown；
 *         toCallZero = 是否过牌局面（无人下注，可免费过牌）。
 *  返回 { tip, cls }：tip 一行中文牌理，cls 复用 tone 取值供配色。
 *  只用 advice 现有字段拼文案，不重算胜率、不依赖引擎实例。 */
function explainAdvice(advice, ctx) {
  if (!advice || !advice.tone) return { tip: '', cls: 'neutral' };
  const tone = advice.tone;
  const eq = parsePct(advice.equityPct);       // 0..1 或 null
  const odds = parsePct(advice.potOdds);      // 0..1 或 null
  const preflop = ctx && ctx.street === 'preflop';
  const toCallZero = !!(ctx && ctx.toCallZero);
  const drawOuts = advice.drawOuts || 0;

  let tip = '';
  // 过牌局面优先：无论 tone，无人下注时策略是「免费看牌/控制底池」
  if (toCallZero) {
    if (tone === 'strong') {
      tip = preflop
        ? '起手牌占优且无人加注，可加注收窄对手、扩大底池'
        : '已成强牌且无人下注，主动下注让对手为听牌付出代价';
    } else {
      tip = '无人下注，免费看一张牌，过牌控制底池';
    }
    return { tip, cls: tone === 'strong' ? 'strong' : 'neutral' };
  }

  if (tone === 'strong') {
    tip = preflop
      ? '起手牌占优 + 胜率高，加注收窄对手、扩大底池'
      : '已成强牌，价值下注让对手为听牌付出代价';
  } else if (tone === 'draw') {
    if (drawOuts > 0) {
      tip = '听约 ' + drawOuts + ' 张补牌，底池赔率 ' + advice.potOdds +
        ' 低于成牌率，长期跟注有利';
    } else {
      tip = '有听牌潜力，按底池赔率决定是否跟注';
    }
  } else if (tone === 'weak') {
    tip = '胜率 ' + advice.equityPct + ' 远低于所需赔率 ' + advice.potOdds +
      '，长期跟注必亏，弃牌省筹码';
  } else {   // neutral
    tip = preflop
      ? '中等牌力，位置有利可便宜看牌，不利位置弃'
      : '胜率与赔率接近，边际手，按对手风格与位置决定';
  }
  return { tip, cls: tone };
}

module.exports = { classifyHole, explainAdvice, parsePct };
