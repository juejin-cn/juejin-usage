# Tauri 候选包与发布准备

## 独立 Beta 发布记录（2026-11-03 · next.7）

已发布 [2.0.0-next.7](https://github.com/juejin-cn/juejin-usage/releases/tag/tauri-v2.0.0-next.7)，将“设置 → 应用”对齐原 Electron 客户端：统一启动选项顺序、静默启动说明、菜单栏用量选择器、更新及设备信息卡片与版本行样式。包含 next.6 的更新重启横幅修复。源码为 `736d644f176915e8fba626e0c7a7413d440b955c`，构建注入独立版本。

[三平台 CI](https://github.com/juejin-cn/juejin-usage/actions/runs/41643672004) 全部通过。macOS 两种架构均完成 Developer ID 签名、应用及 DMG 公证和最终包内复验；Windows 包含 Tauri 更新签名，无 Authenticode。三平台更新签名和签名版本绑定均经原 Beta 公钥验证。DMG 大小为 26.26 MiB（Apple Silicon）、29.35 MiB（Intel），Windows NSIS 为 25.69 MiB。

9 个 GitHub 附件的 SHA-256 与本地一致；三平台公开更新包及签名文件已复核。Gitee 独立 Beta 清单已切换至 next.7，公开 raw 回读一致；真实更新器以 next.6 检查能发现 next.7，以 next.7 检查不重复更新。Electron 更新文件不变，GitHub Latest 仍为 `v0.1.15`。

Apple Silicon 隔离副本上的 next.6 → next.7 真实安装器验签和替换检查通过，464 个普通文件与签名构建一致，严格代码签名及公证票据验证通过。未改动用户已安装的应用，原生 GUI 布局与自动重启仍待实测。归档：`~/Releases/jusage-tauri/2.0.0-next.7/`，包含产物、校验和、更新清单、签名/公证及测试日志和 `verification.json`。

## 独立 Beta 发布记录（2026-11-03 · next.6）

已发布 [2.0.0-next.6](https://github.com/juejin-cn/juejin-usage/releases/tag/tauri-v2.0.0-next.6)，修复更新重启正常停止本地服务时，页面短暂误报故障并显示重试横幅的问题。源码为 `3c80041ffefa07aa4a78accac1cf53e9aedc2dd9`，构建注入独立版本。

[三平台 CI](https://github.com/juejin-cn/juejin-usage/actions/runs/41631284020) 全部通过。macOS 两种架构均完成 Developer ID 签名、应用与 DMG 公证和最终包内复验；三平台更新签名及签名版本绑定经原 Beta 公钥验证。9 个 GitHub 附件哈希与本地一致，公开更新包及签名文件已复核。Gitee Beta 清单已切到 next.6，真实更新器以 next.5 检查能发现 next.6；Electron 更新文件不变，GitHub Latest 仍为 `v0.1.15`。

Apple Silicon 隔离副本上的 next.5 → next.6 真实安装器验签和替换测试通过，464 个普通文件与签名构建一致，严格代码签名及公证票据验证通过。未替换用户应用，原生 GUI 点击和自动重启尚待实测；旧版执行升级时仍可能出现原横幅，修复在 next.6 运行后生效。归档：`~/Releases/jusage-tauri/2.0.0-next.6/`，含附件、签名/公证和测试日志、更新清单与 `verification.json`。

## 独立 Beta 发布记录（2026-11-03 · next.5）

已发布 [2.0.0-next.5](https://github.com/juejin-cn/juejin-usage/releases/tag/tauri-v2.0.0-next.5)，供已安装 next.4 的用户验证自动更新。沿用 Beta 应用标识和更新公钥；macOS 更新归档排除 AppleDouble 元数据并检查根目录结构。

源码为 `bf016f98c2bbe9eebe33f04c2af4a7de90f69dca`，版本由构建注入。[三平台 CI](https://github.com/juejin-cn/juejin-usage/actions/runs/41626169802) 全部通过。macOS 两种架构完成 Developer ID 签名、应用与 DMG 公证及最终包内复验；Windows 包含更新签名，无 Authenticode。DMG 大小分别为 26.26 MiB（Apple Silicon）、29.35 MiB（Intel），Windows NSIS 为 25.69 MiB。

9 个 GitHub 附件的 SHA-256 与本地产物匹配；三平台公开更新包及签名文件已复核。Gitee 独立 Beta 清单已切换至 next.5，公开 raw 清单回读一致；真实更新器以 next.4 检查能发现 next.5，以 next.5 检查不重复更新。Electron 更新清单不变，GitHub Latest 仍为 `v0.1.15`。

隔离副本上的 next.4 → next.5 真实安装器测试通过，464 个普通文件匹配，严格签名及公证票据验证通过。用户 `/Applications` 中的 next.4 保留供手动测试；尚未验收原生界面点击、自动重启及重启后的运行状态。Intel 最终包初次复验因本地 Core dist 缺失失败，补齐后 8 项包内测试及 228 个 API/3 个时区对照均通过。

归档：`~/Releases/jusage-tauri/2.0.0-next.5/`，包含附件、校验和、更新清单、签名/公证记录、CI 和复验日志及 `verification.json`。

## 独立 Beta 发布记录（2026-11-03 · next.4）

已发布 [2.0.0-next.4](https://github.com/juejin-cn/juejin-usage/releases/tag/tauri-v2.0.0-next.4)，将自动更新入口对齐 Electron：在排行榜左侧显示下载进度、更新并重启和重试更新按钮，移除顶部更新横幅，详细错误保留在悬浮提示与设置页；失败后重新检查并下载，成功后保留一次性通知。

| 平台 | 安装包大小 | 验证 |
| --- | ---: | --- |
| macOS Apple Silicon | DMG 26.26 MiB | Developer ID 签名、应用及 DMG 公证、最终包内复验 |
| macOS Intel | DMG 29.35 MiB | Developer ID 签名、应用及 DMG 公证、Rosetta 下包内复验 |
| Windows x64 | NSIS 25.70 MiB | CI 构建及包内测试、Tauri 更新签名；无 Authenticode |

源码为 `706d9973fac2c9aca3f2e623b55a7997c736fa7b`，独立版本由构建注入；[三平台构建与测试](https://github.com/juejin-cn/juejin-usage/actions/runs/41605493132) 全部通过。沿用 next.3 的签名、公证流程、Beta 应用标识、公钥与 Node 22.15.0 full-ICU。更新签名经过原 Beta 公钥验证，9 个附件的 SHA-256 与本地产物核对。GitHub 保持 Pre-release、非 Latest；仅切换 Gitee 独立 Beta 清单，Electron 正式版更新清单不变。

归档位于 `~/Releases/jusage-tauri/2.0.0-next.4/`，包含附件、签名/公证及测试日志、校验和与验证记录；本地验证生成的构建缓存在完成检查后清理。本版本未进行原生 GUI 覆盖升级验收。

## 独立 Beta 发布记录（2026-11-03）

已发布 [2.0.0-next.3](https://github.com/juejin-cn/juejin-usage/releases/tag/tauri-v2.0.0-next.3)，修复默认开机自启注册、开关持久化和更新后的注册路径刷新，并将桌宠同步气泡的数据、样式与交互对齐 Electron。保留原 Beta 应用标识、更新公钥及 Node 22.15.0 full-ICU。

| 平台 | 安装包大小 | 验证 |
| --- | ---: | --- |
| macOS Apple Silicon | DMG 26.26 MiB | Developer ID 签名、应用及 DMG 的 Apple 公证、最终包内测试 |
| macOS Intel | DMG 29.35 MiB | Developer ID 签名、应用及 DMG 的 Apple 公证、Rosetta 下最终包内测试 |
| Windows x64 | NSIS 25.69 MiB | CI 构建及包内测试、Tauri 更新签名；无 Authenticode |

源码为 `ba544e30e2d8605b33c1dbb19ec809caf998c33c`，构建时通过 `prepare-beta.mjs` 注入独立版本。三平台 [CI 构建与测试](https://github.com/juejin-cn/juejin-usage/actions/runs/41589539130) 全部通过。macOS 的 CI 产物在本机使用既有凭据完成 Developer ID 签名与公证，保留原 DMG 的 Finder 布局，重生成更新归档并绑定版本签名，随后重新运行最终包内测试。三平台更新签名均使用原 Beta 公钥和官方 Minisign 验证库校验，9 个 Release 附件的 SHA-256 与本地产物逐一核对。

GitHub 保持 Pre-release、非 Latest；Electron Latest 仍为 `v0.1.15`。仅更新独立 Gitee `releases/tauri-beta/latest.json`，不修改 Electron 的更新清单。归档位于 `~/Releases/jusage-tauri/2.0.0-next.3/`，包含分平台产物、校验和、签名/公证记录和 CI 日志。未进行 `next.2 → next.3` 的原生 GUI 覆盖升级验收，也未在实体 Intel Mac 或 Windows 桌面进行 GUI 验收。

## 独立 Beta 发布记录（2026-11-02）

已发布 [2.0.0-next.2](https://github.com/juejin-cn/juejin-usage/releases/tag/tauri-v2.0.0-next.2)，沿用 `next.1` 的 Beta 应用标识和更新公钥。GitHub 标记为 Pre-release，Latest 仍为 Electron `v0.1.15`。

| 平台 | 产物 | 大小 | 验证 |
| --- | --- | ---: | --- |
| macOS Apple Silicon | DMG | 26.18 MiB | Developer ID 签名、Apple 公证、包内测试 |
| macOS Intel | DMG | 29.25 MiB | Developer ID 签名、Apple 公证、Rosetta 下 x64 包内测试 |
| Windows x64 | NSIS EXE | 25.69 MiB | CI 构建、包内测试、Tauri 更新签名；无 Authenticode |

默认保留 Node 22.15.0 full-ICU。macOS 自动更新附件仍为 gzip 格式的 `.app.tar.gz`（Apple Silicon 37.27 MiB、Intel 39.50 MiB）；26.18 MiB 是手动安装用的 DMG，不能把两者混为一谈。

更新源：[独立 Gitee Beta 清单](https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri-beta/latest.json)。附件从 GitHub 下载，需要能访问 GitHub。不要修改 Electron 的 `latest.yml`、`latest-mac.yml`、`beta.yml`、`beta-mac.yml`，也不要按旧 SOP 删除正式版附件。

本次源码分支 `chore/tauri-next-2.0.0-next.2`；清单发布分支 `chore/tauri-beta-feed-next2`。后者的 `.github/scripts/publish-tauri-beta-feed.py` 在发布前校验公开附件、SHA-256 与签名文件，只写入 `releases/tauri-beta/latest.json`，并比对旧更新文件的 Git blob SHA。Gitee 对缺失嵌套文件可能返回 `200 + []`；新建后 raw 地址也可能短暂返回 404，必须等公开地址可读后再验收客户端。

发布顺序：构建并测试 macOS 两种架构及 Windows x64 → 上传到 GitHub Release 草稿 → 核对附件哈希 → 发布为非 Latest 的 Pre-release → 用发布后的真实下载 URL 生成清单 → 发布 Gitee 清单 → 从旧 Beta 验证升级。草稿附件 URL 含 `untagged-*` 临时标签，不能直接写入正式更新清单。

本机归档：`~/Releases/jusage-tauri/2.0.0-next.2/`，包含分平台产物、`SHA256SUMS`、`latest.json`、构建/CI 日志与 `verification.json`。签名私钥和 Apple 凭据不进入 Git 仓库或 Release。

已在 macOS Apple Silicon 实测 `next.1 → next.2`：检查更新、下载验签、安装重启成功；界面显示 `2.0.0-next.2`，再次检查未提供重复升级。更新后的全部 462 个文件与签名构建一致，重启后的 Node 后台进程正常启动。Windows 仅完成 CI 和包内验证，尚未做桌面覆盖升级实测。

Intel 补包使用同一发布源码 `845e0ca50d5ff8a4ea439fc1430817bc3270b2d6`，在 Rosetta 下使用 x64 Node 22.15.0 full-ICU 和 x64 Rust 1.99.1 构建；主程序和 Node 均为 x86_64。已通过 61 项 host 测试、29 项 Rust 测试、6 项最终包测试，以及 228 个 API 对照和 3 个时区用例。已加入 `darwin-x86_64` 更新项；尚未在实体 Intel Mac 上进行 GUI 安装与覆盖升级实测。

本地 GUI 验收应先退出其他客户端，避免互斥或登录回调串扰。测试前预建未关联配置、关闭云同步；需要禁止业务请求时将测试 API 根指向本机关闭端口。`TUD_DATA_DIR`/`JUSAGE_CONFIG_HOME` 仅对当前启动进程有效：macOS 安装后重启经 LaunchServices，不保留这些临时环境变量，可能恢复使用普通数据目录。不能据此宣称测试目录或账号数据迁移已经通过；测试结束应退出副本并停用临时数据目录。

以下为早期候选包流程与历史实测记录；涉及“未配置凭据、未发布”的描述以本节最新记录为准。

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

`artifacts/` 中包含与 Electron 下载页同名规则的安装包（如 `Juejin Usage-<ver>-arm64.dmg`、`Juejin Usage Setup <ver>.exe`）、`artifacts.json` 和 `SHA256SUMS`；工作流保存 14 天。
正式包版本以 `apps/desktop-tauri/package.json` 为唯一入口，构建前同步 Tauri 配置、Cargo.toml 与 Cargo.lock。`version:check` 支持 Windows CRLF，不因换行格式误报。
Tauri Dashboard 构建也注入该版本，普通 CLI/Web 仍使用原有 Dashboard 版本。

## Node sidecar 与签名

Node 使用 `bundle.externalBin`，名称为 `jusage-node`，避免与 Linux 系统 Node 冲突。
Tauri 会把它作为独立可执行文件放进安装包，并纳入平台签名处理；Node/Core 数据仍在 `node-app/` 资源目录。
Core 只打包发布所需的 dist 和元信息，不携带 workspace 源码、测试或 `.env`；依赖保留各消费方解析到的版本。
Node LICENSE 从运行时安装目录复制，可通过 `TUD_NODE_LICENSE` 显式指定；自建 Node 应提供对应许可文件。

Release 使用 Rust `opt-level = "s"`、单 codegen unit 与最终程序符号裁剪。`build-native.mjs` 对 macOS release 默认使用完整 LTO，其他平台和直接 Cargo 构建仍沿用 Cargo.toml 的 Thin LTO；显式的 `CARGO_PROFILE_RELEASE_LTO` 优先。build-override 仍保留编译期宏库的调试信息和符号，避免 macOS dyld 拒绝加载。
macOS release DMG 使用 ULMO/LZMA，要求 macOS 10.15+，满足项目最低 macOS 12。压缩在 Tauri 签署 DMG 之前完成，构建后校验格式；不对已签名的发布附件做原地转换。Debug 和 Windows/Linux 打包行为保持不变。对照数据和验证边界见 [full-icu 包体优化](full-icu-size.md)。
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

## 可选 small-icu 运行时

默认仍使用官方 full-icu Node 22.15.0。small-icu 需要显式选择；目前提供 macOS/Linux 本机编译入口，Windows 继续使用官方运行时。

```bash
pnpm --filter @juejin-opensource/jusage-desktop-tauri node:build:small-icu
```

构建脚本从 `scripts/node-source.json` 指定的官方地址下载 22.15.0 源码，校验已提交的 SHA-256，再使用 `--with-intl=small-icu` 编译。输出保存在被忽略的 `.node-build/` 中，包含 `build.json`、二进制和 `NODE-LICENSE`。默认最多使用 8 个编译任务，可通过 `TUD_NODE_BUILD_JOBS` 调整；需 Python 3.8–3.13，可用 `TUD_NODE_BUILD_PYTHON` 指定。不会修改系统 Node，也不运行全局安装。

```bash
# 从仓库根执行；仍保留原有 macOS strip 与最终签名流程
TUD_NODE_ICU=small \
TUD_NODE_BIN="$PWD/apps/desktop-tauri/.node-build/node-v22.15.0/out/Release/node" \
TUD_NODE_BUILD_MANIFEST="$PWD/apps/desktop-tauri/.node-build/build.json" \
TUD_NODE_LICENSE="$PWD/apps/desktop-tauri/.node-build/NODE-LICENSE" \
pnpm stage:desktop:tauri
```

staging 校验精确 Node 版本、平台、架构、ICU 类型、来源校验和与构建后二进制哈希；缺少构建记录或许可证时拒绝 small-icu。`runtime.json` schema 2 记录 ICU 版本和裁剪前后的来源信息。`binarySha256` 是 staging 后、平台最终签名前的哈希，最终签名会改变二进制，不能把它当成安装包校验和；安装包继续使用 artifacts 的 SHA256SUMS 和平台签名验证。

```bash
# 编译测试后，用同版本官方与 small-icu Node 串行跑 Core 和 Tauri 测试
pnpm --filter @juejin-opensource/jusage-core test:compile
node apps/desktop-tauri/scripts/compare-node-runtimes.mjs \
  /absolute/path/to/official-node \
  "$PWD/apps/desktop-tauri/.node-build/node-v22.15.0/out/Release/node" \
  /tmp/jusage-runtime-comparison
pnpm --filter @juejin-opensource/jusage-desktop-tauri test:staged
```

`compare-node-runtimes.mjs` 校验两个 Node 都为 22.15.0 且 ICU 类型分别为 full/small，然后保存两套 Core、Tauri 日志及汇总；Tauri 用例包含固定样本金样本。对最终安装包还要执行 `test:packaged`。构建安装包时，以上四个 `TUD_NODE_*` 环境变量也必须传给 `bundle` / `bundle:release`，避免构建前准备资源时换回官方 Node。

Core 的时区转换和 Claude 订阅时间解析已使用 `formatToParts`；审计仍发现多处默认 locale 的文件路径排序，以及数值版本排序和系统时区读取。因此当前验证只证明样本与测试覆盖范围，不把 small-icu 当成完整国际化支持。前端仍由系统 WebView 提供 Intl，与 sidecar Node 的 ICU 无关。切回 full-icu 时移除 small-icu 的环境变量，并把 `TUD_NODE_BIN` 指向匹配版本的官方 Node 后重新构建。

### macOS x64 实测与验收（2026-10-27）

使用同一份最终 Rust 程序、前端和 Core，对照官方 full-icu 与源码编译的 small-icu Node **22.15.0**。两套均经过相同的 `strip -x` 和 ad-hoc 签名；单位 MiB（1024² 字节），`.app` 按文件逻辑大小求和。

| 项目 | full-icu | small-icu | 减少 |
| --- | ---: | ---: | ---: |
| 安装后 `.app` | 101.59 | 74.67 | 26.5% |
| DMG 下载 | 39.13 | 28.33 | 27.6% |
| 随包 Node | 86.83 | 59.91 | 31.0% |
| Rust 主程序 | 12.30 | 12.30 | 0.0% |

两套 Node 各自通过 Core 523 项（3 项原有跳过）和 Tauri Node 47 项测试；两套最终 `.app` 均通过严格签名检查、228 个 API 金样本、三个统计时区案例与 6 项包内宿主测试。独立 Rust 验收另通过 27 项测试和 72 组 daily 金样本对比。

本机对照产物与原始日志保存在被忽略的 `artifacts/icu-comparison/{full,small}/` 和 `artifacts/icu-comparison/runtime-tests/`；`sizes.json` 记录字节数和 DMG SHA-256。这是 x64 候选包验证，没有进行 GUI、真实账号、正式签名/公证或自动更新验收；不外推其他平台。small-icu 和 Rust daily 仍需显式开启，默认保持 full-icu / Node。

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
