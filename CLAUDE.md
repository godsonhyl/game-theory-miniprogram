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
```

测试全部是自研断言脚本（无 jest/mocha），直接 `node xxx.js` 运行，失败项会打印 label。跑单个测试：`node miniprogram/test-room-sync.js` 或对应 npm script。`npm test` = 9 套件全跑（引擎 test-core / 牌桌页 test-miniprogram-logic / 牌面 test-cards / 云规范 test-cloud-integration / 首页 test-index-logic / 跨设备同步 test-room-sync / SDK test-sdk-load / WXML check-wxml / 打包规则 check-pack-rules），改动后必须过。断言数是硬口径——改动后新增/删除断言要在 commit message 里说明。

## 双树结构（易踩坑）

仓库根 = `project.config.json` 所在工程目录，小程序源码在 `miniprogram/` 子目录（`miniprogramRoot: "miniprogram/"`）。发布指引等文档里的「poker 目录」即指本仓库根目录。

- 根目录：`core/poker-core.js`（引擎源）、`index.html`（浏览器原型，对照参考）、`test-core.js`、`pack.js`/`upload.js`、根 `package.json`（npm scripts）。
- `miniprogram/`：真正的上传源。**它有自己独立的 `package.json` + `node_modules`**，用于微信开发者工具的「构建 npm」（编译出 `miniprogram_npm/`）。首次使用或改依赖后必须在开发者工具里构建 npm，否则上传报模块找不到。
- **引擎有两份 identical 拷贝**：`core/poker-core.js` 与 `miniprogram/core/poker-core.js`。改动任何一份必须同步复制到另一份（`cmp` 确认一致），已落库数据依赖其编码格式稳定。

## 架构

### 引擎（core/poker-core.js）

纯逻辑德州扑克引擎（UMD 包装，CommonJS + 全局双导出），零 DOM/网络依赖，~1300 行。要点：

- 牌编码 `0..51`：`rank = id >> 2, suit = id & 3`；金额一律整数筹码。
- 随机源可注入 seed（xorshift128+），同 seed 同动作序列 → 同结果（事件溯源回放的基础，`game.events` 记录全量）。
- 边池按承诺额分层合并，支持任意多路全下。
- `RANK_NAMES`（机读码，定长单字符）与 `RANK_DISPLAY`（UI 显示，T→10）职责严格分离，不可合并——`codeToCard` 等编解码依赖定长。
- 客户端定位：引擎仅做预渲染与 UI 反馈；现有实现为演示态，权威逻辑跑在「房主端」，上线底线是迁服务端。

### 牌桌页权威/镜像模型（pages/table/table.js，~2900 行，核心页面）

- **AI 对战 / 好友房房主端**：引擎跑在本机（权威端）。
- **好友房好友端（remoteMode）**：不跑引擎，把房主广播的快照镜像成本地 game 对象，按「我 = 本地 0 号位」重映射座位，复用同一套渲染与操作逻辑；动作经 room-sync 上行，房主消化后随下一帧广播。
- 座位环用统一的 `ringPositions()`（我固定底部中央，其余铺上方半圆），等待室与游戏中共用坐标（开局无跳变）。
- 音效走 `utils/sfx.js` 的 WebAudio 实时合成（14 个 PRESETS 音色，零资源文件），`drainSfx()` 300ms 事件泵轮询 `game.events`（`sfxSeq` 游标）；提示音（倒计时警告/限时局/被动代弃/收到消息）挂在 startTimer/startClock/autoStandUnready/pushChat，全部 `soundOn` 门控，`unlock()` 必须在用户手势栈内（`onFirstTouch`）调用一次。

### 跨设备同步（utils/room-sync.js）

基于云端表的轮询模型：每个真人一行（RLS 只许改自己），房主行存房间公开状态（waiting/playing + snapshot + appliedSeqBySeat），好友动作写自己行动作字段上行，房主 1.5s 轮询按序号消化，心跳 5s / 15s 判离线，30s 行动超时代弃牌。云端不可用时静默降级为本地模拟。

- **seq 按座位分道**（不是房主单一全局水位）：`pendingActions(rows, appliedSeqBySeat)` 用「行座位 → 已应用 seq」的映射，seq 只区分同一行内动作的新旧，慢钟设备好友的动作不会被别家高 seq 永久跳过。
- **座位伪冒断言**：`applyFriendAction` 一律以行内 `rowSeat` 为准，payload `seat` 与行座位不符即整条丢弃——好友不能替他人行动。
- **房主心跳僵死检测**：房主行存在但心跳超 `OFFLINE_MS` 起计，超 `HOST_STALE_EXIT_MS`（30s 宽限）仍未恢复 → 好友端判房间僵死自动退出。
- 已知边界：快照含真人底牌，防作弊需服务端引擎（已议定封存，见 room-sync.js 头注释与 `docs/服务端化蓝图.md`）；room-sync 无 chat 字段，镜像端收不到好友间聊天。

### 云服务（utils/cloud.js + WorkBuddy SDK）

- 表：`poker_profiles` / `poker_records`（RLS 按用户隔离）、`poker_rooms`（按房号公开读）、`poker_room_seats`（同步座位）。
- 登录链路：`wx.login` → `signInWithWechat(code, appid)`，客户端不接触 AppSecret。
- 安全红线：endpoint/publishableKey 是仅有的可放前端的配置；**禁止手写 `wx.request` 访问 `/.cloud/**`**（绕过凭证注入）；insert 不得携带 `owner_id`（服务端 `auth.uid()` 决定）。`test:cloud` 会校验这些规范及隐私声明与实际调用精确一致。
- 房卡扣减走乐观锁；上线需换服务端事务 + 幂等。

### 其余 utils

`room-snapshot.js`（退出续局，本地缓存，纯体验优化）、`sfx.js`（WebAudio 实时合成音效，零资源文件，异常全部静默）、`settings.js`（本地存储，不进云）、`auth.js`（登录 + 房卡扣减乐观锁 + 签到/对局奖励/战绩统计并发防护）、`workbuddy-cloud-diagnostics.js`。

## 测试方法

自研轻量框架：脚本内 mock `wx`/`Page`/`getApp` 后真实加载页面 JS 驱动逻辑（`test:mp`/`test-room-sync.js` 通过 reload require-cache 拿多个独立页面闭包模拟房主+好友）。`test-room-sync.js` 用内存版 cloud.database 模拟云端表，不依赖网络。不装微信开发者工具也能跑全部测试。

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
