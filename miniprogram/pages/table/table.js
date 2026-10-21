/**
 * 牌桌页逻辑
 *
 * 架构说明（重要）：
 *   AI 对战 / 好友房房主端：引擎跑在本机（权威端），渲染 + 驱动引擎。
 *   好友房好友端（remoteMode）：不跑引擎——把房主广播的快照镜像成本地
 *   game 对象，按「我 = 本地 0 号位」重映射座位后，复用同一套渲染与操作逻辑；
 *   我的动作经 room-sync 上行，由房主端消化后随下一帧广播回来。
 *   所有合法性判断以权威端（房主）为准，本地仅用于即时 UI 反馈。
 */
const P = require('../../core/poker-core.js');
const app = getApp();
const { auth } = require('../../utils/auth');
const { settings } = require('../../utils/settings');
const roomSync = require('../../utils/room-sync');
const sfx = require('../../utils/sfx');   // 合成音效（发牌/下注/加注/全下/获胜…）
const replayStore = require('../../utils/replay-store');   // 对局复盘缓存（本地，结算时收割）
const highlightStore = require('../../utils/highlight-store'); // 高光时刻存档（本地，结算时判定收割）
const sngStore = require('../../utils/sng-store'); // SNG 结算单存档（本地，复盘页可回看）
const advisor = require('../../utils/advisor');   // AI 教学提示文案（起手牌分类 + 牌理解释，仅练习模式）
const botProfiles = require('../../utils/bot-profiles'); // AI 角色档案：5 角色 style + 台词 + 马脚（批②）
const styleAnalyzer = require('../../utils/style-analyzer'); // 风格分析：analyzeOpponent 给对手画像页用（批⑥）

/**
 * 单次行动倒计时（秒）：计时环按此值计算进度，且在远端模式下与
 * SYNC.ACTION_TIMEOUT_SEC 同口径——好友房里本地环走到 0 的时刻即房主 30s 代弃
 * 生效的时刻，UI 与权威端不再「说两个数」（好友本地环走完却还要干等 10s）。
 * 单机模式（AI/SNG）保持 20s 快节奏不变。
 */
const TICK_MAX = 20;

/** 同类同步失败提示的最短间隔：心跳 5s 一发，10s 节流意味着最多偶发弹一次，
 *  连续失败也只保持「约两条一次」的频率，不把 toast 叠成提示帘。 */
const SYNC_FAIL_TOAST_MS = 10000;

/**
 * 座位环几何与预算常量已抽到 utils/table-geometry.js（纯函数模块）。
 *
 * 为什么抽出去：这些函数原本内嵌在本文件里，测试只能靠正则把 ringPositions
 * 和一堆常量从源码字符串「抠」出来再 new Function 求值——常量截取范围靠正则
 * 锚点，增删一行注释就可能漏截，且漏截时报 ReferenceError 会被误读成几何实现
 * 错了（2026-10-21 就因多出 FELT_UH_FALLBACK/uhToFelt 两个依赖被迫改正则）。
 * 抽成模块后测试直接 require，几何变成可单测的纯函数。
 *
 * 这里保留同名解构引用（而不是各处改成 G.xxx）：本文件内 80 余处引用点不动，
 * 降低本次重构的回归面。常量单一来源仍是 table-geometry.js。
 */
const {
  uhToFelt,
  ringPositions,
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
  ACT_BUBBLE_HALF_W
} = require('../../utils/table-geometry');

/**
 * 空座位条目（游戏中座位环的占位）。
 *
 * 桌上有 N 个位，人没坐满时那几个位照样要画出来——否则 8 人房 5 人开局，
 * 玩家看到的只有 5 个位、根本不知道还能再进 3 个人（更没法点空位加入）。
 * 字段与「有人的座位」逐条对齐，WXML 里共用同一套模板，
 * 靠 empty 让 .sit-btn 显形、其余元素自然不渲染。
 */
function emptySeat(seat, pp, inGame) {
  return {
    seat, seatNo: seat + 1, cls: 'seat empty', name: '', initial: '', empty: true,
    // 牌桌上的空位文案跟着阶段走：等待室是「坐下」，牌局中是「入座」
    // （按钮文案一律在 JS 里算好，WXML 只取值——三元表达式放进 wxml 会编译失败）
    sitText: inGame ? '入座' : '坐下',
    x: pp.x, y: pp.y, stack: '', bet: 0, allIn: false, folded: false,
    standing: false, active: false, isDealer: false, isSB: false, isBB: false,
    isMe: false, ready: null, cardsBack: false, showCards: false, hole: [],
    win: false, winGain: 0, timer: '', timerPct: 0, timerUrgent: false,
    actText: '', actCls: ''
  };
}

/** 电脑玩家名（AI 桌的预设对手；NAMES[0] 是「我」的占位，组局时按 mySeat 覆盖）。
 *  ⚠️ 必须 ≥9 个：9 人桌最多 8 个 bot，旧池只有 5 个时 botLabel 取模会让第
 *  6~8 个电脑玩家与前面重名（2026-10-22 用户反馈）。取名字段经 botNamesFor
 *  再做一次去重兜底（池再缩小也不会重名）。 */
const BOT_NAMES = ['林小满', '陈默', '苏晴', '赵岩', '周叙', '顾清', '沈舟', '陆离', '许安'];
const NAMES = ['你'].concat(BOT_NAMES);

/** AI 桌等待室提示：按是否已坐下切换（好友房用的是 seatHint，互不干扰） */
const AI_WAIT_HINT = {
  sitting: '点任一空位选座位坐下，坐下后自动安排 AI 对手',
  seated: '点「开始游戏」发牌；想多人混战可继续「添加电脑玩家」'
};
/* 教练提示持续手数（新手可玩性 review 2026-10-19）：前 N 手每手轮到我都提示一次。
   取 3 的理由：新手的困惑不是「第一次没看到界面」，而是「连续几把都不知道该看
   什么」；一手太短（还没建立条件反射就没了），再多就变成噪音（会打的人被反复
   打扰）。手动点掉永远优先——见 onCoachClose。 */
const COACH_HANDS = 3;
const QUICK_TALK = ['打得不错', '运气真好', '好牌！', '跟一手', '谢谢', '再想想'];
const EMOJIS = ['👍', '😂', '😮', '🔥', '💰', '😢'];
/** 好友房快捷语/表情广播白名单（防伪造内容/超长 payload）。
 *  与 onQuickChat/onEmoji 的 data-t/data-e 来源严格一致——只有面板上能点的文案
 *  才允许上行广播，房主消化前再过一次白名单。聊天内容不在快照里全文广播，只取
 *  最近 CHAT_QUEUE_MAX 条滚动，与 emotes 队列同构。 */
const CHAT_TEXT_SET = QUICK_TALK.concat(EMOJIS);
/** 聊天队列广播上限：房主行 state 里保留的最近聊天条数（镜像端只渲染面板，不存历史）。 */
const CHAT_QUEUE_MAX = 8;



/** 花色配色（四色牌）：0♠ 黑 / 1♣ 绿 / 2♦ 蓝 / 3♥ 红 */
const SUIT_CLS = ['s-spade', 's-club', 's-diamond', 's-heart'];

/** 好友房空闲超时：创建后超过该时长仍无人加入（仅房主一人），自动销毁 */
const ROOM_TTL_MS = 30 * 60 * 1000;
/** 空闲超时提示提前量：最后 5 分钟开始逐秒显示「X 分钟后自动解散」，
 *  让房主知道房间快被回收了，赶紧拉好友或加电脑玩家，而不是到点突然被踢。 */
const IDLE_WARN_MS = 5 * 60 * 1000;

/**
 * 就绪超时（秒）：上一手结束后，所有人需点「准备就绪」才发下一手；
 * 超过该时长仍未准备的人，自动站起（退出本局，但保留在房间内）。
 */
const READY_TIMEOUT_SEC = 30;

/**
 * 单机自动续局宽限（秒）：AI/SNG 桌「准备就绪」挂起 READY-auto_Sec 后
 * 自动替我点一次就绪——去掉每手一次的手动点击（连续对局的纯摩擦，玩家
 * 审视 2026-10-17）。30s 真超时（站起退出）的硬口径不动：宽限只是一次
 * 代点，被代点后我仍在座、照常发牌，与真人点按完全同路径。
 * 用户 2026-10-16 反馈「未点准备就绪却自动下一局」的语义不冲突：那次
 * 问题是**我超时被站起后**剩下纯 bot 照常开局（观战态被硬开局）；
 * 本宽限是我**仍在座**时的代点，finishReadyPhase 的真人就绪断言
 * （双保险）仍以 readyMap 计票为准。好友房（remote/房主多人）不适用：
 * 多人节奏该由每个真人自己掌控。
 * 手感调优（2026-10-17）：8s → 3s。单机两手间隔（结算 3s + 代点 8s 一度
 * 合计 13s）是节奏拖沓首因；3s 代点 + 就绪条「继续 ▶」手动快进双保险，
 * 想停的玩家随时站起，赶节奏的玩家零等待。
 * 手感调优（2026-10-17 二调）：3s → 2s。3s 仍被反馈拖沓——结算亮牌 3s +
 * 代点 3s 合计 6s；代点窗口本身没有信息量（无倒计时、无提示），压到 2s
 * 只保留「结算刚看完想喘口气」的最小间隙。30s 硬超时口径继续不动。
 */
const READY_AUTO_SEC = 2;

/**
 * 结算展示时序（毫秒）：一手结束（摊牌亮牌）后，先在牌桌上停留亮牌
 * RESULT_SHOW_MS ≈ 5 秒（看各家底牌与赢家），随后**直接进就绪阶段**——
 * 「每人盈亏」结算弹窗不自动弹出，由用户点「查看结算」主动打开
 * （摘要条 / 就绪条都有入口，与「准备就绪」并存）。
 * 弹窗打开后 RESULT_MODAL_MS 自动关闭（防挂屏）；亮牌展示期内打开的，
 * 关闭时顺带进就绪；就绪期内打开的只关弹窗、不重置就绪计票。
 * 镜像端就绪阶段以房主广播为准。
 * 手感调优（2026-10-17）：5s → 3s。亮牌展示期过长是单机节奏拖沓的首因，
 * 且摘要条/就绪条同时有「查看结算」+「继续 ▶」双出口，想看牌的玩家
 * 留得住、赶节奏的玩家走得掉。
 */
const RESULT_SHOW_MS = 3000;
const RESULT_MODAL_MS = 10000;

/**
 * 买入额（WePoker 式入座流程）：点空位 → 选买入额 → 入座。
 * 买入额随座位同步到云端，房主开局时按各人买入发筹码。
 */
const DEFAULT_BUY_IN = 1000;

/**
 * B4（玩家审视 2026-10-17）：SNG 起始筹码统一常量。
 * 淘汰赛必须全员同起点（公平性底线）：原先各处 DEFAULT_BUY_IN 兜底，
 * 理论上同为一档、但任何一处改动漂移都会造成「有人 1000 有人 2000」的
 * 隐性不公平。SNG 与 AI 好友桌买入解耦，SNG 固定 2000（10 档涨盲空间，
 * 初始 bb=20 时 50BB 起步、可撑 4 档涨盲到封顶）。
 */
const SNG_START_STACK = 2000;

/** 买入额统一取值口：SNG 固定 2000，其余模式用玩家选的（或默认）买入额 */
const buyInOf = (mode, picked) => (mode === 'sng' ? SNG_START_STACK : (picked || DEFAULT_BUY_IN));

/**
 * B2（玩家审视 2026-10-17）：涨盲封顶（大盲上限）。
 * 原实现 sb/bb 每 blindIntervalMin 分钟无限翻倍——长局会涨到数千/万级，
 * 与「买入几百到 10 万」的常客筹码完全不匹配（少于一个盲注即判死的荒诞局）。
 * cap 取 min(初始 bb × 16, DEFAULT_BUY_IN / 2)：
 *   - 默认初始 bb=20 → 320；买入 1000 → 500；两者取小 = 320（4 档涨盲到顶）。
 *   - 初始 bb 更小的房间 cap 同比例收缩，bb≥63（如 80/160 房）由买入半数封顶。
 * 到顶后不再翻倍，只toast 一次「盲注已达本房封顶」提示后静默——每分钟重复
 * 提示纯属骚扰。涨盲的本意是逼僵局推进，bb 到买入一半时该淘汰的早淘汰了。
 */
const bbCapOf = initBb => Math.max((initBb || 20), Math.min((initBb || 20) * 16, DEFAULT_BUY_IN / 2));

/**
 * 加注档位（sizing chips）分两街口径（资深玩家评审 2026-10-17 的「档位说错了扑克的语言」）：
 *
 *   翻前 —— BB 倍数语言。open sizing 的行话是「开 2.5bb / 3bb」，池比例在
 *     翻前算不出「我到底加了多少个大盲」。档位 key 直接编码倍数（bb25 = 2.5bb），
 *     目标金额 = bb × 倍数，经 snapToBlind 吸附、钳到合法区间（当前注已高于
 *     该档时钳到 min，等价「最小」——面对 3bet 时 4bb 档退化但不消失）。
 *   翻后 —— 池比例语言（33%/50%/67%/100%）。用百分比而不是 ½池/⅔池 这类分数，
 *     因为「池的三分之一」在不同轮次的实际筹码量会让人算不清「我到底叫了多少」；
 *     33/67 取分数的近似整数倍（1/3、2/3），兼顾直觉与整齐的数字。
 *
 * render 按 game.street 重建 raisePresets（g.street 已入渲染指纹，切街必重算）。
 */
const RAISE_PRESET_PCT = { p33: 1 / 3, p50: 0.5, p67: 2 / 3, p100: 1 };
// BB 档：2.5bb / 3bb / 4bb 三档——open 最常用的三个尺度，4bb 以上是 3bet 领域（
// 对面注已经抬起来后，BB 档语义就退化为 min，仍保留按钮只是视觉提示历史档位）
const RAISE_PRESET_BB = { bb25: 2.5, bb30: 3, bb40: 4 };

/** G5：分享卡摘要文案——只露「盈亏语气」不露桌码/对手名（与高光分享同口径） */
function netTextSharedOf(res, myGain, myLost, won) {
  if (won) return '我在「博弈论」赢了 ' + myGain + ' 筹码！';
  return '这手我输了 ' + myLost + ' 筹码，再接再厉';
}
/** 翻前 6 档：最小 / 2.5bb / 3bb / 4bb / 全下 / 自定义（BB 语言） */
const PRESETS_PREFLOP = [
  { k: 'min', t: '最小' },
  { k: 'bb25', t: '2.5BB' },
  { k: 'bb30', t: '3BB' },
  { k: 'bb40', t: '4BB' },
  { k: 'allin', t: '全下' },
  { k: 'custom', t: '自定义' }
];
/** 翻后 7 档：最小 / 33% / 50% / 67% / 100% / 全下 / 自定义（池比例语言） */
const PRESETS_POSTFLOP = [
  { k: 'min', t: '最小' },
  { k: 'p33', t: '33%' },
  { k: 'p50', t: '50%' },
  { k: 'p67', t: '67%' },
  { k: 'p100', t: '100%' },
  { k: 'allin', t: '全下' },
  { k: 'custom', t: '自定义' }
];

const BUY_IN_OPTIONS = [500, 1000, 2000, 5000];

/**
 * B3（用户需求 2026-10-17）：好友房补筹上限（补后筹码总额 ≤ REBUY_CAP）。
 * 取「买入档位最大值 5000」为房间补筹上限：补筹的意义是输光后回桌，
 * 不该补成超买入的巨塔。好友房的 bot 不受此机制约束（房主端每手
 * startHand 仍自动补到 DEFAULT_BUY_IN，见 startHand 补筹守卫）。
 */
const REBUY_CAP = 5000;

/* ---------- 牌桌互动与氛围（评审 2026-10-15 设计文档 docs/plans/2026-10-15-table-interaction-design.md） ---------- */

/** 表情轮盘（点头像弹出）。渲染端只认这里面的字符——上行来的任意
 *  emoji 字符串先过白名单再显示，防伪造内容与超长 payload。 */
const EMOTE_SET = ['👏', '🎉', '😏', '😅', '🤡', '💪'];
/** 表情频控（毫秒）：同座位两条表情至少间隔该时长，超出静默丢弃（体验功能不提示）。 */
const EMOTE_THROTTLE_MS = 3000;
/** 表情气泡驻留（毫秒）。时间到由 data 内 bornAt 兜底清理（渲染层不依赖定时器精确性）。 */
const EMOTE_BUBBLE_MS = 2200;
/** 氛围队列滚动上限：房主行 state 里保留的最近表情条数（渲染端只放最近 1.5s 的）。 */
const EMOTE_QUEUE_MAX = 10;
/** 渲染端放行窗口（毫秒）：表情 ts 早于该窗口的视为历史重放，不再冒泡。 */
const EMOTE_PLAY_WINDOW_MS = 1500;
/** 大牌特效阈值：赢家成手 ≥ 顺子才触发全屏星光粒子（小牌局保持安静，特效不廉价）。 */
const BIG_HAND_MIN = 4;   // HAND.STRAIGHT——引擎牌型枚举：0高牌…4顺子 5同花 6葫芦 7四条 8同花顺
/** 连胜徽章门槛：连续赢 ≥2 手开始显示 🔥xN。 */
const WIN_STREAK_MIN = 2;
/** 高光存档「连胜」门槛：连续赢 ≥5 手入档（独立于 WIN_STREAK_MIN 的 2 手显示门槛）。 */
const HIGHLIGHT_STREAK = 5;
/** 底池脉冲驻留（毫秒）：换街归池时底池胶囊弹一下的时长上限（#14 批三，renderAmbience 清场）。 */
const POT_PULSE_MS = 600;

/** 牌型名 → 引擎枚举（BIG_HAND_MIN 门槛用；evals 里存的是中文名）。 */
const HAND_NAME_TO_CAT = {
  '皇家同花顺': 8, '同花顺': 8, '四条': 7, '葫芦': 6, '同花': 5, '顺子': 4,
  '三条': 3, '两对': 2, '一对': 1, '高牌': 0
};

/** 好友房牌局快照（中途退出 → 再次进入续局） */
const snapshot = require('../../utils/room-snapshot');

let game = null;
let timer = null;
let clock = null;         // 游戏时长倒计时（房间设定，到点自动结束本局）
let blindTimer = null;   // 涨盲定时器（批④：每 blindIntervalMin 分钟 sb/bb 翻倍）
let expireTimer = null;   // 好友房超时销毁计时器
let expireWarnTimer = null; // 好友房空闲超时提示计时器（提前 5 分钟显示倒计时）
let readyTimer = null;    // 「准备就绪」倒计时（超时未准备自动站起）
let tick = 20;
let aiStep = 0;
let aiTimer = null;
let foldTimer = null;   // 弃牌二次确认自动复位计时器
let allinTimer = null;  // 全下二次确认自动复位计时器（与 foldTimer 同构）
let myActText = '';
let myActCls = '';

/* ---------- 氛围状态（模块级，不进 data 的派生与频控记录） ---------- */
let winStreaks = {};      // 座位 → 连胜手数（下一手 startHand 清零）
let lastEmoteAt = {};     // 座位 → 上次表情时刻（频控用）
let flySeed = 0;          // 筹码飞行动画的自增 id（WXML wx:key 用，防复用错位）

Page({
  data: {
    mode: 'ai',          // 'ai' = AI 对战；'friend' = 好友房
    pageTitle: 'AI 对战',
    roomNo: '',
    handNo: 1,
    streetCn: '翻牌前',
    pot: 0,
    sidePots: [],
    board: [],
    boardPlaceholders: [],
    seats: [],
    legal: null,
    raiseTo: 0,
    raisePreset: '',
    isMyTurn: false,
    foldConfirm: false,   // 弃牌二次确认：首次点「弃牌」进入确认态，再点才真正弃牌
    allinConfirm: false,  // 全下二次确认：首次点「全下」进入确认态，再点才真正全下
                          // （押上全部筹码，比弃牌更该防误触——新手拖滑杆到最右即触发）
    currentPlayerName: '',
    advice: {},
    result: null,
    resultModal: null,    // 单手结算弹窗（每人净盈亏）：亮牌展示后弹出
    canDisclose: false,   // 非摊牌赢池「亮一手」入口（仅 fold 结算的获胜者·权威端）
    resultGodView: false, // 已退役：「看全桌牌」开关（2026-10-17 撤销，防旧快照/缓存引用残留时读到 undefined）
    replayDate: 0,        // 已退役：G3 弃牌行复盘跳转 date（行内入口 2026-10-17 撤销，留 0 防旧缓存引用）

    // 等待室（好友房）：创建房间后为空房间，好友坐下、房主点开始才发牌
    phase: 'playing',     // 'waiting'（空房间）| 'playing'（牌桌）；initGame/等待室会显式设定
    waitSeats: [],        // 座位占用情况（自选座位：点空位入座，开局前可换座）
    canStart: false,      // 至少 2 人坐下才可开始
    ownerSeat: 0,         // 房主默认坐 0 号位（可在等待室换座）
    isOwner: true,        // 是否房主（访客从分享卡片进入时只有观看/等待权限）
    syncLive: false,      // 跨设备同步是否可用（false = 本地引擎模拟降级）
    seatHint: '',         // 等待室选座提示（好友房）
    waitHint: '',         // 等待室选座提示（AI 桌：引导挑座位后才发牌）
    idleRemainText: '',   // 好友房空闲超时倒计时文案（「5:00 后自动解散」，仅房主等待室最后 5 分钟显示）
    rootStyle: '',        // JS 实测视口变量（--uh/--uw），注入页面根节点

    // 用户设置（参考主流 App 的 Table Appearance 自定义）
    fourColor: true,      // 四色牌
    soundOn: true,        // 音效（合成音效）
    vibrateOn: true,      // 震动反馈（与音效独立）
    animOn: true,         // 牌桌动画

    // 房间参数（创建时设定，不可中途修改）
    maxSeats: 6,          // 限定人数
    durationMin: 0,       // 游戏时长（分钟），0 = 不限时
    remainSec: 0,         // 剩余秒数
    remainText: '',       // 倒计时展示（mm:ss / h:mm:ss）
    timeUp: false,        // 时长已到，游戏结束
    summary: null,        // 结束时的全员盈亏统计

    // 站起 / 坐下：退出「游戏」≠ 退出「房间」
    myStanding: false,    // 我已站起：退出当前牌局但仍在房间内观战
    mySeated: true,       // 我是否算「在座」（含「已坐下、下一手入局」的待入局状态）
    canStand: false,      // 当前可否站起（已弃牌或本手已结束）

    // 就绪阶段：上一手结束后，等所有坐下的人点「准备就绪」才发下一手
    readyPhase: false,    // 当前是否处于等待就绪阶段
    readyList: [],        // 参与者就绪情况 [{seat,name,isMe,isBot,ready}]
    myReady: false,       // 我是否已准备
    readyLeft: 0,         // 我的就绪倒计时剩余秒（超时自动站起）
    readyHint: '',        // 就绪阶段提示文案

    // 入座买入（WePoker 式）：点空位 → 选买入额 → 入座，买入额随座位同步
    buyInShow: false,     // 买入选择弹窗
    buyInSeat: -1,        // 准备入座的座位号
    buyInValue: DEFAULT_BUY_IN,
    buyInBBText: 50,   // B6：买入额折算 BB 文案（默认 1000/20），弹窗文案动态用
    buyInOptions: BUY_IN_OPTIONS.map(v => ({ v: v, t: String(v) })),

    // B3 好友房手动补筹弹窗（照 buyin 三件套范式）：
    // 仅好友房真人我在座且非 bot 时可用，补后总额 ≤ REBUY_CAP
    rebuyShow: false,      // 补筹弹窗
    rebuySeated: false,    // 弹窗打开时的「我在座」快照（提交前校验）
    rebuyValue: 0,         // 本次拟定补入额（正数）
    rebuyOptions: [],      // 档位行 [{ v: add, t: 描述 }]，打开时按 stack 现算
    rebuyCancelMode: false, // 「已申请 +N」态：确认钮换「取消申请」（规则 3）
    myRebuyAdd: 0,         // 我本手已申请的补筹额（下一手生效，「待补 +N」角标用）

    // 行动计时环（render 里随模式刷新：remote 30s / 单机 20s，供 wxml 与测试读）
    timerMax: 20,

    // 我的区域（微扑克式：手牌与操作集中在屏幕下半区）
    myCards: [],          // 我的两张底牌
    myStack: 0,
    myBuyIn: 0,          // 本局带入筹码（盈亏基准，随 startStacks 延续）
    myNetLive: 0,        // 实时盈亏 = myStack − myBuyIn
    myNetLiveText: '0',
    myBet: 0,
    myFolded: false,
    myActive: false,      // 轮到我行动
    myTimer: '',
    myTimerPct: 0,
    myTimerUrgent: false,  // 轮到我最后 5s：行动条紧迫脉冲
    myDealer: false,
    mySB: false,
    myBB: false,
    myActText: '',
    myActCls: '',

    // 加注档位（主流 App 的 bet sizing chips，替代占位很大的滑杆）。
    // render 按街重建：翻前 BB 语言（PRESETS_PREFLOP），翻后池比例语言（PRESETS_POSTFLOP）。
    // 初始值翻前口径（开局第一帧即翻前）。
    raisePresets: PRESETS_PREFLOP,
    // 自定义下注面板：数值范围 0 ~ raiseMax（MAX = 全下金额），步进 = 小盲注
    raiseCustom: false,
    raiseMin: 0,
    raiseMax: 0,
    raiseStep: 10,   // 小盲注整数倍，建局后由 render 按 game.sb 校正
    // 实际会提交的加注额 / 是否等价于全下（与 onRaise 同口径，仅用于按钮文案）
    raiseSubmit: 0,
    raiseAllIn: false,

    // 折叠面板：聊天与菜单默认收起，不抢占主视觉（微扑克：社区折叠在边栏）
    chatOpen: false,
    menuOpen: false,
    // 实时盈亏面板（菜单 →「我的筹码」）：带入 / 剩余 / 盈亏，随时可查
    bankShow: false,
    // 时长已到但本手仍在打：倒计时停在 00:00，等这手结束才总结束
    clockPendingEnd: false,

    // 社交：快捷聊天 + 表情
    chatLog: [],          // 最近聊天/表情（最多 8 条）
    chatUnread: 0,        // 聊天折叠期间收到的他人/AI 消息计数（打开面板清零）
    quickChat: QUICK_TALK,
    chatEmojis: EMOJIS,

    // 新手引导 / 教学
    helpShow: false,
    // 牌桌内设置弹窗（⋯ 菜单入口）
    settingsShow: false,
    sFourColor: true, sSound: true, sVibrate: true, sAnim: true,

    // ---------- 牌桌互动与氛围（docs/plans/2026-10-15-table-interaction-design.md） ----------
    emoteShow: false,      // 表情轮盘弹层（点头像弹出）
    emoteSeat: -1,        // 轮盘针对的座位（气泡冒在该座位旁）
    emoteSet: EMOTE_SET.map(e => ({ e })),
    emotes: [],            // 当前在冒的表情气泡 [{seat, emoji, bornAt, key}]
    spark: null,           // 大牌星光粒子 [{x, y, d, s, key}]（null = 不播）
    flyOut: [],            // 下注筹码飞行：座位 → 底池 [{x, y, dx, dy, delay, key}]
    flyIn: [],             // 收池筹码飞行：底池 → 赢家 [{x, y, tx, ty, delay, key}]
    potPulse: false,       // #14 批三：换街归池时底池胶囊脉冲（到期由 renderAmbience 清场）
    streaks: {},           // 座位 → 连胜徽章文案（'' = 不显示，如 '🔥 x2'）
    winFx: '',             // 本手赢家座位列表（逗号串，wxml 给座位加金光脉冲 class）
    // 批⑥：对手画像角色卡（长按头像弹出）——独立 modal toggle，不进三道脏检查指纹
    oppCardShow: false,
    oppCardData: null,      // { name, trait, desc, styleBars, tellHints, oppStats }
    // 批⑦：高光分享卡片弹层（非 canvas 预览弹层）——独立 modal toggle，不进三道指纹
    shareCardShow: false,
    shareCardData: null,    // { handName, summary, myHole, board, mode }
    helpRows: [
      { name: '翻牌前', desc: '每人两张底牌，大小盲先行下注' },
      { name: '翻牌', desc: '发出 3 张公共牌，开始第二轮下注' },
      { name: '转牌', desc: '第 4 张公共牌，再一轮下注' },
      { name: '河牌', desc: '第 5 张公共牌，最后一轮下注' },
      { name: '摊牌', desc: '7 张牌取最大 5 张组合比大小' }
    ],
    coachShow: false,
    /* 首手教练提示（新手可玩性 review 2026-10-19 重写）。
     * 旧文案：「轮到你时：看右侧『牌力分析』的胜率与赔率，胜率高于赔率再跟注。」
     * 两个问题：
     *   ① 引导到了一个**当时不存在的画面**——胜率/赔率曾被 coachShow 的
     *      wx:elif 挤掉，且不在「右侧」（它在底牌上方一条）。现已并列显示，位置
     *      也写明。
     *   ② 只说了「看哪里」，没说「我这手牌算好算坏」。而新手刚发牌时最大的
     *      疑问恰恰是后者——现在底牌下方已有起手牌标签/牌型名，把这条也指出来，
     *      让「一条提示」和「界面上的几处新标签」串成一条线。
     * 仍只在 AI 练习模式显示，操作一次后自动收起（doAct 里清 coachShow）。 */
    coachTip: '轮到你时：先看底牌下方的起手牌标签（比如「顶口袋对子」），再看上方的胜率与赔率——胜率明显高于赔率再跟注。',
  },

  onLoad(options) {
    const opts = options || {};
    // 批⑤：SNG 淘汰赛模式（mode=sng）。复用 AI 桌引擎路径，但关闭补筹、
    // 启用淘汰编排（筹码归零即淘汰，最后一人夺冠）。不消耗房卡、无好友同步。
    this.mode = opts.room ? 'friend' : (opts.mode === 'sng' ? 'sng' : 'ai');
    // 快速入桌（P1-4）：quick=1 → AI 桌跳过「选座+手工补位+点开始」三步，
    // 直接坐 0 号位、补满 bots（URL 携带，钳 1~7）、立即发牌。难度仍由
    // level 携带；要调难度 → 首页长按 AI 卡片出 ActionSheet。
    this.quick = this.mode === 'ai' && opts.quick === '1';
    this.quickBots = this.quick ? Math.min(7, Math.max(1, Number(opts.bots) || 5)) : 0;
    // AI 难度档位（批②）：rookie/advanced/expert，默认 advanced。仅 AI/SNG 桌生效，
    // 好友房的机器人沿用默认梯度（好友房 Bot 不该比真人强太多）
    this.level = ((this.mode === 'ai' || this.mode === 'sng') && opts.level) ? opts.level : 'advanced';
    this.roomNo = opts.room || '';
    // 结束房入口（好友房「有对战」被关闭后 status='ended'）：进房不跑引擎，
    // 直接跳复盘页按房间列出每局（满足「进房间看每一局复盘」）。
    if (opts.ended === '1' && this.roomNo) {
      wx.redirectTo({ url: '/pages/replay/replay?room=' + this.roomNo });
      return;
    }
    // own=1 表示从「我的房间」或创建流程进入（房主）；分享/输入房间号进入视为访客
    this.isOwner = this.mode === 'friend' ? opts.own === '1' : true;
    this.roomClosed = false;   // 每次进出页面重置：房间是否已被本页关闭
    this.myStanding = false;   // 每次进出页面重置：默认坐在局内
    this.pendingSit = false;   // 「坐下加入游戏」待下一手生效
    this.standingMap = {};     // 其他座位（电脑玩家）的站起状态：seat → true
    this.readyMap = {};        // 就绪阶段各座位是否已准备：seat → true
    this.botReadyTimers = [];  // 电脑玩家自动「准备就绪」的定时器
    // 跨设备同步状态（好友房）：mySeat = 本地渲染座位（好友镜像端恒 0）；
    // roomSeat = 云端座位号（自选座位，-1 = 未选座）
    this.mySeat = 0;
    // 好友房房主沿用 0 号位（房间是自己的）；AI 桌与好友访客一样不预占，
    // 进等待室后由玩家自己挑位置坐下
    this.roomSeat = (this.mode === 'friend' && this.isOwner) ? 0 : -1;
    this.remoteMode = false;   // 好友端镜像模式：不跑引擎，只渲染房主广播
    this.syncLive = false;
    this.roomRows = [];        // 最近一次轮询到的座位行
    this.hostState = null;     // 房主广播的房间公开状态
    this.appliedSeqBySeat = {};// 房主已消化的好友动作序号（按来源行座位分道，防跨设备时钟偏差丢动作）
    this.hostStaleSince = 0;   // 好友端：房主心跳疑似停滞的起始时刻（超宽限判房间僵死）
    this.botSeats = {};        // 机器人座位（不会上行动作，超时不管）
    this.pendingSitMap = {};   // 好友「坐下」待下一手生效：seat → true
    this.pendingJoinMap = {};  // 好友中途加入：房间座位 → { name, stack }，下一手插入
    // B3 好友房手动补筹：手牌进行中申请的补筹 { seat: add }，startHand 消化。
    // 就绪/结算阶段申请的补筹即时生效（不进此 map）。
    this.pendingRebuyMap = {};
    this.pendingMove = null;   // 游戏中换座：{ from, to }，下一手发牌前落位
    this.pendingJoin = null;   // 中途加入：{ seat, stack, name, isHuman, style }
    this.pendingBotSeat = null;// AI/SNG 桌：空位补电脑玩家的目标座位
    this.pendingKickBots = {};// 进行中踢 bot：seat → true，下一手移出 game.players
    this.leftPlayers = [];     // 中途离场者战绩留档（结算单仍统计他们）
    this.pollTimer = null;
    this.hbTimer = null;
    this.publishTimer = null;
    this.friendActSince = 0;   // 房主端：好友行动开始时刻（超 30s 代弃牌）
    this.sawHost = false;      // 好友端：是否见过房主行（用于判断房间解散）
    this.inBackground = false; // 前后台切换状态（onHide/onShow 配对消费）
    this.bgRemainSec = undefined; // 限时局切后台时的剩余秒数（回前台断点续走）
    // 房间参数：限定人数与游戏时长（创建房间时设定）
    this.maxSeats = Math.min(9, Math.max(2, Number(opts.max) || 6));
    this.durationMin = Math.max(0, Number(opts.dur) || 0);
    // 涨盲间隔（批④）：建房时设定，0 = 不涨盲（保持现行为）。单位分钟。
    // 每隔 blindIntervalMin 分钟 sb/bb 翻倍，逼迫僵局推进。
    this.blindIntervalMin = Math.max(0, Number(opts.blind) || 0);
    this.startStacks = {};     // 座位 → 起始筹码（结算盈亏用）
    this.buyInStack = {};      // 座位 → 买入额（入座时选定，开局按此发筹码）
    // SNG 淘汰赛赛制状态（批⑤）：仅 mode==='sng' 有效，其它模式恒空。
    // sngPlacement：seat → 名次（1=冠军，数字越大越先淘汰）；
    // sngEliminationOrder：淘汰顺序 [seat,...]（最后一个为冠军，倒数第二为亚军）；
    // sngNextPlace：下一个淘汰名次（初始=总人数，每淘汰一人递减至 1=冠军）。
    this.sngPlacement = {};
    this.sngEliminationOrder = [];
    this.sngNextPlace = null;
    // 批⑨：AI 读人反制的滚动 VPIP 状态（仅 mode==='ai' && level==='expert' 用）。
    // _humanVpipHands=已统计手数、_humanVpipCount=自愿入池手数、
    // _humanActedThisHand=本手人类是否行动过（startHand 边界累加用）。
    // 不进 setData/三道指纹（纯实例字段，仅 scheduleAI 注入 tight 时读）。
    this._humanVpipHands = 0;
    this._humanVpipCount = 0;
    this._humanActedThisHand = false;
    this.chatSeq = this.chatSeq || 0;
    // #14 批二：动作文案渲染态（座位 → { text, cls }）。三端统一存储——
    // AI 端 scheduleAI 写、房主端 applyFriendAction 写（看好友）、镜像端
    // diffActLabels 从快照 diff 推断后写；render 座位映射从这里派生。
    // 旧架构是 scheduleAI 的路径型 setData 补丁，afterAct→render 全量重建
    // seats 时把非我的 actText 重置为 ''——气泡一帧闪现，现实中几乎不可见。
    // 换街即清（render 内 _actHandStreet 判据），防「文字说跟注、桌面无注」。
    // 进渲染指纹靠 _actEpoch 令牌（独立实例状态，不穿透会被跳过分支吞掉）。
    this._lastActMap = {};
    this._actEpoch = 0;
    this._actHandStreet = '';
    this._remotePrev = null;   // 镜像端 diff 的上一帧快照基线（enterRemote 维护）
    // 氛围状态：页面级重置（连胜/频控/飞行 id 随页面实例归零）
    winStreaks = {};
    lastEmoteAt = {};
    flySeed = 0;
    this.emoteSeen = 0;        // 镜像端已放过气泡的表情 ts 高水位（防轮询重放）
    const s = settings.get();
    // B3：补筹弹窗在本手是否已询问——防每手结算重复弹窗骚扰
    this._rebuyAskedHand = -1;
    // B3 规则 3：我本手已申请的补筹 { hand, add }（防重复累计 + 撤销入口判据）
    this._myRebuyPending = { hand: -1, add: 0 };
    // AI 桌无限练习：true = 旧行为每手自动补满；false（默认）= 真枪实弹，我输光即本桌结束。
    // 放 this （实例字段）而非 data：参与 startHand 守卫与 render 指纹，属页面级常量而非渲染态。
    this.aiUnlimited = !!s.aiUnlimited;
    this.setData({
      mode: this.mode,
      roomNo: this.roomNo,
      isOwner: this.isOwner,
      maxSeats: this.maxSeats,
      durationMin: this.durationMin,
      remainSec: this.durationMin * 60,
      remainText: this.durationMin ? this.fmtRemain(this.durationMin * 60) : '',
      // 涨盲级展示（批④）：初始 10/20，涨盲后由 startBlindTimer 更新
      blindLevel: 20,
      blindText: this.fmtBlind(10, 20),
      blindIntervalMin: this.blindIntervalMin,
      timeUp: false,
      clockPendingEnd: false,
      summary: null,
      myStanding: false,
      mySeated: true,
      canStand: false,
      readyPhase: false,
      readyList: [],
      myReady: false,
      readyLeft: 0,
      readyHint: '',
      // SNG 也是本机引擎，但赛制不同——标题必须区分，不能一律显示「AI 对战」
      // （2026-10-21 用户：SNG 对局左上角显示的是 AI 对战）。
      pageTitle: this.mode === 'friend' ? '好友房'
        : (this.mode === 'sng' ? 'SNG 淘汰赛' : 'AI 对战'),
      fourColor: s.fourColor,
      soundOn: s.sound,
      // 氛围字段重置（页面复用/热重载时清干净上一局的气泡与粒子）
      emoteShow: false, emoteSeat: -1, emotes: [],
      spark: null, flyOut: [], flyIn: [], streaks: {},
      vibrateOn: s.vibrate,
      animOn: s.animation
    });
    this.updateViewport();
    // 音效事件泵：300ms 轮询消化引擎事件流（game.events）→ 播音效。
    // 与渲染解耦——对手在计时器/看门狗路径里的动作也能及时发声。
    this.sfxSeq = 0;          // 已消费的事件序号（首手从 0 开始，天然不播历史音）
    this.startSfxPump();
    // 音频解锁：WebAudio 上下文初始 suspended，必须在一次真实手势里 resume()。
    // 挂根节点 touchstart（捕获阶段，卡在所有按钮之前），用户第一次碰屏幕就解锁，
    // 之后发牌/下注音才真的出声。once 语义由 sfx.unlock 内部幂等保证。
    this.sfxUnlockBound = true;
    if (this.mode === 'friend' && wx.showShareMenu) {
      wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] });
    }
    if (this.mode === 'friend') {
      // 好友房：先尝试跨设备同步（入座 + 轮询/心跳）；失败则保持本地引擎模拟。
      // 本地快照续局（房主）与同步引导并行，互不影响。
      this.bootstrapSync();
      // 续局恢复：有快照时先问一句「恢复 / 重开」，用户确认后才 restoreRoom，
      // 避免故意退出想重开却被自动拉回旧牌局。无快照直接进等待室。
      if (!this.promptRestore()) this.initWaiting();
    } else {
      // AI 对战：与好友房共用同一间等待室——先挑座位坐下、点「开始游戏」才发牌，
      // 不再一进就自动开局。差别只在：无房间号、不跨设备同步、坐下后自动补 AI 对手。
      this.initWaiting();
      // 快速入桌（P1-4）：等一帧让等待室首帧渲染出来（避免「点了没反应」的白屏错觉），
      // 再自动坐 0 号位 + 补满 bots + 直接开局。若 400ms 内已被用户手动推进
      // （phase != waiting），startGame 静默 return，不抢他的操作。
      if (this.quick && this.mode === 'ai') {
        this.quick = false;   // 只消费一次——重启/续路径不复用
        setTimeout(() => {
          if (this.data.phase !== 'waiting') return;
          this.sitSeat(0, DEFAULT_BUY_IN);
          this.fillBotsTo(this.quickBots + 1);
          this.startGame();
        }, 400);
      }
    }
  },

  /**
   * AI 桌补位到目标人数（quick 快速入桌用）：把空位逐个补成电脑玩家，
   * 与 fillBots 共用「先 find 空位 → occupied + isBot + 命名」的路径，
   * 区别只在目标数不再硬编码 2。目标达到后或不余人位数退出。
   */
  fillBotsTo(targetTotal) {
    if (this.mode === 'friend') return;
    const seats = (this.data.waitSeats || []).slice();
    // 起点编号：沿用 fillBots 的「按当前已入 bot 个数连续编号」口径
    let botNo = seats.filter(s => s.isBot).length;
    let guard = 0;   // 防死循环：单局 maxSeats ≤ 9，兜底 20 次退出即可
    while (seats.filter(s => s.occupied).length < targetTotal && guard++ < 20) {
      const empty = seats.find(s => !s.occupied);
      if (!empty) break;
      empty.occupied = true;
      empty.isBot = true;
      empty.name = this.botLabel(botNo);
      empty.stack = this.mode === 'sng' ? SNG_START_STACK : DEFAULT_BUY_IN;
      botNo++;
    }
    this.setData({
      waitSeats: seats,
      seats: this.buildWaitSeats(seats),
      canStart: this.canStartOf(seats)
    });
  },

  /**
   * 分享面板 / 切后台返回后，部分机型（荣耀、vivo、华为等）会把横屏页
   * 重置回竖屏（微信已知问题），导致 vh 布局全部放大爆掉。
   * onShow 重新锁回横屏（延迟 100ms 兼容部分机型不生效）。
   */
  onShow() {
    if (wx.setPageOrientation) {
      setTimeout(() => {
        wx.setPageOrientation({ orientation: 'landscape' });
      }, 100);
    }
    this.updateViewport();
    // 从后台切回：iOS 会把 WebAudio 上下文挂起（currentTime 停走），
    // 这里补一次解锁尝试；用户下一次触摸也会再触发 onFirstTouch。
    if (this.sfxUnlockBound) { try { sfx.unlock(); } catch (e) {} }
    this.onLeaveBackground();
  },

  /**
   * onHide（切后台/跳分享面板）：全量暂停定时器与云端轮询。
   * 评审 2026-10-15 MEDIUM：此前切后台时轮询/看门狗/倒计时/AI 调度照跑——
   * 后台 JS 定时器被挂起后节奏失真（回来一次性补跑）、云端心跳白写、
   * 限时局的时长在后台偷走。心跳不在暂停列表：房主掉线 15s 判离线是
   * 房间语义（真·退后台超过 15s 本就该判离线），不能因切后台豁免。
   */
  onHide() {
    this.onEnterBackground();
  },

  /** 切后台：停轮询/看门狗/AI 调度/个人计时环/时长倒计时/音效泵 */
  onEnterBackground() {
    if (!this.inBackground) {
      this.inBackground = true;
      // 记录切后台前的同步态：在途轮询可能因后台断网失败 → onSyncLost 把
      // syncLive 置 false，回前台若只看 syncLive 就再也不重启轮询（卡死真凶）。
      this._syncWasLive = !!this.syncLive;
      this.saveSnapshot();   // 后台被系统直接回收时（不走 onUnload）也能续局
    }
    this.stopPolling();
    this.stopEngineWatch();
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
    this.stopSfxPump();
    // 涨盲定时器（批④）：后台暂停，回前台由 onLeaveBackground 恢复
    this.clearBlindTimer();
    // 限时局：记下剩余秒数，回前台从断点继续（后台时间不计入牌局时长）
    if (clock) {
      this.bgRemainSec = Number(this.data.remainSec) || 0;
      this.clearClock();
    }
  },

  /** 回前台：恢复被 onEnterBackground 暂停的一切（幂等：没暂停过就不动） */
  onLeaveBackground() {
    if (!this.inBackground) return;
    this.inBackground = false;
    // 切后台期间在途轮询失败会把 syncLive 置 false（见 onSyncLost）；若切后台前
    // 同步本来是活的，这里先复活一次（真连不上时随后的 pollOnce 会再次降级）。
    if (this._syncWasLive && !this.syncLive && this.roomNo && this.mode === 'friend') {
      this.syncLive = true;
      this.setData({ syncLive: true });
      this.startHeartbeat();
    }
    this._syncWasLive = false;
    // 回前台：先补一轮轮询再看缺什么（好友端后台期间可能错过房主广播）
    if (this.syncLive && this.roomNo && !this.pollTimer) this.startPolling();
    // 看门狗在 initGame 启动、onEnterBackground 停掉；此处不区分模式——
    // healEngine 内部自判「好友房仅房主端驱动」，双模式重启它最简单且幂等
    if (!this.engineWatch) this.startEngineWatch();
    if (!this.sfxPump) this.startSfxPump();
    if (this.durationMin && this.bgRemainSec !== undefined) {
      const resume = this.bgRemainSec;
      this.bgRemainSec = undefined;
      if (resume > 0 && !this.data.timeUp) this.startClock(resume);
    }
    // 涨盲定时器（批④）：回前台恢复（按当前盲注级重启倒计时，不补后台漏掉的翻倍）
    if (this.blindIntervalMin && game && !game.result) this.startBlindTimer();
    // 回到页面的下一拍补一次全量刷新（好友端可能错过后台期间的房主广播）
    if (this.syncLive && this.roomNo) this.pollOnce();
    // 重新武装当前行动者：我的倒计时 / 好友超时起点 / AI 调度（onEnterBackground 已停掉）
    this.resumeEngine();
    this.render();
  },

  /**
   * 首次触摸 → 解锁音频上下文（见 sfx.js unlock 注释）。
   * 绑定在根节点的 bindtouchstart 上，用 capture 语义先于按钮执行；
   * 不做任何业务逻辑，纯音频解锁，重复触发由 unlock() 幂等吸收。
   */
  onFirstTouch() {
    try { sfx.unlock(); } catch (e) { /* 音效不可用也不能影响牌局 */ }
    // 兜底：部分机型从分享面板返回不回调 onShow，切后台标记会一直挂着 →
    // 用户回来后第一次触摸补一次恢复（onLeaveBackground 幂等：未切后台立即返回），
    // 避免「分享返回牌局卡死」。
    if (this.inBackground) this.onLeaveBackground();
  },

  /**
   * 弹窗内容层的点按吞没：拦住冒泡，防止误触底下的遮罩关闭（bindtap=onHelpClose 等）。
   * 裸 catchtap（无属性值）在 WXML 校验里属「无保证行为」——空属性是否生效随
   * 基础库版本漂移（评审 2026-10-15 MEDIUM），显式绑定空函数才是稳定写法。
   */
  onBlockTap() { /* 有意留空：只吞冒泡，不做任何事 */ },

  /** 视口尺寸变化（转屏 / 分窗）时重算布局变量 */
  onResize(res) {
    this.updateViewport(res);
    this.measureFelt();
  },

  /**
   * JS 实测视口 → CSS 变量（样式不再依赖原生 vh/vw，防转屏后尺寸错乱）：
   *   --uh：纵向 1% 基准，横屏下 = 视口高/100；
   *         若被异常切回竖屏，取 min(宽,高)/100 兜底，页面按宽度等比缩放不爆版。
   *   --uw：横向 1% 基准 = 视口宽/100。
   */
  updateViewport(info) {
    let w = 0, h = 0;
    if (info && info.size) {
      w = info.size.windowWidth;
      h = info.size.windowHeight;
    } else if (wx.getWindowInfo) {
      const i = wx.getWindowInfo();
      w = i.windowWidth;
      h = i.windowHeight;
    }
    if (!w || !h) return;
    const uw = w / 100;
    const uh = Math.min(w, h) / 100;
    this.setData({
      rootStyle: '--uh:' + uh.toFixed(3) + 'px;--uw:' + uw.toFixed(3) + 'px;'
    });
    this.measureFelt();
  },

  /**
   * 实测 .felt 高度（uh 口径）→ this.feltUh（2026-10-21 单位混算根因修复）。
   *
   * 为什么必须实测而不是写死数值：uh 与 felt% 是两套单位，felt 是 flex:1 弹性
   * 容器——高度随【页面固定开销 + myzone/resultbar 有无 + 字体回流行高抖动】
   * 变化，不同手机不同。任何静态常数都会在部分机型上高估 felt 高、低估底池
   * 上沿，重现顶排被底池遮挡。SelectorQuery 量出的真实像素高 ÷ 本帧 uhPx
   * 才是唯一可信基准。
   *
   * 时序（「同一局内坐标不跳变」约束）：
   *   - onLoad 首帧渲染后 + onResize 各测一次；测量落定前 ringPositions 用
   *     FELT_UH_FALLBACK 保守值（换算放大、天花板收紧方向，宁可上排略挤不遮挡）。
   *   - 测量成功后 feltUh 固化到下一次 resize，**不在 resultbar/readyPhase 出现
   *     压矮 felt 时重算**——座位 % 坐标本来就随 felt 高度伸缩，若在局间重算，
   *     座位会在「结算条出现/消失」瞬间跳变（2026-10-19 定下的开局无跳变约束）。
   * 几何天花板只在「底池可见的动作态」下才有意义，所以基准取动作态实测值，
   * 局间压矮阶段继续沿用（天花板偏保守半档，方向安全）。
   */
  measureFelt() {
    if (!wx.createSelectorQuery) return;   // 测试环境无 SelectorQuery → 回退保守值
    try {
      wx.createSelectorQuery()
        .select('.felt').boundingClientRect()
        .exec(rects => {
          const r = Array.isArray(rects) && rects[0];
          if (!r || !r.height || r.height <= 0) return;
          // uhPx：与 updateViewport 同口径（横屏 = 视口高/100）
          let uhPx = 0;
          try {
            const i = wx.getWindowInfo ? wx.getWindowInfo() : {};
            const w = i.windowWidth || 0, h = i.windowHeight || 0;
            if (w && h) uhPx = Math.min(w, h) / 100;
          } catch (e) { uhPx = 0; }
          if (!uhPx) return;
          const feltUh = r.height / uhPx;
          // 防御性夹取：明显异常的测量值（分屏过渡态、页面隐藏态、大于全屏高
          // 的鬼值）丢弃，宁可保守回退。下限取 50：.felt 是 flex:1 主区，正常
          // 视口下不会低于视口高一半；留 [30,50) 的宽缝反而会让异常小值（测量
          // 落在弹窗/过渡态）把天花板整体抬高。首帧 render 可能先用回退值 65
          // 跑一次，实测回调后按新基准重排——真实视口 (55,92) 区间内最大位移
          // ≈3% 且方向单调，视为可接受的一次性跳变。
          if (feltUh < 50 || feltUh > 100) return;
          this.feltUh = Math.round(feltUh * 10) / 10;
        });
    } catch (e) { /* 测量失败：保持回退值，不阻断渲染 */ }
  },

  /**
   * 我这一位的显示名：默认取我的昵称（微信名），没设过才回落「你」。
   * 「（房主）」只在好友房里才有意义——AI 桌没有房主，别往名字后面堆后缀。
   */
  meLabel(withOwner) {
    const n = auth.myName('你');
    return (withOwner && this.mode === 'friend') ? n + '（房主）' : n;
  },

  /**
   * 等待室座位 → 牌桌座位环渲染数据：给每个座位算出环形坐标（与游戏中共用
   * ringPositions，锚定在我的座位 → 开局时座位位置连续无跳变），并补齐渲染字段。
   */
  buildWaitSeats(source) {
    const list = source || [];
    // 锚定座位：我若已入座则以我的座位为底部中央，否则用房主位（稳定布局）
    const anchor = this.roomSeat >= 0 ? this.roomSeat
      : (this.isOwner ? this.data.ownerSeat : 0);
    const pos = ringPositions(list.map(s => s.seat), anchor, this.feltUh);
    return list.map(s => {
      const p = pos[s.seat] || { x: 50, y: 20 };
      const empty = !s.occupied;
      const name = s.isMe ? this.meLabel(s.isOwner) : (s.name || '');
      return {
        seat: s.seat,
        seatNo: s.seat + 1,
        // cls 此前只有游戏态在构造，等待室这里漏了 → class 为空 → 座位拿不到
        // .seat 的绝对定位，与游戏中共用的座位环位置对不上。补齐后两态一致。
        cls: ['seat', list.length >= 7 ? 'tight' : '', empty ? 'empty' : '', s.isMe ? 'self' : ''].filter(Boolean).join(' '),
        sitText: '坐下',
        x: p.x, y: p.y,
        empty,
        occupied: !!s.occupied,
        isMe: !!s.isMe,
        isOwner: !!s.isOwner,
        isBot: !!s.isBot,
        name: empty ? '' : name,
        initial: empty ? '' : (name ? name.slice(0, 1) : '?'),
        // 等待室展示买入额（机器人与未指定者回落到默认买入），与牌局中同格式口径
        stack: empty ? '' : this.fmtStack(Number(s.stack) || DEFAULT_BUY_IN),
        // 以下字段游戏中才用，其余给安全默认值避免渲染异常
        bet: 0, folded: false, active: false, win: false, standing: false, allIn: false,
        isDealer: false, isSB: false, isBB: false,
        cardsBack: false, showCards: false, hole: [], actText: '', actCls: ''
      };
    });
  },

  /**
   * 进入等待室：房主坐 0 号位；访客（从分享卡片进入）自动落座 1 号位并等待房主开始。
   * 注意：访客落座仅本地可见——真实跨设备同步需要服务端房间状态（当前为本地引擎模拟）。
   * 等待室与牌桌共用同一张桌：座位环（seats）在此一并渲染，空座位带「坐下」按钮。
   */
  initWaiting() {
    const owner = this.data.ownerSeat;
    const guestSeat = 1;
    const ws = [];
    // 好友房：房主坐 0 号位、访客自动落 1 号位。
    // AI 桌：一张空桌——没有人预占，玩家自己挑哪个位置坐下（选座是这里的核心）。
    const presetByRole = this.mode === 'friend';
    // 按房间设定的限定人数生成座位（2 / 4 / 6）
    for (let i = 0; i < this.maxSeats; i++) {
      const isOwnerSeat = presetByRole && i === owner;
      const isGuestSeat = presetByRole && !this.isOwner && i === guestSeat;
      if (isOwnerSeat || isGuestSeat) this.buyInStack[i] = DEFAULT_BUY_IN;
      ws.push({
        seat: i,
        occupied: isOwnerSeat || isGuestSeat,
        isOwner: isOwnerSeat,
        isMe: isOwnerSeat ? this.isOwner : isGuestSeat,
        isBot: false,
        name: isOwnerSeat ? (this.isOwner ? this.meLabel(true) : '房主') : (isGuestSeat ? this.meLabel(false) : ''),
        isHost: isOwnerSeat,
        stack: (isOwnerSeat || isGuestSeat) ? DEFAULT_BUY_IN : 0
      });
    }
    this.setData({
      phase: 'waiting',
      waitSeats: ws,
      seats: this.buildWaitSeats(ws),
      canStart: this.canStartOf(ws),
      syncLive: this.syncLive,
      seatHint: this.syncLive && !this.isOwner && this.roomSeat < 0 ? '点击空位入座' : '',
      waitHint: this.mode === 'friend' ? '' : AI_WAIT_HINT.sitting
    });
    if (this.isOwner) this.armExpire();   // 仅房主侧计时：30 分钟无人加入自动销毁
  },

  /** 可开始条件：必须自己是房主（AI 桌即本人），且至少 2 人坐下 */
  canStartOf(seats) {
    return this.isOwner && (seats || []).filter(s => s.occupied).length >= 2;
  },

  /**
   * AI 桌自动补位：玩家坐下后把同桌补到能开局的最少人数（2 人）。
   * 不替玩家一次加满——想打多人桌由他自己点「添加电脑玩家」逐步加，
   * 但至少保证「坐下即可开始」，不会卡在按钮是灰的状态。
   */
  fillBots() {
    if (this.mode === 'friend') return;
    const seats = (this.data.waitSeats || []).slice();
    let botNo = seats.filter(s => s.isBot).length;
    while (seats.filter(s => s.occupied).length < 2) {
      const empty = seats.find(s => !s.occupied);
      if (!empty) break;   // 座位数为 1 的极端情况：无法补位
      empty.occupied = true;
      empty.isBot = true;
      empty.name = this.botLabel(botNo);
      empty.stack = this.mode === 'sng' ? SNG_START_STACK : DEFAULT_BUY_IN;
      botNo++;
    }
    this.setData({
      waitSeats: seats,
      seats: this.buildWaitSeats(seats),
      canStart: this.canStartOf(seats)
    });
  },

  // ---------- 跨设备同步（poker_room_seats：每人行 + 房主广播） ----------

  /**
   * 同步引导（好友房进入时调用，异步）：
   *   房主 → 占 0 号位并广播等待室布局；好友 → 先不占座（roomSeat=-1），
   *   在等待室点空位入座。随后启动轮询与心跳。
   * 任何一步失败都静默降级为「本地引擎模拟」，不卡界面。
   */
  async bootstrapSync() {
    if (this.mode !== 'friend' || !this.roomNo) return;
    try {
      let rows = [];
      try { rows = await roomSync.poll(this.roomNo); } catch (e) { rows = []; }

/**
     * 房主身份回收（关键修复，用户 2026-10-16 反馈「退出去邀请好友再进，房主就变人了」）。
     *
     * 病根：isOwner 只看 URL 的 own=1。而分享/邀请链接**不带 own 参数**，
     * 房主从自己分享出去的卡片重进 → isOwner 变 false → 自己被当成访客。
     *
     * 修法：以 **poker_rooms.owner_id**（服务端 auth.uid() 写入，客户端伪造不了）
     * 为唯一权威，与当前登录用户比对。own=1 退化为「乐观提示」——
     * 拿不到房间行时（首次进入 / 网络异常）才生效。
     *
     * 顺序很关键：必须先查房主归属再决定 seat，否则会出现「按访客逻辑坐 -1 号位、
     * 之后又切成房主」的座位错乱。
     */
      let roomOwner = null;
      try {
        const r = await auth.findRoom(this.roomNo);
        roomOwner = r && r.owner_id ? r.owner_id : null;
      } catch (e) { roomOwner = null; }
      let myUid = null;
      try {
        const p = await auth.ensureProfile();
        if (p) { app.globalData.profile = p; myUid = p.owner_id || null; }
      } catch (e) { /* 档案读取失败用兜底名，不阻断同步 */ }
      if (roomOwner && myUid && roomOwner === myUid) this.isOwner = true;
      this.setData({ isOwner: this.isOwner });

      // 房主恢复之前选过的座位；好友未选座时为 -1（进等待室再点空位）
      let seat = this.isOwner ? 0 : -1;
      if (this.isOwner) {
        // 房主重进房间：把历史动作序号先推到最新，避免重放离开期间积压的动作
        this.appliedSeqBySeat = roomSync.pendingActions(rows, {}).nextBySeat;
      }
      // 名字：广播给同桌好友看的那份，默认用我的微信昵称；
      // ensureProfile 已在上面调用过（顺带把登录态里的档案补齐，否则 myName 只能回落兜底名）
      const name = auth.myName(this.isOwner ? '房主' : '好友');
      // 买入额：房主沿用上次选择（重进房间不重置），好友入座时再选
      const mineRow = rows.filter(r => r.is_host)[0];
      const joinStack = this.isOwner && mineRow && mineRow.stack ? mineRow.stack : DEFAULT_BUY_IN;
      // 座位：房主优先沿用自己残留的行座位（离开时行未删干净的场景）
      if (this.isOwner && mineRow && Number(mineRow.seat) >= 0) seat = Number(mineRow.seat);
      this.buyInStack[seat] = joinStack;
      await roomSync.join(this.roomNo, {
        seat: seat,
        name: name,
        isHost: this.isOwner,
        stack: joinStack
      });
      this.roomSeat = seat;
      this.mySeat = this.isOwner ? seat : 0;
      this.syncLive = true;
      this.setData({ syncLive: true, seatHint: !this.isOwner ? '点击空位入座' : '' });
      this.startPolling();
      this.startHeartbeat();
      if (this.isOwner) this.publishWait();
      await this.pollOnce();
    } catch (e) {
      // 云端表不可用（旧应用未建表 / 网络异常）→ 本地引擎模拟。
      // stopSync 先清掉可能已起的轮询/心跳/发布定时器，防泄漏后再降级。
      this.stopSync();
      this.syncLive = false;
      this.setData({ syncLive: false, seatHint: '' });
      console.error('[table] 跨设备同步不可用，已降级本地模式',
        JSON.stringify({ stage: 'bootstrap-sync', message: e && e.message }));
    }
  },

  startPolling() {
    this.stopPolling();
    if (!this.syncLive || !this.roomNo) return;
    this.pollTimer = setInterval(() => { this.pollOnce(); }, roomSync.SYNC.POLL_MS);
  },

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },

  /** 同步写的失败提示统一收口：同文案 10s 内只提示一次（心跳 5s 一发、
   *  每发都弹 toast 会把界面刷成提示帘）。降级路径除外——降级已有
   *  专门的「已转本地模式」提示，这里不再叠加。 */
  syncFailToast(title) {
    this.syncFailLast = this.syncFailLast || {};
    const now = Date.now();
    if (now - (this.syncFailLast[title] || 0) < SYNC_FAIL_TOAST_MS) return;
    this.syncFailLast[title] = now;
    console.error('[table] 同步上行失败', JSON.stringify({ room: this.roomNo, title }));
    wx.showToast({ title, icon: 'none' });
  },

  startHeartbeat() {
    this.stopHeartbeat();
    if (!this.syncLive || !this.roomNo) return;
    this.hbTimer = setInterval(() => {
      roomSync.heartbeat(this.roomNo)
        .catch(() => this.syncFailToast('网络不稳定，同步可能延迟'));
    }, roomSync.SYNC.HEARTBEAT_MS);
  },

  stopHeartbeat() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  },

  stopSync() {
    this.stopPolling();
    this.stopHeartbeat();
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; }
  },

  /** 同步丢失（云端报错）：停掉轮询，退回本地模式 */
  onSyncLost() {
    if (!this.syncLive) return;
    // 切后台期间在途轮询被系统打断属预期，不算同步丢失：回前台 onLeaveBackground
    // 会重启轮询（并按 _syncWasLive 复活）。否则分享返回会被误判断网、永久降级
    // 本地模式 → 好友房牌局卡死。
    if (this.inBackground) return;
    this.syncLive = false;
    this.stopSync();
    this.setData({ syncLive: false });
    wx.showToast({ title: '云端同步中断，已转本地模式', icon: 'none' });
  },

  /**
   * 轮询一次房间：
   *   房主 → 消费好友动作（按座位分道的 appliedSeqBySeat 消化）、合并就绪计票、好友超时代行（无注过牌/有注弃牌）、广播状态；
   *   好友 → 读取房主广播：等待室布局 / 牌局快照镜像。
   */
  async pollOnce() {
    if (!this.syncLive || !this.roomNo) return;
    // 防重入：1.5s 轮询周期里若上一次 await roomSync.poll 尚未返回，本次直接跳过——
    // 避免慢钟设备上多次 poll 重叠并发，导致序号消化乱序或重复广播。
    if (this._polling) return;
    this._polling = true;
    let rows;
    try {
      rows = await roomSync.poll(this.roomNo);
    } catch (e) {
      this.onSyncLost();
      this._polling = false;
      return;
    }
    try {
      this.roomRows = rows;
      const st = roomSync.hostStateOf(rows);
      this.hostState = st;

      if (this.isOwner) {
        if (!st && this.data.phase === 'playing') this.publishPlay();
        if (this.data.phase === 'waiting') { this.renderWait(); return; }
        this.dropOfflineSeats(rows);
        const { actions, nextBySeat } = roomSync.pendingActions(rows, this.appliedSeqBySeat);
        Object.keys(nextBySeat).forEach(s => { this.appliedSeqBySeat[s] = nextBySeat[s]; });
        actions.forEach(a => this.applyFriendAction(a));
        if (this.data.readyPhase) this.mergeFriendReady(rows);
        this.watchFriendAction();
        this.healEngine();
        this.publishPlay();
        return;
      }

      // ---- 好友端 ----
      const host = roomSync.hostRow(rows);
      if (!host) {
        if (this.sawHost) {
          // 房主行消失（离开/解散）→ 退回首屏
          this.sawHost = false;
          wx.showToast({ title: '房主已离开，房间解散', icon: 'none' });
          this.leaveRoom();
        }
        return;
      }
      // 房主心跳僵死检测：行还在但心跳超时——房主可能已崩溃/杀进程，
      // 其行不会自己消失。给 HOST_STALE_EXIT_MS 宽限（覆盖一次长轮询/切后台恢复），
      // 仍未恢复则判房间僵死退出，好友端绝不无限干等。
      if (!roomSync.isOnline(host, Date.now())) {
        this.hostStaleSince = this.hostStaleSince || Date.now();
        if (Date.now() - this.hostStaleSince >= roomSync.SYNC.HOST_STALE_EXIT_MS) {
          this.hostStaleSince = 0;
          wx.showToast({ title: '房主长时间无响应，房间已解散', icon: 'none' });
          this.leaveRoom();
          return;
        }
      } else {
        this.hostStaleSince = 0;
      }
      this.sawHost = true;
      if (!st) { if (this.data.phase === 'waiting') this.renderWait(); return; }
      if (st.kind === 'waiting') {
        this.remoteMode = false;
        if (this.data.phase !== 'waiting') {
          // 房主退回等待室（重开一局）→ 好友同步退回
          this.clearResultTimer();
          this.clearResultModalTimer();
          this.setData({ phase: 'waiting', result: null, summary: null, timeUp: false, resultModal: null });
          if (game) game.result = null;
        }
        // 座位环按房间座位数铺满：以房主广播为准。好友从分享卡片进来时 URL
        // 不带 max，默认 6 会让 4 人桌在他那边多画出 2 个不存在的空位。
        if (st.maxSeats) this.maxSeats = Math.min(9, Math.max(2, Number(st.maxSeats) || 6));
        this.renderWait();
        return;
      }
      this.enterRemote(st);
    } finally {
      this._polling = false;
    }
  },

  /** 等待室布局：真人来自各自的行（在线才算占座），机器人来自房主广播 */
  renderWait() {
    if (this.data.phase !== 'waiting') return;
    const source = this.syncLive
      ? roomSync.buildWaitLayout(this.roomRows, this.hostState, this.maxSeats, this.roomSeat)
      : (this.data.waitSeats || []);
    const seats = this.buildWaitSeats(source);
    const occupiedCount = seats.filter(s => s.occupied).length;
    this.setData({
      waitSeats: source,
      seats: seats,
      canStart: this.isOwner && occupiedCount >= 2,
      seatHint: this.roomSeat < 0 ? '点击空位入座' : ''
    });
  },

  /** 房主广播等待室布局（只含机器人；真人身位在各自行里）。
   *  必须只在等待阶段广播：开局后残留的异步回调（如换座 .then）若把
   *  kind:'waiting' 写回去，会清掉 playing 快照，好友端会被踢回等待室。 */
  publishWait() {
    if (this.data.phase !== 'waiting') return;
    if (!this.syncLive || !this.isOwner || !this.roomNo) return;
    const bots = (this.data.waitSeats || [])
      .filter(s => s.isBot)
      .map(s => ({ seat: s.seat, kind: 'bot', name: s.name }));
    // 任何一处静默吞错都会让好友端 UI 与权威端静默撕裂；改回去前先读评审报告 MEDIUM 一节。
    roomSync.publishState(this.roomNo, { kind: 'waiting', seats: bots, maxSeats: this.maxSeats })
      .catch(() => this.syncFailToast('布局广播失败，好友端可能暂看不到'));
  },

  /**
   * 点座位：WePoker 式入座流程——先选买入额，再落座。
   * 点自己的座位可改买入额；点已占用座位给出提示。
   */
  chooseSeat(e) {
    const seat = Number(e.currentTarget.dataset.seat);
    if (isNaN(seat)) return;
    // 等待室：原流程（选买入额 → 落座，开局才发牌）
    // B4：SNG 起始筹码全员统一 2000，不弹买入选择（弹了也不许改）。
    if (this.data.phase === 'waiting') {
      const source = (this.data.waitSeats || []);
      const target = source.filter(s => s.seat === seat)[0];
      if (!target) return;
      if (target.occupied && !target.isMe) { wx.showToast({ title: '该座已有人', icon: 'none' }); return; }
      if (this.mode === 'sng') {
        this.setData({ buyInSeat: seat });
        this.sitSeat(seat, SNG_START_STACK);
        wx.showToast({ title: '淘汰赛统一 2000 筹码开局', icon: 'none' });
        return;
      }
      this.setData({
        buyInShow: true,
        buyInSeat: seat,
        buyInValue: this.buyInStack[seat] || DEFAULT_BUY_IN
      });
      return;
    }
    // 游戏中（含就绪阶段）：桌上有 N 个位，没坐满时那几个位照样能点。
    // 只拦「正坐着人」的位——站起观战者（sittingOut）不算占座，可以让位给新来的人。
    // B4（2026-10-17）：SNG 淘汰赛禁中途加入——半路用任意筹码入局会直接
    // 破坏名次公平性（先淘汰者反而可能被后来者「顶掉」最终名次）。
    if (this.mode === 'sng' && this.data.phase === 'playing') {
      wx.showToast({ title: '淘汰赛进行中，不可中途加入', icon: 'none' });
      return;
    }
    const occupant = game ? game.seatOf(seat) : null;
    if (occupant && !occupant.sittingOut) {
      wx.showToast({ title: '该座已有人', icon: 'none' }); return;
    }
    this.buyInStack[seat] = this.buyInStack[seat] || DEFAULT_BUY_IN;
    this.setData({
      buyInShow: true,
      buyInSeat: seat,
      buyInValue: this.buyInStack[seat],
      buyInBBText: this.calcBuyInBB(this.buyInStack[seat])
    });
  },

  /**
   * B6（玩家审视 2026-10-17）：买入额折算 BB 文案。
   * 弹窗 Woods 文案「盲注 10/20，1000 ≈ 50BB」原是写死的——涨盲后 10/20
   * 与实际盲注脱钩，玩家没法按 BB 口径估量买入额。waiting 期 game 可能
   * 还没建（null），此时退回页面初始盲注 data.blindText（10/20），与
   * 建局实际盲注一致（建局盲注 = 游戏选项传入，初始就这一档）。
   */
  calcBuyInBB(value) {
    const bb = (game && game.bb) ? game.bb : Number(String(this.data.blindText || '10/20').split('/')[1]) || 20;
    const v = Number(value) || DEFAULT_BUY_IN;
    return Math.round(v / bb);
  },

  /** 选买入额档位：同步刷新 BB 折算文案 */
  onBuyInPick(e) {
    const v = Number(e.currentTarget.dataset.v);
    if (!v) return;
    this.setData({ buyInValue: v, buyInBBText: this.calcBuyInBB(v) });
  },

  cancelBuyIn() {
    this.setData({ buyInShow: false, buyInSeat: -1 });
  },

  /* ---------- B3 好友房手动补筹（用户需求 2026-10-17；规则定案 2026-10-19）----------
   * 输光不再被动等系统补：玩家自己决定何时补、补多少，补后总额封顶 REBUY_CAP。
   * bot 仍由房主端自动补（演示态）。三条硬规则（用户评审 2026-10-19）：
   *   1. 一律下一手生效：任何时点（对局中/就绪/结算）确认都只记 pendingRebuyMap，
   *      startHand 发牌前统一消化——进行中改 stack 破坏当手 legality/边池；
   *      就绪阶段点了补筹再点「准备就绪」，下一手开局即带着新筹码（用户原话场景）。
   *   2. 金额必须是 DEFAULT_BUY_IN（1000）的整数倍：+1000/+2000/+3000…，
   *      受 REBUY_CAP - stack 钳制（最后一级可不足整倍，例 stack=4200 → +800）。
   *   3. 同一手只能有一笔申请：确认后置「已申请」，重复点提示不累计；
   *      「已申请」态可取消（用户确认：误操作不该罚一手）。房主端摘除本地
   *      pendingRebuyMap[mySeat] 即可；好友端 pending 钱在房主机里，取消也走
   *      rebuy 动作上行（add:0 = 撤销），房主端摘除该座 pending。
   * 实例字段 _myRebuyPending = { hand, add }：我本手已申请的补筹（供防重 +
   * 「待补 +N」角标；镜像端下一帧快照回来前先本地顶着，防轮询窗口重复点）。
   * 历史死代码 _rebuyDismissedHand（只写不读）已整段删除；canRebuyNow 开头
   * 原「remoteMode 未初始化」空 if 连注释带条件删除（onLoad 已初始化，无窗口）。
   *
   * ⚠️ 上行时序（P3，评审 2026-10-19）：room-sync 的 action 是「每行一个槽」，
   * 新动作整列覆盖旧的（pushAction 直接 upsert action 字段）。所以「申请→撤销」
   * 快速连点时房主只会看到后一条（撤销时已无申请可撤，无害）；真正的风险是
   * 跨手错位——好友在 H1 申请、房主 H2 前才消化，钱会记进 H2 的 pending。
   * 旧注释写的「房主消化时与在途申请相消」不成立。现在上行 rebuy 动作带
   * handNo，房主 applyFriendAction 只接受 handNo === 当前手（即申请针对
   * 「下一手」的口径），过期申请直接丢弃。 */
  canRebuyNow() {
    if (this.mode !== 'friend') return false;
    const me = game && game.seatOf(this.mySeat);
    if (!me || !me.isHuman || me.sittingOut) return false;
    if (!this.seatedOf(this.mySeat)) return false;
    return true;
  },

  /** 我剩余可补空间（补后总额 ≤ REBUY_CAP） */
  rebuyRoomLeft() {
    const me = game && game.seatOf(this.mySeat);
    if (!me) return 0;
    return Math.max(0, REBUY_CAP - me.stack);
  },

  /** 补筹额规整（规则 2）：向下取 DEFAULT_BUY_IN 整数倍，不足一手按一手计，
   *  再钳到剩余空间（最后一级允许不足整倍——上限优先于整倍纪律）。 */
  roundRebuyAdd(v) {
    const left = this.rebuyRoomLeft();
    if (left <= 0) return 0;
    const n = Math.floor(Number(v) / DEFAULT_BUY_IN);
    const add = (n >= 1 ? n : 1) * DEFAULT_BUY_IN;
    return Math.min(add, left);
  },

  /** 打开补筹弹窗：档位 = +1000/+2000/+3000…（整手倍数，规则 2），按剩余空间截断；
   *  本手已申请过 → 弹「取消申请」态（规则 3：不重复累计，给反悔出口）。 */
  openRebuy() {
    if (!this.canRebuyNow()) return;
    // 就绪阶段打开补筹窗 → 先撤销「已就绪」：否则其他人（含 bot）先齐、下一手在
    // 我确认补筹之前就发出去，`game.handNo` 已 +1 → 补筹被记到再下一手才生效
    // （真机 2026-10-20「下下局才生效」）。确认后再点「准备就绪」即可，补筹随
    // 下一手开局到账。
    if (this.data.readyPhase && this.readyMap && this.readyMap[this.mySeat]) {
      this.markReady(this.mySeat, false);
    }
    const me = game.seatOf(this.mySeat);
    const pend = this._myRebuyPending || {};
    const pendingMine = game && pend.hand === game.handNo && pend.add > 0;
    if (pendingMine) {
      this.setData({
        rebuyShow: true,
        rebuySeated: true,
        rebuyValue: pend.add,
        rebuyOptions: [],
        rebuyCancelMode: true    // 「已申请 +N」态：确认钮换「取消申请」
      });
      return;
    }
    if (this.rebuyRoomLeft() <= 0) {
      wx.showToast({ title: '已到补筹上限', icon: 'none' });
      return;
    }
    const first = this.roundRebuyAdd(DEFAULT_BUY_IN);
    const opts = [];
    for (let add = DEFAULT_BUY_IN; add <= REBUY_CAP; add += DEFAULT_BUY_IN) {
      if (add > this.rebuyRoomLeft()) break;
      opts.push({ v: add, t: '+' + add });
    }
    if (opts.length === 0) opts.push({ v: this.rebuyRoomLeft(), t: '补满 ' + REBUY_CAP });   // 不足整倍的收尾档
    this.setData({
      rebuyShow: true,
      rebuySeated: true,
      rebuyValue: first,
      rebuyOptions: opts,
      rebuyCancelMode: false
    });
  },

  onRebuyPick(e) {
    const v = Number(e.currentTarget.dataset.v);
    if (!v) return;
    this.setData({ rebuyValue: v });
  },

  onRebuyInput(e) {
    let v = parseInt(e.detail.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    // 输入预览保持原值，规整（整倍）在确认时统一做——输入中途强制跳秒数反焦
    this.setData({ rebuyValue: Math.min(v, this.rebuyRoomLeft()) });
  },

  cancelRebuy() {
    this.setData({ rebuyShow: false, rebuyCancelMode: false });
  },

  /** 确认补筹：一律记 pending 下一手生效（规则 1）；本手已申请过则先撤销旧的
   *  再记新的（弹窗进不来这分支——openRebuy 已拦截，双保险）。
   *  房主端写本地 pendingRebuyMap；好友端上行 rebuy 动作（add:0 = 撤销申请）
   *  由房主消化，自己置「已申请」态，快照广播回来后界面自然更新。 */
  confirmRebuy() {
    if (!this.canRebuyNow()) { this.setData({ rebuyShow: false, rebuyCancelMode: false }); return; }
    if (this.data.rebuyCancelMode) { this.revokeRebuy(); return; }
    const add = this.roundRebuyAdd(this.data.rebuyValue || 0);
    if (add <= 0) { this.setData({ rebuyShow: false, rebuyCancelMode: false }); return; }
    this.setData({ rebuyShow: false, rebuyCancelMode: false });
    this._myRebuyPending = { hand: game ? game.handNo : -1, add: add };
    if (this.remoteMode) {
      // 缺 zone 提示不走常见 todo：好友端没有引擎权威，写本地会被下一帧快照卷回。
      // 上行给房主消化；失败提示用户（禁静默吞——SILENT_OK_COUNT 守卫）。
      roomSync.pushAction(this.roomNo, { type: 'rebuy', seat: this.roomSeat, add: add, handNo: this._myRebuyPending.hand })
        .catch(() => this.syncFailToast('补筹未同步成功，请重试'));
      wx.showToast({ title: '已申请补筹 +' + add, icon: 'none' });
      this.pushChat(this.mySeat, this.meLabel(false), '申请补筹 +' + add);
      this.render();
      return;
    }
    // 房主端：一律记 pending（规则 1），下一手 startHand 发牌前统一消化
    this.pendingRebuyMap[this.mySeat] = add;
    this.pushChat(this.mySeat, this.meLabel(false), '补筹 +' + add);
    this.forcePublish();   // 立即广播（置 _lastPlayFp=null 穿透写库脏检查）
    this.render();
  },

  /** 撤销本手已申请的补筹（规则 3：已申请态可取消）。房主端摘本地记录；
   *  好友端 pending 钱记在房主机的 pendingRebuyMap，同样走 rebuy 动作
   *  （add:0 = 撤销）由房主消化撤销。生效后（startHand 已消化）不可撤——
   *  UI 只在 _myRebuyPending 未过期时给入口，这里再加 handNo 断言双保险。 */
  revokeRebuy() {
    this.setData({ rebuyShow: false, rebuyCancelMode: false });
    const pend = this._myRebuyPending || {};
    if (!game || pend.hand !== game.handNo || !(pend.add > 0)) return;
    this._myRebuyPending = { hand: -1, add: 0 };
    if (this.remoteMode) {
      // handNo 一并上行：撤销针对的是「我申请时那一手」，房主端按它判过期（P3）
      roomSync.pushAction(this.roomNo, { type: 'rebuy', seat: this.roomSeat, add: 0, handNo: pend.hand })
        .catch(() => this.syncFailToast('撤销未同步成功，请重试'));
      wx.showToast({ title: '已撤销补筹申请', icon: 'none' });
      this.render();
      return;
    }
    delete this.pendingRebuyMap[this.mySeat];
    this.pushChat(this.mySeat, this.meLabel(false), '撤销补筹');
    this.forcePublish();
    this.render();
  },

  /** 确认入座：记录买入额 → 本地即时反馈 → 同步云端（RLS 只能改自己的行） */
  confirmBuyIn() {
    const seat = this.data.buyInSeat;
    // B4：SNG 统一 2000 起始（等待室入口已绕过弹窗，此处兜底游戏中重新入座）
    const buyIn = buyInOf(this.mode, Number(this.data.buyInValue) || DEFAULT_BUY_IN);
    if (seat < 0) { this.setData({ buyInShow: false }); return; }
    this.setData({ buyInShow: false, buyInSeat: -1 });
    // 等待室：直接落座，开局发牌；游戏中：下一手才入局（不插当前手）
    if (this.data.phase === 'waiting') {
      this.sitSeat(seat, buyIn);
    } else {
      this.joinMidGame(seat, buyIn);
    }
  },

  /**
   * 游戏中（含就绪阶段）入座：选好买入额后，下一手发牌才正式入局——
   * 不插进当前进行中的这一手（本手仍观战，轮到也自动弃牌）。
   *
   * 三种情形在一个入口收口，全部推迟到下一手生效：
   *   ① 我还没座位（新进来 / 已离席）→ 中途加入，落到点的那个位
   *   ② 我已有座位（含站起观战中）  → 换座，下一手挪到新位
   *   ③ AI 桌我已在座              → 点空位 = 在该位补一个电脑玩家
   * 顶替：目标位上是站起观战的人时，他把位子让给新来的——战绩先转入 leftPlayers，
   *      结算单照旧统计他（让座不等于从结算里消失）。
   *
   * 好友房镜像端：座位号是本地重映射的，上行一律换成房间座位号，
   * 否则房主端按「座位伪冒」直接丢弃。
   */
  joinMidGame(seat, buyIn) {
    if (!game) return;
    this.vacateIfStanding(seat);
    this.buyInStack[seat] = buyIn;
    if (this.remoteMode) {
      const roomSeat = this.roomSeatOfLocal(seat);
      // #13 修复（2026-10-19）：入座成功必须更新 this.roomSeat——此前它一直是
      // bootstrapSync 设的 -1（观战），导致后续 loadSnapshot 永远无法把自己
      // 映射回本地 0 号位（me0 不存在 → 看不到底牌、无法行动），用户所见即
      // 「提示下一手入局，实际下一手没加入」。乐观置位：上行链失败时已有
      // syncFailToast 提示重试，重试会走同一分支再次置位，无需回滚。
      this.roomSeat = roomSeat;
      // 先占云端的房间座位，再上行加入动作——两条串在一条链上，
      // 任一步失败都统一提示（上行失败必须让用户看见，不能静默吞掉）
      roomSync.moveSeat(this.roomNo, roomSeat, buyIn)
        .then(() => roomSync.pushAction(this.roomNo, { type: 'join', seat: roomSeat }))
        .catch(() => this.syncFailToast('入座未同步成功，请重试'));
      this.pendingSit = true;
      wx.showToast({ title: '下一手开始入局', icon: 'none' });
      this.render();
      return;
    }
    const me = game.seatOf(this.mySeat);
    const seated = me && !me.sittingOut;
    if (!me) {
      // ① 中途加入：引擎里还没我这个人，下一手把新玩家插进去
      this.pendingJoin = {
        seat, stack: buyIn, isHuman: true,
        name: this.meLabel(this.isOwner),
        style: { aggro: 0.4, tight: 0.35 }
      };
      this.myStanding = false;
      wx.showToast({ title: '下一手开始入局', icon: 'none' });
    } else if ((this.mode === 'ai' || this.mode === 'sng') && seated) {
      // ③ AI/SNG 桌：我一直在座，点空位就是在那位补个电脑玩家
      this.pendingBotSeat = seat;
      wx.showToast({ title: '下一手安排电脑玩家入座', icon: 'none' });
    } else if (seat === this.mySeat) {
      // 点自己的位（站起观战中）→ 重新入局
      this.pendingSit = true;
      this.myStanding = false;
      wx.showToast({ title: '下一手开始入局', icon: 'none' });
    } else {
      // ② 换座：本手打完再挪位
      this.pendingMove = { from: this.mySeat, to: seat };
      this.myStanding = false;
      // 房主换座要同步到云端：好友端的座位布局以云端座位行为准，
      // 不同步的话好友那边看到的还是旧座位
      if (this.syncLive && this.isOwner) {
        this.roomSeat = seat;
        roomSync.moveSeat(this.roomNo, seat, buyIn)
          .catch(() => this.syncFailToast('换座同步失败'));
      }
      wx.showToast({ title: '下一手换到 ' + (seat + 1) + ' 号位', icon: 'none' });
    }
    this.render();
  },

  /**
   * 目标位上是「站起观战」的人 → 他让位：先留档战绩再移出席位。
   *
   * 留档是必须的：结算单要统计所有参与过这局的人，中途离场者若直接从
   * game.players 消失，他就从结算单里蒸发了——账面盈亏会对不上。
   * leftPlayers 在 endGame 与在座者合并统计，并标「中途离场」。
   */
  vacateIfStanding(seat) {
    if (!game) return;
    const p = game.seatOf(seat);
    if (!p || !p.sittingOut) return;
    const buyIn = this.startStacks[p.seat] !== undefined ? this.startStacks[p.seat] : p.stack;
    this.leftPlayers.push({
      seat: p.seat, name: p.name || '玩家', isHuman: !!p.isHuman,
      buyIn, stack: p.stack, left: true
    });
    delete this.startStacks[p.seat];
    delete this.standingMap[p.seat];
    delete this.botSeats[p.seat];
    game.players = game.players.filter(x => x.seat !== seat);
  },

  /**
   * 下一手发牌前落位：换座 / 中途加入 / 补电脑玩家，三件都在引擎开新一手
   * （game.startHand）之前完成——引擎的座位名单、按钮轮转、盲注与发牌都是
   * 那一刻从 game.players 现算的，早一步插进去，新座位这一手就自然进了牌局。
   */
  applyPendingSeats() {
    if (!game) return;
    // ① 换座：记账跟着座位走（起始筹码按座位记账），并同步庄位引用
    if (this.pendingMove) {
      const from = this.pendingMove.from;
      const to = this.pendingMove.to;
      this.pendingMove = null;
      const p = game.seatOf(from);
      if (p && !game.seatOf(to)) {
        if (this.startStacks[from] !== undefined) {
          this.startStacks[to] = this.startStacks[from];
          delete this.startStacks[from];
        }
        if (this.botSeats[from]) { delete this.botSeats[from]; this.botSeats[to] = true; }
        delete this.standingMap[from];
        p.seat = to;
        p.sittingOut = false;                 // 换座即入座（含观战者重新入局）
        // 庄位若正落在这个座位，跟着迁移，否则按钮轮转会被打回 seats[0]
        if (game.dealerSeat === from) game.dealerSeat = to;
        if (game.sbSeat === from) game.sbSeat = to;
        if (game.bbSeat === from) game.bbSeat = to;
        if (this.mySeat === from) this.mySeat = to;
      }
    }
    // ② 中途加入：引擎里没有这个人 → 新建玩家插进去
    if (this.pendingJoin) {
      const j = this.pendingJoin;
      this.pendingJoin = null;
      if (!game.seatOf(j.seat)) {
        game.players.push({
          id: 'p' + j.seat + '-' + Date.now(), name: j.name, seat: j.seat,
          stack: j.stack, isHuman: !!j.isHuman, style: j.style,
          hole: [], folded: false, allIn: false,
          bet: 0, committed: 0, actedBet: null, canRaise: true, sittingOut: false,
          hands: 0, net: 0
        });
        this.startStacks[j.seat] = j.stack;
        if (j.isHuman) { this.mySeat = j.seat; this.myStanding = false; }
        delete this.standingMap[j.seat];
      }
    }
    // ③ AI 桌：空位补一个电脑玩家
    if (this.pendingBotSeat !== null && this.pendingBotSeat !== undefined) {
      const seat = this.pendingBotSeat;
      this.pendingBotSeat = null;
      if (!game.seatOf(seat)) {
        const botNo = game.players.filter(x => !x.isHuman).length;
        game.players.push({
          id: 'bot' + seat + '-' + Date.now(), name: this.botLabel(botNo), seat,
          stack: this.mode === 'sng' ? SNG_START_STACK : DEFAULT_BUY_IN, isHuman: false,
          style: botProfiles.styleFor(botNo, (this.mode === 'ai' || this.mode === 'sng') ? this.level : 'advanced'),
          hole: [], folded: false, allIn: false,
          bet: 0, committed: 0, actedBet: null, canRaise: true, sittingOut: false,
          hands: 0, net: 0
        });
        this.botSeats[seat] = true;
        this.startStacks[seat] = this.mode === 'sng' ? SNG_START_STACK : DEFAULT_BUY_IN;
      }
    }
    // ④ 进行中踢 bot：把目标 bot 移出 game.players 并留档 leftPlayers。
    // 与补 bot 对称——只在下一手 startHand 前落位，不打断当前手。
    // 移除前先存 leftPlayers：结算单仍统计该 bot 的带入/盈亏，账面不缺口。
    // 不踢真人（pendingKickBots 只在 kickBot 里对 bot 座位置位）；不移除庄位引用，
    // startHand 会按 game.players 现算按钮轮转，残留 dealerSeat 落在已空座位上
    // 时引擎有兜底（poker-core.js startHand 找不到按钮位会回退 seats[0]）。
    if (this.pendingKickBots && game) {
      Object.keys(this.pendingKickBots).forEach(s => {
        const seat = Number(s);
        const p = game.seatOf(seat);
        if (!p) return;
        const buyIn = this.startStacks[seat] !== undefined ? this.startStacks[seat] : DEFAULT_BUY_IN;
        this.leftPlayers.push({
          seat, name: p.name || '玩家', isHuman: false,
          buyIn, stack: p.stack, left: true
        });
        delete this.startStacks[seat];
        delete this.botSeats[seat];
        delete this.standingMap[seat];
        game.players = game.players.filter(x => x.seat !== seat);
      });
      this.pendingKickBots = {};
    }
  },

  /**
   * 镜像端（好友）：本地座位是 loadSnapshot 重映射后的紧凑号，
   * 与房间座位号不是同一个东西——上行的座位号必须是房间座位号。
   * 逆映射表在 enterRemote 时按引擎同一套规则复算（房间座位升序 → 本地 0,1,2…）。
   */
  roomSeatOfLocal(localSeat) {
    if (this._localToRoom && this._localToRoom[localSeat] !== undefined) {
      return this._localToRoom[localSeat];
    }
    return localSeat;
  },

  /** 落座（含换座）：本地即时反馈 + 云端同步，买入额随行写入 */
  sitSeat(seat, buyIn) {
    const prev = this.roomSeat;
    this.roomSeat = seat;
    if (this.isOwner) this.mySeat = seat;
    this.buyInStack[seat] = buyIn;
    if (prev >= 0 && prev !== seat) delete this.buyInStack[prev];   // 换座：旧座位买入额作废
    // 本地即时反馈：更新等待室布局与牌桌座位环（下一轮轮询会以云端为准）
    const seats = (this.data.waitSeats || []).map(s => {
      if (s.seat === seat) {
        return {
          seat: s.seat, occupied: true, isBot: false, isMe: true, isOwner: this.isOwner,
          name: this.meLabel(this.isOwner), isHost: this.isOwner, stack: buyIn
        };
      }
      if (s.seat === prev) {
        return { seat: s.seat, occupied: false, isBot: false, isMe: false, isOwner: false, name: '', isHost: false, stack: 0 };
      }
      return s;
    });
    this.setData({
      waitSeats: seats,
      seats: this.buildWaitSeats(seats),
      seatHint: '',
      waitHint: this.mode === 'friend' ? '' : AI_WAIT_HINT.seated
    });
    // AI 桌：坐下后立刻补一个对手，保证「开始游戏」直接可点
    this.fillBots();
    if (!this.syncLive) return;   // 本地模式：仅本地生效，不走云端换座
    roomSync.moveSeat(this.roomNo, seat, buyIn)
      .then(() => { if (this.isOwner) this.publishWait(); })
      .catch(() => wx.showToast({ title: '换座同步失败', icon: 'none' }));
  },

  /** 掉线检测：原在局里的真人座位心跳超时 → 视为站起，不卡牌局 */
  dropOfflineSeats(rows) {
    if (this.data.phase !== 'playing' || !game) return;
    const live = {};
    roomSync.activeSeats(rows, Date.now()).forEach(r => { live[r.seat] = true; });
    let dirty = false;
    game.players.forEach(p => {
      // ⚠️ 双判据：botSeats 是「座位表」，p.isHuman===false 是「玩家对象自身」的
      // 属性。只认 botSeats 时，只要它没被正确重建（如开局组装 players 时
      // 云端布局里该座位 isBot 为 false → id 取 'p'+seat 而非 'bot'+seat），
      // 电脑玩家就会因为没有云端心跳行而被判掉线、强制站起——真机表现为
      // 「添加了电脑玩家，坐下几秒后自己退出，人数又不足 2」（2026-10-17）。
      // 机器人没有云端座位行是设计如此，任何依赖「有无心跳」的判定都会误杀它。
      if (this.botSeats[p.seat]) return;              // 机器人不受心跳影响
      if (p.isHuman === false) return;                // 同上：按玩家对象判定（兜底）
      if (p.seat === this.mySeat) return;             // 我自己
      if (live[p.seat]) return;                       // 在线
      if (p.sittingOut) return;
      p.sittingOut = true;
      this.standingMap[p.seat] = true;                // 同步到 UI：头像下显示「观战」
      this.pushChat(p.seat, p.name, '掉线，自动站起');
      dirty = true;
    });
    // 中途站起若恰好轮到该座位 / 引擎推进落在他头上 → 立即代弃推进，防全桌冻结（C-2）
    if (dirty && !game.result && game.actionSeat >= 0) {
      const seat = game.actionSeat;
      if (!this.botSeats[seat] && seat !== this.mySeat && this.standingMap[seat]) this.advance();
    }
  },

  /**
   * 房主消化一个好友动作。
   * 座位一律取动作来源行自己的座位（a.rowSeat，由 pendingActions 绑定），
   * 不信任 payload 里的 seat——否则任何好友可替他人（含房主）行动/站起。
   * payload seat 与 rowSeat 不一致视为伪冒，整条丢弃。
   */
  applyFriendAction(a) {
    if (!game) return;
    if (a.type === 'act' && Number(a.seat) !== Number(a.rowSeat)) return;   // 座位伪冒 → 丢弃
    const seat = Number(a.rowSeat);
    if (a.type === 'act') {
      if (game.actionSeat === seat && !game.result) {
        // #14 批二：act 前存街内最高注——actLabel 的「下注/加注」语义按动作
        // 发生前的 currentBet 判定（act 后 currentBet 已变，拿不到正确口径）。
        const currentBetBefore = game.currentBet;
        const r = game.act(seat, a.action, a.amount || 0);
        if (r.ok) {
          // 动作文案精确写入（好友桌均可看见「对方做了什么」）。payload 只有
          // {type,seat,action,amount}，与 actLabel 查表口径完全同构，零新文案逻辑。
          this._lastActMap[seat] = {
            text: this.actLabel({ action: a.action, amount: a.amount || 0 }, currentBetBefore),
            cls: this.actClsOf(a.action)
          };
          this._actEpoch++;
          this.afterAct();
        }
      }
      // 动作过期（已不是该座行动 / 本手已结束）→ 丢弃
      return;
    }
    if (a.type === 'stand') {
      if (Number(a.seat) !== Number(a.rowSeat)) return;   // 座位伪冒 → 丢弃
      const p = game.seatOf(seat);
      if (p && !p.sittingOut) {
        p.sittingOut = true;
        this.standingMap[seat] = true;
        this.pushChat(seat, p.name, '站起观战');
        if (this.data.readyPhase) {
          // 就绪阶段站起 → 退出计票，其余人齐了就直接发下一手
          const seated = (this.data.readyList || []).filter(x => x.seat !== seat);
          this.setData({ readyList: seated });
          this.renderReady();
          this.checkAllReady();
        }
        // 牌局进行中站起：若行动权恰好在他手上 → 立即代弃推进，防全桌冻结（C-2）
        if (this.data.phase === 'playing' && !game.result && game.actionSeat === seat) this.advance();
        this.render();
        this.forcePublish();   // 站起是关键状态：穿透节流立即广播，镜像端马上回显
      }
      return;
    }
    if (a.type === 'sit') {
      if (Number(a.seat) !== Number(a.rowSeat)) return;   // 座位伪冒 → 丢弃
      // 坐下下一手生效：先记下，startHand 时清理 sittingOut
      this.pendingSitMap[seat] = true;
      delete this.standingMap[seat];
      const p = game.seatOf(seat);
      if (p) this.pushChat(seat, p.name, '重新入局（下一手生效）');
      this.forcePublish();
      return;
    }
    if (a.type === 'join') {
      // 中途加入：好友在牌局进行中占了新座位。
      // 房主端的座位号就是房间座位号，无需重映射——直接用动作来源行自己的座位。
      if (Number(a.seat) !== Number(a.rowSeat)) return;   // 座位伪冒 → 丢弃
      // 座位已被占（可能是别人抢先一步）→ 退化成「重新入局」，不重复插人
      if (game.seatOf(seat)) {
        this.pendingSitMap[seat] = true;
      } else {
        const row = (this.roomRows || []).filter(r => Number(r.seat) === seat)[0];
        this.pendingJoinMap[seat] = {
          name: (row && row.name) || '玩家',
          stack: Number(row && row.stack) || DEFAULT_BUY_IN
        };
      }
      delete this.standingMap[seat];
      this.pushChat(seat, '玩家', '加入牌局（下一手生效）');
      this.forcePublish();
      return;
    }
    if (a.type === 'rebuy') {
      // B3 好友手动补筹：rowSeat 断言同防伪冒——好友不能替他人补筹。
      // 规则 1（一律下一手生效）：一律记 pendingRebuyMap 由 startHand 统一
      // 消化，无「立即生效」分支——进行中改 stack 破坏当手口径；就绪阶段申请
      // 的也一样下一手开局到账，行为全时点一致可预期。
      if (Number(a.seat) !== Number(a.rowSeat)) return;
      const p = game.seatOf(seat);
      if (!p) return;
      if (!p.isHuman) return;                       // bot 拒收（房主端自动补）
      // P3：跨手过期判定。room-sync 每行只有一个 action 槽，好友在 H1 申请、
      // 房主 H2 前才轮询到时，不校验就会把「H1 的申请」记进 H2 的 pending。
      // 带上 handNo 的按「申请针对当前这一手（= 下一手生效）」判；缺字段的是
      // 旧版本客户端，保持兼容放行（与 P2 的整手倍纪律配合，风险面已被钳住）。
      if (a.handNo !== undefined && Number(a.handNo) !== Number(game.handNo)) return;
      const raw = Math.round(Number(a.add) || 0);
      if (raw === 0) {
        // add:0 = 撤销本手已申请的补筹（规则 3：已申请态可取消）
        delete this.pendingRebuyMap[seat];
        this.forcePublish();
        return;
      }
      if (raw < 0) return;
      // add 由行主自报，规整 + 钳制：整手倍（规则 2，镜像端已规整、这里再兜一
      // 层防直写云端）、补后不超 REBUY_CAP。同一手一笔（规则 3）：后值覆盖，不累计。
      // ⚠️ 不合规一律丢弃（P2，评审 2026-10-19）：旧实现 floor 后「不足一手按
      // 一手」强抬到 1000，等于把好友的非法请求放大成一整手——与会话里其它
      // handler「不合规就 return」的口径相反。整手倍纪律是硬约束：非整数倍
      // （300/1500）直接拒收，不猜测玩家本意。
      if (raw % DEFAULT_BUY_IN !== 0) return;
      let add = raw;
      add = Math.min(add, Math.max(0, REBUY_CAP - p.stack));
      if (add <= 0) return;
      this.pendingRebuyMap[seat] = add;
      this.pushChat(seat, p.name, '申请补筹 +' + add);
      this.forcePublish();
      return;
    }
    if (a.type === 'emote') {
      // 表情：rowSeat 断言同防伪冒——他人不能替我发表情。
      // emoji 过渲染白名单才冒泡（防伪造内容/超长 payload）。频控在冒泡侧做。
      if (Number(a.seat) !== Number(a.rowSeat)) return;
      if (EMOTE_SET.indexOf(a.emoji) < 0) return;
      this._showEmoteBubble(seat, a.emoji);
      return;
    }
    if (a.type === 'chat') {
      // 快捷语/表情文字：rowSeat 断言同防伪冒——他人不能替我发快捷语。
      // 文案过 CHAT_TEXT_SET 白名单才进面板（防伪造内容/超长 payload）。
      // 用 rowSeat 对应玩家的引擎名字作显示名，与本地站起/入局系统消息同口径。
      if (Number(a.seat) !== Number(a.rowSeat)) return;
      if (CHAT_TEXT_SET.indexOf(a.text) < 0) return;
      const p = game.seatOf(seat);
      this.pushChat(seat, p ? p.name : '', a.text);
      return;
    }
  },

  /** 立即广播一次（忽略 500ms 节流与脏检查）：站起/坐下/结算等关键状态变化用。
   *  must force：多数调用点的变动已进指纹（sittingOut/bet 等）；站起/坐下若
   *  不改任何指纹字段（罕见），靠这里旁路脏检查保证一定写出去。 */
  forcePublish() {
    this.publishDue = 0;
    this._lastPlayFp = null;   // 作废指纹 → writePlayState 必然重新写库
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; }
    this.publishPlay();
  },

  /** 就绪计票合并：好友的 ready_hand === 下一手手数 即视为已准备 */
  mergeFriendReady(rows) {
    if (!game) return;
    const ready = roomSync.readySeats(rows, game.handNo + 1, Date.now());
    let changed = false;
    Object.keys(ready).forEach(s => {
      if (!this.readyMap[s]) { this.readyMap[s] = true; changed = true; }
    });
    if (changed) {
      this.renderReady();
      this.checkAllReady();
      this.publishPlay();
    }
  },

  /** 远端好友行动超时（30s）：房主代行防卡死。与本地超时 startTimer 同口径——
   *  有注 → 弃牌，无注（可免费看牌）→ 过牌，不替好友主动掏筹码/跟注。 */
  watchFriendAction() {
    if (!game || game.result || game.actionSeat < 0) { this.friendActSince = 0; return; }
    const seat = game.actionSeat;
    if (seat === this.mySeat || this.botSeats[seat]) { this.friendActSince = 0; return; }
    const now = Date.now();
    if (this.isStanding(seat)) {
      // 该座位已被判站起/掉线（sittingOut → legalActions 返回 null，act 会被拒）：
      // 不能干等 30s——立即走 advance 的中途站起弃牌推进，否则全桌冻结（C-2）。
      this.friendActSince = 0;
      this.advance();
      return;
    }
    if (!this.friendActSince) this.friendActSince = now;
    if (now - this.friendActSince >= roomSync.SYNC.ACTION_TIMEOUT_SEC * 1000) {
      this.friendActSince = 0;
      const p = game.seatOf(seat);
      // 与本地超时同口径：无注可免费看牌 → 过牌；有注 → 弃牌（不替好友主动跟注）。
      // legalActions 返回 null（已不可行动）时 fallback 弃牌，act 会被引擎拒走兜底。
      const legal = game.legalActions(seat);
      const act = legal && legal.toCall === 0 ? 'check' : 'fold';
      const r = game.act(seat, act);
      if (r.ok) {
        this.pushChat(seat, p ? p.name : '', act === 'check' ? '超时未行动，自动过牌' : '超时未行动，自动弃牌');
        this.afterAct();
      } else {
        // 代行被拒（座位已不可行动）：罕见但必须兜底，否则 watchFriendAction 每 1.5s 空转
        console.error('[table] 好友超时代行被引擎拒绝', JSON.stringify({ seat, act, error: r.error }));
        this.advance();
      }
    }
  },

  /** 某个座位是否是「等上行的真人好友」（房主端不代打，只等待） */
  isFriendSeat(seat) {
    return this.syncLive && !this.botSeats[seat] && seat !== this.mySeat;
  },

  /**
   * 引擎自愈（房主端每次轮询检查）：轮到的本机 AI 座位却没有任何调度器在跑
   * （开局链路曾异常/定时器丢失）→ 重新挂上，保证牌局永不无声停滞。
   */
  healEngine() {
    if (!game || game.result || this.data.readyPhase) return;
    if (this.data.timeUp || this.data.summary) return;   // 本局已结束，不再驱动
    const seat = game.actionSeat;
    if (seat < 0 || seat === this.mySeat) return;
    if (this.isFriendSeat(seat)) return;          // 真人好友由 watchFriendAction 兜底
    if (this.isStanding(seat)) return;            // 站起者由 advance 的自动弃牌处理
    if (!aiTimer) this.scheduleAI();
  },

  /**
   * 回前台主动重新武装「当前行动者」（2026-10-19 分享返回卡死修复）。
   *
   * 背景：onEnterBackground 会清掉 aiTimer（AI 调度）与 timer（我的倒计时），
   * 而 onLeaveBackground 只恢复轮询/看门狗/音效/涨盲/时钟——**没重新武装当前
   * 行动者**。分享（切后台）回来后：轮到我 → 倒计时冻结、30s 自动弃牌不触发；
   * 轮到真人好友 → friendActSince 仍停在切后台前，首轮轮询可能被后台时间误判
   * 超时；轮到 AI → 只能等看门狗 1.5s 补调度。部分机型分享面板关闭不回调
   * onShow，连看门狗都起不来 → 整手卡死。
   *
   * 与 advance() 的三路分支同口径，幂等：我的座位 → 重启倒计时；真人好友 →
   * 重置超时起点；AI/机器人 → 重新调度。由 onLeaveBackground 与 onFirstTouch
   * （漏掉 onShow 的机型兜底）调用。
   */
  resumeEngine() {
    if (!game || game.result || this.data.readyPhase) return;
    if (this.data.timeUp || this.data.summary) return;
    const seat = game.actionSeat;
    if (seat < 0) return;
    if (seat === this.mySeat) {
      // 我的行动：重置倒计时（onEnterBackground 清掉了 timer）。
      // startTimer 自带 clearInterval，可安全重复调用；只在回前台时走一次。
      this.startTimer();
      return;
    }
    if (this.isStanding(seat)) return;   // 站起者由 advance 的自动弃牌处理
    if (this.isFriendSeat(seat)) {
      // 房主端等真人好友：回前台重新计 30s，不把后台时间算作好友拖延
      // （否则一回来就立刻替好友弃牌——尤其是房主自己分享离开的那段时间）。
      this.friendActSince = Date.now();
      return;
    }
    if (!aiTimer) this.scheduleAI();     // AI/机器人：补调度
  },

  /**
   * 引擎看门狗：AI 对战没有轮询循环可挂自愈，独立起 1.5s 定时巡检。
   * 好友房轮询里也会调 healEngine，看门狗属双保险（aiTimer 槽位防重复调度）。
   */
  startEngineWatch() {
    this.stopEngineWatch();
    this.engineWatch = setInterval(() => {
      try { this.healEngine(); } catch (e) { /* 巡检本身不许抛错 */ }
    }, 1500);
  },

  stopEngineWatch() {
    if (this.engineWatch) { clearInterval(this.engineWatch); this.engineWatch = null; }
  },

  /** 房主广播牌局状态（节流 ~500ms，好友 1.5s 轮询，无需每次渲染都写库） */
  publishPlay() {
    if (!this.syncLive || !this.isOwner || !this.roomNo) return;
    if (this.data.phase !== 'playing' || !game) return;
    const now = Date.now();
    if (this.publishTimer) clearTimeout(this.publishTimer);
    const due = this.publishDue || 0;
    if (now >= due) {
      this.publishDue = now + 500;
      this.writePlayState();
    } else {
      this.publishTimer = setTimeout(() => {
        this.publishTimer = null;
        this.publishDue = Date.now() + 500;
        this.writePlayState();
      }, due - now);
    }
  },

  writePlayState() {
    if (!this.syncLive || !this.isOwner || !this.roomNo || !game) return;
    const snap = game.snapshot();
    const state = {
      kind: 'playing',
      snapshot: snap,
      legal: game.actionSeat >= 0 ? game.legalActions(game.actionSeat) : null,
      seqBySeat: this.appliedSeqBySeat,   // 调试口：房主已消化的动作序号（按座位分道）
      readyPhase: this.data.readyPhase,
      readyList: this.data.readyList || [],
      readyLeft: this.data.readyLeft || 0,
      readyHint: this.data.readyHint || '',
      summary: this.data.summary || null,
      clockPendingEnd: !!this.data.clockPendingEnd,   // 到点挂起中：好友端也显示「本手后」
      handNo: game.handNo,
      // 房间座位数：座位环按它铺满，好友端必须与房主端看到同样多的位。
      // 好友从分享卡片进来时 URL 上不带 max，默认 6 会让 4 人桌在他那边
      // 多画出 2 个根本不存在的空位（还能点进去，点了坐不上）。
      maxSeats: this.maxSeats,
      // 氛围表情队列（设计 §1）：随快照广播，镜像端按放行窗口渲染。
      // 频控已在发送端/冒泡侧做过，这里只做滚动上限截断。
      emotes: (this.data.emotes || []).slice(-EMOTE_QUEUE_MAX),
      // 快捷语队列（设计 §2.4 观战快捷语）：随快照广播，镜像端按座次重映射后进聊天面板。
      // 与 emotes 同构——最近 N 条滚动，房主消化 chat 动作后追加到 chatLog 再裁剪广播。
      // chatLog 里的系统消息（站起/入局/超时代弃）也在队列里，镜像端按白名单过滤后只回放
      // 好友发的快捷语/表情（系统消息在镜像端由其自己的本地逻辑生成，避免重复）。
      chats: (this.data.chatLog || []).slice(-CHAT_QUEUE_MAX)
      // G6 的 endHoles 透传已于 2026-10-17 随「看全桌牌」入口撤销一并退役：
      // 唯一消费者是镜像端结算弹窗的降级构建，入口没了数据白传。
    };
    // 脏检查（评审 2026-10-15 MEDIUM「房主全量写库无脏检查」）：房主 500ms 节流后
    // 仍会因每次 render / 轮询而调到这里；若牌局实质未变（同手同街同注同池同动作
    // 座位），整条状态与上一帧逐字节相同——写库纯属空转，徒增云端配额与 RTT。
    // 以 snapshot 的关键字段拼出指纹，与上一帧比对：未变则跳过本轮写库；变动或
    // 就绪/结算这类「牌桌外」状态变化仍照写（forcePublish 会绕过本检查）。
    const fingerprint = [
      snap.handNo, snap.street, snap.currentBet, snap.pot,
      snap.actionSeat, snap.sb, snap.bb,   // 批④：盲注级随房主涨盲变化，写库必须反映
      snap.boardCodes.join(','),
      (snap.players || []).map(p => p.seat + ':' + p.stack + ':' + p.bet + ':' +
        (p.folded ? 1 : 0) + (p.allIn ? 1 : 0) + (p.sittingOut ? 1 : 0) +
        (p.hole ? p.hole.join('.') : '')).join('|'),
      this.data.readyPhase ? 'r' + (this.data.readyList || []).map(x => x.seat + (x.ready ? 1 : 0)).join(',') : '',
      this.data.summary ? 's' + JSON.stringify(this.data.summary) : '',
      this.data.clockPendingEnd ? 'cp' : '',
      // 表情队列内容/位置变化必须触发写库——否则好友端看不到新表情（轮询内唯一广播时机）
      'e' + (state.emotes || []).map(x => x.seat + x.emoji + x.bornAt).join('|'),
      // 快捷语队列变化必须触发写库——否则好友端看不到新快捷语（轮询内唯一广播时机）
      'c' + (state.chats || []).map(x => x.id + ':' + x.seat + ':' + (x.text || '')).join('|')
    ].join('#');
    if (this._lastPlayFp === fingerprint) return;
    this._lastPlayFp = fingerprint;
    // 房间公开状态写库失败必须提示：好友端下一帧就看不到牌局了，用户却完全不知情。
    // 与其它上行共用 syncFailToast 节流，避免半路复活时连续失败屏被 toast 刷屏。
    roomSync.publishState(this.roomNo, state)
      .catch(() => this.syncFailToast('牌局同步失败，好友端可能暂看不到'));
  },

  /**
   * 好友端进入镜像：把房主广播的快照装进本地 game 对象，
   * 按「我 = 本地 0 号位」重映射座位，之后复用同一套渲染与操作逻辑。
   */
  enterRemote(st) {
    const snap = st && st.snapshot;
    if (!snap) return;
    // 座位环按房间座位数铺满：以房主广播为准。好友从分享卡片进来时 URL 不带
    // max，默认 6 会让 4 人桌在他那边多画出 2 个根本不存在的空位（还能点进去）。
    if (st.maxSeats) this.maxSeats = Math.min(9, Math.max(2, Number(st.maxSeats) || 6));
    if (!game) {
      game = P.createGame({ players: [], sb: 10, bb: 20, dealerSeat: 0, seed: 'mirror-' + this.roomNo });
    }
    game.loadSnapshot(snap, this.roomSeat, { legal: st.legal });
    this.remoteMode = true;
    this.mySeat = 0;

    // 站起/坐下状态以权威端为准（sittingOut 重映射后在 0 号位）
    const me0 = game.seatOf(0);
    this.myStanding = !!me0 && !!me0.sittingOut;
    this.pendingSit = false;
    this.standingMap = {};

    // 就绪名单座位号跟随快照重映射（房主坐标 → 本地「我=0」坐标），
    // 否则镜像端座位徽章对不上座位（就绪状态上座位的渲染依赖 seat 匹配）。
    const remapS = {};
    let nextLocal = 1;
    ((snap.players && snap.players.map(p => p.seat)) || []).sort((a, b) => a - b).forEach(s => {
      remapS[s] = (s === this.roomSeat) ? 0 : nextLocal++;
    });
    // 逆映射留档：本地座位 → 房间座位。上行的座位号（入座/换座）必须是房间座位号，
    // 房主端按房间座位记账，传本地号会被当成座位伪冒直接丢弃。
    this._localToRoom = {};
    Object.keys(remapS).forEach(r => { this._localToRoom[remapS[r]] = Number(r); });
    // 空位也要进逆映射（#13 修复 2026-10-19）：座位环按「原始下标 0..maxSeats-1」
    // 铺满空位，这些下标与房间座位号没有任何恒等关系——中途加入的好友点空位时，
    // joinMidGame 拿它查 roomSeatOfLocal，表内查不到就会退回「下标当座位号」，
    // moveSeat 把自己的行写去错误的房间座位（占座冲突 / 房主端伪冒丢弃 / 插错位）。
    // 配对规则：未占的显示下标升序 ↔ 未被快照玩家占用的房间座位升序，逐一配对。
    const occupiedRoom = {};
    Object.keys(remapS).forEach(r => { occupiedRoom[Number(r)] = true; });
    const freeRoomSeats = [];
    for (let rs = 0; rs < this.maxSeats; rs++) if (!occupiedRoom[rs]) freeRoomSeats.push(rs);
    const takenLocal = {};
    Object.keys(this._localToRoom).forEach(l => { takenLocal[Number(l)] = true; });
    let freeIdx = 0;
    for (let ls = 0; ls < this.maxSeats && freeIdx < freeRoomSeats.length; ls++) {
      if (!takenLocal[ls]) this._localToRoom[ls] = freeRoomSeats[freeIdx++];
    }
    const list = (st.readyList || [])
      .map(x => Object.assign({}, x, { seat: remapS[Number(x.seat)] !== undefined ? remapS[Number(x.seat)] : -1 }))
      .filter(x => x.seat >= 0);
    // G6 的 _endHoles 缓存已随「看全桌牌」入口（2026-10-17）撤销退役：房主不再
    // 透传 endHoles，镜像端不再消费——这里只清引用防旧字段残留。
    this._endHoles = null;
    this._endHoleHandNo = null;
    const myEntry = list.filter(x => Number(x.seat) === 0)[0];
    // 房主已离开结算阶段（进入就绪 / 结算清空）→ 收起本地结算弹窗
    const hostLeftResult = st.readyPhase || !snap.result;
    if (hostLeftResult) this.clearResultModalTimer();
    const patch = {
      phase: 'playing',
      remoteMode: true,
      readyPhase: !!st.readyPhase,
      readyList: list,
      myReady: !!(myEntry && myEntry.ready),
      readyLeft: st.readyLeft || 0,
      readyHint: st.readyHint || '',
      summary: st.summary || null,
      timeUp: !!st.summary,
      // 房主挂起（到点但本手仍在打）：镜像端同样显示「本手后」，
      // 否则好友端倒计时停在 00:00 会误以为断线/卡死
      clockPendingEnd: !st.summary && st.clockPendingEnd === true
    };
    if (hostLeftResult && this.data.resultModal) patch.resultModal = null;
    // 表情镜像（设计 §1）：房主广播的 emotes 按「我=0 号位」重映射后冒泡。
    // 只放最近 1.5s 内的（EMOTE_PLAY_WINDOW_MS）——表情是瞬时氛围，靠本端
    // bornAt 兜底消散，不重放历史（断线重连同理不补历史表情）。
    // 以「座次重映射」换算 seat：与 readyList 同一套 remapS。
    const freshEmotes = [];
    ((st.emotes) || []).forEach(e => {
      if (!e || EMOTE_SET.indexOf(e.emoji) < 0) return;
      const localSeat = remapS[Number(e.seat)];
      if (localSeat === undefined) return;
      if (e.bornAt && Date.now() - e.bornAt > EMOTE_BUBBLE_MS + EMOTE_PLAY_WINDOW_MS) return;
      freshEmotes.push({ seat: localSeat, emoji: e.emoji, bornAt: Date.now(), key: 'r' + (++flySeed) });
    });
    if (freshEmotes.length) {
      // 同座位去重（房主端可能同座位连发被截断成多条）：保留最新一条
      const seen = {};
      const merged = (this.data.emotes || []).slice();
      freshEmotes.reverse().forEach(e => {
        if (seen[e.seat]) return;
        seen[e.seat] = true;
        const idx = merged.findIndex(x => x.seat === e.seat);
        if (idx >= 0) merged.splice(idx, 1);
        merged.push(e);
      });
      patch.emotes = merged;
    }
    // 快捷语镜像（设计 §2.4）：房主广播的 chats 按座次重映射后进聊天面板。
    // 只回放白名单内的好友快捷语/表情——系统消息（站起/入局/超时代弃）在镜像端由
    // 其自己的本地逻辑生成，不重复回放。以 chatLog 的 id 为去重键：已见过的 id 不再
    // 追加，避免 1.5s 轮询反复重放同一条（与 emote 的 bornAt 窗口同理防重放）。
    const freshChats = [];
    const seenChatIds = this._seenChatIds || (this._seenChatIds = {});
    ((st.chats) || []).forEach(c => {
      if (!c || CHAT_TEXT_SET.indexOf(c.text) < 0) return;   // 只回放白名单快捷语
      const localSeat = remapS[Number(c.seat)];
      if (localSeat === undefined) return;
      if (c.id && seenChatIds[c.id]) return;                  // 同一条不重放
      freshChats.push({ id: c.id, seat: localSeat, name: '', text: c.text });
      if (c.id) seenChatIds[c.id] = true;
    });
    if (freshChats.length) {
      const merged = (this.data.chatLog || []).slice();
      freshChats.forEach(c => {
        const p = game.seatOf(c.seat);
        merged.push({ id: ++this.chatSeq, seat: c.seat, name: p ? p.name : '', text: c.text });
      });
      while (merged.length > 8) merged.shift();
      patch.chatLog = merged;
    }
    // #14 批二：镜像端动作文案——从快照 diff 推断（零广播成本：不新增上行/
    // 快照字段，房主端也无需广播 actText）。必须在指纹 return **之前**写入并
    // 递增 _actEpoch：diff 的源字段（bet/folded/allIn/actionSeat）全在
    // _lastRemoteFp 内，真有动作时指纹必不同；但渲染指纹不含 actionSeat，
    // 不带令牌的话「过牌」类 diff（bet 不变）会被渲染指纹跳过分支吞掉。
    // 宁空不错：判不准的动作不发文案。
    this._mirrorDiffActs(snap);
    // 脏检查（评审 2026-10-15 MEDIUM「镜像端每 1.5s 全量 setData 无脏检查」）：
    // 好友端 1.5s 轮询拿到房主快照；若牌局实质未变，loadSnapshot 后渲染出的 patch
    // 与上一帧逐字段相同——整帧 setData 纯属空转，触发全量 diff/重绘、低端机掉帧。
    // 以快照的关键牌桌字段拼出指纹，与上一帧比对：未变则跳过 setData + render。
    // 牌桌外字段（就绪名单/结算/计时/表情/快捷语）变化照常更新——指纹覆盖它们，不会被吞。
    const fp = [
      snap.handNo, snap.street, snap.currentBet, snap.pot, snap.actionSeat,
      snap.sb, snap.bb,   // 批④：房主涨盲后快照 sb/bb 变化，镜像端盲注展示需重绘
      snap.boardCodes.join(','),
      (snap.players || []).map(p => p.seat + ':' + p.stack + ':' + p.bet + ':' +
        (p.folded ? 1 : 0) + (p.allIn ? 1 : 0) + (p.sittingOut ? 1 : 0)).join('|'),
      !!st.readyPhase, (st.readyList || []).map(x => x.seat + (x.ready ? 1 : 0)).join(','),
      st.readyLeft, st.readyHint, JSON.stringify(st.summary || null),
      st.clockPendingEnd ? 'cp' : '',
      snap.result ? 'r' + JSON.stringify(snap.result.winners) : '',
      (snap.reveal && JSON.stringify(snap.reveal)) || '',
      (patch.emotes ? 'e' + patch.emotes.map(x => x.seat + x.emoji + x.bornAt).join('|') : ''),
      (patch.chatLog ? 'c' + patch.chatLog.map(x => x.id + ':' + x.seat + ':' + (x.text || '')).join('|') : '')
    ].join('#');
    if (this._lastRemoteFp === fp) return;
    this._lastRemoteFp = fp;
    // 批④：房主涨盲后快照 sb/bb 已变，镜像端盲注级展示跟随更新（兜底 10/20）
    patch.blindLevel = snap.bb || 20;
    patch.blindText = this.fmtBlind(snap.sb || Math.round((snap.bb || 20) / 2) || 10, snap.bb || 20);
    this.setData(patch);
    this.render();
    // 镜像端不驱动引擎：若轮到我，只起本地计时环做视觉反馈
    if (game.actionSeat === 0 && !game.result) this.startTimer();
  },

  /**
   * #14 批二：镜像端动作文案推断。好友端 1.5s 轮询只有快照可看（引擎在房主
   * 机），旧实现完全没有对手动作文案——好友桌的「下注过程」只有 bet 数字在变。
   * 这里比对相邻两帧快照推断每人做了什么，写进 _lastActMap 补齐过程语义。
   * 纯函数 diffActLabels 便于单测；调用侧只做 map 维护与基线更新。
   * 已知粒度损失：1.5s 轮询可能合并两次动作（A 下注→B 加注同帧抵达），
   * 只能标终态（A 跟注 B 加注）——标签仍为真，只是丢失中间过程，可接受。
   */
  _mirrorDiffActs(snap) {
    const prev = this._remotePrev;
    const players = (snap.players || []).map(p => ({
      seat: p.seat, bet: p.bet, folded: !!p.folded, allIn: !!p.allIn
    }));
    const next = {
      handNo: snap.handNo,
      actionSeat: snap.actionSeat,
      bets: {}, folded: {}, allIn: {}
    };
    players.forEach(p => {
      next.bets[p.seat] = p.bet;
      next.folded[p.seat] = p.folded;
      next.allIn[p.seat] = p.allIn;
    });
    this._remotePrev = next;
    if (!prev || prev.handNo !== snap.handNo) return;   // 首帧/跨手：只建基线不推断
    if (snap.result) return;                            // 结算帧只做归池（bet 清零），不误标
    const acts = this.diffActLabels(prev, players, snap.currentBet);
    if (!acts.length) return;
    acts.forEach(a => {
      if (a.text) {
        this._lastActMap[a.seat] = { text: a.text, cls: a.cls };
        this._actEpoch++;
      }
    });
  },

  /** _mirrorDiffActs 的纯推断核心（可单测）。返回 [{seat, text, cls}]。 */
  diffActLabels(prev, players, currentBet) {
    const out = [];
    players.forEach(p => {
      const beforeBet = Number(prev.bets[p.seat]);
      const wasFolded = !!prev.folded[p.seat];
      const wasAllIn = !!prev.allIn[p.seat];
      if (!wasFolded && p.folded) {
        out.push({ seat: p.seat, text: '弃牌', cls: 'act-f' });
        return;
      }
      if (!wasAllIn && p.allIn) {
        out.push({ seat: p.seat, text: '全下', cls: 'act-a' });
        return;
      }
      if (p.bet > beforeBet) {
        if (p.bet >= currentBet) {
          // += 到达当前注：增前街内有注是加注，无注是首个下注（与 actLabel 同口径）
          const verb = beforeBet > 0 ? '加注 ' : '下注 ';
          out.push({ seat: p.seat, text: verb + p.bet, cls: 'act-r' });
        } else {
          out.push({ seat: p.seat, text: '跟注', cls: '' });
        }
      } else if (p.bet === beforeBet && p.seat === prev.actionSeat &&
                 currentBet === p.bet) {
        // bet 不变且该座位上一帧持有行动权且注 = 街内最高注 → 过牌。
        // 附 currentBet===p.bet 防 preflop 盲注位被误标（盲注推入后 bet=currentBet
        // 但从不是他的主动动作……严格说盲注位 actionSeat afterEach 会离开，正常
        // 帧序下不会命中；此判据宁空不错，边角漏标不误导）。
        out.push({ seat: p.seat, text: '过牌', cls: '' });
      }
    });
    return out;
  },

  // ---------- 牌局快照：中途退出后可重新进入续局 ----------

  /** 存快照：座位、剩余筹码、第几手、上一手庄位（仅房主侧，续局用） */
  saveSnapshot() {
    if (this.mode !== 'friend' || !this.isOwner || !this.roomNo || this.data.phase !== 'playing' || !game) return;
    snapshot.save(this.roomNo, {
      handNo: game.handNo,
      dealerSeat: this.prevDealerSeat,
      startStacks: this.startStacks,   // 盈亏口径跟随续局保持连续
      remainSec: this.data.remainSec,  // 倒计时剩余时间，续局接着倒数
      standing: this.myStanding,   // 续局时保留「已站起观战」状态
      pendingSit: this.pendingSit, // 续局时保留「已坐下、下一手入局」状态
      // 盲注级（批④涨盲）：续局沿用当前 sb/bb，涨盲后不退回默认 10/20
      sb: game.sb, bb: game.bb,
      blindIntervalMin: this.blindIntervalMin,   // 续局恢复涨盲定时器（URL 不带 blind 时兜底）
      seats: game.players.map(p => ({
        seat: p.seat, name: p.name, stack: p.stack, isMe: !!p.isHuman, style: p.style
      }))
    });
  },

  clearSnapshot() {
    snapshot.clear(this.roomNo);
  },

  /**
   * 续局恢复入口（onLoad 调用）：有快照时弹确认，用户选「恢复」才 restoreRoom，
   * 选「重新开始」则清快照进等待室。无快照返回 false 由调用方走 initWaiting。
   * 返回 true 表示已处理（无论恢复还是重开），返回 false 表示无快照、调用方自行 initWaiting。
   */
  promptRestore() {
    if (this.mode !== 'friend' || !this.roomNo || !this.isOwner) return false;
    const snap = snapshot.load(this.roomNo);
    if (!snap) return false;
    wx.showModal({
      title: '继续上一局？',
      content: '你在第 ' + snap.handNo + ' 手退出，筹码与座位已保留，可继续或重新开局。',
      confirmText: '继续',
      cancelText: '重开',
      success: res => {
        if (res.confirm) {
          // 用户选择继续：恢复牌局（失败则回退等待室）
          if (!this.restoreRoom()) this.initWaiting();
        } else {
          // 用户选择重开：清掉旧快照，进等待室
          this.clearSnapshot();
          this.initWaiting();
        }
      }
    });
    return true;
  },

  /**
   * 重新进入房间时恢复牌局：用快照里的座位与筹码重建牌桌，重发当前这一手。
   * 仅房主侧生效（访客本地无该房间的牌局数据）。
   */
  restoreRoom() {
    if (this.mode !== 'friend' || !this.roomNo || !this.isOwner) return false;
    const snap = snapshot.load(this.roomNo);
    if (!snap) return false;
    this.myStanding = !!snap.standing;   // 站起观战状态随续局恢复
    this.pendingSit = !!snap.pendingSit; // 「已坐下待入局」状态随续局恢复

    const players = snap.seats.map(s => ({
      id: s.isMe ? 'me' : 'p' + s.seat,
      // 续局：我的名字始终用当前昵称（快照里存的是上一局的名字，可能已改过）
      name: s.isMe ? auth.myName('你') : (s.name || '玩家'),
      seat: s.seat,
      stack: s.stack > 0 ? s.stack : 1000,
      isHuman: !!s.isMe,
      style: s.style || { aggro: 0.5, tight: 0.35 }
    }));
    this.setData({ phase: 'playing' });
    try {
      const started = this.initGame(players, snap);
      if (!started || !game || !game.handNo) throw new Error('engine not started');
    } catch (e) {
      // 续局失败（快照损坏/引擎异常）：清掉快照回到等待室，绝不无声卡死
      console.error('[table] 续局失败，回退等待室', JSON.stringify({
        stage: 'restore-room', message: e && e.message, stack: e && e.stack
      }));
      game = null;
      this.clearSnapshot();
      this.initWaiting();
      wx.showToast({ title: '续局失败，请重新开局', icon: 'none' });
      return true;
    }
    this.startClock(snap.remainSec);   // 倒计时接着上次剩余时间继续
    // ⚠️ 中断的那一手无法精确续上（快照不含逐街状态，重发必然换牌）。直接开
    // 下一手：handNo 变化会让好友端【重载快照、重新取得行动权】；否则重发同一
    // handNo（actionSeat/currentBet 也相同），好友端指纹不变会跳过重载，仍以为
    // 「我已经行动过」→ 房主死等好友行动（真机 2026-10-20「退出重进不能继续」）。
    // 语义也自洽：那一手已作废，从下一手接着打。
    try {
      this.startHand();
    } catch (e) {
      console.error('[table] 续局开下一手失败', JSON.stringify({
        stage: 'restore-next-hand', room: this.roomNo, message: e && e.message
      }));
    }
    this.forcePublish();   // 立即广播新手牌（穿透节流），好友端马上重载
    wx.showToast({ title: '已回到房间 · 从第 ' + ((snap.handNo || 1) + 1) + ' 手继续', icon: 'none' });
    return true;
  },

  /**
   * 启动/重置空闲销毁倒计时（仅好友房、房间号存在时生效）。
   * 30 分钟到点销毁；提前 5 分钟逐秒显示「X 后自动解散」，让房主有时间拉人，
   * 而不是到点突然被踢。两个计时器：expireTimer 管销毁，expireWarnTimer 管提示。
   */
  armExpire() {
    this.clearExpire();
    this.clearExpireWarn();
    if (this.mode === 'friend' && this.roomNo) {
      this._expireDeadline = Date.now() + ROOM_TTL_MS;
      expireWarnTimer = setTimeout(() => this.tickExpireWarn(), ROOM_TTL_MS - IDLE_WARN_MS);
      expireTimer = setTimeout(() => this.destroyRoom(), ROOM_TTL_MS);
    }
  },

  clearExpire() {
    if (expireTimer) { clearTimeout(expireTimer); expireTimer = null; }
  },

  /** 提前 5 分钟起逐秒刷新「X 后自动解散」倒计时文案 */
  tickExpireWarn() {
    if (!this.roomNo || this.data.phase !== 'waiting' || !this.isOwner) {
      this.setData({ idleRemainText: '' });
      return;
    }
    const left = Math.max(0, Math.round((expireTimer ? this._expireDeadline : 0) - Date.now()));
    if (left <= 0) {
      this.setData({ idleRemainText: '' });
      return;
    }
    this.setData({ idleRemainText: this.fmtRemain(Math.round(left / 1000)) + ' 后自动解散' });
    expireWarnTimer = setTimeout(() => this.tickExpireWarn(), 1000);
  },

  clearExpireWarn() {
    if (expireWarnTimer) { clearTimeout(expireWarnTimer); expireWarnTimer = null; }
    this.setData({ idleRemainText: '' });
  },

  /** 超时无人加入：关闭云端房间并退到首页 */
  destroyRoom() {
    if (this.data.phase !== 'waiting') return;
    this.roomClosed = true;
    this.clearExpire();
    this.clearExpireWarn();
    this.clearClock();
    if (this.roomNo) {
      auth.closeRoom(this.roomNo).catch(e => console.error('[table] 离房清理失败',
        JSON.stringify({ stage: 'destroyRoom', room: this.roomNo, err: e && e.message })));   // 销毁云端房间，不影响本地退出
    }
    wx.showToast({ title: '房间超时已自动解散', icon: 'none' });
    this.onBack();
  },

  /** 房主添加电脑玩家，模拟好友进入并坐下。
   *  等待室：直接占 waitSeats 空位 + 广播 waiting 布局。
   *  进行中（好友房房主）：走 pendingBotSeat 下一手插入，与 AI/SNG 点空位补 bot
   *  同一套 applyPendingSeats ③ 落位口径——插入后随下一手 startHand 的
   *  forcePublish 广播，镜像端 loadSnapshot 重映射自动容纳新座位。为何好友房
   *  需要这个：好友人数不够时房主可中途补 bot 凑桌，不必退回等待室。 */
  addBot() {
    if (!this.isOwner) {
      wx.showToast({ title: '仅房主可添加玩家', icon: 'none' });
      return;
    }
    // 进行中：好友房房主中途补 bot（pendingBotSeat → 下一手 applyPendingSeats ③ 插入）
    if (this.data.phase === 'playing' && this.mode === 'friend' && !this.remoteMode && game) {
      // 找空位：maxSeats 范围内未被 game.players 占用的座位（含 sittingOut 者仍占座）
      const occupied = {};
      game.players.forEach(p => { occupied[p.seat] = true; });
      let seat = -1;
      for (let i = 0; i < this.maxSeats; i++) {
        if (!occupied[i]) { seat = i; break; }
      }
      if (seat < 0) { wx.showToast({ title: '房间已满', icon: 'none' }); return; }
      this.pendingBotSeat = seat;
      wx.showToast({ title: '下一手安排电脑玩家入座', icon: 'none' });
      return;
    }
    if (this.data.phase !== 'waiting') return;
    const seats = this.data.waitSeats.slice();
    if (seats.filter(s => s.occupied).length >= this.maxSeats) {
      wx.showToast({ title: '已达限定人数', icon: 'none' }); return;
    }
    const empty = seats.find(s => !s.occupied);
    if (!empty) { wx.showToast({ title: '房间已满', icon: 'none' }); return; }
    const botNo = seats.filter(s => s.isBot).length + 1;
    empty.occupied = true;
    empty.isBot = true;
    // 好友房沿用「好友N」（等真人来了换号的占位叫法）；AI 桌用预设对手名
    empty.name = this.botLabel(botNo - 1);
    // ⚠️ SNG 淘汰赛全员同起点（buyInOf → 2000）：空位初始 stack=0，若这里
    // 回落 DEFAULT_BUY_IN(1000) 就会出现「我 2000、电脑 1000」的不公平开局
    // （与 sitSeat/fillBots/fillBotsTo 的 buyInOf 口径对齐）。
    empty.stack = buyInOf(this.mode, Number(empty.stack));
    const occupiedCount = seats.filter(s => s.occupied).length;
    this.setData({
      waitSeats: seats,
      seats: this.buildWaitSeats(seats),
      canStart: this.canStartOf(seats)
    });
    // 第一位好友坐下 → 房间「有人进去了」，取消自动销毁
    if (occupiedCount >= 2) this.clearExpire();
    this.publishWait();   // 广播机器人布局，好友端同步可见
  },

  /** 房主请出某个电脑玩家（腾出空位）。
   *  等待室：直接清 waitSeats 占位 + 广播。
   *  进行中（好友房房主、非镜像）：走 pendingKickBots 下一手移出，与补 bot
   *  对称。不立即踢——当前手可能正轮到该 bot 行动，中途抽走会冻结牌局；
   *  下一手 startHand 前落位，引擎按剩余 players 重算按钮轮转，安全。 */
  kickBot(e) {
    if (!this.isOwner) return;
    const seat = Number(e.currentTarget.dataset.seat);
    if (isNaN(seat)) return;
    // 进行中：好友房房主走 pendingKickBots 下一手移出（镜像端 isOwner 恒 false，被拦）
    if (this.data.phase === 'playing' && this.mode === 'friend' && !this.remoteMode && game) {
      const p = game.seatOf(seat);
      if (!p || !this.botSeats[seat]) {
        wx.showToast({ title: '只能请出电脑玩家', icon: 'none' }); return;
      }
      this.pendingKickBots[seat] = true;
      wx.showToast({ title: '下一手请出该电脑玩家', icon: 'none' });
      return;
    }
    if (this.data.phase !== 'waiting') return;
    const seats = this.data.waitSeats.slice();
    const t = seats.find(s => s.seat === seat);
    if (!t || !t.isBot) return;
    t.occupied = false;
    t.isBot = false;
    t.name = '';
    // 重命名现有 bot：必须**去重**（9 人桌 8 个 bot，旧实现 idx%5 会重名）。
    const botNames = this.botNamesFor(seats.filter(s => s.isBot).length);
    let n = 0;
    seats.forEach(s => { if (s.isBot) s.name = botNames[n++]; });
    const occupiedCount = seats.filter(s => s.occupied).length;
    this.setData({
      waitSeats: seats,
      seats: this.buildWaitSeats(seats),
      canStart: this.canStartOf(seats)
    });
    this.publishWait();
  },

  /** 电脑玩家的名字：AI 桌用预设对手名，好友房叫「好友N」 */
  botLabel(idx) {
    return this.mode === 'friend' ? ('好友' + (idx + 1)) : BOT_NAMES[idx % BOT_NAMES.length];
  },

  /** 给一批 bot 分配**互不重名**的名字（2026-10-22 用户：9 人桌 8 个电脑玩家重名）。
   *  按序号取池内名字；已用过则追加 2/3… 兜底（即使未来 BOT_NAMES 又被缩到
   *  比 bot 数少，也不会出现同名）。返回数组，长度 = count。 */
  botNamesFor(count) {
    const n = Math.max(0, Number(count) || 0);
    const used = {};
    const out = [];
    for (let i = 0; i < n; i++) {
      const base = BOT_NAMES[i % BOT_NAMES.length];
      let name = base;
      let k = 2;
      while (used[name]) { name = base + k; k++; }
      used[name] = true;
      out.push(name);
    }
    return out;
  },

  /** 复制房间号 */
  copyRoom() {
    wx.setClipboardData({
      data: this.roomNo,
      success: () => wx.showToast({ title: '房间号已复制', icon: 'success' })
    });
  },

  /**
   * 顶栏返回：
   *  - 牌局进行中 → 二次确认（按钮文案 ≤4 字，真机限制），确认后存快照离开，房间保留；
   *  - 等待室      → 房主空等放弃则关闭房间，访客离开不影响房间。
   */
  onBack() {
    if (this.mode === 'friend' && this.data.phase === 'playing') {
      wx.showModal({
        title: '退出房间？',
        content: '房间会保留，可从首页「我的房间」重新进入；若只是不想打这一局，点「站起退出本局」即可留在房间内',
        confirmText: '退出',
        cancelText: '留下',
        success: res => { if (res.confirm) this.leaveRoom(); },
        fail: () => this.leaveRoom()   // 弹窗异常时兜底离开，避免卡死在牌桌
      });
      return;
    }
    this.leaveRoom();
  },

  /** 真正离开页面：正常导航栈直接返回；分享卡片冷启动进桌时栈为空，兜底回首页 */
  leaveRoom() {
    if (this.mode === 'friend') {
      if (this.data.phase === 'waiting') {
        // 房主空等（无人加入）离开 → 视为放弃房间，关闭云端房间清理残留
        const cnt = this.data.waitSeats.filter(s => s.occupied).length;
        if (this.isOwner && !this.roomClosed && cnt <= 1 && this.roomNo) {
          this.roomClosed = true;
          auth.closeRoom(this.roomNo).catch(e => console.error('[table] 离房清理失败',
            JSON.stringify({ stage: 'leaveRoom-wait', room: this.roomNo, err: e && e.message })));
          this.clearSnapshot();
        }
      } else {
        this.saveSnapshot();   // 牌局进行中离开：暂存本地快照，云端房间保持 active
      }
      // 离房释放自己的座位行。
      // 【修复】原先只对访客删行，房主保留——但房主从邀请链接重进时会被判成访客，
      // 于是「房主的行」与「新访客的行」同时存在 → 同一人占两个座位，
      // 表现为牌桌上出现两个自己。改为所有人都删自己的行：
      // 房间本身（poker_rooms + 快照）不受影响，仍可重新进入续局。
      if (this.syncLive) {
        roomSync.leave(this.roomNo).catch(e => console.error('[table] 离房清理失败',
          JSON.stringify({ stage: 'leaveRoom-sync', room: this.roomNo, err: e && e.message })));
      }
      this.stopSync();
    }
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/index/index' })
    });
  },

  /**
   * 房主点开始：按已坐下座位构建玩家并发牌（访客无权限，只能等待）。
   * 防卡死三道闸：
   *   1) _starting 防抖：连点/异步间隙内重复触发只走一次；
   *   2) 组局来源兜底：云端布局异常（<2 人）时回退本地等待室布局；
   *   3) initGame 全程 try/catch：任何异常都回退等待室并提示，绝不无声卡死。
   */
  async startGame() {
    if (this.data.phase !== 'waiting') return;
    if (this._starting) return;
    if (!this.isOwner) {
      wx.showToast({ title: '等待房主开始', icon: 'none' });
      return;
    }
    this.clearExpire();   // 已开始对局，停止空闲销毁倒计时
    this.clearExpireWarn();  // 开局后隐藏空闲倒计时文案
    if (!this.data.canStart) {
      wx.showToast({ title: '至少 2 人才能开始', icon: 'none' });
      return;
    }
    this._starting = true;
    if (this.data.soundOn) sfx.play('click');
    try {
      // 开局前先拉一次最新座位布局（加机器人/好友入座后可能还没轮到轮询）
      if (this.syncLive) {
        try { await this.pollOnce(); } catch (e) { this.onSyncLost(); }
      }
      const toPlayer = (s) => {
        // AI 机器人绑定固定角色 style（按序号 → botProfiles.styleFor），
        // 取代旧 0.3+rand*0.5 随机——角色人格稳定，难度档位影响激进度梯度。
        // 真人 style 维持轻随机（仅 AI 桌「我」的教练提示不读 style，无影响）。
        let style;
        if (s.isBot) {
          // 按已入座 Bot 的序号绑定角色（同 botLabel 的计数口径：小于等于本座位的 Bot 数 - 1）
          const botSeq = Math.max(0, (this.data.waitSeats || []).filter(x => x.isBot && x.seat <= s.seat).length - 1);
          style = botProfiles.styleFor(botSeq, (this.mode === 'ai' || this.mode === 'sng') ? this.level : 'advanced');
        } else {
          style = { aggro: 0.3 + Math.random() * 0.5, tight: 0.25 + Math.random() * 0.45 };
        }
        return {
          id: s.isMe ? 'me' : (s.isBot ? 'bot' + s.seat : 'p' + s.seat),
          // 我的名字用微信昵称（好友端能看到）；他人沿用云端广播/等待室里的名字
          name: s.isMe ? (s.name || this.meLabel(false)) : (s.name || '玩家'),
          seat: s.seat,
          // 按各自买入额发筹码（未指定者回落到默认买入）
          stack: Number(s.stack) || DEFAULT_BUY_IN,
          isHuman: !s.isBot,     // 真人（含好友）的底牌进快照，供镜像端渲染
          style
        };
      };
      // 有跨设备同步时按云端布局组局（真人行 + 机器人）；否则用本地等待室布局
      let source = this.syncLive
        ? roomSync.buildWaitLayout(this.roomRows, this.hostState, this.maxSeats, this.roomSeat)
        : (this.data.waitSeats || []);
      // ⚠️ 权威端（房主/AI 桌）用本地等待室的电脑玩家补齐云端布局。
      //  房主点「添加电脑玩家」后 publishWait 是异步写云端的，而 hostState 要等
      //  下一次轮询才读得回新值；这中间若点「开始游戏」，云端布局里还没有这些
      //  bot → 它们被漏掉，开局人数比等待室少，极端时不足 2 人直接开不了局
      //  （真机 2026-10-17：「添加了电脑玩家却开不了，提示人数不足」）。
      //  只补 bot、只补云端布局里没有的座位；镜像端不参与（它以房主快照为准）。
      if (this.syncLive && !this.remoteMode) {
        const bySeat = {};
        source.forEach(s => { bySeat[Number(s.seat)] = s; });
        (this.data.waitSeats || []).forEach(s => {
          if (!s || !s.isBot || !s.occupied) return;
          // 注意 buildWaitLayout 返回的是「全部座位」（含未占用的空位对象），
          // 所以判据是「云端该座位未占用或不是 bot」，不是「该座位不存在」。
          const cur = bySeat[Number(s.seat)];
          if (!cur || !cur.occupied || !cur.isBot) bySeat[Number(s.seat)] = s;
        });
        source = Object.keys(bySeat).map(k => bySeat[k])
          .sort((a, b) => Number(a.seat) - Number(b.seat));
      }
      // 本人（房主 / AI·SNG 本人）尚未落座时，自动占第一个空位入局——
      // 否则会开成「自己观战 bot 互打」的畸形局：mePlayer 缺失使 mySeat 仍指向
      // game 里不存在的座位，就绪阶段 readyList 不含我，「准备就绪」按钮看似可点
      // 实则点了无反应（myReady 不变、无提示）。SNG 本就是本人参赛的淘汰赛，
      // 不该出现「本人不在局内」的开局（2026-10-18 复现：repro-sng-noseat.js）。
      // 好友房本人入座由云端 roomSync 保证，此处跳过。
      if (this.mode !== 'friend' && !source.some(s => s.isMe)) {
        const empty = source.find(s => !s.occupied);
        if (empty) {
          empty.occupied = true;
          empty.isMe = true;
          empty.isOwner = this.isOwner;
          empty.name = this.meLabel(this.isOwner);
          // 与 SNG 统一起点对齐（buyInOf：sng→2000，其余→选定的买入额）
          empty.stack = buyInOf(this.mode, this.buyInStack[empty.seat]);
          if (this.isOwner) { this.mySeat = empty.seat; this.roomSeat = empty.seat; }
        }
      }
      let players = source.filter(s => s.occupied).map(toPlayer);
      // 兜底：云端布局异常（如 state 残留 playing 导致机器人丢失）→ 用本地布局重试
      if (players.length < 2) {
        players = (this.data.waitSeats || []).filter(s => s.occupied).map(toPlayer);
      }
      if (players.length < 2) {
        wx.showToast({ title: '坐下的人数不足', icon: 'none' });
        return;   // 留在等待室，用户可继续加人
      }

      // 我的渲染座位必须与「me」玩家一致（换座后云端行滞后时防错位）
      const mePlayer = players.filter(p => p.id === 'me')[0];
      if (mePlayer) this.mySeat = mePlayer.seat;

      // 记录机器人座位：房主端不为它们等待上行，超时也不管
      this.botSeats = {};
      players.forEach(p => { if (p.id.indexOf('bot') === 0) this.botSeats[p.seat] = true; });
      this.pendingSitMap = {};
      this.pendingJoinMap = {};
      this.pendingMove = null;
      this.pendingJoin = null;
      this.pendingBotSeat = null;
      this.pendingKickBots = {};
      this.leftPlayers = [];     // 新一局：中途离场者的战绩留档从零开始

      // 批⑤：SNG 赛制初始化——淘汰名次从总人数倒数（第 N 名先淘汰），涨盲默认 3 分钟
      if (this.mode === 'sng') {
        this.sngPlacement = {};
        this.sngEliminationOrder = [];
        this.sngNextPlace = players.length;
        // SNG 天然涨盲：URL 已带 blind=3，此处兜底确保非 0
        if (!this.blindIntervalMin) this.blindIntervalMin = 3;
      }

      this.setData({ phase: 'playing' });
      let started = false;
      try {
        started = this.initGame(players);
      } catch (err) {
        console.error('[table] 开局异常，回退等待室', JSON.stringify({
          stage: 'start-game', message: err && err.message, stack: err && err.stack
        }));
      }
      if (!started || !game || !game.handNo) {
        game = null;
        this.setData({ phase: 'waiting' });
        this.renderWait();   // 恢复等待室座位环与操作条，用户可直接重试
        if (started === false) {
          wx.showToast({ title: '开局失败，请重试', icon: 'none' });
        }
        return;
      }
      this.startClock();   // 开始游戏才启动时长倒计时
      this.startBlindTimer();   // 批④：开局启动涨盲倒计时（blindIntervalMin=0 时 no-op）
      this.publishPlay();  // 立即广播，让好友进入镜像
    } finally {
      this._starting = false;
    }
  },

  /**
   * 涨盲定时器（批④）：每 blindIntervalMin 分钟 sb/bb 翻倍，逼迫僵局推进。
   * blindIntervalMin=0（默认）不涨盲，保持现行为。翻倍后穿透两道脏检查指纹
   * （_lastPlayFp / _lastRenderFp 置 null），setData blindLevel/blindText，
   * 播 blind 音色 + toast 提示。房主端权威，好友端经 writePlayState 透传的
   * 快照 sb/bb 在 enterRemote 恢复（500ms 延迟可接受，盲注非实时操作）。
   */
  startBlindTimer() {
    this.clearBlindTimer();
    if (!this.blindIntervalMin || !game) return;
    const ms = this.blindIntervalMin * 60 * 1000;
    // B2 封顶基准：以引擎当前 bb 为「初始 bb」（startBlindTimer 只在开局调一次，
    // 此刻 game.bb 即本局起始盲注级；续局恢复的房间以恢复级为基准）。
    this._bbCap = bbCapOf(game ? game.bb : 20);
    this._bbCapToastShown = false;
    blindTimer = setInterval(() => {
      if (!game || game.result) return;
      // B2（2026-10-17）：封顶后不再翻倍。到达下一次翻倍就超 cap 时先钳到 cap，
      // 完全到顶则静默（提示只播一次，见 _bbCapToastShown）。
      const nextBb = game.bb * 2;
      if (nextBb > this._bbCap) {
        if (nextBb !== game.bb && game.bb < this._bbCap) {
          // 半路截断：bb 还没到 cap，但翻倍会跳过 cap → 钳到 cap
          game.sb = this._bbCap / 2;
          game.bb = this._bbCap;
          game.minRaise = game.bb;
          this._lastPlayFp = null;
          this._lastRenderFp = null;
          this.setData({
            blindLevel: game.bb,
            blindText: this.fmtBlind(game.sb, game.bb)
          });
          if (this.data.soundOn) sfx.play('blind');
          wx.showToast({ title: '盲注已达本房封顶 ' + this.fmtBlind(game.sb, game.bb), icon: 'none' });
          this._bbCapToastShown = true;
        } else if (!this._bbCapToastShown) {
          // 已在封顶：只提示一次
          wx.showToast({ title: '盲注已达本房封顶', icon: 'none' });
          this._bbCapToastShown = true;
        }
        return;
      }
      // 翻倍 sb/bb（引擎下一手 postBlind 自然取新值，不新增引擎字段）
      game.sb = game.sb * 2;
      game.bb = game.bb * 2;
      game.minRaise = game.bb;   // minRaise 跟随大盲
      // 穿透两道指纹：盲注级变化必须进 setData 与写库，否则跳过分支吞掉
      this._lastPlayFp = null;
      this._lastRenderFp = null;
      this.setData({
        blindLevel: game.bb,
        blindText: this.fmtBlind(game.sb, game.bb)
      });
      if (this.data.soundOn) sfx.play('blind');
      wx.showToast({ title: '盲注涨至 ' + this.fmtBlind(game.sb, game.bb), icon: 'none' });
      // 房主端：随下一帧 writePlayState 透传广播给好友（不加专门广播）
    }, ms);
  },

  clearBlindTimer() {
    if (blindTimer) { clearInterval(blindTimer); blindTimer = null; }
  },

  /** 盲注级文案：sb/bb →「10/20」 */
  fmtBlind(sb, bb) {
    return Math.round(sb) + '/' + Math.round(bb);
  },

  /**
   * 筹码量紧凑文案（#14 批一）：座位环/myzone 共用。
   * 一万以下原样显示；一万以上折「X.X万」（去尾零：2.5万 / 1万）——
   * 补筹封顶 5000 的常规局只在好友房堆大额时才触发，座位卡 104rpx 宽
   * 撑不下 6 位数字。非数字/空原样返回（空位 stack='' 的 wx:if 语义保持）。
   */
  fmtStack(n) {
    if (typeof n !== 'number' || !isFinite(n)) return n;
    if (Math.abs(n) < 10000) return String(n);
    const wan = Math.round(n / 1000) / 10;   // 万位保留 1 位小数
    return (wan % 1 === 0 ? String(Math.round(wan)) : String(wan)) + '万';
  },

  /**
   * 游戏时长倒计时：到点自动结束本局并统计盈亏（0 = 不限时，不启动）
   * @param {number} [fromSec] 续局时传入剩余秒数，接着上次继续倒数
   */
  startClock(fromSec) {
    this.clearClock();
    if (!this.durationMin) {
      this.setData({ timeUp: false, remainSec: 0, remainText: '' });
      return;
    }
    let left = (typeof fromSec === 'number' && fromSec > 0) ? fromSec : this.durationMin * 60;
    if (left <= 0) {
      this.setData({ timeUp: true, remainSec: 0, remainText: '00:00' });
      return;
    }
    // 续局从断点恢复时，若已过最后 1 分钟阈值则不再补播钟音
    this.sfxClockWarned = left <= 60;
    this.setData({ timeUp: false, remainSec: left, remainText: this.fmtRemain(left) });
    this.pendingTimeUp = false;   // 新一轮（或续局恢复）清掉上一轮的「到点挂起」标记
    clock = setInterval(() => {
      left--;
      if (left <= 0) {
        this.clearClock();
        this.onClockExpired();
        return;
      }
      // 限时局最后 1 分钟：与 UI 变橙（remainSec <= 60）同阈值，钟音一声
      if (left === 60 && !this.sfxClockWarned) {
        this.sfxClockWarned = true;
        if (this.data.soundOn) sfx.play('clock');
      }
      this.setData({ remainSec: left, remainText: this.fmtRemain(left) });
    }, 1000);
  },

  clearClock() {
    if (clock) { clearInterval(clock); clock = null; }
  },

  /** 剩余秒 → mm:ss（超过 1 小时显示 h:mm:ss） */
  fmtRemain(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const mm = String(m).padStart(2, '0');
    const sss = String(ss).padStart(2, '0');
    return h > 0 ? (h + ':' + mm + ':' + sss) : (mm + ':' + sss);
  },

  /**
   * 时长到点。
   *
   * 关键规则（用户 2026-10-16 反馈）：到点时若**本手还在打**，不能直接把牌局掀了——
   * 玩家看到的是「两手打到一半突然 game over，筹码悬在半路」，无法接受。
   * 正确做法是「打完这一手再总结束」：
   *   - 不在打牌中（等待室/就绪阶段/本手已结算）→ 立即结束；
   *   - 正在打牌 → 置 pendingTimeUp 标记，等本手走完亮牌/结算流程，
   *     在 enterReadyPhase（每手唯一的收口）里再真正 endGame。
   *
   * pendingTimeUp 期间 UI 显示「本手结束后结束」，玩家知道还有多久。
   */
  onClockExpired() {
    const inPlay = !!(game && !game.result && this.data.phase === 'playing' && !this.data.readyPhase);
    if (!inPlay) { this.endGame(); return; }
    this.pendingTimeUp = true;
    this.setData({ remainSec: 0, remainText: '00:00', clockPendingEnd: true });
    this.render();
  },

  /**
   * 时长到点：结束本局，统计**所有参与过游戏的人**盈亏（当前筹码 − 起始筹码），
   * 按盈亏排名。中途站起/掉线离场者同样入单并标「中途离场」，每行带齐
   * 带入 / 剩余 / 盈亏，底部另有全员合计对账行。
   * 结束的是「这一局」，不是退出房间——房间仍在，可再来一局或返回。
   */
  endGame() {
    if (!game) return;
    // P1-6：结算单「打法画像」一行（仅 AI 对战且本机权威端，非镜像端）。
    // 数据源 = replayStore 全量（上限 20 局，analyze 内部 O(n) 扫描，开销可忽略）。
    // 样本 < 10 不硬算（analyze 自带 insufficient 态兜底，避免小样本误导）。
    let styleLine = '';
    if (this.mode === 'ai' && !this.remoteMode) {
      try {
        const res = styleAnalyzer.analyze(replayStore.listAll());
        if (res && !res.insufficient && (res.sample | 0) >= 10) {
          styleLine = '你的打法画像：' + res.quadrant + ' · VPIP ' + res.vpipPct +
            '（近 ' + res.sample + ' 手）';
        }
      } catch (e) { /* 失败静默，不阻断结算 */ }
    }
    // 批⑤重入防护：SNG 终局链路 _sngCheckFinalize → endGame → _sngCheckFinalize 会递归
    // （endGame 内调 _sngCheckFinalize 补齐存活者名次，补齐后又判 alive<=1 想再次 endGame）。
    // 用 _sngEnding 幂等位：进入即置位，_sngCheckFinalize 内见已置位则不再触发 endGame。
    if (this.mode === 'sng' && this._sngEnding) return;
    if (this.mode === 'sng') this._sngEnding = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    this.clearReadyClock();
    this.clearBlindTimer();   // 批④：本局结束停涨盲

    // 批⑤：SNG 淘汰赛——按淘汰顺序排名（名次升序，1=冠军在前），不按净值排序。
    // 终局可能由 _sngCheckFinalize 调入（存活者<=1），也可能由时长到点兜底。
    if (this.mode === 'sng') {
      this._sngCheckFinalize();   // 确保所有名次已记录（兜底补齐存活者名次）
      // 防御性合并 leftPlayers：让位离场者已移出 game.players，不合并则其从
      // SNG 结算单蒸发；且「我」被让位时 me 取不到会误判 isChampion=true。
      // 名次从 sngPlacement 取，未记录者（离场早于淘汰记录）兜底末位。
      // 末位名次 = 在场人数 + 已离场无名次人数（本手局内总参与者），不能只取
      // game.players.length——那会把离场者排到「第 N 名」而不是「第 N+k 名」。
      const fallbackPlace = game.players.length + (this.leftPlayers || [])
        .filter(p => this.sngPlacement[p.seat] == null).length;
      const rows = (this.leftPlayers || []).map(p => ({
        seat: p.seat,
        name: p.name,
        stack: p.stack,
        buyIn: p.buyIn,
        net: p.stack - p.buyIn,
        place: this.sngPlacement[p.seat] != null ? this.sngPlacement[p.seat] : fallbackPlace,
        placeText: '第 ' + (this.sngPlacement[p.seat] != null ? this.sngPlacement[p.seat] : fallbackPlace) + ' 名',
        isMe: !!p.isHuman,
        left: true
      })).concat(game.players.map(p => ({
        seat: p.seat,
        name: p.name,
        stack: p.stack,
        buyIn: this.startStacks[p.seat] !== undefined ? this.startStacks[p.seat] : p.stack,
        net: p.stack - (this.startStacks[p.seat] !== undefined ? this.startStacks[p.seat] : p.stack),
        place: this.sngPlacement[p.seat] != null ? this.sngPlacement[p.seat] : 1,
        placeText: '第 ' + (this.sngPlacement[p.seat] != null ? this.sngPlacement[p.seat] : 1) + ' 名',
        isMe: !!p.isHuman
      }))).sort((a, b) => a.place - b.place);   // 名次升序：冠军在前
      const me = rows.filter(r => r.isMe)[0];
      const myPlace = me ? me.place : 1;
      const isChampion = myPlace === 1;
      // SNG 结算单存档（复盘页可回看）：结算弹窗一闪而过 / 被「再来一局」盖掉时，
      // 玩家仍能在「战绩 → 最近 SNG」里查到带入/剩余/盈亏/名次。
      const sngSummary = {
        id: Date.now(),
        ts: Date.now(),
        mode: this.mode,
        roomNo: this.roomNo || '',
        handNo: game.handNo,
        title: isChampion ? 'SNG 结束 · 恭喜夺冠！' : 'SNG 结束 · 淘汰赛结算',
        sub: '共 ' + game.handNo + ' 手 · 按淘汰顺序排名',
        rows: rows.map(r => ({
          seat: r.seat, name: r.name, place: r.place, placeText: r.placeText,
          buyIn: r.buyIn, stack: r.stack, net: r.net, isMe: !!r.isMe, left: !!r.left
        })),
        myPlace: myPlace,
        myPlaceText: '第 ' + myPlace + ' 名',
        myNet: me ? me.net : 0,
        myNetText: me ? ((me.net >= 0 ? '+' : '') + me.net) : '0',
        myBuyIn: me ? me.buyIn : 0,
        myStack: me ? me.stack : 0
      };
      sngStore.save(sngSummary);
      // 注：曾设想「好友房 SNG 同步一份 sng-summary 到云端复盘」，但 mode==='sng'
      // 蕴含 opts.room 为空（onLoad 里 room 优先分派 'friend'），roomNo 恒为 ''，
      // 该云同步分支不可达，已删除——SNG 是纯本地赛制，结算单只进本地 sngStore。
      this.setData({
        timeUp: true,
        clockPendingEnd: false,
        isMyTurn: false,
        legal: null,
        readyPhase: false,
        readyList: [],
        myReady: false,
        readyLeft: 0,
        readyHint: '',
        sng: true,    // 批⑤：WXML summary-row 内的 wx:for 作用域需用顶层字段判断 SNG
        summary: {
          title: isChampion ? 'SNG 结束 · 恭喜夺冠！' : 'SNG 结束 · 淘汰赛结算',
          sub: '共 ' + game.handNo + ' 手 · 按淘汰顺序排名',
          styleLine: styleLine,   // P1-6：打法画像一行（无样本时空串，wxml wx:if 隐藏）
          rows: rows,
          isSng: true,    // WXML 按此切换「名次」列而非「盈亏」列
          myPlace: myPlace,
          myPlaceText: '第 ' + myPlace + ' 名',
          myNet: me ? me.net : 0,
          myNetText: me ? ((me.net >= 0 ? '+' : '') + me.net) : '0',
          myBuyIn: me ? me.buyIn : 0,
          myStack: me ? me.stack : 0
        }
      });
      // 战绩记录
      const meP = game.seatOf(this.mySeat);
      if (meP) {
        this.pendingRecord = {
          tableId: 'sng',
          handNo: game.handNo,
          seat: this.mySeat,
          hole: meP.hole.map(c => P.cardToCode(c)).join(' '),
          board: game.board.map(c => P.cardToCode(c)).join(' '),
          handType: isChampion ? 'SNG夺冠' : ('SNG第' + myPlace + '名'),
          net: me ? me.net : 0,
          won: isChampion
        };
        this.uploadRecord();
      }
      return;
    }

    // 全员统计（用户 2026-10-16 反馈）：结算单必须覆盖**所有参与过游戏的人**，
    // 包括中途站起离场、掉线自动站起、站起后未再入局者——引擎的 game.players
    // 始终保留这些座位（站起只置 sittingOut，筹码原样保留），所以逐人遍历即可
    // 全覆盖；中途离场的人额外打 left 标记，结算单上可见「中途离场」。
    // 每行带齐「带入 / 剩余 / 盈亏」三件套，另有全员合计（total）供对账。
    // 让位离场者（座位被新来的人顶替）已移出 game.players，账却要继续记：
    // 他们打过的那些手若直接从结算单消失，全桌合计盈亏就对不上。
    // 与在座者合并统计，统一标「中途离场」。
    const rows = (this.leftPlayers || []).map(p => ({
      seat: p.seat, name: p.name, stack: p.stack, buyIn: p.buyIn,
      net: p.stack - p.buyIn, isMe: !!p.isHuman, left: true
    })).concat(game.players.map(p => {
      // 盈亏基准 = 起始筹码。兜底不再是常数 1000（站起观战者/续局快照缺项者曾被
      // 凭空记 ±几百的假盈亏），而是该玩家当前筹码——即「无基准记录则视为 0 盈亏」，
      // 与 startStacks 的记账语义一致（评审 2026-10-15 MEDIUM）。
      const buyIn = this.startStacks[p.seat] !== undefined ? this.startStacks[p.seat] : p.stack;
      return {
        seat: p.seat,
        name: p.name,
        stack: p.stack,
        buyIn: buyIn,
        net: p.stack - buyIn,
        isMe: !!p.isHuman,
        // 中途离场：站起/掉线自动站起（sittingOut 是权威标记，isStanding 兜住
        // 本地「我已站起」等仅存在于 UI 层的状态）
        left: !!(p.sittingOut || this.isStanding(p.seat))
      };
    })).sort((a, b) => b.net - a.net);
    // 全员合计：所有人带入 / 剩余 / 盈亏的总和。零和游戏里合计盈亏 ≈ 0，
    // 对不上即说明有记账缺口——这行本身就是一张自检表。
    const sumBuyIn = rows.reduce((s, r) => s + r.buyIn, 0);
    const sumStack = rows.reduce((s, r) => s + r.stack, 0);
    const sumNet = sumStack - sumBuyIn;

    const me = rows.filter(r => r.isMe)[0];
    this.setData({
      timeUp: true,
      clockPendingEnd: false,
      isMyTurn: false,
      legal: null,
      readyPhase: false,
      readyList: [],
      myReady: false,
      readyLeft: 0,
      readyHint: '',
      sng: false,   // 批⑤：非 SNG 结算——WXML summary-row 内 wx:for 作用域判断用
      summary: {
        title: '本局结束 · 时长已到',
        sub: '共 ' + game.handNo + ' 手 · 全员盈亏结算',
        styleLine: styleLine,   // P1-6：打法画像一行（无样本时空串，wxml wx:if 隐藏）
        rows: rows,
        myNet: me ? me.net : 0,
        myNetText: me ? ((me.net >= 0 ? '+' : '') + me.net) : '0',
        // 我的「带入 / 剩余 / 盈亏」三件套（结算单顶部概览用）
        myBuyIn: me ? me.buyIn : 0,
        myStack: me ? me.stack : 0,
        // 全员合计（结算单底部对账行）：所有人带入 / 剩余 / 盈亏总和
        total: {
          buyIn: sumBuyIn,
          stack: sumStack,
          net: sumNet,
          netText: (sumNet >= 0 ? '+' : '') + sumNet
        }
      }
    });

    // 到点也记一笔战绩（盈亏 = 结束时相对起始筹码的变化）
    const meP = game.seatOf(this.mySeat);
    if (meP) {
      this.pendingRecord = {
        tableId: this.roomNo || 'ai',
        handNo: game.handNo,
        seat: this.mySeat,
        hole: meP.hole.map(c => P.cardToCode(c)).join(' '),
        board: game.board.map(c => P.cardToCode(c)).join(' '),
        handType: '时长结束',
        net: me ? me.net : 0,
        won: me ? me.net > 0 : false
      };
      this.uploadRecord();
    }
  },

  /** 结束后「再来一局」：重置筹码与倒计时，同一批玩家继续 */
  restartGame() {
    if (this.remoteMode) {
      wx.showToast({ title: '等待房主开始下一局', icon: 'none' });
      return;
    }
    if (!game) return;
    const players = game.players.map(p => ({
      id: p.id, name: p.name, seat: p.seat, stack: 1000,
      isHuman: !!p.isHuman, style: p.style
    }));
    // 批⑤修复：SNG「再来一局」须重置赛制状态——sngPlacement 只在 startGame 初始化，
    // 不重置则所有座位已有名次，_sngDetectEliminations 判 undefined 才记新名次的
    // 逻辑永远不触发，新一局打不出淘汰、直到时长到点（盲注不涨、赛制失效）。
    if (this.mode === 'sng') {
      this.sngPlacement = {};
      this.sngEliminationOrder = [];
      this._sngEnding = false;   // 复位终局幂等位：不复位则第二局的 endGame 在入口早退，整局无结算/无存档
      if (players.length) this.sngNextPlace = players.length;
    }
    this.setData({ summary: null, timeUp: false, clockPendingEnd: false });
    this.pendingTimeUp = false;
    this.initGame(players);   // startHand 内部会清理就绪状态
    this.startClock();
  },

  onSummaryClose() {
    this.setData({ summary: null });
  },

  /** 转发内容：好友房带房间号，好友点开即自动加入 */
  onShareAppMessage() {
    // 批⑦：若刚分享了高光，title 带高光摘要（「我在博弈论打出了皇家同花顺！」）
    if (this._shareHighlightTitle) {
      const title = this._shareHighlightTitle;
      this._shareHighlightTitle = null;   // 一次性：分享后清掉，下次回到默认
      /* 高光分享直达复盘（2026-10-20 修复「点分享链接看不到那局战况」）。
       * 旧 path 固定 /pages/index/index，点开只有 title 没有内容——接收者
       * 只能进首页干瞪眼。病根：分享卡的数据（replayStore/highlightStore）
       * 只存在分享者本机 storage，接收者机器上根本没有那局数据，任何
       * 「带 date 跳 replay 页」的方案都会落到「复盘记录不存在」。
       *
       * 正确路径是复用已上云的数据：
       *   · 好友房：poker_hand_replays 每局都落库（表内 replay?room= 房间复盘
       *     模式）——但 rpc 按房主 owner_id 校验，仅房主本人可见，好友点开
       *     rows 为空显示「暂无复盘」。诚实做法：带 room 让接收者先进房间
       *     与分享者同桌打牌（分享的本来意图），「那局战况」由分享卡 title +
       *     截图承担（零 canvas 约束下的既定方案，见 onShareCardShow 头注释）。
       *   · AI 局：数据纯本机，没有任何可直达的云端载体，退回首页默认 path。
       *     强行跳本机 replay 页对接收者只有一句「复盘记录不存在」。 */
      if (this.mode === 'friend' && this.roomNo) {
        return { title: title, path: '/pages/index/index?room=' + this.roomNo };
      }
      return { title: title, path: '/pages/index/index' };
    }
    if (this.mode === 'friend') {
      return {
        title: '来「博弈论」和我打一局，房间号 ' + this.roomNo,
        path: '/pages/index/index?room=' + this.roomNo
      };
    }
    return { title: this._shareTitle(), path: '/pages/index/index' };
  },

  /** 分享标题：SNG 与 AI 对战分开（二者都是本机引擎，但赛制不同） */
  _shareTitle() {
    return this.mode === 'sng' ? '博弈论 · SNG 淘汰赛' : '博弈论 · AI 对战';
  },

  /** 分享到朋友圈：好友房带房间号 */
  onShareTimeline() {
    if (this.mode === 'friend') {
      return { title: '来「博弈论」和我打一局，房间号 ' + this.roomNo, query: 'room=' + this.roomNo };
    }
    return { title: this._shareTitle() };
  },

  onUnload() {
    if (timer) clearInterval(timer);
    if (aiTimer) clearTimeout(aiTimer);
    this.clearClock();
    this.clearBlindTimer();   // 批④：销毁页停涨盲
    this.clearExpire();
    this.clearExpireWarn();
    this.clearReadyClock();
    this.clearResultTimer();
    this.clearResultModalTimer();
    this.clearFoldTimer();
    this.clearAllinTimer();   // 全下确认计时器与弃牌同构，销毁页同样要清（防泄漏）
    this.stopEngineWatch();
    this.stopSfxPump();
    this.stopSync();
    // 系统返回手势 / 页面被直接销毁时静默存快照，保证下次进入能续局
    this.saveSnapshot();
  },

  initGame(players, snap) {
    // AI/SNG 桌：机器人按序号绑定角色 style（取代旧随机），应用所选难度档位。
    // 好友房走 toPlayer 已绑过；这里只兜底「未传 players 的 AI/SNG 桌默认局」。
    const applyLevel = (this.mode === 'ai' || this.mode === 'sng') ? this.level : 'advanced';
    // 兜底建人（调用方通常都传 players）：名字池扩到 9 个后必须按座位数截断，
    // 否则默认局会被撑到 10 人（超过 maxSeats）。
    const fallbackNames = NAMES.slice(0, Math.max(2, Math.min(NAMES.length, this.maxSeats || 6)));
    const ps = players || fallbackNames.map((name, i) => ({
      id: 'u' + i,
      // AI 桌：我的座位用微信昵称，其余沿用预设对手名（NAMES[0] 是「我」的占位）
      name: i === this.mySeat ? auth.myName('你') : name,
      seat: i,
      stack: 1000,
      isHuman: i === this.mySeat,
      style: i === this.mySeat
        ? { aggro: 0.5, tight: 0.5 }
        : botProfiles.styleFor(Math.max(0, i - 1), applyLevel)
    }));
    // 盲注级（批④涨盲）：新建牌局默认 10/20；续局沿用快照里的 sb/bb
    // （涨盲定时器翻倍过的不退回默认）。createGame 后再覆写，保证引擎内部
    // minRaise/bb 一致。
    const initSb = (snap && snap.sb) ? snap.sb : 10;
    const initBb = (snap && snap.bb) ? snap.bb : 20;
    game = P.createGame({
      players: ps,
      sb: initSb,
      bb: initBb,
      dealerSeat: ps[ps.length - 1].seat,
      seed: 'mp-' + Date.now()
    });
    if (snap) {
      // 续局：回退到上一手庄位与手数，startHand 轮转后即重发快照记录的那一手
      if (snap.dealerSeat !== undefined && snap.dealerSeat !== null) game.dealerSeat = snap.dealerSeat;
      game.handNo = Math.max(0, (snap.handNo || 1) - 1);
      // 涨盲续局：恢复盲注级（createGame 已按 initSb/initBb 建好，此处兜底防漂移）
      if (snap.bb) { game.bb = snap.bb; game.sb = snap.sb || Math.round(snap.bb / 2) || 10; }
    }
    // 记录涨盲间隔与初始盲注，供 startBlindTimer 翻倍与展示（批④）
    this.blindIntervalMin = (snap && snap.blindIntervalMin) ? snap.blindIntervalMin
      : Math.max(0, Number(this.blindIntervalMin) || 0);
    this.setData({
      blindLevel: initBb,
      blindText: this.fmtBlind(initSb, initBb)
    });
    // 起始筹码：新建牌局记录当前值，续局沿用快照里的原始起始值（盈亏口径一致）
    if (snap && snap.startStacks) {
      this.startStacks = snap.startStacks;
    } else {
      this.startStacks = {};
      game.players.forEach(p => { this.startStacks[p.seat] = p.stack; });
    }
    /* AI 练习模式教练提示（新手可玩性 review 2026-10-19）。
     * 旧实现只在 startGame 置一次 true，doAct 首次操作就永久收起——
     * 新手只见到一把牌桌就再没有引导了。
     * 现改为「前 COACH_HANDS 手，每手轮到我都提示」：新手的困惑不在于
     * 「第一次看到界面」，而在于「连续几把都不知道该看什么」。给三手，
     * 到第四手还不会的话，重复的提示也只是噪音。
     * 用户手动点掉（onCoachClose）则永久收起——尊重已经上手的人。 */
    if (this.mode === 'ai' && !this._coachDismissed && (this._coachHandsSeen || 0) < COACH_HANDS) {
      this.setData({ coachShow: true });
    }
    // 引擎看门狗：双模式通用巡检，任何一环掉链 1.5s 内自动接上
    this.startEngineWatch();
    return this.startHand();
  },

  /** 发一手牌；返回是否成功开局（失败时上层据此回退等待室，防无声卡死） */
  startHand() {
    this.clearResultTimer();     // 上一手的结算展示定时器作废（防串手）
    this.clearResultModalTimer();
    this.resultModalHand = -1;   // 新一手允许重新调度结算弹窗（手数可能轮回重置）
    winStreaks = {};             // 连胜计数随新手清零（设计 §2.2：连胜徽章只活到下一手）
    this._winFxSeats = [];
    this.setData({ spark: null, flyOut: [], flyIn: [], winFx: '', streaks: {} });
    // 中途入座 / 换座 / 补电脑玩家：本手结束、下一手发牌前落位
    this.applyPendingSeats();
    // 「坐下加入游戏」下一手才生效：本手发牌前正式落座并入局
    if (this.pendingSit) {
      this.pendingSit = false;
      this.myStanding = false;
      // 中途加入的座位：本手为观战（sittingOut），下一手正式入局需清除该标记
      const me = game.seatOf(this.mySeat);
      if (me) me.sittingOut = false;
    }
    // 跨设备：好友的「坐下」上行到本手才生效（清 sittingOut 正式入局）
    if (this.pendingSitMap && game) {
      Object.keys(this.pendingSitMap).forEach(s => {
        const p = game.seatOf(Number(s));
        if (p) p.sittingOut = false;
      });
      this.pendingSitMap = {};
    }
    // 跨设备：好友的中途加入（引擎里本没有这个座位的人）→ 下一手发牌前插入。
    // 座位号沿用房间座位号，与房主端其余记账完全同一套坐标。
    if (this.pendingJoinMap && game) {
      Object.keys(this.pendingJoinMap).forEach(s => {
        const seat = Number(s);
        const info = this.pendingJoinMap[s] || {};
        const stack = Number(info.stack) || DEFAULT_BUY_IN;
        if (!game.seatOf(seat)) {
          game.players.push({
            id: 'p' + seat + '-' + Date.now(),
            name: info.name || '玩家', seat, stack, isHuman: true,
            style: { aggro: 0.4, tight: 0.35 },
            hole: [], folded: false, allIn: false,
            bet: 0, committed: 0, actedBet: null, canRaise: true, sittingOut: false,
            hands: 0, net: 0
          });
          this.startStacks[seat] = stack;
        }
        delete this.standingMap[seat];
      });
      this.pendingJoinMap = {};
    }
    // 新的一手开始，清理上一手的就绪状态与结算弹窗
    this.clearReadyClock();
    this.readyMap = {};
    this.setData({
      readyPhase: false, readyList: [], myReady: false, readyLeft: 0, readyHint: '',
      resultModal: null
    });

    // 每手重置加注档位：上一局选中的档位高亮会一直留到下一局（真机反馈）。
    // 默认落在「最小」——比全取消更好，因为 render 里raiseTo 会被钳到
    // legal.minRaiseTo，档位高亮与加注按钮金额始终一致，不会出现
    //「无高亮但按钮显示某个金额」或「高亮全下却只能加最小」的错觉。
    this.resetRaiseState();

    // 补筹守卫（计划 P0-1）：AI 桌默认「真枪实弹」不补筹，设置里开「无限练习」才恢复
    // 每手自动补满；SNG 不补筹——筹码归零即淘汰，靠 sng 检测记名次推进赛制。
    // B3（用户需求 2026-10-17）：好友房真人不再每手自动补筹——补多少、何时补
    // 由玩家自己决定（rebuy 弹窗/常驻按钮），只有 bot 保留演示态自动补满。
    if (this.mode === 'friend') {
      game.players.forEach(p => {
        if (!p.isHuman && p.stack < 20) {
          const add = DEFAULT_BUY_IN - p.stack;
          p.stack = DEFAULT_BUY_IN;
          if (this.startStacks[p.seat] !== undefined) this.startStacks[p.seat] += add;
        }
      });
    } else if (this.mode === 'ai' && this.aiUnlimited) {
      game.players.forEach(p => {
        if (p.stack < 20) {
          const add = DEFAULT_BUY_IN - p.stack;
          p.stack = DEFAULT_BUY_IN;
          if (this.startStacks[p.seat] !== undefined) this.startStacks[p.seat] += add;
        }
      });
    }
    // B3：真人手动补筹消化——申请一律记在 pendingRebuyMap（规则 1：下一手
    // 生效），下一手发牌前统一切入。规则 2 时已把 add 规成整手倍，这里只补
    // 撤销后站起等边角：人已不在座（站起/超时自动站起）→ 补筹作废，钱不白给。
    //
    // ⚠️ 落账必须等 game.startHand() 成功之后（P1，评审 2026-10-19）：
    // 旧实现先并入 stack、再调 startHand，开不起来（结算后有人站起/掉线、
    // 好友端尚未把入座同步过来 → 人数不足）时直接 return false——钱已进
    // stack、pendingRebuyMap 已清空、startStacks 已被抬高（结算盈亏失真），
    // 而且下一手不会再重试。这里只「算」出待落账清单（plan），不写任何
    // 状态；成功发牌后再统一落账并清 pending，失败则原样保留等下次重试。
    const rebuyPlan = [];
    const rebuyMapBefore = this.pendingRebuyMap || {};
    Object.keys(rebuyMapBefore).forEach(s => {
      const p = game.seatOf(Number(s));
      const add = Math.round(Number(rebuyMapBefore[s]) || 0);
      if (p && add > 0 && !p.sittingOut && !this.standingMap[Number(s)]) {
        const roomCap = p.isHuman ? REBUY_CAP : DEFAULT_BUY_IN;
        const safe = Math.max(0, Math.min(add, roomCap - p.stack));
        if (safe > 0) rebuyPlan.push({ seat: p.seat, add: safe });
      }
    });
    game.players.forEach(p => { p.net = 0; });

    const prevDealer = game.dealerSeat;   // 供快照记录：恢复时从这里轮转到下一庄位
    const r = game.startHand();
    if (!r.ok) {
      // 批⑤：SNG 终局——人数不足时 game.over，仍需处理夺冠收尾（只剩一人时记冠军）
      if (this.mode === 'sng') this._sngCheckFinalize();
      wx.showToast({ title: r.error, icon: 'none' });
      return false;
    }
    // B3 补筹落账（P1）：startHand 已成功——此刻才把 rebuyPlan 并入 stack。
    // 未进 plan 的座位（已站起/被撤销/无空间）随 pendingRebuyMap 一并清空：
    // 「一律下一手生效」的下一次机会就是这个 startHand 边界，过期作废。
    if (rebuyPlan.length || Object.keys(rebuyMapBefore).length) {
      rebuyPlan.forEach(it => {
        const p = game.seatOf(it.seat);
        // 引擎 startHand 已扣过本手盲注 → 这里再按当前 stack 二次钳制补后上限
        // （正常路径 rebuyPlan 已钳过，二次钳制只防 startHand 内部改 stack）
        const roomCap = p && p.isHuman ? REBUY_CAP : DEFAULT_BUY_IN;
        const safe = p ? Math.max(0, Math.min(it.add, roomCap - p.stack)) : 0;
        if (safe <= 0) return;
        p.stack += safe;
        if (this.startStacks[p.seat] !== undefined) this.startStacks[p.seat] += safe;
        if (it.seat === this.mySeat && this._myRebuyPending) {
          this._myRebuyPending = { hand: -1, add: 0 };
          this.setData({ myRebuyAdd: 0 });
        }
      });
      this.pendingRebuyMap = {};
    }
    // 批⑤：SNG 淘汰检测——startHand 后引擎已把 stack<=0 玩家标 folded=true，
    // 但「本手不参与」≠「自动淘汰」——此处检测筹码归零者记名次推进赛制。
    // 放在 startHand 成功后：此时游戏对象字段（stack/folded）已就绪。
    if (this.mode === 'sng') this._sngDetectEliminations();
    // 批⑨：startHand 边界——上手机人类若行动过，计入已统计手数并重置本手标记。
    // P1-7（2026-10-17）：守卫从『仅 expert』放宽到『所有 AI 局』——统计不改决策，
    // 把 VPIP 收进 HUD（myzone 小字显示）对 rookie/advanced 玩家同样是成长的指导。
    // 仅 expert：**决策层的** _adjustTightByVpip 仍要求 level==='expert' 与 ≥3 手样本
    // （见 scheduleAI 处守卫），避免新手被自家 1~2 手噪音引导的错反制。
    // SNG 终局 r.ok=false 分支已在上方 return，不计数。
    if (this.mode === 'ai' && this._humanActedThisHand) {
      this._humanVpipHands++;
      this._humanActedThisHand = false;
    }
    this.prevDealerSeat = prevDealer;
    // 加注档位重置追踪：与本手 handNo 对齐，双保险覆盖 render 的跨手检测
    // （resetRaiseState 已置 _raiseResetPending，这里再锚定 handNo，
    //  即便某次 render 跳过也不致下一手残留上一手的高亮选择）。
    this._raiseHandNo = game.handNo;
    myActText = '';
    myActCls = '';
    // #14 批二：跨手清空动作文案（镜像端不走 startHand，靠 render 判据兜底）
    this._lastActMap = {};
    this._actEpoch++;
    this.render();
    this.forcePublish();   // 新手牌是关键状态：穿透节流立即广播，好友马上看到发牌

    this.advance();
    return true;
  },

  /**
   * SNG 淘汰检测（批⑤）：遍历玩家，对筹码归零且尚未记名次者记录淘汰名次。
   * 引擎 startHand 已把 stack<=0 玩家设 folded=true（poker-core.js:862），
   * 但不自动淘汰——SNG 需在此记名次推进赛制。每淘汰一人播 eliminate 音色 + toast。
   * 检测完若存活者 <=1 调 sngFinalize 收尾夺冠。仅 mode==='sng' 调用。 */
  _sngDetectEliminations() {
    if (this.mode !== 'sng' || !game || !game.players) return;
    let newEliminated = false;
    game.players.forEach(p => {
      if (p.stack <= 0 && this.sngPlacement[p.seat] === undefined) {
        // 新淘汰者：记当前名次（从末位倒数），push 顺序，播音色
        const place = this.sngNextPlace != null ? this.sngNextPlace-- : null;
        if (place != null) {
          this.sngPlacement[p.seat] = place;
          this.sngEliminationOrder.push(p.seat);
          newEliminated = true;
          if (this.data.soundOn) sfx.play('eliminate');
          wx.showToast({ title: p.name + ' 被淘汰（第' + place + '名）', icon: 'none' });
        }
      }
    });
    // 淘汰状态变化需穿透渲染指纹，否则座位灰显不刷新
    if (newEliminated) {
      this._lastRenderFp = null;
      this.render();
    }
    // 存活者 <=1 → 终局夺冠
    this._sngCheckFinalize();
  },

  /**
   * SNG 终局检测（批⑤）：存活者（stack>0）<=1 时收尾夺冠。
   * 夺冠者记 place=1、播 champion 音色、收割 sng_win 高光徽章、结束本局。
   * 兜底：若冠军未被淘汰检测到（如靠赢池夺魁），在此补记。仅 mode==='sng' 调用。 */
  _sngCheckFinalize() {
    if (this.mode !== 'sng' || !game || !game.players) return;
    const alive = game.players.filter(p => p.stack > 0);
    if (alive.length > 1) return;   // 尚未终局
    // 收尾：补齐未被检测淘汰的存活者名次（冠军=1，若还有第二名存活者=2，依此类推）
    const survivors = alive.slice().sort((a, b) => b.stack - a.stack);
    // 从剩余最低名次往下分配给未记录者
    let nextPlace = this.sngNextPlace != null ? this.sngNextPlace : 1;
    // 先给未记录的存活者分配名次（倒序：stack 最高的拿最小名次=最好）
    const unrecorded = game.players.filter(p => this.sngPlacement[p.seat] === undefined && p.stack > 0);
    // 按筹码降序分配剩余名次（最高筹码 = 最好名次）
    unrecorded.sort((a, b) => b.stack - a.stack);
    unrecorded.forEach(p => {
      const place = Math.max(1, nextPlace);
      this.sngPlacement[p.seat] = place;
      if (this.sngEliminationOrder.indexOf(p.seat) < 0) this.sngEliminationOrder.push(p.seat);
      if (place > 1 && nextPlace > 1) nextPlace--;
    });
    this.sngNextPlace = Math.max(1, nextPlace);
    // 冠军 = 名次为 1 的玩家
    const championSeat = Object.keys(this.sngPlacement)
      .filter(s => this.sngPlacement[s] === 1)
      .map(Number)[0];
    if (championSeat !== undefined && this.data.soundOn) sfx.play('champion');
    // 收割夺冠高光徽章（仅我夺冠时）
    if (championSeat === this.mySeat && game.result) {
      highlightStore.addHighlight(game, this.mySeat, 'sng', 'sng_win', 0);
      // 新高光解锁即时反馈（P1-6，与 showResultModal 收割点同口径）。
      const first = highlightStore.listAll().filter(r => r.type === 'sng_win').length === 1;
      wx.showToast({
        title: '🏆 新高光：SNG 夺冠' + (first ? '（首次）' : ''),
        icon: 'none',
        duration: 2500
      });
    }
    // 若游戏尚未 over，由 endGame 收尾结算（按名次而非净值）。
    // 关键：不判 game.result——SNG 终局常发生在「最后一手 startHand 即 skipToShowdown
    // 结算、game.result 已置位」的同一手，若用 !game.result 守卫则永远进不来 endGame
    // （赛制卡在「最后一站立」、发不出结算面板）。endGame 幂等处理已在结算中的手。
    if (!game.over) {
      this.endGame();
    }
  },

  /**
   * 批⑨：根据人类滚动 VPIP 调整 AI 风格 tight 值（零引擎改动，纯包装层）。
   * 引擎 aiDecide 翻前用 style.tight（threshold=26-tight*10），此处构造调整后的 style 副本传入。
   * 基准 0.28 与 style-analyzer VPIP_LOOSE 一致；delta=(humanVpip-0.28)*0.5。
   * 人类 VPIP 高（松）→ delta 正 → bot 收紧（不陪松玩家）；人类 VPIP 低（紧）→ delta 负 → bot 放松（多偷池）。
   * 纯算术，不调用概率路径（rnd()/rng.float()），不修改 baseStyle 原对象（Object.assign 副本）。 */
  _adjustTightByVpip(baseStyle, humanVpip) {
    const adjusted = Object.assign({}, baseStyle);
    const delta = (humanVpip - 0.28) * 0.5;
    adjusted.tight = Math.max(0, Math.min(1, baseStyle.tight + delta));
    return adjusted;
  },

  /**
   * 推进下一个行动者：轮到我时起计时器，否则排 AI。
   * 若我已站起观战，则视为弃牌并直接跳过（站起者不参与本手）。
   * 渲染异常不允许打断引擎推进（render 内部已自捕获，这里再兜一层）。
   */
  advance() {
    if (!game || game.result) return;
    try {
      const seat = game.actionSeat;
      // 已站起的人（含超时未准备被自动站起者）不参与本手：轮到即自动弃牌跳过。
      // ⚠️ sittingOut 置位后 legalActions 返回 null，act 会被拒——
      // 必须先代弃（此时还没标 sittingOut，legal 仍合法）或直接由引擎
      // 推进路径处理，否则该座位永远轮空 → 全桌冻结（C-2 核心守卫）。
      if (this.isStanding(seat)) {
        const p = game.seatOf(seat);
        if (p && p.sittingOut && !p.folded) {
          // 已被标 sittingOut：走引擎推进路径（advance 内部按弃牌跳过）
          game.advanceInHand();
          this.afterAct();
          return;
        }
        const r = game.act(seat, 'fold');
        if (r.ok) { this.afterAct(); return; }
      }
      if (seat === this.mySeat) {
        this.startTimer();
        return;
      }
      // 跨设备：真人好友的座位等动作上行（房主 1.5s 轮询消费，30s 超时代行——无注过牌/有注弃牌）
      if (this.isFriendSeat(seat)) {
        this.friendActSince = this.friendActSince || Date.now();
        this.render();
        return;
      }
      this.scheduleAI();
    } catch (e) {
      console.error('[table] advance 异常', JSON.stringify({
        stage: 'advance', seat: game.actionSeat, message: e && e.message, stack: e && e.stack
      }));
    }
  },

  /**
   * 站起：退出当前牌局（不退出房间），不再参与发牌与行动，可随时坐下重新入局。
   * 规则与主流 App 一致：需先弃牌或等本手结束才能离桌，避免中途抽身影响牌局。
   */
  standUp() {
    if (!game || this.myStanding) return;
    const me = game.seatOf(this.mySeat);
    if (!me) return;
    if (!(me.folded || game.result)) {
      wx.showToast({ title: '本手结束后或弃牌后可站起', icon: 'none' });
      return;
    }
    this.myStanding = true;
    this.pendingSit = false;
    this.pushChat(this.mySeat, this.meLabel(false), '站起观战');
    if (this.remoteMode) {
      // 镜像端：站起动作上行，房主把该座位标记 sittingOut。
      // 站起/坐下的上行失败必须提示——沉默失败会把 UI 观战态与权威端撕裂整个房间。
      roomSync.pushAction(this.roomNo, { type: 'stand', seat: this.roomSeat })
        .catch(() => this.syncFailToast('站起未同步成功，请检查网络'));
    }
    wx.showToast({ title: '已退出本局，可坐下重新加入', icon: 'none' });
    if (this.data.readyPhase) {
      if (this.remoteMode) {
        // 镜像端：退出计票由房主处理，本地先把我的条目摘掉
        const list = (this.data.readyList || []).filter(x => Number(x.seat) !== Number(this.roomSeat));
        this.setData({ readyList: list, myReady: false });
      } else {
        // 就绪阶段站起 → 退出计票，其余人齐了就直接发下一手
        const seated = (this.data.readyList || []).filter(x => this.seatedOf(x.seat));
        this.setData({ readyList: seated });
        this.renderReady();
        this.checkAllReady();
      }
    }
    this.render();
  },

  /**
   * 坐下：重新入局，但「下一手」才生效——不会中途插进已经开始的牌局。
   * 当前本手仍保持观战（轮到我自动弃牌），下一手发牌时正式落座。
   */
  sitDown() {
    if (!game) return;
    if (!this.myStanding && !this.pendingSit) return;   // 已在局内
    this.pendingSit = true;
    this.myStanding = true;    // 本手仍观战，startHand 时才转为入局
    this.pushChat(this.mySeat, this.meLabel(false), '重新入局');
    if (this.remoteMode) {
      // 镜像端：坐下的上行由房主记 pendingSitMap，下一手 startHand 才生效。
      // 同上：上行失败必须让用户知道，否则到下一手才发现自己没入局。
      roomSync.pushAction(this.roomNo, { type: 'sit', seat: this.roomSeat })
        .catch(() => this.syncFailToast('坐下未同步成功，请重试'));
    }
    wx.showToast({ title: '下一手开始发牌入局', icon: 'none' });
    if (this.data.readyPhase) {
      if (this.remoteMode) { this.render(); return; }   // 镜像端就绪状态以房主广播为准
      this.enterReadyPhase();   // 就绪阶段坐下 → 重新计票（我也要点「准备就绪」）
      return;
    }
    this.render();
  },

  // ---------- 渲染 ----------
  // 渲染与引擎严格解耦：render 内任何异常都只降级本帧画面并打日志，
  // 绝不向上抛——否则 startHand→render→advance 链路断掉，牌局无声冻结。
  render() {
    try {
      // 氛围基线：缓存「上一帧」的注额/池作为本帧 diff 的对照。
      // _snapBaseline 在这里把 this._base 刷成本帧值，供下一帧比对；
      // 本帧渲染用 prevBase（上一帧结束时缓存的值）。
      const prevBase = this._base;
      this._snapBaseline();
      this._prevBase = prevBase;
      // 渲染指纹：牌桌实质状态未变时跳过整帧 setData（评审 2026-10-15 性能优化）。
      // tick 必须进指纹——计时应变化时需重绘；但 startTimer 的每秒回调走局部
      // setData（不调 render），故 render 不被每秒触发，指纹稳定。跳过路径仍执行
      // _renderTail（结算调度 + 广播），防漏调度。forcePublish 不动本指纹，靠
      // handNo/street 等实质字段变化自然令指纹不同。
      const g = game;
      // 超时口径按模式取（remote 30s / 单机 20s）：timerPct/timerUrgent 均 from tickMax
      const tickMax = this.timerMax();
      // P0-1：指纹里引用的 me 必须在拼接前解析——引擎未起局时（等待室）me 可能为空
      const mePre = game.seatOf(this.mySeat);
      /* 我当前的牌型名（新手可玩性 review 2026-10-19）。
       * 病根：牌型名此前只在**摊牌之后**出现在赢家座位标签与结算弹窗上；牌局进行中
       * 玩家只能看到两张底牌 + 公共牌，永远不知道「我现在是两对还是三条」。
       * 新手最容易卡住的正是「一对和两对哪个大」「我这是不是顺子」——牌型速览
       * 放在首页，人在牌桌上打牌时不会回去翻。
       * 现在翻牌出现后（board ≥ 3 张）每街算一次最佳成手，显示在底牌下方。
       * ⚠️ 只显示「牌型名」这一纯事实，不含任何行动建议，故不受合规门控
       *   （renderAdvice 的 mode !== 'ai' 限制只针对「建议加注/弃牌」这类结论）。
       * ⚠️ 必须**在指纹 fp 之前**算出来——fp 里 'hn' 段要用它，放到后面会踩
       *   const 的 TDZ（ReferenceError: Cannot access before initialization）。
       */
      let myHandName = '';
      let myHandTier = 0;   // 配色档位（1 最强 .. 5 最弱），0=无标签
      if (mePre && mePre.hole && mePre.hole.length === 2 && !this.myStanding) {
        if (game.board.length >= 3) {
          const ev = P.evaluate(mePre.hole.concat(game.board));
          if (ev && ev.name) myHandName = ev.name;
          /* 听牌提示（新手可玩性 review）：只报「牌型名」会误导新手——
           * A♠Q♠ + 9♠5♠J♣ 判定为「高牌」，新手以为自己什么都没有，转头就弃掉
           * 一手四张同花（还有两张牌可成同花，是最值钱的听牌之一）。
           * 故当已成牌型只是「高牌」或「一对」时，额外看一眼有没有 8 张以上的出路
           * （同花听/两头顺听=8~9 张），有就补一句「听牌」。
           * 只加「听」这个事实，不给「该跟注还是加注」的结论，仍不属于行动建议。
           */
          if (myHandName === '高牌' || myHandName === '一对') {
            const dr = P.detectDraws ? P.detectDraws(mePre.hole, game.board) : null;
            if (dr && dr.outs >= 8 && game.board.length < 5) {
              myHandName = myHandName + ' · ' + (dr.desc || '听牌') + ' ' + dr.outs + ' 张';
            }
          }
        } else {
          /* 翻牌前起手牌标签（新手可玩性 review 2026-10-19）。
           * 手上只有两张牌时 evaluate 判不出「牌型」（只能给「高牌」），
           * 于是新手拿到 A♠K♠ 与 7♣2♦ 看到的界面完全一样——而这正是
           * 弃牌/跟注/加注第一个决策依据。
           * advisor.classifyHole 早就实现好了五档起手牌分类（premium/strong/
           * playable/marginal/trash，边界按「新手友好」偏保守调过），
           * 但此前只在轮到我行动时、作为「胜率 xx% · 起手牌：xx · 建议」的
           * 一部分出现，且被 coachShow 的 elif 链路挤掉过。现在直接常驻显示
           * 在底牌下方，翻前翻后统一由 myHandName 承载。
           * ⚠️ 合规：这是「这手牌的类别」这一纯事实判断（静态牌力表，无 RNG、
           *   无对手信息），不是「建议加注/弃牌」，故不受 mode !== 'ai' 门控。
           */
          const cls = advisor.classifyHole(mePre.hole);
          if (cls && cls.label) {
            myHandName = cls.label;
            myHandTier = cls.tier || 0;
          }
        }
      }
      const fp = [
        g.handNo, g.street, g.potTotal(), g.currentBet, g.actionSeat,
        (g.board || []).join(','),
        g.dealerSeat, g.sbSeat, g.bbSeat,
        g.sb, g.bb,   // 批④：盲注级变化（涨盲）必须令指纹不同，否则跳过分支吞掉 blindLevel/blindText
        g.players.map(p => p.seat + ':' + p.stack + ':' + p.bet + ':' +
          (p.folded ? 1 : 0) + (p.allIn ? 1 : 0) + (p.sittingOut ? 1 : 0) +
          // 批⑤：SNG 淘汰名次进指纹——淘汰后座位灰显需重绘，未入指纹会被跳过分支吞掉
          (this.mode === 'sng' && this.sngPlacement[p.seat] !== undefined ? 'E' + this.sngPlacement[p.seat] : '') +
          (p.hole ? p.hole.join('.') : '')).join('|'),
        g.result ? 'r' + JSON.stringify(g.result.winners) + JSON.stringify(g.result.awards) : '',
        g.showdownReveal ? 'sv' + JSON.stringify(g.showdownReveal) : '',
        this.data.readyPhase ? 'rp' + (this.data.readyList || []).map(x => x.seat + (x.ready ? 1 : 0)).join(',') : '',
        this.data.readyLeft,
        this.data.foldConfirm ? 1 : 0,
        // 全下确认态：按钮文案在「全下 / 再点全下」间切换，是独立实例状态
        // （非 stack/bet 派生）——不进指纹会在其余成分恰好全同时被跳过分支吞掉，
        // 玩家点了没反应（与 foldConfirm 同理，见其上方注释）。
        this.data.allinConfirm ? 1 : 0,
        this.data.raiseTo,
        this.data.raiseCustom ? 1 : 0,
        tick,                    // 计时环残值——变化时必须重绘
        myActText,               // 我的动作气泡文案
        myActCls,
        // #14 批二：动作文案是独立实例状态（非 stack/bet 派生），必须以 epoch
        // 令牌进指纹——render fp 不含 actionSeat，房主端 applyFriendAction 写
        // map 后若其余成分恰好全同，不加令牌气泡会被跳过分支吞掉。
        'ax' + this._actEpoch,
        // B3 规则 3：已申请补筹是独立实例状态（非 stack 派生），必须以 epoch
        // 式字段进指纹——申请/撤销/生效的瞬间若其余成分未变，不加则角标变化
        // 会被跳过分支吞掉（与 _actEpoch 同理）。
        'rb' + (this._myRebuyPending ? this._myRebuyPending.hand + ':' + this._myRebuyPending.add : ''),
        this.myStanding ? 1 : 0,
        this.pendingSit ? 1 : 0, // 影响 mySeated（坐下待下一手入局）的派生态
        // 我的当前牌型名（新手可玩性 review）。虽是 board+hole 的纯派生量、
        // 顶层已覆盖 board 与 p.hole，但它是本轮新增的独立显示字段，按本仓库
        // 「新增任何写入 render 的 setData 字段都要同步加进指纹」的约定显式登记，
        // 避免将来 hole 的指纹口径调整时把它静默吞掉。
        'hn' + myHandName + '/' + myHandTier,
        this.data.resultModal ? 'rm' : '',  // 结算弹窗开/关状态
        // P0-1：AI 桌输光/练习模式开关——派生 myAIBusted/aiUnlimitedTip 由二者驱动，
        // 不进指纹则设置切换或筹码归零瞬间的 mytip 切换会被跳过分支吞掉
        (this.mode === 'ai' && this.aiUnlimited) ? 'u' : '',
        (this.mode === 'ai' && !this.aiUnlimited && mePre && mePre.stack <= 0) ? 'b' : '',
        // P1-7：我的 VPIP 显示随每手边界更新（手数变 → 百分比变）。仅 AI 局
        // 入指纹——好友/匹配对局计算会泄露对手读人细节到 HUD（社交禁忌）。
        (this.mode === 'ai' ? 'v' + this._humanVpipHands + ':' + this._humanVpipCount : '')
      ].join('#');
      if (this._lastRenderFp === fp) {
        this._renderTail();
        return;
      }
      // 指纹置位推迟到主 setData 成功之后：若 render body 中途抛错（降级 setData
      // 在 catch 里跑），_lastRenderFp 仍是上一帧的旧值 → 下一帧同势 render 不命中
      // 跳过、自然重试，降级态不会卡到下一次实质状态变化才恢复（评审 2026-10-16）。
      const showdown = g.street === P.STREET.SHOWDOWN;
      const result = g.result;
      // #14 批二：动作文案换街即清——跟 bet 归池（引擎 collectBets）同帧发生。
      // 旧街的「跟注」若残留会与「桌面无注」矛盾误导玩家。镜像端 street 由
      // loadSnapshot 更新，同一 render 路径自动清；两手之间的极端残留由
      // startHand 的显式清空双保险兜底（镜像端不走 startHand）。
      const actTag = g.handNo + ':' + g.street;
      if (this._actHandStreet !== actTag) {
        this._lastActMap = {};
        this._actEpoch++;
        this._actHandStreet = actTag;
      }
      // 就绪阶段：上一手的牌全部收走（公共牌/底牌/赢家特效），桌面清空等下一局，
      // 就绪状态以徽章形式挂在各个座位上（不再在底部条里逐人罗列）。
      const readyPhase = this.data.readyPhase;
      const readyLs = readyPhase ? (this.data.readyList || []) : [];

      // 公共牌
      // 摊牌高亮：以「我的最佳成手 5 张」为依据，把构成牌型的牌标出来
      const myReveal = game.showdownReveal ? game.showdownReveal[this.mySeat] : null;
      const bestSet = (result && myReveal && myReveal.hand) ? new Set(myReveal.hand) : null;

      const board = readyPhase ? [] : this.markBest(game.board.map((card, i) => this.cardData(card, i)), bestSet);
      const placeholders = readyPhase ? 0 : Math.max(0, 3 - game.board.length);
      const placeholdersArr = [];
      for (let i = 0; i < placeholders; i++) placeholdersArr.push({ phkey: i });

      // 边池（含归属者座位号——玩家审视 2026-10-17：此前只显金额，多路全下
      // 时看不出「这几个池谁有资格拿」，要去结算单反查）。eligible 是有资格
      // 竞争该池的座位列表（引擎 buildSidePots 已算好并排序）。
      let sidePots = [];
      if (!readyPhase && game.pots && game.pots.length > 1) {
        sidePots = game.pots.slice(1).map(p => ({
          amount: p.amount,
          eligible: (p.eligible || []).map(s => s + 1),   // 显示用 1 起座位号
          eligibleList: (p.eligible || []).map(s => s + 1).join('/')  // wxml 只做拼接展示
        }));
      }

      // 站起观战：仍在房间内，但不参与发牌与行动
      const standing = this.myStanding === true;
      // 已坐下但待下一手入局时同样算「在座」（需点就绪），只是本手仍不参与
      const mySeated = this.pendingSit || !standing;
      const me = game.seatOf(this.mySeat);
      const canStand = !!me && !standing && (!!me.folded || !!result);

      // 座位环：所有玩家（含「我」）都渲染在椭圆上——「我」锚定在底部中央，
      // 与等待室共用同一套坐标系（ringPositions）→ 开局瞬间座位位置完全连续、无跳变。
      // 我的底牌仍单独展示在底部我的操作区（myzone），座位卡只放身份/筹码/下注/状态。
      // 座位环按房间设定的 N 个位整体铺开：桌子有几个位就画几个位，
      // 空位同样常显（带「坐下」按钮）→ 人员不满时能看见、能点进去加入或换座。
      // （旧版只画 game.players：8 人房 5 人开局，剩下 3 个位在界面上根本不存在。）
      const allSeats = [];
      for (let si = 0; si < this.maxSeats; si++) allSeats.push(si);
      // 兜底：万一有玩家的座位号落在房间座位数之外（默认局按预设名单建人），
      // 也要进环——宁可多画一个位，不能让某个玩家在牌桌上凭空消失。
      game.players.forEach(p => { if (allSeats.indexOf(p.seat) < 0) allSeats.push(p.seat); });
      allSeats.sort((a, b) => a - b);
      const pos = ringPositions(allSeats, this.mySeat, this.feltUh);
      const seats = allSeats.map(si => {
        const p = game.seatOf(si);
        if (!p) {
          // C9（玩家审视 2026-10-17）：进行中的空位胶囊降透明——满桌打牌时
          // 空位的「入座」按钮与真人座位同权重抢焦点，干扰读牌。等待室
          // （未开局）不降透：拉人是等待室的主任务，按钮必须显眼。
          // readyPhase（局间等待）同样不降透：填桌就在这时发生。
          const es = emptySeat(si, pos[si] || { x: 50, y: 20 }, true);
          if (!readyPhase && !result) es.cls += ' dim';
          return es;
        }
        const pp = pos[p.seat] || { x: 50, y: 20 };
        const isMe = p.seat === this.mySeat;
        const isWinner = !readyPhase && result && result.winners.indexOf(p.seat) !== -1;
        /* 摊牌牌型标注（新手可玩性 review 2026-10-19）。
         * 病根：牌型名此前只挂给**赢家**座位（isWinner 条件）。摊牌时其余亮牌的
         * 座位只有两张牌在飘，新手看到「我输了」却不知道对方到底赢在哪一手——
         * 而这正是学牌最关键的一课（「原来 Q 三条赢了我的两对」）。
         * 现放宽为：摊牌阶段（showdown）任何已亮牌的座位都标牌型名，
         * 赢家的名字加金色（winner 样式在 cls 里），输家是灰色。
         * fold 结算不亮牌（muck 礼仪）→ showdownReveal 无该座位 → 不显示空壳。
         */
        const reveal = !readyPhase && showdown && game.showdownReveal ? game.showdownReveal[p.seat] : null;
        const typeName = (reveal && reveal.name) ? reveal.name : '';
        const name = p.name || '玩家';
        // 就绪徽章数据：true=已准备 / false=准备中 / null=不显示（非就绪阶段或不在就绪名单）
        const rEntry = readyLs.filter(x => Number(x.seat) === Number(p.seat))[0];
        const readyFlag = rEntry ? !!rEntry.ready : null;
        // 对手手中暗牌：未摊牌、未弃牌、有底牌 → 显示两张小牌背（WPK 式：一眼看出谁还在手）。
        // ⚠️ 走廊座位不显示牌背：牌背行就在块底（SEAT_H_PX_UH 已含 0.4 margin +
        // 9.8 牌高，见常量注释），走廊块底与底池上沿同高，牌背必落进底池带；
        // 弃牌/在手状态靠亮度与徽章已能区分。
        // 判据与 bubbleCls 同构（双条件）：纵向（块底以「完整块」口径超底池上沿）
        // 且横向落在中央走廊（|x−50| < 走廊半宽）才藏。f626191 的旧判据
        // y<25 单条件实测「漏藏 0 处、误藏 4 处」（6 位桌 x=25/75、
        // 8 位桌 x=16.5/83.5 的侧位也有 y<25 的弧线段）——y 维度根本没有
        // 区分度，核心变量是 x（2026-10-21 评审）。
        const feltUh = this.feltUh || FELT_UH_FALLBACK;
        const blockHalfFelt = uhToFelt((allSeats.length >= 7 ? SEAT_H_PX_UH_TIGHT : SEAT_H_PX_UH), feltUh) / 2;
        const potTopFelt = POT_ANCHOR.y - uhToFelt(POT_PILL_H, feltUh) / 2;
        const hideCardsBackY = (+pp.y) + blockHalfFelt > potTopFelt;
        const topRow = hideCardsBackY && Math.abs((+pp.x) - POT_ANCHOR.x) < SEAT_CORRIDOR_HALF_W;
        const cardsBack = !topRow && !readyPhase && !isMe && !p.folded && !showdown && p.hole.length === 2;
        // 摊牌亮牌：摊牌座位要整块浮到最上层——否则相邻座位的名牌/筹码堆
        // 会压在刚亮出的两张牌上，等于「亮了还是看不清」。
        const showCards = !readyPhase && !isMe && showdown && !p.folded && p.hole.length === 2;
        const isStanding = this.isStanding(p.seat);
        const isActive = !readyPhase && game.actionSeat === p.seat && !result;
        const isFolded = readyPhase ? false : !!p.folded;
        // 批⑤：SNG 淘汰（筹码归零已被赛制记名次），灰显优先级高于 folded/standing
        const isEliminated = this.mode === 'sng' && this.sngPlacement[p.seat] !== undefined && p.stack <= 0;
        /**
         * 座位卡的完整 class 字符串在这里一次性算好，WXML 只写 `class="{{item.cls}}"`。
         *
         * 【为什么必须放 JS】原先第 77 行把整段逻辑内联在 WXML 里：
         *   {{winFx && (',' + winFx + ',').indexOf(',' + item.seat + ',') >= 0 ? 'winfx' : ''}}
         * 这在**开发者工具里看着没问题、真机上传直接编译失败**：
         *   Bad attr 'class' with message: unexpected token ':'
         * 原因是 WXML 的 {{}} 解析器不支持「三元里嵌套 && + 字符串拼接 + 方法调用
         * .indexOf()」这种组合，解析到 `? 'winfx' :` 的冒号就崩了。
         * 这类表达式引擎能力有限，**一律搬到 JS 预计算**才安全
         * （项目里 actCls / myActCls 早就是这个思路）。
         *
         * 语义与原内联表达式逐条对齐：empty 空位 / self 我 / folded 弃牌 /
         * active 行动中 / win 赢家 / standing 观战 / winfx 赢家金光。
         */
        const cls = [
          'seat',
          allSeats.length >= 7 ? 'tight' : '',   // 大桌紧凑模式：8~9 人不挤成一团
          p.stack === undefined || p.name === '' ? 'empty' : '',   // 空位（等待室无人）
          isMe ? 'self' : '',
          isFolded ? 'folded' : '',
          isActive ? 'active' : '',
          isWinner ? 'win' : '',
          isStanding ? 'standing' : '',
          isEliminated ? 'eliminated' : '',   // 批⑤：淘汰灰显（声明在 folded/standing 之后以覆盖 opacity）
          isWinner && this._winFxSeats && this._winFxSeats.indexOf(p.seat) >= 0 ? 'winfx' : '',
          showCards ? 'reveal' : ''
        ].filter(Boolean).join(' ');
        return {
          seat: p.seat,
          seatNo: p.seat + 1,
          cls: cls,
          name: name,
          initial: name.slice(0, 1),
          x: pp.x,
          y: pp.y,
          // #14 批一：筹码文案走紧凑格式（>=1万折「万」），显示层统一口径
          stack: this.fmtStack(p.stack),
          bet: readyPhase ? 0 : p.bet,
          // 下注胶囊落位按座位区分：对手（上半圆）浮在块底「内侧」，我的座位
          // （底部中央）浮在块「上方」朝桌心。顶排若也向上浮会顶出牌桌上沿被裁掉
          // ——真机「部分玩家下注筹码看不到」正是这个（下注数字上半截被切）。
          betCls: 'seat-bet ' + (isMe ? 'bet-me' : 'bet-in'),
          /* 行动气泡落位（2026-10-19 评审修复；2026-10-21 改用双条件复用几何变量）。
           *
           * ⚠️ 判据的核心变量是【x】，不是 y —— 这一点历史上推错了两轮，记下来：
           *   底池是**居中的窄条**（胶囊宽度随金额 14~20uw，横向约占 40%~60%），
           *   而座位铺在整条半圆上。左右两侧座位的气泡虽然纵向也落在底池带里，
           *   但**横向根本不重叠**，朝下完全没问题，改了只会白白压住头像。
           *   而 y 单独做判据会误伤：半圆上所有对手 y 都贴近，用 y 阈值会把
           *   全桌都判进去（实测过，头像全被压）。
           *
           *   故条件 = 纵向可能进底池带（hideCardsBackY，与牌背共享的几何量：
           *             块底 > 底池上沿，uhToFelt 换算后同单位）
           *             且 横向与底池带相交（|x-50| < 底池半宽 + 气泡半宽）。
           *   底池半径取保守值 POT_SAFE_HALF_W（覆盖最宽金额），气泡半宽按
           *   最长文案「加注 12500」估 ACT_BUBBLE_HALF_W。
           *   代价是这些座位的气泡会盖住头像上半圈的首字母——头像只是身份
           *   标识，气泡文字才是行动信息；庄家/倒计时徽章在头像外侧不受影响。 */
          bubbleCls: (isMe ? 'bub-me'
            : (hideCardsBackY && Math.abs((+pp.x) - POT_ANCHOR.x) < (POT_SAFE_HALF_W + ACT_BUBBLE_HALF_W)
              ? 'bub-top' : 'bub-in')),
          allIn: readyPhase ? false : p.allIn,
          folded: isFolded,
          standing: isStanding,
          eliminated: isEliminated,   // 批⑤：淘汰标记，WXML 显示「淘汰」文本
          placeText: isEliminated ? '第' + this.sngPlacement[p.seat] + '名' : '',
          active: isActive,
          isDealer: game.dealerSeat === p.seat,
          isSB: game.sbSeat === p.seat,
          isBB: game.bbSeat === p.seat,
          isMe,
          // 批：进行中「请出」标签复用此座位对象，isBot 必须带——
          // 等待室走 buildWaitSeats 自带 isBot，进行中座位对象此前未带，
          // 会导致 wxml:149 的 `item.isBot` 判空，「请出」在牌局中根本不显示。
          isBot: !!this.botSeats[p.seat],
          // P1-7 HUD 徽章：bot 风格折两字（紧凶/松弱/中稳），随座位对象每帧重建，
          // 同 isBot 不进指纹（isBot/p.style 在牌桌生命周期内不变，座位对象整体
          // 换出才是换人格触发重算；引擎 aiDecide 本身不改 style，故静态）。
          // 真人（isMe/好友）不显示——风格建在别人画像上是 muck 礼仪之外的越权。
          // 7 人以上（tight 桌）不挂「松凶/紧凶」风格徽章：每座都挂会让桌面非常杂乱
          // （2026-10-21 用户反馈「紧凑杂乱」）。6 人及以下保留。
          styleTag: (allSeats.length >= 7) ? '' : ((!!this.botSeats[p.seat] && p.style)
            ? botProfiles.styleTagOf(p.style)
            : ''),
          ready: readyPhase ? readyFlag : null,
          // 对手底牌：平时不展示（德扑常识），仅摊牌时亮出；我在底部 myzone 单独展示
          cardsBack,
          showCards,
          hole: readyPhase ? [] : this.markBest(p.hole.map((card, ci) => this.cardData(card, ci)), bestSet),
          win: !!isWinner,
          // 摊牌后赢家座位直接飘出赢得的筹码数（WPK 式结算反馈）
          winGain: isWinner ? result.awards.filter(a => a.seat === p.seat).reduce((s, a) => s + a.amount, 0) : 0,
          // C3：赢家座位同帧亮牌型名（source: showdownReveal，fold 结算为空）
          typeName: typeName,
          timer: !readyPhase && game.actionSeat === p.seat ? tick : '',
          timerPct: !readyPhase && game.actionSeat === p.seat ? Math.round(tick / tickMax * 100) : 0,
          // 最后 5s 计时环转红脉冲（仅当前行动座位，与我回合 actbar.urgent 同阈值）
          timerUrgent: !readyPhase && game.actionSeat === p.seat && tick <= 5 && tick > 0,
          // #14 批二：动作文案从实例态派生（我走 myActText 模块变量，其余座位
          // 查 _lastActMap——AI 端/房主端看好友/镜像端 diff 三路统一写入）。
          actText: !readyPhase ? (isMe ? myActText : ((this._lastActMap[p.seat] || {}).text || '')) : '',
          actCls: !readyPhase ? (isMe ? myActCls : ((this._lastActMap[p.seat] || {}).cls || '')) : ''
        };
      });

      // 我的信息（底部 myzone：手牌 + 筹码 + 状态）。就绪阶段底牌收走，等下一手再发
      const meP = game.seatOf(this.mySeat);
      const myCards = readyPhase ? [] : this.markBest(
        (meP && !standing) ? meP.hole.map((card, i) => this.cardData(card, i)) : [], bestSet);

      // 实时盈亏口径：带入 = startStacks[mySeat]，缺失兜底为当前筹码（视作 0 盈亏）。
      // 与 endGame 的结算口径逐字一致 —— 否则会出现「面板显示的盈亏和结算单不一样」，
      // 这类不一致最难排查。面板与结算都读这三个值。
      const myBuyIn = meP ? (this.startStacks[meP.seat] !== undefined ? this.startStacks[meP.seat] : meP.stack) : 0;
      const myNetLive = meP ? meP.stack - myBuyIn : 0;

      // P0-1：AI 「真枪实弹」我输光后，本桌结束态（blocking 提示 + 「再来一桌」出口）；
      //        「无限练习」开启时，就绪/结算阶段把原有 mytip 换成练习模式提示。
      // 两字段同由 render 派生（指纹里的 mode/aiUnlimited/stack 段驱动），不进 setData 会
      // 被跳过分支吞掉；只在对应分支显示，不会并存——后写即终值。
      const myAIBusted = this.mode === 'ai' && !this.aiUnlimited && !!meP && meP.stack <= 0;
      const aiUnlimitedTip = this.mode === 'ai' && this.aiUnlimited && (readyPhase || !!result) && !myAIBusted;

      // P1-7 HUD：我的 VPIP 小字。AI 桌都显示（守卫已放宽——统计与反制同口径，
      // 反制仍是 expert 专属）。样本<5 手显示「--」（VPIP 1~2 手的方差没意义，
      // 反而误导）。字符串派生自纯实例字段：_humanVpipHands/_humanVpipCount
      // 在第 startHand 边界累加、doAct 时累可自愿入池计数。指纹段见下。
      const myVpipPct = (this.mode === 'ai' && this._humanVpipHands >= 5)
        ? String(Math.round(this._humanVpipCount / this._humanVpipHands * 100))
        : '--';

      // 操作区（站起观战时不参与行动）
      const isMyTurn = game.actionSeat === this.mySeat && !result && !standing;
      let legal = null;
      let raiseTo = 0;
      // 跨手重置的触发条件 = 「手数前进」，而不是「走过 startHand()」。
      // ⚠️ 曾经只挂在 startHand() 上，结果好友房复发「一直高亮上一局的」：
      // 镜像端根本不走 startHand()——enterRemote() 直接 loadSnapshot 房主快照
      // 再 setData + render()，续局 restoreRoom 同理。这些路径都绕过了重置点。
      // 以 handNo 为判据挂在 render 上，所有让牌局前进的路径都被同一处覆盖。
      if (game && this._raiseHandNo !== game.handNo) {
        this._raiseHandNo = game.handNo;
        this._raiseResetPending = true;
      }
      // ⚠️ 档位口径随「街 / 当前跟注额」失效（2026-10-17 真机截图实锤）：
      //  用户点 50% 档（高亮 p50、金额=p50 口径）后没有确认加注，AI 行动把
      //  street/currentBet 推进 → 旧档位的金额算出来低于新一轮 minRaiseTo，
      //  render 把 raiseTo 钳回最小（按钮「加注 20」），而 preset 高亮还停在
      //  50% → 「高亮 50% + 加注 20」的矛盾态（AI 桌与好友房同现）。
      //  修法：street:currentBet 变化即视为档位口径失效，与跨手同帧重置回
      //  「最小」——高亮与金额永远同源。同街内无人加注（currentBet 不变）
      //  时不触发，我选好的档位不会被误清。
      const raiseEpoch = game ? (game.street + ':' + game.currentBet) : '';
      if (game && this._raiseEpoch !== raiseEpoch) {
        this._raiseEpoch = raiseEpoch;
        this._raiseResetPending = true;
      }
      // 每手重置：startHand 刚置的标志（见 resetRaiseState）。setData 异步，
      // this.data.raiseTo 同帧还是上一手的值，必须用实例字段在同一同步路径上覆盖，
      // 否则会出现「档位已高亮回『最小』，金额却还是上一手 100%」的新矛盾态。
      const wasReset = !!this._raiseResetPending;
      this._raiseResetPending = false;
      if (isMyTurn) {
        // 镜像端优先用房主下发的合法性（快照带不了 canRaise 细节），取不到再本地算
        legal = (game.remoteLegal && game.remoteLegal.seat === this.mySeat)
          ? game.remoteLegal
          : game.legalActions(this.mySeat);
        // 每手首帧锁定为最小额（与 raisePreset:'min' 高亮严格对应）
        if (legal) {
          raiseTo = wasReset ? legal.minRaiseTo
            : (this.data.raiseTo >= legal.minRaiseTo ? this.data.raiseTo : legal.minRaiseTo);
        }
      }
      // 2026-10-19 用户明确要求：每一局开始（以及每次重置：换街 / 跟注额变化）
      // 一律回到「最小」档、并收起自定义面板——**不再恢复上一手的档位记忆**。
      // 旧的 C7「档位会话记忆」会把高亮一直停在玩家上次选的 50%，看起来像
      // 「高亮卡住/又出现」（用户反复反馈）。现在可见高亮与金额都从保守档起步。
      const presetRestore = wasReset ? 'min' : this.data.raisePreset;
      // 自定义下注面板的上下限：MAX = 全下金额（raiseTo 可达上限），最小值由合法下注决定
      const raiseMin = (isMyTurn && legal) ? legal.minRaiseTo : 0;
      const raiseMax = (isMyTurn && legal) ? legal.maxRaiseTo : 0;
      // B5（玩家审视 2026-10-17）：滑杆步进自适应。
      // 原步进恒 = 小盲（默认 10），深筹局（如 max 3000）要拖 300 格——滑杆根本
      // 不可用。步进 = max(小盲, ceil(区间跨度/120))：滑杆拖格数封顶 ≈ 120，
      // 小额局（跨度 < 1200）仍保持小盲精度不变。盲注吸附语义交给
      // snapToBlind（失焦/± 按钮/滑杆 onRaiseSlider 内），步进变粗只是调值
      // 粒度变化，「金额永不为零头」的舱壁不受影响。
      const raiseStep = isMyTurn
        ? Math.max(this.blindStep(), Math.ceil((raiseMax - raiseMin) / 120))
        : 0;
      // 非我回合 / 不可加注时收起自定义面板，避免残留数值误导。
      // 重置帧（新一手 / 换街 / 跟注额变化）一律强制收起：上一手展开的面板
      // 不得跨手残留（好友房镜像端同理）；也不再按记忆自动展开。
      const raiseCustom = wasReset
        ? false
        : (isMyTurn && legal && legal.canRaise ? this.data.raiseCustom : false);
      // 档位条只在「轮到我且真的可以加注」时显示。只能跟注/全下时（canRaise=false：
      // 筹码不足，或被不足额全下封锁）档位没有任何意义，留着只会显示一个点不动的
      // 高亮（真机「高亮 50% 却只能跟注」）。JS 预计算，避免 WXML 写复合逻辑。
      const showPresets = !!(isMyTurn && legal && legal.canRaise && !raiseCustom);
      // 实际会提交的加注额（与 onRaise 钳制同口径，仅用于按钮文案）：
      // 数字输入框能填出低于下限的值，而失焦补正未必先触发；到达上限则等价全下。
      // ⚠️ 读 raiseTo（上面算好的局部量）而非 this.data.raiseTo：每手重置帧
      // data 里还是上一手旧值，直接读会让按钮文案与档位高亮对不上。
      let raiseSubmit = 0, raiseAllIn = false;
      if (isMyTurn && legal && legal.canRaise) {
        raiseSubmit = Math.max(legal.minRaiseTo, Math.round(raiseTo || 0));
        raiseAllIn = raiseSubmit >= legal.maxRaiseTo;
      }
      // ⚠️ 高亮与金额必须「每帧同源」（2026-10-19 第三次复发修复）。
      // 只在「重置帧」重算有一个致命漏洞：重置帧可能发生在「不是我的回合」
      // （新一街前位对手先下注 → street/currentBet 变、actionSeat 不是我）：
      // 旧实现里高亮按 C7 记忆恢复成 p50，但金额因 isMyTurn=false 没算（仍为 0）；
      // 等轮到我时 epoch 不再变化、wasReset=false，金额被钳回 minRaiseTo，
      // 于是又出现「高亮 50% + 加注=最小」的矛盾态（真机截图实锤）。
      // 修法：只要轮到我且可加注，每帧都按当前高亮档、用本帧最新 legal 重算
      // 金额；自定义档保留玩家手感，只做合法区间钳制。
      let presetFinal = presetRestore;
      if (isMyTurn && legal && legal.canRaise) {
        if (presetFinal !== 'custom') {
          const t = this.presetTarget(presetFinal, legal);
          if (t !== null) {
            raiseTo = t;
          } else {
            // 当前街无此档（理论上 presetFinal 已按街校验过）→ 回落最小，高亮同步
            presetFinal = 'min';
            raiseTo = legal.minRaiseTo;
          }
        } else {
          const v = Math.round(raiseTo || this.data.raiseTo || 0);
          raiseTo = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, v));
        }
        raiseSubmit = Math.max(legal.minRaiseTo, Math.round(raiseTo || 0));
        raiseAllIn = raiseSubmit >= legal.maxRaiseTo;
      }
      // C2（玩家审视 2026-10-17）：加注按钮动词按街内是否有注区分——
      // 无人下过注（toCall===0）时是「下注 X」而非「加注到 X」（翻后首位
      // 开池说「加注」是错误术语）。派生输入 legal.toCall 已随 legal 进指纹。
      const raiseVerb = (isMyTurn && legal && legal.canRaise && legal.toCall === 0)
        ? '下注' : '加注';
      // C4（玩家审视 2026-10-17）：池比展示——跟注 X مقابل 池比 1:Z。
      // Z = (pot + toCall) / toCall（含我补齐后的总池），纯算术、不含任何
      // 建议/胜率成分，合规上等同展示底池数字。保留 1 位小数（2.5 这类
      // 中间值对跟注/弃牌边线判断有信息量）。只在有注可跟时显示。
      let potOddsText = '';
      if (isMyTurn && legal && legal.toCall > 0) {
        const pot = game.potTotal();
        const z = (pot + legal.toCall) / legal.toCall;
        potOddsText = '跟注 ' + legal.toCall + ' · 池比 1:' + (z >= 10 ? Math.round(z) : +z.toFixed(1));
      }

      const curPlayer = game.actionSeat >= 0 ? game.seatOf(game.actionSeat) : null;

      this.setData({
        handNo: game.handNo,
        streetCn: readyPhase ? '等待下一局' : P.STREET_CN[game.street],
        pot: readyPhase ? 0 : game.potTotal(),
        sidePots,
        board,
        boardPlaceholders: placeholdersArr,
        seats,
        legal,
        raiseTo,
        raiseMin,
        raiseMax,
        raiseStep,
        raiseCustom,
        // 加注档位按街重建（翻前 BB 语言 / 翻后池比例语言）。g.street 已入渲染指纹，
        // 切街自然触发重算；镜像端 loadSnapshot 恢复 street 后同路径生效。
        raisePresets: this.presetsForStreet(game.street),
        // 档位高亮与金额必须同帧写入同一个 setData：分两次写会出现
        //「高亮已回『最小』但金额还是上一手」的中间态被渲染出来。
        // 重置帧一律回 'min'（2026-10-19 取消 C7 记忆）；非重置帧保持玩家当前选择。
        // presetTarget 兜底失败回落最小也反映在这一帧。
        raisePreset: presetFinal,
        // 档位条可见性（可加注才显示）：与 raisePreset 同帧写入，避免
        // 「高亮已出、按钮却不能加注」的中间态。
        showPresets,
        raiseSubmit,
        raiseAllIn,
        raiseVerb,
        potOddsText,
        isMyTurn,
        // 非我回合时自动解除弃牌确认态（下一手/对手行动后不再误触发）
        foldConfirm: isMyTurn ? this.data.foldConfirm : false,
        myStanding: standing,
        mySeated: mySeated,
        canStand: canStand,
        // B3 好友房补筹常驻按钮：入座真人、本手未在观战、还有补筹空间即可见。
        // 派生输入 mode/isHuman/sittingOut/stack/standing/mySeated 全在指纹内。
        canRebuy: this.mode === 'friend' && !!me && !!me.isHuman && !me.sittingOut &&
                  !standing && mySeated && me.stack < REBUY_CAP,
        // B3 规则 3 的可见反馈：本手已申请的补筹额（下一手生效），筹码数字旁
        // 「待补 +N」角标。镜像端在快照回来前由 _myRebuyPending 本地顶着。
        myRebuyAdd: (this._myRebuyPending && game &&
          this._myRebuyPending.hand === game.handNo && this._myRebuyPending.add > 0)
          ? this._myRebuyPending.add : 0,
        // 我的区域（底部）
        myCards,
        myHandName,          // 当前牌型名（翻牌后才有；新手「我这是什么牌」的答案）
        myHandTier,          // 起手牌档位 1..5（翻前用于配色；翻牌后为 0）
        myStack: meP ? meP.stack : 0,
        // myzone 显示用紧凑格式（与座位环同口径）。myStack 保持数字——
        // 结算/补筹等数值口径照旧读 myStack，不受显示格式影响。
        myStackText: meP ? this.fmtStack(meP.stack) : '',
        // 实时盈亏面板（菜单「我的筹码」）：带入 / 剩余 / 盈亏三项，随每帧渲染刷新
        myBuyIn: myBuyIn,
        myNetLive: myNetLive,
        myNetLiveText: myNetLive > 0 ? '+' + myNetLive : String(myNetLive),
        myBet: meP ? meP.bet : 0,
        myFolded: meP ? !!meP.folded : false,
        myActive: game.actionSeat === this.mySeat && !result,
        myTimer: game.actionSeat === this.mySeat ? tick : '',
        myTimerPct: game.actionSeat === this.mySeat ? Math.round(tick / tickMax * 100) : 0,
        // 轮到我最后 5s：行动条整体紧迫脉冲（与座位计时环 timerUrgent 同阈值）
        myTimerUrgent: game.actionSeat === this.mySeat && !result && tick <= 5 && tick > 0,
        myDealer: game.dealerSeat === this.mySeat,
        mySB: game.sbSeat === this.mySeat,
        myBB: game.bbSeat === this.mySeat,
        myActText: myActText,
        myActCls: myActCls,
        currentPlayerName: curPlayer ? curPlayer.name : '',
        result: result ? this.buildResult(result) : null,
        // 超时上限随模式入 setData（remote 30s / 单机 20s）——timerPct 的分母，
        // 也让 wxml/测试可读；数值由 this.timerMax() 派生，不进指纹（模式不变即常量）
        timerMax: tickMax,
        // 结算清空时同步收起弹窗（新一手/回等待室），有结算时保留现状
        resultModal: result ? this.data.resultModal : null,
        // P0-1：AI 桌输光/练习模式提示（已入指纹，见上）
        myAIBusted: myAIBusted,
        aiUnlimitedTip: aiUnlimitedTip,
        // P1-7：底部我的筹码区下的 VPIP 小字（已入指纹，见上）
        myVpipPct: (this.mode === 'ai') ? myVpipPct : ''
      });
      // 主 setData 成功 → 现在置位指纹。异常帧（走下面 catch）不更新 _lastRenderFp，
      // 下一帧同势 render 会重试，降级态不致卡死。
      this._lastRenderFp = fp;

      this.renderAdvice(isMyTurn);
    } catch (e) {
      // 降级渲染：清掉可能半更新的座位/公共牌，保住基本框架，引擎照常推进
      console.error('[table] render 异常，已降级本帧', JSON.stringify({
        stage: 'render', mySeat: this.mySeat, message: e && e.message, stack: e && e.stack
      }));
      try {
        this.setData({
          seats: [], board: [], boardPlaceholders: [], sidePots: [],
          legal: null, isMyTurn: false, myActive: false, advice: {}
        });
      } catch (e2) { /* 连降级都失败时放弃本帧 */ }
    }
    this._renderTail();
  },

  /** render 末尾的调度：结算弹窗时序 + 房主广播（指纹跳过时也要执行，防漏调度） */
  _renderTail() {
    // 结算展示调度（本地端与镜像端统一走这里）：
    // 摊牌亮牌先在牌桌上停留 RESULT_SHOW_MS 让各家牌面完整可见，之后**自动弹出**
    // 「每人盈亏」结算弹窗；弹窗停留 RESULT_MODAL_MS 自动关闭并进入就绪阶段
    // （防无人操作卡局）。就绪条上另留「查看结算」入口可随时回看明细。
    // 每手只调度一次（resultModalHand 守卫，防镜像端 2s 轮询重复挂表、重弹）。
    if (game && game.result && !this.data.readyPhase && !this.data.timeUp &&
        this.resultModalHand !== game.handNo) {
      this.resultModalHand = game.handNo;
      this.clearResultTimer();
      this.resultTimer = setTimeout(() => {
        this.resultTimer = null;
        this.showResultModal();   // 镜像端仅开弹窗，就绪阶段以房主广播为准
      }, this.resultShowMs || RESULT_SHOW_MS);
    }
    // 房主端：每次渲染后节流广播最新状态，好友端 1.5s 内看到
    this.publishPlay();
    // 氛围副作用：筹码飞行/粒子/连胜/表情清场。放最后——
    // 即便它自身异常也不影响结算调度与广播（renderAmbience 内部已自捕获）。
    this.renderAmbience();
  },

  /* ==================== 牌桌互动与氛围 ====================
   * 设计：docs/plans/2026-10-15-table-interaction-design.md
   * 统一收口在一个渲染段——render 主体只算牌局数据，氛围副作用
   * （筹码飞行/星光粒子/连胜徽章/表情气泡）由 renderAmbience 驱动：
   *   · 本地端与镜像端共用；输入 = 上一帧快照 diff（render 前缓存）；
   *   · 全部动 transform/opacity，animOn=false 时只更新数字不挂动画。
   */

  /** render 开头调用：缓存本帧基线（筹码飞行与粒子靠相邻两帧 diff 触发）。
   *  必须在 render 主体读完 game 之后、任何 setData 之前调用。 */
  _snapBaseline() {
    if (!game) return;
    this._base = {
      handNo: game.handNo,
      street: game.street,
      pot: game.potTotal(),
      bets: game.players.map(p => ({ seat: p.seat, bet: p.bet, folded: !!p.folded })),
      stacks: game.players.map(p => ({ s: p.stack })).map(x => x.s),
      lastBetBy: (game.events || []).length ? game.events[game.events.length - 1] : null
    };
  },

  /**
   * 氛围渲染：比对上一帧缓存的注额/池/结果，触发四类动画。
   * 只在被 _renderTail 调用的路径上跑（本地端与镜像端 render 末尾统一进）。
   */
  renderAmbience() {
    try {
      if (!game || this.data.phase !== 'playing') return;
      const prev = this._prevBase;   // 上一帧缓存的基线（首帧 null → 不触发飞行）
      const now = {
        handNo: game.handNo,
        street: game.street,
        pot: game.potTotal(),
        result: game.result || null,
        actionSeat: game.actionSeat,
        cat: this._resultHandCat()
      };
      const result_fresh = now.result && prev && !prev.result;

      // ---- ① 下注筹码飞行：座位 → 底池（谁 bet 变大谁飞）----
      if (prev && prev.handNo === now.handNo && this.data.animOn) {
        const prevBets = {};
        prev.bets.forEach(b => { prevBets[b.seat] = b.bet; });
        game.players.forEach(p => {
          const before = Number(prevBets[p.seat]) || 0;
          if (p.bet > before) this._spawnFlyOut(p.seat, now.pot);
        });
      }

      // ---- ①' 归池飞行 + 底池脉冲：换街帧触发（#14 批三）----
      // 引擎 collectBets 把各家 bet 清零归池的瞬间，旧体验是座位注额胶囊
      // 集体凭空消失、底池数字跳大，玩家看不懂「钱去哪了」。这里对上一帧
      // 还在桌上的每份 bet 再放一波 fly-out 到 POT_ANCHOR——「桌面注码滑进
      // 底池」的因果画面，底池胶囊同时脉冲一下呼应数字跳变。弃牌者的注
      // 也归池，全飞（座位灰显下飞出的暗淡筹码反而真实）。与 ① 分工：
      // ① 是下注即时反馈（筹码推到面前），①' 是收注入池结算（真桌隐喻）。
      if (prev && prev.handNo === now.handNo && prev.street !== now.street && this.data.animOn) {
        prev.bets.forEach(b => { if (b.bet > 0) this._spawnFlyOut(b.seat, now.pot); });
        this.setData({ potPulse: true });
        this.potPulseBorn = Date.now();
      }

      // ---- ② 收池筹码飞行：底池 → 赢家 + 金光脉冲（结算瞬间触发）----
      if (this.data.animOn && result_fresh) {
        const winners = now.result ? now.result.winners || [] : [];
        winners.forEach(s => this._spawnFlyHome(s));

        // ---- ③ 大牌星光粒子：赢家成手 ≥ 顺子 ----
        if (now.result && now.cat >= BIG_HAND_MIN) {
          winners.forEach(s => this._spawnSpark(s));
        }
        // 胜者金光脉冲座位标记（render 时由 cls 内联消费，故用实例字段而非 data——
        // setData 是异步的，render 内读 this.data.winFx 会拿到上一帧的值）
        this._winFxSeats = winners.slice();
        this.setData({ winFx: winners.join(',') });
      }

      // ---- ④ 连胜徽章 + 表情气泡清场 ----
      if (result_fresh && now.result) this._bumpStreaks(now.result);

      // 表情气泡到期清场：每帧顺带清理（渲染本身高频，无需独立定时器）
      const liveEmotes = (this.data.emotes || []).filter(
        e => Date.now() - e.bornAt < EMOTE_BUBBLE_MS
      );
      if (liveEmotes.length !== (this.data.emotes || []).length) this.setData({ emotes: liveEmotes });
      // 星光粒子到期清场
      if (this.data.spark && Date.now() - this.sparkBorn > 2600) this.setData({ spark: null });
      // 收池飞行到位后清场
      if (this.data.flyIn.length && Date.now() - this.flyInBorn > 1600) this.setData({ flyIn: [] });
      if (this.data.flyOut.length && Date.now() - this.flyOutBorn > 1200) this.setData({ flyOut: [] });
      // 底池脉冲到期清场（#14 批三，同 flyOutBorn 清场模式）
      if (this.data.potPulse && Date.now() - this.potPulseBorn > POT_PULSE_MS) this.setData({ potPulse: false });
    } catch (e) { /* 氛围异常绝不影响牌局（与音效同口径静默） */ }
    // 下一帧的基线在本 render 主体开头已由 _snapBaseline 刷新
  },

  /** 结算结果的赢家最高牌型档（0..8）。fold 结算无 evals → 返回 0（不触发粒子）。 */
  _resultHandCat() {
    if (!game || !game.result) return 0;
    const evals = game.result.evals;
    if (!evals) return 0;
    let cat = 0;
    game.result.winners.forEach(s => {
      const e = evals[s];
      if (e) cat = Math.max(cat, HAND_NAME_TO_CAT[e.name] || 0);
    });
    return cat;
  },

  /** 座位坐标 → felt 内百分比（筹码飞行起/终点）。带缓存，同帧同 seat 复用。
   *  落点常量 POT_ANCHOR 见文件头（C5：与 .pot-row top 同源）。 */
  _fxPos(seat) {
    // ⚠️ 必须与 render 用同一套座位集（房间全部座位，含空位）：
    // 只传 game.players 会让 ringPositions 按「在座人数」算角度，与渲染
    // 按「房间座位数」算出的坐标不一致 → 筹码飞行起点偏移（2026-10-21 修）。
    const allSeats = [];
    for (let si = 0; si < this.maxSeats; si++) allSeats.push(si);
    game.players.forEach(p => { if (allSeats.indexOf(p.seat) < 0) allSeats.push(p.seat); });
    allSeats.sort((a, b) => a - b);
    const pos = ringPositions(allSeats, this.mySeat, this.feltUh);
    const pp = pos[seat] || { x: 50, y: 40 };
    return pp;
  },

  /** 下注飞行：生成 5~7 枚筹码从座位飞向中央底池（错峰 delay）。 */
  _spawnFlyOut(seat, pot) {
    flySeed++;
    const from = this._fxPos(seat);
    const n = 5 + (Math.abs(flySeed) % 3);   // 5~7 枚
    const chips = [];
    // dx/dy = 底池锚点 − 座位坐标，作为 transform 位移量（vw/vh 口径，
    // 见 wxss @keyframes flyChip：translate(calc(var(--dx)*1vw),calc(var(--dy)*1vh))）。
    // 座位环均在 felt 内，felt 宽≈100vw，故 x 方向 vw 与 felt% 近似；y 方向 felt
    // 高<100vh，位移会略过冲，但 opacity 在到位前已淡出（氛围特效不追求精确落点）。
    for (let i = 0; i < n; i++) {
      chips.push({
        x: from.x, y: from.y,
        dx: +(POT_ANCHOR.x - from.x).toFixed(1), dy: +(POT_ANCHOR.y - from.y).toFixed(1),
        delay: i * 0.04, key: 'o' + flySeed + '_' + i
      });
    }
    this.setData({ flyOut: this.data.flyOut.concat(chips) });
    this.flyOutBorn = Date.now();
  },

  /** 收池飞行：底池 → 赢家座位。 */
  _spawnFlyHome(seat) {
    flySeed++;
    const to = this._fxPos(seat);
    const n = 6;
    const chips = [];
    for (let i = 0; i < n; i++) {
      chips.push({
        x: POT_ANCHOR.x, y: POT_ANCHOR.y,
        tx: +to.x.toFixed(1), ty: +to.y.toFixed(1),
        delay: i * 0.05, key: 'i' + flySeed + '_' + i
      });
    }
    this.setData({ flyIn: this.data.flyIn.concat(chips) });
    this.flyInBorn = Date.now();
  },

  /** 大牌星光粒子：胜者座位上方 20 粒随机散布（贴图 assets/spark.png）。 */
  _spawnSpark(seat) {
    flySeed++;
    const at = this._fxPos(seat);
    const pts = [];
    for (let i = 0; i < 20; i++) {
      pts.push({
        seat,                                  // wxml 按 seat 归属到座位节点上渲染
        bx: +at.x.toFixed(1), by: +at.y.toFixed(1),   // 基准座位坐标（wxml 按 item 匹配）
        x: +(at.x + (Math.random() * 24 - 12)).toFixed(1),
        y: +(at.y + (Math.random() * 16 - 8)).toFixed(1),
        d: +(Math.random() * 1.2).toFixed(2),       // 动画 delay
        s: +(0.6 + Math.random() * 0.9).toFixed(2), // 缩放
        key: 's' + flySeed + '_' + i
      });
    }
    this.setData({ spark: pts });
    this.sparkBorn = Date.now();
  },

  /** 连胜维护：本手赢家 +1，其余清零；≥2 手的显示 🔥xN 徽章。startHand 清零不入此。 */
  _bumpStreaks(result) {
    const winners = {};
    (result.winners || []).forEach(s => { winners[s] = true; });
    const streaks = {};
    game.players.forEach(p => {
      const w = winners[p.seat];
      const n = w ? (winStreaks[p.seat] || 0) + 1 : 0;
      winStreaks[p.seat] = n;
      streaks[p.seat] = (n >= WIN_STREAK_MIN) ? ('🔥 x' + n) : '';
    });
    this.setData({ streaks });
  },

  /**
   * 高光时刻判定（结算时调，返回 {type, streak} 或 null）。
   * 判定依赖：game.result.evals/winners（结算态）、winStreaks（已被 _bumpStreaks 更新）、
   * 本手 events（诈唬判定需推断翻后是否有 raise/allin，action 事件无 street 须自己跟踪）。
   * 优先级：皇家同花顺 > 四条 > 连胜5 > 诈唬成功（一手只存最高级别一档，避免重复入档）。
   */
  _detectHighlight() {
    if (!game || !game.result) return null;
    const mySeat = this.mySeat;
    const r = game.result;
    const winners = r.winners || [];
    const iWon = winners.indexOf(mySeat) >= 0;
    const evals = r.evals || {};
    const me = evals[mySeat];
    const handName = me && me.name;

    // 皇家同花顺：摊牌且我赢、成手为皇家同花顺
    if (r.type === 'showdown' && iWon && handName === '皇家同花顺') {
      return { type: 'royal_flush', streak: 0 };
    }
    // 四条：摊牌且我赢、成手为四条
    if (r.type === 'showdown' && iWon && handName === '四条') {
      return { type: 'quads', streak: 0 };
    }
    // 连胜 5 局：winStreaks 模块级，_bumpStreaks 刚更新过
    const streak = winStreaks[mySeat] || 0;
    if (iWon && streak >= HIGHLIGHT_STREAK) {
      return { type: 'streak5', streak };
    }
    // 诈唬成功：非摊牌（对手全弃我独赢）且本手我有翻后（非 preflop）raise/allin。
    // action 事件无 street 须按 type:'street' 推断当前街（与 style-analyzer/replay 同法）。
    if (r.type !== 'showdown' && iWon) {
      let curStreet = 'preflop';
      let bluffed = false;
      // 切本手 events（从最后一个 hand_start 起）
      let lastStart = -1;
      for (let i = (game.events.length - 1); i >= 0; i--) {
        if (game.events[i].type === 'hand_start') { lastStart = i; break; }
      }
      for (let i = Math.max(0, lastStart); i < game.events.length; i++) {
        const e = game.events[i];
        if (!e) continue;
        if (e.type === 'street') { curStreet = e.street; continue; }
        if (e.type !== 'action' || e.seat !== mySeat) continue;
        if (curStreet !== 'preflop' && curStreet !== 'showdown') {
          if (e.action === 'raise' || e.action === 'allin') bluffed = true;
        }
      }
      if (bluffed) return { type: 'bluff_success', streak: 0 };
    }
    return null;
  },

  /* ---------- 表情互动：轮盘 + 气泡 ---------- */

  /** 点座位头像（游戏中任意座位、等待室不弹——那里头像承担选座职责）。
   *  AI 局直接本地冒泡；好友房经 emote 动作上行，房主消化后随快照广播，
   *  镜像端（含发送者本人）从广播渲染——保证每台设备同一时刻看到同一表情。
   *  站起观战者同样可发（设计 §2.4 观战者互动）。 */
  onAvatarTap(e) {
    const seat = Number(e.currentTarget.dataset.seat);
    if (isNaN(seat) || seat < 0) return;
    // 批⑥：长按触发 onAvatarLongPress 后仍可能冒泡一次 tap（微信 longpress 不阻断
    // 后续 tap），用短时标记拦住——长按后短时间内来的 tap 当作误触跳过，不弹表情轮盘。
    if (this._longPressFlag) { this._longPressFlag = false; return; }
    this.setData({ emoteShow: true, emoteSeat: seat });
  },

  /**
   * 批⑥：长按头像弹「对手画像」角色卡。
   * 仓库首个 longpress。AI 对手显示固定角色档案（性格/打法/马脚/本局统计）；
   * 真人好友对手无固定档案，只显示本局统计。空位不长按。
   */
  onAvatarLongPress(e) {
    const seat = Number(e.currentTarget.dataset.seat);
    if (isNaN(seat) || seat < 0) return;
    this._longPressFlag = true;   // 拦住紧随其后的 tap（防误弹表情轮盘）
    const data = this._computeOppCard(seat);
    if (!data) return;
    this.setData({ oppCardShow: true, oppCardData: data });
  },

  /** 关对手画像角色卡 */
  onOppCardClose() {
    if (this.data.oppCardShow) this.setData({ oppCardShow: false, oppCardData: null });
  },

  /**
   * 构造对手画像角色卡数据。
   *  - AI 对战（mode==='ai'）：按机器人序号查 botProfiles.profileFor，取性格/打法/马脚；
   *    打法风格条用纯 CSS width 百分比静态赋值（无 canvas、无 transition）。
   *  - 好友房真人：无固定档案，name 取座位显示名，性格/马脚留空，仅展示本局统计。
   *  本局统计从 game.events 切本手（最后一个 hand_start 之后）调 analyzeOpponent。
   */
  _computeOppCard(seat) {
    if (!game) return null;
    const p = game.seatOf(seat);
    if (!p) return null;
    // 判机器人序号（同 scheduleAI 口径：小于等于本座位的 Bot 数 - 1）
    const isAiBot = this.mode === 'ai' && this.botSeats[seat];
    let botIdx = -1;
    if (isAiBot) {
      botIdx = Math.max(0, game.players.filter(x => this.botSeats[x.seat] && x.seat <= seat).length - 1);
    }
    const profile = botIdx >= 0 ? botProfiles.profileFor(botIdx) : null;
    // 打法风格条：6 字段 → 百分比（纯 CSS width 静态赋值，无 transition/keyframes）
    const styleBars = profile ? this._buildStyleBars(profile.style) : [];
    const tellHints = profile ? botProfiles.tellHints(profile) : [];
    // 本局统计：切本手 events
    const oppStats = this._computeOppStats(seat);
    return {
      name: p.name || (this.mode === 'friend' ? '好友' : '对手'),
      initial: (p.name || '?').slice(0, 1),
      trait: profile ? profile.trait : '',
      desc: profile ? profile.desc : '真人好友 · 无固定角色档案',
      isBot: !!profile,
      styleBars,
      tellHints,
      oppStats
    };
  },

  /** 把 style 6 字段转风格条数组（每项 {label, pct}），pct = 字段值*100 取整。 */
  _buildStyleBars(style) {
    if (!style) return [];
    return [
      { label: '激进', pct: Math.round((style.aggro || 0) * 100) },
      { label: '紧度', pct: Math.round((style.tight || 0) * 100) },
      { label: '诈唬', pct: Math.round((style.bluffFreq || 0) * 100) },
      { label: '英雄跟', pct: Math.round((style.heroCall || 0) * 100) },
      { label: '慢打', pct: Math.round((style.slowplay || 0) * 100) }
    ];
  },

  /** 切本手 events 调 analyzeOpponent 算单对手单局统计。 */
  _computeOppStats(seat) {
    if (!game || !game.events) return null;
    const evs = game.events;
    // 找最后一个 hand_start（本手起点）
    let lastStart = -1;
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i] && evs[i].type === 'hand_start') { lastStart = i; break; }
    }
    if (lastStart < 0) return null;
    const handEvs = evs.slice(lastStart);
    return styleAnalyzer.analyzeOpponent(handEvs, seat);
  },

  /** 关表情轮盘（点遮罩/选完都走这里） */
  onEmoteClose() {
    if (this.data.emoteShow) this.setData({ emoteShow: false, emoteSeat: -1 });
  },

  /** 轮盘选表情：本地即时冒泡（频控 3s/座位）+ 好友房上行广播。
   *  上行失败静默降级（体验功能，不弹错不重试——与牌局关键上行不同）。 */
  onEmotePick(e) {
    const emoji = e.currentTarget.dataset.e;
    const seat = this.data.emoteSeat;
    this.setData({ emoteShow: false, emoteSeat: -1 });
    if (EMOTE_SET.indexOf(emoji) < 0) return;   // 渲染白名单外的非法值直接丢
    if (seat < 0) return;
    // 频控：同一座位 3s 内只放一条
    const now = Date.now();
    if (now - (lastEmoteAt[seat] || 0) < EMOTE_THROTTLE_MS) return;
    lastEmoteAt[seat] = now;
    this._showEmoteBubble(seat, emoji);
    if (this.mode === 'friend' && this.syncLive && this.roomNo) {
      const payloadSeat = this.remoteMode ? this.roomSeat : this.mySeat;
      roomSync.pushAction(this.roomNo, { type: 'emote', seat: payloadSeat, emoji })
        .catch(() => { /* 静默降级：本地已冒泡，失败不提示（氛围功能非关键路径） */ });
    }
  },

  /** 本地冒泡（每座位同时只留 1 个，新顶旧） */
  _showEmoteBubble(seat, emoji) {
    const emotes = (this.data.emotes || []).filter(e => e.seat !== seat);
    emotes.push({ seat, emoji, bornAt: Date.now(), key: 'e' + (++flySeed) });
    this.setData({ emotes });
  },

  /** 观战快捷语入口（P3 落地）：点头像轮盘里的「快捷语」区，复用聊天面板的
   *  onQuickChat 通道——本地进面板 + 好友房 type:'chat' 上行广播，与表情同通道。
   *  发送目标座位用轮盘选中的 emoteSeat（点了谁的头像就发给谁那桌的聊天区），
   *  但快捷语本身是全桌广播聊天，seat 字段仍是我自己的座位（payload seat=roomSeat）。
   *  这里只关轮盘并触发一条快捷语；文案固定取 QUICK_TALK[0]，避免引入额外 UI 选择态。 */
  onEmoteTalk() {
    const seat = this.data.emoteSeat;
    this.onEmoteClose();
    if (seat < 0) return;
    this.onQuickChat({ currentTarget: { dataset: { t: QUICK_TALK[0] } } });
  },

  /** 牌 ID → 渲染数据（花色配色：四色牌时 ♠黑 / ♣绿 / ♦蓝 / ♥红） */
  cardData(card, idx) {
    // 缓存牌面基对象（rank/suit/cls/code 仅由 card id 决定，无副作用）。
    // hi 由 markBest 在摊牌后原地写入，故命中缓存时必须浅克隆返回——否则
    // markBest 改 c.hi 会污染缓存，下一帧 hi 残留为旧值。克隆仅 5 属性，比重算省。
    const key = card + ':' + (idx || 0);
    if (this._cardCache && this._cardCache[key]) {
      return Object.assign({}, this._cardCache[key]);
    }
    const s = P.suitOf(card);
    const d = {
      idx: idx || 0,                 // 供 wx:key 使用的稳定键
      code: P.cardToCode(card),      // 摊牌时用于判断是否属于最佳成手 5 张（机读码，恒为 "Th" 形式）
      hi: false,                     // 是否属于最佳 5 张（摊牌高亮）
      rank: P.RANK_DISPLAY[P.rankOf(card)],   // 界面显示文本（10 显示 "10"，非 "T"）
      suit: P.SUIT_CHARS[s],
      cls: SUIT_CLS[s]
    };
    this._cardCache = this._cardCache || {};
    this._cardCache[key] = d;
    return d;
  },

  /** 摊牌时把「最佳成手 5 张」标出来：传入 code 集合，给牌数据打 hi 标记 */
  markBest(cards, bestSet) {
    if (!bestSet) return cards;
    return cards.map(c => {
      c.hi = bestSet.has(c.code);
      return c;
    });
  },

  /** 操作反馈：震动（音效由 sfx 事件泵按动作类型精确发声，这里不再叠 click） */
  feedback() {
    if (this.data.vibrateOn && wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  },

  // ---------- 音效：引擎事件流 → 合成音（utils/sfx.js） ----------

  /** 启动音效事件泵（300ms 轮询；声音开关在 drainSfx 内逐次判断，切换即时生效） */
  startSfxPump() {
    this.stopSfxPump();
    this.sfxPump = setInterval(() => {
      try { this.drainSfx(); } catch (e) { /* 音效绝不影响牌局 */ }
    }, 300);
  },

  stopSfxPump() {
    if (this.sfxPump) { clearInterval(this.sfxPump); this.sfxPump = null; }
  },

  /**
   * 消化引擎事件流（game.events，seq 单调递增）→ 音效：
   *   hand_start/deal → 发牌　action(fold/check/call/raise/allin) → 对应动作音
   *   hand_end → 我赢 = 胜利琶音，否则中性收尾音。
   * 「轮到我」提示不依赖 turn 事件（镜像端事件流为空），统一用 isMyTurn
   * 的 false→true 边沿检测——本地端与镜像端行为一致。
   * 快照续局/镜像重建会把 events 重置，序号超界时回收敛到当前长度（不补播历史音）。
   */
  drainSfx() {
    if (this.data.phase !== 'playing') return;
    const events = (game && game.events) || [];
    if (this.sfxSeq > events.length) this.sfxSeq = events.length;   // 重建后收敛
    // C6（玩家审视 2026-10-17）：轮到我行动的 false→true 边沿移到 soundOn 分支外——
    // 静音模式下同样把遮挡座位的聊天浮层收起（浮层遮挡对操作是实打实的伤害，
    // 与声音无关）。边沿用 this.sfxWasMyTurn 记忆，两分支各自推进保持口径一致。
    const myTurn = !!this.data.isMyTurn;
    if (myTurn && !this.sfxWasMyTurn && !(game && game.result)) {
      if (this.data.soundOn) sfx.play('turn');
      if (this.data.chatOpen) this.setData({ chatOpen: false });   // 浮层掀起，行动条露出
    }
    this.sfxWasMyTurn = myTurn;
    if (this.data.soundOn) {
      while (this.sfxSeq < events.length) {
        const e = events[this.sfxSeq++];
        switch (e.type) {
          case 'hand_start':
          case 'deal':
            sfx.play('deal');
            break;
          case 'action':
            if (e.action === 'fold') sfx.play('fold');
            else if (e.action === 'check') sfx.play('check');
            else if (e.action === 'allin') sfx.play('allin');
            else if (e.action === 'raise') sfx.play('raise');
            else sfx.play('bet');          // call / 其他下注类
            break;
          case 'hand_end':
            sfx.play((e.winners || []).indexOf(this.mySeat) >= 0 ? 'win' : 'end');
            break;
          // turn 事件不在此处理：统一走上方 isMyTurn 边沿（镜像端也有）
        }
      }
    } else {
      this.sfxSeq = events.length;         // 静音模式也要推进序号，开声音后不补播
    }
  },

  /** 发送一条聊天 / 表情（seat === mySeat = 我主动发，不响提示音） */
  pushChat(seat, name, text) {
    const log = this.data.chatLog.slice();
    log.push({ id: ++this.chatSeq, seat: seat, name: name, text: text });
    while (log.length > 8) log.shift();
    const patch = { chatLog: log };
    // 聊天折叠时收到他人/AI 消息 → 累计未读，打开聊天面板时清零
    if (!this.data.chatOpen && seat !== this.mySeat) patch.chatUnread = (this.data.chatUnread || 0) + 1;
    this.setData(patch);
    // 收到他人/AI 消息时轻提示；我自己发的（快捷聊天/表情、我的站起/入局系统消息）不响
    if (this.data.soundOn && seat !== this.mySeat) sfx.play('chat');
  },

  /** 快捷语：本地即时进聊天面板 + 好友房上行广播（type:'chat'），房主消化后随快照
   *  广播给所有镜像端。上行失败静默降级（氛围功能，与 emote 同口径：不弹错不重试）。
   *  seat 上行用 roomSeat（云端座次），房主按 rowSeat 断言防伪冒——与 emote 同通道。 */
  onQuickChat(e) {
    const text = e.currentTarget.dataset.t;
    this.pushChat(this.mySeat, this.meLabel(false), text);
    this.feedback();
    if (this.mode === 'friend' && this.syncLive && this.roomNo &&
        CHAT_TEXT_SET.indexOf(text) >= 0) {
      const payloadSeat = this.remoteMode ? this.roomSeat : this.mySeat;
      roomSync.pushAction(this.roomNo, { type: 'chat', seat: payloadSeat, text })
        .catch(() => { /* 静默降级：本地已进面板，失败不提示（氛围功能非关键路径） */ });
    }
  },

  /** 表情快捷：与 onQuickChat 同通道（type:'chat'），emoji 亦过 CHAT_TEXT_SET 白名单。 */
  onEmoji(e) {
    const text = e.currentTarget.dataset.e;
    this.pushChat(this.mySeat, this.meLabel(false), text);
    this.feedback();
    if (this.mode === 'friend' && this.syncLive && this.roomNo &&
        CHAT_TEXT_SET.indexOf(text) >= 0) {
      const payloadSeat = this.remoteMode ? this.roomSeat : this.mySeat;
      roomSync.pushAction(this.roomNo, { type: 'chat', seat: payloadSeat, text })
        .catch(() => { /* 静默降级：本地已进面板，失败不提示（氛围功能非关键路径） */ });
    }
  },

  // ---------- 折叠面板（聊天 / 菜单）----------
  // 微扑克式：社区与次要操作默认折叠，主视觉只留牌桌 + 我的操作区
  toggleChat() {
    const opening = !this.data.chatOpen;
    // 打开聊天面板时清零未读（已读）
    this.setData({ chatOpen: opening, menuOpen: false, chatUnread: opening ? 0 : (this.data.chatUnread || 0) });
  },

  toggleMenu() {
    this.setData({ menuOpen: !this.data.menuOpen, chatOpen: false });
  },

  closePanels() {
    if (this.data.chatOpen || this.data.menuOpen) this.setData({ chatOpen: false, menuOpen: false });
  },

  /**
   * 菜单 →「我的筹码」：实时盈亏面板。
   * 展示带入 / 剩余 / 盈亏三项，数值与结算单逐字同源（都读 startStacks[mySeat]），
   * 所以玩家在局中看到的盈亏 == 结束时结算单上的盈亏。
   */
  onMenuBank() {
    this.setData({ menuOpen: false, bankShow: true });
    if (this.data.soundOn) sfx.play('click');
  },

  onBankClose() {
    this.setData({ bankShow: false });
  },

  onMenuHelp() {
    this.setData({ menuOpen: false, helpShow: true });
  },

  /** 牌桌内设置入口（⋯ 菜单）：即时生效，四色牌/音效/震动/动画/无限练习 */
  onMenuSettings() {
    const s = settings.get();
    this.setData({
      menuOpen: false,
      settingsShow: true,
      sFourColor: s.fourColor,
      sSound: s.sound,
      sVibrate: s.vibrate,
      sAnim: s.animation,
      sAiUnlimited: !!s.aiUnlimited
    });
  },

  onSettingsClose() {
    this.setData({ settingsShow: false });
  },

  /** 切换设置项并即时生效（四色牌/音效/震动/动画/无限练习） */
  onToggleSetting(e) {
    const key = e.currentTarget.dataset.k;
    const patch = {};
    if (key === 'fourColor') patch.fourColor = !this.data.sFourColor;
    if (key === 'sound') patch.sound = !this.data.sSound;
    if (key === 'vibrate') patch.vibrate = !this.data.sVibrate;
    if (key === 'animation') patch.animation = !this.data.sAnim;
    if (key === 'aiUnlimited') patch.aiUnlimited = !this.data.sAiUnlimited;
    const next = settings.set(patch);
    this.setData({
      sFourColor: next.fourColor,
      sSound: next.sound,
      sVibrate: next.vibrate,
      sAnim: next.animation,
      sAiUnlimited: !!next.aiUnlimited,
      // 即时生效：渲染用的派生字段同步刷新
      fourColor: next.fourColor,
      soundOn: next.sound,
      vibrateOn: next.vibrate,
      animOn: next.animation
    });
    // aiUnlimited 即时生效：下一手 startHand 补筹守卫读 this.aiUnlimited，同步切换
    if (key === 'aiUnlimited') this.aiUnlimited = !!next.aiUnlimited;
  },

  onMenuStand() {
    this.setData({ menuOpen: false });
    this.standUp();
  },

  onMenuSit() {
    this.setData({ menuOpen: false });
    this.sitDown();
  },

  onMenuBack() {
    this.setData({ menuOpen: false });
    this.onBack();
  },

  /** 新手引导：规则/下注轮次说明 */
  onHelp() {
    this.setData({ helpShow: true });
  },

  onHelpClose() {
    this.setData({ helpShow: false });
  },

  onCoachClose() {
    // 用户主动点掉 = 「我懂了」，本桌永久收起（与 doAct 里按手计数自然结束区分）。
    // 只在内存里记（不写 storage）：下一桌重新给新手提示，不把一次性意图永久化。
    this._coachDismissed = true;
    this.setData({ coachShow: false });
  },

  /** G5：分享卡摘要文案——只露「盈亏语气」不露桌码/对手名（与高光分享同口径） */
  buildResult(res) {
    // 结算行覆盖「所有投入过筹码的人」：含弃牌者（他们输掉的盲注/下注也要显示），
    // 每人给出净盈亏 net = 赢得 - 投入，输赢一目了然。muck 礼仪：非摊牌玩家
    // 不亮牌（真实牌桌你也不能逼人亮牌），「看全桌牌」上帝视角入口已于
    // 2026-10-17 撤销——与摊牌行信息重复，且镜像端依赖的 endHoles 透传
    // 一并退役（快照 hideHoles 边界不再显式化）。
    const rows = game.players
      .filter(p => p.committed > 0 || res.winners.indexOf(p.seat) !== -1)
      .map(p => {
        const rv = game.showdownReveal[p.seat];
        const win = res.winners.indexOf(p.seat) !== -1;
        const gain = res.awards.filter(a => a.seat === p.seat).reduce((s, a) => s + a.amount, 0);
        const net = gain - p.committed;
        // muck 礼仪（A4，2026-10-17）：弃牌者不亮牌——未摊牌且已弃牌时 holeTxt 置空，
        // 手牌列与胶囊短文都落「弃牌」文案。快照侧已同步掩码（弃牌者 hole=null），
        // 此处是 UI 侧兜底：房主本地 game.players 里弃牌者底牌仍在内存，若不遮，
        // 结算弹窗会把 mucked 牌明文打出来，与引擎快照的掩码语义不一致。
        const holeTxt = rv
          ? rv.hole.map(code => this.codeToStr(code)).join(' ')
          : (p.folded ? '' : p.hole.map(c => P.cardToStr(c)).join(' '));
        // 摊牌结算弹窗里的「手牌牌面」：默认只亮真正摊牌（rv 存在）的座位，
        // 弃牌者的牌不公开（muck 不亮牌，扑克通行礼仪），此时 cards 为空数组、
        // 由 .sr-cards 的固定宽度占位保持各行「牌型 / 盈亏」两列仍对齐。
        // hi 标记 = 该底牌参与了最佳成手 5 张（摊牌时金边高亮，便于看懂为什么赢）。
        const bestSet = (rv && rv.hand) ? new Set(rv.hand) : null;
        // 未摊牌/无 rv 的玩家 bestSet 为 null → bestIds 必须兜底空集。
        // 只判断 bestSet 是否真值，避免在「玩家有底牌但未摊牌」场景里 new Set(null) 抛错。
        const bestIds = bestSet
          ? new Set([...bestSet].map(code => P.codeToCard(code)).filter(id => id >= 0))
          : new Set();
        let cards = ((rv && rv.hole) ? rv.hole : [])
          .map((code, ci) => {
            const id = P.codeToCard(code);
            if (id < 0) return null;
            const d = this.cardData(id, ci);
            d.hi = !!(bestSet && bestSet.has(code));
            return d;
          })
          .filter(Boolean);
        return {
          seat: p.seat,
          name: p.name,
          icon: win ? '🏆 ' : '',
          // 手牌列：弃牌者 holeTxt 已置空 → 落「弃牌」占位（保持列不空、语义清晰）
          hand: rv ? holeTxt + ' → ' + rv.name : (holeTxt || (p.folded ? '弃牌' : '未摊牌')),
          cards,                    // 结算弹窗的迷你手牌（默认：弃牌为空）
          bestIds,                  // 该玩家参与最佳成手的牌 id 集——G2 公共牌行按行高亮
          // 结算条胶囊用的短文本：摊牌显示牌型名；弃牌/未摊牌给状态文案
          short: rv ? rv.name : (p.folded ? '弃牌' : (holeTxt || '未摊牌')),
          committed: p.committed,   // 本手总投入（飞筹动画的筹码量）
          isMe: p.seat === this.mySeat,   // 结算弹窗高亮我的行
          win,
          gain,
          net                       // 净盈亏：正 = 赢，负 = 输
        };
      });

    // G2（玩家审视 2026-10-17）：每行附公共牌条 = 本手翻牌/转牌/河牌 5 张全部显示，
    // 「该玩家参与最佳成手」的那几张公共牌打 hi——回答玩家最直觉的问题「他到底
    // 击中了公共牌的哪几张」。数据即 game.board 机读 id，过 cardData 克隆（防 hi
    // 残留污染缓存）。翻前弃牌局 board 为空 → 该行 board 为空数组，WXML 不渲染条；
    // 摊牌失败方/弃牌者 bestIds 为空 → 公共牌全亮但无高亮（muck 玩家无依据可标）。
    // G4（2026-10-17）：公共牌按街分桶——翻牌 0-2 / 转牌 3 / 河牌 4。新手对折起来
    // 的 5 张常分不清「转牌发的是哪一张」（而读牌故事恰恰靠讲街次）。桶标签只在
    // 确有该街时加入（翻前无人看牌 board 为空 → 三桶均空 → WXML 整段不渲染）。
    const boardIds = (game.board || []);
    // 单字标签（翻/转/河）：摊牌行要按列对齐，双字标签会把公共牌条撑到
    // 弹窗放不下（2026-10-17 布局收口）。街次语义靠顺序固定，单字足够。
    const streetLabels = ['翻', '转', '河'];
    // 每街的切片区间（闭区间末端）：flop=[0,3) turn=[3,4) river=[4,5)
    const streetRanges = [[0, 3], [3, 4], [4, 5]];
    rows.forEach(r => {
      const all = boardIds.map((id, i) => {
        const d = this.cardData(id, i + 100);   // idx +100 避开与底牌 hc 段同 key 撞缓存
        d.hi = r.bestIds.has(id); return d;
      });
      r.board = all;
      r.boardBuckets = streetRanges.map((rg, si) => ({
        label: streetLabels[si],
        cards: all.slice(rg[0], rg[1])
      })).filter(b => b.cards.length > 0);
    });

    // 我的座位可能因云端行滞后/他端换座而不在引擎里（seatOf 取不到），
    // 结算不能因此崩掉——缺失时按 0 投入兜底，战绩底牌留空。
    const me = game.seatOf(this.mySeat);
    const myGain = res.awards.filter(a => a.seat === this.mySeat).reduce((s, a) => s + a.amount, 0);
    const myLost = me ? Math.max(0, (me.committed || 0) - myGain) : 0;
    const won = res.winners.indexOf(this.mySeat) !== -1;

    // 准备上云的战绩记录
    this.pendingRecord = {
      tableId: this.roomNo || 'ai',
      handNo: game.handNo,
      seat: this.mySeat,
      hole: me ? me.hole.map(c => P.cardToCode(c)).join(' ') : '',
      board: game.board.map(c => P.cardToCode(c)).join(' '),
      handType: (game.showdownReveal[this.mySeat] && game.showdownReveal[this.mySeat].name) || (won ? '获胜' : '未中牌'),
      net: myGain - myLost,
      won
    };

    return {
      title: res.type === 'showdown' ? '摊牌结算' : '牌局结束',
      rows,
      netText: won ? '你赢得 ' + myGain + ' 筹码' : '你输掉 ' + myLost + ' 筹码',
      // G5（2026-10-17）：分享卡数据——与 highlight-store 同口径但标量级小，
      // 弃牌行也能分享（弃牌无 handName 时由调用方兜底「本手回顾」）。
      share: {
        handName: (game.showdownReveal[this.mySeat] && game.showdownReveal[this.mySeat].name) || '',
        summary: netTextSharedOf(res, myGain, myLost, won),
        myHole: me ? me.hole.map((c, i) => this.cardData(c, i)) : [],
        board: (game.board || []).map((c, i) => this.cardData(c, i + 200))   // +200 避开 hc/bc 段缓存 key
      }
    };
  },

  /** 战绩写入云端（失败不打断对局，仅提示） */
  async uploadRecord() {
    if (!this.pendingRecord) return;
    const rec = this.pendingRecord;
    this.pendingRecord = null;
    try {
      await auth.saveRecord(rec);
    } catch (err) {
      console.error('[table] 战绩上传失败', JSON.stringify({
        stage: 'save-record',
        message: err && err.message ? err.message : '未知错误'
      }));
      wx.showToast({ title: '战绩同步失败，不影响本局', icon: 'none' });
    }
  },

  /** 'As' → 'A♠'；'Th' → '10♥' */
  codeToStr(code) {
    // 解析仍按机读码（单字符点数）走，只有输出改用显示文本
    const r = P.RANK_NAMES.indexOf(code[0]);
    const s = P.SUIT_NAMES.indexOf(code[1]);
    return (r < 0 || s < 0) ? code : P.RANK_DISPLAY[r] + P.SUIT_CHARS[s];
  },

  renderAdvice(isMyTurn) {
    // 合规硬约束（README 第 0.3 节）：行动建议 = 实时外挂辅助，
    // 仅允许在「练习模式」（AI 对战/教学）输出；好友房与匹配对战必须关闭。
    // 引擎侧 advise() 同样有 practiceMode 开关双保险（服务器接入后以房间配置为准）。
    if (!isMyTurn || this.mode !== 'ai') {
      this._adviceKey = null;   // 离开我的回合即失效：回到我回合必然是新局势
      this.setData({ advice: {} });
      return;
    }
    // 缓存键（评审 2026-10-15 MEDIUM「每帧 1800 次蒙特卡洛」）：轮到我期间 render
    // 会被各种事件反复触发（AI 动作回调/setData 回流/前后台切换），而 my 牌面、
    // 公共牌、下注局势一个都不会变——1800 次蒙特卡洛每帧重算纯属白烧 CPU（低端
    // 机可感掉帧）。局势完全一致时直接复用上一次结果，两个附带收益：
    // 胜率数字不再在两次 render 间因 RNG 抖动；iters 也不虚标。
    const me = game.seatOf(this.mySeat);
    const key = [
      game.handNo, game.street, game.currentBet, game.potTotal(),
      game.activePlayers().length,
      me ? me.hole.join(',') : '', game.board.join(',')
    ].join('|');
    if (this._adviceKey === key) {
      // 同局势复用；万一 advice 被别处清掉（如降级渲染），用缓存补写回来
      const c = this._adviceResult;
      if (c && (!this.data.advice || !this.data.advice.text)) this.setData({ advice: c });
      return;
    }
    this._adviceKey = key;
    const a = P.advise(game, this.mySeat, { practiceMode: true });
    // advisor 教学提示（第二期）：起手牌分类（仅翻前）+ 各街牌理解释。
    // 纯客户端文案、不接 LLM、不重算胜率——输入完全由上面的缓存键覆盖（hole +
    // street + tone + equityPct 均在键内或键派生），故无需为 advisor 单独缓存：
    // 命中 _adviceKey 时 advice 已含 tip，未命中时随 P.advise 顺带算（开销可忽略）。
    const advBase = a ? {
      equityPct: a.equityPct,
      potOdds: a.potOdds,
      text: a.text,
      tone: a.tone,
      drawDesc: a.draws.outs > 0 ? a.draws.desc : '',
      drawOuts: a.draws.outs
    } : null;
    if (advBase) {
      const hole = me ? me.hole : [];
      const legal = game.legalActions(this.mySeat);
      const cls = advisor.classifyHole(hole);
      const expl = advisor.explainAdvice(advBase, {
        street: game.street,
        toCallZero: !!(legal && legal.toCall === 0)
      });
      // 翻前时 explain 前缀拼起手牌分类，让新手把胜率数字与「该不该玩」对应起来
      const prefix = (game.street === 'preflop' && cls) ? ('起手牌：' + cls.label + ' · ') : '';
      advBase.holeLabel = (game.street === 'preflop' && cls) ? cls.label : '';
      advBase.holeTag = (game.street === 'preflop' && cls) ? cls.tag : '';
      advBase.explain = prefix + expl.tip;
    }
    this._adviceResult = advBase;
    if (!a) { this.setData({ advice: {} }); return; }
    this.setData({ advice: this._adviceResult });
  },

  // ---------- 我的操作 ----------
  onPresetTap(e) {
    const legal = this.data.legal;
    if (!legal) return;
    const v = e.currentTarget.dataset.v;
    // 「自定义」档：展开自定义下注面板（与预设档互斥）
    if (v === 'custom') { this.onCustomTap(); return; }
    // 选预设档时收起自定义面板
    this.setData({ raiseCustom: false });
    const target = this.presetTarget(v);
    if (target === null) return;
    this.setRaiseTo(target, v);
  },

  /** 按当前街重建加注档位表：翻前 BB 语言，翻后池比例语言（g.street 已入渲染指纹） */
  presetsForStreet(street) {
    return street === P.STREET.PREFLOP ? PRESETS_PREFLOP : PRESETS_POSTFLOP;
  },

  /**
   * 预设档 → 目标「加注到」金额。返回 null 表示该档非法（不改动任何状态）。
   *
   * 两街口径（档位表见 PRESETS_PREFLOP / PRESETS_POSTFLOP 头注释）：
   *   - BB 档（bb25/bb30/bb40，翻前）：加注到 = 大盲 × 倍数。bb 取 game.bb
   *     （镜像端 loadSnapshot 已恢复该值，无需加广播字段）。
   *   - 比例档（p33…p100，翻后）：加注到 = 当前最高下注 × 2 + 底池 × 比例。
   *     多轮加注后 currentBet 已抬高，「×2 + 池×比例」能保证叫的量始终是
   *     「池的百分之多少」（主流 App 的 sizing chips 就是这个口径）。
   *   - 比例/BB 档一律向下吸附到小盲注整数倍（见 snapToBlind），避免出现 137 这种
   *     零头数字，与自定义面板的步进口径保持一致。
   *   - 全下不吸附：all-in 的金额就是玩家剩余筹码，本身可能不是盲注倍数。
   */
  presetTarget(v, legalOverride) {
    // legalOverride：render 每帧重算金额时必须传「本帧刚算出的 legal」——
    // this.data.legal 同帧还是上一帧的值（setData 异步），用错会把金额按旧的
    // min/max 钳制，出现「高亮 50% 但金额=上一街的最小额」的漂移。
    const l = legalOverride || this.data.legal || {};
    const min = Number(l.minRaiseTo) || 0;
    const max = Number(l.maxRaiseTo) || 0;
    if (v === 'min') return min;
    if (v === 'allin') return max;
    const mult = RAISE_PRESET_BB[v];
    if (mult !== undefined) {
      const bb = game && game.bb > 0 ? game.bb : 20;
      return Math.min(max, Math.max(min, this.snapToBlind(Math.min(bb * mult, max), max)));
    }
    const pct = RAISE_PRESET_PCT[v];
    if (pct === undefined) return null;
    const raw = game.currentBet * 2 + game.potTotal() * pct;
    return Math.min(max, Math.max(min, this.snapToBlind(Math.min(raw, max), max)));
  },

  /**
   * 吸附到小盲注的整数倍（默认「就近」：不足半个盲注则进位，保证叫注不小于盲注粒度）。
   * 超过上限时回落为上限——上限是玩家剩余筹码，可能不是盲注倍数，不能被抬高一档。
   */
  snapToBlind(v, maxOverride) {
    const step = this.blindStep();
    const n = Math.round(Number(v) || 0);
    if (step <= 1) return n;
    const snapped = Math.round(n / step) * step;
    // maxOverride：render 里用本帧 fresh legal 的 max，避免吸附时读到上一帧
    // data.legal.maxRaiseTo 把金额压小（presetTarget 重算路径专用）。
    const max = (maxOverride !== undefined)
      ? (Number(maxOverride) || 0)
      : (Number((this.data.legal || {}).maxRaiseTo) || 0);
    if (max && snapped > max) return max;
    return Math.max(step, snapped);
  },

  /** 小盲注步长（缺省 10，与建局 sb 保持一致） */
  blindStep() {
    const sb = game && game.sb;
    return sb > 0 ? sb : 10;
  },

  // 展开/收起自定义下注面板
  /**
   * 统一设置下注金额：连同按钮文案派生的 raiseSubmit / raiseAllIn 一起写入。
   *
   * ⚠️ 必须走这个方法，不能直接 setData({raiseTo})：
   * 加注按钮读的是 raiseSubmit / raiseAllIn（不是 raiseTo），而这两个字段
   * 若只在 render() 里算，滑杆/输入框改动就不触发 render，按钮文案会一直
   * 停在上一帧的旧值（曾出现：滑杆拉到 346，按钮仍显示「加注 20」）。
   * 口径与 onRaise 的提交钳制严格一致：低于最小按最小，达上限算全下。
   */
  setRaiseTo(amt, preset) {
    const l = this.data.legal || {};
    const min = Number(l.minRaiseTo) || 0;
    const max = Number(l.maxRaiseTo) || 0;
    const v = Math.round(Number(amt) || 0);
    const submit = min ? Math.max(min, v) : v;
    const patch = { raiseTo: v, raiseSubmit: submit, raiseAllIn: !!(max && submit >= max) };
    if (preset !== undefined) patch.raisePreset = preset;
    // 不再写「档位会话记忆」（2026-10-19 用户要求每局重置到最小）：
    // 高亮只在当前这一街内保持玩家手选，重置帧统一回 'min'。
    this.setData(patch);
    return patch;
  },

  /**
   * 每手重置加注档位状态（startHand 调用）。
   *
   * 背景：真机反馈「下注选择按钮一直高亮上一局的」。根因是 raisePreset 是
   * 页面级 data，跨手累积；而 raiseTo 会被 render 钳到 legal.minRaiseTo，
   * 于是出现「高亮 100% 但加注按钮只显示最小额」的矛盾态。
   *
   * 口径选择：默认高亮「最小」而非全部取消。理由——render 的
   * `raiseTo = max(this.data.raiseTo, legal.minRaiseTo)` 决定了轮到我时
   * 加注按钮**必然**显示最小额；若档位条全不高亮，界面上就没有任何提示
   * 说明「当前这个金额对应最小档」。默认高亮最小让两者自洽。
   *
   * ⚠️ 必须同时置 `_raiseResetPending`：setData 是异步的，startHand 里
   * resetRaiseState() 之后紧接着的 render() 同帧读 this.data 拿到的还是
   * 上一手旧值 —— 只 setData 会造成「高亮已重置为最小，金额却还是上一手的」。
   * render() 用这个实例字段做一次覆盖，读写都在同步路径上，绕开 setData 时序。
   *
   * 2026-10-19：取消 C7「档位会话记忆」——每局/每街重置一律回 'min' 并收起
   * 自定义面板（用户要求「每一局开始不要高亮或默认最小」）。render 的重置帧
   * 直接以 'min' 重算金额（见 render），与本方法的 setData 同为保守档，不冲突。
   */
  resetRaiseState() {
    this._raiseResetPending = true;
    this.setData({
      raisePreset: 'min',
      raiseTo: 0,
      raiseSubmit: 0,
      raiseAllIn: false,
      raiseCustom: false,
      // 档位随新一手回翻前口径（startHand 后 game.street 已是 preflop，
      // render 的按街重建是同口径单来源，此处与 render 用同一函数防漂移）
      raisePresets: this.presetsForStreet(P.STREET.PREFLOP)
    });
  },

  onCustomTap() {
    const legal = this.data.legal;
    if (!legal || !legal.canRaise) return;
    const open = !this.data.raiseCustom;
    // 展开时若当前金额低于最小下注，自动对齐到最小（避免直接全下 0 这种非法值）
    const raiseTo = open && this.data.raiseTo < legal.minRaiseTo ? legal.minRaiseTo : this.data.raiseTo;
    // ⚠️ 必须显式写 raiseCustom：setRaiseTo 只负责金额三件套（raiseTo/Submit/AllIn），
    // 不碰展开态。漏写这里会导致点「自定义」面板永远不弹出（曾表现为点击无反应）。
    this.setData({ raiseCustom: open });
    this.setRaiseTo(raiseTo, open ? 'custom' : this.data.raisePreset);
  },

  // 滑杆拖动：按步长吸附。B5（2026-10-17）步进来自 render 的 raiseStep
  // （大区间自适应变粗，小局仍为小盲），拖到顶部落 max 档（否则粗步进永远
  // 差一拍够不到全下额）。
  onRaiseSlider(e) {
    const step = this.data.raiseStep || this.blindStep();
    const max = Number((this.data.legal || {}).maxRaiseTo) || this.data.raiseMax || 0;
    let v = Number(e.detail.value);
    if (max && v >= max - step) v = max;          // 最后一格直接落全下
    else if (step > 1) v = Math.round(v / step) * step;
    this.setRaiseTo(v, 'custom');
  },

  /** 面板 ± 一档（一个小盲注）：长按可连续调，金额永不为零头 */
  onCustomStep(e) {
    const l = this.data.legal || {};
    const min = Number(l.minRaiseTo) || 0;
    const max = Number(l.maxRaiseTo) || 0;
    const dir = Number(e.currentTarget.dataset.dir) >= 0 ? 1 : -1;
    const step = this.blindStep();
    const cur = Number(this.data.raiseTo) || 0;
    let v = cur + dir * step;
    // 上限是剩余筹码，可能不是盲注倍数 —— 越界时直接落到边界值而不是叠加
    if (max && v > max) v = max;
    if (v < min) v = min;
    this.setRaiseTo(v, 'custom');
  },

  // 数字输入：只做清洗与上限。不在输入过程中抬到下限/吸附 ——
  // 否则想输「500」时刚打完第一个「5」就会被改写，后面根本没法接着输。
  // 吸附与下限补正都推迟到失焦（onRaiseBlur）。
  onRaiseInput(e) {
    const l = this.data.legal || {};
    const max = l.maxRaiseTo || this.data.raiseMax || 0;
    let v = parseInt(e.detail.value, 10);
    if (isNaN(v) || v < 0) v = 0;
    if (max && v > max) v = max;
    this.setRaiseTo(v, 'custom');
  },

  /**
   * 失焦归一：把任意输入收敛成「合法且是小盲注整数倍」的金额。
   *   1) 先吸附到盲注整数倍（就近）；
   *   2) 再钳到 [最小加注, 上限]。
   * 顺序很重要：上限常是零头（如剩余 157），先钳上限再吸附会把它抬到 160 越界，
   * 所以吸附在前、钳制在后，且 snapToBlind 内部已对越界值回落成上限。
   */
  onRaiseBlur() {
    const l = this.data.legal || {};
    const min = Number(l.minRaiseTo) || 0;
    const max = Number(l.maxRaiseTo) || 0;
    let v = this.snapToBlind(this.data.raiseTo);
    if (max && v > max) v = max;
    if (min && v < min) v = min;
    this.setRaiseTo(v, 'custom');
  },

  // 收起自定义面板 → 恢复档位条（两者互斥，收起即回到百分比档位条）
  onCustomClose() {
    this.setData({ raiseCustom: false });
  },

  onCustomMin() { const l = this.data.legal; if (l) this.setRaiseTo(l.minRaiseTo, 'custom'); },
  onCustomPct(e) {
    const pct = Number(e.currentTarget.dataset.pct);
    if (isNaN(pct)) return;
    const l = this.data.legal; if (!l) return;
    const raw = game.currentBet * 2 + game.potTotal() * pct;
    const v = Math.min(l.maxRaiseTo, Math.max(l.minRaiseTo, this.snapToBlind(raw)));
    this.setRaiseTo(v, 'custom');
  },
  onCustomMax() { const l = this.data.legal; if (l) this.setRaiseTo(l.maxRaiseTo, 'custom'); },

  onFold() {
    if (!this.data.isMyTurn) return;
    // 弃牌二次确认（防误触）：首次点击进入确认态，2.2s 内再点才真正弃牌
    if (!this.data.foldConfirm) {
      this.setData({ foldConfirm: true });
      if (foldTimer) clearTimeout(foldTimer);
      foldTimer = setTimeout(() => { foldTimer = null; this.setData({ foldConfirm: false }); }, 2200);
      return;
    }
    if (foldTimer) { clearTimeout(foldTimer); foldTimer = null; }
    this.setData({ foldConfirm: false });
    this.doAct('fold', 0, '弃牌', 'act-f');
  },

  clearFoldTimer() {
    if (foldTimer) { clearTimeout(foldTimer); foldTimer = null; }
  },

  onCheckOrCall() {
    const legal = this.data.legal;
    if (!legal) return;
    if (legal.toCall > 0) this.doAct('call', 0, '跟注', 'act-c');
    else this.doAct('check', 0, '过牌', 'act-c');
  },

  onRaise() {
    const legal = this.data.legal;
    if (!legal || !legal.canRaise) return;
    // 提交前把金额钳到合法区间 [minRaiseTo, maxRaiseTo]。
    // 滑杆本身 min=raiseMin 不会拖出非法值，但数字输入框能（清空后键入 0），
    // 且 bindblur 的补正只在失焦时发生——点「加注」按钮可能先走这里，故必须兜底。
    const amt = Math.max(legal.minRaiseTo, Math.round(this.data.raiseTo || 0));
    if (amt >= legal.maxRaiseTo) {
      /* 全下二次确认（新手可玩性 review 2026-10-19）。
       * 病根：弃牌这种「只损失已投入部分」的动作有 2.2s 二次确认，而全下——
       * 一次点击押上全部筹码——反而没有任何保护。新手把滑杆拖到最右、
       * 或在数字输入框里误敲一个大数，点一下按钮就输光。保护力度完全反了。
       * 这里复用弃牌的确认态模式（同一 2.2s 窗口、同样的「再点一次才生效」），
       * 文案随按钮切换到「再点全下」，给新手看清后果的机会。 */
      if (!this.data.allinConfirm) {
        this.setData({ allinConfirm: true });
        if (allinTimer) clearTimeout(allinTimer);
        allinTimer = setTimeout(() => { allinTimer = null; this.setData({ allinConfirm: false }); }, 2200);
        return;
      }
      if (allinTimer) { clearTimeout(allinTimer); allinTimer = null; }
      this.setData({ allinConfirm: false });
      this.doAct('allin', 0, '全下', 'act-a');
    } else {
      this.doAct('raise', amt, '加注 ' + amt, 'act-r');
    }
  },

  clearAllinTimer() {
    if (allinTimer) { clearTimeout(allinTimer); allinTimer = null; }
  },

  doAct(action, amount, text, cls) {
    if (this.data.timeUp) return;   // 本局已结束（时长到点），不再接受行动
    if (game.actionSeat !== this.mySeat || game.result) return;
    // 任何行动都先解除弃牌确认态（防确认态残留到下一回合）
    if (this.data.foldConfirm) { this.setData({ foldConfirm: false }); this.clearFoldTimer(); }
    // 同理解除全下确认态：换动作/下一轮都不该带着上次的「待确认」
    if (this.data.allinConfirm) { this.setData({ allinConfirm: false }); this.clearAllinTimer(); }
    // 批⑨：act 前 street 快照——game.act() 可能触发街推进，翻前计数必须取推进前的 street
    const streetBefore = game.street;
    const res = game.act(this.mySeat, action, amount);
    if (!res.ok) {
      wx.showToast({ title: res.error, icon: 'none' });
      return;
    }
    // 批⑨：AI 读人反制——翻前自愿入池计数。P1-7（2026-10-17）放宽守卫到所有 AI 局
    // （HUD 徽章需统计 VPIP —— 与反制决策同口径同分母）。ai_rookie/advanced 仅统计不反制。
    // 口径同 style-analyzer：blind/check 不计，call/raise/allin 计入自愿入池。
    if (this.mode === 'ai' && streetBefore === P.STREET.PREFLOP) {
      if (action === 'call' || action === 'raise' || action === 'allin') this._humanVpipCount++;
      this._humanActedThisHand = true;
    }
    myActText = text;
    myActCls = cls;
    this.feedback();                       // 震动反馈
    /* 教练提示按手收起（新手可玩性 review 2026-10-19）。
     * 旧逻辑：首次操作就永久收起 → 新手只见到一把牌桌就再无引导。
     * 现在每手第一次操作时收起本手提示，并累加已提示手数；打满
     * COACH_HANDS 手后不再出现（再提示就是噪音）。
     * 与 onCoachClose（用户手动点掉）区分开：手动点掉是永久，计数用完是自然结束。 */
    if (this.data.coachShow) {
      this.setData({ coachShow: false });
      this._coachHandsSeen = (this._coachHandsSeen || 0) + 1;
    }
    if (this.remoteMode) {
      // 镜像端：本地乐观执行做即时反馈，动作上行给房主（下一帧广播回来校正）
      roomSync.pushAction(this.roomNo, {
        type: 'act', seat: this.roomSeat, action: action, amount: amount || 0
      }).catch(() => wx.showToast({ title: '动作发送失败', icon: 'none' }));
      this.render();
      return;
    }
    this.afterAct();
  },

  onNextHand() {
    if (this.data.timeUp) { this.setData({ summary: this.data.summary || null }); return; }
    if (this.data.readyPhase) { this.onReadyTap(); return; }   // 就绪阶段：按钮即「准备就绪」
    if (this.remoteMode) { this.onReadyTap(); return; }        // 镜像端：等房主发牌，点了就算准备
    if (game && game.result) {
      // 结算展示阶段点「下一手」：关掉结算弹窗（若开着），直接进入就绪计票
      this.closeResultModal(true);
      return;
    }
    this.uploadRecord();   // 异步上云，不阻塞下一手
    this.startHand();
  },

  // ---------- AI ----------
  afterAct() {
    this.render();
    if (game.result) {
      this.uploadRecord();
      // 亮牌展示 → 结算弹窗的时序由 render 末尾统一调度（本地端与镜像端同路径，
      // 见 scheduleResultModal），这里不再另挂定时器，避免双份调度互相踩。
      return;
    }
    this.advance();
  },

  /** 清除结算展示定时器（跳过 / 发新手牌 / 退出页面时） */
  clearResultTimer() {
    if (this.resultTimer) { clearTimeout(this.resultTimer); this.resultTimer = null; }
  },

  /** 清除结算弹窗自动关闭定时器 */
  clearResultModalTimer() {
    if (this.resultModalTimer) { clearTimeout(this.resultModalTimer); this.resultModalTimer = null; }
  },

  /**
   * 弹出单手结算弹窗（每人净盈亏 + 摊牌手牌）。通常由 render 末尾的统一调度
   * 在亮牌展示 RESULT_SHOW_MS 后自动触发，也可由用户点「查看结算」提前打开
   * （摘要条 / 就绪条都有入口）。打开后 RESULT_MODAL_MS 自动关闭；
   * 若关闭时尚未进就绪阶段（亮牌展示期内点开），顺带进入就绪；
   * 已在就绪阶段则只关弹窗——enterReadyPhase 会清空就绪计票，绝不能误调。
   */
  showResultModal() {
    this.clearResultTimer();
    if (!this.data.result || this.data.timeUp) return;
    if (this.data.resultModal) return;
    // 收割本局到复盘缓存：仅本机权威端跑引擎时才缓存（镜像端无 game.events
    // 全量；观战/中途退出价值低不缓存）。失败静默（体验优化，不阻断结算）。
    if (game && game.events && game.events.length && game.result && !this.remoteMode) {
      replayStore.addReplay(game, this.mySeat, this.data.mode);
      // 云端落库复盘（仅好友房、权威端）：把本局逐街事件流存到 poker_hand_replays，
      // 供「进房看每局复盘」。失败静默降级——复盘是体验增强，绝不懈怠结算主流程。
      if (this.roomNo) {
        const payload = replayStore.buildReplayPayload(game, this.mySeat, this.data.mode);
        if (payload) {
          auth.saveHandReplay(this.roomNo, game.handNo, payload).catch(e =>
            console.error('[table] 复盘云端落库失败', JSON.stringify({ room: this.roomNo, hand: game.handNo, err: e && e.message })));
        }
      }
      // 高光时刻判定与存档：同样仅权威端（镜像端无 game.result.evals 全量）。
      // 判定规则在此处（store 层只存不判）——此时 game.result.evals/winners 已算完、
      // winStreaks 已被 renderAmbience 的 _bumpStreaks 更新（先于 showResultModal）、
      // events 完整。失败静默（体验优化，与 replay 同口径）。
      const hl = this._detectHighlight();
      if (hl) {
        highlightStore.addHighlight(game, this.mySeat, this.data.mode, hl.type, hl.streak);
        // 新高光解锁即时反馈（P1-6）：入档后 listAll 已含本条，数同类型条数=1 即「首次」。
        // 一手最多一条（_detectHighlight 单返回，优先级见函数头注释），toast 不用排队。
        const HIGHLIGHT_LABEL = {
          royal_flush: '皇家同花顺', quads: '四条', streak5: '五连胜',
          bluff_success: '诈唬成功', sng_win: 'SNG 夺冠'
        };
        const label = HIGHLIGHT_LABEL[hl.type] || '高光时刻';
        const first = highlightStore.listAll().filter(r => r.type === hl.type).length === 1;
        wx.showToast({
          title: '🏆 新高光：' + label + (first ? '（首次）' : ''),
          icon: 'none',
          duration: 2500
        });
      }
    }
    // G3 已随行内「复盘看牌」撤销（2026-10-17）退役：replayDate 不再供任何 WXML
    // 入口消费，结算弹窗打开不再预取 replay-store。复盘统一走胶囊 onReplayTap。
    // 上帝视角已退役（2026-10-17 撤销入口）：弹窗只显示摊牌亮牌（muck 礼仪）
    this.setData({ resultModal: this.buildResult(game.result) });
    this.clearResultModalTimer();
    this.resultModalTimer = setTimeout(() => {
      this.resultModalTimer = null;
      this.closeResultModal(true);
    }, RESULT_MODAL_MS);
    // 非摊牌赢池自愿亮牌入口（玩家审视 2026-10-17）：仅 fold 结算的获胜者在
    // 本机权威端可见——亮牌是社交货币（亮 A 高诈唬），muck 礼仪之外给主动选择权。
    // 已亮过（showdownReveal 有我）/摊牌局（本就全亮）/镜像端（写本地会被快照
    // 卷回）都不显示按钮。
    const meInResult = game && game.seatOf(this.mySeat);
    const canDisclose = !!(!this.remoteMode && game && game.result && game.result.type === 'fold' &&
      game.result.winners.indexOf(this.mySeat) !== -1 && meInResult && meInResult.hole.length === 2 &&
      !game.showdownReveal[this.mySeat]);
    this.setData({ canDisclose: canDisclose });
  },

  /**
   * 关闭结算弹窗。proceed=true 且尚未进就绪阶段时，顺带进入就绪（跳过剩余展示）；
   * 已在就绪阶段只关弹窗。镜像端只关弹窗——就绪阶段由房主广播驱动。
   */
  closeResultModal(proceed) {
    this.clearResultTimer();
    this.clearResultModalTimer();
    // 亮牌入口随弹窗收起复位（下一手 showResultModal 会按新局面重算）
    if (this.data.canDisclose) this.setData({ resultModal: null, canDisclose: false });
    else if (this.data.resultModal) this.setData({ resultModal: null });
    if (proceed && !this.remoteMode && !this.data.readyPhase) this.enterReadyPhase();
  },

  // G3 弃牌行「复盘看牌」小链接已撤销（2026-10-17 用户反馈：摊牌行最后一列
  // 的查看复盘与底部「复盘这手牌」胶囊重复）——onRowReplayTap 随入口删除，
  // 复盘跳转统一走 onReplayTap（replayStore.latest 同手校验 + 无缓存 toast）。

  /** 「查看结算」入口（结算摘要条 / 就绪条上的按钮）：手动打开结算弹窗 */
  onShowResult() {
    this.showResultModal();
  },

  /** 结算弹窗按钮：亮牌展示期内 = 下一手（进就绪计票）；就绪期/镜像端 = 知道了（仅关闭） */
  onResultNext() {
    this.closeResultModal(!this.remoteMode);
  },

  /** 结算弹窗「复盘」按钮：跳转复盘页看本局逐街回放（仅本机权威端有缓存） */
  onReplayTap() {
    const rec = replayStore.latest();
    if (!rec) {
      wx.showToast({ title: '本局复盘未缓存', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/replay/replay?date=' + rec.date });
  },

  /**
   * 批⑦：高光分享卡片弹层（非 canvas 方案）。
   * 零 canvas 硬约束下，微信生图唯一途径（canvas）不可用，故定为「分享卡预览弹层
   * + 截图引导 + onShareAppMessage title 摘要」：弹层纯 WXML+WXSS 精美排版高光信息，
   * 引导用户「长按截图可保存到相册」，open-type="share" 按钮带高光摘要 title。
   * 数据来源：highlightStore/latest() 取最近高光，解码手牌/公共牌/牌型名。
   * G5（2026-10-17）：同弹层也承担「本手分享」——buildResult 注入的 share 字段
   * 随结算弹窗成行即可点。优先用本手 share（结算行占有率 100%），只在手动点
   * 「分享高光」入口且本手无 share 时回退 highlightStore（G7/P1-6 老链路存留）。
   */
  onShareCardShow() {
    const share = (this.data.result && this.data.result.share) || null;
    if (!share) {
      const rec = highlightStore.latest();
      if (!rec) {
        wx.showToast({ title: '还没有高光时刻', icon: 'none' });
        return;
      }
      const evals = (rec.result && rec.result.evals) || {};
      const me = evals[rec.mySeat];
      const handName = (me && me.name) || highlightStore.summarize(rec, rec.type);
      const myHole = (rec.myHole || []).map((c, i) => this.cardData(c, i));
      const board = (rec.board || []).map((c, i) => this.cardData(c, i));
      this._shareHighlightTitle = '我在「博弈论」打出了' + (rec.summary || handName) + '！';
      this.setData({
        shareCardShow: true,
        shareCardData: {
          handName: handName,
          summary: rec.summary || handName,
          myHole: myHole,
          board: board,
          mode: rec.mode || 'ai'
        }
      });
      return;
    }
    this._shareHighlightTitle = '我在「博弈论」' + (share.handName ? '打出了' + share.handName + '，' : '') + share.summary;
    this.setData({
      shareCardShow: true,
      shareCardData: {
        handName: share.handName || '本手回顾',
        summary: share.summary,
        myHole: share.myHole,
        board: share.board,
        mode: this.mode || 'ai'
      }
    });
  },

  onShareCardClose() {
    if (this.data.shareCardShow) this.setData({ shareCardShow: false });
  },

  // ---------- 结算弹窗查看类入口（hl-* 面板收口复盘） ----------
  // 2026-10-17 用户反馈二次反转：高光时刻不做二级面板，胶囊直接平铺在弹窗按钮区
  // 上方（复盘/分享/亮一手——「看全桌牌」随上帝视角入口一并撤销），点击直接执行。
  // 各入口自带门控：onReplayTap 无缓存时 toast、亮一手由 canDisclose 门控。

  // ---------- 就绪阶段：所有人准备就绪后才发下一手 ----------

  /** 某座位是否已站起（站起者退出本局，但仍在房间内） */
  isStanding(seat) {
    if (seat === this.mySeat) return !!this.myStanding;
    return !!this.standingMap[seat];
  },

  /** 引擎引用（测试注入用：跨端引擎行为断言，业务代码不要调用） */
  requireGame() {
    return game;
  },

  /** 某座位是否算「在座」：我已坐下但待下一手入局时，同样算在座并需点就绪 */
  seatedOf(seat) {
    if (seat === this.mySeat) return this.pendingSit || !this.myStanding;
    return !this.standingMap[seat];
  },

  /**
   * 进入就绪阶段：列出所有在座的人，等齐「准备就绪」才发下一手。
   * 电脑玩家模拟真人点击（1.5~4s 内自动就绪）。
   */
  enterReadyPhase() {
    if (!game || this.data.timeUp) return;   // 时长已到或牌局已结束，不再开下一手
    // 时长已到但本手还在打 → 这里就是那手的收口，此刻才真正结束总牌局，
    // 保证玩家打完完整的一手（摊牌/结算弹窗都看完）才 game over。
    if (this.pendingTimeUp) { this.pendingTimeUp = false; this.endGame(); return; }
    if (this.remoteMode) return;             // 镜像端的就绪状态以房主广播为准
    this.clearReadyClock();

    const list = game.players.map(p => ({
      seat: p.seat,
      name: p.name,
      isMe: !!p.isHuman,
      isBot: !p.isHuman,
      ready: false
    })).filter(x => this.seatedOf(x.seat));

    this.readyMap = {};
    list.forEach(x => { this.readyMap[x.seat] = false; });

    // 跨设备：好友可能已经点了准备（ready_hand = 下一手），直接合入计票
    if (this.syncLive) {
      const ready = roomSync.readySeats(this.roomRows, game.handNo + 1, Date.now());
      list.forEach(x => { if (ready[x.seat]) this.readyMap[x.seat] = true; });
    }

    this.setData({ readyPhase: true, readyList: list, myReady: false, readyHint: '' });
    this.renderReady();
    this.startReadyClock();
    this.render();   // 同步底部状态行（等待准备就绪 / 已坐下待入局）
    this.publishPlay();

    // B3 好友房自动弹补筹窗：我筹码不足 1 大盲且本手没弹过 → 自动弹一次。
    // 弹的是申请表单（规则 1：下一手生效）——就绪阶段「补完再点准备」是
    // 用户提出的核心场景，开局即带着新筹码。
    if (this.mode === 'friend' && game && game.handNo !== this._rebuyAskedHand) {
      this._rebuyAskedHand = game.handNo;
      const me = game.seatOf(this.mySeat);
      if (me && me.isHuman && !me.sittingOut && me.stack < game.bb) this.openRebuy();
    }

    list.forEach(x => {
      if (!x.isBot) return;
      const delay = 1500 + Math.random() * 2500;
      this.botReadyTimers.push(setTimeout(() => this.markReady(x.seat, true), delay));
    });

    // 单机自动续局宽限：AI/SNG 桌我在座时，READY_AUTO_SEC 后自动替我点一次
    // 「准备就绪」（连续对局去每手点击摩擦）。此前无论 bot 多快就绪，都必须
    // 等真人手点才能发下一手。宽限只是代点——我仍在座、走 onReadyTap 同一路径
    // 计票；30s 真超时自动站起的硬口径与 finishReadyPhase 的真人就绪断言不动。
    // 好友房（房主多人/镜像端）不挂：多人节奏由每个真人自己掌控。
    if (this.mode !== 'friend' && this.seatedOf(this.mySeat)) {
      this.autoReadyTimer = setTimeout(() => {
        this.autoReadyTimer = null;
        if (this.data.readyPhase && !this.data.myReady) this.onReadyTap();
      }, READY_AUTO_SEC * 1000);
    }
  },

  /** 标记某人已准备 / 未准备，并在齐人后立即发下一手 */
  markReady(seat, v) {
    if (!this.data.readyPhase) return;
    this.readyMap[seat] = !!v;
    if (seat === this.mySeat) this.feedback();
    this.renderReady();
    this.checkAllReady();
  },

  /** 渲染就绪列表与提示文案 */
  renderReady() {
    const list = (this.data.readyList || []).map(x => {
      return { seat: x.seat, name: x.name, isMe: x.isMe, isBot: x.isBot, ready: !!this.readyMap[x.seat] };
    });
    const ok = list.filter(x => x.ready).length;
    const me = list.filter(x => x.isMe)[0];
    let hint;
    if (ok >= list.length) {
      hint = list.length >= 2 ? '全部就绪，即将发下一手…' : '至少需要 2 人入局，等待玩家坐下…';
    } else {
      hint = '已就绪 ' + ok + '/' + list.length + ' · 超时未准备将自动站起';
    }
    this.setData({ readyList: list, myReady: me ? !!me.ready : false, readyHint: hint });
  },

  /** 所有在座的人都已就绪（且不少于 2 人）→ 发下一手 */
  checkAllReady() {
    const list = this.data.readyList || [];
    if (!list.length) return;
    if (!list.every(x => !!this.readyMap[x.seat])) return;
    if (list.length < 2) return;   // 不足 2 人不开牌，等有人坐下后重新计票
    this.finishReadyPhase();
  },

  finishReadyPhase() {
    // 补筹窗还开着 → 暂缓发牌：保证「补完再点准备」时补筹落在下一手（而不是
    // 被抢先发牌拖到再下一手）。
    if (this.data.rebuyShow) return;
    // AI 对战（单机）：下一手必须由真人明确点「准备就绪」才发——绝不自动开局。
    // 即使其余电脑玩家都已就绪，只要真人没点，就停在就绪阶段等真人入局。
    // 用户 2026-10-16 反馈：未点准备就绪却自动下一局，这里兜底拦截。
    // （checkAllReady 已要求全员就绪，此处再显式确认真人就绪，双保险。
    //   自动续局宽限的代点走的也是真人计票路径——readyMap 里我就绪后才可能
    //   走到这里，语义与手点等价，不妨碍这条断言。）
    if (this.mode !== 'friend' && !(this.data.readyList || []).some(x => x.isMe && this.readyMap[x.seat])) {
      this.renderReady();
      this.setData({ readyHint: '请点「准备就绪」继续' });
      return;
    }
    this.clearReadyClock();
    this.setData({ readyPhase: false, readyLeft: 0, readyHint: '', myReady: false });
    this.uploadRecord();
    this.startHand();
  },

  startReadyClock() {
    this.clearReadyClock();
    let left = READY_TIMEOUT_SEC;
    this.setData({ readyLeft: left });
    readyTimer = setInterval(() => {
      left--;
      this.setData({ readyLeft: left > 0 ? left : 0 });
      if (left <= 0) {
        this.clearReadyClock();
        this.autoStandUnready();
      }
    }, 1000);
  },

  clearReadyClock() {
    if (readyTimer) { clearInterval(readyTimer); readyTimer = null; }
    (this.botReadyTimers || []).forEach(t => clearTimeout(t));
    this.botReadyTimers = [];
    // 单机自动续局宽限的代点定时器一并配对清理（finishReadyPhase/切后台都要能取消）
    if (this.autoReadyTimer) { clearTimeout(this.autoReadyTimer); this.autoReadyTimer = null; }
  },

  /**
   * 就绪超时：未点「准备就绪」的人自动站起（退出本局，仍保留在房间内）。
   * 站起后重新计票：仍在座且都已就绪的人够 2 人就直接发下一手。
   */
  autoStandUnready() {
    const list = this.data.readyList || [];
    const unready = list.filter(x => !this.readyMap[x.seat]);
    if (!unready.length) return;

    unready.forEach(x => {
      if (x.seat === this.mySeat) {
        this.myStanding = true;
        this.pendingSit = false;
        this.pushChat(this.mySeat, this.meLabel(false), '超时未准备，已自动站起');
        wx.showToast({ title: '超时未准备，已自动站起', icon: 'none' });
        if (this.data.soundOn) sfx.play('timeout');   // 被动站起提示（区别于主动站起）
      } else {
        this.standingMap[x.seat] = true;
        this.pushChat(x.seat, x.name, '超时未准备，已自动站起');
      }
    });

    const seated = list.filter(x => this.seatedOf(x.seat));
    this.setData({ readyList: seated });

    // ⚠️ AI 对战（单机）里「我」是唯一的真人。超时把我站起后，若还照常判断
    //「剩余在座者是否都已准备」，我已被移出名单、剩下的电脑玩家又都已经准备，
    // 于是直接开局——真机反馈：「我还没点准备就绪，怎么牌局就开始了」，
    // 而且开局后我还变成了观战，更让人摸不着头脑。
    // 单机场景必须留在这个阶段，等玩家自己从菜单「坐下加入游戏」重新入局，
    // 不能开一局没有真人参与的纯电脑互打。好友房不受影响（那边本就是多人，
    // 有人超时挂机、其他人继续是设计意图）。
    const soleHumanStoodUp = this.mode !== 'friend' && !seated.some(x => x.seat === this.mySeat);

    if (!soleHumanStoodUp && seated.length >= 2 && seated.every(x => !!this.readyMap[x.seat])) {
      this.finishReadyPhase();
      return;
    }
    this.renderReady();
    if (soleHumanStoodUp) {
      this.setData({ readyHint: '你已自动站起 · 菜单「坐下加入游戏」可重新入局' });
    } else if (seated.length < 2) {
      this.setData({ readyHint: '人数不足 2 人 · 菜单「坐下加入游戏」可重新入局' });
    }
    this.render();
  },

  /** 我点「准备就绪」（未坐下时先提示坐下） */
  onReadyTap() {
    if (!this.data.readyPhase) return;
    // 补筹窗开着时不允许就绪：否则下一手可能在确认前发出，补筹被记到再下一手
    if (this.data.rebuyShow) return;
    // 幂等：按钮已 disabled，但主操作键/镜像端也可能触发这里，重复计票会白耗一轮
    if (this.data.myReady) return;
    if (this.data.soundOn) sfx.play('click');
    if (this.remoteMode) {
      // 镜像端：写自己行的 ready_hand（下一手手数），房主轮询合入计票
      if (!game) return;
      const nextHand = game.handNo + 1;
      // 就绪标记上行失败必须提示：房主收不到就绪 → 永远不发下一手，好友只会干等
      roomSync.markReadyRow(this.roomNo, nextHand)
        .catch(() => this.syncFailToast('准备未同步成功，请重试'));
      const list = (this.data.readyList || []).map(x =>
        Number(x.seat) === Number(this.mySeat) ? Object.assign({}, x, { ready: true }) : x);
      this.setData({ myReady: true, readyList: list });
      return;
    }
    if (!this.seatedOf(this.mySeat)) {
      wx.showToast({ title: '你已站起，请先坐下', icon: 'none' });
      return;
    }
    this.markReady(this.mySeat, true);
  },

  // 「继续 ▶」onFastForward 已移除（2026-10-17 用户反馈与「准备就绪」冗余）。
  // 亮牌/就绪期的等待由 READY_AUTO_SEC=3s 自动代点承担，无需手动快进。

  scheduleAI() {
    const seat = game.actionSeat;
    const p = game.seatOf(seat);
    if (!p) return;
    // 角色档案（马脚用）：按序号查 botProfiles。botSeats 标记的是机器人座位，
    // 在等待室入座时按序号绑定，此处复用同一序号口径取档案。
    const isAiBot = this.mode === 'ai' && this.botSeats[seat];
    const botIdx = isAiBot
      ? Math.max(0, game.players.filter(x => this.botSeats[x.seat] && x.seat <= seat).length - 1)
      : -1;
    const profile = botIdx >= 0 ? botProfiles.profileFor(botIdx) : null;
    const tell = profile && profile.tellPattern || {};
    const baseTalkRate = profile ? profile.talkRate : 0.35;
    const isBluff = /诈唬/.test((p && p.lastReason) || '');  // 见下：本帧决策后回填

    // 反应时间抖动（马脚）：诈唬急促（心虚）、强牌拖延（装犹豫）。
    // 分布偏移非确定信号——玩家可借它读对手，但不保证准确。默认 620~1140ms。
    let delay = 620 + Math.random() * 520;
    // 本帧是否诈唬要等 aiDecide 出结果才知，故先按 reason 兜底用 p.lastReason
    // （上一手同座位残值），决策后再以本帧 d.reason 精确化下一帧。此处抖动按
    // tell.bluffFast / 强牌延后做软偏移：
    if (tell.bluffFast && isBluff) delay = 300 + Math.random() * 240;       // 急促
    else if (/价值|强/.test((p && p.lastReason) || '')) delay = 800 + Math.random() * 600; // 强牌装犹豫

    aiTimer = setTimeout(() => {
      aiTimer = null;   // 先释放槽位：本帧若失败，看门狗可重新调度
      try {
        if (game.result || game.actionSeat !== seat) return;
        const legal = game.legalActions(seat);
        if (!legal) return;

        const seats = game.inHandPlayers().map(x => x.seat);
        // B1（玩家审视 2026-10-17）：位置因子改「行动序位」口径。
        // 旧算法 pf = (actIdx - dealerIdx) 混入了空座位/离座者（inHandPlayers
        // 含所有未 sittingOut 的座位，人数随中途加入波动），且把「按钮后第一个
        // 行动」判成最晚位（实际最先行动 = 最差位）。新口径：按距按钮的顺时针
        // 行动序排位，rank 0 = 按钮左一（最先行动/最差位），n-1 = 按钮（最后行动/
        // 最好位），lateness = rank/(n-1) 归一到 [0,1]。HU（n=2）翻前行动顺序
        // 由大盲先手（按钮=小盲），引擎内部处理；此处只在翻后把按钮判为最好位，
        // 翻前给两座位固定中值 0.5（与 test-core.js 压力测试同口径）——
        // 序位只对「多人且行动顺序稳定」的街才有意义。
        let positionFactor = 0;
        const n = seats.length;
        const actIdx = seats.indexOf(seat);
        const dlrIdx = seats.indexOf(game.dealerSeat);
        const rank = (actIdx - dlrIdx + n) % n;   // 0 = 按钮左一
        if (n === 2) {
          positionFactor = game.board.length === 0 ? 0.5 : (rank === 0 ? 0 : 0.9);
          // HU 翻后：按钮后行动 = 位置优势（rank 1 → 0.9）；按钮左一其实不存在
          // 于 2 人局（rank 只能 0/1，rank 0 = 按钮本人外那家，先行动）。
        } else if (n > 2) {
          const lateness = rank / (n - 1);
          positionFactor = lateness >= 0.99 ? 0.9 : (lateness > 0.5 ? 0.4 : 0);
        }
        // 批⑨：AI 读人反制——expert 难度下，按人类玩家滚动 VPIP 调整 bot 的 tight。
        // 人类松（高 VPIP）→ bot 收紧（多弃牌不陪松玩家）；人类紧（低 VPIP）→ bot 放松
        // （多偷池）。用 Object.assign 副本注入，不碰 p.style 原对象。零引擎改动：
        // 引擎 aiDecide 读 ctx.style.tight，此处调的就是它读到的值，签名不变。
        let aiStyle = p.style;
        if (this.mode === 'ai' && this.level === 'expert' && this._humanVpipHands >= 3) {
          const humanVpip = this._humanVpipCount / this._humanVpipHands;
          aiStyle = this._adjustTightByVpip(p.style, humanVpip);
        }
        const d = P.aiDecide({
          hole: p.hole,
          board: game.board,
          pot: game.potTotal(),
          toCall: legal.toCall,
          stack: p.stack,
          currentBet: game.currentBet,
          numActive: game.activePlayers().length,
          positionFactor,
          style: aiStyle,
          minRaiseTo: legal.minRaiseTo,
          maxRaiseTo: legal.maxRaiseTo,
          // 加注权 & 大盲一并交给 AI：退化路径的估算区间不精确，
          // 传全后 aiDecide 的夹取永远落在引擎合法区间内
          canRaise: legal.canRaise,
          bb: game.bb,
          // 翻后蒙特卡洛的 rng 种子必须可复现（玩家审视 2026-10-17）：aiDecide 内部
          // 翻后 quickEquity 用本 rng 发牌，种子含 handNo+seat+第 n 次决策 → 同局
          // 回放时 AI 分叉路径逐位还原。翻后每次决策递增 aiStep，避免同手同座位
          // 两街决策种子相同（次序敏感：rng 消耗在 aiDecide 内部，和翻前抽牌流隔离）。
          rng: P.createRng('mp-' + game.handNo + '-' + seat + '-' + (aiStep++))
        });
        // 回填本帧 reason 供下一帧反应时间抖动判诈唬/强牌
        p.lastReason = d.reason || '';

        const res = game.act(seat, d.action, d.amount);
        if (!res.ok) {
          // 非法动作：记日志后放弃本帧；定时器槽已释放，看门狗会用新随机数重试
          console.error('[table] AI 动作被引擎拒绝', JSON.stringify({
            stage: 'ai-act', seat, action: d.action, amount: d.amount, error: res.error
          }));
          this.render();
          return;
        }

        // #14 批二：把 AI 的动作写进实例态 _lastActMap（render 派生动着气泡）。
        // 旧实现是路径型 setData 补丁 seats[idx].actText，afterAct→render 全量
        // 重建 seats 时被重置为 ''——气泡一帧闪现，现实中几乎不可见。
        // actLabel 第二参必传 game.currentBet（C2：aiDecide 返回值不带 ctx）。
        this._lastActMap[seat] = {
          text: this.actLabel(d, game.currentBet),
          cls: this.actClsOf(d.action)
        };
        this._actEpoch++;
        this.afterAct();
        // AI 聊天冒泡：角色触发率（话痨高 / 寡言低），诈唬时按马脚调整。
        // 诈唬话多掩饰（bluffTalkBoost）或诈唬必沉默（bluffSilent）。
        const thisBluff = /诈唬/.test(d.reason || '');
        let talkRate = baseTalkRate;
        if (thisBluff) {
          if (tell.bluffSilent) talkRate = 0;           // 诈唬必沉默
          else if (tell.bluffTalkBoost) talkRate = Math.min(0.9, talkRate * tell.bluffTalkBoost);
        }
        if (d.reason && Math.random() < talkRate) {
          this.pushChat(seat, p.name, this.pickTalk(d, profile));
        }
      } catch (e) {
        console.error('[table] AI 行动异常，等待看门狗重试', JSON.stringify({
          stage: 'ai-schedule', seat, message: e && e.message, stack: e && e.stack
        }));
      }
    }, delay);
  },

  /**
   * AI 动作气泡文案。raise 之外的动作文案与金额无关，直接查表。
   * C2：街内无人下过注 →「下注」（翻后首位开池说加注是错误术语）。
   * ⚠️ 第二参 currentBet 必传（街内最高注，0 即首个下注）：
   * aiDecide 的返回对象只有 {action,amount,reason}，不带 ctx 透传字段，
   * 从返回值读 currentBet 恒为 undefined、文案会错标成「下注」。
   */
  actLabel(d, currentBet) {
    if (d.action === 'fold') return '弃牌';
    if (d.action === 'check') return '过牌';
    if (d.action === 'call') return '跟注';
    if (d.action === 'allin') return '全下';
    return ((currentBet | 0) === 0 ? '下注 ' : '加注 ') + d.amount;
  },

  actClsOf(action) {
    if (action === 'fold') return 'act-f';
    if (action === 'raise') return 'act-r';
    if (action === 'allin') return 'act-a';
    return '';
  },

  pickTalk(d, profile) {
    // 批②：按角色档案取台词。profile 缺省（好友房机器人/旧路径）时退回原 QUICK_TALK 兜底。
    if (profile) {
      const scene = botProfiles.sceneOf(d);
      const line = botProfiles.pickTalk(profile, scene);
      if (line) return line;
    }
    if (d.action === 'fold') return QUICK_TALK[Math.floor(Math.random() * 2)];
    if (d.action === 'allin') return '好牌！';
    if (d.action === 'raise') return '打得不错';
    return QUICK_TALK[Math.floor(Math.random() * QUICK_TALK.length)];
  },

  // ---------- 计时器 ----------
  /**
   * 行动计时环。tick 是「本回合残值」的全局单值（tickMax 起倒数）：
   *   - 轮到我 → 残值写到 myTimer/myTimerPct（myzone 专属字段，每秒 setData）；
   *   - 轮到对手 → 残值只进整帧 render 的 seats[].timer；本回调**不**写对手
   *     字段——曾经每秒把我的残值 setData 给对手计时环（评审 2026-10-15
   *     MEDIUM），导致「对手环用我的剩余秒数跳」；对手环等下一帧 render 刷新，
   *     牺牲的流畅度换正确性（对手到点由房主 30s 代弃兜底，不依赖本地环）。
   *
   * tickMax 按模式取值（超时口径统一，评审玩家反馈）：
   *   - 单机（AI/SNG）：TICK_MAX=20s 快节奏不变；
   *   - 好友房：roomSync.SYNC.ACTION_TIMEOUT_SEC=30s——本地环走到 0 的时刻必须
   *     就是房主代弃生效的时刻，否则好友端「环走完了还在干等」且 UI 与权威端
   *     说两个数（20s 环 vs 30s 代弃曾是双常量错位）。单机不受影响。
   */
  timerMax() {
    return this.remoteMode ? roomSync.SYNC.ACTION_TIMEOUT_SEC : TICK_MAX;
  },

  startTimer() {
    if (timer) clearInterval(timer);
    const tickMax = this.timerMax();
    tick = tickMax;
    this.sfxWarnedTick = 0;   // 倒计时警告已播到的 tick 值（0=未播），防每秒重复
    timer = setInterval(() => {
      tick--;
      if (game.actionSeat === this.mySeat) {
        // 我已移出 seats 数组（渲染在底部 myzone），计时写到我的专属字段
        this.setData({
          myTimer: tick,
          myTimerPct: Math.max(0, Math.round(tick / tickMax * 100)),
          // 最后 5s：行动条紧迫脉冲（与座位计时环 timerUrgent、5s/3s 警告音同阈值）
          myTimerUrgent: tick <= 5 && tick > 0
        });
        // C1（玩家审视 2026-10-17）：我方分支同时局部刷新我在座位环上的计时环。
        // ⚠️ 环下标必须用 this.data.seats 按 seat 找——座位环含空位，与
        // game.players 的下标不同构（评审时曾用 players.findIndex 出过错）。
        const myRingIdx = this.data.seats.findIndex(s => s && s.seat === this.mySeat);
        if (myRingIdx >= 0 && this.data.seats[myRingIdx].timer !== undefined) {
          this.setData({
            ['seats[' + myRingIdx + '].timer']: tick,
            ['seats[' + myRingIdx + '].timerPct']: Math.max(0, Math.round(tick / tickMax * 100)),
            ['seats[' + myRingIdx + '].timerUrgent']: tick <= 5 && tick > 0
          });
        }
        // 行动倒计时警告：剩余 5s/3s 各滴答一声，避免误超时代弃
        if ((tick === 5 || tick === 3) && this.sfxWarnedTick !== tick) {
          this.sfxWarnedTick = tick;
          if (this.data.soundOn) sfx.play('warn');
        }
      } else if (game.actionSeat >= 0 && !this.data.readyPhase && !game.result) {
        // 对手回合：每秒局部更新该行动座位的计时环，避免「整帧 render 才刷新 → 跳秒」。
        // 关键：只写当前行动座位（game.actionSeat）的值，不碰 myTimer/myTimerPct，
        // 故不会重演「对手环显示我的残值」旧 bug（评审 2026-10-15 MEDIUM）。
        const actIdx = game.players.findIndex(p => p.seat === game.actionSeat);
        if (actIdx >= 0) {
          this.setData({
            ['seats[' + actIdx + '].timer']: tick,
            ['seats[' + actIdx + '].timerPct']: Math.max(0, Math.round(tick / tickMax * 100)),
            ['seats[' + actIdx + '].timerUrgent']: tick <= 5 && tick > 0
          });
        }
      }
      if (tick <= 0) {
        clearInterval(timer);
        const legal = game.legalActions(this.mySeat);
        if (legal && game.actionSeat === this.mySeat && !game.result) {
          if (this.data.soundOn) sfx.play('timeout');   // 被动代弃提示
          // 超时不替玩家主动下注：有注可跟 → 弃牌（不替玩家跟注，与好友超时
          // watchFriendAction 同口径）；无注 → 过牌。被动处理应偏保守，不替玩家
          // 掏筹码（评审 2026-10-16）。
          if (legal.toCall > 0) this.doAct('fold', 0, '弃牌', 'act-f');
          else this.doAct('check', 0, '过牌', 'act-c');
        }
      }
    }, 1000);
  },

  /**
   * 非摊牌赢池自愿亮牌（玩家审视 2026-10-17）：对手全弃我独赢（result.type==='fold'）
   * 时，muck 礼仪让我的牌不公开——但「亮一手 A 高诈唬」是德扑的核心社交货币。
   * 结算弹窗给获胜者一个自愿「亮牌」按钮： disclosures 写进 game.showdownReveal[mySeat]
   * （同引擎摊牌数据结构），render 的 showCards 条件已要求 showdown 街——fold 结算
   * 引擎同样置 street=SHOWDOWN，座位亮牌与结算弹窗迷你手牌都会自然复用。
   * 镜像端（remoteMode）不写：reveal 由权限端随快照广播，镜像写本地 game 会
   * 与下一帧快照冲突被覆盖（快照 reveal 只在 showAll 时带，fold 结算无 reveal →
   * 好友端亮牌属后续可做——需把 reveal 透传进 fold 结算快照，涉引擎面暂不动）。
   * 只允许亮我自己的牌，且仅本手（startHand 清空 showdownReveal）。
   */
  onShowMyCards() {
    if (this.remoteMode) return;              // 镜像端写本地 reveal 会被下一帧快照卷回，不开放
    if (!game || !game.result || game.result.type !== 'fold') return;
    if (game.result.winners.indexOf(this.mySeat) === -1) return;   // 只有赢家能亮
    const me = game.seatOf(this.mySeat);
    if (!me || me.hole.length !== 2 || game.showdownReveal[this.mySeat]) return;
    const e = P.evaluate(me.hole.concat(game.board || []));
    game.showdownReveal[this.mySeat] = {
      hole: me.hole.map(c => P.cardToCode(c)),
      hand: e.best.map(c => P.cardToCode(c)),
      handCn: e.best.map(c => P.cardToStr(c)),
      cat: e.cat, name: e.name, ranks: e.ranks.slice()
    };
    // reveal 变化必须穿透渲染指纹，否则跳过分支吞掉亮牌（seats[].hole 由它派生）
    this._lastRenderFp = null;
    if (!this.remoteMode) this.forcePublish();   // 房主亮牌随下一帧广播给好友
    this.setData({ resultModal: this.buildResult(game.result), canDisclose: false });
    this.pushChat(this.mySeat, this.meLabel(false), '亮出底牌 ' +
      me.hole.map(c => P.cardToStr(c)).join(' ') + '（' + e.name + '）');
    this.render();
  }
});
