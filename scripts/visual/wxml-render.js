/**
 * WXML → HTML 渲染器（视觉回归专用，不进发布包）
 *
 * 为什么需要它：本项目 2263 项断言全是「行为级 / 静态守卫」，没有一项能证明
 * 「画面看起来是对的」。历史上座位遮挡、气泡压底池、河牌被裁这些问题，都是靠
 * 人工算坐标发现的——算坐标只能证明「数学上不重叠」，证明不了「观感好不好」，
 * 而且算错坐标时会得出完全相反的结论（本项目 review 中真实发生过三次）。
 *
 * 做法：不重写渲染逻辑，而是**复用小程序页面自己的 data**（跑页面 JS + mock
 * setData 拿到真实 data 快照），再把 WXML/WXSS 机械翻译成 HTML/CSS 交给浏览器
 * 截图。这样截图反映的就是真机的 data 与样式，而不是另写一套演示页面
 * （index.html 是自绘样式，没有 --uh / .felt，与小程序是两套东西，不能用来回归）。
 *
 * 支持的 WXML 子集（够本项目的 table 页用）：
 *   - 插值 {{ expr }}（文本与属性位置）
 *   - wx:if / wx:elif / wx:else
 *   - wx:for / wx:for-item / wx:for-index / wx:key
 *   - view/text/image/block 等标签映射
 * 不支持（本项目也未使用）自定义组件、wxs、template import。
 */

'use strict';

/** 小程序标签 → HTML 标签。view/text 在真机是 div/span，这里保持一致以免盒模型偏差 */
const TAG_MAP = {
  view: 'div',
  text: 'span',
  'scroll-view': 'div',
  block: null,           // 透明容器，只保留子节点
  image: 'img',
  button: 'button',
  navigator: 'a',
  label: 'label',
  form: 'form',
  input: 'input',
  textarea: 'textarea',
  switch: 'input',
  slider: 'input',
  canvas: 'canvas',
  video: 'video',
  'movable-area': 'div',
  'movable-view': 'div',
  'cover-view': 'div',
  'rich-text': 'div',
  icon: 'i'
};

const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link']);

/* ------------------------------------------------------------------ *
 * 表达式求值
 * ------------------------------------------------------------------ */

/**
 * WXML 插值里的表达式是 JS 子集（三元、逻辑、算术、属性访问、数组/对象字面量、
 * 字符串/数字字面量）。这里直接用 new Function 求值——输入是本仓库自己的模板，
 * 不是用户数据，注入风险可接受；渲染器只在本机跑，不进发布包。
 *
 * 求值失败不抛错：WXML 里若出现不支持的写法（或分词把一段文本切出了半个
 * 表达式），静默返回 undefined 比中断整张截图更有用——缺一块内容仍能看出
 * 布局对不对，而抛错会让整个场景失败、什么都看不到。
 */
function evalExpr(expr, scope) {
  // eslint-disable-next-line no-new-func
  try {
    const fn = new Function('__scope', 'with (__scope) { return (' + expr + '); }');
    return fn(scope);
  } catch (e) {
    if (process.env.VISUAL_DEBUG) {
      console.error('[wxml-render] 表达式求值失败: ' + JSON.stringify(expr) + ' → ' + e.message);
    }
    return undefined;
  }
}

/**
 * 求值一段可能含多个 {{ }} 的字符串或纯表达式。
 * WXML 属性里的 {{ }} 与文本里的 {{ }} 语义一致：整体是一个表达式时返回原生值
 * （可能是对象/数组/布尔），否则做字符串拼接。
 */
function interpolate(str, scope) {
  if (str == null) return '';
  const s = String(str);

  // 「整体是一个 {{ }}」才返回原生值（对象/数组/布尔）。
  // ⚠️ 不能写成 /^\s*\{\{([\s\S]*?)\}\}\s*$/ 就完事：非贪婪在这里会被 $ 逼着
  // 一路吃到最后一个 }}，把「{{a}} 文本 {{b}}」误判成单个表达式 {{a}} 文本 {{b}}，
  // 求值直接语法错误。必须先确认内部不再出现 {{ 与 }} 这对定界符：
  //   - 表达式内部不含 }}（用 [^}]* 近似不够，字符串字面量里可能有 '}'）
  //   - 因此先用「括号/引号配对扫描」找出第一个完整的 {{...}} 结束位置
  const whole = /^\s*\{\{/.test(s) && endOfFirstInterpolation(s, 0) === s.trimEnd().length;
  if (whole) {
    const inner = s.trim().slice(2, -2);
    return evalExpr(inner, scope);
  }

  if (s.indexOf('{{') < 0) return s;
  // 逐段扫描替换：用 endOfFirstInterpolation 找边界，避免正则把
  // 「{{a}} x {{b}}」里的第一段吃到第二个 }} 上。
  let out = '';
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{{', i);
    if (open < 0) { out += s.slice(i); break; }
    out += s.slice(i, open);
    const end = endOfFirstInterpolation(s, open);
    if (end < 0) { out += s.slice(open); break; }   // 未闭合：原样保留
    const expr = s.slice(open + 2, end - 2);
    const v = evalExpr(expr, scope);
    out += (v == null || v === false) ? '' : String(v);
    i = end;
  }
  return out;
}

/**
 * 从 s[start]（必须是 {{ 的位置）起，返回第一个「合法的」{{...}} 的结束下标（含 }}）。
 * 扫描时跟踪字符串引号与括号层级，避免把表达式里的字面量 '}' 当成定界符。
 */
function endOfFirstInterpolation(s, start) {
  let i = start + 2;
  let depth = 0;
  let quote = null;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; i++; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === '}' && s[i + 1] === '}') return i + 2;
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * 词法：切分为「标签 / 文本」序列
 * ------------------------------------------------------------------ */

/**
 * 把 WXML 源码切成 token 流。注释先剥离（含 {{!-- --}} 与 <!-- -->）。
 */
function tokenize(src) {
  let s = String(src);
  // 去注释：WXML 支持 <!-- --> 与 {{!-- --}}
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\{\{!--[\s\S]*?--\}\}/g, '');

  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      const text = s.slice(i);
      if (text.trim()) tokens.push({ type: 'text', value: text });
      break;
    }
    if (lt > i) {
      const text = s.slice(i, lt);
      if (text.trim()) tokens.push({ type: 'text', value: text });
    }
    // 找标签结束，注意属性值里的 > 不能当结束（用引号状态机）
    let j = lt + 1;
    let quote = null;
    let selfClose = false;
    while (j < s.length) {
      const ch = s[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        selfClose = s[j - 1] === '/';
        break;
      }
      j++;
    }
    const raw = s.slice(lt + 1, j);
    if (raw[0] === '/') {
      tokens.push({ type: 'close', name: raw.slice(1).trim() });
    } else {
      tokens.push({ type: 'open', raw: raw.replace(/\/$/, ''), selfClose });
    }
    i = j + 1;
  }
  return tokens;
}

/** 解析一个开标签的标签名与属性表（保留原始字符串，属性值延后求值） */
function parseOpenTag(raw) {
  const m = /^([\w-]+)([\s\S]*)$/.exec(raw.trim());
  if (!m) return { name: '', attrs: [] };
  const name = m[1];
  const rest = m[2];
  const attrs = [];
  const re = /([\w:.-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g;
  let a;
  while ((a = re.exec(rest))) {
    const key = a[1];
    const val = a[3] != null ? a[3] : (a[4] != null ? a[4] : '');
    attrs.push({ key, value: val });
  }
  return { name, attrs };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/**
 * 把节点树渲染成 HTML 字符串。
 * ctx: { scope, usedTags } —— usedTags 收集实际用到的标签，供 CSS 预处理
 */
function renderNodes(nodes, scope, ctx) {
  let out = '';
  let i = 0;
  while (i < nodes.length) {
    const n = nodes[i];
    if (n.type === 'text') {
      const v = interpolate(n.value, scope);
      // 文本节点里若整体是对象/数组则丢弃（WXML 也不会显示）
      out += (typeof v === 'object' && v !== null) ? '' : escapeHtml(String(v == null ? '' : v));
      i++;
      continue;
    }
    if (n.type !== 'el') { i++; continue; }

    // 处理 if / elif / else 链：从头收集同层相邻的条件节点
    const chainResult = renderConditionalChain(nodes, i, scope, ctx);
    if (chainResult) {
      out += chainResult.html;
      i = chainResult.next;
      continue;
    }

    // 没有条件指令：直接按 for 展开后渲染
    out += renderElement(n, scope, ctx);
    i++;
  }
  return out;
}

/** 处理 node 自身（若有 wx:if 则连同后续 elif/else 组成链） */
function renderConditionalChain(nodes, start, scope, ctx) {
  const first = nodes[start];
  const hasIf = getDirective(first, 'wx:if') !== undefined;
  const hasFor = getDirective(first, 'wx:for') !== undefined;
  // for 外层优先：带 for 的节点自己负责展开，不参与同级条件链（WXML 语义上
  // wx:for 与 wx:if 同级时先 for 后 if，本模板未出现该组合，按简单情况处理）
  if (!hasIf || hasFor) return null;

  let i = start;
  let done = false;
  let html = '';
  let guard = 0;
  while (i < nodes.length && guard++ < 200) {
    const n = nodes[i];
    if (n.type !== 'el') {
      if (n.type === 'text' && !done) { html += renderNodes([n], scope, ctx); i++; continue; }
      break;
    }
    const condIf = getDirective(n, 'wx:if');
    const condElif = getDirective(n, 'wx:elif');
    const hasElse = getDirective(n, 'wx:else') !== undefined;
    if (i === start) {
      if (!done && truthy(interpolate(condIf, scope))) { html += renderElement(n, scope, ctx, { skipCond: true }); done = true; }
      i++;
      continue;
    }
    if (condElif !== undefined) {
      if (!done && !constFalse(condElif) && truthy(interpolate(condElif, scope))) {
        html += renderElement(n, scope, ctx, { skipCond: true }); done = true;
      }
      i++;
      continue;
    }
    if (hasElse) {
      if (!done) { html += renderElement(n, scope, ctx, { skipCond: true }); done = true; }
      i++;
      break;
    }
    break;
  }
  return { html, next: i };
}

/** 取指令值（属性位置求值成原始字符串，交给 interpolate 再求值） */
function getDirective(node, key) {
  const a = node.attrs && node.attrs.find(x => x.key === key);
  return a ? a.value : undefined;
}

function constFalse(expr) {
  // wx:elif="{{false}}" 之类：求值结果为 false，不是「条件不成立」而是「永不成立」
  return expr === 'false' || expr === '{{false}}';
}

function truthy(v) {
  return !!v;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 渲染单个元素：先展开 wx:for，再判条件，最后输出标签。
 */
function renderElement(node, scope, ctx, opts) {
  opts = opts || {};
  const forExpr = getDirective(node, 'wx:for');
  if (forExpr !== undefined && !opts.skipFor) {
    const list = interpolate(forExpr, scope);
    const arr = Array.isArray(list) ? list : (list && typeof list === 'object' ? Object.values(list) : []);
    const itemName = (getDirective(node, 'wx:for-item') || 'item').trim();
    const indexName = (getDirective(node, 'wx:for-index') || 'index').trim();
    let out = '';
    for (let k = 0; k < arr.length; k++) {
      const childScope = Object.create(scope);
      childScope[itemName] = arr[k];
      childScope[indexName] = k;
      out += renderElement(node, childScope, ctx, { skipFor: true, skipCond: opts.skipCond });
    }
    return out;
  }

  if (!opts.skipCond) {
    const cond = getDirective(node, 'wx:if');
    if (cond !== undefined && !truthy(interpolate(cond, scope))) return '';
  }

  return renderTag(node, scope, ctx);
}

/** 真正输出标签（属性求值 + 子节点递归） */
function renderTag(node, scope, ctx) {
  const tag = node.name;
  const htmlTag = Object.prototype.hasOwnProperty.call(TAG_MAP, tag) ? TAG_MAP[tag] : 'div';

  const attrs = {};
  let classStr = '';
  let styleStr = '';
  for (const a of node.attrs) {
    const k = a.key;
    if (k.startsWith('wx:') || k === 'wx:key') continue;
    if (k === 'bindtap' || k === 'catchtap' || k === 'bindtouchstart' || k === 'catchtouchstart' ||
        k === 'bindinput' || k === 'bindchange' || k === 'bindlongpress' || k === 'catchlongpress' ||
        k === 'bindtouchmove' || k === 'bindtouchend' || k === 'bindconfirm' || k === 'bindblur') continue;

    const v = interpolate(a.value, scope);
    if (k === 'class') { classStr = v == null ? '' : String(v); continue; }
    if (k === 'style') { styleStr = v == null ? '' : String(v); continue; }
    attrs[k] = v;
  }

  // class 里可能有 {{}} 已经求值完；style 同理
  let html = '';
  if (htmlTag === null) {
    // block：不输出容器，只输出子节点
    return renderNodes(node.children || [], scope, ctx);
  }
  if (ctx && ctx.usedTags) ctx.usedTags.add(htmlTag);

  html += '<' + htmlTag;
  if (classStr) html += ' class="' + escapeHtml(classStr) + '"';
  if (styleStr) html += ' style="' + escapeHtml(styleStr) + '"';
  for (const k in attrs) {
    const v = attrs[k];
    if (v === false || v == null) continue;
    if (htmlTag === 'img' && k === 'src') { html += ' src="' + escapeHtml(String(v)) + '"'; continue; }
    if (k === 'src' || k === 'href' || k === 'id' || k === 'data-id') {
      html += ' ' + k + '="' + escapeHtml(String(v)) + '"';
    }
  }
  if (VOID_TAGS.has(htmlTag)) return html + '>';

  html += '>';
  html += renderNodes(node.children || [], scope, ctx);
  html += '</' + htmlTag + '>';
  return html;
}

/* ------------------------------------------------------------------ *
 * 解析成树
 * ------------------------------------------------------------------ */

/**
 * token 流 → 节点树。每个元素节点带 attrs 与 children。
 * WXML 允许自闭合与隐式闭合，这里要求标签配对（check-wxml.js 已在测试里保证平衡）。
 */
function parseTree(tokens) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  for (const t of tokens) {
    const top = stack[stack.length - 1];
    if (t.type === 'text') {
      top.children.push({ type: 'text', value: t.value });
    } else if (t.type === 'open') {
      const { name, attrs } = parseOpenTag(t.raw);
      const el = { type: 'el', name, attrs, children: [] };
      top.children.push(el);
      if (!t.selfClose && !VOID_TAGS.has(TAG_MAP[name])) stack.push(el);
    } else if (t.type === 'close') {
      // 弹栈到匹配名字（容忍少量不规范嵌套）
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === t.name) { stack.length = k; break; }
      }
    }
  }
  return root;
}

/**
 * 主入口：WXML 源码 + 数据 → HTML 片段
 * @returns {{ html: string, usedTags: Set<string> }}
 */
function renderWxml(wxmlSrc, data) {
  const tokens = tokenize(wxmlSrc);
  const tree = parseTree(tokens);
  const ctx = { usedTags: new Set() };
  const html = renderNodes(tree.children, data || {}, ctx);
  return { html, usedTags: ctx.usedTags };
}

module.exports = { renderWxml, interpolate, tokenize, parseTree, TAG_MAP, VOID_TAGS };
