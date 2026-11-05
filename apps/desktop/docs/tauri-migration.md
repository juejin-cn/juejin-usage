# Electron → Tauri 过渡升级

从 Electron `0.1.16` 起，客户端会在检查更新时读取：

`https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/electron-to-tauri.json`

## 开关

仓库内默认文件 [`releases/electron-to-tauri.json`](../../../releases/electron-to-tauri.json) 为 `enabled: false`。存量用户先升到 `0.1.16`（普通 electron-updater），再打开迁移：

```bash
node apps/desktop/scripts/enable-tauri-migration.mjs \
  --version 1.0.0 \
  --arm64-dmg 'https://github.com/juejin-cn/juejin-usage/releases/download/v1.0.0/Juejin%20Usage-1.0.0-arm64.dmg' \
  --arm64-sha512 '<base64 or hex>' \
  --intel-dmg 'https://github.com/juejin-cn/juejin-usage/releases/download/v1.0.0/Juejin%20Usage-1.0.0.dmg' \
  --intel-sha512 '<base64 or hex>' \
  --win-exe 'https://github.com/juejin-cn/juejin-usage/releases/download/v1.0.0/Juejin%20Usage%20Setup%201.0.0.exe' \
  --win-sha512 '<base64 or hex>'
```

推送到会同步 Gitee 的分支后，已安装过渡版的客户端下次检查会下载对应安装包；用户点击「升级到新版客户端」后打开 DMG/Setup 并退出 Electron。

## 体验边界

- 不能静默热更；macOS 需拖入「应用程序」替换，Windows 走 NSIS 向导。
- 便携版只提示手动下载。
- 业务数据目录仍为 `~/.ai-usage`。
- 关闭迁移：把 `enabled` 改回 `false` 并推送。
