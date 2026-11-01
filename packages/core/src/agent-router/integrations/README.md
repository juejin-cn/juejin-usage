# AI 工具接入

桌面网关卡片的 DisplayPulse 按钮打开工具接入 Sheet。控制接口由桌面 host key 保护，不对推理端口开放。

| 工具 | 接入方式 | 管理文件 |
| --- | --- | --- |
| OpenCode | 自动 | `opencode.json` / `opencode.jsonc` |
| Claude Code | 自动 | `.claude/settings.json` |
| Codex | 自动 | `.codex/config.toml` 和应用数据目录中的模型目录 |
| ZCode | 自动 | `.zcode/v2/config.json`、`provider_config.json` |
| Trae IDE、Cursor IDE | 手动 | 提供地址、密钥和模型 ID 的复制入口 |
| Cursor CLI | 不支持 | 不写入配置 |

自动接入支持 macOS、Windows，识别对应的配置目录环境变量。用户在 Sheet 中启用后才写入文件，不会自动启动或重启工具。工具可能需要重新加载配置；旧版 Claude Code 可能不支持完整模型菜单。Cursor IDE 经远端服务发出的请求无法访问本机回环地址。

模型选择只控制工具的模型菜单，不是网关权限控制。默认全部跟随网关已开放且可用的模型，自定义选择固定模型 ID。端口、密钥、模型变化会同步到已接入工具；停止网关保留工具配置。关闭接入按字段撤销仍由本功能管理的值，保留工具或用户的外部修改。Codex 新增的供应商段保持完整，供已有会话使用；profile 仍引用的模型目录文件也会保留。

原配置和事务日志通过现有凭据库加密保存。写入采用临时文件与原子替换，多文件失败回滚，启动时恢复未完成事务。自动同步遇到受管理字段冲突时停止覆盖并显示错误，但不阻止取消接入。取消时跳过已变更的字段和已删除的文件；非法格式、路径风险或写入过程中的并发修改仍会中止事务。符号链接、非法配置、未知 ZCode schema 会拒绝写入。不更改工具的认证文件。

接口：`GET /agents/integrations`，`PUT /agents/integrations/:id`（`mode`、`models`、`defaultModel`），`DELETE /agents/integrations/:id`。统一前缀为 `/functions/tud-agent-router`。列表响应不包含密钥、备份或文件内容。

测试使用隔离的临时用户目录，覆盖配置格式保留、外部修改、回滚、重启恢复、模型同步及控制接口鉴权。真实工具版本和 Windows 原生运行仍需发布前人工验收。
