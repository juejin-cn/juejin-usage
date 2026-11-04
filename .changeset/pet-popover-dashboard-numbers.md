---
"@juejin-opensource/jusage-desktop-tauri": patch
"@juejin-opensource/jusage-desktop": patch
"@juejin-opensource/jusage-dashboard": patch
---

桌宠 Popover 加宽并为旧版阴影预留透明边距，恢复与 Electron 一致的宠物光晕和指针反馈；用量数字复用仪表盘数字组件、动画和字体。

macOS 桌宠显式清除原生窗口阴影缓存与不透明背景，避免气泡外围出现矩形阴影；开发模式同时监听共用宠物样式与外观配置。

开发启动等待前端资源构建完成，避免加载上一次构建的气泡样式。
