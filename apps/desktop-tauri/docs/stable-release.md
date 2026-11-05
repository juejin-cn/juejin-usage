# Tauri 正式发版（stable）

正式通道与 Beta 隔离：独立 Actions Secrets/Variables、独立更新 feed、手动触发构建并直接上传 GitHub Release。

逐步操作清单见 [stable-release-sop.md](stable-release-sop.md)。

## Actions 凭据

在仓库 **Settings → Secrets and variables → Actions** 配置。不要用 Beta 密钥顶替正式通道。

### Secrets

| 名称 | 用途 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application `.p12` 的 base64（CI 无本机钥匙串） |
| `APPLE_CERTIFICATE_PASSWORD` | p12 密码 |
| `APPLE_SIGNING_IDENTITY` | 例如 `Developer ID Application: …` |
| `APPLE_API_KEY` | Notary Key ID |
| `APPLE_API_ISSUER` | Issuer UUID |
| `APPLE_API_PRIVATE_KEY` | `.p8` **文件全文**（不是本机路径） |
| `TAURI_SIGNING_PRIVATE_KEY` | 正式通道 Tauri 更新签名私钥（建议与 Beta 分开的新密钥对） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码；未加密可空 |
| `TUD_WINDOWS_CERTIFICATE` | Windows PFX base64（建议正式版配置） |
| `TUD_WINDOWS_CERTIFICATE_PASSWORD` | PFX 密码 |
| `GITEE_TOKEN` | 同步/推清单（若脚本需要） |

Apple 公证优先使用上面的 P8 三件套；不必再配 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`（仍可作为后备）。

导出 p12（本机，结果贴进 Secret，勿提交仓库）：

```bash
base64 -i DeveloperID.p12 | pbcopy
security find-identity -v -p codesigning
```

### Variables

| 名称 | 值 |
| --- | --- |
| `TUD_UPDATER_PUBLIC_KEY` | 与正式私钥配对的公钥全文 |
| `TUD_UPDATER_URL` | `https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri/latest.json` |
| `TUD_WINDOWS_TIMESTAMP_URL` | HTTPS RFC 3161 时间戳服务（有 Windows 证书时必填） |

生成正式更新密钥（本机一次性）：

```bash
pnpm --filter @juejin-opensource/jusage-desktop-tauri exec tauri signer generate -w ~/.tauri/jusage-stable.key
# 公钥写入 Variable；私钥全文写入 Secret
```

### 与 Beta 的关系

| 正式 | Beta |
| --- | --- |
| `TAURI_SIGNING_*` + `TUD_UPDATER_*` | `TAURI_BETA_SIGNING_*` + `TUD_BETA_UPDATER_PUBLIC_KEY` |
| feed `releases/tauri/latest.json` | `releases/tauri-beta/latest.json` |
| identifier `com.juejin.tud.desktop`（与 Electron `appId` 相同） | `com.juejin.jusage.desktop-tauri.beta` |

`APPLE_*` 可与 Electron/Beta 共用同一张 Developer ID。

## 应用标识

正式包 identifier 为 `com.juejin.tud.desktop`，与 Electron [`electron-builder.yml`](../../desktop/electron-builder.yml) 的 `appId` 一致，便于 macOS 同名 `.app` 替换。业务数据仍在 `~/.ai-usage`。

## 工作流

手动运行 **Tauri stable release**（[`.github/workflows/tauri-release.yml`](../../../.github/workflows/tauri-release.yml)）：

1. 输入 `version`（如 `1.0.0`）与可选 `draft`（默认 `true`）。
2. 三端并行构建、签名/公证、归集 Electron 兼容文件名。
3. `publish` job 创建/更新 GitHub Release tag **`v${version}`**（`--latest=false`），上传安装包、更新包、`.sig`、`SHA256SUMS`。
4. Electron 过渡期保持非 Latest / 草稿，避免冲掉 Electron Latest。

本机注入版本（不 push）：

```bash
node apps/desktop-tauri/scripts/prepare-release.mjs 1.0.0
export TUD_RELEASE_CHANNEL=stable
export TUD_UPDATER_URL=https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri/latest.json
# 另配置 TUD_UPDATER_PUBLIC_KEY、TAURI_SIGNING_PRIVATE_KEY 与 Apple/Windows 签名
pnpm --filter @juejin-opensource/jusage-desktop-tauri bundle:release
```

## 发布后：更新清单与下载页

Release **公开**后用真实附件目录 URL 生成清单（草稿的 `untagged-*` URL 不可写入）：

```bash
node apps/desktop-tauri/scripts/write-stable-feed.mjs \
  /path/to/three-platform-artifacts \
  https://github.com/juejin-cn/juejin-usage/releases/download/v1.0.0 \
  1.0.0
```

将写入仓库 [`releases/tauri/latest.json`](../../../releases/tauri/README.md)；推送后确认 Gitee raw 可读。下载页优先 Gitee 安装包时，还需把同一套 DMG/EXE 同步到 Gitee Release。

## Electron → Tauri 交接

过渡版逻辑见 Electron `auto-update`；开关文件为 [`releases/electron-to-tauri.json`](../../../releases/electron-to-tauri.json)。默认 `enabled: false`，存量升到带迁移逻辑的 Electron 后再打开。
