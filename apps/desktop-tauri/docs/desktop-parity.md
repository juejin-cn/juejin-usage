# Electron 功能对齐清单

核对日期：2026-10-27。当前工作区：`feat/desktop/tauri-migration`（Node/Core sidecar）。官方基线：`juejin-cn/main@7b71ae5`；增量起点 `cda5330`。以源文件和 preload 契约检查功能，不能用“构建通过”代替原生交互验收。

## 指定同步区间

`cda5330..7b71ae5` 中修改 Electron 的提交为 `ee154f7`、`f38d87d`、`7c73ce2`、`752cad3`。变更集中在 Cursor 账号状态、密封凭据解密、Keychain 授权和手动刷新策略。Every Code 无时间戳 totals 修复为 Core 提交 `1f7e0cc`。

当前分支的 `packages/core` 和 Dashboard Cursor 卡片与 `7b71ae5` 树一致；这部分通过共享 Core 和 Dashboard 继承，不应重复移植另一套读取器。

用户提供的同步说明还包含 `todayLivePath` 和一个 `chore(sync)` 提交，但当前 Git 历史没有定位到该提交，当前 `packages/core/src/paths.ts` 也没有此符号。另一个工作树 `juejin-usage-tauri` 是 `feat/desktop/tauri-rust-core`，已具有完整 Desktop UI 迁移提交 `174c61b`，且存在未提交的 Rust local-api 工作。两条路线必须先确认目标，不能互相覆盖。

## 当前 Node sidecar 版本与 Electron 的差异

| 能力 | Electron 历史依据 | 当前 Tauri 状态 / 剩余工作 |
| --- | --- | --- |
| Cursor / Every Code | 上述同步区间 | 共享实现已一致；真实账号和平台行为待验收 |
| 原生标题栏、主题、图标 | `028ad61`、`17a46a5` / DesktopWindow | 已有标题栏、主题同步、应用与模板托盘图标 |
| 菜单栏用量和模式 | `a3b9246`、`e18f098`、`62ff99b`、`b8e243d` | 已有显示开关与模式、定时刷新；设置页入口和更及时的同步触发仍需对齐 |
| 托盘 Popover | TrayPopover / TrayPopoverView；`ced1b67` | 本轮补齐独立浮层、订阅卡、时间/渠道筛选、趋势及同步时间；原生点击与多屏待实机验收 |
| 全局时间范围 | `a2fefaa` | 浮层目前独立持久化；主面板/浮层/桌宠联动未完成 |
| 开机自启、隐藏启动 | `b7d84f0`、`d4b6683`、`1cd7eec` | 未迁移，需原生登录项注册、设置入口与隐藏启动恢复路径 |
| 图片分享剪贴板 | preload `copyImageToClipboard` | 分享页面已共享；需原生图片写入，避免依赖 WebView ClipboardItem |
| 桌宠设置 | autostart / DesktopPet | 仅内置选择、开关、拖动；缺缩放、动画帧率、漫游间隔、反馈时长与设置页 |
| 桌宠右键、点击穿透 | `2594245`、DesktopPet | 未迁移上下文菜单、透明像素穿透 |
| 本地 / 社区桌宠 | `1ecc36c`、`667eea4` | 缺包扫描、受限资源加载、目录入口、目录刷新、社区列表与安装校验 |
| macOS Spaces / 全屏 | `d6eb802`、`76619c8` | 需处理桌宠跨 Spaces 和全屏行为；保留主窗口生命周期回归 |
| 挂起检测 / 休眠恢复 | local-runtime / index powerMonitor | 已有崩溃重启和启动超时；缺就绪 API 挂起探针、恢复唤醒触发 |
| 驻留内存 | `3036949`、`7a33179`、`1cd7eec` | 目前主窗口隐藏常驻；需按需重建、事件重放与竞态控制 |
| 更新 | `55533e9` / auto-update | 已有可选签名更新准备；完成标记、异常退出及真实覆盖安装待对齐/验收 |
| 开发 mock | `edb80c1`、`a32d8bf` | 需对齐 Desktop mock 参数与运行时隔离，不能把样例状态当真实数据 |

后续按这些独立能力逐项实现、测试和记录。未通过的项目保留未完成状态；签名凭据缺失不阻止无签名开发包中的功能迁移。
