# macOS / Windows 测试发布 SOP

此流程产出独立的 Tauri Beta 候选包，完成验收后发布到 Gitee。候选工作流不发布 Release、不上传附件、不推送更新清单。

## 隔离边界

| 项目 | Beta 配置 |
| --- | --- |
| 应用名称 | `Juejin Usage` |
| 应用标识 | `com.juejin.jusage.desktop-tauri.beta` |
| 版本 | 显式填写 `1.1.16-beta.1` 等版本；下次升级用更高版本 |
| Release 标签 | `tauri-v1.1.16-beta.1` 等独立标签 |
| 更新清单 | `https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri-beta/latest.json` |
| 平台 | macOS arm64、macOS x64、Windows x64 NSIS |

不要修改旧版 `releases/latest.yml`、`latest-mac.yml`、`beta.yml`、`beta-mac.yml`，不要替换或删除其中引用的附件。旧 Electron SOP 中为腾配额清理旧 Release/附件的步骤不适用于本次测试。若 Gitee 空间不足，先增加容量或另选测试仓库并调整 Beta 配置，不删除旧版正在使用的产物。

这不是业务数据沙箱：默认仍使用 `~/.ai-usage` 和共用 runtime owner。首次安装、升级验收使用独立系统账号或虚拟机，不与旧客户端同时运行；不复制正式账号配置。Beta 的 identifier 继续隔离安装标识、Tauri 配置与更新通道；对外名称统一为 `Juejin Usage`，不再以产品名区分 Beta。macOS 的新安装包为 `Juejin Usage.app`，与 Electron 同名，不支持在同一目录并排存放；旧 Beta 的原目录仍可通过自动更新原位升级。不承诺隔离所有采集源或系统副作用。

## 凭据准备

在 GitHub 仓库 Actions 中配置，不把凭据提交到仓库或粘贴到聊天。

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `APPLE_CERTIFICATE` | 带私钥的 Developer ID Application P12 的 base64 |
| Secret | `APPLE_CERTIFICATE_PASSWORD` | P12 密码 |
| Secret | `APPLE_SIGNING_IDENTITY` | Developer ID Application 身份全名 |
| Secret | `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 公证账号、应用专用密码、Team ID |
| Secret | `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_PRIVATE_KEY` | 可替代上一行的 P8 公证方式：Key ID、Issuer ID、P8 文件内容 |
| Secret | `TAURI_BETA_SIGNING_PRIVATE_KEY` | 专供 Beta 的 Tauri 更新私钥内容 |
| Secret | `TAURI_BETA_SIGNING_PRIVATE_KEY_PASSWORD` | 更新私钥密码，未加密可为空 |
| Variable | `TUD_BETA_UPDATER_PUBLIC_KEY` | 对应公钥内容，不能填文件路径 |
| Secret | `TUD_WINDOWS_CERTIFICATE` / `TUD_WINDOWS_CERTIFICATE_PASSWORD` | 可选 Windows PFX base64 和密码 |
| Variable | `TUD_WINDOWS_TIMESTAMP_URL` | 使用 Windows 签名时必填的 HTTPS RFC 3161 服务 |

Beta 工作流把独立的 Beta 密钥映射为 Tauri CLI 环境变量，不覆盖其他通道的 Secrets。系统签名证书可沿用旧版有效证书。Windows 若缺少系统签名证书，产物为未做 Authenticode 签名的测试包，须明确标注；Tauri 更新签名仍为必需。

本机已存在 Developer ID 身份并不代表 GitHub runner 能使用它；CI 仍需上述 P12 及公证凭据。现有 `GITEE_TOKEN` 用于元信息同步，不等于已有附件自动上传流程。

P8 方式在 Beta workflow 中写入权限为 0600 的 runner 临时文件，经 `APPLE_API_KEY_PATH` 传给 Tauri，构建后清理。P8 仅用于公证，不能替代 Developer ID 签名证书。不要把本机 P8 绝对路径作为 CI Secret：runner 无法访问开发机文件。

## 构建和归档

1. 将审核后的 Beta 流程推送至构建分支。工作流首次启用通常需要进入仓库默认分支；不要把未确认的本地修改一起提交。
2. 手动运行 **Tauri beta candidates**，选择构建分支和明确的 Beta 版本。工作流仅在临时 checkout 修改版本，不改仓库中的正式版本。
3. 三个任务都成功后，下载各自的 `tauri-beta-<version>-<target>` artifact。Actions 保留 30 天，不是永久归档。
4. 保存到仓库外的版本目录，例如 `~/Releases/jusage-tauri/1.1.16-beta.1/<target>/`，保留各目录中的 `artifacts.json`、`SHA256SUMS`、包和签名。

本机构建需在独立 release checkout 中执行，先在环境中配置常规 `TAURI_SIGNING_PRIVATE_KEY`、密码和 `TUD_UPDATER_PUBLIC_KEY`（使用同一套 Beta 密钥），以及系统签名/公证变量：

```bash
node apps/desktop-tauri/scripts/prepare-beta.mjs 1.1.16-beta.1
export TUD_RELEASE_CHANNEL=beta
export TUD_UPDATER_URL=https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri-beta/latest.json
pnpm --filter @juejin-opensource/jusage-desktop-tauri bundle:release
pnpm --filter @juejin-opensource/jusage-desktop-tauri test:packaged release
pnpm --filter @juejin-opensource/jusage-desktop-tauri artifacts release
```

原始包在 `apps/desktop-tauri/src-tauri/target/release/bundle/`；归集包在 `apps/desktop-tauri/artifacts/`。下一次构建/归集会清理对应目录，必须提前另存。macOS 两个架构分别使用匹配架构的构建机，Windows 使用 Windows 构建机。

## 发布到 Gitee

1. 先在隔离账号/虚拟机验收安装包与系统签名。macOS 正式签名候选需验收公证；Windows 标明是否有 Authenticode 签名。
2. 创建独立测试发行版 `tauri-v<version>`。上传三平台安装包、更新包及 `.sig`，不要删除任何旧版附件。macOS 自动更新使用 `.app.tar.gz`，DMG 用于首次安装；Windows 更新使用 NSIS `-setup.exe`。
3. 保持归集后的文件名，取得 Gitee 的实际 HTTPS 附件下载地址；匿名验证可下载且内容、SHA-256 与本地一致。不能假设 Gitee 使用 GitHub 的下载路径规则。
4. 用真实附件目录 URL 生成清单：

```bash
node apps/desktop-tauri/scripts/update-manifest.mjs \
  /path/to/three-platform-artifacts \
  https://实际附件下载目录 \
  1.1.16-beta.1 macos-windows
```

脚本在产物根目录生成 `latest.json`。如果附件没有共同目录，先生成清单后逐项替换 `platforms.*.url` 为真实地址，保留签名原文并重新校验三个链接。清单脚本验证产物哈希和签名文件存在，不代替客户端的密码学验签。

5. 最后只发布 `releases/tauri-beta/latest.json`，确认 Gitee raw 地址返回 JSON 而非登录页/HTML。若依靠 GitHub → Gitee 镜像，等待镜像完成后再测试。不要把安装包放入 Git 仓库。
6. 用上一 Beta 版本验证检查 → 下载验签 → 手动安装 → 重启 → 实际版本和成功提示。第一版用于首次安装，至少再构建一版才能验收覆盖升级。同时验证错误签名、损坏包、下载失败和同版本不升级。

正式签名、公证、远程下载、覆盖安装通过前，仅称为候选包；脚本测试通过不能替代这些验收。
