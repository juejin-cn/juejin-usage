---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage-desktop-tauri": patch
---

修复 Codex VS Code 会话通过 WorkBuddy 返回 HTTP 400：抽取可复用的固定客户端身份兼容函数，兼容已实测触发拒绝的 Codex 身份介绍，保留后续完整指令、文本块、用户消息与工具定义。
