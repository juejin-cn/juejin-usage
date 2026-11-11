# 网关模型元数据

`ModelMetadata` / `ModelCatalog` 可从 core 的 `agent-router/model-metadata` 子入口导入。浏览器运行时的 `sanitizeModelMetadata` 必须从此子入口导入；`agent-router` 总入口包含 Node 服务端模块，前端只可从总入口使用 `import type`。适配器输出统一结构，Worker 白名单校验后通过现有 `/models` 查询返回给账户模型列表；API Key 的模型目录也使用相同契约。

```ts
interface ModelMetadata {
  name?: string;
  capabilities?: { vision?: boolean; reasoning?: boolean; toolCalling?: boolean };
  limits?: { contextTokens?: number; maxContextTokens?: number; outputTokens?: number };
  billing?: {
    isFree?: boolean;
    multiplier?: number;
    originalMultiplier?: number;
    discountRatio?: number;
    conditions?: string[];
    validUntil?: string;
  };
}
```

能力字段缺省代表未知，`false` 代表上游明确不支持。VL 是模型的图片输入能力，不代表当前网关传输层已支持该模型的全部多模态协议。上下文以 Token 计，Max 是可选模式上限，展示它不会改变请求。

倍率仅在供应商、账号内部比较；折扣比例 0.8 为八折。零倍率不自动等于免费：例如 Copilot 零 premium request multiplier 仍属于付费订阅。不得将模型名称、未知字段或缺失价格转换成“免费”。该结构服务于展示，不参与账单结算和路由。

## 适配边界

厂商字段映射集中在 `channels/model-metadata.ts`，由各渠道显式调用；公共 `modelRows` 只校验统一结构，不猜测字段。

| 渠道 | 已确认的数据来源 |
| --- | --- |
| Trae CN / Global | `multimodal`、普通/Max 窗口、`__dev` 输出上限、账号折扣和分时倍率；有 `__max` 模型才展示 Max |
| Copilot | `capabilities.supports`、`capabilities.limits`、`billing.multiplier` |
| Codex | `input_modalities`、`context_window`、`max_context_window`、推理摘要能力 |
| Kiro | `supportedInputTypes`、`tokenLimits` |
| Qoder / 千问工作及企业版 | `is_vl`、`is_reasoning`、上下文配置、消费倍率与账号活动 |
| WorkBuddy 国内/国际 | 图片/推理开关、输入输出限制、积分倍率与整日折扣；分时活动价格不能可靠解释时省略倍率 |
| MiniMax 国内/国际 | 模态列表、`attachment`、`thinking_config`、上下文与输出上限 |
| ZCode | 已命中的模型配置规则中的输入格式、上下文和输出/推理选项 |
| Antigravity | `supportsImages`、`maxTokens`、`maxOutputTokens` |
| Grok | `context_window` |
| OpenCode Zen 免费入口 | 已获取目录的模态、能力、上下文、输出、输入/输出及缓存价格 |
| Claude / Cursor / Kimi Work / 火山手动 ID / OpenCode Go / 通用 API | 当前查询未确认的可选字段留空，仅保留名称与 ID |

新增渠道时在适配器补转换函数和真实响应形状的测试，不修改前端供应商判断分支，也不按相似名称填充模型能力。

## 传输、刷新和兼容

查询响应保留 `models: string[]`、`names`，增量增加 `metadata` 和 `checkedAt`。原先只消费 ID 的调用方不变，元数据不写入路由配置。字段校验丢弃无效可选值及原始供应商字段，不携带认证信息。

前端以账户实例 ID 隔离目录，请求合并只限同一账户。详情打开期间每分钟刷新，并在当前计费数据的 `validUntil` 到达时刷新。动态价格采用不超过一分钟的保守有效期；期限内仍以上游条件为准。失败时保留能力和上下文，已到期的计费信息不继续显示，界面提示刷新失败。
