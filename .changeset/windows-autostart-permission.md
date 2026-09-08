---
'@juejin-opensource/jusage': patch
---

- Windows 下 `jusage service start` 注册开机自启因缺少管理员权限失败（0x80070005）时，给出「以管理员身份运行终端」/「改用 `jusage start` 前台运行」的明确指引，不再只抛 PowerShell 原始报错。
- 服务已在运行时补注册自启失败不再中断命令：降级为警告提示（服务运行不受影响）。
- CLI.md 补充 Windows 需在管理员终端运行以注册开机自启的说明。
