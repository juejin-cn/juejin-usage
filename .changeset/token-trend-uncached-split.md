---
'@juejin-opensource/jusage-core': patch
'@juejin-opensource/jusage-dashboard': patch
'@juejin-opensource/jusage-desktop': patch
---

修复 Token 趋势「详细」视图在缓存远大于未缓存输入时把输入画成 0 的问题；日/小时构成改用未缓存输入与独立缓存列，不再二次相减或截断。
