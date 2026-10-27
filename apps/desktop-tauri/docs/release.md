# Tauri 候选包与发布准备

本客户端仍为实验版本。候选包与 Electron 的安装包、应用标识和标签分开维护。
工作流只上传 Actions artifacts，不创建或发布 GitHub/Gitee Release，也不推送 tag。

## 平台与产物

| Runner | Rust target | 默认产物 |
| --- | --- | --- |
| macos-latest | aarch64-apple-darwin | `.app`、DMG |
| macos-15-intel | x86_64-apple-darwin | `.app`、DMG |
| windows-latest | x86_64-pc-windows-msvc | 当前用户 NSIS 安装包 |
| ubuntu-22.04 | x86_64-unknown-linux-gnu | deb |

macOS 配置最低版本为 12；Linux 以 Ubuntu 22.04 构建环境为基线，其他发行版和显示服务仍需验收。
开发机需对应平台的 Tauri 原生依赖。CI 自动安装 Linux WebKitGTK 4.1、AppIndicator 和打包工具。
Cargo 的 release 构建依赖显式保留调试信息并禁用 strip，以规避当前 macOS 对 stripped proc-macro 动态库的 LINKEDIT 对齐限制（[Rust #157750](https://github.com/rust-lang/rust/issues/157750)）。这不把过程宏打入应用。

本方案不跨架构打包 Node：每个 runner 都使用 `.node-version` 固定的 Node 22.15.0，与 Electron 35.4.0 内置版本一致。指定不同 Rust target 会被 staging 拒绝。

```bash
# 本机平台的调试候选包
pnpm --filter @juejin-opensource/jusage-desktop-tauri bundle --debug
pnpm --filter @juejin-opensource/jusage-desktop-tauri test:packaged debug
pnpm --filter @juejin-opensource/jusage-desktop-tauri artifacts debug

# 发布模式候选包，未提供签名/更新配置时仍是普通候选包
pnpm --filter @juejin-opensource/jusage-desktop-tauri bundle:release
pnpm --filter @juejin-opensource/jusage-desktop-tauri test:packaged release
pnpm --filter @juejin-opensource/jusage-desktop-tauri artifacts release
```

`test:packaged` 在 macOS 检查 `.app` 签名并运行实际包内 Node；Linux 解开 deb、Windows 用 7-Zip 解开 NSIS 后运行其中的 Node/Core 测试，不安装或打开应用。Windows 本地运行该校验需安装 7-Zip。
这不代替真实安装、GUI、WebView2、系统通知、多屏或账号验证。

`artifacts/` 中包含按 Rust target 命名的安装包、`artifacts.json` 和 `SHA256SUMS`；工作流保存 14 天。
正式包版本以 `apps/desktop-tauri/package.json` 为唯一入口，构建前同步 Tauri 配置、Cargo.toml 与 Cargo.lock。`version:check` 支持 Windows CRLF，不因换行格式误报。
Tauri Dashboard 构建也注入该版本，普通 CLI/Web 仍使用原有 Dashboard 版本。

## Node sidecar 与签名

Node 使用 `bundle.externalBin`，名称为 `jusage-node`，避免与 Linux 系统 Node 冲突。
Tauri 会把它作为独立可执行文件放进安装包，并纳入平台签名处理；Node/Core 数据仍在 `node-app/` 资源目录。
Core 只打包发布所需的 dist 和元信息，不携带 workspace 源码、测试或 `.env`；依赖保留各消费方解析到的版本。
Node LICENSE 从运行时安装目录复制，可通过 `TUD_NODE_LICENSE` 显式指定；自建 Node 应提供对应许可文件。

Release 使用 Rust `opt-level = "s"`、Thin LTO、单 codegen unit 与最终程序符号裁剪；build-override 仍保留编译期宏库的调试信息和符号，避免 macOS dyld 拒绝加载。
macOS release 资源准备只对随包 Node 副本执行 `strip -x`，保留导出符号，并重新 ad-hoc 签名以便包前校验；Tauri 随后统一执行最终签名。不会修改开发机的 Node，debug 和其他平台不裁剪 Node。
`pnpm test:desktop:tauri` 包含裁剪后 Node 的签名、SQLite 与 crypto 回归；`test:packaged release` 继续验证最终包内 Node/Core。


macOS 未配置正式凭据时使用 `-` ad-hoc 签名封存资源，包含 Node 所需的 JIT entitlement。
debug 构建会移除继承的 Apple 签名/公证凭据并强制 ad-hoc；release 将空证书变量视为未配置并删除，避免 Tauri 按变量存在性导入空 PKCS#12。非空证书配套的合法空密码仍保留。
ad-hoc 不等于 Developer ID 签名或 Apple 公证，不能据此宣称正式分发通过 Gatekeeper。

手动运行 Actions 的 `release` profile 时才会注入仓库的签名配置。PR 和 debug profile 不获得签名秘密。

| 配置 | 用途 |
| --- | --- |
| Secrets `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY` | Apple Developer ID 证书与身份；由 Tauri 处理 |
| Secrets `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` | Apple 公证配置（应用专用密码） |
| Secrets `TUD_WINDOWS_CERTIFICATE`、`TUD_WINDOWS_CERTIFICATE_PASSWORD` | Windows PFX 的 base64 内容与密码，手动候选工作流导入临时 runner 证书库 |
| Variable `TUD_WINDOWS_TIMESTAMP_URL` | 配套 HTTPS RFC 3161 时间戳服务；Windows 签名时必填 |

本机 Windows 签名可设置已导入证书的 `TUD_WINDOWS_CERTIFICATE_THUMBPRINT` 和 `TUD_WINDOWS_TIMESTAMP_URL`。
本仓库当前未配置这些凭据，因此 Developer ID、公证和 Authenticode 尚未实测。

## 显式启用自动更新

普通/debug 构建禁用自动更新，没有默认 feed，也不使用参考项目的公钥。Linux deb 不能直接自动安装 AppImage 更新；运行时仅在 AppImage 环境允许自动更新。

发布模式构建需要同时提供：

| 配置 | 存放 |
| --- | --- |
| `TUD_UPDATER_PUBLIC_KEY` | Actions Variable；Tauri CLI 生成的公钥内容，不是文件路径 |
| `TUD_UPDATER_URL` | Actions Variable；自有 HTTPS manifest 地址 |
| `TAURI_SIGNING_PRIVATE_KEY` | Actions Secret；对应更新签名私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Actions Secret；私钥密码（未加密则可留空） |

`bundle:release` 生成被 Git 忽略的 `src-tauri/tauri.release.generated.json`，仅含公开配置；不会把私钥写入文件。
公钥与地址必须同时设置，地址必须使用 HTTPS，生成更新包还必须提供私钥。Linux 启用后额外生成 AppImage。
更新签名与操作系统代码签名是两件独立的事，两组凭据互不替代。

启用的正式构建可在托盘或设置中检查更新。发现新版后，由用户点击「安装并重启」；下载和安装均经官方 updater 验签。
下载/验签失败不停止 sidecar；安装前停止 sidecar，安装失败后尝试恢复运行时。不会自动安装或降级，也不会重复提交业务写请求。
当前没有真实更新密钥和 feed，因此尚未进行真实的签名、下载和覆盖安装验收。

四平台签名产物准备好后，可在包含所有 Actions artifact 子目录的目录生成静态 manifest：

```bash
node apps/desktop-tauri/scripts/update-manifest.mjs \
  /path/to/downloaded-artifacts \
  https://github.com/juejin-cn/juejin-usage/releases/download/tauri-v0.1.0 \
  0.1.0
```

脚本要求四个 target 的版本一致、profile 为 release、对应更新包及 `.sig` 齐全，并校验 SHA-256；输出 `latest.json`，不会上传或发布。
macOS 使用 `.app.tar.gz`，Windows 使用 NSIS `-setup.exe`，Linux 使用 `.AppImage`。
建议采用独立的 `tauri-v<version>` 标签，避免与 Electron 的 `v<version>` 更新资产混用。

## GUI 验收记录

候选包验证覆盖安装包结构和其中的 Core 运行时。以下项目仍需在对应平台实际操作后记录结果：

- 安装、卸载、首次运行与缺失 WebView2/原生依赖时的行为。
- 账号关联、真实采集上报、CLI/Electron/Tauri 互斥。
- 托盘、关闭隐藏、系统主题、多屏恢复、桌宠拖动及系统通知送达。
- 带真实凭据的操作系统签名、公证、更新签名、下载失败与覆盖安装回归。

验收前继续保留 Electron，PR 保持 Draft；本次没有发布任何正式版本。

## macOS arm64 包体实测

2026-10-27，同一 Node 26.1.0、同一代码与资源，分别构建优化前后 Release `.app` 和 DMG；单位 MiB（1024² 字节）。

| 项目 | 优化前 | 优化后 | 减少 |
| --- | ---: | ---: | ---: |
| 安装后 .app | 165.52 | 122.29 | 26.1% |
| DMG 下载 | 52.94 | 46.47 | 12.2% |
| 随包 Node | 136.44 | 100.80 | 26.1% |
| Rust 主程序 | 19.99 | 12.40 | 38.0% |
| Resources | 8.64 | 8.64 | 0.0% |

这里的 `.app` 为文件逻辑大小之和，磁盘占用随文件系统变化；DMG 为实际生成文件大小。Node 版本和架构不同会影响结果，不能据此推算 Windows/Linux。

切换为与 Electron 一致的官方 Node 22.15.0 后，同样优化设置下再次实测：DMG **40.32 MiB**、安装后 `.app` **105.07 MiB**、随包 Node **83.59 MiB**。Node 22.15.0 下 Core 523 项通过 / 3 项跳过；38 项 Tauri Node 测试和 5 项最终包内运行时测试通过，包内校验同时断言实际 Node 与 manifest 的完整版本均为 22.15.0。

## 前端与 sidecar 资源去重

- Sidecar 只复制 `dist/host` 与宠物 helper；`dist/ui` 由 Tauri 嵌入一次，不再进入 `node-app`。
- 运行时移除类型声明与 source map，Hono 保留 ESM、YAML 保留 Node 实现；保留 package.json、许可证、配置数据以及其他包的 CommonJS 入口。
- Tauri 构建不复制 Dashboard 的 Web 专属 public 资源，品牌图标仍走模块导入；普通 CLI/Web 构建继续保留 public。
- 订阅图标直接导入 Color/Mono 组件，保持外观，避免 Avatar 入口意外带入 LobeHub UI、Markdown 和 KaTeX。
- 最终包检查拒绝重复的 UI、类型文件和非运行时变体，并通过包内 YAML 导出解析、签名和 local-api 生命周期测试。

2026-10-27，Node 22.15.0 / macOS arm64，同一压缩设置的去重前后实测：

| 项目 | 去重前 | 去重后 | 减少 |
| --- | ---: | ---: | ---: |
| 安装后 .app | 105.07 MiB | 97.80 MiB | 6.9% |
| DMG 下载 | 40.32 MiB | 36.62 MiB | 9.2% |
| Rust 主程序（含嵌入前端） | 12.40 MiB | 11.77 MiB | 5.0% |
| Resources | 8.62 MiB | 2.25 MiB | 73.9% |

前端主 JS chunk 从 2048.12 KiB 降到 1453.53 KiB；全部 JS 从 2438.79 KiB 降到 1844.21 KiB。模块级构建审计确认 KaTeX、LobeHub UI 和 streamdown 无代码进入最终 chunks。
