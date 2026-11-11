---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage-desktop-tauri": patch
---

修复 Claude Code 转发至 HY4 等第三方模型时的 400：跨协议转换仅移除可识别的 SDK 计费系统块，保留用户指令及原生 Messages 请求。Claude CLI、VS Code 和临时会话接入改用完整工具定义，受管理的工具搜索偏好可在移除接入时恢复。桌面网关记住显式开关状态，重载后恢复监听；启动状态写入失败时保留已运行的网关。
