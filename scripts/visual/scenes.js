/**
 * 视觉回归 —— 场景定义（视觉回归专用，不进发布包）
 *
 * 每个场景 = 一个「真机状态」的可复现构造：驱动真实页面 JS 走到该状态，取 data
 * 快照。场景选的是历史上真出过事的地方，不是随便截图：
 *   - 座位遮挡（2026-10-19 用户反馈「顶排筹码被底池遮挡」）
 *   - 河牌被裁（8a16e54 .sr-board 定宽 46uh 装不下 5 张）
 *   - 8/9 位桌拥挤（本仓库 review 中反复出问题的桌型）
 *   - 结算弹窗、全下、边池
 *
 * ⚠️ 用假时钟同步推进：快速入桌（quick）靠 setTimeout 异步发牌，不接管定时器
 * 就永远停在等待室（本项目踩过：18 个场景渲染出相同画面）。
 */

'use strict';

const { createRuntime, installFakeTimers } = require('./runtime');

/**
 * 构造一个已开局的 AI 桌。
 * @param {object} viewport
 * @param {object} opts { seats, level, advanceMs }
 *
 * ⚠️ 座位数要同时传 `max` 与 `bots`：maxSeats（桌子总座位数）由 opts.max 决定
 * （默认 6），而 quickBots 只决定补几个 bot。只传 bots 不传 max 的话，所有场景
 * 都会被截到 6 座、渲染出同一张图（本项目踩过，靠比对文件 hash 才发现）。
 */
function startAiTable(viewport, opts) {
  const o = Object.assign({ seats: 6, level: 'advanced', advanceMs: 1200 }, opts || {});
  const bots = Math.max(1, o.seats - 1);
  const clock = installFakeTimers();
  clock.setDate();
  let rt;
  try {
    rt = createRuntime(viewport);
    rt.pageCtx.onLoad({
      mode: 'ai',
      quick: '1',
      max: String(o.seats),
      bots: String(bots),
      level: o.level
    });
    // quick 路径用 setTimeout 坐下 + 发牌；推进虚拟时间让它跑完
    clock.advance(o.advanceMs);
    if (!rt.dataStore.rootStyle) rt.pageCtx.updateViewport();
    return { rt, clock };
  } catch (e) {
    clock.restore();
    throw e;
  }
}

/**
 * 打到一手结束，停在结算单弹出态。
 *
 * 为什么需要这个场景：结算单 `.sr-board` 是「河牌被裁」事故的发生地——
 * 2c38b85 把宽度从 46uh 改到 50uh 仍不够，又放宽到 54uh / 卡片 5.2uh。
 * 也就是说这个 bug 修了两轮，只靠断言（`overflow:hidden` + 宽度数值）没能
 * 一次做对。结算态是「牌局进行中」场景完全看不到的画面，必须单独覆盖。
 */
function startSettlement(viewport, opts) {
  const o = Object.assign({ seats: 9, level: 'advanced' }, opts || {});
  const clock = installFakeTimers();
  clock.setDate();
  let rt;
  try {
    rt = createRuntime(viewport);
    rt.pageCtx.onLoad({
      mode: 'ai', quick: '1',
      max: String(o.seats),
      bots: String(Math.max(1, o.seats - 1)),
      level: o.level
    });
    clock.advance(1500);
    // 推进到结算单弹出：轮到我时自动跟注/过牌，否则只推时钟让 bot 行动
    for (let k = 0; k < 400; k++) {
      const d = rt.dataStore;
      if (d.resultModal) break;
      if (d.phase !== 'playing') break;
      if (d.isMyTurn) {
        try { rt.pageCtx.onCheckOrCall(); } catch (e) { /* 无合法动作时跳过 */ }
      }
      clock.advance(1200);
    }
    if (!rt.dataStore.resultModal) throw new Error('未能推进到结算态');
    if (!rt.dataStore.rootStyle) rt.pageCtx.updateViewport();
    return { rt, clock };
  } catch (e) {
    clock.restore();
    throw e;
  }
}

/**
 * 场景表。build 返回 { rt, clock }；框架负责取数后调 rt.stopTimers() 与 clock.restore()。
 */
const SCENES = [
  {
    name: 'ai-2p',
    desc: '2 人桌（单挑）',
    build: (vp) => startAiTable(vp, { seats: 2 })
  },
  {
    name: 'ai-5p',
    desc: '5 人桌（侧位刚启用）',
    build: (vp) => startAiTable(vp, { seats: 5 })
  },
  {
    name: 'ai-6p',
    desc: '6 人桌',
    build: (vp) => startAiTable(vp, { seats: 6 })
  },
  {
    name: 'ai-7p',
    desc: '7 人桌（顶部 4 座）',
    build: (vp) => startAiTable(vp, { seats: 7 })
  },
  {
    name: 'ai-8p',
    desc: '8 人桌（每侧 2 侧位 + 顶 3，曾交叠）',
    build: (vp) => startAiTable(vp, { seats: 8 })
  },
  {
    name: 'ai-9p',
    desc: '9 人桌（最挤桌型）',
    build: (vp) => startAiTable(vp, { seats: 9, level: 'expert' })
  },
  {
    name: 'result-9p',
    desc: '9 人桌结算单（.sr-board 河牌被裁事故现场）',
    build: (vp) => startSettlement(vp, { seats: 9 })
  }
];

module.exports = { SCENES, startAiTable, startSettlement };
