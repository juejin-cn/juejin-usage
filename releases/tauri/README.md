# Tauri stable updater feed

公开清单地址（写入 Actions Variable `TUD_UPDATER_URL`）：

`https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri/latest.json`

## 发版时（推荐）

**Tauri stable release** 工作流在构建并上传 GitHub Release 后，会用三端产物签名自动生成 `latest.json`，并开 PR：

`chore/tauri-feed-X.Y.Z` → `main`

确认流程：

1. Publish GitHub Release `vX.Y.Z`（若仍是 draft）
2. 将同名安装包 / 更新包上传到 Gitee `vX.Y.Z`
3. Merge 该 PR，等 Gitee 同步 `main` 后确认 raw 返回新版本
4. 用已安装的正式客户端检查更新

未确认 Gitee 附件前不要 merge，否则客户端可能提示更新但下载失败。

## 本地兜底

工作流不可用时，汇总三端 `artifacts/` 后：

```bash
node apps/desktop-tauri/scripts/write-stable-feed.mjs \
  /path/to/artifacts-root \
  https://gitee.com/juejin-cn/juejin-usage/releases/download/v1.0.0 \
  1.0.0
```

或用 Release 里的 `.sig` 手写清单（见 `apps/desktop-tauri/docs/stable-release-sop.md` 第 7 步）。推送到会同步 Gitee 的分支后再验证 raw URL。

不要改动 `releases/latest.yml` / `latest-mac.yml`（Electron）或 `releases/tauri-beta/`。
