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
 */

let ctx = null;          // 懒加载的 WebAudioContext 单例
let failed = false;      // 创建失败标记（之后不再重试，避免每次 play 都抛错）

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
  o.start(t); o.stop(t + dur + 0.05);
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
};

/**
 * 播放一个音效。任何情况下都不抛错：
 * 没有 WebAudio 能力 / 合成异常 → 静默跳过。
 */
function play(name) {
  const c = ensureCtx();
  if (!c || !c.currentTime) return;
  const fn = PRESETS[name];
  if (!fn) return;
  try {
    fn(c, c.currentTime + 0.01);
  } catch (e) { /* 音频通道偶发占用等：本次静默 */ }
}

module.exports = { play };
