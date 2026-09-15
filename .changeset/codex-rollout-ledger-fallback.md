---
'@juejin-opensource/jusage-core': patch
---

修复 Codex 历史会话用量丢失：Codex 把会话迁进数据库后会删除对应的 rollout 文件，这些会话的 Token 从此再也统计不到；现在会回退读取 Codex 线程账本，按会话最后活跃时间补记这部分历史用量（账本只保留总量，无法还原输入 / 输出 / 缓存的拆分）。
