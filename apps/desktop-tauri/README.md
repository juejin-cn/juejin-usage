# Desktop Tauri

实验性 Tauri 客户端。当前完成前三阶段的基础实现：主窗口、Dashboard、Node/Core sidecar、登录回调、托盘、桌宠和运行时恢复。
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

- 主窗口复用 `packages/dashboard/dist`，不复制 React 源码；Dashboard 新增受 `runtime: tauri` 标记限制的桥接，CLI/Web 行为不变。
- 桥接仅转发当前 origin 下的 `/health` 和 `/functions/tud-*`，公网请求继续使用原有 fetch。
- Node sidecar 使用相同的 local-api 契约，负责采集、缓存、同步和上报，独立定时更新 heartbeat。
- sidecar 使用 `kind: desktop` 参与 `tud.pid` 互斥。已有桌面 owner 时拒绝启动；接管 CLI 时沿用 Core 的停止/接管逻辑，并停用 CLI 开机自启。
- 正常退出通过 stdin 通知 sidecar 清理；宿主崩溃关闭 stdin 时，sidecar 也会清理并退出。超时后原生壳强制回收子进程。
- 资源准备脚本打包当前平台的 Node 和 Core 实际解析到的依赖版本；不按 pnpm store 中的最新版本猜测，也不依赖仓库外的 node_modules 链接。
- 默认使用当前 Node，可用绝对路径 `TUD_NODE_BIN` 指定同平台、同架构的 Node >=20。暂不支持跨平台/跨架构打包。
- 使用独立应用标识 `com.juejin.jusage.desktop-tauri`，不注册 Electron 的 deep-link 协议，也不沿用参考项目的更新地址或公钥。

数据目录默认仍为 `~/.ai-usage`；可用 `TUD_DATA_DIR` 指向隔离目录。
不要同时运行两个桌面客户端；退出 Electron 后再启动 Tauri。
账号关联由原生 IPC 发起，通过一次性浏览器 ticket → 掘金线上页面 → sidecar 回环处理器写入配置，成功后通知并唤起 Tauri 窗口。
回调不再依赖浏览器面板的 React 写入；不注册 `juejin-usage://`，因此不抢占 Electron 协议。
会话有效期 10 分钟；启动 ticket 只能使用一次，回调需同浏览器的 HttpOnly 会话 Cookie，写入前消耗会话以阻止重复提交。
客户端启动、窗口聚焦、关联和取消关联时刷新账号状态；公网 Web 与 CLI 不使用这些原生事件。

关闭主窗口会隐藏到托盘，采集继续运行；从托盘或 macOS Dock 可重新显示。彻底退出请使用托盘菜单的退出项。
托盘提供面板、设置、订阅渠道、立即同步和退出入口；额度仍由主面板现有订阅卡片展示，订阅菜单管理卡片可见渠道，未新增独立托盘额度浮层。
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
- 复用现有 Electron 图片、布局和精灵帧 helper，在构建时转译并复制资源；没有复制 React 桌宠组件或修改原有 Electron 源码。桌宠固定 0.5 倍、原地待机，本阶段未迁移自动漫游、透过透明像素点击、社区安装或自定义桌宠。
- 桌宠开关、选择及通知开关保存在 Tauri 独立配置目录的 `desktop-ui.json`；窗口位置由 window-state 保存。关闭桌宠后停止动画和用量请求。
- 系统通知默认关闭，可在托盘开启；仅对本地服务重试耗尽/被接管，以及手动同步失败发通知，不为每次轮询打扰。实际送达由系统通知设置决定。

本阶段不包含「进程仍存活但已就绪的 API 长时间无响应」的完整健康探针，原生 API 超时仍会反馈错误。

## 分阶段迁移

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| 1 | Tauri 主窗口、内嵌 Dashboard、Node/Core sidecar、互斥/心跳/退出、独立构建入口 | 已实现；见下方验证记录 |
| 2 | 桌面桥能力、登录回调与账号状态、主题/窗口状态、托盘与订阅入口 | 已实现；真实账号与原生 GUI 验收待补 |
| 3 | 基础桌宠、通知、同步推送、崩溃恢复与恢复提示 | 已实现；桌宠高级能力与原生 GUI 验收待补 |
| 4 | Windows/Linux 验收、签名/公证、更新源、安装包与发布流程 | 待实现 |

每阶段继续在当前迁移分支和 Draft PR 交付，单独记录验收结果。
迁移期间保留 Electron，完成平台与功能验收后再讨论替换。

验证记录：

- 第一阶段：Node 运行时/API/桥接/依赖准备测试、Rust 路径限制测试和 macOS arm64 原生 `.app` 构建。
- 第二阶段：登录回调写入真实隔离 sidecar、一次性/过期/错误回调、事件取消订阅、外部链接、原生主题/同步结果校验，以及 Dashboard 账号状态测试。
- 第三阶段：真实子进程崩溃重启与退出取消、所有权阻止重启、代次/通知确认隔离、桌宠反馈和资源编译测试。
- 共享路径核对：Electron 的 `AppShell` 已通过原有 preload 接收设置/关联事件，`useTheme` 已同步原生主题；没有 `useJuejinClientLinkFlow` 同名副本。本次 Tauri 专用适配不改变 Electron 代码。
尚未完成真实账号登录、真实采集/上报与跨平台 GUI 验收；本阶段产物供开发验证。

## 参考实现

参考仓库：https://github.com/you-want/juejin-usage-tauri ，提交 `303aaf2127bc2adbf9b614efc10c9bd644de0d42`（MIT）。
本地参考 submodule 位于 `.references/juejin-usage-tauri`，其 gitlink 和 `.gitmodules` 不进入提交。
Node runtime 参考其 sidecar 结构，按当前 Core 能力适配；未引入参考实现的 Rust API 引擎、desktop-ui 或更新配置；基础桌宠直接复用本仓库现有资源。
构建和运行不依赖参考 submodule，新克隆本仓库无需下载它。
