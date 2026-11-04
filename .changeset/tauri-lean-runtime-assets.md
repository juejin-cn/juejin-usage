---
"@juejin-opensource/jusage-dashboard": patch
"@juejin-opensource/jusage-desktop": patch
---

缩小桌面端产物：订阅图标直接加载实际使用的 SVG 组件，避免意外引入 Markdown/公式渲染依赖；Tauri 不再重复携带前端资源，移除运行时类型声明和无用的依赖变体，Web 专属静态资源仅在 Web 构建中保留。
