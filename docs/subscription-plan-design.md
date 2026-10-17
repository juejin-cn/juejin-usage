# 订阅计划数据获取与接口协议

本文沉淀 Desktop 与 CLI 订阅计划数据的获取方式、IPC/HTTP 响应结构和展示策略。读取器与 mapper 位于 `packages/core/src/subscription`，两端使用同一实现；内容以当前实现为基线，未落地的规则明确标记为“建议”。

本文采用供应商无关的描述。不同适配器可以选择不同的数据源和响应形态，但不得把访问令牌、Cookie、认证文件内容或上游原始响应暴露给渲染进程。

## 1. 架构与数据流

订阅数据遵循以下单向链路：

```text
本地安装与登录状态
        │
        ├─ 本地 CLI / RPC / 本地服务
        ├─ 本地凭据 + 官方只读接口
        └─ 本地缓存或日志中的只读快照
        │
        ▼
core 共享读取器（CLI Node / Electron 主进程）：读取、校验、归一化、缓存、降级
        │
        ▼
Desktop Preload IPC / CLI 本地 HTTP：仅传递脱敏快照
        │
        ▼
Renderer：计算剩余比例、刷新时间并展示卡片
```

职责边界：

- core 读取器在 Node/Electron 后台发现安装位置、读取本地登录状态、访问上游接口、执行超时控制和错误归类。
- shared mapper 负责将上游字段归一化为稳定的百分比、时间戳、套餐名称和额度窗口。
- preload 只暴露订阅读取方法，不暴露文件系统、令牌或任意网络访问能力。
- renderer 只消费脱敏快照，不直接读取认证文件，也不持有上游凭据。

## 2. 数据获取与对接方式

### 2.1 获取方式

当前适配器使用以下一种或多种方式。它们是能力分类，不代表所有适配器都按固定顺序尝试。

| 方式 | 适用条件 | 当前处理方式 | 主要限制 |
| --- | --- | --- | --- |
| CLI / stdio RPC | 本机工具提供账户与额度 RPC | 启动本地进程，通过 JSON-RPC 或私有 RPC 读取账户及限额；完成后关闭子进程 | 依赖本地版本兼容性，需要进程超时与异常退出处理 |
| 本地服务 | 已运行的桌面工具暴露回环地址服务 | 从本机进程信息中发现端口及校验信息，只访问 `127.0.0.1` | 服务可能未启动，协议可能随版本变化 |
| 本地凭据 + 官方接口 | 本地认证状态包含可复用令牌 | 主进程只读认证文件或数据库，再调用对应的只读账户/额度接口 | 令牌可能过期，区域和自定义端点需要单独判断 |
| 本地数据库 | 登录状态保存在本地数据库 | 只查询必要字段，构造官方接口所需的会话信息 | 数据库结构可能变化或被占用 |
| 本地缓存或日志 | 正式认证文件缺少接口所需的短期信息 | 从有限大小、有限范围的本地文件中提取最近一次有效信息 | 只能作为降级来源，不能视为实时数据 |

### 2.2 对接流程

每个适配器应按当前实现完成以下步骤：

1. 检查本地工具、配置目录或可执行文件是否存在。
2. 判断是否使用自定义服务地址；不支持自定义地址时返回 `custom-provider`，而不是把凭据发送到非预期主机。
3. 读取登录状态，并将未登录、过期、账户类型不支持等情况映射为明确状态。
4. 调用本地 RPC 或官方只读接口，并设置有限超时。
5. 对响应进行结构检查，只保留套餐、额度、百分比、刷新时间等展示必需字段。
6. 生成脱敏快照，经 IPC 返回 renderer。
7. 请求失败时，如存在最后一次成功快照，则返回该快照并设置 `stale: true`；否则返回无数据的错误状态。

### 2.3 安全约束

- 凭据读取、令牌拼接和上游请求只允许发生在 CLI Node / Electron 主进程后台，不允许进入 renderer。
- 不得通过 IPC/HTTP 返回访问令牌、刷新令牌、Cookie、账户密码、认证文件路径或完整上游响应。
- 不得修改或刷新写回第三方认证文件；认证生命周期仍由原工具负责。
- 自定义服务地址必须显式识别。适配器不支持时停止请求，不得自动回退到默认主机并携带自定义凭据。
- 本地日志降级读取应限制候选目录、文件大小和解析范围。
- 用户可见错误只表达安装、登录、授权、兼容性、频率限制或网络状态，不展示原始响应体。

## 3. IPC 接口协议

Desktop 保留各适配器的 IPC channel 和 preload 方法；CLI 使用逐渠道 HTTP。core 的 `readSubscription(channel, options)` 根据固定渠道表调用读取器，Kimi 返回多个来源的快照数组，其他渠道返回单个快照。以下签名表达单快照读取器共同遵循的调用模型：

```ts
type SubscriptionReadOptions = {
  forceRefresh?: boolean;
};

type ReadSubscription = (
  options?: SubscriptionReadOptions,
) => Promise<SubscriptionSnapshot>;
```

- 部分读取方法支持 `forceRefresh`，用于绕过 60 秒成功缓存。
- 不支持该选项的方法按无参数调用；调用方不得假设所有适配器都能强制刷新。
- 并发刷新通常共享同一个 in-flight Promise，避免相同账户被重复请求。
- `forceRefresh` 只绕过成功缓存，不代表可以绕过正在进行的请求或上游限流。

### 3.1 响应结构分类

当前快照可以归纳为三类结构。对应的机器可读约束见 [`schemas/subscription-snapshot.schema.json`](./schemas/subscription-snapshot.schema.json)。

#### 命名窗口

适用于返回固定短周期和长周期窗口的本地 RPC：

```json
{
  "status": "ready",
  "planLabel": "Professional",
  "fiveHour": {
    "usedPercent": 36.5,
    "resetsAt": 1790000000
  },
  "weekly": {
    "usedPercent": 61,
    "resetsAt": 1790500000
  },
  "message": null
}
```

长周期字段当前可能为 `weekly` 或 `sevenDay`。部分旧快照没有 `fetchedAt` 和 `stale`。

#### 模型池窗口

适用于将自有模型、其他模型和旧版合并套餐分开返回的接口：

```json
{
  "status": "ready",
  "planLabel": "Team",
  "primaryModels": {
    "usedPercent": 20,
    "resetsAt": 1790500000
  },
  "otherModels": {
    "usedPercent": 45,
    "resetsAt": 1790500000
  },
  "plan": null,
  "fetchedAt": 1790000000,
  "stale": false,
  "message": null
}
```

`primaryModels` 表示工具自有或主要模型池，`plan` 是兼容旧响应的合并额度。新旧字段可以同时出现在类型中，展示层应优先使用更细分的模型池。这里使用供应商无关名称描述结构；具体适配器在 mapper 边界完成字段对应。

#### 额度列表

适用于额度数量、名称或周期由上游动态决定的接口：

```json
{
  "status": "ready",
  "planLabel": "Standard",
  "region": "global",
  "limits": [
    {
      "id": "short-window",
      "label": "5h",
      "usedPercent": 28,
      "resetsAt": 1790000000
    },
    {
      "id": "long-window",
      "label": "7d",
      "usedPercent": 52.25,
      "resetsAt": 1790500000
    }
  ],
  "fetchedAt": 1789999900,
  "stale": true,
  "message": "暂时无法获取最新额度，当前展示上次成功结果"
}
```

余额也使用额度列表，但保留金额字段：

```json
{
  "status": "ready",
  "planLabel": null,
  "limits": [
    {
      "id": "account-balance",
      "label": "账户余额",
      "usedPercent": 25,
      "description": "余额 75.00 / 100.00",
      "remaining": 75,
      "total": 100,
      "resetsAt": null
    }
  ],
  "fetchedAt": 1790000000,
  "stale": false,
  "message": null
}
```

### 3.2 字段说明

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `status` | string | 是 | 数据读取状态，决定展示额度、空态还是操作提示 |
| `planLabel` | string \| null | 是 | 上游套餐名称的精简展示值；未知时为 `null` |
| `message` | string \| null | 是 | 面向用户的状态说明；成功且无需提示时为 `null` |
| `fetchedAt` | integer \| null | 视结构而定 | 最近一次成功数据的 Unix 秒时间戳 |
| `stale` | boolean | 视结构而定 | `true` 表示正在展示最后一次成功数据，而非本次实时结果 |
| `region` | `global` \| `mainland` \| null | 否 | 数据所属区域；无法确定时为 `null` |
| `limits` | array | 额度列表结构必填 | 一个账户下可展示的额度窗口集合 |
| `id` | string | 是 | 窗口内稳定标识，不作为跨适配器全局 ID |
| `label` | string | 是 | 面向用户的短标签，例如周期或额度类型 |
| `usedPercent` | number | 是 | 已使用比例，范围为 `0–100` |
| `resetsAt` | integer \| null | 是 | 额度刷新或到期的 Unix 秒；上游未提供时为 `null` |
| `description` | string \| null | 余额窗口必填 | 金额摘要等补充说明 |
| `remaining` | number \| null | 余额窗口必填 | 剩余额度；未知时为 `null` |
| `total` | number \| null | 余额窗口必填 | 总额度；未知时为 `null` |

### 3.3 状态定义

| 状态 | 含义 | 展示策略 |
| --- | --- | --- |
| `ready` | 已取得可展示数据 | 展示套餐和额度；`stale` 为真时同时提示数据陈旧 |
| `not-installed` | 未发现本地工具或配置目录 | 提示先安装并使用对应工具 |
| `not-signed-in` | 未发现有效登录状态 | 提示在原工具中登录 |
| `authorization-required` | 需要用户完成额外授权 | 提示在原工具完成授权，不在当前应用收集凭据 |
| `expired` | 本地认证已过期 | 提示重新登录 |
| `access-denied` | 当前账户无权访问额度接口 | 显示权限提示，不反复重试 |
| `custom-provider` | 检测到不受支持的自定义服务地址 | 停止默认接口请求并说明限制 |
| `unsupported-account` | 当前账户类型不提供订阅额度 | 显示账户类型不支持 |
| `unsupported-plan` | 当前套餐不提供可读取额度 | 显示套餐不支持 |
| `unsupported-version` | 本地版本或协议不兼容 | 提示升级原工具或当前应用 |
| `temporarily-unavailable` | 网络、上游服务或临时解析失败 | 有历史快照时展示陈旧数据，否则展示稍后重试 |
| `unavailable` | 旧结构中的通用不可用状态 | 按消息展示，不将其解释为未登录 |

没有额度的错误示例：

```json
{
  "status": "not-signed-in",
  "planLabel": null,
  "limits": [],
  "fetchedAt": null,
  "stale": false,
  "message": "请先在原工具中登录"
}
```

## 4. 套餐、刷新时间与剩余额度策略

### 4.1 套餐等级

当前行为：

- `planLabel` 保存经过空白清理和有限名称映射后的展示文本。
- 无法识别套餐时保留安全的通用名称或 `null`。
- 套餐名称与额度窗口相互独立；有套餐不代表一定能取得额度。
- 当前没有共享的 `free/pro/team/enterprise` 等等级枚举，也不会根据名称推断具体额度。

建议：如后续需要筛选或统计，可新增独立的标准等级字段，同时继续保留原始展示名称；不得仅根据套餐名称推断刷新周期、限额或付费状态。

### 4.2 使用与剩余比例

当前行为：

- 上游 `0–1` 小数比例在 mapper 边界转换为 `0–100`。
- 已提供百分比的接口直接校验并限制在 `0–100`。
- 只提供 `used` 和 `total` 时，按 `used / total * 100` 计算。
- renderer 使用 `100 - usedPercent` 计算剩余比例，并将结果限制在 `0–100`。
- 非有限数或无法识别的窗口通常被忽略，不应作为 `0%` 已用展示。
- 余额窗口保留 `remaining` 和 `total`，百分比只用于复用环形进度展示。

建议：统一规定“缺失”与“零使用”是不同状态。缺少分母时保留金额或数量，不生成虚假的百分比。

### 4.3 刷新时间

当前行为：

- mapper 接受 ISO 时间、Unix 秒或 Unix 毫秒，并归一化为 Unix 秒。
- 上游没有刷新时间时返回 `null`，renderer 不编造倒计时。
- `resetsAt` 表示对应窗口的刷新或到期时间；`fetchedAt` 表示本地成功取得快照的时间，两者不能混用。
- renderer 在组件挂载和窗口重新获得焦点时读取快照。
- 多数网络型读取器缓存最后一次成功结果 60 秒，并合并并发请求。
- 多数网络型读取器失败时保留最后一次成功数据并设置 `stale: true`。
- 一个旧式本地 RPC 快照当前没有 `fetchedAt`、`stale` 和 60 秒成功缓存。

建议：

- 统一补齐 `fetchedAt` 和 `stale`，使所有快照具备相同的新鲜度语义。
- 区分成功缓存 TTL 与陈旧数据可展示期限；陈旧期限不应由 `resetsAt` 推导。
- 对网络错误使用带抖动的指数退避；鉴权失败等待登录状态变化，限流响应优先遵循上游 `Retry-After`。
- 手动刷新可以绕过成功缓存，但仍复用进行中的请求并遵守上游限流。

### 4.4 错误与降级

当前行为：

- 安装、登录、过期、账户不支持和临时故障使用不同状态表达。
- 请求失败且已有成功快照时，优先展示旧额度，避免卡片瞬间退化为空态。
- 错误消息面向用户，底层异常、响应体和凭据不会进入 IPC 快照。
- 区域型适配器按区域分别缓存，避免不同账户区域互相覆盖。

建议：将错误进一步划分为可重试与需用户操作两类，并为限流保留可选的下次重试时间；在运行时契约真正增加字段前，文档和 Schema 不预先声明这些字段。

### 4.5 面板展示位置与渠道开关

当前行为：

- Desktop 与 CLI 用量页把订阅额度卡片放在顶部四个概览指标卡片下方、热力图上方；macOS 托盘弹层继续复用同一组卡片。
- 设置 →「订阅」可按渠道开关是否允许展示；默认全部开启。偏好保存在 renderer 的 `localStorage`（`tud.subscriptionChannelVisibility`）。
- 当前设置与网格仅包含已可本地读取额度的渠道；Trae / WorkBuddy 等尚未落地的适配器不进入开关列表，也不挂载卡片。
- 渠道关闭后不挂载对应卡片；开启后仍遵循现有自动识别：加载中或无可展示额度时不占位。

### 4.6 CLI 独立运行与本地 HTTP

- `pnpm start:cli` 构建并启动本地面板；修改源码后需要构建，开发热更新使用 `pnpm dev:cli`。
- 关闭本项目 Desktop 后，CLI 直接读取本机供应商登录状态并获取订阅，不依赖 Electron 或桌面端缓存。供应商工具自身的运行条件仍然有效，例如某些渠道需要其本地服务运行。
- 首页包含当前可用的 12 个渠道，沿用 Desktop 卡片、详情、首次加载、聚焦刷新和单卡刷新规则。设置 →「订阅」支持逐渠道开关；CLI 浏览器与 Desktop 的 localStorage 偏好各自独立。
- 本地接口为 `GET /functions/tud-subscription/:channel`；`forceRefresh=1` 绕过成功缓存，仍合并进行中的请求。响应使用 `{ success, message, data }`；业务状态保留在 snapshot 中，意外异常仅返回通用错误码。
- 接口仅支持 HTTP 回环面板及端口 5194 的 CLI 开发来源；拒绝外部 Origin、跨站请求和非回环 Host。通过 `--host` 暴露的远程面板不提供订阅读取。
- Node 20 下读取 Cursor / VS Code 本地数据库需要 `sqlite3` 在 PATH 中；支持 `node:sqlite` 的版本优先使用只读内置数据库实现。缺少读取能力只影响相应渠道，不阻止 CLI 启动。
- CLI 默认使用 Node fetch；Desktop 为原来使用 Chromium 请求的读取路径注入 Electron `net.fetch`，保留原系统代理/PAC 行为。
- 线上掘金 Web（`VITE_API_TARGET=server`）不挂载订阅卡片或订阅设置，也不调用本机订阅接口。订阅能力不改变采集 owner、同步、上传和 heartbeat 规则。

## 5. 当前协议约束与演进原则

- core 提供统一的渠道分发入口；本文和 Schema 保留各渠道已有快照形态，并不要求所有适配器返回相同字段。
- 新增字段时优先保持可选，确认所有调用方完成兼容后再设为必填。
- 修改字段含义、时间单位或百分比方向属于破坏性变更，需要同步更新 shared 类型、IPC bridge、renderer 和 Schema。
- 新增响应结构时，应先判断能否复用现有三类形态；无法复用时再扩展 Schema 的顶层联合类型。
- 文档示例必须使用脱敏、虚构数据，不得复制真实账户响应。
