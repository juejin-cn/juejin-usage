# @juejin-opensource/jusage-desktop

## 0.1.16

### Patch Changes

- 托盘增加用量 / 网关分页，可展开运行工具、搜索并切换默认模型，并从此添加入口配置本地运行工具。
- Electron 过渡版支持按远程开关下载并打开 Tauri 安装包（默认关闭）；正式 Tauri 与 Electron 使用相同应用标识，并提供手动触发的 stable 发版工作流。
- 修复新版 Cursor 加密登录态后本机订阅额度卡与用量同步读不到的问题：兼容 `cursor-safe-storage` 密文与旧版明文 JWT（macOS 钥匙串 / Windows DPAPI / Linux peanuts·钥匙环），并正确展示 Premium 周额度。
- 修复热力图最右侧日期格、选中描边和末尾月份文字被裁切的问题，Web、Tauri 与 Electron 同步调整。
- 统一桌宠用量气泡中的时间范围、Token 和费用标签字号，使其与用量和金额数值保持一致。
- 桌宠 Popover 加宽并为旧版阴影预留透明边距，恢复与 Electron 一致的宠物光晕和指针反馈；用量数字复用仪表盘数字组件、动画和字体。
- 修复宠物大小和动画速度滑块拖动卡顿、回跳的问题：拖动期间只更新本地数值，结束后再保存。
- 缩小桌面端产物：订阅图标直接加载实际使用的 SVG 组件，避免意外引入 Markdown/公式渲染依赖。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.16

## 0.1.15

### Patch Changes

- 新增 DevEco Code 用量采集；支持读取 Qoder App 订阅额度与资源包余额，退出或切换账号不再沿用旧额度。
- 修复 Codex 额度请求未走系统代理导致读取失败，临时网络异常后窗口聚焦可自动重试。
- Qoder Add-on 额度统一显示剩余百分比；同步进度改为原子写入，避免中途退出后进度丢失。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.15

## 0.1.14

### Patch Changes

- 订阅卡片支持手动刷新和展开详情：按额度池展示重置/到期时间、订阅等级和余额明细；DeepSeek 改为赠送与充值金额，Codex 补充积分与重置卡，Cursor 增加 Grok Bot，Qoder 支持共享与专属额度池。
- 支持 Kimi 桌面版与 Kimi Code 共用一张订阅卡片；未登录时隐藏对应来源。
- 已登录 Qoder 但读不到额度时显示原因；未安装或未登录仍隐藏卡片。
- 修复 Codex、Claude 订阅额度无法显示：失败时展示原因并保留同账号最近额度。
- 新增 TeleAgent、KinetAios 用量采集；Kimi 图标适配浅色主题，Codex 改用官方彩色图标。
- 修复跨零点后空闲日期显示为 0；数据校对会展示被跳过的事件。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.14

## 0.1.13

### Patch Changes

- 主面板和托盘新增 Copilot 套餐剩余额度、内联建议与重置时间，按本机登录账号匹配，避免多账号混用。
- 新增 MiniMax Code、WPS 灵犀（WPS Comate）用量采集；MiniMax 额度卡支持新版桌面客户端 / mcode CLI。
- 修复 ZCode 额度卡在智谱账号下不显示，并区分国内 / 国际账号；Codex 额度失败时显示原因和重试，未使用 ChatGPT 订阅时隐藏卡片。
- 修复静默启动后再打开不显示窗口，以及原生崩溃后进程卡死无法重新打开。
- 修复 Windows 便携版自动更新后变成普通安装版：便携版只提示新版本，引导到 Gitee 手动下载。
- 修复 OpenCode 2.0 新用量、CodeBuddy 整轮 token、多项目云端少报，以及休眠后缺失日期不显示。
- WorkBuddy 改用官方品牌图标。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.13

## 0.1.12

### Patch Changes

- 概览卡下方展示本机订阅额度卡片，可在设置中选择显示哪些渠道（默认开启；为空的渠道仍自动隐藏）；套餐档位与重置/到期时间展示更清晰。
- 概览卡副文案展示请求数与缓存命中率。
- 修复 Desktop 同步 DSH 时 worker 100% CPU 卡死；同步 worker 内置 5 分钟硬看门狗，卡死后自动重启。
- 支持 CodeBuddy 扩展与新版 Cline SDK 用量；修复新版 ZCode 不记 token、以及 zcode 总 Token 少算 reasoning。
- 修复 Hermes 用量日期、JSONL 半截行丢失，以及 Codex 账本补齐迁库后被删历史文件的用量。
- 数据校对失败时带上失败日期与事件数。
- 修复 Windows 上 Claude Code `notify.cmd: command not found`。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.12

## 0.1.11

### Patch Changes

- macOS 菜单栏托盘默认同时显示今日 Token 和金额，随数据同步更新；可在「应用设置」中选择仅 Token、仅金额或两者，也可关闭显示。
- 新增 AutoClaw 用量采集与项目归属；修复 WorkBuddy 项目全部显示为「未知项目」，升级后会自动重扫一次历史数据。
- 设置中新增数据校验：对比本机与线上近 90 天用量，仅校准当前设备，可以本地为准覆盖线上差异。
- AutoClaw 在「工具与模型用量」等统计图标处改用官方品牌图标。
- 修复 Cursor App 与 Cursor CLI 登录了不同账号时，本地用量和额度卡停止更新的问题。
- 修复 macOS 上开启桌面宠物后主窗口与 Dock 被隐藏、多桌面切换时宠物不跟随，以及 Cmd+Q / 托盘退出后进程仍残留的问题。
- 修复设置面板「关于」「宠物」等标签页内容被裁切、无法滚动到底的问题。
- 修复对本机已安装或应用内附带的 Codex、Claude、Grok CLI 订阅额度采集不完整的问题。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.11

## 0.1.10

### Patch Changes

- 新增 Command Code、QwenWork 用量采集与面板展示。
- 设置中可添加、自动发现并切换自定义 v2 桌面宠物，支持从共享目录一键拉取安装社区宠物。
- 桌面宠物同步新增用量后，可选提示本轮 Token、今日新高和连续活跃天数（默认关闭）。
- macOS 托盘增加本机订阅/额度卡片：Codex、DeepSeek 余额、MiniMax Code、OpenCode Go、TRAE；WorkBuddy 卡片在官方额度接口确认前不会向外发送凭据。ZCode 可从 OpenCode `auth.json` 读取备用凭据。
- 统一托盘与主面板的卡片汇总、工具筛选和趋势比较口径。
- 修复 Token 趋势「详细」视图缓存过大时把输入画成 0；修复未勾选复选框在深色模式几乎不可见，以及白底徽章上 DeepSeek Harness 图标变空白。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.10

## 0.1.9

### Patch Changes

- 发现新版本后自动下载并尝试重启安装，不再弹窗确认，也不再提供跳过版本；重启失败或超时后恢复本地服务，可在工具栏或设置中一键「更新并重启」。
- 主题切换收敛为单个按钮，在「跟随系统 → 亮色 → 暗色」间循环；支持跟随系统并实时响应外观变化，手动选择的亮/暗主题会持久化。
- 新增 GPT-6 Astra 的官方 Token 定价，并补上缓存读取与缓存写入单价；命中缓存的输入 Token 不再按 0 计费。
- 修复保存设置失败后，云端同步开关等设置仍可能在运行中生效、与已保存配置不一致的问题。
- 修复后台同步或上报完成时可能覆盖刚保存的设置、重新开启云端同步的问题，并避免保存设置时回退最近同步或上报时间。
- 修复把面板时间范围从 7 天扩大到 30 / 90 天后 Token、费用和会话数被重复计算的问题；Desktop 同步进程也会在主进程清空 cursor 后丢弃自己的缓存。
- 修复 macOS 托盘弹窗在后台空同步后仍显示过期「最近同步」时间的问题。
- 修复 macOS 托盘用量弹窗：小时趋势最左侧横坐标被裁切；30 / 90 天范围下每日趋势横坐标被裁切或互相重叠。
- 修复同步和更新提示的关闭按钮被窗口拖拽区域遮挡、无法手动关闭的问题。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.9

## 0.1.8

### Patch Changes

- 新增 DeepSeek Harness（dsh）用量采集：读取本地 `~/.dsh` 会话，按消息增量统计 token、模型与项目。
- 桌面宠物支持右键菜单：显示主窗口、同步数据、打开设置、退出宠物。
- 桌面宠物点击后的 Token / 费用与主面板当前时间范围一致，并标明是今天还是近 7 / 30 / 90 天。
- 降低桌面宠物空闲时的内存占用：宠物窗口不再加载主面板，空闲动画不再整页重绘。
- 修复自动更新：下载时在面板显示进度；安装后未能自动重启时恢复本地服务，并提供「重启并更新」按钮手动重试。
- 定价表补充 Claude Fable 5.1 与 Gemini 3.8 Flash，费用统计按最新价格计算。
- 修复项目分布把工作目录编码路径（如 `%2FUsers%2F...`）直接当标题展示的问题。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.8

## 0.1.7

### Patch Changes

- 修复 Desktop、CLI 与 Web 面板每日趋势费用刻度被裁切，较大金额现在可完整显示。
- 修复 macOS 桌面宠物悬浮窗意外显示原生红绿灯窗口控制按钮。
- 修复设置里桌面宠物大小滑块被裁切，并在未开启「显示桌面宠物」时禁用形象、大小和跑动等参数。
- 降低桌面端后台同步时的主进程卡顿：解析改到独立进程，空轮询不再全量扫描，定价改为启动时拉取一次。
- 新增开机静默启动：开机自启时仅显示托盘、不弹主窗口。
- 托盘驻留时隐藏即销毁主窗口与宠物窗口，按需重建，降低内存占用。
- 统一 Desktop 与 Web 的设置弹窗样式。
- 手动同步后弹出成功或失败 Toast。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.7

## 0.1.6

### Patch Changes

- 用量页时间范围刷新后仍保留上次选择。
- 筛选栏补充 GitHub 仓库入口。
- 同步 core 的定价表增量更新与模型匹配增强。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.6

## 0.1.5

### Patch Changes

- 启动即独占 runtime：停掉 CLI（含自启）并强制抢占 `tud.pid`。
- 心跳 watchdog 监控 runtime；丢失 ownership 或 runtime 掉线时自动 recover。
- `config.json` 损坏可自动恢复；IPC / Dashboard 对 `LOCAL_RUNTIME_NOT_READY` 重试并提示「本地服务正在恢复」。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.5

## 0.1.4

### Patch Changes

- Codex / Every Code 将 unknown 模型用量并入同期主导已知模型；聚合费用按 8 位小数累加，避免分桶先四舍五入到分。
- 定价覆盖层落盘缓存，启动复用上次成功拉取的表，刷新后重建聚合缓存。
- 自动更新禁止降级；看板刷新 overlay 不再给卡片染色。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.4

## 0.1.3

### Patch Changes

- 拿不到 `tud-sync-status` 水位时，历史补报按本地 90 天窗继续上报，避免队列一直 hold。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.3

## 0.1.2

### Patch Changes

- 本地采集与上报窗口扩到 90 天；历史补报在拿不到服务端地板时留队，避免误标已上报。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.2

## 0.1.1

### Patch Changes

- 新增排行榜相关能力，并同步桌面端内嵌看板体验。
- 修复刷新及一批 beta 阶段积累的问题，提升桌面端稳定性。
- 升级内部依赖至 `@juejin-opensource/jusage-core@0.1.1`，整理后发布 `0.1.1` 正式版。

## 0.1.1-beta.13

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.1-beta.9

## 0.1.1-beta.11

### Patch Changes

- fix: allow the macOS updater to close windows and relaunch after installation
- fix: restore the local runtime and close-to-tray behavior if installation fails

## 0.1.1-beta.10

### Minor Changes

- feat: automatically restart and install downloaded updates
- feat: show a one-time success toast after an update completes

## 0.1.1-beta.9

### Minor Changes

- feat: show downloaded auto updates in an actionable toast and check for updates on startup
- chore: upgrade HeroUI to 3.2.4

## 0.1.1-beta.8

### Patch Changes

- test: publish a signed macOS update to verify the in-app auto-update flow

## 0.1.1-beta.7

### Minor Changes

- feat: add signed GitHub Releases auto-update flow for macOS and Windows

## 0.1.1-beta.6

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.8

## 0.1.1-beta.5

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.7

## 0.1.1-beta.4

### Patch Changes

- fix: reefresh
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.6

## 0.1.1-beta.3

### Patch Changes

- feat: ranks
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.5

## 0.1.1-beta.2

### Patch Changes

- chore: update
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.4

## 0.1.1-beta.1

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.3

## 0.1.1-beta.0

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.2
