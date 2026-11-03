---
"@juejin-opensource/jusage-dashboard": patch
"@juejin-opensource/jusage-desktop": patch
---

修复宠物大小和动画速度滑块拖动卡顿、回跳的问题：拖动期间只更新本地数值，结束后再保存，按序合并原生保存请求并忽略过期响应。Tauri 与 Electron 同步调整。
