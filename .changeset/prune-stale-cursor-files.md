---
"@juejin-opensource/jusage-core": patch
---

同步时清理父目录仍在、但日志文件已删除的 cursor 条目，避免 cursors.json 随失效路径持续膨胀。
