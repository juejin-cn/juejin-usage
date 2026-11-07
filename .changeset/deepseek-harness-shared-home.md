---
"@juejin-opensource/jusage-core": patch
---

修复旧版桌面 CLI 启动脚本遮蔽官方 DeepSeek Harness 共享数据目录的问题。同一工具接入同时配置已初始化的官方桌面 profile 和旧 CLI 目录，保留各目录的凭据格式与撤销备份，避免模型仅写入另一个安装实例。
