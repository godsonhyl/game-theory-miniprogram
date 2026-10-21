/**
 * 牌桌几何纯函数（座位环坐标 + 几何预算常量）
 *
 * 为什么单独成模块：
 *   这些函数原本内嵌在 pages/table/table.js（6000+ 行）里，测试要验证几何时
 *   只能用正则把 `ringPositions` 和一堆常量从源码字符串里「抠」出来，再拼成
 *   一个新函数求值（`new Function(常量 + 函数 + module.exports)`）。这个做法
 *   本身是脆的——常量截取范围靠正则的起止锚点，上加一行注释/改一次声明顺序
 *   就可能漏截，而且漏截时报的错是 `ReferenceError`，会被误读成「几何实现错了」。
 *   2026-10-21 就因为多加了 FELT_UH_FALLBACK/uhToFelt 两个依赖而被迫改正则。
 *   抽成模块后测试直接 `require`，几何从「字符串抠取 + 动态求值」变成真正的
 *   单元测试。
 *
 * 与页面解耦的边界：
 *   - 本模块**只做纯计算**：输入座位集合 / 我的座位 / felt 实测高度，输出坐标。
 *     不读 wx、不读 this.data、不碰 setData。
 *   - 唯一的模块级状态是 `ringPositions` 的坐标缓存（纯函数缓存，输入相同必得
 *     同一结果），不构成副作用。
 *   - felt 高度由页面 `measureFelt()` 运行时实测后作为参数传入（不写死机型数值），
 *     测量失败时才用 FELT_UH_FALLBACK 兜底。
 *
 * ⚠️ uh 与 felt% 是两套单位（2026-10-21 用户核实的历史病根）：
 *   - 纵向 CSS 尺寸全部是 uh（--uh = 实测视口高 1%），如胶囊高 7.6uh、座位块高 26.4uh；
 *   - 而定位坐标（.pot-row top、座位 x/y）是 felt%——相对 .felt 高（flex:1
 *     弹性容器，playing 态实测仅 ≈65.9uh，非 100uh）。
 *   felt 只有 100uh 的约 2/3 高，1felt% ≈ 1.52uh。历史上代码把两套单位直接相减
 *   （potTop = 35 − 7.6/2 = 31.2），底池上沿被高估约 2 个 felt 点位，顶排块底
 *   实际越界约 6%——“顶排被底池挡住、怎么修都差一点”的根因。
 *   修正口径：所有 uh→felt% 判定一律经 `uhToFelt()` 换算，禁止裸减。
 */

/**
 * felt 高度回退值（uh）。仅测量不可用时兜底，取 playing 态保守估计：
 * 100 − 页面固定开销（padding 1.6 + topbar 5.6 + felt margin 0.4）−
 * myzone 常驻（mybar 14.5 + actbar 10.8 + margins 2.6）≈ 65.9。宁可偏小
 * （换算放大、天花板收紧方向），不得偏大（重现遮挡）。
 */
const FELT_UH_FALLBACK = 65;

/**
 * uh → felt% 换算（四舍五入到 0.1 felt% 防长尾）。
 * feltUh 缺省/非法时按 100uh 退化（与旧口径一致），保证任何调用路径拿到的
 * 都是有限值——几何函数里出现 NaN 会让座位飞到屏幕外且难以排查。
 */
function uhToFelt(uh, feltUh) {
  const f = feltUh > 0 ? feltUh : 100;
  return Math.round(uh * 100 / f * 10) / 10;
}

/**
 * C5（玩家审视 2026-10-17）：底池中心的 felt% 坐标 —— 筹码飞行（下注飞出/
 * 收池飞回）的锚点。必须与 table.wxss 的 .pot-row `top:22%` 同源：原先 JS
 * 硬编码 (50,32)、wxss 是 22%，飞进底池的筹码视觉上落在池下方一截
 * （「筹码没进池」的错觉）。改任何一处必须同步另一处（两侧注释均已标注）。
 */
const POT_ANCHOR = { x: 50, y: 35 };

/**
 * 座位块几何预算（pie 环唯一的纵向天花板依据）。
 *
 * 实测病根（2026-10-19）：顶排座位块是「锚点向下延伸」的——头像 + 名牌 +
 * SB/BB + 两张牌背，逐项按 WXSS 折算 = 8.6+3.6+3.88+10.28 ≈ 26.4%（牌桌高
 * = 100uh）。旧版底池固定在 top:22%（上沿 ≈18.6%），块底必撞底池带，
 * 被压住的恰恰是玩家最该读的「筹码 / 本轮下注」。纯升 z-index 救不了
 * 「自己被盖」。
 *
 * 方案（已落地）：底池下移到公共牌正上方（35%）；下注胶囊浮到锚点上方
 * （不占块底）；顶排锚点天花板 = 底池胶囊上沿 − 半块 − 空隙，由
 * ringPositions 按下方常量现算，不再写裸数字。
 *
 * ⚠️ POT_PILL_H 的实测口径（2026-10-19 评审收窄）：pot-amount 字号 4.8uh ×
 * 默认行高 ≈1.35 + 上下 padding 2×0.5uh + 1rpx 边框 ≈ 7.6uh。旧估 6.8 漏了
 * 行高系数，会让顶排块底压住底池约 1px（余量算出来恰好是 0）。
 */
const SEAT_H_PX_UH = 26.4;        // 座位主体块高（uh 单位 = 牌桌百分比）
const SEAT_H_PX_UH_TIGHT = 22.4;  // 7 座以上紧凑模式

/** 顶排锚点 y 下限：座位号/庄家徽章 .overlay 向上溢出 ≈ 2.2uh，留 3.4uh 才不出桌沿。 */
const RING_TOP_MIN = 3.4;

/** 环形布局：对手锚点 y 的安全上界。椭圆自然值侧边约 27~33%，此上界只防
 *  「未来把 ry 调大后座位沉到我的座位/底部按钮上」。
 *  ⚠️ 不再用「底池上沿 − 半块」当统一天花板：那会把左右两侧的座位也拽到顶排，
 *  整个环压成顶部一条细带（真机「布局难看」）。遮挡改由 2D 判据保证——
 *  只有 x 落在中央走廊（|x−50| < SEAT_CORRIDOR_HALF_W）的座位才要求块底
 *  不越过底池上沿；两侧座位在底池/公共牌的 x 范围之外，天然不重叠。 */
const RING_Y_MAX = 50;

/** 中央走廊半宽（width%）：公共牌 5 张约 34% 宽（半 17）+ 描边余量 = 18。
 *  座位块中心与 50 的横向距离小于它，才可能压到中央盘面。 */
const SEAT_CORRIDOR_HALF_W = 18;

/** 底池胶囊高度（uh）：实测口径见上方注释（行高 1.35 + padding + 边框）。 */
const POT_PILL_H = 7.6;

/** 行动气泡从座位块底向下的总落深（uh）= bottom 偏移 1 + 自身高约 4.1。
 *  用于判断「这个座位的气泡会不会掉进底池带」：块底 + 本值 > 底池上沿即越界。
 *  气泡高 = 字号 2.6 × 行高 1.35 + padding 0.25×2 + 边框 ≈ 4.1；取 5.1 合计。
 *  ⚠️ 改 .act-bubble 的字号/padding 时必须同步这个常量。 */
const ACT_BUBBLE_DROP_UH = 5.1;

/* 等待/弃牌态的座位内容栈高（uh）＝ 头像 8.6 + 名牌 3.6（margin .6 + 名字行 ≈3）
 *  + 徽章行 3.8（margin .3 + 行高 3.2 + 边框）≈ 16.0（2026-10-21 实测）。
 *  它与 SEAT_H_PX_UH（26.4）服务于两个不同的判定口径：
 *   - SEAT_H_PX_UH 是「牌背可见」态块高——牌背行（.seat-cards 是文档流子元素，
 *     0.4 margin + 9.8 高 ≈ 10.3uh）已含在 26.4 里、就在块底。⚠️ 曾误在块底
 *     之外再 +10.3 当「牌背落深」——双计，把 topRow 判据撑高了一档。
 *   - 本常量是「无牌态」（等待室全员 / 游戏中弃牌·空位）的真实块高——等待模式
 *     与游戏模式共用坐标，几何判定必须按各态实际块高分口径（见 ringPositions
 *     走廊天花板与 guardSeatCardNoOverlap 双口径断言）。
 *  ⚠️ 改头像/名牌/徽章样式时必须同步（与 SEAT_H_PX_UH 同一纪律）。 */
const SEAT_META_STACK_UH = 16.0;

/** 紧凑模式（7 座以上）内容栈高：头像 7.2 + 名牌 3.7 + 徽章行 3.5 ≈ 14.5。 */
const SEAT_META_STACK_TIGHT_UH = 14.5;

/** 走廊座位内容天花板与底池上沿的最小间隙（felt%）。内容栈块底贴住底池时仍留
 *  此余量，防真机字体行高抖动把徽章行推进底池胶囊。 */
const RING_CEIL_GAP = 0.3;

/** 底池胶囊的保守半宽（uw，占屏宽百分数）。金额位数越多越宽：
 *  「底池 30」约 ±7uw，「底池 125000」约 ±10uw。取 11 覆盖到七位数，
 *  宁可多判几个座位走 bub-top，也不要漏判导致气泡被底池吃掉。 */
const POT_SAFE_HALF_W = 11;

/** 行动气泡的保守半宽（uw）：「加注 12500」这类最长文案约 ±11uw 量级，
 *  按座位块宽 104rpx（约 7uw）也不足以覆盖，故取块宽与最长文案的最大者。 */
const ACT_BUBBLE_HALF_W = 11;

/**
 * 9 位桌座位模板（不含「我」，7 项 → 实为 8 个对手？见下方说明）。
 *
 * 顺序按顺时针：左下 → 左中 → 左上 → 顶 → 右上 → 右中 → 右下。
 * 侧位都在中央走廊（|x−50| < 18）之外，不遮底池/公共牌；内侧 y=50 与顶部
 * 块底（≈27）、我的座位块（y≈68.8 起）均不重叠。
 *
 * ⚠️ 两项数必须 = 桌面座位数 − 1（「我」占一个位，不在模板里）。9 位桌模板
 * 只有 8 项、8 位桌 7 项——**缺项会走 placeOnArc 兜底**，兜底坐标与模板坐标
 * 撞车（实测 (86.5,26.8) 与 (88,50) 重合），顶排被挤死。测试有「模板项数 +
 * 两两不交叠」守卫钉死这一点。
 */
const NINE = [
  { x: 24, y: 50 }, { x: 10, y: 38 },
  { x: 30, y: 16 }, { x: 43, y: 14 }, { x: 57, y: 14 }, { x: 70, y: 16 },
  { x: 90, y: 38 }, { x: 76, y: 50 }
];

/**
 * 8 位桌座位模板（每侧 2 个侧位 + 顶部 3 个，共 7 项 = 8 座 − 我）。
 *
 * 8 位桌与 9 位桌对齐（2026-10-21 评审：8 位是唯一顶排密度超标桌型——
 * 顶排 5 座块宽 69.5% 挤在 67% 跨度里，密度超 100%；其余桌型均 ≤92%）。
 *
 * ⚠️ 同侧两座必须**横向**错开 ≥ 内容盒宽：内侧位先放在 x=10 曾与外侧 x=12
 * 交叠（dx 仅 2% ≈ 17px，横向压住 52.8px——纵向 12 felt% 的差远小于块高
 * 34.5 felt%，拉不开只能靠横向，2026-10-21 第二轮 review 实测）。挪到 x=26
 * （与 9 位桌红框位 24 对齐）与外侧差 14% > 块宽；顶部 [36,50,64] 间距 14%
 * 同理。模板必须凑满 total-1=7 项：缺项走 placeOnArc 兜底落在 (86.5,26.8)
 * 会与 (88,50) 重合，测试有「模板项数 + 两两不交叠」守卫钉死。
 */
const EIGHT = [
  { x: 12, y: 50 }, { x: 26, y: 38 },
  { x: 36, y: 16 }, { x: 50, y: 14 }, { x: 64, y: 16 },
  { x: 74, y: 38 }, { x: 88, y: 50 }
];

/** ringPositions 的模块级坐标缓存（纯函数缓存：seatSet+mySeat+feltUh 唯一决定结果） */
const _ringCache = {};

/**
 * 统一座位环坐标（WPK 式环形）。
 *
 *   - 「我」锚定在椭圆底部中央（y=82），底部留给我的手牌 + 操作条；
 *   - 其余对手沿「上方半圆」铺开（左 200° → 顶 270° → 右 340°），
 *     保留椭圆**自然 y**：左右两侧座位落在 y≈27~33%，形成真正的环形，
 *     而不是全被夹到顶部一条细带（2026-10-19 用户「布局难看」的根因）。
 *   按相对座位号（顺时针从我左侧起）排序，牌桌左右邻接关系符合直觉。
 *   等待室与游戏中共用同一套坐标 → 点「开始游戏」瞬间所有座位位置完全连续、无跳变。
 *
 * 座位排布（2026-10-19 环形恢复 + 2D 遮挡判据）：
 *   - 座位块以锚点为中心、四外延伸；对手下注胶囊浮在**块底内侧**（.seat-bet.bet-in），
 *     我的浮在块上方（.bet-me）——既不被桌沿裁掉，也不侵入底池带。
 *   - 遮挡不用「统一 y 天花板」（那会把侧边座位也顶到顶排），而是 **2D 判据**：
 *     只有 x 落在中央走廊（|x−50| < SEAT_CORRIDOR_HALF_W）的座位才要求
 *     内容栈底 ≤ 底池上沿；两侧座位在底池/公共牌的 x 范围之外，垂直重叠无妨。
 *   - down 排布已删除（纵向尺寸全为 uh 相对量，比值不随视口变化）。
 *
 * @param {number[]} seatSet 房间全部座位号（含空位——render 传 allSeats，
 *        不是在座人数：8 位房 7 人局也要按 8 算，否则侧位不生效）
 * @param {number} mySeat 我的座位号（固定在底部中央）
 * @param {number} [feltUh] 实测 .felt 高度（uh）；缺省/非法时用 FELT_UH_FALLBACK
 * @returns {object} 座位号 → { x, y }（felt%），附加 __layout 供调试与断言
 */
function ringPositions(seatSet, mySeat, feltUh) {
  const F = feltUh > 0 ? feltUh : FELT_UH_FALLBACK;
  const arr = seatSet.slice().sort((a, b) => a - b);
  // 模块级缓存：座位坐标是纯函数（seatSet + mySeat + feltUh 唯一决定），座位组合
  // 有限（≤9 座），命中即返回同一对象，省去每帧重算三角函数。键含 feltUh——
  // 转屏/机型不同的实测值不同，缓存必须按基准分道。
  const cacheKey = arr.join(',') + ':' + mySeat + ':' + F;
  if (_ringCache[cacheKey]) return _ringCache[cacheKey];
  const total = arr.length;
  if (total === 0) return {};
  const idxMe = Math.max(0, arr.indexOf(mySeat));
  // 椭圆参数：cy/ry 决定对手座位带的纵向范围。大桌（7 座及以上）把椭圆撑宽
  // 压扁：座位越多弧上越挤，不加宽的话 8~9 人桌两侧座位会叠在一起（配合
  // .seat.tight 缩小座位块）。
  const big = total >= 7;
  const cx = 50, cy = 42, rx = big ? 46 : 43, ry = big ? 25 : 27;
  // 座位块高 / 底池上沿：uh → felt% 换算后才与 x/y 同单位（两套单位直减是旧病根）。
  const blockPct = uhToFelt(big ? SEAT_H_PX_UH_TIGHT : SEAT_H_PX_UH, F);
  // 无牌态内容栈高（头像+名牌+徽章，不含牌背行）:走廊座位必然隐藏牌背
  // （见 render 的 topRow 判据），.seat 盒按实际子元素渲染、锚点按实际盒高
  // 居中——走廊座位的真实盒只有 meta 栈那么高，天花板必须按它算。
  const metaPct = uhToFelt(big ? SEAT_META_STACK_TIGHT_UH : SEAT_META_STACK_UH, F);
  const potTop = POT_ANCHOR.y - uhToFelt(POT_PILL_H, F) / 2;
  /* 走廊内容天花板（felt%）：y 的上界按口径分两档（2026-10-21 双口径修复）——
   *   - 走廊座位（|x−50| < SEAT_CORRIDOR_HALF_W）与底池横向相叠，其内容栈
   *     块底不得侵入底池上沿：天花板 = potTop − meta 半栈 − RING_CEIL_GAP。
   *     用 meta 而非完整块（26.4uh）：按完整块算 F=65 时天花板 ≈8.6，块顶被压到
   *     ≈−11.7 felt%——头像整段被 .table-page overflow:hidden 裁掉（真机即
   *     「顶排头像消失」）。走廊座位牌背本就被 topRow 判据隐藏，块里没有牌背
   *     段，按 meta 栈算天花板 ≈16.6，头像段完整落在 felt 顶内。
   *   - 侧位不压（x 在走廊之外，与底池横向不相交），沿用 RING_Y_MAX。
   * 顶排头像上沿仍可能越过 felt 顶部 10% 以内：felt border-radius 50%/42%
   * 的外圆角区域本来就无内容可裁，且仍在页面 pad 内，无碍。
   * 已知残余（接受）：SB/BB 座位在翻前会多出 pos-tag 行（+3.8uh），其徽章行
   * 可能探入底池带 ≈2 felt%——仅翻前、仅 2 个座位、不覆盖筹码数字，且为
   * 2026-10-19 前旧布局就有的历史量级，不动主布局去消它。 */
  const ceilFelt = potTop - metaPct / 2 - RING_CEIL_GAP;
  const corridorYmin = Math.max(RING_TOP_MIN, ceilFelt);
  const layout = {
    feltUh: F,
    blockPct: blockPct,
    metaPct: metaPct,
    potTop: Math.round(potTop * 10) / 10,
    ceil: Math.round(corridorYmin * 10) / 10
  };
  const pos = {};
  if (total === 1) {
    pos[arr[0]] = { x: 50, y: 82 };
    pos.__layout = layout;
    _ringCache[cacheKey] = pos;
    return pos;
  }
  // 锚点（我）固定在底部中央
  pos[mySeat] = { x: 50, y: 82 };
  // 对手按顺时针座次（从我左侧开始）依次排到上方半圆
  const opp = [];
  for (let k = 1; k < total; k++) opp.push(arr[(idxMe + k) % total]);
  const O = opp.length;
  /* 顶部弧：200°(左上) → 270°(顶) → 340°(右上)。走廊座位（|x−50| < 走廊半宽）
   * 的 y 压到「内容天花板」之下——块内名牌/徽章行（最该读的信息）贴住底池
   * 上沿但不侵入；头像段可越 felt 顶（椭圆外角无内容可裁，见上方注释）。
   * 侧位不压线（椭圆自然 y + RING_Y_MAX 上界），两侧与底池横向不相交。 */
  const placeOnArc = (s, j, M) => {
    const t = (j + 1) / (M + 1);
    const ang = 200 + t * 140;
    const rad = ang * Math.PI / 180;
    let x = cx + rx * Math.cos(rad);
    let y = cy + ry * Math.sin(rad);
    x = Math.max(10, Math.min(90, +x.toFixed(1)));
    if (Math.abs(x - 50) < SEAT_CORRIDOR_HALF_W) {
      y = Math.min(y, corridorYmin);
    }
    y = Math.max(RING_TOP_MIN, Math.min(RING_Y_MAX, +y.toFixed(1)));
    pos[s] = { x, y };
  };

  // 5 人以上（5~9 个座位）优化座位分布（2026-10-21 用户：6 个对手全挤在顶部
  // 弧上太拥挤；「6 人以上都得优化」；9 位桌「再加一个到红框，左右对称」）。
  // ⚠️ total = 房间座位数（含空位，render 传的是 allSeats），不是在座人数：
  // 8 位房 7 人局也要按 8 算，否则侧位不生效。
  if (total >= 9) {
    // 9 位桌：每侧 2 个（外侧 + 内侧红框位置），顶部 4 个；左右镜像。
    opp.forEach((s, k) => {
      if (NINE[k]) pos[s] = NINE[k];
      else placeOnArc(s, k, O);   // 兜底：理论 maxSeats≤9，防未来放宽
    });
  } else if (total >= 8) {
    // 8 位桌：每侧 2 个侧位 + 顶部 3 个（见 EIGHT 注释的交叠修复记录）。
    opp.forEach((s, k) => {
      if (EIGHT[k]) pos[s] = EIGHT[k];
      else placeOnArc(s, k, O);   // 兜底
    });
  } else if (total >= 5) {
    // 5~7 位：左右各 1 个侧位（x=10~12 / 88~90, y=50），其余顶部弧均匀。
    // 5 座房也开侧位（2026-10-21 用户）：4 个对手全挤顶部弧时中心距仅 18.4%，
    // 两侧 x=3~17 / 83~97 的大块区域完全空着；开侧位后顶部 3 个、中心距 24.7%。
    const sideX = big ? 10 : 12;
    pos[opp[0]] = { x: sideX, y: 50 };
    pos[opp[O - 1]] = { x: 100 - sideX, y: 50 };
    const top = opp.slice(1, O - 1);
    top.forEach((s, j) => placeOnArc(s, j, top.length));
  } else {
    // 4 位及以下：对手 ≤3 个，全部在顶部弧（侧位无收益——弧上密度已足够松）。
    opp.forEach((s, k) => placeOnArc(s, k, O));
  }
  pos.__layout = layout;
  _ringCache[cacheKey] = pos;
  return pos;
}

module.exports = {
  // 函数
  uhToFelt,
  ringPositions,
  // 常量（页面渲染与测试断言共用同一来源，禁止各自写裸数字）
  FELT_UH_FALLBACK,
  POT_ANCHOR,
  SEAT_H_PX_UH,
  SEAT_H_PX_UH_TIGHT,
  RING_TOP_MIN,
  RING_Y_MAX,
  SEAT_CORRIDOR_HALF_W,
  POT_PILL_H,
  ACT_BUBBLE_DROP_UH,
  SEAT_META_STACK_UH,
  SEAT_META_STACK_TIGHT_UH,
  RING_CEIL_GAP,
  POT_SAFE_HALF_W,
  ACT_BUBBLE_HALF_W,
  // 座位模板（导出便于测试直接断言项数与镜像关系）
  NINE,
  EIGHT
};
