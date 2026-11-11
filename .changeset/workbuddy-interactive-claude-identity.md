---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage-desktop-tauri": patch
---

修复交互式 Claude Code 项目会话转发 HY4 时仍返回 400 的问题：WorkBuddy 适配器仅将已知客户端固定身份前缀转为通用编码助手身份，保留其余完整系统指令、工具定义及用户内容。跨协议计费元数据解析兼容扩展字段。验收补充真实交互终端、原项目配置和完整工具列表。
