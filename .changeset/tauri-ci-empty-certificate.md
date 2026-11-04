---
---

修复 Tauri macOS CI 将空签名环境变量当作 PKCS#12 证书导入的问题：debug 强制 ad-hoc，release 保留有效凭据及合法空密码，Apple 凭据只注入 release 构建步骤。
