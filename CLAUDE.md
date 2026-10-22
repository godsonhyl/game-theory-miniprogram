# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

微信小程序「博弈论」（好友房 + AI 对战的德州扑克）。产品名为「博弈论」，但玩法是 Texas Hold'em——文档/合规语境中的「德州扑克」指玩法本身，不可替换为产品名。纯 JavaScript，零框架，无构建步骤（微信开发者工具直接编译）。

## 常用命令

```bash
npm test                        # 全部测试（改动后必须跑）
npm run test:engine             # 引擎断言（test-core.js）
npm run test:mp                 # 牌桌页逻辑仿真（mock wx/Page）
npm run test:cards              # 牌面渲染逻辑
npm run test:cloud              # 云服务接入规范校验
npm run test:sdk                # SDK 加载
npm run test:pack               # 打包排除清单与 project.config.json 漂移校验
npm run test:wxml               # WXML 静态检查（标签闭合 + wx:for-item 声明）
npm run pack                    # 打包 dist/*.zip（三层校验：引擎存在/体积<2MB/页面四件套齐全）
npm run upload                  # miniprogram-ci 命令行上传体验版（需 private.<AppID>.key）
npm run preview                 # 仅生成预览包，不上传
npm run visual                  # 视觉回归：渲染 2~9 人桌 × 3 视口截图并与基线比对
npm run visual:update           # 确认画面变化符合预期后更新基线
```

测试全部是自研断言脚本（无 jest/mocha），直接 `node xxx.js` 运行，失败项会打印 label。跑单个测试：`node miniprogram/test-room-sync.js` 或对应 npm script。`npm test` = 12 个脚本全跑（2297 项断言），分两类：**行为/格式校验**（引擎 test-core / 牌桌页 test-miniprogram-logic / 牌面 test-cards / 云规范 test-cloud-integration / 首页 test-index-logic / 跨设备同步 test-room-sync / SDK test-sdk-load / JS 语法 check-js-syntax / WXML check-wxml / 打包规则 check-pack-rules / 视觉回归工具自检 visual/selftest）与**云端迁移护栏 check-cloud-migration**（见下）。改动后必须过。断言数是硬口径——改动后新增/删除断言要在 commit message 里说明。截图脚本（`visual/run.js`、`visual/compare.js`）依赖本机 Chrome 与基线图，**故意不并入 `npm test`**，跑 `npm run visual` 单独执行；`visual/selftest.js` 是纯 JS，已并入 `npm test`。

## 双树结构（易踩坑）

仓库根 = `project.config.json` 所在工程目录，小程序源码在 `miniprogram/` 子目录（`miniprogramRoot: "miniprogram/"`）。发布指引等文档里的「poker 目录」即指本仓库根目录。

- 根目录：`core/poker-core.js`（引擎源）、`index.html`（浏览器原型，对照参考）、`test-core.js`、`pack.js`/`upload.js`、根 `package.json`（npm scripts）。
- `miniprogram/`：真正的上传源。**禁止在 miniprogram/ 下出现 package.json / node_modules**（历史形态是「npm 依赖 + 开发者工具构建 npm」，30fe664 已彻底移除），SDK 现以内联源码形态放在 `miniprogram/utils/vendor/`，clone 即可上传；`scripts/check-pack-rules.js` 钉死「发布目录无 node_modules + 源码总字节 < 2MB」，违反直接 80051 发布失败。
- **引擎有两份 identical 拷贝**：`core/poker-core.js` 与 `miniprogram/core/poker-core.js`。改动任何一份必须同步复制到另一份（`cmp` 确认一致），已落库数据依赖其编码格式稳定。

## 架构

### 引擎（core/poker-core.js）

纯逻辑德州扑克引擎（UMD 包装，CommonJS + 全局双导出），零 DOM/网络依赖，~1450 行。要点：

- 牌编码 `0..51`：`rank = id >> 2, suit = id & 3`；金额一律整数筹码。
- 随机源可注入 seed（xorshift128+），同 seed 同动作序列 → 同结果（事件溯源回放的基础，`game.events` 记录全量）。
- 边池按承诺额分层合并，支持任意多路全下。
- `RANK_NAMES`（机读码，定长单字符）与 `RANK_DISPLAY`（UI 显示，T→10）职责严格分离，不可合并——`codeToCard` 等编解码依赖定长。
- 客户端定位：引擎仅做预渲染与 UI 反馈；现有实现为演示态，权威逻辑跑在「房主端」，上线底线是迁服务端。

### 牌桌页权威/镜像模型（pages/table/table.js，~5000 行，核心页面）

- **AI 对战 / 好友房房主端**：引擎跑在本机（权威端）。
- **好友房好友端（remoteMode）**：不跑引擎，把房主广播的快照镜像成本地 game 对象，按「我 = 本地 0 号位」重映射座位，复用同一套渲染与操作逻辑；动作经 room-sync 上行，房主消化后随下一帧广播。
- 座位环用统一的 `ringPositions()`（我固定底部中央，其余铺上方半圆），等待室与游戏中共用坐标（开局无跳变）。**几何纯函数已于 2026-10-21 抽到 `utils/table-geometry.js`**（`ringPositions` / `uhToFelt` / 全部几何常量 / NINE·EIGHT 座位模板）：`table.js` 顶部按名解构引用，本文件内 80 余处引用点不变；改几何只改那个模块，它是几何的**单一来源**。抽出的动因：测试原先只能用正则把 `ringPositions` 和一堆常量从 `table.js` 源码字符串里「抠」出来再 `new Function` 求值——常量截取靠正则锚点，增删注释/调整声明顺序就会漏截，且漏截报 `ReferenceError` 容易被误读成「几何实现错了」（2026-10-21 因多出 `FELT_UH_FALLBACK`/`uhToFelt` 两个依赖被迫改正则）。现在测试直接 `require` 真模块，几何成为真正的单元测试；另有「导出完整性」守卫：`table.js` 解构清单里任何一个符号模块没导出都会红灯（否则页面拿到 `undefined` 算出 NaN 坐标，座位飞出屏幕且难反查）。

- **座位块/中央盘面的纵向隔离（2026-10-19 用户反馈「顶排筹码被底池遮挡」→ 2026-10-21 单位混算根因修复）**：座位块以锚点为中心四外延伸（pie 环单一排布），块高 ≈26.4uh；下注胶囊浮到锚点上方（`.seat-bet` absolute）不占块底；底池 `top:35%`（`POT_ANCHOR.y` 必须同步）。⚠️ **uh 与 felt% 是两套单位**：纵向 CSS 尺寸全是 uh（视口高 1%），而座位 x/y、底池 top 是 felt%（相对 `.felt`，flex:1 弹性容器，playing 态实测仅 ≈65.9uh）——两套单位直减是历史病根。修正口径：`measureFelt()` 用 SelectorQuery **运行时实测** .felt 真实像素高 → `this.feltUh`（不写死任何机型数值；失败回退 `FELT_UH_FALLBACK=65`，取「换算放大、天花板收紧」的保守方向；测量固化到下一次 resize，不在 resultbar/readyPhase 压矮 felt 时重算——开局无跳变约束）。所有 uh→felt% 判定经 `uhToFelt()` 换算；**走廊座位锚点天花板按「无牌态内容栈」（`SEAT_META_STACK_UH`，走廊座位牌背被 topRow 判据隐藏、真实盒只有 meta 栈高）现算**：potTop − meta 半栈 − `RING_CEIL_GAP`；按 26.4uh 完整块算会把头像段压出 felt 顶被 page overflow 裁掉（数学上装不下，table.js 头注释有推导）。已知残余（接受）：翻前 SB/BB 座位 pos-tag 行可能探入底池带 ≈2 felt%。桌型分布：4 座以下全顶弧；5~7 座每侧 1 侧位；8 位桌每侧 2 侧位（同侧两座必须横向错开 > 名牌宽：内侧位 x=26 与外侧 x=12 差 14%，曾放 x=10 交叠）+ 顶部 3 座；9 位桌每侧 2 侧位 + 顶部 4 座。`test-miniprogram-logic.js` 的 `guardSeatCardNoOverlap` 直接 `require` 该模块、真跑「三档视口（fb/60/65.9/92）× 人数 [2..9]」组合断言几何，并有「8/9 位桌模板项数 = total−1、侧位镜像、任意两座宽内容不交叠」守卫（模板缺项会走 placeOnArc 兜底挤死顶排；两两间距是唯一能拦住「同侧两座只差 2%」这类回归的判据）——**改任何一处块尺寸必须同步常量（SEAT_H_PX_UH / SEAT_META_STACK_UH / POT_PILL_H / RING_CEIL_GAP 等）与 WXSS 表，否则测试会红**。曾试过的 `.seat.down` 窄视口兜底已删除：纵向尺寸全为 uh 相对量，触发条件在数学上不存在。
- 音效走 `utils/sfx.js` 的 WebAudio 实时合成（14 个 PRESETS 音色，零资源文件），`drainSfx()` 300ms 事件泵轮询 `game.events`（`sfxSeq` 游标）；提示音（倒计时警告/限时局/被动代弃/收到消息）挂在 startTimer/startClock/autoStandUnready/pushChat，全部 `soundOn` 门控，`unlock()` 必须在用户手势栈内（`onFirstTouch`）调用一次。

### 渲染脏检查指纹（三处，改动 render/sync 前必读）

牌桌有三道「同势跳过」指纹，避免轮询/计时每帧空转 setData 与写库。三者结构相同（拼关键状态字段 → 与缓存键比对 → 命中跳过），**改动任一指纹的字段集必须同步覆盖所有由它派生、且会写进 setData/写库的字段**，否则跳过分支会吞掉该字段的变化导致画面/同步漏帧：

- **`render()` 的 `_lastRenderFp`**：渲染前算指纹，命中跳过整帧 setData，但仍调 `_renderTail()`（结算弹窗时序 + `publishPlay`），防漏调度。指纹**必须含 `tick`**——但 `startTimer` 每秒走局部 setData（`seats[actIdx].timer`/`myTimer`，不调 render），故 render 不被每秒触发、指纹稳定；`tick` 入指纹是为「其他触发引起的 render 落在计时中段时也能取到当前残值」。`myActText`/`myActCls`/`myStanding`/`pendingSit`/`foldConfirm`/`raiseTo`/`raiseCustom`/`resultModal` 等派生态都要进指纹。新增任何写入 render 的 setData 字段都要同步加进指纹。
- **`writePlayState()` 的 `_lastPlayFp`**：房主 500ms 节流后仍每帧调到，指纹未变跳过写库；`forcePublish()`（站起/新手牌等关键状态）置 `_lastPlayFp=null` 穿透。
- **`enterRemote()` 的 `_lastRemoteFp`**：好友端 1.5s 轮询拿快照，指纹未变跳过 setData+render；座位重映射后用快照字段拼指纹。

### 渲染层缓存（纯函数 + 浅克隆隔离）

`ringPositions()` 有模块级 `_ringCache`（键 = 排序后 seatSet + mySeat + feltUh，按实测基准分道缓存不同视口），`cardData()` 有按 card id 的 `_cardCache`。两者都是纯函数缓存，命中即返回。**`cardData` 命中时必须浅克隆返回**——`markBest` 会原地写 `c.hi`，不克隆会污染缓存令下一帧 `hi` 残留。新增同类缓存遵循：纯输入 → 缓存 → 被下游原地改的返回值要克隆。

### 跨设备同步（utils/room-sync.js）

基于云端表的轮询模型：每个真人一行（RLS 只许改自己），房主行存房间公开状态（waiting/playing + snapshot + appliedSeqBySeat），好友动作写自己行动作字段上行，房主 1.5s 轮询按序号消化，心跳 5s / 15s 判离线，30s 行动超时代弃牌。云端不可用时静默降级为本地模拟。

- **seq 按座位分道**（不是房主单一全局水位）：`pendingActions(rows, appliedSeqBySeat)` 用「行座位 → 已应用 seq」的映射，seq 只区分同一行内动作的新旧，慢钟设备好友的动作不会被别家高 seq 永久跳过。
- **座位伪冒断言**：`applyFriendAction` 一律以行内 `rowSeat` 为准，payload `seat` 与行座位不符即整条丢弃——好友不能替他人行动。
- **房主心跳僵死检测**：房主行存在但心跳超 `OFFLINE_MS` 起计，超 `HOST_STALE_EXIT_MS`（30s 宽限）仍未恢复 → 好友端判房间僵死自动退出。
- 已知边界：快照含真人底牌，防作弊需服务端引擎（已议定封存，见 room-sync.js 头注释与 `docs/服务端化蓝图.md`）；room-sync 无 chat 字段，镜像端收不到好友间聊天。

### 云服务（utils/cloud.js + WorkBuddy SDK）

- 表：`poker_profiles` / `poker_records`（RLS 按用户隔离）、`poker_rooms`（按房号公开读）、`poker_room_seats`（同步座位）。
- 登录链路：`wx.login` → `signInWithWechat(code, appid)`，客户端不接触 AppSecret。
- **写操作 rpc 迁移护栏**：`migrations/` 存服务端函数 SQL；`scripts/check-cloud-migration.js` 静态校验 auth.js 调用的每个 rpc 名都能在 migrations/ 找到 CREATE FUNCTION（防改名失联），`--sql` 打印可粘到云端验证函数真实存在的 SQL（npm test mock 掉 cloud 层，rpc 缺失测不出来——commit ce1516a 的历史事故）。凡是让客户端新增/改调云端 rpc 的改动，必须同步落 migrations/ 并在云端执行。
- 安全红线：endpoint/publishableKey 是仅有的可放前端的配置；**禁止手写 `wx.request` 访问 `/.cloud/**`**（绕过凭证注入）；insert 不得携带 `owner_id`（服务端 `auth.uid()` 决定）。`test:cloud` 会校验这些规范及隐私声明与实际调用精确一致。
- 房卡扣减走乐观锁；上线需换服务端事务 + 幂等。

### 其余 utils

`table-geometry.js`（座位环几何纯函数，见牌桌页一节）、`room-snapshot.js`（退出续局，本地缓存，纯体验优化）、`sfx.js`（WebAudio 实时合成音效，零资源文件，异常全部静默）、`settings.js`（本地存储，不进云）、`auth.js`（登录 + 房卡扣减乐观锁 + 签到/对局奖励/战绩统计并发防护）、`workbuddy-cloud-diagnostics.js`。

## 测试方法

自研轻量框架：脚本内 mock `wx`/`Page`/`getApp` 后真实加载页面 JS 驱动逻辑（`test:mp`/`test-room-sync.js` 通过 reload require-cache 拿多个独立页面闭包模拟房主+好友）。`test-room-sync.js` 用内存版 cloud.database 模拟云端表，不依赖网络。不装微信开发者工具也能跑全部测试。

- 测试分两类：**行为级**（mock 运行时后真实调页面方法，断言 setData 落值）与**静态守卫**（读源码字符串正则，断言「某字段/方法/节点存在」或「不再出现某种写法」）。改 UI 但难在测试里复现的场景用静态守卫兜底——例如 `.chat-badge`/`recordsError` 这类 WXML/WXSS 节点靠正则守卫。
- `test-miniprogram-logic.js` 顶部 mock 的 `wx` 对象是全局共享的，多个 `pageCtx.onLoad()` 复用同一份；若新增 wx API 调用，需在 mock wx 里补桩，否则 `test:cloud` 的「源码 wx.* 调用 vs 隐私声明」清单会对不上。当前声明的 wx.* 调用见 `test-cloud-integration.js` 输出（含 `stopPullDownRefresh` 等）。
- 测 setData 次数可用「包装 setData 计数器」模式（见 `test-miniprogram-logic.js` 中 `_lastPlayFp`/`_lastRemoteFp`/`_lastRenderFp` 三个验证块：`pageCtx.setData = (d) => { count++; return realSetData(d); }`，用 try/finally 还原）。

### 视觉回归（scripts/visual/，详见该目录 README）

行为级与静态守卫都**证明不了「画面看起来是对的」**——历史上座位遮挡、河牌被裁、8 位桌模板缺项，全是靠人工算坐标才发现，而算坐标只能证明「数学上不重叠」，算错了还会得出相反结论（review 中真实发生过三次）。视觉回归补这一环：

- **链路**：真实页面 JS（mock wx/Page + 假时钟）→ 真实 data 快照 → 挑真实 `table.wxml` 渲染器 + `table.wxss` 单位换算 → Chrome headless 截图 → 与基线逐像素比对。**不另写演示页面**（`index.html` 是自绘样式，没有 `--uh`/`.felt`，测不到真实画面）。
- **两个决定成败的坑**：① 页面用 `seed: 'mp-' + Date.now()` 做牌种，假时钟必须给**固定 epoch** 而非真实时间，否则每次跑出的牌不同、基线永远不稳（踩过：18 张图 14 张每次都不一样）；② 座位数要同时传 `max` 与 `bots`，只传 `bots` 会被截到默认 6 座、所有桌型渲染成同一张图（踩过，靠比对文件 hash 才发现）。
- **判定口径**：像素差 > 24 才算变；变化像素 > 0.5% **且最大连通块 > 0.15%** 才判失败——抗锯齿是零散细线，真实布局问题一定成片，这样既不误报也不漏报（实测注入 x=10 交叠 bug：8 位桌 3 张全部命中，其余 15 张零误报）。
- **进 npm test 的只有 `visual/selftest.js`**（29 项，纯 JS 不依赖浏览器，守渲染器语义 / 场景数据随参数变化 / 渲染确定性 / 单位换算）。截图与比对脚本依赖本机 Chrome 与基线图，`npm run visual` 单独跑。

## 文档

- `README.md`：合规一号风险（版号/ICP/行动建议限制）、服务端权威架构蓝图（WebSocket + 事件溯源 + MySQL/Redis）、上线检查清单。
- `docs/review-2026-10-15.md`：全项目评审报告 + 修复记录（残余 CRITICAL/HIGH 均已修复，含每项修复的设计取舍；后续工作先查这里避免重蹈覆辙）。
- `docs/服务端化蓝图.md`：房卡货币化前必须实施的服务端改造清单。

## 约定与注意事项

- 注释、文档、commit message 用中文；文件头注释解释「为什么这么设计」是本仓库的强约定，修改前先读目标文件头部注释（内含不可破坏的格式约定和踩坑记录）。
- `scripts/check-wxml.js` 的规则来自历史事故：标签闭合平衡、wx:for 内别名插值（文本**与属性**位置都查）必须声明 `wx:for-item`；预处理剥离注释；VOID_TAGS 覆盖官方 WXML void 元素集；完整标签栈做词法作用域（内层可见外层别名）。
- 牌桌动画只用 `transform`/`opacity` + CSS keyframes，不动 `top/left/width`（重排红线，目标 60fps）；包体积红线 2MB。
- 打包/上传排除清单唯一来源是 `scripts/pack-rules.js`（pack.js / upload.js / project.config.json 三处共用）——改清单只改它，`npm test` 里的 `scripts/check-pack-rules.js` 会拦住 project.config.json 漂移和 `miniprogram_npm` 被误排除（历史事故：排除 = 体验版白屏）。
- 位运算必须加括号（`&` 优先级高于 `===` 曾导致顺子判定全错）；任何决策输出过引擎 `act()` 前必须夹取到合法区间。
- `project.private.config.json`、`private.*.key`、`miniprogram/.wbapp_*.privacy.json` 等本地/密钥文件不进版本库（已在 .gitignore）。
- 「行动建议」类功能（`advise(game, seat, { practiceMode: true })`）仅在练习模式/AI 对战启用（引擎层默认返回 null，`renderAdvice` 再加 `mode !== 'ai'` 门槛），好友房与匹配对战必须关闭（合规硬约束）。
- 战绩/签到客户端层已收口（乐观锁 + 置标记先行），但 total_hands 仍客户端自报、签到日期仍客户端时钟——完整服务端化（rpc 事务 + 发放流水表 + 收表权限 + 服务端时钟）已写成 `docs/服务端化蓝图.md`，接支付前照单实施。
- 同步链路禁止裸 `.catch(() => {})` 静默吞错（`test-miniprogram-logic.js` 的 `SILENT_OK_COUNT` 守卫拦截）：上行失败要么 `syncFailToast` 提示用户，要么 `console.error` 记录。离房清理（closeRoom/roomSync.leave）原为静默吞，已全部改 `console.error`。当前 `SILENT_OK_COUNT = EMOTE_OK_COUNT = 3`：氛围功能（emote）的 3 处静默 catch 为命名常量豁免（带注释说明为何安全），其余场景守卫仍全量拦截。
- 改动 `table.js` 的同步链路（`pollOnce`/`bootstrapSync`/`writePlayState`/`enterRemote`）时注意：`pollOnce` 有 `_polling` 重入守卫（防 1.5s 轮询与上次 await 重叠），`bootstrapSync` catch 先 `stopSync()` 再降级（防定时器泄漏）。新增轮询/定时器要配对清理。
