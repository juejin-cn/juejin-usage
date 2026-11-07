---
"@juejin-opensource/jusage-core": patch
---

修复官方 DeepSeek Harness 桌面端经 WorkBuddy 转发返回 400 的兼容问题。仅将 Harness 内置的路径引用、实现目录和 Web GUI 身份说明转换为语义等价的说明，保留完整指令、工作目录、用户消息和工具定义；自定义系统提示不做泛化替换。
