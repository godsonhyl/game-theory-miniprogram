/**
 * 极简游戏音效（零资源文件：WebAudio 实时合成）
 *
 * 设计约束：
 *   - 小程序包内不放任何 .mp3/.wav（省体积、免下载），全部用
 *     wx.createWebAudioContext() 的振荡器现场合成短促音色；
 *   - 任何异常一律静默吞掉（老基础库没有 WebAudio / 音频通道被占用时
 *     自动退化为无声），绝不能影响牌局逻辑；
 *   - 单例 context 懒加载：首次 play 才创建，页面不播声音就零开销。
 *
 * 音色一览（全部 < 0.6s，短促不吵）：
 *   deal   发牌/翻公共牌     高频短「唰」
 *   check  过牌             桌面轻敲两下（低频咚咚）
 *   bet    跟注/下注         筹码入池（两声高频嗒）
 *   raise  加注             筹码 + 上行双音（提示性更强）
 *   allin  全下             重筹码砸桌 + 三连上行（高张力）
 *   fold   弃牌             低频下滑「噗」
 *   turn   轮到我行动        柔和双频叮咚（提示音）
 *   win    赢下本手          上行琶音（C-E-G-C）
 *   end    本手结束（未赢）   下行双音（中性收尾）
 *   click  按钮/界面点击      30ms 高频嗒
 *   warn   行动倒计时 5s/3s   轻短「嗒嗒」滴答（防误超时代弃）
 *   clock  限时局最后 60s     柔和钟音（与 UI 变橙同阈值，视觉+听觉双提示）
 *   timeout 被动代弃/自动站起  下行双音（中性偏负，提示「非你主动」）
 *   chat   收到对手/AI 消息   轻短「啵」（社交反馈，我的消息不响）
 *   blind  盲注涨盲           上行三连（D5-G5-B5），提示性提示「注码变高」
 *   eliminate SNG 淘汰        下行低频沉音（A3-F3-D3），出局感
 *   champion SNG 夺冠         上行琶音 C5-E5-G5-C6-E6（凯旋，比 win 多一高点）
 */

let ctx = null;          // 懒加载的 WebAudioContext 单例
let failed = false;      // 创建失败标记（之后不再重试，避免每次 play 都抛错）
let unlocked = false;    // 是否已被用户手势解锁过（见 unlock）

function ensureCtx() {
  if (ctx) return ctx;
  if (failed) return null;
  try {
    if (typeof wx === 'undefined' || !wx.createWebAudioContext) { failed = true; return null; }
    ctx = wx.createWebAudioContext();
  } catch (e) { failed = true; ctx = null; }
  return ctx;
}

/**
 * 解锁音频上下文 —— 必须在用户手势的同步调用栈里执行。
 *
 * ⚠️ 这是「真机完全没声音」的头号原因：
 * WebAudio 上下文创建后状态是 suspended，此时 currentTime 恒为 0、不推进，
 * 振荡器能建好也能连到 destination，但渲染线程不跑 → 一片寂静，且不报任何错。
 * 必须由一次真实的 touch/click 触发 resume() 才能进入 running。
 *
 * 页面在 onLoad 后立刻挂一次根节点 bindtouchstart 调本函数（见 table.js onFirstTouch），
 * 之后所有音效都不再受自动播放策略限制。
 * 幂等：重复调用只在非 running 时才 resume。
 */
function unlock() {
  const c = ensureCtx();
  if (!c) return false;
  try {
    if (c.state === 'running') { unlocked = true; return true; }
    const r = c.resume && c.resume();
    // resume 返回 Promise（部分基础库）；失败也不阻塞，静默等下一次手势
    if (r && typeof r.then === 'function') {
      r.then(() => { unlocked = true; }, () => { /* 仍未解锁，等下次手势 */ });
    } else {
      unlocked = true;
    }
    return true;
  } catch (e) { return false; }
}

/** 上下文是否可用（用于「音效开关」显示真实状态，而非假装开着） */
function available() {
  const c = ensureCtx();
  return !!c;
}

/** 当前是否真的在发声状态（running）—— 供诊断/测试用 */
function isRunning() {
  return !!(ctx && ctx.state === 'running');
}

/**
 * 单音节点：osc(t 起始, freq, dur, type, vol, glideTo)
 *   glideTo 存在时频率从 freq 滑向 glideTo（下滑/上滑音效用）
 */
function osc(c, t, freq, dur, type, vol, glideTo) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, glideTo), t + dur);
  // 快起慢收包络：5ms 内起音，指数衰减到近乎 0（听感干净无咔哒声）
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(c.destination);
  // 尾部多留 30ms 再停：部分基础库会在 stop() 时刻硬切波形，
  // 提前停会把正在衰减的尾巴砍出一个「咔」声。
  const end = t + dur + 0.03;
  o.start(t); o.stop(end);
  // 节点自动回收：避免长时间对局累积几百个已停止的 oscillator
  if (typeof o.onended === 'function') {
    try { o.onended = function () { try { o.disconnect(); g.disconnect(); } catch (e) {} }; } catch (e) {}
  }
}

/* ---------- 音色编排（t = 起始时刻，s = 秒） ---------- */
const PRESETS = {
  // 发牌：高频三角波瞬音 + 轻微下滑，像牌擦过桌布
  deal(c, t) {
    osc(c, t, 2400, 0.05, 'triangle', 0.10, 1200);
  },
  // 过牌：指节敲桌两下（低频正弦短音）
  check(c, t) {
    osc(c, t, 190, 0.07, 'sine', 0.22);
    osc(c, t + 0.1, 160, 0.07, 'sine', 0.18);
  },
  // 跟注/下注：筹码入池（两声高频嗒，第二声更轻）
  bet(c, t) {
    osc(c, t, 2100, 0.035, 'square', 0.07);
    osc(c, t + 0.06, 1700, 0.03, 'square', 0.05);
  },
  // 加注：筹码 + 上行双音（E5→A5），提醒「注码变了」
  raise(c, t) {
    osc(c, t, 2100, 0.035, 'square', 0.08);
    osc(c, t + 0.05, 1700, 0.03, 'square', 0.055);
    osc(c, t + 0.1, 659, 0.1, 'triangle', 0.1);
    osc(c, t + 0.18, 880, 0.14, 'triangle', 0.1);
  },
  // 全下：重筹码砸桌（低频砰）+ 三连上行（高张力）
  allin(c, t) {
    osc(c, t, 130, 0.12, 'sine', 0.3, 70);
    osc(c, t + 0.12, 523, 0.09, 'triangle', 0.12);
    osc(c, t + 0.21, 659, 0.09, 'triangle', 0.12);
    osc(c, t + 0.3, 784, 0.18, 'triangle', 0.13);
  },
  // 弃牌：低频下滑「噗」
  fold(c, t) {
    osc(c, t, 320, 0.14, 'sine', 0.16, 140);
  },
  // 轮到我：柔和叮咚（880 + 泛音 1760），不刺耳
  turn(c, t) {
    osc(c, t, 880, 0.16, 'sine', 0.14);
    osc(c, t, 1760, 0.1, 'sine', 0.05);
    osc(c, t + 0.16, 1174, 0.2, 'sine', 0.12);
  },
  // 赢下本手：上行琶音 C5-E5-G5-C6
  win(c, t) {
    [523, 659, 784, 1046].forEach((f, i) => {
      osc(c, t + i * 0.09, f, 0.16, 'triangle', 0.13);
    });
  },
  // 本手结束（未赢）：下行双音，中性收尾
  end(c, t) {
    osc(c, t, 660, 0.12, 'sine', 0.1);
    osc(c, t + 0.13, 440, 0.18, 'sine', 0.1);
  },
  // 界面点击：30ms 高频嗒
  click(c, t) {
    osc(c, t, 1300, 0.03, 'square', 0.05);
  },
  // 行动倒计时警告（5s/3s）：轻短「嗒嗒」滴答，比 click 更轻更短，紧迫但不刺耳
  warn(c, t) {
    osc(c, t, 1600, 0.03, 'square', 0.06);
    osc(c, t + 0.12, 1300, 0.03, 'square', 0.06);
  },
  // 限时局最后 60s：柔和钟音下滑（C5→G4），与 UI 变橙同阈值
  clock(c, t) {
    osc(c, t, 523, 0.18, 'sine', 0.12, 392);
  },
  // 被动代弃/自动站起：下行双音（A4→D4），中性偏负，提示「非你主动」
  timeout(c, t) {
    osc(c, t, 440, 0.12, 'sine', 0.12);
    osc(c, t + 0.13, 294, 0.2, 'sine', 0.12);
  },
  // 收到对手/AI 消息：轻短「啵」，三角波单声，社交反馈不抢戏
  chat(c, t) {
    osc(c, t, 880, 0.08, 'triangle', 0.08);
  },
  // 盲注涨盲：上行三连 D5-G5-B5（大调上行提示「升级了」），柔和三角波不刺耳
  blind(c, t) {
    [587, 784, 988].forEach((f, i) => {
      osc(c, t + i * 0.08, f, 0.14, 'triangle', 0.11);
    });
  },
  // 批⑤：SNG 淘汰——下行低频沉音（A3→F3→D3），出局感，短促不拖沓
  eliminate(c, t) {
    [220, 175, 147].forEach((f, i) => {
      osc(c, t + i * 0.12, f, 0.16, 'sine', 0.14, f * 0.7);
    });
  },
  // 批⑤：SNG 夺冠——上行琶音 C5-E5-G5-C6-E6（大调凯旋，比 win 多一个高点）
  champion(c, t) {
    [523, 659, 784, 1046, 1318].forEach((f, i) => {
      osc(c, t + i * 0.1, f, 0.18, 'triangle', 0.14);
    });
  },
};

/**
 * 播放一个音效。任何情况下都不抛错：
 * 没有 WebAudio 能力 / 合成异常 → 静默跳过。
 */
function play(name) {
  const c = ensureCtx();
  if (!c) return;
  const fn = PRESETS[name];
  if (!fn) return;
  // ⚠️ 不要再用 `if (!c.currentTime) return` 当守卫：
  // 上下文 suspended 时 currentTime 恒为 0，会把每一次播放都挡掉，
  // 而这恰恰是「解锁前」的所有播放 —— 于是永远等不到声音，形成死锁。
  // 这里改为：时钟没走就先尝试解锁并跳过本次（下一帧/下一次手势后再响）。
  const t0 = c.currentTime || 0;
  if (!t0) {
    if (!unlocked) unlock();
    return;
  }
  try {
    fn(c, t0 + 0.01);
  } catch (e) { /* 音频通道偶发占用等：本次静默 */ }
}

module.exports = { play, unlock, available, isRunning };
