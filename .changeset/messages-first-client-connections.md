---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage-dashboard": patch
"@juejin-opensource/jusage-desktop": patch
"@juejin-opensource/jusage-desktop-tauri": patch
---

统一协议优先级为 Anthropic Messages、OpenAI Responses、Chat Completions。ZCode、OpenCode、Pi 和 MiniMax Code 默认使用 Messages，OpenCode 临时启动配置同步调整；Codex 保留 Responses，Gemini 保留原生协议。新增供应商按已声明支持的协议选择，现有上游协议不自动更改。支持已管理 Chat 配置事务升级及撤销恢复。
