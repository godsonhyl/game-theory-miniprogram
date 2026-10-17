# 开发者工具 + touristappid 体验版部署清单

> 生成时间：2026-10-16（第 14 轮更新）　代码版本：`af7b917`
> ⚠️ **touristappid 试用通道 2026-10-27 到期，还剩 11 天。** 到期后体验版会失效。
> 📌 本地 `master` 领先 `origin/master` 1 个提交（`af7b917` 编码规范文档），网络恢复后先 `git push`。

## 一、准备（已完成，无需再做）

| 项 | 状态 |
|---|---|
| `project.config.json` | ✅ `appid: touristappid`、`miniprogramRoot: miniprogram/`、`libVersion: 3.5.5` |
| `packOptions.ignore` | ✅ 已排除测试文件 / package*.json / node_modules / dist |
| 云 SDK | ✅ 构建产物内联在 `miniprogram/utils/vendor/workbuddy-cloud-sdk.js`（2026-10-17 起，无需「构建 npm」/npm install） |
| 云环境配置 | ✅ `endpoint: mp-api.app.workbuddy.host`；应用 ID **不要在此写死**，以 `miniprogram/utils/cloud.js` 的 `publishableKey`（`wbpk_<appId>_…`）为准。2026-10-17 曾短暂切到另一个新建应用（未授权导致登录失败，已回退废弃），换应用后必须回到**新**应用上重跑一遍迁移与 rpc 核对，npm test 查不出来 |
| 页面声明 | ✅ 3 页，单主包无分包 |

## 一之二、换云端应用：必做的四件事 ⚠️

换 `cloud.js` 的 `publishableKey`（= 换应用）**不是改一行配置就完事**，它等于换一个空数据库 +
换一套平台授权。2026-10-17 真机踩过：改完 key 后所有登录报
**「登录未完成 / 小程序未授权给 WorkBuddy」**（服务端 `/v1/login-wechat` 返回，不是本地文案）。

| # | 必做 | 说明 |
|---|---|---|
| 1 | **在哪个设备建的应用，就在哪个设备授权** | 应用只注册在创建它的工作区。本机 `cloud_service inspect` 列出的是 `2qkKI2ZGSh13zUKRFfD8Cm` 与 `tW8FJoIcEfNHOzCRKUX7sV`，2026-10-17 那个新建应用**不在其中** → 本机 `activate/reuse` 直接 `reuse_not_found`，管不了它，授权只能回原设备做 |
| 2 | 重跑数据库迁移与 rpc 核对 | 新库是空的。`migrations/*.sql` 要重跑，再用 `scripts/check-cloud-migration.js --sql` 的 SQL 验一遍。npm test **查不出这个**（测试 mock 掉 cloud 层） |
| 3 | 等平台下发新应用的隐私清单 | `.wbapp_<appId>.privacy.json` 按应用下发且被 gitignore 排除，短期内缺失属正常，测试只告警不判失败 |
| 4 | 真机登录自测一次 | 数据库全绿 ≠ 能登录。授权缺失只在真机第一次登录时暴露 |

排查登录类报错时，先看 `miniprogram/utils/auth.js` 的日志：失败时会打出
`appid` + `code` + `message`，能直接看出是**哪个 appid 没被授权**。

## 二、上传前预检（已全部通过）

```
node scripts/check-pack-rules.js   →  全部通过：5 项断言 ✓
node scripts/check-wxml.js         →  WXML 静态检查全部通过：4 项断言 ✓（3 个文件）
npm test                           →  9 个套件全部通过（1126 项断言）
cmp core/poker-core.js miniprogram/core/poker-core.js   →  引擎双副本一致 ✓
```

> **上传失败过的两种根因，务必都记住：**
> 1. `table.wxml` 少一个 `</view>` → 标签嵌套不匹配 → 编译失败
> 2. `{{}}` 里**三元运算符中调用方法**（如 `.indexOf()`）→ `Bad attr 'class' with message: unexpected token ':'`
>
> 第 2 种最阴险：**开发者工具不报错、真机预览也正常，只有点「更新」上传才炸**。
> 已在 `check-wxml.js` 加了规则 3 自动拦截，每次上传前必跑上面第 2 项。
> 复杂逻辑一律搬到 JS 里预计算，WXML 只写 `{{item.cls}}` 这类取值。

## 三、操作步骤

1. 解压 `dist/game-theory-miniprogram-0.1.0.zip`
2. 微信开发者工具 → **导入项目** → 选解压后的目录
3. AppID 选 **「测试号」/ 不填（保持 touristappid）**
4. 后端服务保持「云开发」/ 不勾选（走 `utils/cloud.js` 的 SDK 直连）
5. 编译 → 确认无报错 → 右上角 **上传**
6. 版本号建议 `0.1.1`，备注：`就绪30s+限时挂起+结算三件套+房主身份回收+上传编译修复`

## 四、产物信息

- `dist/game-theory-miniprogram-0.1.0.zip`
- 25 文件 / 889,352 bytes 原始 / **210KB 压缩**
- 主包占用约 **0.85MB / 2MB**，余量充足

## 五、上传后必验（回归第 8～13 轮改动）

**优先级 P0 —— 不通过就不能算上传成功：**

| 验证项 | 期望 |
|---|---|
| **上传编译** | 点「更新」能成功。失败且报 `unexpected token ':'` → WXML 表达式问题，见第二节 |
| **房主身份** | 房主开房 → 退出 → 邀请好友 → 重入，**房主仍是自己**；反复重入**不出现两个自己** |
| **限时挂起** | 倒计时归零时若正在打牌，顶栏定格「本手后」（中性灰、不闪红），这手打完才弹结算，**不能中途 game over** |

**优先级 P1：**

| 验证项 | 期望 |
|---|---|
| 加注档位 | 7 个档位按钮（最小/33%/50%/67%/100%/全下/自定义）**横屏一行不折行**；自定义值失焦后吸附到小盲注整数倍且不越上限 |
| 结算三件套 | 结算单显示**带入 / 剩余 / 盈亏**三项，盈亏正负色正确（涨红跌绿） |
| 实时盈亏面板 | 菜单 →「我的筹码 · 盈亏」可随时查看，数字与结算单**口径一致** |
| 准备就绪 | 点完按钮**原位变灰禁用**（不消失、不跳版），倒计时 **30s** |
| 牌桌布局 | 对手手牌**不遮挡**底池注码与公共牌；中央盘面压住牌背 |
| 开始按钮 | 等待室「开始游戏」**不折行**，主标题+副提示两行（不足 2 人时显示「至少 2 人」） |

> 音效验证要点（历史遗留）：**必须先点一下屏幕**。WebAudio 上下文需用户手势 `resume()`
> 才进入 running，否则静默无声且不报错。

## 六、长期建议

`touristappid` 是 14 天试用通道，10/27 失效。要长期使用需：
1. 微信公众平台注册小程序，拿到**正式 AppID**
2. 「开发管理 → 开发设置 → 生成并下载代码上传密钥」→ 存为 `private.<AppID>.key`（等同密码，勿提交）
3. 把 AppID 填入 `upload.js` 的 `CONFIG.appId`

之后即可 `npm run upload` 一键上传，不必每次手动操作。
