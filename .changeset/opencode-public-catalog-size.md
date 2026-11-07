---
"@juejin-opensource/jusage-core": patch
---

修复添加 OpenCode Zen Free 时公共模型目录超过 4 MiB 导致 SUBSCRIPTION_RESPONSE_TOO_LARGE 的问题。仅为该公共目录设置 16 MiB 读取上限，其他订阅响应保留原有限制；超过上限仍取消读取。
