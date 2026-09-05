---
"@juejin-opensource/jusage-core": patch
---

修复 Copilot CLI 用量的项目归属：此前只要会话跨越两次同步（超过一个轮询间隔就会发生），增量续读会把整个会话的 token 归到 `unknown` 项目；且之后扩大时间范围触发全量重扫时，同一份用量会以 `unknown` + 真实项目两行重复计数。现在项目名随文件游标持久化，续读时恢复，归属正确且重扫结果收敛。
