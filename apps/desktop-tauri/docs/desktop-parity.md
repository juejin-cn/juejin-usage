# Electron 功能对齐清单

核对日期：2026-10-27。用户确认的基准为**当前仓库本地 `main@6f6299d`**，目标为当前 `feat/desktop/tauri-migration`，不修改另一 Rust core 工作树。

迁移分支已经包含官方 `7b71ae5` 的较新 Core 修复，保留这些修复；不会为了对照本地 main 而回退 Cursor 或 Every Code。此前描述中的 `todayLivePath` 不属于本地 main 的实现，不据此引入另一条迁移路线。

## 功能对应

| 本地 main 中的能力 | 历史 / 契约依据 | Tauri 实现 |
| --- | --- | --- |
| 采集、缓存、校准、订阅、上报 | Core / local-api；原 Desktop readers | 同一 Core，Node sidecar；共享 Dashboard 订阅详情与校准入口 |
| 标题栏、主题、窗口状态、外链 | DesktopWindow / preload | 自定义标题栏、系统按钮、主题跨窗口同步、窗口状态、系统浏览器 |
| 菜单栏用量与 Token/费用模式 | `a3b9246`、`e18f098`、`62ff99b`、`b8e243d` | 托盘和应用设置入口；同步触发 + 定时刷新，序号拒绝陈旧响应 |
| 托盘浮层 | TrayPopover / TrayPopoverView | 同布局的订阅卡、时间/渠道筛选、趋势、同步时间；左键开关，失焦/Esc 隐藏；按显示器工作区定位 |
| 主窗口按需重建 | `3036949`、`7a33179`、`1cd7eec` | 关闭释放主 WebView；托盘/Dock/单实例/登录重建；设置意图保留到渲染器取回；关闭最后窗口不等于退出 |
| 开机自启 / 静默启动 | `b7d84f0`、`d4b6683`、`1cd7eec` | 官方 autostart 插件，release 设置可配置；`--autostart` + 静默偏好决定是否创建主窗口；debug 不注册开发路径 |
| 图片分享剪贴板 | preload `copyImageToClipboard` | 仅写入 PNG，大小与像素边界检查，原生 clipboard 插件；不读系统剪贴板 |
| 桌宠开关/选择/拖动 | DesktopPet / preload | 内置和已安装宠物，原生拖动、位置保存、关闭释放宠物 WebView |
| 缩放/帧率/漫游/反馈设置 | autostart / DesktopPet | 同范围校验（0.35–0.75、120–320ms、1–120min、1–10s）；设置页、工作区内漫游、同步增量气泡 |
| 桌宠右键 / 点击穿透 | `2594245`、DesktopPetView | 原生上下文菜单；轮询原生鼠标位置 + 当前精灵帧 alpha 命中，透明区穿透后仍可恢复交互 |
| 本地 / 社区宠物 | `1ecc36c`、`667eea4` | 构建时直接转译 Electron 的 scanner/remote helper；目录、包校验、列表刷新、安装互斥、受限资源读取；接口必须持有宿主密钥 |
| macOS Spaces / 全屏 | `d6eb802`、`76619c8` | 宠物加入所有 Spaces / FullScreenAuxiliary；不切换整个应用激活策略 |
| 时间范围联动 | `a2fefaa` | 主面板与浮层共享 `tud.dashboardRange`；宠物点击气泡按相同范围读取日汇总；同步增量仍按同一天与同一运行时比较 |
| 运行时恢复 | local-runtime / watchdog | 子进程崩溃/启动超时重试、所有权保护；15 秒健康探针、连续 3 次失败回收；休眠长间隔不消耗失败预算 |
| 更新生命周期 | auto-update / preload | 配置更新源时启动及每 6 小时检查，签名验证后缓存下载；进度、确认安装/重启、失败恢复 sidecar、实际版本匹配的升级完成提示与确认 |

本地 main 没有后续 `a32d8bf` 的完整 Desktop mock 模式，本轮不将其列为当前基准的缺口。

## 验证与边界

- 源码实现对齐不等于原生平台验收。跨平台安装、自启注册、托盘焦点、WebView 重建、剪贴板、桌宠穿透、休眠、Spaces/全屏仍需实机检查。
- 未配置签名/更新源时更新关闭；没有执行正式代码签名、公证、真实签名下载或覆盖安装。
- Linux 不提供 Tauri 托盘点击事件，保留菜单入口；Popover 左键交互适用于 macOS/Windows。
- 原有 Electron 保留，参考 submodule 不提交。另一工作树的未提交 Rust local-api 工作未触碰。

### 本轮已执行

- Tauri Node 测试 30 项，Rust 测试 20 项，Dashboard 测试 137 项；Dashboard 构建通过。
- macOS arm64 debug 与 release `.app` 均构建成功，分别通过严格 ad-hoc 签名检查与包内运行时 5 项测试；包内测试包含带宿主密钥的宠物目录接口，确认扫描 helper 实际进入包。
- 原生 UI 已检查主窗口打开、应用/桌宠设置入口；Electron 占用 owner 时原生设置仍可见。关闭主窗口后通过桌宠双击重建成功。未改动实际自启注册或系统剪贴板内容，未执行社区网络安装。
- 完整采集 GUI 验收受到当前 Electron owner 占用限制；没有终止或抢占 Electron。
