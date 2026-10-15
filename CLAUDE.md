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
npm run test:wxml               # WXML 静态检查（标签闭合 + wx:for-item 声明）
npm run pack                    # 打包 dist/*.zip（三层校验：引擎存在/体积<2MB/页面四件套齐全）
npm run upload                  # miniprogram-ci 命令行上传体验版（需 private.<AppID>.key）
npm run preview                 # 仅生成预览包，不上传
```

测试全部是自研断言脚本（无 jest/mocha），直接 `node xxx.js` 运行，失败项会打印 label。跑单个测试：`node miniprogram/test-room-sync.js`。

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

### 牌桌页权威/镜像模型（pages/table/table.js，~2500 行，核心页面）

- **AI 对战 / 好友房房主端**：引擎跑在本机（权威端）。
- **好友房好友端（remoteMode）**：不跑引擎，把房主广播的快照镜像成本地 game 对象，按「我 = 本地 0 号位」重映射座位，复用同一套渲染与操作逻辑；动作经 room-sync 上行，房主消化后随下一帧广播。
- 座位环用统一的 `ringPositions()`（我固定底部中央，其余铺上方半圆），等待室与游戏中共用坐标（开局无跳变）。

### 跨设备同步（utils/room-sync.js）

基于云端表的轮询模型：每个真人一行（RLS 只许改自己），房主行存房间公开状态（waiting/playing + snapshot + appliedSeq），好友动作写自己行动作字段上行，房主 1.5s 轮询按序号消化，心跳 5s / 15s 判离线，30s 行动超时代弃牌。云端不可用时静默降级为本地模拟。已知边界：快照含真人底牌，防作弊需服务端引擎。

### 云服务（utils/cloud.js + WorkBuddy SDK）

- 表：`poker_profiles` / `poker_records`（RLS 按用户隔离）、`poker_rooms`（按房号公开读）、`poker_room_seats`（同步座位）。
- 登录链路：`wx.login` → `signInWithWechat(code, appid)`，客户端不接触 AppSecret。
- 安全红线：endpoint/publishableKey 是仅有的可放前端的配置；**禁止手写 `wx.request` 访问 `/.cloud/**`**（绕过凭证注入）；insert 不得携带 `owner_id`（服务端 `auth.uid()` 决定）。`test:cloud` 会校验这些规范及隐私声明与实际调用精确一致。
- 房卡扣减走乐观锁；上线需换服务端事务 + 幂等。

### 其余 utils

`room-snapshot.js`（退出续局，本地缓存，纯体验优化）、`sfx.js`（WebAudio 实时合成音效，零资源文件，异常全部静默）、`settings.js`（本地存储，不进云）、`auth.js`、`workbuddy-cloud-diagnostics.js`。

## 测试方法

自研轻量框架：脚本内 mock `wx`/`Page`/`getApp` 后真实加载页面 JS 驱动逻辑（`test:mp`/`test-room-sync.js` 通过 reload require-cache 拿多个独立页面闭包模拟房主+好友）。`test-room-sync.js` 用内存版 cloud.database 模拟云端表，不依赖网络。不装微信开发者工具也能跑全部测试。

## 约定与注意事项

- 注释、文档、commit message 用中文；文件头注释解释「为什么这么设计」是本仓库的强约定，修改前先读目标文件头部注释（内含不可破坏的格式约定和踩坑记录）。
- `scripts/check-wxml.js` 的两条规则来自历史事故：wx:for 内用别名插值必须声明 `wx:for-item`；标签必须闭合平衡。
- 牌桌动画只用 `transform`/`opacity` + CSS keyframes，不动 `top/left/width`（重排红线，目标 60fps）；包体积红线 2MB。
- 打包/上传排除清单唯一来源是 `scripts/pack-rules.js`（pack.js / upload.js / project.config.json 三处共用）——改清单只改它，`npm test` 里的 `scripts/check-pack-rules.js` 会拦住 project.config.json 漂移和 `miniprogram_npm` 被误排除（历史事故：排除 = 体验版白屏）。
- 位运算必须加括号（`&` 优先级高于 `===` 曾导致顺子判定全错）；任何决策输出过引擎 `act()` 前必须夹取到合法区间。
- `project.private.config.json`、`private.*.key`、`miniprogram/.wbapp_*.privacy.json` 等本地/密钥文件不进版本库（已在 .gitignore）。
- 「行动建议」类功能（`advise()`）仅在练习模式/AI 对战启用，好友房与匹配对战必须关闭（合规硬约束）。
