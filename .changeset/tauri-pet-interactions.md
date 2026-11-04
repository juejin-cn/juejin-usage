---
"@juejin-opensource/jusage-dashboard": patch
"@juejin-opensource/jusage-desktop": patch
---

修复 Tauri 桌宠菜单触发、拖动后位置保存及取消操作后漫游无法恢复的问题，恢复窗口时将完整窗口限制在当前显示器工作区内，并将用量说明改为面板当前时间范围。

桌宠点击面板与 Electron 的两行指标、紧凑数值和箭头布局对齐，并在面板时间范围变化及同步完成后刷新已打开的用量。

Tauri 桌宠配置面板与 Electron 对齐，提供形象预览、社区下载、大小与动作设置，并联动禁用未开启的配置项。
