---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage-desktop-tauri": patch
---

修复 Claude Code 转发至 Codex 订阅模型的请求与流式兼容：仅在订阅适配器内将显式 system 输入项转换为 developer，保持指令顺序、工具历史和原生状态；字符串输入转换为消息数组。将成功 SSE 的响应类型统一为 text/event-stream，避免上游误标 application/json 后被当作 JSON 解析，HTTP 失败仍保持原状态与响应类型。
