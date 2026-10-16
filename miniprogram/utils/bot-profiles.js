/**
 * AI 角色档案（批②：AI 人格化组）。
 *
 * 纯数据模块：5 个固定角色，各自一套 style（决策入口参数，喂给引擎 aiDecide）、
 * 专属台词池（按场景分桶）、以及「马脚」线索（反应时间抖动 / 话痨倾向 / 专属习惯）。
 * table.js 按机器人序号绑定角色 → toPlayer/initGame 读 style、pickTalk 取台词、
 * scheduleAI 消费 tellPattern 做反应时间与聊天频率的微调。
 *
 * 设计取舍：
 *  - style 的 6 字段直接进引擎 aiDecide（决策入口，包装改不进去），故扩展字段
 *    bluffFreq/heroCall/slowplay/bluffSize 写在引擎里、默认兜底旧行为不变。
 *  - 台词是纯出口包装，不进引擎、不进云、不进任何指纹/快照，table.js 内消费。
 *  - tellPattern 同理纯客户端体验层（反应时间分布偏移、话多话少），是「马脚」
 *    而非确定信号——玩家可借它读对手，但不保证准确。
 *  - 难度分级（rookie/advanced/expert）通过 levelToStyles 覆写角色 style 的
 *    激进度梯度实现；读对手 VPIP 反制不在本批（aiDecide 无状态、跨手统计改动面过大）。
 *
 * 约定：角色按 BOT_NAMES 序号绑定（table.js botLabel 已按序号取名），故 PROFILES
 * 数组顺序与 BOT_NAMES 一一对应：林小满 / 陈默 / 苏晴 / 赵岩 / 周叙。
 */

/** 5 角色固定 style + 台词 + 马脚。顺序对齐 table.js 的 BOT_NAMES。 */
const PROFILES = [
  {
    name: '林小满',
    trait: '乐天派话痨',
    desc: '爱聊天，打法松，容易冲动',
    talkRate: 0.45,          // 话痨：触发概率高
    style: { aggro: 0.62, tight: 0.28, bluffFreq: 0.32, bluffSize: 0.55, heroCall: 0.18, slowplay: 0.05 },
    tellPattern: { bluffTalkBoost: 2.0 },   // 诈唬时话更多（掩饰）
    talks: {
      win: ['哈哈运气真好！', '这手收下啦～', '今天手气不错'],
      lose: ['哎怎么输了', '下一手一定赢回来', '你运气太好了吧'],
      bluff_success: ['嘿嘿，骗到你了', '我就说我会赢', '看穿我算你厉害'],
      bad_beat: ['不可能吧这都输！', '运气不在我这边', '再来再来'],
      fold: ['这手不玩了', '算了算了', '等下一手'],
      raise: ['加一下试试', '跟不跟嘛', '看我的'],
      allin: ['梭哈！', '全压了，怕不怕', '今天赌一把']
    }
  },
  {
    name: '陈默',
    trait: '沉默紧凶',
    desc: '话少手狠，专等好牌',
    talkRate: 0.15,          // 寡言：很少冒泡
    style: { aggro: 0.55, tight: 0.72, bluffFreq: 0.18, bluffSize: 0.4, heroCall: 0.08, slowplay: 0.22 },
    tellPattern: { bluffSilent: true },     // 诈唬时必沉默（反常）
    talks: {
      win: ['。', '收了', '运气'],
      lose: ['。', '输了', '嗯'],
      bluff_success: ['。', '运气', '看错了'],
      bad_beat: ['……', '不该跟', '下次'],
      fold: ['弃', '不跟', ''],
      raise: ['加', '跟不跟', ''],
      allin: ['全下', '压', '']
    }
  },
  {
    name: '苏晴',
    trait: '稳健平衡',
    desc: '打法均衡，话不多不少',
    talkRate: 0.30,
    style: { aggro: 0.50, tight: 0.50, bluffFreq: 0.25, bluffSize: 0.50, heroCall: 0.12, slowplay: 0.15 },
    tellPattern: { bluffTalkBoost: 1.3 },
    talks: {
      win: ['这手该赢', '不错', '运气站在我这边'],
      lose: ['认输', '你打得稳', '下一手再来'],
      bluff_success: ['被我骗到了吧', '这手我没牌', '看穿算你厉害'],
      bad_beat: ['就差一点', '运气差了些', '再打一手'],
      fold: ['弃了', '不值得跟', '这手放弃'],
      raise: ['加注', '该加就得加', '试你一下'],
      allin: ['全下', '赌这一把', '看牌了']
    }
  },
  {
    name: '赵岩',
    trait: '激进猛攻',
    desc: '喜欢施压，常诈唬',
    talkRate: 0.38,
    style: { aggro: 0.78, tight: 0.30, bluffFreq: 0.42, bluffSize: 0.75, heroCall: 0.25, slowplay: 0.08 },
    tellPattern: { bluffFast: true },       // 诈唬时反应急促（心虚）
    talks: {
      win: ['稳住就能赢！', '这手是冲出来的', '压你就是赢'],
      lose: ['可恶，输了', '运气没站我这边', '下一手翻盘'],
      bluff_success: ['哈哈被吓到了吧', '我根本没牌', '虚张声势也是本事'],
      bad_beat: ['这都输？', '不可能', '再来！'],
      fold: ['这手让了', '不值得', '换一手'],
      raise: ['加！看你跟不跟', '压你一手', '敢跟吗'],
      allin: ['梭哈！都跟上', '全压，怕了吧', '赌大的']
    }
  },
  {
    name: '周叙',
    trait: '冷静陷阱',
    desc: '慢打高手，专挖坑',
    talkRate: 0.22,
    style: { aggro: 0.45, tight: 0.58, bluffFreq: 0.20, bluffSize: 0.45, heroCall: 0.15, slowplay: 0.35 },
    tellPattern: { bluffFast: true },
    talks: {
      win: ['意料之中', '这手本就该赢', '慢慢来'],
      lose: ['你运气不错', '下一手继续', '没什么'],
      bluff_success: ['你没识破', '这手其实没牌', '虚的一手'],
      bad_beat: ['差一点', '运气不好', '没关系'],
      fold: ['弃了，等机会', '不值得', '这手放弃'],
      raise: ['加一点', '试探一下', '看你的反应'],
      allin: ['全下，都亮牌', '赌这一手', '看你敢不敢']
    }
  }
];

/**
 * 难度档位 → 对各字段施加的乘数偏移。
 * rookie（新手）：对手更弱——更松（多进池送筹码）、更被动（少诈唬/少跟注/少慢打）
 * advanced（进阶）：维持角色本色
 * expert（高手）：对手更强——更紧（更挑剔）、更激进诈唬、更多英雄跟注与慢打
 * 乘数作用在角色 style 上，clamp 到 [0,1]（heroCall/slowplay/bluffFreq 上限 1）。
 */
const LEVEL_MOD = {
  rookie:   { aggroMul: 0.7,  tightMul: 0.6,  bluffMul: 0.5,  heroMul: 0.4, slowMul: 0.5,  sizeMul: 0.8 },
  advanced: { aggroMul: 1.0,  tightMul: 1.0,  bluffMul: 1.0,  heroMul: 1.0, slowMul: 1.0,  sizeMul: 1.0 },
  expert:  { aggroMul: 1.2,  tightMul: 1.3,  bluffMul: 1.5,  heroMul: 1.6, slowMul: 1.5,  sizeMul: 1.2 }
};

const clamp01 = v => Math.max(0, Math.min(1, v));

/**
 * 按机器人序号 + 难度档位取角色 style。
 * @param {number} idx 机器人序号（对齐 BOT_NAMES）
 * @param {string} [level] 难度档位 'rookie'|'advanced'|'expert'，默认 advanced
 * @returns {object} 喂给 aiDecide 的 style（6 字段）
 */
function styleFor(idx, level) {
  const profile = PROFILES[idx % PROFILES.length];
  const mod = LEVEL_MOD[level] || LEVEL_MOD.advanced;
  const base = profile.style;
  return {
    aggro: clamp01(base.aggro * mod.aggroMul),
    tight: clamp01(base.tight * mod.tightMul),
    bluffFreq: clamp01(base.bluffFreq * mod.bluffMul),
    bluffSize: clamp01(base.bluffSize * mod.sizeMul),
    heroCall: clamp01(base.heroCall * mod.heroMul),
    slowplay: clamp01(base.slowplay * mod.slowMul)
  };
}

/**
 * 取角色档案（台词/马脚/触发率，不受难度影响——人格本色不随难度变）。
 * @param {number} idx 机器人序号
 * @returns {object|null} PROFILES 元素，越界返回 null
 */
function profileFor(idx) {
  const i = Number(idx);
  if (isNaN(i)) return null;
  return PROFILES[i % PROFILES.length] || null;
}

/**
 * 判定一句话所属场景：从 aiDecide 返回的 {action,reason} 推断。
 * reason 含「诈唬」且赢了 → bluff_success；否则按 action 走 win/lose/fold/raise/allin。
 * @param {object} d aiDecide 返回值
 * @param {boolean} [isBluffWin] 是否诈唬成功赢下本手（caller 在结算时判定）
 * @returns {string} 场景键，落到 talks 的某个桶
 */
function sceneOf(d, isBluffWin) {
  if (isBluffWin && d && /诈唬/.test(d.reason || '')) return 'bluff_success';
  const a = d && d.action;
  if (a === 'fold') return 'fold';
  if (a === 'allin') return 'allin';
  if (a === 'raise') return 'raise';
  return 'win';   // 兜底（call/check 赢牌）
}

/** 从场景桶里随机取一句台词；空桶兜底返回空串 */
function pickTalk(profile, scene) {
  if (!profile || !profile.talks) return '';
  const pool = profile.talks[scene] || profile.talks.win || [];
  if (!pool.length) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = {
  PROFILES,
  LEVEL_MOD,
  styleFor,
  profileFor,
  sceneOf,
  pickTalk
};
