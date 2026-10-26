# Desktop Tauri

实验性 Tauri 客户端。当前完成第一阶段：主窗口、Dashboard、本地 Core API 与 Node sidecar 生命周期。
现有 Electron 客户端保留在 `apps/desktop`，原有启动、构建与发布命令继续有效。

## 运行

需要 Node.js >=20、pnpm 和 Rust stable。macOS 还需 Xcode Command Line Tools。
本阶段在 macOS arm64 上验证，Windows/Linux 安装包和功能验收安排在第四阶段。

```bash
pnpm install
pnpm dev:desktop:tauri
pnpm build:desktop:tauri
```

`dev` 和 `build` 都会先构建 Core、Node host 与 Dashboard，然后准备资源。
开发窗口与安装包统一加载内嵌前端，不依赖 Vite 开发服务器；修改源码后需重新运行。
当前默认构建 macOS `.app`，产物在 `src-tauri/target/release/bundle/macos/`。
尚未配置签名、公证、更新源或自动发布。

```bash
pnpm stage:desktop:tauri           # 只构建和准备资源
pnpm test:desktop:tauri            # Node 运行时、桥接及资源准备测试
pnpm --filter @juejin-opensource/jusage-desktop-tauri test:staged # 包内 Node/Core
cargo test --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml --locked
```

Rust 编译/测试前先运行 `pnpm stage:desktop:tauri`，以生成前端与运行时资源。
根目录 `pnpm build` 仍只构建 JS/TS；原生构建使用上面的独立入口。

## 架构与边界

```text
Tauri 主窗口 → 内嵌 Dashboard
                  ↓ 本地 API fetch 桥接
             Rust IPC → 127.0.0.1 随机端口 → Node sidecar → Core
```

- 主窗口复用 `packages/dashboard/dist`，不复制 React 源码；Dashboard 与 Electron renderer 均未修改。
- 桥接仅转发当前 origin 下的 `/health` 和 `/functions/tud-*`，公网请求继续使用原有 fetch。
- Node sidecar 使用相同的 local-api 契约，负责采集、缓存、同步和上报，独立定时更新 heartbeat。
- sidecar 使用 `kind: desktop` 参与 `tud.pid` 互斥。已有桌面 owner 时拒绝启动；接管 CLI 时沿用 Core 的停止/接管逻辑，并停用 CLI 开机自启。
- 正常退出通过 stdin 通知 sidecar 清理；宿主崩溃关闭 stdin 时，sidecar 也会清理并退出。超时后原生壳强制回收子进程。
- 资源准备脚本打包当前平台的 Node 和 Core 实际解析到的依赖版本；不按 pnpm store 中的最新版本猜测，也不依赖仓库外的 node_modules 链接。
- 默认使用当前 Node，可用绝对路径 `TUD_NODE_BIN` 指定同平台、同架构的 Node >=20。暂不支持跨平台/跨架构打包。
- 使用独立应用标识 `com.juejin.jusage.desktop-tauri`，不注册 Electron 的 deep-link 协议，也不沿用参考项目的更新地址或公钥。

数据目录默认仍为 `~/.ai-usage`；可用 `TUD_DATA_DIR` 指向隔离目录。
不要同时运行两个桌面客户端；退出 Electron 后再启动 Tauri。
账号关联暂经系统浏览器 → sidecar 托管的回环面板写入配置，关联后返回 Tauri；原生 deep-link 与桌面账号状态交互在第二阶段验收。
当前同步结果由 Dashboard 现有轮询和聚焦刷新读取；原生推送与恢复提示在第三阶段完善。

## 分阶段迁移

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| 1 | Tauri 主窗口、内嵌 Dashboard、Node/Core sidecar、互斥/心跳/退出、独立构建入口 | 已实现；见下方验证记录 |
| 2 | 桌面桥能力、登录回调与账号状态、主题/窗口状态、托盘与订阅展示 | 待实现 |
| 3 | 桌宠、通知、同步推送、崩溃恢复与恢复提示 | 待实现 |
| 4 | Windows/Linux 验收、签名/公证、更新源、安装包与发布流程 | 待实现 |

每阶段继续在当前迁移分支和 Draft PR 交付，单独记录验收结果。
迁移期间保留 Electron，完成平台与功能验收后再讨论替换。

第一阶段验证：Node 运行时/API/桥接/依赖准备测试、Rust 路径限制测试和 macOS arm64 原生 `.app` 构建。
尚未完成真实账号登录、真实采集/上报与跨平台 GUI 验收；本阶段产物供开发验证。

## 参考实现

参考仓库：https://github.com/you-want/juejin-usage-tauri ，提交 `303aaf2127bc2adbf9b614efc10c9bd644de0d42`（MIT）。
本地参考 submodule 位于 `.references/juejin-usage-tauri`，其 gitlink 和 `.gitmodules` 不进入提交。
Node runtime 参考其 sidecar 结构，按当前 Core 能力适配；未引入参考实现的 Rust API 引擎、desktop-ui、桌宠和更新配置。
构建和运行不依赖参考 submodule，新克隆本仓库无需下载它。
