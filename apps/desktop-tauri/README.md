# Desktop Tauri

实验性 Tauri 客户端。当前完成前三阶段的基础实现：主窗口、Dashboard、Node/Core sidecar、登录回调、托盘、桌宠和运行时恢复。
现有 Electron 客户端保留在 `apps/desktop`，原有启动、构建与发布命令继续有效。

## 运行

需要 Node.js >=20、pnpm 和 Rust stable。macOS 还需 Xcode Command Line Tools。
本地在 macOS arm64 验证，CI 覆盖 macOS arm64/x64、Windows x64 和 Linux x64 候选包。真实安装与 GUI 验收仍待补。

```bash
pnpm install
pnpm dev:desktop:tauri
pnpm build:desktop:tauri
```

`dev` 和 `build` 都会先构建 Core、Node host 与 Dashboard，然后准备资源。
开发窗口与安装包统一加载内嵌前端，不依赖 Vite 开发服务器；修改源码后需重新运行。
按平台生成 macOS `.app`/DMG、Windows NSIS 或 Linux deb；产物位于 `src-tauri/target/release/bundle/`。
构建与签名/更新配置见 [发布准备说明](docs/release.md)。默认不启用更新，不自动发布；正式签名凭据尚未配置。

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

- 主窗口复用 `packages/dashboard/dist`，不复制 React 源码；Dashboard 新增受 `runtime: tauri` 标记限制的桥接，CLI/Web 行为不变。
- 桥接仅转发当前 origin 下的 `/health` 和 `/functions/tud-*`，公网请求继续使用原有 fetch。
- Node sidecar 使用相同的 local-api 契约，负责采集、缓存、同步和上报，独立定时更新 heartbeat。
- sidecar 使用 `kind: desktop` 参与 `tud.pid` 互斥。已有桌面 owner 时拒绝启动；接管 CLI 时沿用 Core 的停止/接管逻辑，并停用 CLI 开机自启。
- 正常退出通过 stdin 通知 sidecar 清理；宿主崩溃关闭 stdin 时，sidecar 也会清理并退出。超时后原生壳强制回收子进程。
- 资源准备脚本通过 externalBin 打包当前平台 Node，并复制 Core 实际解析到的依赖版本；不按 pnpm store 中的最新版本猜测，也不依赖仓库外的 node_modules 链接。
- 默认使用当前 Node，可用绝对路径 `TUD_NODE_BIN` 指定同平台、同架构的 Node >=20。暂不支持跨平台/跨架构打包。
- 使用独立应用标识 `com.juejin.jusage.desktop-tauri`，不注册 Electron 的 deep-link 协议，也不沿用参考项目的更新地址或公钥。

数据目录默认仍为 `~/.ai-usage`；可用 `TUD_DATA_DIR` 指向隔离目录。
不要同时运行两个桌面客户端；退出 Electron 后再启动 Tauri。
账号关联由原生 IPC 发起，通过一次性浏览器 ticket → 掘金线上页面 → sidecar 回环处理器写入配置，成功后通知并唤起 Tauri 窗口。
回调不再依赖浏览器面板的 React 写入；不注册 `juejin-usage://`，因此不抢占 Electron 协议。
会话有效期 10 分钟；启动 ticket 只能使用一次，回调需同浏览器的 HttpOnly 会话 Cookie，写入前消耗会话以阻止重复提交。
客户端启动、窗口聚焦、关联和取消关联时刷新账号状态；公网 Web 与 CLI 不使用这些原生事件。

主窗口与 Electron 对齐使用自定义标题栏：macOS 保留系统红黄绿按钮，Windows/Linux 显示最小化、最大化/还原、关闭按钮；标题栏支持拖动和双击最大化。
应用 PNG/ICO/ICNS 和 macOS 托盘模板图标在资源准备时从 `apps/desktop/resources` 同步，不维护独立设计。
macOS 托盘右键菜单的「菜单栏用量」可开关今日用量，选择 Token、费用或同时显示；选择持久化，每 30 秒刷新，读取失败显示不可用而不伪装为零用量。

关闭主窗口会释放其 WebView 并继续采集；从托盘或 macOS Dock 按需重建。彻底退出请使用托盘菜单的退出项。
托盘提供面板、设置、订阅渠道、立即同步和退出入口；额度仍由主面板现有订阅卡片展示，订阅菜单管理卡片可见渠道，左键点击托盘打开独立用量 Popover，右键保留原生菜单。浮层沿用 Electron 的订阅额度、时间/渠道筛选、趋势、最近同步时间和打开主面板入口，支持再次点击、失焦及 Esc 隐藏；位置按托盘所在显示器和工作区约束。Linux 不提供托盘点击事件，继续使用原生菜单入口。
窗口尺寸、位置和最大化状态由官方 window-state 插件保存；不恢复隐藏状态，避免下次启动找不到窗口。
主题选择复用 HeroUI 持久化，并同步到原生窗口，`system` 模式解除原生主题覆盖、跟随系统。
外部链接与 `window.open` 请求交给系统浏览器处理。
同步完成后经原生事件立即刷新 Dashboard 和桌宠；原有轮询与聚焦刷新继续兜底。

## 运行时恢复与桌宠

- Sidecar 异常退出后清除旧端口，以 1/2/4/8/16 秒退避自动重启，最多连续重试 5 次；只有就绪后持续运行 60 秒才重置重试预算。
- 启动 60 秒内未报告端口时回收进程并进入重试。终止失败后可在提示条或托盘中手动重试；恢复成功会刷新用量。
- 如果检测到另一个桌面客户端占有/接管 runtime，则停止自动重启，避免反复争抢。退出应用会取消退避与重启，并清理子进程。
- 恢复不会重放 API 写请求。启动期间的配置修复通知保存在原生状态中，前端显示后才确认，避免首屏或 StrictMode 吞掉通知。
- 桌宠默认关闭，在托盘「桌宠」中启用、选择 Hawking/Yoyo/Click。拖动可移动，单击看今日 Token，双击打开面板；同一运行时、同一天的新增用量显示短暂气泡。
- 复用现有 Electron 图片、布局和精灵帧 helper，在构建时转译并复制资源；没有复制 React 桌宠组件或修改原有 Electron 源码。桌宠设置支持缩放、帧率、漫游、反馈开关/时长、透明像素穿透、上下文菜单，以及本地/社区宠物扫描和安装；包校验直接复用 Electron helper。
- 桌宠开关、选择及通知开关保存在 Tauri 独立配置目录的 `desktop-ui.json`；窗口位置由 window-state 保存。关闭桌宠后销毁宠物 WebView；位置保存，跨显示器恢复会验证位置。
- 系统通知默认关闭，可在托盘开启；仅对本地服务重试耗尽/被接管，以及手动同步失败发通知，不为每次轮询打扰。实际送达由系统通知设置决定。

就绪后每 15 秒探测 API，连续 3 次失败回收并进入既有重试；休眠长间隔重置探针失败计数。

## 分阶段迁移

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| 1 | Tauri 主窗口、内嵌 Dashboard、Node/Core sidecar、互斥/心跳/退出、独立构建入口 | 已实现；见下方验证记录 |
| 2 | 桌面桥能力、登录回调与账号状态、主题/窗口状态、托盘与订阅入口 | 已实现；真实账号与原生 GUI 验收待补 |
| 3 | 基础桌宠、通知、同步推送、崩溃恢复与恢复提示 | 已实现；原生 GUI 验收待补 |
| 4 | 跨平台构建、签名/更新配置与候选产物 | 已实现发布准备；四平台矩阵复验中，实际签名/更新及 GUI 待验收 |

每阶段继续在当前迁移分支和 Draft PR 交付，单独记录验收结果。
迁移期间保留 Electron，完成平台与功能验收后再讨论替换。

验证记录：

- 第一阶段：Node 运行时/API/桥接/依赖准备测试、Rust 路径限制测试和 macOS arm64 原生 `.app` 构建。
- 第二阶段：登录回调写入真实隔离 sidecar、一次性/过期/错误回调、事件取消订阅、外部链接、原生主题/同步结果校验，以及 Dashboard 账号状态测试。
- 第三阶段：真实子进程崩溃重启与退出取消、所有权阻止重启、代次/通知确认隔离、桌宠反馈和资源编译测试。
- 第四阶段：平台安装包配置、版本同步、target/Node 架构校验、更新配置与 manifest 校验；候选包以 Actions artifacts 提供，不自动发布。
- 共享路径核对：Electron 的 `AppShell` 已通过原有 preload 接收设置/关联事件，`useTheme` 已同步原生主题；没有 `useJuejinClientLinkFlow` 同名副本。本次 Tauri 专用适配不改变 Electron 代码。
尚未完成真实账号登录、真实采集/上报与跨平台 GUI 验收；本阶段产物供开发验证。

## 参考实现

参考仓库：https://github.com/you-want/juejin-usage-tauri ，提交 `303aaf2127bc2adbf9b614efc10c9bd644de0d42`（MIT）。
本地参考 submodule 位于 `.references/juejin-usage-tauri`，其 gitlink 和 `.gitmodules` 不进入提交。
Node runtime 参考其 sidecar 结构，按当前 Core 能力适配；未引入参考实现的 Rust API 引擎、desktop-ui 或更新配置；基础桌宠直接复用本仓库现有资源。
构建和运行不依赖参考 submodule，新克隆本仓库无需下载它。

## Electron 功能对齐记录（2026-10-27）

已核对最新 `origin/main`；当前分支已包含其 Core 更新，包括 Cursor 平台凭据修复。Dashboard 复用现有订阅额度详情、筛选、分享和数据展示，不另复制渲染器。

本轮补齐自定义窗口标题栏、应用/托盘图标和菜单栏用量的显示开关、Token/费用模式选择。菜单栏用量偏好存放于 Tauri 独立配置，不改变 Electron 设置。

以本地 `main@6f6299d` 的 Desktop 功能为对齐基准，开机自启/静默启动、原生 PNG 剪贴板、桌宠设置/本地及社区安装、时间范围联动、窗口按需重建和健康探针已补实现。完整对应和实机验收边界见 [功能对齐清单](docs/desktop-parity.md)。

应用设置中的自启功能仅在 release 构建启用；开发包不注册登录项。无正式代码签名也可构建 release 开发候选包。自动更新仍需要独立的更新签名和 HTTPS feed，未配置时关闭。
