# @juejin-opensource/jusage-core

## 1.1.1

### Patch Changes

- 修复已安装 T3 Code Beta 桌面客户端或官方 `t3` 命令时，运行工具列表仍显示未安装的问题。
- 新增多款工具自动接入，补齐模型展示名称与已知能力、上下文限制；优化托盘工具排序、代理开关与底部模型选择面板，减少展开和切换卡顿；补充 T3 Code 深浅主题图标，并将 Trae 国内版、国际版额度和显示设置独立展示。

## 1.1.0

### Minor Changes

- 内置定价补充 Claude Fable 5.2、Gemini 4 Carbon、Muse Ember 等最新 models.dev 官方渠道费率（含缓存价）。
- 网关支持自定义 API 供应商、局域网共享与空模型目录补全；凭据库仍由桌面宿主提供包装密钥，改为本地数据目录文件后开发版与正式版可共用。
- 修复 DSH Desktop 自定义数据目录及 Beta 版会话无法被发现和统计的问题，CLI 与桌面客户端均可采集这些目录中的 Token 用量。
- 限制 Codex 增量去重键的保留数量，避免 `cursors.json` 随历史会话持续增长。
- 限制 ZCode 增量消息快照的保留数量，避免 `cursors.json` 随历史请求持续增长。
- Accept the Anthropic SDK's `?beta=true` on the gateway Messages endpoint so Claude Code does not report a configured model as unavailable before inference. Preserve authentication and reject unrelated query parameters.
- Enable client-side tool discovery by default, translate Messages deferred tool references across protocols, and migrate owned search preferences while preserving user settings.
- 修复 Claude Code 转发至 HY4 等第三方模型时的 400：跨协议转换仅移除可识别的 SDK 计费系统块，保留用户指令及原生 Messages 请求。Claude CLI、VS Code 和临时会话接入改用完整工具定义，受管理的工具搜索偏好可在移除接入时恢复。桌面网关记住显式开关状态，重载后恢复监听；启动状态写入失败时保留已运行的网关。
- 支持 Responses 客户端工具搜索、搜索结果动态加载函数与自由文本工具，以及 developer additional_tools 历史。保留执行归属、命名空间、调用 ID 和参数绑定，修复工具名与参数同时分片时的类型误判，并补充三轮 HTTP 和真实上游验收。
- 新增 CodeArts Agent 数据源：读取 ~/.codeartsdoer/codearts-data/opencode.db 的本地消息记录统计 token 用量，桌面端、CLI 与本地面板同步支持。
- 支持 Codex Responses 自由文本工具与命名空间工具向其他上游协议转发，保留原始输入、调用 ID、命名空间和流式完成事件。修复 WorkBuddy 拒绝 Codex developer 指令角色导致的 400，并补充真实 Codex apply_patch 闭环检查脚本。
- 修复 Claude Code 转发至 Codex 订阅模型的请求与流式兼容：仅在订阅适配器内将显式 system 输入项转换为 developer，保持指令顺序、工具历史和原生状态；字符串输入转换为消息数组。将成功 SSE 的响应类型统一为 text/event-stream，避免上游误标 application/json 后被当作 JSON 解析，HTTP 失败仍保持原状态与响应类型。
- 修复 Codex VS Code 会话通过 WorkBuddy 返回 HTTP 400：抽取可复用的固定客户端身份兼容函数，兼容已实测触发拒绝的 Codex 身份介绍，保留后续完整指令、文本块、用户消息与工具定义。
- 打开应用时不再主动弹出 Cursor 钥匙串授权：首次在 Cursor 用量卡片点击刷新并授权后，之后打开应用会自动显示额度，无需再次授权或手动刷新。
- 将 DeepSeek Harness 从手动引导升级为直接接入：自动写入各 profile 的自定义供应商、默认模型及 Harness 凭据存储，支持桌面启动脚本中的实际数据目录、密钥和模型同步、外部修改保护与可撤销恢复。工具详情使用「接入网关」，保留 Claude Desktop 的手动引导。
- 修复旧版桌面 CLI 启动脚本遮蔽官方 DeepSeek Harness 共享数据目录的问题。同一工具接入同时配置已初始化的官方桌面 profile 和旧 CLI 目录，保留各目录的凭据格式与撤销备份，避免模型仅写入另一个安装实例。
- 修复 Codex 累计用量先写入 token、后补时间戳时可能漏记完整用量的问题。
- Add a local AI gateway in the Tauri desktop client with provider authorization, model routing, usage history, and AI tool configuration. Refresh shared dashboard controls and typography. Discover Codex sessions from explicit environment roots or the default home directory.
- Recognize Gemini streaming text, tool calls, inline media and terminal candidates when preparing gateway replies, preventing valid responses from being rejected as empty streams.
- 新增与供应商无关的网关内置搜索执行层，统一四种客户端协议的搜索声明、执行循环、来源结果和历史回放，避免 Codex 通过 Chat/Messages/Gemini 上游时仅因携带 web_search 就触发协议转换错误。保留原生直通及客户端自定义工具，搜索后端不可用时如实返回工具失败结果。
- Add Antigravity OAuth, OpenCode Go and Volcengine gateway providers. Expose account-specific model capabilities, context limits and billing metadata, and improve Trae authentication and quota reporting.
- Archive local gateway request details, converted provider calls, upstream errors and streamed responses with credential redaction, bounded retention and a request log viewer.
- 网关模型目录与工具接入使用固定短别名，隐藏供应商 UUID，保留旧长 ID 调用兼容。多账号自动分配并持久化独立别名，迁移已有模型选择且保留配置备份；已知 Claude 模型使用易读显示名称。
- 新增独立 Grok Bot 订阅额度卡片，从本机客户端当前账号读取每周额度和试用到期时间，无需安装 Cursor。支持 macOS 手动授权钥匙串及 Windows 本机加密凭据读取；登录或网络异常时显示提示。
- 修复官方 DeepSeek Harness 桌面端经 WorkBuddy 转发返回 400 的兼容问题。仅将 Harness 内置的路径引用、实现目录和 Web GUI 身份说明转换为语义等价的说明，保留完整指令、工作目录、用户消息和工具定义；自定义系统提示不做泛化替换。
- DeepSeek Harness 接入优先使用 Claude Messages 和 OpenAI Responses，修正 Messages 地址拼接，并同步两条供应商的凭据、模型与默认选择。
- 统一协议优先级为 Anthropic Messages、OpenAI Responses、Chat Completions。ZCode、OpenCode、Pi 和 MiniMax Code 默认使用 Messages，OpenCode 临时启动配置同步调整；Codex 保留 Responses，Gemini 保留原生协议。新增供应商按已声明支持的协议选择，现有上游协议不自动更改。支持已管理 Chat 配置事务升级及撤销恢复。
- 同步 models.dev 官方渠道价格：新增 GPT-6.1 Terra 与 Mistral Large 4 0.8 定价，更新 Mistral Large 4 的输入、输出及缓存读取价格，让相关模型的用量费用估算使用最新费率。
- 增加 Gemini 原生网关协议、模型目录与精确计数转发，支持 Gemini CLI 安装探测及可回滚的用户配置接管。跨协议工具调用通过有界内存映射保留原生签名、密文推理和调用 ID，校验账户、模型及参数归属；补充特性头兼容与缓存写入用量明细，对无法转换的能力返回明确错误。
- 补齐第三方 Responses 的客户端工具搜索适配及原生 JSON/SSE 转换，保留自定义工具、托管工具、加密推理、原始 ID 和扩展字段。修复原生 SSE 直通缺少终结事件仍被视为成功、压缩流未检查以及后续大帧被前缀预算误拒绝的问题。
- 修复添加 OpenCode Zen Free 时公共模型目录超过 4 MiB 导致 SUBSCRIPTION_RESPONSE_TOO_LARGE 的问题。仅为该公共目录设置 16 MiB 读取上限，其他订阅响应保留原有限制；超过上限仍取消读取。
- 新增 PI-Desktop 用量采集：读取本地 pi.sqlite 的 turns 记录，按模型与项目统计 token（含缓存读取、推理 token），在面板中显示为独立来源 `pi-desktop`。
- 同步反馈区分本地采集完成、云端上报完成、待补报、上报失败及未上报状态，避免云端未更新时仍提示同步成功。
- Qoder 各额度池统一显示剩余百分比，并补充 macOS 钥匙串始终允许的授权提示。
- 简化运行工具卡片，将默认模型放在状态右侧并使用 26px 设置按钮。配置外部变更时暂停自动同步，在详情提供重新接入，撤销时恢复重新接入前的外部配置。
- 将 Runtimes 显示名称改为「运行工具」，独立展示 Claude Desktop，并添加 DeepSeek Harness。本机探测支持 dsh 可执行程序与 Harness 桌面应用；提供官方自定义模型 API 的连接参数复制和手动配置引导，记录保持手动配置状态，不声明连接已验证。
- Add a Runtime tool picker with default model selection, compact integration cards, and reversible configuration for MiniMax Code, Pi, and the Claude Code VS Code extension alongside Claude Code, Codex, ZCode, and OpenCode. Add guided Claude Desktop setup without modifying its configuration or claiming a verified connection.

  Display local tool cards in a responsive grid with three full-width columns on desktop, two on smaller windows, and one on narrow screens. Label the entry “添加本地工具”.

  Match the local tool picker to the compact supplier picker and distinguish installed tools from leftover configuration. Detect executable CLIs, valid desktop app bundles and VS Code extension manifests, with cached login-shell PATH discovery and explicit refresh. Keep uninstalled integrations removable.

- 区分本机模型目录缺失与上游限流、额度或容量拒绝，仅转发经过白名单校验的原因码及重试时间。修复订阅流提前断开仍补结束标记的问题；正确处理 Google RPC 流内错误码与安全拦截，避免将失败记录为成功。
- Read Trae international account usage and subscription allowances from its existing IDE login without a conversation database key. Show account-wide snapshots locally, avoid duplicate collection and device uploads, and preserve the last successful usage snapshot when remote collection fails.
- 修复交互式 Claude Code 项目会话转发 HY4 时仍返回 400 的问题：WorkBuddy 适配器仅将已知客户端固定身份前缀转为通用编码助手身份，保留其余完整系统指令、工具定义及用户内容。跨协议计费元数据解析兼容扩展字段。验收补充真实交互终端、原项目配置和完整工具列表。

## 0.1.16

### Patch Changes

- 修复新版 Cursor 加密登录态后本机订阅额度卡与用量同步读不到的问题：兼容 `cursor-safe-storage` 密文与旧版明文 JWT（macOS 钥匙串 / Windows DPAPI / Linux peanuts·钥匙环），并正确展示 Premium 周额度。
- 修复 Every Code 累计用量先写入 token、后补时间戳时可能漏记完整用量的问题。
- 从 models.dev 同步最新官方渠道模型价格，新增 5 条模型定价并更新 52 条已有定价及缓存费率。
- 减少未变化游标保存时的临时内存分配。Tauri 托盘面板改为首次打开时创建，隐藏两分钟后释放；增加可选的同步阶段内存记录，便于排查资源占用。
- Electron 与 Tauri 共用桌宠同步反馈计算，统一新增用量、今日新高和连续使用天数。Tauri 补齐同步气泡样式、精确值提示、用量数字过渡，以及同步、点击和拖动之间的切换行为。

## 0.1.15

### Patch Changes

- 新增 DevEco Code 用量采集：读取本地 `deveco.db` 并独立统计 token。
- 线上用量面板支持生成可嵌入博客 / GitHub README 的 SVG 用量卡片，可切换样式、复制链接并管理公开展示标识。
- CLI Web 首页可展示本机各渠道订阅套餐与剩余额度，无需启动桌面端。
- 同步进度文件 `cursors.json` 改为原子写入，避免中途退出后进度丢失、需要重扫历史。
- 修复 Codex 累计快照漏算缓存输入差值导致费用偏高；修复 OpenCode / DevEco Code 先写 token、后补时间戳时可能漏记用量。
- 内置定价表同步 models.dev：补充 Gemini 4 Argon、Muse Wonder 1.0、MiniMax-M3.1-Flash、DeepSeek V4.1 Flash 1017，并为 GLM-4.5V / 4.6V 补齐缓存读取价。

## 0.1.14

### Patch Changes

- 新增 TeleAgent（中国电信星辰超级智能体）用量采集：按模型与 token 统计，半小时分桶计入面板。
- 新增 KinetAios 用量采集：读取本地 `history.db` 的 `cost_log`，token 与真实美元成本计入面板与排行榜。
- 支持 Kimi 桌面版用量采集与项目归属，可与 Kimi Code 并存并增量去重。
- 修复电脑不关机跨过零点后，昨天及连续多天没有新用量的日期在本地面板显示为 0：空同步也会补上这些日期，不必重启。
- 数据校对会展示被跳过事件的 event_id 与归属原因；按上海时区校准时不再误删跨日本地行。
- 内置定价表补充 GPT-6.1 Sol、Claude Haiku / Sonnet 5.5、Mistral Large 4 等，并更新一批现有模型价格。

## 0.1.13

### Patch Changes

- 新增 MiniMax Code 用量采集：读取本机 MiniMax Code 会话，按项目目录归属；可用 `jusage sync --source=minimax-code`（别名 `mcode` / `minimax`）。
- 新增 WPS 灵犀（WPS Comate）用量采集：读取 `~/.wpscomate` 会话日志，按工作目录归属项目。
- Command Code 用量现在会随云端同步上报；升级后首次校对可补报近 90 天存量。
- 修复 OpenCode 2.0 及之后新产生的用量没有进入统计：下次同步补齐尚未记过的模型调用与上下文压缩，已统计历史不重复计算。
- 修复 CodeBuddy 用量偏低：多轮工具调用按整轮累计 token，不再只计最后一轮。
- 修复同一时段多项目用量上报到云端时只记一部分：每次同步上报该时段全部项目合计；升级后首次同步会自动全量比对纠正少报。
- 修复应用休眠或停用多天后，已有用量日期不出现在本地面板：启动时补齐缺失的历史缓存日期。
- Cursor 用量 CSV 下载超时则跳过本轮采集，避免中断整轮同步；未登录时停止拉取账号账单，已采集历史保留。
- 收紧桌面进程匹配，避免启动时误杀 Cursor / VS Code 等带仓库名的 IDE 插件进程。
- 设置中的关联账号头像、昵称改为后台刷新，不再长期停留在过期资料。
- 内置定价表补充 Claude Opus 5.5、GPT-6 Sol/Luna、小米 Mimo v2.6，并更新通义千问国内区价格。

## 0.1.12

### Patch Changes

- 支持读取 CodeBuddy 桌面应用与 VSCode / Cursor 插件的用量数据，并按项目目录归属；补充腾讯 hy4-preview 定价与 codebuddy「auto」模型别名。
- Codex 会话迁入数据库后删除的历史文件用量，改为按线程账本累计总量补齐；历史文件仍在时按文件拆分，账本只补差额。
- 修复 Desktop 同步 DSH 时 `tud-sync-worker` 100% CPU 永久卡死：多帧 zstd 改用纯 JS 解码器。首次同步大体积会话可能多花约十秒，日常增量不受影响。
- 修复新版 Cline 用量无法采集：新增读取 `~/.cline/data/sessions` SDK 会话，同时保留旧版 VS Code globalStorage 逻辑。
- 修复 Hermes Agent 用量被记到「会话开始那天」：改为按最后一次活动时间归集。已写入历史不会自动重排；扩大时间范围触发全量重扫时日分布可能变化。
- 修复新版 ZCode 不再记录 token：兼容 `providerId`，并优先读取 `model_usage` 表（修正缓存 token 双倍计入）；旧版仍回退 message 表。
- 修复 zcode「总 Token」少算 reasoning：面板按五项明细求和，并自愈存量 zcode 桶。
- 修复同步撞上日志写入中途时，半截记录被跳过后永久丢失：游标停在最后一条完整记录。
- 概览卡副文案展示请求数与缓存命中率；请求数优先用本地请求证据，其余渠道回退 conversation 计数。
- 数据校对失败时，报错带上失败日期、本地事件数与服务端窗口。
- 修复 Windows 上 Claude Code `notify.cmd: command not found`；旧 hook 下次启动时自动更正。
- 内置定价表同步 models.dev 官方渠道价格，含 Grok 4.7 与近期 GLM 模型。

## 0.1.11

### Patch Changes

- 新增 AutoClaw 用量采集：读取 `~/.openclaw-autoclaw*`（或 `AUTOCLAW_STATE_DIR`）下的会话，与 OpenClaw 同格式；此前只设了 `OPENCLAW_STATE_DIR` 的用户，AutoClaw 数据无法被统计。
- AutoClaw 项目归属改为从消息里的绝对路径向上找仓库根；没有路径时沿用上一项目，最后回退到 agent 显示名。
- 修复 WorkBuddy 项目全部显示为「未知项目」：改为从会话工作目录归属项目（优先 git 仓库根目录名）；升级后会自动重扫一次历史 WorkBuddy / AutoClaw 数据。
- 新增 `jusage doctor` 诊断：排查运行环境、数据目录权限、本地数据源探测、进程锁和云端连通性，异常时给出解决指引。
- 设置中可校验本机与线上近 90 天用量是否一致，并以本地为准覆盖当前设备的差异。
- 修复 Cursor App 与 Cursor CLI 登录了不同账号时，本地用量和额度卡停止更新的问题。
- 内置定价表同步近期 Qwen 3.8 Flash、DeepSeek Flash 等官方渠道价格。

## 0.1.10

### Patch Changes

- 新增 Command Code 用量采集：读取 `~/.commandcode/projects` 下的会话 JSONL，将 token 用量计入面板与排行榜。
- 新增 QwenWork 用量采集：读取 `~/.qwenwork` 与 `~/.qwenworkcn` 会话日志，国内版/国际版一并计入。
- Codex 会扫描已配置的 profile 目录，多官方账号以及 配置管理器指定的 Codex 家目录用量都会纳入统计。
- WorkBuddy 国际版 `~/.workbuddy-ai` 与国内版一并采集；同一会话在两边镜像时只计一次。
- 修复 WorkBuddy 用量全部归到 `unknown` 项目的问题，改为按会话工作目录解析真实项目名。
- 修复 Copilot CLI 增量续读把跨轮询会话归到 `unknown`、扩大时间范围后又与真实项目重复计数的问题。
- 修复 OpenCode 会话项目名全部显示为 `unknown` 的问题。
- 修复 DeepSeek Harness 用量采集：兼容 `session.v3.jsonl.zstd` 等带版本会话文件，并支持思考模型 Token。
- `jusage sync --source` 与本地 API 的数据源参数有明确契约：`all` 等同全量；未知数据源 CLI 非零退出、API 返回 400，不再静默同步 0 条却显示成功。帮助列表补上 `dsh`。
- 统一托盘、CLI 与 Desktop 面板的卡片汇总、工具筛选和趋势比较口径；趋势改为与紧邻的等长上一周期比较，今天按昨天同期计算。
- 修复 Token 趋势「详细」视图在缓存远大于未缓存输入时把输入画成 0 的问题。
- 修复 Windows：不再依赖已移除的 `wmic` 判断本地服务占用；`AI_USAGE_*_ROOTS` 不再在盘符冒号处被切断；并发写 `config.json` 会先重试再放弃。
- 支持从共享的 `~/.ai-usage/pets` 目录发现、刷新并切换自定义 v2 桌面宠物。

## 0.1.9

### Patch Changes

- 新增 GPT-6 Astra 的官方 Token 定价，并补上缓存读取（$1 / 百万 Token）与缓存写入（$12.5 / 百万 Token）单价；命中缓存的输入 Token 不再按 0 计费，Codex 等来源的费用不再明显偏低。
- 排行榜公开榜扩到前 100，并在列表顶部置顶展示自己的真实名次。
- 修复保存设置失败后，云端同步开关等设置仍可能在运行中生效、与已保存配置不一致的问题。
- 修复后台同步或上报完成时可能覆盖刚保存的设置、重新开启云端同步的问题，并避免保存设置时回退最近同步或上报时间。
- 修复把面板时间范围从 7 天扩大到 30 / 90 天后 Token、费用和会话数被重复计算的问题：扩大范围触发的历史重扫改为用重扫结果覆盖已有数据，不再和旧数据相加；Desktop 的同步进程也会在主进程清空 cursor 后丢弃自己的缓存，保证补扫真的执行。

## 0.1.8

### Patch Changes

- 新增 DeepSeek Harness（dsh）用量采集：读取本地 `~/.dsh` 会话，按消息增量统计 token、模型与项目。
- 定价表补充 Claude Fable 5.1 与 Gemini 3.8 Flash，费用统计按最新价格计算。
- 修复项目分布把工作目录编码路径（如 `%2FUsers%2F...`）直接当标题展示的问题。

## 0.1.7

### Patch Changes

- 降低后台同步占用：解析改到独立进程，空轮询不再全量扫描，定价改为启动时拉取一次。

## 0.1.6

### Patch Changes

- 内置定价表按 models.dev 官方渠道增量同步，手工补充的模型价保留不丢。
- 定价匹配增强：Claude 模型名归一化、推理档后缀剥离，精确命中优先于 fuzzy 兜底。
- 修复 Cursor 模型被误判为 MiniMax 导致费用偏高。

## 0.1.5

### Patch Changes

- 新增 runtime 心跳与 ownership 监督，僵死 / 过期 owner 可被识别并清掉。
- `config.json` 损坏时自动备份并重建，尽量捞回登录 token 与设备 ID。

## 0.1.4

### Patch Changes

- Codex / Every Code 将 unknown 模型用量并入同期主导已知模型，减少 unknown 分桶。
- 定价覆盖层落盘缓存，启动可复用上次成功拉取的表，刷新后重建聚合缓存。
- 聚合费用统一按 8 位小数累加，避免分桶先四舍五入到分造成误差。

## 0.1.3

### Patch Changes

- 拿不到 `tud-sync-status` 水位时，历史补报按本地 90 天窗继续上报，避免队列一直 hold。

## 0.1.2

### Patch Changes

- 本地采集与上报窗口扩到 90 天；历史补报在拿不到服务端地板时留队，避免误标已上报。

## 0.1.1

### Patch Changes

- 改进 `jusage service start` 的启动就绪判断，修复 PID 时间戳误判和写盘时序导致的误超时，并增加 `/health` 兜底检查。
- 补齐排行榜相关能力所需的核心数据与配套逻辑。
- 汇总 beta 阶段的稳定性修复，并发布首个 `0.1.1` 正式版。

## 0.1.1-beta.9

### Patch Changes

- fix: `jusage service start` 不再因 PID 时间戳误判 / 写盘过晚而报超时，并以 `/health` 作为就绪兜底
- fix: cli 启动检测失败问题

## 0.1.1-beta.8

### Patch Changes

- fix: some bugs

## 0.1.1-beta.7

### Patch Changes

- fix: some bugs

## 0.1.1-beta.6

### Patch Changes

- fix: reefresh

## 0.1.1-beta.5

### Patch Changes

- feat: ranks

## 0.1.1-beta.4

### Patch Changes

- chore: update

## 0.1.1-beta.3

### Patch Changes

- fix: some bugs

## 0.1.1-beta.2

### Patch Changes

- fix: some bugs

## 0.1.1-beta.1

### Patch Changes

- chore: init

## 0.1.1-beta.0

### Patch Changes

- chore: init
