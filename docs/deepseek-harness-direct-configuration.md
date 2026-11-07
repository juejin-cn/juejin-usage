# DeepSeek Harness 自动接入

在「运行工具 → 添加本地工具 → DeepSeek Harness」选择模型并点击「接入网关」，自动写入连接配置。原有手动引导记录可以直接升级，Claude Desktop 仍使用自己的配置引导。

## 实现

- 在已有 profile、web 和 desktop 的 `cordis.patch.yml` 添加 `llm-pi-ai.providers.jusage`，使用 Claude Messages（`anthropic-messages`）和网关完整模型 ID，同时添加 `jusage-responses`（`openai-responses`）供应商；GPT/Codex 默认模型自动选择 Responses，其他模型默认选择 Messages，两条路径均可手动选择；设置 `agent-default-model`，对新会话生效。
- home patch 的优先级高于 profile。仅在它已有对应覆盖行时同步相关字段，保留其他供应商、插件与 DeepSeek 官方配置。
- 密钥使用独立的 `JUSAGE_GATEWAY_KEY`。兼容旧式平铺凭据库和新版 version 1 凭据库，CLI 的 `.env` 同步更新；profile 内不放密钥原文。已有凭据和受支持的安装包解析器决定存储格式，解析器仅作有界文本读取，不执行代码。
- 尊重 `DSH_HOME`，识别本机桌面 CLI 启动脚本中的字面量数据目录。探测不运行 CLI，不把残留配置目录当作已安装。
- 使用现有加密备份、冲突检测与多文件事务。可同步模型、端口、密钥和新增 profile；撤销时恢复未被外部修改的字段，保留其他凭据与供应商。重复行、别名、不支持的凭据格式和不安全写入路径会拒绝处理。

真实 CLI 验证发现 WorkBuddy 对 Harness 固定身份前缀 `You are an AI agent powered by DeepSeek Harness.` 返回 400。适配器仅替换这一明确的客户端身份句，保留其后的工作目录、完整系统指令、用户消息和工具。受控试验排除了输出预算、store、stream_options 和工具列表作为本次 400 的原因；替换固定前缀后真实请求通过。

## 验证

[脱敏结果](./deepseek-harness-direct-configuration-results.json)记录了本机真实程序验证，未保存凭据、原始请求、工具内容或供应商原始错误。

1. 核心测试 852 项，849 通过、3 跳过；面板 195 项通过；Dashboard 与 Electron 类型检查通过。
2. 使用本机安装的桌面捆绑版 Harness，在临时目录生成配置；真实 `--dump-config` 成功，能看到供应商、模型和凭据引用，不含密钥原文。
3. 真实 headless Harness 从自动生成的凭据库读取密钥，调用隔离 HTTP 测试端点，认证和模型选择正确，正常返回校验结果。
4. 通过当前桌面网关调用 WorkBuddy `hy4free`，真实 Harness 正常退出、标准输出精确匹配随机校验串，stderr 为零；撤销配置并清理临时目录。

验证未改写用户当前 Harness profile。macOS 真实程序已验证；Windows、Linux 的支持来自实现与隔离测试，未声称完成对应原生 GUI 验收。`connected` 表示配置一致，不代表任意供应商、模型或会话均已验证。

官方依据：[自定义模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)、[profile 组合顺序](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[凭据服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/credentials-local/src/index.ts)。

## 2026-11-07 协议检查

原配置固定使用 Chat Completions。改为 Messages 与 Responses 两条独立供应商，共用 `JUSAGE_GATEWAY_KEY`；Messages baseURL 去掉末尾 `/v1`，由 SDK 拼接 `/v1/messages`，Responses 保留 `/v1`。已有接入通过正常同步升级，凭据轮换与撤销覆盖两条路径。

本机只读实测：现有 key 访问模型目录返回 200；WorkBuddy `hy4free` 的 Messages 和 Responses 均返回 200，并分别收到 `message_stop`、`response.completed`。当前默认 Qoder `qmodel_38max` 在两条路径均返回 `UPSTREAM_MODEL_NOT_IN_CATALOG`（404），即使公开目录仍列出该 ID；这属于独立的上游目录可用性问题。本次没有把原始 400 的原因归结为缺失 key，也未宣称已完成 Harness GUI 会话验收。
