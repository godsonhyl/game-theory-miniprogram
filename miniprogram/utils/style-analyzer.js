/**
 * 个人风格分析（第三期，设计 docs/plans/2026-10-16-复盘教学风格分析-design.md ③）
 *
 * 定位：给玩家一面「打法画像」镜子——不是「赢不赢」（云端胜率已有），而是
 * 「怎么打」：翻前愿不愿进池（VPIP）、翻后主动还是被动（AGG）、敢不敢摊牌
 * （摊牌胜率）。三者合成四象限定位 + 2-3 条具体行为观察。
 *
 * 数据源与边界（设计文档硬约束）：
 * - 纯本地行为统计：吃 replay-store 缓存的 events 序列（listAll() 存量），
 *   不上新云端表、无新 wx API、无新隐私权限、无新合规面、不接 LLM。
 * - 不碰引擎双副本：只读已缓存的复盘记录，纯解析，不重跑引擎。
 * - 样本 < VPipMin（10 局）不硬算——返回 insufficient 态，避免小样本误导。
 * - 不做 GTO 精确对比：无权威基准，硬给「正确率」是假权威（设计文档明确不做）。
 * - 四象限文案是**描述性**（你打得紧/松、凶/弱），不评判「对错」——
 *   娱乐玩家不需要被说教。
 *
 * 事件流前提（依赖 replay-store 的收割口径，改那边前先看这边）：
 * - 每条记录 events 含补录的虚拟 action('blind')（引擎 postBlind 不发事件），
 *   VPIP 口径据此把 blind 与 preflop 的 check（大盲免费看过）排除在「自愿」外。
 * - street 字段由 addReplay 从原事件拷贝；盲目补录事件的 street = 'preflop'。
 * - result.awards 数组每项 { seat, amount }，winners 在平分池时可能多人——
 *   判胜一律用 awards（实际分钱），不用 winners。
 *
 * 纯函数、零状态、零 RNG、零 wx 依赖——可直接单测。
 */
/** 样本下限：少于此值不硬算（设计文档硬约束） */
const VPipMin = 10;
/** AGG 弱/凶分界：低于此为被动（弱），不低于为主动（凶）。边界归凶。 */
const AGG_PASSIVE = 1.0;
const AGG_AGGRESSIVE = 1.0;
/** VPIP 紧/松分界：28% 是 6 人桌常见分界，固定阈值避免「假精确」。 */
const VPIP_LOOSE = 0.28;

/** 算风格画像。list = replayStore.listAll() 的复盘记录数组。
 *  样本不足返回 { sample, insufficient: true }；否则返回完整画像对象。 */
function analyze(list) {
  const sample = Array.isArray(list) ? list.length : 0;
  if (sample < VPipMin) return { sample, insufficient: true };
  if (!sample) return { sample: 0, insufficient: true };

  let vpipCount = 0;    // 自愿进池局数
  let postAgg = 0;     // 翻后 raise + allin 计数
  let postCall = 0;    // 翻后 call 计数
  let sdCount = 0;      // 摊牌局数
  let sdWinCount = 0;  // 摊牌且获胜局数

  list.forEach(rec => {
    if (!rec || !Array.isArray(rec.events)) return;
    const mySeat = rec.mySeat;
    let myVpip = false;
    let iWon = false;
    rec.events.forEach(e => {
      if (!e || e.type !== 'action' || e.seat !== mySeat) return;
      const st = e.street;
      const action = e.action;
      if (st === 'preflop') {
        // VPIP：翻前主动参与（call/raise/allin）。blind（被动投）与
        // check（大盲免费看过）不计——标准口径，被动投入不算自愿。
        if (action === 'call' || action === 'raise' || action === 'allin') myVpip = true;
      } else if (st !== 'showdown') {
        // AGG：翻后（翻牌/转牌/河牌）激进度。raise/allin 攻击、call 跟从。
        if (action === 'raise' || action === 'allin') postAgg++;
        else if (action === 'call') postCall++;
        // check/fold 不入式（不主动也不跟注，无信息）
      }
    });
    if (myVpip) vpipCount++;

    // 摊牌判定与判胜（用 awards 不用 winners）
    const r = rec.result || {};
    const evals = r.evals || {};
    const isShowdown = r.type === 'showdown' || !!evals[mySeat];
    if (isShowdown) {
      sdCount++;
      const awards = r.awards || [];
      for (let i = 0; i < awards.length; i++) {
        const w = awards[i];
        if (w && w.seat === mySeat && Number(w.amount) > 0) { iWon = true; break; }
      }
      if (iWon) sdWinCount++;
    }
  });

  // ----- 三个指标 -----
  // VPIP = 自愿进池局数 / 总局数
  const vpip = vpipCount / sample;
  const vpipPct = Math.round(vpip * 100) + '%';
  // AGG = (raise+allin) / max(call, 1)——分母夹 1 防 0 除（全 raise 无跟注 → 高 AGG，合理）
  const agg = postAgg / Math.max(postCall, 1);
  const aggText = agg.toFixed(2) + ' : 1';
  // 摊牌胜率 = 摊牌获胜局数 / 摊牌局数（无摊牌样本记 0，观察里注明）
  const sdRate = sdCount;
  const sdRatePct = sdCount + ' 次';
  const sdWin = sdCount > 0 ? sdWinCount / sdCount : 0;
  const sdWinPct = sdCount > 0 ? Math.round(sdWin * 100) + '%' : '—';

  // ----- 四象限 -----
  const tight = vpip < VPIP_LOOSE;
  const passive = agg < AGG_PASSIVE;
  let quadrant, quadrantTag;
  if (tight && passive) { quadrant = '紧弱'; quadrantTag = 'tight-passive'; }
  else if (tight && !passive) { quadrant = '紧凶'; quadrantTag = 'tight-aggressive'; }
  else if (!tight && passive) { quadrant = '松弱'; quadrantTag = 'loose-passive'; }
  else { quadrant = '松凶'; quadrantTag = 'loose-aggressive'; }

  // ----- 2-3 条具体行为观察（描述性、不评判；挑最显著的，避免堆砌） -----
  const obs = [];
  if (vpip < 0.20) obs.push('翻前很挑剔，只打好牌');
  else if (vpip > 0.45) obs.push('翻前入池很积极，手牌范围宽');
  if (agg < 0.7) obs.push('翻后偏被动，多跟注少加注');
  else if (agg > 1.8) obs.push('翻后很主动，频繁加注施压');
  if (sdCount === 0) obs.push('近期没有摊牌样本（都超前结束了）');
  else if (sdCount >= 3 && sdWin < 0.4) obs.push('摊牌时赢面偏低，留意是否带弱牌到摊牌');
  else if (sdWin > 0.6) obs.push('摊牌选牌质量不错');
  const observations = obs.slice(0, 3);

  return {
    sample, vpip, vpipPct, agg, aggText,
    sdRate, sdRatePct, sdWin, sdWinPct,
    quadrant, quadrantTag, observations
  };
}

module.exports = { analyze, VPipMin, AGG_PASSIVE, AGG_AGGRESSIVE };
