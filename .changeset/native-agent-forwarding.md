---
"@juejin-opensource/jusage-core": minor
"@juejin-opensource/jusage-dashboard": patch
"@juejin-opensource/jusage-desktop": patch
"@juejin-opensource/jusage-desktop-tauri": patch
---

增加 Gemini 原生网关协议、模型目录与精确计数转发，支持 Gemini CLI 安装探测及可回滚的用户配置接管。跨协议工具调用通过有界内存映射保留原生签名、密文推理和调用 ID，校验账户、模型及参数归属；补充特性头兼容与缓存写入用量明细，对无法转换的能力返回明确错误。
