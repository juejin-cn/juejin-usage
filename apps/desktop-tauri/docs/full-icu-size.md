# full-icu 包体优化（2026-11-02）

保留完整 Node 22.15.0 / ICU 76.1，未使用 small-icu，未移除应用功能。实验针对 macOS ARM64，不外推 Intel Mac 或 Windows 的具体收益。

## DMG 压缩对照

对已发布 `2.0.0-next.1` 的同一个 DMG 进行转换，内部应用内容完全相同。单位为 MiB（1024² 字节）。

| 格式 | 压缩方式 | DMG | 转换耗时 |
| --- | --- | ---: | ---: |
| UDZO | zlib，现有 level 9 | 36.737 | 原始产物 |
| ULFO | LZFSE | 36.047 | 3.696 s |
| ULMO | LZMA | 26.512 | 3.966 s |
| UDBZ | bzip2 level 9，系统已标记弃用 | 33.453 | 3.995 s |

ULMO 减少 27.8% 的 DMG 下载体积，不改变安装后大小。三种转换结果均通过镜像校验；只读挂载后逐一核对 462 个应用文件的 SHA-256，一致；应用严格签名和公证票据验证通过。这些转换实验只证明内部应用保持完整，不代表转换后的 DMG 外层签名仍然有效。

本机 `hdiutil` 手册说明 ULMO 要求 macOS 10.15+，项目要求 macOS 12+。未在每个历史 macOS 版本上实际安装验收。转换耗时和约 0.11–0.13 s 的挂载耗时为本机缓存条件下的观测，不是跨机器性能承诺。

## Rust 编译对照

源代码基于 `3e93d49`，同一前端和 full-icu Node；四组均为单 codegen unit 和符号裁剪。

| opt-level / LTO | 主程序 | 主程序 gzip-9 | 本次构建耗时 |
| --- | ---: | ---: | ---: |
| s / thin | 12.036 | 5.803 | 53.982 s |
| z / thin | 10.050 | 5.554 | 51.250 s |
| s / fat | 10.468 | 5.295 | 80.051 s |
| z / fat | 8.469 | 4.942 | 62.637 s |

gzip-9 列用于估计压缩后的差异，不等于最终 DMG 或 updater 包大小。构建复用了本机缓存，缓存状态不同，耗时不能作为公平的冷构建性能比较。

采用 `s/fat`：主程序减少约 13%，保留循环向量化；未直接采用会关闭循环向量化的 `z`。不声称 `z` 已发现性能问题，而是尚未对其做充分的运行时性能验证。

`s/fat` 的 29 项 release 模式 Rust 测试通过。对 `s/thin`、`s/fat` 分别编译同一个 headless daily 读路径工具，两组均通过 228 个 API 样本、3 个时区案例和 72 组 Rust daily 对照。

交替顺序跑 3 轮，每轮 10,000 个样本；固定 mixed / 7 天数据，包含文件读取、聚合和 JSON 序列化：

| 配置 | 三轮 median | 三轮 p95 |
| --- | --- | --- |
| s/thin | 0.040542 / 0.040541 / 0.040709 ms | 0.043667 / 0.044500 / 0.044042 ms |
| s/fat | 0.033875 / 0.033875 / 0.034000 ms | 0.036250 / 0.036625 / 0.037417 ms |

这是合成数据上的组件微基准，不包含 WebView、IPC、完整采集过程或前端交互，不据此宣称整个桌面应用加速。

## 构建接入

本次验证的 Tauri CLI 2.12.4 的 DMG schema 没有压缩格式配置。`dmg-compression.mjs` 仅在 macOS release 子进程的 PATH 中放置临时 `hdiutil` 适配器：

- 仅匹配输出到当前 bundle/macos 中间目录（随后由 Tauri 移入 bundle/dmg）的 `convert ... -format UDZO`，改为 ULMO 并移除不适用的 zlib 参数。
- 其他磁盘操作原样交给 `/usr/bin/hdiutil`；不修改系统命令，也不修改 node_modules。
- Tauri 随后按原流程签署最终 DMG；无须自行导出证书或另建签名流程。
- 结束时清理临时适配器，并检查实际产物是 ULMO；Tauri 将来改变调用方式时明确报错，不静默退回较大的格式。
- `build-native.mjs` 为 macOS release 设置 `CARGO_PROFILE_RELEASE_LTO=fat`，允许显式环境变量覆盖；其他平台继续使用原配置。

签名、公证凭据仍按原发布 SOP 配置。常规 `bundle:release` 即采用优化；不要对已发布 DMG 转换后直接覆盖原附件，压缩格式改变后必须重新签名、计算校验和并发布新候选包。

## 最终签名包验证

按当前分支版本 `1.1.15` 构建本地验证包，未更改版本策略、未发布新版本。实际采用 `s/fat` + ULMO，保留 full-icu Node 22.15.0 / ICU 76.1：

| 项目 | 结果 |
| --- | ---: |
| DMG | 27,452,264 bytes（26.18 MiB） |
| 安装后的应用 | 101,021,806 bytes（96.34 MiB，按文件逻辑大小求和） |
| 随包 Node | 87,672,640 bytes（83.61 MiB） |
| Rust 主程序 | 10,931,744 bytes（10.43 MiB） |

与此前 36.74 MiB 的测试发行包相比，DMG 约减少 28.7%；这是不同版本标识的完整包对照，严格的单变量压缩对照见前面的同包转换实验。构建器显示的 app 大小可能与按文件大小求和略有差异。

- 61 项 Node 宿主测试、29 项 release 模式 Rust 测试、6 项最终包内运行时测试通过。
- 最终 DMG 为 ULMO，镜像校验通过，DMG 外层与包内应用的签名均有效，Apple 公证 Accepted，应用公证票据验证通过。
- 最终 DMG 只读挂载后，应用所有文件与构建目录逐项 SHA-256 对照一致。
- DMG SHA-256：`c2e4c44c1a8194628e3a18a68403ed22778ce6a0f8d3f98875f814cf7ed853d4`。

本地验证包为 `~/Releases/jusage-tauri/size-experiment-20261102/optimized-full-icu-arm64.dmg`，完整数据在同目录 `optimized-summary.json`。未覆盖远程安装包，也没有进行跨版本自动升级或历史 macOS 版本上的 GUI 验收。此优化主要降低首次安装的 DMG 体积；自动更新的 `.app.tar.gz` 不使用 LZMA，只能受益于较小的 Rust 主程序。

## 复现实验

只操作候选副本，不覆盖原文件：

```bash
hdiutil convert /path/to/original.dmg -format ULMO -o /path/to/candidate-lzma.dmg
hdiutil verify /path/to/candidate-lzma.dmg

# 在已 prepare:app 的实验工作区内；四组分别替换 s/z、thin/fat
CARGO_PROFILE_RELEASE_OPT_LEVEL=s CARGO_PROFILE_RELEASE_LTO=fat \
  cargo build --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml \
  --release --locked --features custom-protocol
```

原始记录保存在本机 `~/Releases/jusage-tauri/size-experiment-20261102/`：`dmg-results.json`、`dmg-validation.json`、`rust-results.json`、`lto-benchmark.json` 及各项构建和验证日志。实验包未替换 GitHub 上已发布的测试包。

参考：本机 `man hdiutil` 的 ULMO 兼容性说明，以及 [Cargo Profiles](https://doc.rust-lang.org/cargo/reference/profiles.html) 对 opt-level 与 LTO 的定义。
