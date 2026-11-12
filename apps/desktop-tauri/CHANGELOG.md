# @juejin-opensource/jusage-desktop-tauri

## 1.1.1

### Patch Changes

- 新增多款工具自动接入，补齐模型展示名称与已知能力、上下文限制；优化托盘工具排序、代理开关与底部模型选择面板，减少展开和切换卡顿；补充 T3 Code 深浅主题图标，并将 Trae 国内版、国际版额度和显示设置独立展示。
- 修复已安装 T3 Code Beta 桌面客户端或官方 `t3` 命令时，运行工具列表仍显示未安装的问题。
- 网关供应商与运行工具默认只展示主流项，其余收进「更多」；优先展示 Claude / Codex / WorkBuddy / Grok / Trae 国内 / MiniMax 国内，以及 Claude Code / Codex / DeepSeek Harness。
- 网关配置卡片移至供应商和运行工具列表之前，便于优先查看连接设置。
- 用量托盘的自定义入口改为与主题按钮等大的编辑图标，编辑时用勾选图标完成设置。
- 托盘默认模型选择面板保持固定高度，搜索无结果或模型数量较少时也不改变面板大小。
- 移除托盘顶部重复的「添加运行工具」入口，保留工具列表内的直接接入与配置引导。

## 1.1.0

### Minor Changes

- 网关凭据加密主密钥改存 `~/.ai-usage/agent-router/vault.key`（不再日常依赖系统钥匙串）。开发版与正式版共用数据目录即可读写登录态；若本机仍有旧钥匙串条目，会自动迁移一次。
- Tauri 托盘增加用量 / 网关分页，可展开运行工具、搜索并切换默认模型，并从此添加入口配置本地运行工具。
- 网关支持自定义 API 供应商、局域网共享、端口修改与模型连通性测试；默认模型选择支持搜索筛选，自定义供应商模型名使用短别名展示。
- Accept the Anthropic SDK's `?beta=true` on the gateway Messages endpoint so Claude Code does not report a configured model as unavailable before inference. Preserve authentication and reject unrelated query parameters.
- Enable client-side tool discovery by default, translate Messages deferred tool references across protocols, and migrate owned search preferences while preserving user settings.
- 修复 Claude Code 转发至 HY4 等第三方模型时的 400：跨协议转换仅移除可识别的 SDK 计费系统块，保留用户指令及原生 Messages 请求。Claude CLI、VS Code 和临时会话接入改用完整工具定义，受管理的工具搜索偏好可在移除接入时恢复。桌面网关记住显式开关状态，重载后恢复监听；启动状态写入失败时保留已运行的网关。
- 修复 Claude Code 转发至 Codex 订阅模型的请求与流式兼容：仅在订阅适配器内将显式 system 输入项转换为 developer，保持指令顺序、工具历史和原生状态；字符串输入转换为消息数组。将成功 SSE 的响应类型统一为 text/event-stream，避免上游误标 application/json 后被当作 JSON 解析，HTTP 失败仍保持原状态与响应类型。
- 修复 Codex VS Code 会话通过 WorkBuddy 返回 HTTP 400：抽取可复用的固定客户端身份兼容函数，兼容已实测触发拒绝的 Codex 身份介绍，保留后续完整指令、文本块、用户消息与工具定义。
- 打开应用时不再主动弹出 Cursor 钥匙串授权：首次在 Cursor 用量卡片点击刷新并授权后，之后打开应用会自动显示额度，无需再次授权或手动刷新。
- 将 DeepSeek Harness 从手动引导升级为直接接入：自动写入各 profile 的自定义供应商、默认模型及 Harness 凭据存储，支持桌面启动脚本中的实际数据目录、密钥和模型同步、外部修改保护与可撤销恢复。工具详情使用「接入网关」，保留 Claude Desktop 的手动引导。
- Archive local gateway request details, converted provider calls, upstream errors and streamed responses with credential redaction, bounded retention and a request log viewer.
- Show an actionable restart message when an older local gateway service returns a plain-text 404, instead of exposing the WebView JSON parsing error. Validate gateway response envelopes before reading their data.

  Wait for sidecar resource preparation before starting Tauri with dashboard HMR, so switching branches cannot leave the new UI connected to an older gateway backend.

- Remove the gray background around gateway runtime loading placeholders.
- 网关模型目录与工具接入使用固定短别名，隐藏供应商 UUID，保留旧长 ID 调用兼容。多账号自动分配并持久化独立别名，迁移已有模型选择且保留配置备份；已知 Claude 模型使用易读显示名称。
- AI 网关兼容最新 Tauri 客户端，保留正式版更新与桌宠功能；开发时修改桌宠数字及其共享组件会重新构建客户端，避免面板已更新而桌宠仍显示旧效果。
- 新增独立 Grok Bot 订阅额度卡片，从本机客户端当前账号读取每周额度和试用到期时间，无需安装 Cursor。支持 macOS 手动授权钥匙串及 Windows 本机加密凭据读取；登录或网络异常时显示提示。
- 统一协议优先级为 Anthropic Messages、OpenAI Responses、Chat Completions。ZCode、OpenCode、Pi 和 MiniMax Code 默认使用 Messages，OpenCode 临时启动配置同步调整；Codex 保留 Responses，Gemini 保留原生协议。新增供应商按已声明支持的协议选择，现有上游协议不自动更改。支持已管理 Chat 配置事务升级及撤销恢复。
- 增加 Gemini 原生网关协议、模型目录与精确计数转发，支持 Gemini CLI 安装探测及可回滚的用户配置接管。跨协议工具调用通过有界内存映射保留原生签名、密文推理和调用 ID，校验账户、模型及参数归属；补充特性头兼容与缓存写入用量明细，对无法转换的能力返回明确错误。
- 将 Runtimes 显示名称改为「运行工具」，独立展示 Claude Desktop，并添加 DeepSeek Harness。本机探测支持 dsh 可执行程序与 Harness 桌面应用；提供官方自定义模型 API 的连接参数复制和手动配置引导，记录保持手动配置状态，不声明连接已验证。
- Add a Runtime tool picker with default model selection, compact integration cards, and reversible configuration for MiniMax Code, Pi, and the Claude Code VS Code extension alongside Claude Code, Codex, ZCode, and OpenCode. Add guided Claude Desktop setup without modifying its configuration or claiming a verified connection.

  Display local tool cards in a responsive grid with three full-width columns on desktop, two on smaller windows, and one on narrow screens. Label the entry “添加本地工具”.

  Match the local tool picker to the compact supplier picker and distinguish installed tools from leftover configuration. Detect executable CLIs, valid desktop app bundles and VS Code extension manifests, with cached login-shell PATH discovery and explicit refresh. Keep uninstalled integrations removable.

- Keep gateway startup and restart feedback visible for at least one second, and soften usage/gateway panel switches with fade transitions that respect reduced motion preferences.

  Show gateway provider skeletons during initial loading, fade in loaded content, and preserve the last confirmed gateway view during temporary refresh failures.

- 桌面打包检查使用实际随包 Core 和 Node 验证 Codex Responses 内置搜索请求通过 Chat 上游，检测缺少新协议处理代码的旧运行资源。
- 修复 macOS 安装包重试构建后，中间磁盘映像被误当成正式安装包，导致产物收集失败的问题。
- Read Trae international account usage and subscription allowances from its existing IDE login without a conversation database key. Show account-wide snapshots locally, avoid duplicate collection and device uploads, and preserve the last successful usage snapshot when remote collection fails.
- 修复交互式 Claude Code 项目会话转发 HY4 时仍返回 400 的问题：WorkBuddy 适配器仅将已知客户端固定身份前缀转为通用编码助手身份，保留其余完整系统指令、工具定义及用户内容。跨协议计费元数据解析兼容扩展字段。验收补充真实交互终端、原项目配置和完整工具列表。

## 1.0.0

### Minor Changes

- Electron 过渡版支持按远程开关下载并打开 Tauri 安装包；正式 Tauri 使用与 Electron 相同的应用标识，并提供手动触发的 stable 发版工作流。
- Tauri 客户端支持浏览器账号关联后自动更新账号状态，新增托盘入口、关闭到托盘、窗口位置恢复和原生主题同步，复用主面板的订阅卡片与渠道设置。
- 新增实验性 Tauri 客户端的主窗口和本地用量看板，保留现有 Electron 客户端。当前供开发验证，桌面完整能力与多平台发布将分阶段接入。
- 新增 macOS DMG、Windows NSIS 和 Linux deb 候选包构建与校验；内嵌 Node 改用原生 sidecar 打包，保留现有 Electron 客户端。
- Tauri 客户端新增显式配置后的更新检查与安装入口、安装包签名配置和产物校验。未配置公钥与更新源时保持禁用，现有 Electron 更新流程不变。
- Tauri 客户端新增内置桌宠、同步实时刷新、可选系统通知和本地服务崩溃重试；恢复期间显示状态并支持手动重试，保留现有 Electron 客户端。

### Patch Changes

- 开发和构建时自动准备固定版本的 Node 运行时，避免本机 Node 版本不匹配导致 Tauri 无法启动。
- 统一桌宠用量气泡中的时间范围、Token 和费用标签字号，使其与用量和金额数值保持一致。
- 桌宠 Popover 加宽并为旧版阴影预留透明边距，恢复与 Electron 一致的宠物光晕和指针反馈；用量数字复用仪表盘数字组件、动画和字体。

  macOS 桌宠显式清除原生窗口阴影缓存与不透明背景，避免气泡外围出现矩形阴影；开发模式同时监听共用宠物样式与外观配置。

  开发启动等待前端资源构建完成，避免加载上一次构建的气泡样式。

- 桌面客户端与 Beta 安装包统一显示为“Juejin Usage”，同步调整窗口、托盘和登录成功页名称；保留原应用标识、更新通道与自启注册键以兼容已安装版本。
- 桌宠漫游复用旧版 Electron 的曲线轨迹和跑步帧率，拖动时按移动方向播放跑步动画。保存配置不再重置动画或重复显示窗口，点击桌宠不抢主窗口焦点，减少闪烁和明暗切换。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.16
