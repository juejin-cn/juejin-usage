# Contributing Guide

源码仓库：[juejin-cn/juejin-usage](https://github.com/juejin-cn/juejin-usage)。

## 安装依赖的注意事项
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

从 `main` 拉分支，PR 回 `main`。

## 提 Issue

先按场景选对入口：

| 场景 | 去处 |
| --- | --- |
| 装不上、面板打不开、`LOCAL_RUNTIME_NOT_READY` | 先看 [FAQ](./FAQ.md) |
| 不确定是不是 Bug、想问用法、想先讨论方案 | [Discussions](https://github.com/juejin-cn/juejin-usage/discussions) |
| 可复现的缺陷 | [🐞 Bug 报告](https://github.com/juejin-cn/juejin-usage/issues/new?template=bug-report.md) |
| 新功能 / 改进建议 | [🆕 需求与改进](https://github.com/juejin-cn/juejin-usage/issues/new?template=feature-request.md) |

Bug 报告务必写清**端、版本、操作系统、复现步骤**，缺这几项我们没法定位。日志在 `~/.ai-usage/logs/` 下（`daemon.log` / `sync.log` / `notify.log`）。

## 分支规范

`<end>` 只能是 `desktop` | `cli` | `web`。

| 类型 | 格式 | 示例 |
|------|------|------|
| 新功能 | `feat/<end>/<short-desc>` | `feat/cli/service-status` |
| 修 bug | `fix/<end>/<short-desc>` | `fix/web/rank-layout` |
| 文档 / 构建 / 依赖 | `chore/<short-desc>` | `chore/readme-assets` |

跨端改动用影响最大的一端，PR 正文写清范围（例如 `feat/web/share-card`，注明 Desktop renderer 同步改了）。

Fork [juejin-cn/juejin-usage](https://github.com/juejin-cn/juejin-usage) → 按上面开分支 → 提交 Pull Request。

## Commit 规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，主语用英文：

```text
<type>(<scope>): <subject>
```

`<type>`：`feat` | `fix` | `docs` | `style` | `refactor` | `perf` | `test` | `build` | `ci` | `chore`

`<scope>` 可选，填模块名：`desktop` | `cli` | `web` | `dashboard` | `core` | `pricing` 等。

```text
feat(web): add GitHub repository link to leaderboard filter chrome
fix(pricing): avoid guessing Cursor models as MiniMax
chore(release): point auto-update feeds to v0.1.6
```

## 提 PR

PR 会自动带出模板，按模板填完即可。几个容易踩的点：

- **带上 changeset。** 影响用户的改动都要跑 `pnpm changeset`，并把生成的文件一起提交；纯文档 / CI 改动可跳过。描述写「对用户的影响」而非实现方式，详见 [发版与里程碑规范](./RELEASE.md#changeset-怎么写)。
- **改了面板 UI 要看两处。** `packages/dashboard/src` 与 `apps/desktop/src/renderer` 是同构但独立的两份代码，改一处时确认另一处是否需要同步。
- **跨端改动**在 PR 正文写清影响范围。
- 合并前确保 `pnpm build` 通过。

## 按端启动

数据目录：`~/.ai-usage/`。同一时刻不要同时开 Desktop 和 CLI（Desktop 会抢 runtime 并停掉 CLI 服务）。

本地 CLI 用量页（`http://127.0.0.1:8452`）和线上用量页（`https://juejin.cn/aiusage/`）都是同一份 Dashboard（`packages/dashboard`）。

### Desktop

路径：`apps/desktop`

```bash
pnpm install
# 开发热更新：
pnpm dev:desktop
# 构建依赖后启动 Electron
pnpm start:desktop    
```

### CLI

路径：`packages/cli`（面板来自 `packages/dashboard`）

```bash
pnpm install
pnpm start:cli        # 构建后启动，面板 http://127.0.0.1:8452
pnpm dev:cli          # CLI API :8452 + Vite HMR :5194（开发请打开 5194）
```

改 UI 后若用 `start:cli`，需再跑一次 `pnpm build:cli`。

### Web

路径：`packages/dashboard`，本仓库不包含后端。

**方式 A：Whistle**（`https://juejin.cn/aiusage/`）

```bash
pnpm dev:web
```

1. 安装并启动 [Whistle](https://wproxy.org/)（端口 `8899`）或 [whistle 客户端](https://github.com/avwo/whistle-client)（可自动装证书）：

```bash
npm i -g whistle
w2 start
```

浏览器 / 系统代理 `127.0.0.1:8899`。首次 HTTPS 需信任根证书：`http://127.0.0.1:8899` → HTTPS，或 `w2 ca`。

2. Rules：

```text
juejin.cn enable://https
juejin.cn/aiusage/ http://localhost:5194/aiusage/
```

3. 打开 `https://juejin.cn/aiusage/`

**方式 B：Vite proxy**（`http://localhost:5194/aiusage/`）

```bash
pnpm dev:web:proxy
```

1. 登录 `https://juejin.cn`
2. DevTools → Application → Cookies：把 `juejin.cn` 的登录会话拷到 `localhost`（同名同值；含 HttpOnly；不要勾 Secure）
3. 打开用量页并刷新

## 发版

发版、里程碑与 changelog 由维护者按 [发版与里程碑规范](./RELEASE.md) 执行。
