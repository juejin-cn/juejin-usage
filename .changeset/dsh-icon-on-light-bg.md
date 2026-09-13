---
"@juejin-opensource/jusage-desktop": patch
"@juejin-opensource/jusage-dashboard": patch
---

修复「工具与模型用量」等白底徽章上的 DeepSeek Harness（及同类内联 SVG）渠道图标在深色模式下变成空白方块的问题：浅色底上强制使用深色填充，与 Cursor / ZCode 等单色图标一致。Desktop renderer 已同步。
