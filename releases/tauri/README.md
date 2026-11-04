# Tauri stable updater feed

公开清单地址（写入 Actions Variable `TUD_UPDATER_URL`）：

`https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri/latest.json`

## 生成步骤

1. 用 **Tauri stable release** 工作流打出并公开 GitHub Release `vX.Y.Z`（勿用草稿的 `untagged-*` URL）。
2. 汇总三端 `artifacts/` 目录后执行：

```bash
node apps/desktop-tauri/scripts/update-manifest.mjs \
  /path/to/artifacts-root \
  https://github.com/juejin-cn/juejin-usage/releases/download/v1.0.0 \
  1.0.0 \
  macos-windows
```

3. 将输出的 `latest.json` 放到本目录并推送到会同步到 Gitee 的分支。
4. 确认 raw URL 返回 JSON；用已安装的正式客户端检查更新。

不要改动 `releases/latest.yml` / `latest-mac.yml`（Electron）或 `releases/tauri-beta/`。
