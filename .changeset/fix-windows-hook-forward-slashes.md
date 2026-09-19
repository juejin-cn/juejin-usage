---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage": patch
"@juejin-opensource/jusage-desktop": patch
---

修复 Windows 上 Claude Code 每轮结束都报 `Stop hook error: ... notify.cmd: command not found`、用量通知不触发的问题；已写入的旧 hook 会在下次启动时自动更正。
