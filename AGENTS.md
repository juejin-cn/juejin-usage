# AGENTS.md

本仓库无后端。脚本以根 `package.json` 为准。

| 路径 | 职责 |
|------|------|
| `packages/core` | parser、queue、sync、local-api |
| `apps/web` | 线上 `/aiusage/` 的独立入口、路由及 shadcn/ui 界面 |
| `packages/cli` | `jusage`：HTTP + 托管 dashboard dist |
| `packages/dashboard` | CLI / Tauri 面板，以及 Web 迁移期间复用的业务页面 |
| `apps/desktop` | Electron，**已停止维护**；`src/renderer` 是 dashboard 的旧副本 |
| `apps/desktop-tauri` | Tauri；`pnpm dev:desktop` 默认入口。内嵌 dashboard dist，`src/host` 起 Node sidecar 跑 core local-api |

Web 专属 UI 改 `apps/web/src`，使用 shadcn/ui + Base UI 组件（Vega 风格，源码位于 `apps/web/src/components/ui`）、Tabler Icons 与 Tailwind CSS 布局，主题主色为 `#1f80ff`。本地面板 UI / 数据层改 `packages/dashboard/src`，不要同步到 `apps/desktop/src/renderer`。

宿主侧能力（凭据存储、IPC、网关控制接口等）只接 Tauri：`apps/desktop-tauri/src/host`。

PR / 分支命名 / Web 对照线上：[CONTRIBUTING.md](CONTRIBUTING.md)。Desktop 主进程、IPC、heartbeat、mock：[apps/desktop/README.md](apps/desktop/README.md)。

## 开发指南

需要 Node.js >= 20。克隆后先在仓库根执行 `pnpm install`。

如 `pnpm install` 卡在 electron postinstall

Electron 二进制默认从 GitHub Releases 拉取；国内网络可能会超时

请在安装前设置环境变量：

```bash
# Git Bash / macOS / Linux
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
pnpm install
```

```powershell
# PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
pnpm install
```

## 契约

`packages/core/src/server/local-api.ts` 的 `/functions/tud-*` 是 CLI / Desktop / web 共用契约。Dashboard `src/lib/api.ts` 用 `VITE_API_TARGET`（`cli` / `server`）切本地路径与公开 API 根。Desktop renderer 经 IPC 走同一契约，不占 `:8452`。

公开 API 默认根：`packages/core/src/config.ts` 的 `DEFAULT_JUEJIN_API_URL`（面板「设置」可覆盖）。

定价：`packages/core/src/pricing/baked-defaults.ts` 兜底；覆盖价运行时从公开 API 拉。

## Runtime

数据目录 `~/.ai-usage/`（`packages/core/src/paths.ts`），日志 `~/.ai-usage/logs/`。

`tud.pid`（`{pid,kind}`，`kind` ∈ `{cli,desktop}`）互斥：Desktop 启动停 CLI 并抢 owner；之后 CLI 再启只开面板（observer），不 sync/upload。

## Dashboard 进 CLI 包

`pnpm start:cli` 托管已构建 dist：改 `packages/dashboard` 后先 `pnpm build:cli`。`pnpm dev:cli` 才是 Vite HMR（面板开 `:5194`）。

CLI 构建固定 `VITE_BASE=/`。子路径在构建环境注入 `PUBLIC_PATH` / `VITE_BASE`；写进已提交的 `.env.development` / `.env.production` 会打进 CLI 包。

## Desktop 发版

`pnpm release:desktop:mac|win` 推 GitHub Release。`electron-builder.yml` 的 `publish` 仍是 GitHub；运行时更新源在同文件（默认 Gitee）。Electron 二进制走 `apps/desktop/.npmrc` 国内镜像；根 `pnpm.onlyBuiltDependencies` 已含 `electron`。

---
Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
---
