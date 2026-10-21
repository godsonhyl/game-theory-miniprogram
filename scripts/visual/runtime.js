/**
 * 视觉回归 —— 场景构建器（视觉回归专用，不进发布包）
 *
 * 目的：拿到「真实页面 data」喂给 WXML 渲染器，使截图反映真机画面。
 * 做法与 test-miniprogram-logic.js 相同——mock wx / Page / getApp 后 require 页面
 * JS，驱动它走到目标状态，再取 data。不另写演示数据，避免截图与真机脱节。
 */

'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const MP = path.join(ROOT, 'miniprogram');

/**
 * 建立一次干净的页面运行时（wx mock + Page 捕获），返回 pageCtx 与取数工具。
 * 每次调用都清 require cache，保证多场景之间互不污染（与 test-room-sync.js 同法）。
 */
function createRuntime(viewport) {
  const store = { storage: {} };

  const wx = {
    getWindowInfo: () => ({
      windowWidth: viewport.width,
      windowHeight: viewport.height,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      pixelRatio: 2,
      statusBarHeight: 0,
      safeArea: { top: 0, bottom: viewport.height, left: 0, right: viewport.width }
    }),
    getSystemInfoSync: () => wx.getWindowInfo(),
    createSelectorQuery: () => {
      const q = {
        select: () => q,
        selectAll: () => q,
        boundingClientRect: () => q,
        exec: (cb) => {
          // 测量 .felt 真实高度：按真实布局换算（playing 态 ≈65.9uh）
          // 这里给各场景注入期望值，模拟真机测量结果
          const rects = [{ height: viewport.feltUh * Math.min(viewport.width, viewport.height) / 100 }];
          if (typeof cb === 'function') cb(rects);
        }
      };
      return q;
    },
    getStorageSync: (k) => store.storage[k],
    setStorageSync: (k, v) => { store.storage[k] = v; },
    removeStorageSync: (k) => { delete store.storage[k]; },
    showToast: () => {},
    hideToast: () => {},
    showModal: () => {},
    showActionSheet: () => {},
    vibrateShort: () => {},
    vibrateLong: () => {},
    setClipboardData: () => {},
    stopPullDownRefresh: () => {},
    startPullDownRefresh: () => {},
    onNetworkStatusChange: () => {},
    onWindowResize: () => {},
    offWindowResize: () => {},
    createInnerAudioContext: () => ({
      play: () => {}, stop: () => {}, destroy: () => {},
      onEnded: () => {}, onError: () => {}, pause: () => {}
    }),
    createWebAudioContext: () => null,
    Redirecting: false,
    navigateTo: () => {},
    redirectTo: () => {},
    navigateBack: () => {},
    switchTab: () => {},
    reLaunch: () => {},
    setNavigationBarTitle: () => {},
    setNavigationBarColor: () => {},
    login: () => {},
    request: () => {},
    cloud: null,
    getUpdateManager: () => ({ onCheckForUpdate: () => {}, onUpdateReady: () => {}, onUpdateFailed: () => {}, applyUpdate: () => {} }),
    getShareInfo: () => {},
    showShareMenu: () => {},
    hideShareMenu: () => {},
    exitMiniProgram: () => {}
  };

  const prev = {
    wx: global.wx,
    Page: global.Page,
    getApp: global.getApp,
    App: global.App,
    Component: global.Component
  };

  let captured = null;
  global.wx = wx;
  global.Page = (cfg) => { captured = cfg; };
  global.App = () => {};
  global.Component = () => {};
  global.getApp = () => ({ globalData: {}, onLaunch: () => {} });

  // 清缓存，保证模块级单例（_ringCache/_cardCache 等）也是干净的
  const tableJsPath = path.join(MP, 'pages', 'table', 'table.js');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(MP)) delete require.cache[key];
  }
  require(tableJsPath);

  if (!captured) throw new Error('页面 JS 未捕获到 Page 配置');

  // 页面实例：data / setData（浅合并，与真实小程序 setData 语义足够接近）
  const dataStore = JSON.parse(JSON.stringify(captured.data || {}));
  const pageCtx = Object.assign({}, captured, {
    data: dataStore,
    setData(patch, cb) {
      if (typeof patch === 'string') return;
      for (const k of Object.keys(patch || {})) dataStore[k] = patch[k];
      if (typeof cb === 'function') cb();
    }
  });

  // 注：restore() 之后页面里残留的 setTimeout 回调仍可能调 wx.*（如 doAct 的
  // 振动反馈）。所以 restore 不把 global.wx 抹成 undefined，而是保留一个空壳，
  // 避免「场景已跑完、定时器迟到一步」时抛 TypeError 打断截图。
  const noopWx = new Proxy({}, { get: () => () => {} });

  function restore() {
    global.wx = prev.wx || noopWx;
    global.Page = prev.Page;
    global.getApp = prev.getApp;
    global.App = prev.App;
    global.Component = prev.Component;
  }

  /** 停掉页面里所有定时器，避免残留回调在截图期间改数据 */
  function stopTimers() {
    if (Array.isArray(pageCtx.botReadyTimers)) pageCtx.botReadyTimers.length = 0;
    for (const fn of ['clearAllTimers', 'clearAllinTimer', 'clearBlindTimer',
                      'clearFoldTimer', 'clearResultTimer', 'clearResultModalTimer', 'stopSync']) {
      try { if (typeof pageCtx[fn] === 'function') pageCtx[fn](); } catch (e) { /* 场景收尾，忽略 */ }
    }
  }

  return { pageCtx, dataStore, wx, store, restore, stopTimers };
}

/**
 * 假时钟：接管 setTimeout/setInterval，支持「同步跑完到某个时间点」。
 *
 * 为什么必须接管：页面里大量用 setTimeout 推进流程——快速入桌（quick）靠
 * `setTimeout(() => sitSeat(...))` 发牌、bot 行动、结算弹窗时序都是异步的。
 * 真实等待会让截图脚本不确定（跑多久才算「牌局进行中」？bot 想了多久？），
 * 而且一个场景要等好几秒，18 张图就是一两分钟。改成同步推进后：
 * 场景构造是确定的（跑 N 毫秒的虚拟时间），且瞬间完成。
 */
function installFakeTimers() {
  const origSetTimeout = global.setTimeout;
  const origClearTimeout = global.clearTimeout;
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  // Math.random 也要接管：牌序虽由 seed 决定，但 bot 决策、动画时序等仍有
  // 走 Math.random 的地方，不固定就会让画面抖动。
  const origRandom = Math.random;
  let randState = 0x9e3779b9;
  Math.random = () => {
    // xorshift32，固定初值 → 每次运行同一序列
    randState ^= randState << 13; randState >>>= 0;
    randState ^= randState >>> 17;
    randState ^= randState << 5; randState >>>= 0;
    return randState / 4294967296;
  };

  let now = 0;
  let seq = 0;
  const timers = new Map();   // id → { at, fn, args, every }

  function add(fn, delay, args, every) {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, delay | 0), fn, args, every: every ? Math.max(1, delay | 0) : 0 });
    return id;
  }
  function del(id) { timers.delete(id); }

  global.setTimeout = (fn, delay, ...args) => add(fn, delay, args, false);
  global.setInterval = (fn, delay, ...args) => add(fn, delay, args, true);
  global.clearTimeout = (id) => del(id);
  global.clearInterval = (id) => del(id);

  // ⚠️ 必须在替换 global.Date 之前抓住原始 Date 与其 now，否则 FakeDate.now()
  // 里再调 Date.now() 会调到自己（本项目踩过：无限递归栈溢出）。
  //
  // 关键：基准时间取一个**固定常量**而不是真实当前时间。页面开局用
  // `seed: 'mp-' + Date.now()` 做牌种，若基准是真实时间，每次跑出的牌都不同、
  // 截图永远不稳（本项目踩过：18 张图 14 张每次都不一样，基线比对没法用）。
  // 固定 epoch 后同场景同视口 → 同牌序 → 画面可复现。
  const OrigDate = global.Date;
  const FIXED_EPOCH = 1735689600000;   // 2025-01-01T00:00:00Z，任意固定值即可

  class FakeDate extends OrigDate {
    constructor(...a) {
      if (a.length === 0) super(FIXED_EPOCH + now);
      else super(...a);
    }
    static now() { return FIXED_EPOCH + now; }
  }

  return {
    /** 推进虚拟时间 ms，按到期顺序同步执行回调；含 setInterval 的重排 */
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        if (guard++ > 200000) break;   // 死循环保护
        let nextId = null;
        let nextAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; }
        }
        if (nextId == null) break;
        const t = timers.get(nextId);
        now = t.at;
        if (t.every) t.at = now + t.every; else timers.delete(nextId);
        try { t.fn(...(t.args || [])); } catch (e) { /* 场景推进中的异常不中断截图 */ }
        if (t.every && t.at > target) timers.delete(nextId);
      }
      now = target;
    },
    setDate() { global.Date = FakeDate; },
    restore() {
      global.setTimeout = origSetTimeout;
      global.clearTimeout = origClearTimeout;
      global.setInterval = origSetInterval;
      global.clearInterval = origClearInterval;
      global.Date = OrigDate;
      global.Math.random = origRandom;
      timers.clear();
    },
    pending() { return timers.size; }
  };
}

module.exports = { createRuntime, installFakeTimers, ROOT, MP };
