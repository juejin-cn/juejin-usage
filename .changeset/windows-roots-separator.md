---
'@juejin-opensource/jusage-core': patch
---

修复 Windows 下 `AI_USAGE_VSCODE_ROOTS` / `AI_USAGE_KILOCODE_ROOTS` 路径列表被盘符冒号（`C:`）劈碎的问题，Kilo Code / Roo Code 等 VS Code 系数据源在 Windows 恢复正常采集。Windows 上多个根目录请用 `;` 或 `,` 分隔；其他平台 `:` 分隔符保持兼容。
