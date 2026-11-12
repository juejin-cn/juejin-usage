# @juejin-opensource/jusage-dashboard

## 1.1.1

### Patch Changes

- 新增多款工具自动接入，补齐模型展示名称与已知能力、上下文限制；优化托盘工具排序、代理开关与底部模型选择面板，减少展开和切换卡顿；补充 T3 Code 深浅主题图标，并将 Trae 国内版、国际版额度和显示设置独立展示。
- 网关供应商与运行工具默认只展示主流项，其余收进「更多」；优先展示 Claude / Codex / WorkBuddy / Grok / Trae 国内 / MiniMax 国内，以及 Claude Code / Codex / DeepSeek Harness。
- 网关配置卡片移至供应商和运行工具列表之前，便于优先查看连接设置。
- 用量托盘的自定义入口改为与主题按钮等大的编辑图标，编辑时用勾选图标完成设置。
- 托盘默认模型选择面板保持固定高度，搜索无结果或模型数量较少时也不改变面板大小。
- 移除托盘顶部重复的「添加运行工具」入口，保留工具列表内的直接接入与配置引导。
- 移除关于页面中隐私协议与问题反馈链接的下划线。

## 1.1.0

### Minor Changes

- 网关凭据不可用时的提示改为检查本机 `~/.ai-usage` 目录权限；桌面端开发版与正式版共用本地凭据文件，不再因钥匙串授权冲突无法保存登录。
- 托盘增加用量 / 网关分页，可展开运行工具、搜索并切换默认模型，并从此添加入口配置本地运行工具。
- 网关支持自定义 API 供应商、局域网共享、端口修改与模型连通性测试；默认模型选择支持搜索筛选，自定义供应商模型名使用短别名展示。
- 新增 CodeArts Agent 数据源：读取 ~/.codeartsdoer/codearts-data/opencode.db 的本地消息记录统计 token 用量，桌面端、CLI 与本地面板同步支持。
- 支持在托盘「用量概览」逐项显示或隐藏订阅额度、费用和 Token 指标、趋势与工具/模型分布，自动记住本机选择，并可随时恢复默认显示。
- Move the gateway into a dedicated panel with compact usage/gateway navigation. Show model capabilities and account billing details, add free-model filtering, and expose gateway connection and runtime configuration as inline cards.
- 将 DeepSeek Harness 从手动引导升级为直接接入：自动写入各 profile 的自定义供应商、默认模型及 Harness 凭据存储，支持桌面启动脚本中的实际数据目录、密钥和模型同步、外部修改保护与可撤销恢复。工具详情使用「接入网关」，保留 Claude Desktop 的手动引导。
- Add a local AI gateway in the Tauri desktop client with provider authorization, model routing, usage history, and AI tool configuration. Refresh shared dashboard controls and typography. Discover Codex sessions from explicit environment roots or the default home directory.
- Archive local gateway request details, converted provider calls, upstream errors and streamed responses with credential redaction, bounded retention and a request log viewer.
- Show an actionable restart message when an older local gateway service returns a plain-text 404, instead of exposing the WebView JSON parsing error. Validate gateway response envelopes before reading their data.

  Wait for sidecar resource preparation before starting Tauri with dashboard HMR, so switching branches cannot leave the new UI connected to an older gateway backend.

- Remove the gray background around gateway runtime loading placeholders.
- 网关模型目录与工具接入使用固定短别名，隐藏供应商 UUID，保留旧长 ID 调用兼容。多账号自动分配并持久化独立别名，迁移已有模型选择且保留配置备份；已知 Claude 模型使用易读显示名称。
- 新增独立 Grok Bot 订阅额度卡片，从本机客户端当前账号读取每周额度和试用到期时间，无需安装 Cursor。支持 macOS 手动授权钥匙串及 Windows 本机加密凭据读取；登录或网络异常时显示提示。
- 统一协议优先级为 Anthropic Messages、OpenAI Responses、Chat Completions。ZCode、OpenCode、Pi 和 MiniMax Code 默认使用 Messages，OpenCode 临时启动配置同步调整；Codex 保留 Responses，Gemini 保留原生协议。新增供应商按已声明支持的协议选择，现有上游协议不自动更改。支持已管理 Chat 配置事务升级及撤销恢复。
- 增加 Gemini 原生网关协议、模型目录与精确计数转发，支持 Gemini CLI 安装探测及可回滚的用户配置接管。跨协议工具调用通过有界内存映射保留原生签名、密文推理和调用 ID，校验账户、模型及参数归属；补充特性头兼容与缓存写入用量明细，对无法转换的能力返回明确错误。
- 新增 PI-Desktop 用量采集：读取本地 pi.sqlite 的 turns 记录，按模型与项目统计 token（含缓存读取、推理 token），在面板中显示为独立来源 `pi-desktop`。
- 同步反馈区分本地采集完成、云端上报完成、待补报、上报失败及未上报状态，避免云端未更新时仍提示同步成功。
- Qoder 各额度池统一显示剩余百分比，并补充 macOS 钥匙串始终允许的授权提示。
- 简化运行工具卡片，将默认模型放在状态右侧并使用 26px 设置按钮。配置外部变更时暂停自动同步，在详情提供重新接入，撤销时恢复重新接入前的外部配置。
- 将 Runtimes 显示名称改为「运行工具」，独立展示 Claude Desktop，并添加 DeepSeek Harness。本机探测支持 dsh 可执行程序与 Harness 桌面应用；提供官方自定义模型 API 的连接参数复制和手动配置引导，记录保持手动配置状态，不声明连接已验证。
- Add a Runtime tool picker with default model selection, compact integration cards, and reversible configuration for MiniMax Code, Pi, and the Claude Code VS Code extension alongside Claude Code, Codex, ZCode, and OpenCode. Add guided Claude Desktop setup without modifying its configuration or claiming a verified connection.

  Display local tool cards in a responsive grid with three full-width columns on desktop, two on smaller windows, and one on narrow screens. Label the entry “添加本地工具”.

  Match the local tool picker to the compact supplier picker and distinguish installed tools from leftover configuration. Detect executable CLIs, valid desktop app bundles and VS Code extension manifests, with cached login-shell PATH discovery and explicit refresh. Keep uninstalled integrations removable.

- Keep date-range tab selection responsive while dashboard data updates and restore indicator animations.
- Keep gateway startup and restart feedback visible for at least one second, and soften usage/gateway panel switches with fade transitions that respect reduced motion preferences.

  Show gateway provider skeletons during initial loading, fade in loaded content, and preserve the last confirmed gateway view during temporary refresh failures.

- 修复快速切换时间范围后持续加载且无法自动刷新的问题，并合并短时间内的重复切换请求。
- 修复 Tauri 桌面端拖动窗口时，顶部筛选栏文字容易被误选中的问题。
- Read Trae international account usage and subscription allowances from its existing IDE login without a conversation database key. Show account-wide snapshots locally, avoid duplicate collection and device uploads, and preserve the last successful usage snapshot when remote collection fails.

## 0.1.16

### Patch Changes

- 修复热力图最右侧日期格、选中描边和末尾月份文字被裁切的问题，Web、Tauri 与 Electron 同步调整。
- 桌宠 Popover 加宽并为旧版阴影预留透明边距，恢复与 Electron 一致的宠物光晕和指针反馈；用量数字复用仪表盘数字组件、动画和字体。

  macOS 桌宠显式清除原生窗口阴影缓存与不透明背景，避免气泡外围出现矩形阴影；开发模式同时监听共用宠物样式与外观配置。

  开发启动等待前端资源构建完成，避免加载上一次构建的气泡样式。

- 修复宠物大小和动画速度滑块拖动卡顿、回跳的问题：拖动期间只更新本地数值，结束后再保存，按序合并原生保存请求并忽略过期响应。Tauri 与 Electron 同步调整。
- 修复 Tauri 桌面端点击“更新并重启”时，将正常停止本地服务误报为故障、短暂显示重试横幅的问题。
- Tauri 桌面端的“应用”设置对齐原 Electron 客户端：统一启动选项顺序、静默启动提示、菜单栏用量选择、更新和设备信息卡片布局。
- 缩小桌面端产物：订阅图标直接加载实际使用的 SVG 组件，避免意外引入 Markdown/公式渲染依赖；Tauri 不再重复携带前端资源，移除运行时类型声明和无用的依赖变体，Web 专属静态资源仅在 Web 构建中保留。
- 修复 Tauri 桌宠菜单触发、拖动后位置保存及取消操作后漫游无法恢复的问题，恢复窗口时将完整窗口限制在当前显示器工作区内，并将用量说明改为面板当前时间范围。

  桌宠点击面板与 Electron 的两行指标、紧凑数值和箭头布局对齐，并在面板时间范围变化及同步完成后刷新已打开的用量。

  Tauri 桌宠配置面板与 Electron 对齐，提供形象预览、社区下载、大小与动作设置，并联动禁用未开启的配置项。

- 修复 macOS Tauri 托盘浮层在显示器边界处无法弹出的问题，统一托盘圆角与原生阴影并移除边框。隐藏 Tauri 启动及恢复中的服务横幅，保留失败重试入口；将本地面板的排行榜按钮移到 GitHub 左侧，与 Electron 一致。
- Tauri 自动更新设置页与工具栏交互对齐 Electron：补充状态说明、失败 Alert、成功 toast 文案，并将更新按钮移到筛选栏最前。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.16

## 0.1.15

### Patch Changes

- 支持生成可嵌入博客 / GitHub README 的 SVG 用量卡片：多样式、链接复制、公开展示标识停用与重置。
- 新增 DevEco Code 用量展示；下载页等工具图标对齐官方品牌。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.15

## 0.1.14

### Patch Changes

- 新增 TeleAgent、KinetAios、Kimi 桌面版用量展示；Kimi 图标适配浅色主题，Codex 改用官方彩色图标。
- 同步 core：跨零点空闲日期补记、数据校对跳过事件等修复。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.14

## 0.1.13

### Patch Changes

- 新增 MiniMax Code、WPS 灵犀（WPS Comate）用量展示；WorkBuddy 改用官方品牌图标。
- 同步 core：OpenCode 2.0、CodeBuddy 整轮用量、Command Code 上报、多项目少报与缺失日期等修复。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.13

## 0.1.12

### Patch Changes

- 概览卡副文案展示请求数与缓存命中率。
- 同步 core：CodeBuddy / Cline / Hermes / ZCode / DSH / Codex 账本与 JSONL 等相关修复。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.12

## 0.1.11

### Patch Changes

- AutoClaw 在「工具与模型用量」等统计图标处改用官方品牌图标，此前借用的是 OpenClaw 图标。
- 设置中新增数据校验：对比本机与线上近 90 天用量，仅校准当前设备，可以本地为准覆盖线上差异。
- 线上用量页支持按设备筛选，多设备账号可只看指定设备的用量。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.11

## 0.1.10

### Patch Changes

- 新增 Command Code、QwenWork（含国内版/国际版）用量展示：同步源、图表与模型列表显示对应图标与品牌色。
- 下载页 Star 旁新增贡献者墙，展示「感谢掘友们的贡献支持」并链到 GitHub contributors。
- 统一卡片汇总、工具筛选和趋势比较口径；趋势改为与紧邻的等长上一周期比较，今天按昨天同期计算。
- 修复排行榜分享卡把已登录但未进前 100 的用户显示成「登录后查看」；榜外改为「100+名」，开启「隐藏自己」时不再展示个人名次。
- 修复 Token 趋势「详细」视图在缓存远大于未缓存输入时把输入画成 0 的问题。
- 修复设置里未勾选复选框在深色模式下几乎不可见；修复白底徽章上 DeepSeek Harness 等内联图标在深色模式变成空白方块。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.10

## 0.1.9

### Patch Changes

- 排行榜公开榜扩到前 100，并在列表顶部置顶展示自己的真实名次。
- 排行榜页在接口加载失败时不再误报「暂无数据」，改为显示明确错误提示并支持一键重试。
- 主题切换收敛为单个按钮，在「跟随系统 → 亮色 → 暗色」间循环，图标显示当前模式。支持跟随系统并实时响应外观变化，手动选择的亮/暗主题会持久化（桌面重启后保持，web 刷新后保持）。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.9

## 0.1.8

### Patch Changes

- 排行榜模型筛选按识别出的厂商动态分组，展示厂商图标和模型数量，并支持同时搜索厂商和模型名称。
- 线上用量页和下载页增加问题反馈入口，悬停或点击可查看微信二维码。
- 用量页与下载页展示 DeepSeek Harness 来源及官方图标。
- 修复项目分布把工作目录编码路径（如 `%2FUsers%2F...`）直接当标题展示的问题。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.8

## 0.1.7

### Patch Changes

- 修复 Desktop、CLI 与 Web 面板每日趋势费用刻度被裁切，较大金额现在可完整显示。
- 排行榜默认显示今天并记住上次选择的时间范围；下载页改为选取 Gitee 最新安装包，并展示支持的工具与 GitHub Star 入口。
- 统一 Desktop 与 Web 的设置弹窗样式。
- 手动同步后弹出成功或失败 Toast。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.7

## 0.1.5

### Patch Changes

- 个人用量页时间范围刷新后仍保留上次选择。
- 排行榜筛选下拉过长时改为内部滚动；同名模型选项去重，避免异步刷新时列表异常。
- 筛选栏补充 GitHub 仓库入口。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.6

## 0.1.4

### Patch Changes

- 同步 core 的费用精度与 unknown 模型对齐逻辑。
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

- 新增排行榜相关页面与配套交互，完善看板侧的展示能力。
- 修复刷新与一批 beta 阶段暴露的界面问题，提升日常使用稳定性。
- 升级内部依赖至 `@juejin-opensource/jusage-core@0.1.1`，整理后发布首个 `0.1.1` 正式版。

## 0.1.1-beta.9

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.1-beta.9

## 0.1.1-beta.8

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.8

## 0.1.1-beta.7

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.7

## 0.1.1-beta.6

### Patch Changes

- fix: reefresh
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.6

## 0.1.1-beta.5

### Patch Changes

- feat: ranks
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.5

## 0.1.1-beta.4

### Patch Changes

- chore: update
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.4

## 0.1.1-beta.3

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.3

## 0.1.1-beta.2

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.2

## 0.1.1-beta.1

### Patch Changes

- chore: init

## 0.1.1-beta.0

### Patch Changes

- chore: init
