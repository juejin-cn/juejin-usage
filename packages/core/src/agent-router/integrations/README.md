# AI 工具接入

「运行工具」卡片右上角「添加本地工具」打开工具选择弹窗，选择工具和默认模型后确认接入。卡片只展示已添加工具、状态与同行默认模型；右侧 26px 图标按钮打开设置，可修改模型或移除接入。配置错误详情仅在设置中展示。控制接口由桌面 host key 保护，不对推理端口开放。

| 工具 | 接入方式 | 管理文件 |
| --- | --- | --- |
| OpenCode | 自动 | `opencode.json` / `opencode.jsonc` |
| Claude Code 终端 | 自动 | `.claude/settings.json` |
| Claude Code VS Code 扩展 | 自动 | VS Code 用户 `settings.json`，仅管理网关环境变量和默认模型 |
| Claude Desktop | 手动引导 | 仅保存引导记录，不修改应用配置或验证连接 |
| DeepSeek Harness | 自动 | 各 profile 的 `cordis.patch.yml`、home 覆盖层、`.credentials.yaml` 和 `.env` |
| MiniMax Code | 自动 | `~/.minimax/config.yaml` 的 `custom_provider.jusage` 与 `defaultModel` |
| Pi | 自动 | `~/.pi/agent/models.json` 和 `settings.json` |
| Codex | 自动 | `.codex/config.toml` 和应用数据目录中的模型目录 |
| ZCode | 自动 | `.zcode/v2/config.json`、`provider_config.json` |
| Trae IDE、Cursor IDE | 手动 | 提供地址、密钥和模型 ID 的复制入口 |
| Cursor CLI | 不支持 | 不写入配置 |

自动接入支持 macOS、Windows，识别对应的配置目录环境变量，包括 `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` 和 `PI_CODING_AGENT_DIR`。首期不管理 MiniMax 多 profile、VS Code profiles、远程扩展和项目级覆盖。用户在弹窗确认后才写入文件，不会自动启动或重启工具。工具可能需要重新加载配置；旧版 Claude Code 可能不支持完整模型菜单。Cursor IDE 经远端服务发出的请求无法访问本机回环地址。

模型选择只控制工具的模型菜单，不是网关权限控制。默认全部跟随网关已开放且可用的模型，自定义选择固定模型 ID。端口、密钥、模型变化会同步到已接入工具；停止网关保留工具配置。关闭接入按字段撤销仍由本功能管理的值，保留工具或用户的外部修改。Codex 新增的供应商段保持完整，供已有会话使用；profile 仍引用的模型目录文件也会保留。

原配置和事务日志通过现有凭据库加密保存。写入采用临时文件与原子替换，多文件失败回滚，启动时恢复未完成事务。自动同步遇到受管理字段冲突时停止覆盖并显示错误，但不阻止取消接入。取消时跳过已变更的字段和已删除的文件；非法格式、路径风险或写入过程中的并发修改仍会中止事务。符号链接、非法配置、未知 ZCode schema 会拒绝写入。不更改工具原有登录凭据；Harness 仅管理网关供应商的凭据项。MiniMax YAML 使用文档节点编辑保留注释，遇到重复键、别名或未知标签时拒绝修改；VS Code 按环境变量名称管理数组项，保留其他环境变量。

接口：`GET /agents/integrations`，`PUT /agents/integrations/:id`（`mode`、`models`、`defaultModel`），`DELETE /agents/integrations/:id`。统一前缀为 `/functions/tud-agent-router`。列表响应不包含密钥、备份或文件内容。

测试使用隔离的临时用户目录，覆盖配置格式保留、外部修改、回滚、重启恢复、模型同步及控制接口鉴权。真实工具版本和 Windows 原生运行仍需发布前人工验收。

Claude 桌面应用在 Developer → Configure Third-Party Inference 中配置 Gateway、Static API key、Bearer 和网关根地址，工具详情提供密钥与模型配置复制。模型 ID、桌面版本及组织策略可能影响可用性，需在 Claude 内发送消息验证。引导记录状态始终为 `manual`，不参加地址、密钥或模型的自动同步。参考：https://code.claude.com/docs/en/llm-gateway-connect#desktop-app

`connected` 表示受管理配置与已写入值一致且网关正在运行，不代表已向真实工具发送测试消息。工具模型菜单可能受工具版本和项目配置覆盖影响，默认模型写入后需重新加载或新建会话。

本机安装探测只接受可执行文件、带可执行入口的桌面应用或有效且未标记移除的 VS Code 扩展 manifest，不使用配置文件或历史数据目录作为安装证据。CLI 先检查进程 PATH 与用户级 npm、pnpm、原生安装目录；未命中时补查登录 shell 的 PATH，以覆盖 GUI 启动时缺少的 nvm/fnm 等目录。登录 shell 查询有 2 秒超时和 60 秒缓存，手动刷新 `GET /agents/integrations?refresh=1` 会清除该缓存。探测不执行 Agent CLI，也不检查登录账户或付费状态。`installation` 返回 `kind` 与本机路径；工具卸载后保留接入记录并显示未安装，仍可撤销配置。

探测方法参考 Multica 的可执行程序优先、登录 shell PATH 补查和缓存设计：https://github.com/multica-ai/multica/blob/main/server/internal/daemon/agents_probe.go


## Gemini CLI

Detects the `gemini` executable rather than the presence of an old config directory.
The managed user files are `~/.gemini/settings.json` and `~/.gemini/.env`.
The selected auth type is `gemini-api-key`; the API base is the gateway root,
with a local token and default model. Dotenv edits preserve unrelated entries,
comments, quoting and newline style; ambiguous documents are rejected.
Both files participate in the existing encrypted journal and rollback transaction.

Host environment overrides are reported by variable name only. Project `.env`
files and CLI flags can take precedence; without the client's launch directory
and command line this integration cannot verify their effective values.


Claude CLI and VS Code integrations default `ENABLE_TOOL_SEARCH` to `true`, so
MCP schemas are discovered on demand rather than filling the context upfront.
This preference has field-level user ownership: an existing value, including an
empty value, wins; later edits or deletions are retained without blocking other
managed connection fields. Old owned `false` values migrate to `true`, while a
previously overwritten user preference is restored. Disconnect removes only the
default we introduced. Ownership persists across restart in the existing encrypted
integration state; unrelated managed fields retain their conflict protection.
Disposable Claude launchers default search on and respect an explicitly supplied
`ENABLE_TOOL_SEARCH` process variable. Tool permissions and discovery execution
remain controlled by the client. Existing sessions must be reopened to pick up
launch/config changes; prior context is not rewritten.

Claude Desktop 与 Claude Code 在工具选择列表中独立展示，终端和 VS Code 扩展仍归入 Claude Code。DeepSeek Harness 使用 `deepseek-harness` 独立记录；通过 `dsh` 可执行程序或有可执行入口的桌面应用探测安装，不以 `.dsh` 残留目录判定已安装。

DeepSeek Harness 直接接入：在工具详情选择模型后「接入网关」，自动配置 `llm-pi-ai` 的 `jusage`（Claude Messages）与 `jusage-responses`（OpenAI Responses）自定义供应商和 `agent-default-model`，GPT/Codex 默认选择 Responses，其他模型默认选择 Messages；两条路径都保留完整模型目录，默认模型对新会话生效。扫描已有 profile，同时准备 web、desktop 的个人 patch；对已有的 home 覆盖层，仅更新覆盖了这两行的配置。保留其他供应商、DeepSeek 官方行和插件配置，不接管内置搜索。同步密钥、端口、模型变化，并纳入新建 profile；用户修改已管理字段时暂停自动同步，卡片显示「配置已变更」，不覆盖该修改。详情中点击「重新接入」可主动应用选择，外部修改成为新的字段恢复值；后续同步不会自动重复覆盖。移除时仅恢复仍由网关管理的字段，并保留无关字段的外部修改。

密钥通过 `JUSAGE_GATEWAY_KEY` 引用，写入 Harness 凭据存储及 CLI 读取的 `.env`。支持旧版桌面端的平铺格式和新版 version 1 格式（`refs` 与两个供应商的 API key record）；参考已有存储和已安装的凭据解析器识别格式，不执行解析器源码。profile 不包含密钥原文。路径尊重 `DSH_HOME`；对于桌面应用生成、含字面量 `DSH_HOME` 的启动脚本，识别其实际数据目录，探测时不执行脚本。Windows、macOS 与 Linux CLI 支持直接配置。

接入使用现有加密备份和多文件事务，移除时恢复仍由网关管理的配置，并保留其他供应商、外部修改和凭据。新配置文件权限为 0600。已有手动引导记录在保存或同步时升级到自动配置。重复行 ID、别名、符号链接和不识别的凭据 schema 会在写入前拒绝。`connected` 只代表配置已同步；真实 Harness 响应需另行验证。

官方依据：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md ，profile 组合顺序：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md 。

## 模型短别名

带 UUID 的内部账号 ID 保持不变；模型目录和自动接入配置改用持久化的供应商 `alias`，如 `antigravity/claude-sonnet-4-6`。同类账号依次分配 `antigravity-2` 等名称；删除或调整账号顺序不会重命名已有别名。首次加载旧配置会保存别名，并将原文备份至 `config.json.before-model-aliases.bak`。短别名不能占用其他账号或 `auto` 路由的命名空间。

旧的 UUID 长模型 ID 仍可用于请求，凭据、健康状态、自动/手动分组成员与原生工具状态继续绑定内部账号。外部模型目录只列短 ID，并提供模型显示名称；自定义工具接入的默认模型与已选模型会按 `legacyId` 同步迁移。外部修改保护照常生效，不通过别名迁移强制覆盖用户配置。客户端缓存的模型列表需要刷新或重新加载。

## 协议优先级

可配置客户端统一采用 **Messages → Responses → Chat**。ZCode、OpenCode、Pi、MiniMax Code 的自动接入与 OpenCode 临时启动默认使用 Anthropic Messages；Codex 使用其原生 Responses，Gemini CLI 使用原生 Gemini，Harness 保留 Messages 与 Responses 两条入口。用户手动改动受管理配置时仍会阻止自动覆盖，未发生冲突的旧 Chat 接入会事务升级。

地址按客户端 SDK 拼接方式设置：OpenCode 的 `@ai-sdk/anthropic` 使用 `http://127.0.0.1:<port>/v1`，其余三个客户端的 Anthropic SDK 使用网关根地址。ZCode 的 `config.json` 中 `kind: anthropic` 与 `provider_config.json` 中 `api.type: anthropic-messages` 同步写入。

新增上游供应商也会在已声明支持的协议中按同一优先级选择，显式选择的协议及已有连接保持不变。仅支持 Chat 的上游仍使用 Chat，由网关承担转换；不能通过切换客户端协议消除上游限额或获得不存在的接口。

OpenCode 配置说明：[自定义供应商](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/providers.mdx)。

### 更多运行工具

| 工具 | 配置位置 | 使用说明 |
| --- | --- | --- |
| T3 Code | `~/.t3/userdata/settings.json`，支持 `T3CODE_HOME` | 在模型选择器选择 jusage 的 Claude Code 实例 |
| Pi | `~/.pi/agent/models.json`、`settings.json`，支持 `PI_CODING_AGENT_DIR` | 重新选择模型或开启新会话 |
| Antigravity | `~/.gemini/config/config.json` 与 `~/.antigravity/settings.json` | 桌面应用的网关模式，重启生效；不使用 Google 登录及其部分专属功能 |
| Copilot CLI | `~/.copilot/providers.json`、`settings.json` | 支持 `COPILOT_HOME`、`COPILOT_PROVIDERS_CONFIG` |
| OMP | `~/.omp/agent/models.yml`、`config.yml` | 支持已有 `.yaml`、`PI_CONFIG_DIR`、`OMP_PROFILE` / `PI_PROFILE`、`PI_CODING_AGENT_DIR` |
| Kimi Code | `~/.kimi-code/config.toml` | 支持 `KIMI_CODE_HOME`；旧版回退到 `KIMI_SHARE_DIR` / `~/.kimi` |
| Qoder CLI | `~/.qoder/settings.json`，支持 `QODER_CONFIG_DIR` | 需登录并有支持 BYOK 的套餐 |
| Grok Build | `~/.grok/config.toml`，支持 `GROK_HOME` | 接入期间关闭可能覆盖默认模型的 campaigns；移除时恢复 |

这些接入通过现有事务管理器写入配置并保存恢复点，不修改真实工具配置进行测试。模型范围缩减时撤回已取消的托管条目；移除接入时保留用户后续修改的字段。Antigravity 此处指桌面应用，不改写独立 CLI 启动器。

## 默认模型与展示目录核对

默认模型只决定新会话的初始选择，展示目录决定工具内可切换的模型。修改默认值保留原有目录；自定义目录缩小时撤回取消的受管理条目。工具内现有会话、项目配置、启动参数可能覆盖用户级默认值。

| 工具 | 默认值 | 展示目录与补充信息 |
| --- | --- | --- |
| OpenCode | `model` | `provider.jusage.models`：名称、已知上下文/输出限制、图像与推理能力 |
| Pi | `defaultProvider`、`defaultModel` | `models.json` 与 `enabledModels`：名称、上下文、输出、输入类型、推理能力 |
| OMP | `modelRoles.default` | `providers.jusage.models` 与 `enabledModels`；同 Pi 的已知信息，不修改其他任务角色 |
| Claude Code | `model`、`ANTHROPIC_MODEL`；Opus / Sonnet / Haiku 可分别映射，Subagent 可单独指定 | `modelPicker`；未指定的 tier 跟随默认模型，未指定 Subagent 时遵循客户端继承规则 |
| Claude VS Code | `claudeCode.selectedModel` 及相同的分模型环境变量 | 不假设 VS Code 支持终端的完整模型菜单 schema |
| Codex | `model_provider`、`model` | 独立模型目录：名称、已知上下文和图像输入；不推测推理档位 |
| MiniMax Code | `defaultModel` | 自定义供应商模型名称映射；清除旧默认模型的 variant/thinking/context 覆盖 |
| ZCode | `model` | 供应商名称映射与 `personalModelIds` / `modelOrder` 同步 |
| DeepSeek Harness | `agent-default-model` | 两个协议供应商均保留完整 ID/名称目录 |
| T3 Code | Claude 实例的 `ANTHROPIC_MODEL` 和三个 tier 默认值 | `customModels`；仅当前 Claude 引擎，线程内已选模型仍由 T3 管理 |
| Antigravity | `models.defaultModelId` | `models.list`；当前使用静态 ID 列表，未实现动态 `listSource` 目录 |
| Copilot CLI | `model` | 按 provider + ID 管理目录，补充名称、上下文/输入/输出限制 |
| Kimi Code | `default_model` | 名称、上下文和已知图像能力；新版补充输出限制及工具能力，旧版不写新版专用字段 |
| Qoder CLI | `model.name` 和供应商 `model` | 模型显示名称、上下文/输出限制、图像/工具能力；不猜测 thinking 档位 |
| Grok Build | `models.default` | 名称和已知上下文；不猜测 reasoning efforts |
| Gemini CLI | `model.name`、`GEMINI_MODEL` | 当前不覆盖内置模型选择器目录 |
| Claude Desktop / Trae / Cursor IDE | 手动引导 | 不自动写入受管理或加密的应用配置 |
| Cursor CLI | 不支持自动配置 | 不写入文件 |

模型元数据以账号为边界从真实目录获取，展示名称不改变模型路由 ID。没有名称时保留原始 ID，不硬编码不透明 ID 对应的商品名。后台请求去重，成功缓存五分钟，失败一分钟后重试并保留已有信息；更换连接、退出或重新登录会隔离或清除旧缓存。托盘交互不等待目录请求，后台同步会在后续周期补齐配置。缓存仅在内存中，启动后重新获取；未知能力/限制不写入，Kimi 必填上下文保留 128000 的兼容回退。

尚未实现的差异：T3 独立 Codex 引擎与用户 binary/home 设置继承、Antigravity 动态目录、OMP 旧模型文件迁移、各工具的推理档位与特定版本选项、Claude Desktop 加密配置的自动写入。它们需要独立的版本识别、迁移与恢复验证；不能把存在配置字段视为所有版本都可直接接入。
