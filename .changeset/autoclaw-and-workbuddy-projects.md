---
'@juejin-opensource/jusage': patch
---

- 新增 AutoClaw 用量统计：读取 `~/.openclaw-autoclaw*`（或 `AUTOCLAW_STATE_DIR`）下的 `agents/*/sessions` 会话，与 OpenClaw 同格式；此前设置了 `OPENCLAW_STATE_DIR` 的用户，其 AutoClaw 数据完全无法被统计。
- AutoClaw 项目归属：从消息工具调用里的绝对路径向上找 git/构建标记仓库根（如 msgo-server），无路径时沿用会话上一项目，最后回退到 agent 显示名（读 IDENTITY.md 的 agent.name，如「代码助手」）。
- 修复 WorkBuddy 项目全部显示为「未知项目」：改为从会话 cwd 归属项目（与 Claude Code 一致，优先 git 仓库根目录名）；升级后会对历史 WorkBuddy / AutoClaw 数据自动重扫一次，旧项目行会被真实项目行替换。
