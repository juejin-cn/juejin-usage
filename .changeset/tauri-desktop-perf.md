---
"@juejin-opensource/jusage-desktop-tauri": patch
"@juejin-opensource/jusage-dashboard": patch
---

优化 Tauri 桌面客户端流畅度与窗口响应速度：关闭主窗口时先隐藏复用（闲置 15 分钟后再回收），降低 WKWebView 滚动与缩放重绘开销，并在窗口隐藏时暂停网关轮询与优化桌宠命中检测。
