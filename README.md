# 博弈论小程序 · 工程方案与合规说明

> 本文档配合 `core/poker-core.js`（已验证的纯逻辑引擎）与 `index.html`（可玩原型）使用。
> **请先读第 0 章**——它决定这个项目能不能做，比技术选型重要得多。

---

## 0. 先说结论：合规是这个项目的一号风险

原始需求里已经提示了这一点，我把它明确为**开发的前置条件**，而不是收尾工作。

> ⚠️ **关于命名**：产品名为「博弈论」，但底层玩法是 Texas Hold'em。
> 本文档中出现的「德州扑克」均指**游戏品类与玩法本身**，用于合规判定与规则描述，
> **不可一并替换为产品名**——审核看的是实际玩法，不是名字。

### 0.1 三条硬约束

| 事项 | 现状 | 影响 |
|---|---|---|
| **游戏版号** | 德州扑克属于「棋牌类游戏」，需版号方能以游戏形态上架 | 无版号 → 无法独立上架 |
| **ICP 备案 + 微信认证** | 300 元/年，备案周期通常 1~3 周 | 阻塞提审 |
| **合规报告周期更新** | 需按周期提交，逾期触发平台限制 | 长期义务，非一次性 |

### 0.2 无版号时的三条变通路径

| 路径 | 说明 | 风险评估 |
|---|---|---|
| **A. 接入已有版号平台 SDK** | 与持牌方合作做联运，共享其版号与主体资质 | 中。需谈判分成，周期不可控 |
| **B. 走「社交娱乐」类目** | 弱化竞技，定性为虚拟牌局娱乐 + 房卡消耗 | **高**。审核尺度持续收紧，德州扑克极易被认定规避 |
| **C. 不在小程序内做真钱/房卡变现** | 纯免费练习，无充值无房卡 | 中。留存差，但合规压力小 |

**我的建议**：如果团队尚无版号，走 **A 或 C**，并**立即**同步启动资质办理与法律咨询。
不要先投入 3 个月开发，最后卡在提审。

### 0.3 关于「行动建议」功能的高风险提示

需求中的「行动建议」在真实竞技对局中向玩家实时输出行动指令，存在被判定为
**外挂辅助 / 引导性玩法诱导**的实质风险。工程上的处理方式：

```js
// core/poker-core.js 中的 advise() 已实现，但必须在服务端加开关
advise(game, seat) {
  // ⚠️ 仅在 practiceMode=true 时返回，否则返回 null
  if (!ctx.config.practiceMode) return null;
  ...
}
```

界面上必须显著标注「练习模式」，且**仅在 AI 对战 / 教学关卡中启用**，
好友房与匹配对战必须关闭。我在原型界面已加了免责声明，但这是产品决策，需与合规团队书面确认。

---

## 1. 目录结构

```
poker/
├── core/
│   └── poker-core.js          # 纯逻辑引擎（已通过 128 项自测）
├── test-core.js               # 测试套件
├── index.html                 # 可玩原型（浏览器）
├── server/                    # 服务端（Node.js + TypeScript）
│   ├── src/
│   │   ├── engine/
│   │   │   ├── table.ts        # 牌桌状态机（包装 poker-core）
│   │   │   ├── event-store.ts  # 事件溯源存储
│   │   │   └── seed.ts         # 服务端种子管理
│   │   ├── gateway/
│   │   │   ├── ws-server.ts    # WebSocket 网关
│   │   │   └── protocol.ts     # 消息协议（TS 类型定义）
│   │   ├── services/
│   │   │   ├── room.service.ts     # 房间 / 邀请码
│   │   │   ├── wallet.service.ts   # 房卡与道具
│   │   │   ├── auth.service.ts     # 微信登录 + openid
│   │   │   └── stats.service.ts    # 战绩统计
│   │   └── store/
│   │       ├── mysql.ts        # 持久化
│   │       └── redis.ts        # 牌局热状态缓存
│   └── package.json
└── miniprogram/                # 微信小程序
    ├── app.js / app.json / app.wxss
    ├── core/
    │   └── poker-core.js       # ★ 直接复用，无需转译
    ├── pages/
    │   ├── index/              # 首页：好友房 / AI 对战 / 战绩
    │   ├── lobby/              # 房间列表与创建
    │   ├── table/              # 牌桌（核心页面）
    │   │   ├── index.wxml
    │   │   ├── index.wxss      # 横屏适配
    │   │   └── index.js
    │   ├── analysis/           # 牌力分析 / 复盘
    │   └── profile/            # 个人数据与统计
    └── utils/
        ├── ws.js               # WebSocket 封装（自动重连）
        └── auth.js
```

**关键点**：`core/poker-core.js` 采用 UMD 包装（`module.exports` + 全局挂载），
小程序侧 `require('../../core/poker-core.js')` 可直接使用，**零转译成本**。

---

## 2. 服务端权威架构

### 2.1 为什么必须服务端权威

客户端可被任意篡改（改牌、改筹码、改他人下注）。因此：

- 洗牌在**服务端**完成，客户端永远拿不到未发的牌
- 所有动作合法性在**服务端**校验，客户端的 `legalActions` 仅用于 UI 提示
- 边池分配、输赢结算全在服务端完成

### 2.2 事件溯源

```typescript
// 每个动作是一条不可变事件，便于回放与审计
interface GameEvent {
  seq: number;          // 牌局内单调递增
  handNo: number;       // 第几手牌
  type: 'hand_start' | 'deal' | 'action' | 'street' | 'turn' | 'hand_end';
  seat: number;         // 行动者
  action?: 'fold' | 'check' | 'call' | 'raise' | 'allin';
  amount?: number;      // 本次投入
  to?: number;          // 加注后的目标水位
  pot?: number;
  cards?: number[];     // 仅记录「发了哪张牌到公共区」
  ts: number;
}
```

牌局的完整状态可由 `seed + events[]` **完全重放**。这带来三个好处：

1. **争议可复盘**——用户投诉某局异常时，用 seed + events 重放即可验证
2. **审计合规**——满足游戏行业的日志留存要求
3. **AI 复盘**——基于事件流分析决策失误

> 引擎已内置这个能力：`createGame({ seed })` + `game.events`，
> 同 seed 同动作序列必然产生同一结果（测试【8】【9】已验证）。

### 2.3 洗牌随机性

```typescript
// 服务端持有 seed，绝不下发客户端
import { createRng } from './poker-core';

const seed = crypto.randomUUID();     // 密码学安全
const rng = createRng(seed);          // xorshift128+
```

引擎内部用 `crypto.getRandomValues` 做初始种子（`cryptoRandomBytes`），
退化路径仅在无 crypto 环境启用。**生产环境必须校验 `crypto` 存在**。

---

## 3. 实时通信

### 3.1 方案选型

| 方案 | 适用 | 建议 |
|---|---|---|
| **原生 WebSocket** | 牌局实时对战 | ✅ **推荐**。延迟低（<100ms），双向可控 |
| 微信云开发实时数据库 | 轻量、免运维 | ⚠️ 适合原型，不适合高频牌局（写放大严重） |
| 长轮询 | — | ❌ 完全不适用 |

### 3.2 消息协议

```typescript
// ── 客户端 → 服务端 ──
interface ClientMsg {
  type: 'join_table' | 'act' | 'chat' | 'emote' | 'leave_table' | 'ready';
  tableId?: string;
  act?: { action: 'fold'|'check'|'call'|'raise'|'allin'; amount?: number };
  text?: string;
  ts: number;
}

// ── 服务端 → 客户端 ──
interface ServerMsg {
  type: 'table_snapshot' | 'action_applied' | 'chat' | 'emote'
      | 'hand_result' | 'error' | 'player_joined' | 'player_left';
  data?: any;
  seq?: number;        // 用于客户端检测丢包与乱序
  ts: number;
}
```

`table_snapshot` 的内容直接由 `game.snapshot()` 提供，**注意它已做底牌脱敏**：
他人手牌在摊牌前为 `null`，仅本人可见。

### 3.3 断线重连

牌局状态在服务端，客户端重连后重新 `join_table` 拉取全量快照即可，
**无需增量补偿**。建议重连策略：指数退避（1s/2s/4s/8s，上限 15s），最多 5 次。

---

## 4. 数据存储

### 4.1 选型建议

| 数据 | 存储 | 说明 |
|---|---|---|
| 用户信息、战绩、房卡余额 | **MySQL** | 强一致，账务类不可丢 |
| 房间列表、邀请码 | **Redis** | 有 TTL，过期自动清理 |
| 进行中的牌局状态 | **Redis**（可选） | 内存态，服务重启后从事件流重建 |
| 对局事件归档 | **MySQL 分表** 或对象存储 | 按月分区，冷数据下沉 |

> 房卡属**虚拟资产**，账务必须走事务 + 幂等设计。建议引入流水表
> `wallet_transaction(user_id, delta, type, order_id)`，`order_id` 唯一索引防重复扣减。

### 4.2 表结构要点

```sql
-- 用户
CREATE TABLE `user` (
  `openid`     VARCHAR(64)  NOT NULL PRIMARY KEY,
  `unionid`    VARCHAR(64)           DEFAULT NULL,
  `nickname`   VARCHAR(64)           DEFAULT NULL,
  `avatar`     VARCHAR(255)          DEFAULT NULL,
  `room_cards` INT          NOT NULL DEFAULT 0,   -- 房卡余额
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 战绩（按用户 + 时间倒序查询）
CREATE TABLE `record` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`    VARCHAR(64)  NOT NULL,
  `table_id`   VARCHAR(64)  NOT NULL,
  `hand_no`    INT          NOT NULL,
  `seat`       TINYINT      NOT NULL,
  `hole_cards` VARCHAR(16)  NOT NULL,             -- 摊牌后公开，非摊牌存 'xx'
  `board`      VARCHAR(16)  NOT NULL,
  `hand_type`  VARCHAR(16)  NOT NULL,             -- 牌型中文名
  `net`        INT          NOT NULL,             -- 本手盈亏
  `created_at` DATETIME     NOT NULL,
  KEY `idx_user_time` (`user_id`, `created_at` DESC)
) ENGINE=InnoDB;
```

---

## 5. 小程序端实现要点

### 5.1 牌桌渲染（横屏）

```json
// pages/table/index.json
{
  "pageOrientation": "landscape",
  "navigationStyle": "custom",
  "disableScroll": true
}
```

**性能红线**：牌桌动画必须跑在 60fps。扑克牌的位移动画建议：

- 用 `transform` / `opacity`，**不要动 `top/left/width`**（会触发重排）
- 发牌动画统一用 CSS keyframes，避免 JS 逐帧计算
- 牌面元素数量可控（≤ 30 个），不需要 canvas 渲染

> 原型里我用的就是 `transform + keyframes`，
> 见 `index.html` 的 `.card.deal` 与 `dealIn` 动画。

### 5.2 复用引擎

```javascript
// pages/table/index.js
const P = require('../../core/poker-core.js');   // 零转译

// ⚠️ 关键原则：客户端引擎仅用于「预渲染」与「合法性预校验」，
// 绝不用它的状态做最终判定——那必须以服务端返回为准。
function legalPreview(seat) {
  return localGame.legalActions(seat);
}
```

### 5.3 登录与房卡

```javascript
// 静默授权获取 openid
wx.login({
  success: res => {
    wx.request({
      url: `${API_BASE}/auth/login`,
      method: 'POST',
      data: { code: res.code },     // 交给服务端换 openid，客户端不接触
      success: r => { /* r.data.token */ }
    });
  }
});
```

房卡扣减**必须服务端完成**。客户端只发「开房请求」，
服务端校验余额 → 事务扣减 → 创建房间。客户端禁止自行判断余额。

---

## 6. 引擎已验证的能力

`test-core.js` 共 **128 项断言全部通过**，覆盖：

| 能力 | 测试点 | 关键回归 |
|---|---|---|
| 7 张牌评估 | 9 种牌型 + 大小比较 | 位运算优先级陷阱、轮子顺、同花内缺张 |
| 边池分层 | 2/3/4 路全下、弃牌者剔除 | 总额守恒、资格人数递减 |
| 下注状态机 | 最小加注额、不足额全下 | `currentBet` 不被短全下拉低 |
| AI 决策 | 2000 手全自动对局 | **零死锁、零非法动作、筹码全程守恒** |
| 蒙特卡洛胜率 | 单调性 + 稳定性 | 对手越多胜率越低；坚果面时正确计入平局分池 |
| 事件溯源 | 不可变性、序号连续 | 同 seed 同动作 → 同结果 |

### 开发过程中真实修复的三个 Bug（供后续参考）

1. **`&` 优先级高于 `===`**
   `mask >> (hi-4) & 0x1f === 0x1f` 实际被解析为 `(mask >> (hi-4)) & (0x1f === 0x1f)`，
   导致顺子检测几乎永远为真。**位运算必须加括号**。

2. **`pickKicker()` 返回牌 ID，评估器当 rank 用**
   踢脚牌比较全错（返回 44 而不是 11）。类型混用是 7 张牌评估最容易踩的坑。

3. **AI 加注额未夹取到合法区间**
   引擎 `act()` 严格拒绝非法加注，AI 给出越界值会直接卡死牌局。
   **任何决策输出都必须过一遍合法性夹取**。

> 这三个 bug 的共性：**都在自测中被抓到了**。
> 建议服务端接入引擎时，第一件事就是把 `test-core.js` 纳入 CI。

---

## 7. 上线前检查清单

### 技术侧

- [ ] 牌局逻辑全部迁至服务端，客户端无判定权
- [ ] 洗牌种子仅存在于服务端，且用密码学安全随机生成
- [ ] 事件溯源落地，`seed + events` 可完整重放
- [ ] 房卡扣减走事务 + 幂等（`order_id` 唯一索引）
- [ ] WebSocket 断线重连 + 状态全量重拉
- [ ] 引擎单测纳入 CI
- [ ] 小程序包体积 ≤ 主包 2MB / 总包 20MB
- [ ] 牌桌动画在低端机实测 ≥ 50fps

### 合规侧（**请与专业法律团队确认**）

- [ ] 版号或联运资质已落实
- [ ] ICP 备案完成
- [ ] 微信认证完成
- [ ] 类目选择与实际功能一致（不虚标）
- [ ] 用户协议 + 隐私政策已公示
- [ ] 实名认证接入（合规硬性要求）
- [ ] 「行动建议」在竞技房已关闭
- [ ] 房卡消耗说明清晰，**无货币化表述**
- [ ] 未成年人保护与防沉迷措施
- [ ] 合规报告周期更新机制已建立

---

## 8. 建议的开发排期

> 假设：后端 2 人、小程序 2 人、合规对接 1 人（兼职）。

| 阶段 | 内容 | 周期 | 阻塞项 |
|---|---|---|---|
| **P0 合规先行** | 资质确认、法律咨询、版号/联运谈判 | **2~8 周** | ⚠️ 阻塞后续一切 |
| P1 引擎服务端化 | 包装引擎 + 事件溯源 + 单测接入 CI | 2 周 | P0 |
| P2 实时对战 | WebSocket 网关 + 牌桌小程序页 | 3 周 | P1 |
| P3 好友房 | 房间系统 + 邀请码 + 房卡扣减 | 2 周 | P2 |
| P4 社交与数据 | 聊天、表情、战绩统计、复盘 | 2 周 | P2 |
| P5 商城与运营 | 道具商城、风控、埋点 | 2 周 | P3 |
| P6 联调提审 | 体验版内测 → 提审 | 2~4 周 | P0 |

**关键建议**：P0 合规与 P1~P5 开发**并行**。
若 P0 结论是「拿不到版号」，团队还能及时转向 C 方案（免费练习），
而不是在提审前一天才发现。

---

## 9. 本地试玩

```bash
cd poker
python -m http.server 8899        # 或任意静态服务器
# 浏览器打开 http://127.0.0.1:8899/index.html

# 跑引擎自测
node test-core.js                 # 预期输出「全部通过：128 项断言 ✓」
```

原型已实现：完整牌局规则、边池、5 个 AI 对手、发牌/下注动画、
实时牌力分析（蒙特卡洛）、聊天与表情、战绩统计、结算复盘。
