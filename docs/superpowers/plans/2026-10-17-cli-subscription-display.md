# CLI Subscription Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** CLI Web 首页独立获取并展示与 Desktop 一致的 12 个渠道订阅套餐及额度卡片。

**Architecture:** 供应商 snapshot、mapper 与 Node 读取器集中到 core；Desktop IPC 保持兼容，CLI 提供逐渠道 HTTP 接口。Dashboard 复用 Desktop 卡片，通过自身数据访问模块调用 HTTP；线上 server 模式不挂载卡片或订阅设置。

**Tech Stack:** TypeScript、Node >=20、Hono、React 19、HeroUI v3、现有 Node test runner、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-10-17-cli-subscription-display-design.md`

## Global Constraints

- 分支：`feat/cli/subscription-display`；不改 main，不自动推送或合并。
- 覆盖 12 个渠道：Codex、Claude、Cursor、GitHub Copilot、Grok、Kimi、ZCode、Antigravity、Qoder、MiniMax、OpenCode、DeepSeek。
- 保持 Node >=20；优先复用 core 已有 `parsers/sqlite.ts` 的运行时探测及 `sqlite3` CLI 回退能力，不引入新的原生数据库依赖。
- CLI 独立于本项目 Electron 应用；保留供应商工具本身的运行条件。
- Desktop IPC 方法、snapshot 字段、额度算法及 Chromium 系统代理/PAC 行为不回归。
- 凭据只在 Node/Electron 后台读取；不传给浏览器、不写日志、不上传云端、不修改供应商认证文件。
- 卡片位置、排序、详情、刷新、失败降级与 Desktop 一致；两份 renderer 的同名展示代码保持同步。
- 线上 server 模式不展示订阅卡片和渠道设置，不发起订阅请求。
- 未经用户要求不自动使用 agent browser。
- 开始实现 UI 前，按 AGENTS.md 恢复缺失的 HeroUI 本地文档并阅读 Card、ProgressBar、Button、Checkbox、Tabs 文档；涉及库 API 的新用法用 ctx7 查询当前文档。

## 文件职责与迁移映射

| 源码 | 目标/处理 | 职责 |
| --- | --- | --- |
| `apps/desktop/src/shared/*-subscription.ts`（上述 12 渠道） | `packages/core/src/subscription/shared/`；原文件转发导出 | snapshot 类型和 mapper |
| `apps/desktop/src/shared/subscription-{amounts,plan,channels}.ts` | `packages/core/src/subscription/shared/`；原文件转发导出 | 共用金额、套餐和显示偏好 |
| `apps/desktop/src/main/*-subscription.ts`（上述 12 渠道） | `packages/core/src/subscription/readers/`；原文件转发导出 | 本机认证和额度读取 |
| `apps/desktop/src/main/{subscription-cache,cli-runtime,claude-usage-parser,kimi-desktop-context,qoder-app-auth}.ts` | `packages/core/src/subscription/readers/`；原文件转发导出 | 读取器必要依赖 |
| `apps/desktop/src/main/subscription-fetch.ts` | 保留 Electron 实现；core 新建独立请求适配模块 | 运行时请求函数注入 |
| `packages/core/src/subscription/{index,read,transport}.ts` | 新建 | 浏览器安全导出、渠道分发、请求注入 |
| `packages/core/src/server/subscription-api.ts` | 新建 | HTTP 参数、来源和错误边界 |
| `apps/desktop/src/renderer/components/*Subscription*.tsx` | 迁移需要的卡片副本到 Dashboard | 保持现有展示与详情 |
| `apps/desktop/src/renderer/lib/*subscription*.ts`（非测试） | 必要辅助函数复制到 Dashboard | 额度展示、快照选择、详情格式化 |
| `packages/dashboard/src/lib/subscription-api.ts` | 新建 | 逐渠道 HTTP 数据访问 |
| 两端 `src/renderer/lib/subscription-api.ts` / Dashboard `src/lib/subscription-api.ts` | 同名独立实现 | 将卡片与 IPC/HTTP 解耦 |
| Dashboard `SettingsPanel.tsx`、`shell-events.ts` | 修改 | CLI 专用订阅开关 |

不搬迁 Trae/WorkBuddy 的未启用读取器；如果它们引用已迁移模块，保留原路径转发以保证编译。原测试继续通过转发验证同一份实现；新接口与运行时注入测试放在 core/test。

### Task 1: 提取共享订阅读取模块并保留 Desktop 行为

**Files:** 上表 core/subscription 的所有新文件、Desktop 对应转发文件、`apps/desktop/src/main/index.ts`、`packages/core/package.json`、`pnpm-lock.yaml`。

**Interfaces:**
- Produces: `SubscriptionReadOptions = { forceRefresh?: boolean }`。
- Produces: 浏览器安全子路径 `@juejin-opensource/jusage-core/subscription`，导出各 snapshot/mapper/渠道偏好；不导入读文件或网络模块。
- Produces: 后台子路径 `@juejin-opensource/jusage-core/subscription/read`，导出 `readSubscription<K extends SubscriptionChannelId>(channel: K, options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel[K]>`。
- `SubscriptionSnapshotByChannel` 的 11 个值为对应渠道 snapshot；`kimi` 为 `KimiSubscriptionSnapshot[]`。
- Produces: 后台 `setSubscriptionFetch(fetcher: typeof fetch): void`，CLI 默认使用 Node fetch，Desktop 在注册 IPC 前注入 Electron fetch。

- [x] **Step 1: 增加运行时传输测试并验证失败**

新增 `packages/core/test/subscription-transport.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSubscription, setSubscriptionFetch } from '../src/subscription/transport.js';

test('subscription requests use an injected transport without importing Electron', async () => {
  const calls: string[] = [];
  setSubscriptionFetch(async input => {
    calls.push(String(input));
    return Response.json({ ok: true });
  });
  try {
    assert.deepEqual(await (await fetchSubscription('https://example.invalid/usage')).json(), { ok: true });
    assert.deepEqual(calls, ['https://example.invalid/usage']);
  } finally {
    setSubscriptionFetch(globalThis.fetch);
  }
});
```

运行 `pnpm --filter @juejin-opensource/jusage-core test:compile`，预期缺少新模块而失败。

- [x] **Step 2: 按映射提取实现和定义子路径导出**

迁移原实现，内部相对 import 使用 `.js`，保持 exported 函数签名和 mapper 不变。原 Desktop 文件使用明确的 core 子路径转发，例如：

```ts
export * from '@juejin-opensource/jusage-core/subscription/shared/codex-subscription';
```

在 core/package.json 增加 `/subscription`、`/subscription/read`、`/subscription/transport`、`/subscription/shared/*`、`/subscription/readers/*` 的 types/import 映射。core 的 deepseek 读取器需要 `yaml`，将 Desktop 已有 `^2.9.1` 版本声明加入 core 后更新 lockfile，不引入额外解析方案。

传输实现保持延迟读取注入函数，避免模块初始化时捕获旧 fetch：

```ts
let subscriptionFetch: typeof fetch = (...args) => globalThis.fetch(...args);
export function setSubscriptionFetch(fetcher: typeof fetch): void {
  subscriptionFetch = fetcher;
}
export const fetchSubscription: typeof fetch = (...args) => subscriptionFetch(...args);
```

只有原来使用 Electron fetch 的读取路径改用该 transport；其他读取器保留原有 fetch 选择，避免扩大 Desktop 的代理行为变更。Desktop main 在 IPC 注册前执行 `setSubscriptionFetch(fetchSubscription)`，后者来自原 Electron `subscription-fetch.ts`。

- [x] **Step 3: SQLite 兼容与渠道分发**

Cursor/Copilot 不得静态导入 `node:sqlite`。将它们现有固定只读 SQL 改用 core `queryDbJson` 的只读读取能力，保留账户选择和查询结果解析；必要时为 helper 增加只读选项。所有 SQL 参数来自原有固定键或经转义的值，不拼接请求参数。

`read.ts` 明确 import 12 个读取器，通过固定表分发；Kimi 调用 `readKimiSubscriptions`，其他调用各自 `read*Subscription`。不接受任意模块路径。为后台和浏览器入口分别做 Node 无 Electron 的 import smoke 验证。

- [x] **Step 4: 验证并提交**

运行 core build、上述 transport 测试、Desktop 既有所有 subscription/辅助模块测试及 Desktop typecheck。验证迁移后的凭据隔离、缓存、并发和 stale 行为由原测试覆盖。提交 `refactor(core): share subscription readers across runtimes`。

### Task 2: 增加隔离失败的逐渠道本地接口

**Files:** 新建 `packages/core/src/server/subscription-api.ts`、`packages/core/test/local-api-subscription.test.ts`；修改 `packages/core/src/server/local-api.ts`。

**Interfaces:**
- Consumes: Task 1 的 `readSubscription` 和 `SubscriptionChannelId`。
- Produces: `createSubscriptionApi(reader = readSubscription): Hono`，便于注入虚拟 reader。
- Produces: `GET /functions/tud-subscription/:channel?forceRefresh=1`，响应沿用 `{ success, message, data }`。

- [x] **Step 1: 先写接口边界测试**

核心测试使用注入 reader，不能访问真实账户：

```ts
test('returns the selected snapshot and forwards forceRefresh', async () => {
  const calls: unknown[] = [];
  const snapshot = { status: 'ready', planLabel: 'Plus', fiveHour: null, weekly: null,
    hasAccount: true, fetchedAt: 1800000000, stale: false, message: null };
  const app = createSubscriptionApi(async (channel, options) => {
    calls.push([channel, options]);
    return snapshot as never;
  });
  const res = await app.request('http://127.0.0.1:8452/codex?forceRefresh=1');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, message: 'ok', data: snapshot });
  assert.deepEqual(calls, [['codex', { forceRefresh: true }]]);
});
```

再增加：普通读取传 false；`forceRefresh=true` 不视为 1；未知渠道 404 且 reader 未执行；Kimi 数组原样返回；业务失败 snapshot 仍是正常响应；reader 抛出包含私密字符串的错误时 HTTP 500 仅返回 `SUBSCRIPTION_READ_FAILED`。

来源测试：允许 CLI 同源与 `http://localhost:5194`/`http://127.0.0.1:5194` 的开发来源；拒绝 `Origin: https://evil.example`、`Origin: null` 和 `Sec-Fetch-Site: cross-site`，并断言未调用 reader。无 Origin 的本机请求允许。只接受 HTTP 回环 Host，拒绝 DNS rebinding Host；显式非回环 `--host` 不新增订阅远程访问能力。

- [x] **Step 2: 实现独立路由与挂载**

来源校验必须在调用 reader 前进行；不依赖现有宽松 `cors()` 实现认证。错误均使用现有 envelope，状态码分别为 403、404、500。只有合法渠道执行读取：

```ts
const channel = c.req.param('channel');
if (!isSubscriptionChannelId(channel)) {
  return c.json({ success: false, message: 'UNKNOWN_SUBSCRIPTION_CHANNEL', data: null }, 404);
}
try {
  const data = await reader(channel, { forceRefresh: c.req.query('forceRefresh') === '1' });
  return c.json({ success: true, message: 'ok', data });
} catch {
  return c.json({ success: false, message: 'SUBSCRIPTION_READ_FAILED', data: null }, 500);
}
```

在 `createLocalApiApp` 中使用 `app.route('/functions/tud-subscription', createSubscriptionApi())`。不修改 sync owner、heartbeat 和上传路径；路由请求按渠道独立执行。

- [x] **Step 3: 验证并提交**

运行 core test:compile、`node --test packages/core/dist-test/test/local-api-subscription.test.js`、core 既有 local-api 测试。提交 `feat(cli): expose local subscription snapshots`。

### Task 3: 首页卡片、渠道设置和运行时数据访问

**Files:** Dashboard `src/components/{SubscriptionUsageGrid,SubscriptionUsageCard,SubscriptionBrandIcon,*SubscriptionCard}.tsx`（仅实际启用的 12 个）、相关 `src/lib/*subscription*.ts`、`src/hooks/useSubscriptionChannelVisibility.ts`；两端同名数据访问层；Dashboard `DashboardPage.tsx`、`SettingsPanel.tsx`、`shell-events.ts`、package.json；pnpm-lock.yaml。

**Interfaces:**
- Consumes: Task 1 的 browser-safe 子路径类型/mapper，Task 2 的 HTTP 契约。
- Produces: 两端 `subscriptionApi` 对象，保留原 `window.tud.get*Subscription(options)` 的方法名和返回类型；Desktop 方法逐一转发 IPC，Dashboard 方法逐一请求渠道路径。

- [x] **Step 1: 获取组件文档并补齐所需依赖**

AGENTS.md 的 `.heroui-docs` 当前缺失，先执行其指定的 `heroui agents-md --react --output AGENTS.md`；检查生成变更，仅保留与需求相关的内容。阅读现有卡片使用的 HeroUI v3 组件文档。Dashboard 缺少原卡片使用的 date-fns 与 @lobehub/icons，按 Desktop 现有版本添加 `date-fns@^4.4.0` 和 `@lobehub/icons@^5.18.0`，不升级其他依赖。

- [x] **Step 2: 先验证 HTTP 客户端行为**

将可测试的请求边界拆成不依赖 Vite env 的函数，默认 transport 为 fetch；runtime 对象在 CLI 判断后调用该函数。新增 Dashboard `src/lib/subscription-request.test.ts`，mock fetch 验证方法、路径、forceRefresh、envelope 解包与错误，不模拟浏览器账户或 DOM。

```ts
export async function requestSubscription<T>(
  channel: SubscriptionChannelId,
  options: SubscriptionReadOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const suffix = options.forceRefresh ? '?forceRefresh=1' : '';
  const response = await fetcher(`/functions/tud-subscription/${channel}${suffix}`);
  const body = await response.json() as { success: boolean; message: string; data: T | null };
  if (!response.ok || !body.success || body.data === null) throw new Error(body.message);
  return body.data;
}
```

不要通过 `window.tud` shim 支持浏览器。客户端只转发 `forceRefresh`；Claude 原卡片的 `allowCredentialAccess: true` 可由 typed adapter 接收并保留 Desktop IPC 行为，CLI 仍使用已迁移的原 reader，不新增授权机制。

- [x] **Step 3: 复制展示组件并替换数据调用**

原 Desktop 卡片与 Dashboard 副本都改成 `subscriptionApi.getCodexSubscription(...)` 等同名调用。Dashboard 从 core/shared 子路径引用 snapshot、mapper 和渠道偏好。保留 Codex 的 focus 判断、Kimi 多来源选择、各渠道详情和失败反馈。同步必要 SVG 资产，避免无关 Trae/WorkBuddy 组件进入 grid。

Dashboard 首页插入与 Desktop 一致的网格：

```tsx
{isCliBackend() ? (
  <SubscriptionUsageGrid className="mt-4 grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 [&>*]:order-3 [&>*]:self-stretch [&>[data-metric-count='3']]:order-1 [&>[data-metric-count='2']]:order-2" />
) : null}
```

插入位置以 Desktop `DashboardPage.tsx` 的概览指标/热力图关系为准；不能放在整个图表区之后。网格挂载不依赖所有渠道请求完成，不阻塞首页用量加载。

- [x] **Step 4: 订阅渠道开关**

复用原 `useSubscriptionChannelVisibility` 和 `SubscriptionChannelSettings`。Dashboard `SettingsTabId` 增加 `subscription`；Tabs.List/Panel 只在 cliMode 挂载该设置。server 模式遇到 subscription key 回落 sync。保留默认全开、全开/全关、逐渠道切换和 localStorage key；关闭渠道后不挂载卡片、不发新请求。

复用既有 Desktop snapshot state、详情与进度测试到 Dashboard，验证同一份展示辅助规则。CLI/server gate 的请求边界测试确保 server 模式拒绝触发 fetch；不写仅搜索源码字符串的测试。

- [x] **Step 5: 验证并提交**

运行 Dashboard build/test 与 Desktop typecheck/test；确认浏览器 build 没有 Node/Electron externalization 警告。提交 `feat(dashboard): show subscription quota cards in cli mode`。

### Task 4: 集成验证、文档与 changeset

**Files:** `docs/subscription-plan-design.md`、`CONTRIBUTING.md`（仅补充实际新增条件）、`.changeset/cli-subscription-display.md`、本计划。

**Interfaces:** Consumes: Task 1–3 完整功能；Produces: 可构建的 CLI/Desktop 及验证记录。

- [x] **Step 1: 验证 Node 20 与 CLI 独立读取**

使用 Node 20 执行 core dist 的 browser-safe entry 和后台 read entry import；通过隔离 HOME/临时认证及 fake reader/upstream 验证读取，不读取用户真实凭据。SQLite fixture 用本地 sqlite3 创建虚拟库，验证 Cursor/Copilot 查询；缺少 sqlite3 时断言仅该渠道降级，CLI 仍启动。

现有本地测试不启动真实 Electron，也不修改真实 `~/.ai-usage/tud.pid`。CLI HTTP 集成测试使用临时数据目录和随机端口；断言两个渠道中一个失败时另一个仍完成。

- [x] **Step 2: 构建与回归**

顺序执行 `pnpm build`、`pnpm --filter @juejin-opensource/jusage-desktop typecheck`、`pnpm -r --if-present test`。前一阶段已通过且代码未再变更的检查不重复跑。任何失败先区分基线问题与本次回归，修复本次回归并记录无法验证的环境限制。

- [x] **Step 3: 更新说明及发版描述**

文档从 Electron-only 更新为共享 Node 后台读取 + IPC/HTTP 两种出口；记录 CLI 使用方式、Node 20 下 sqlite3 条件、供应商进程依赖、server 不支持。changeset：

```md
---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage": patch
---

CLI Web 首页支持展示本机各渠道的订阅套餐和剩余额度，无需启动桌面端，并可按渠道刷新和控制显示。
```

核对 CLI package.json 的实际包名后使用它；Dashboard/Desktop 为 private 包，按仓库 changeset 配置决定是否纳入。

- [x] **Step 4: 记录结果并提交**

将各步骤完成状态和实测结果更新到本计划，审查 `git diff --check` 与变更范围。提交 `docs(cli): document standalone subscription support`；不自动打开浏览器、不 push、不 merge、不发布。

## 计划自检

- Spec 覆盖：12 渠道与 Desktop 共用逻辑 → Task 1；本地接口及凭据边界 → Task 2；首页一致性与开关、server 隔离 → Task 3；Node 20/SQLite、独立运行及回归/changeset → Task 4。
- 类型一致性：Kimi 始终返回数组；其余 snapshot 保持原类型；HTTP 与 IPC 都只在数据访问层解包。
- 迁移风险：原路径转发保留既有调用方及测试；浏览器入口与后台入口分开，避免 core 根入口意外加载 Node/Electron。
- 执行顺序：Task 1 → Task 2 → Task 3 → Task 4；每步可单独验证与审阅。

## 执行记录（2026-10-17）

- Task 1 完成：core 共享 12 个读取器和 mapper；Desktop 原路径显式转发保留动态 import 的命名导出；新增子路径 default 条件供当前 Node 的 Desktop CommonJS 测试使用，Electron main 仍由构建器打包 core。
- Task 2 完成：固定渠道 HTTP 路由、来源/Host 校验、错误脱敏及刷新参数测试通过。
- Task 3 完成：卡片在 `DashboardOverviewCard.belowMetrics` 中展示，包含单卡刷新、详情和渠道开关；server 模式由 UI 挂载和客户端请求边界双重隔离。
- Task 4 完成：Node 20 的真实 SQLite CLI 回退、缺少 sqlite3 时渠道降级、随机端口 HTTP 集成测试与 CLI help 启动验证通过；补齐说明和 changeset。

### 测试证据

- RED：transport 测试先报缺少 `subscription/transport.js`；接口测试先报缺少 `server/subscription-api.js`；客户端测试先报缺少 `subscription-request.ts`。
- GREEN：上述实现完成后 Node 20 下 10 项订阅 transport/API/runtime 测试全部通过；SQLite fixture 和 mock 上游没有读取真实凭据，也没有启动 Electron 或改动真实 runtime pid。
- Core 基线：498 通过、3 跳过；最终四包测试：core 508 通过、3 跳过，Dashboard 134 通过，Desktop 344 通过，CLI 22 通过，合计 1008 通过、3 跳过。
- 四包构建通过：`pnpm --filter './packages/**' --filter @juejin-opensource/jusage-desktop -r build`；Desktop typecheck 通过；Dashboard/renderer 没有 Node/Electron 浏览器外部化警告，构建仍提示大体积 chunk。
- 四包测试命令：`pnpm --filter './packages/**' --filter @juejin-opensource/jusage-desktop -r --if-present test`。
- Node 20.20.2：两个 core 订阅入口无 Electron 导入成功；`packages/cli/bin/jusage.js --help` 正常；订阅测试无跳过。
- `pnpm build` 和全 workspace 测试被本地忽略目录 `apps/server` 内的嵌套工作树阻断（其 Electron 构建依赖缺失）；未修改该目录，改用上述明确选取实际四包的等价验证。

### 实施调整

- 本机缺少 `heroui` CLI，npm 的 `heroui` / `@heroui/cli` 均返回 404。使用 heroui-react 技能提供的官方文档脚本获取 Card、ProgressBar、Button、Checkbox、Tabs 的当前 MDX，并恢复到被忽略的 `.heroui-docs` 对应路径后阅读；未修改 AGENTS.md。
- Dashboard 的 lucide-react 从 `^1.24.0` 对齐到 Desktop 的 `^1.54.0`，因为原 Codex 卡片的 `PlayingCardsFan` 在旧版本不存在。这是保持现有卡片一致所需的依赖调整；lockfile 清理了安装过程中与本需求无关的变更。
- 浏览器安全的 `SubscriptionSnapshotByChannel` 类型放在 subscription 主入口，后台分发器仅引用它，防止 renderer 依赖后台模块。
- Grok 的原测试需要 mock Node 内置 spawn；迁移为 ESM 后使用 `syncBuiltinESMExports` 同步并恢复 mock，仍通过真实子进程验证 RPC。
- 按用户“直接按照计划实现”的指示在现有功能分支原地执行，没有另建工作树或派发实现代理；未自动进行浏览器操作。
