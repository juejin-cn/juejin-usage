# Desktop Tauri 迁移工作区

本目录用于逐步接入 Tauri 客户端，目前仅建立迁移工作区，尚未提供可运行客户端。
现有 Electron 客户端继续保留在 `apps/desktop`，现有开发、构建和发布命令继续有效。

## 参考实现

- 仓库：https://github.com/you-want/juejin-usage-tauri
- 本次参考提交：`303aaf2127bc2adbf9b614efc10c9bd644de0d42`
- 本地参考 submodule：`.references/juejin-usage-tauri`，仅供开发查阅；其 gitlink 和 `.gitmodules` 不进入提交。
- 新克隆本仓库不会自动下载参考实现。需要参考时可自行克隆上述仓库，不依赖该本地目录构建或运行。

参考实现采用 Tauri Rust 壳与 Node sidecar，复用 dashboard 和 core local-api。
正式移植前应核对其依赖的 CLI desktop-host、共享 desktop-ui 与 dashboard 构建改动，避免只复制壳而遗漏运行时依赖。

## 迁移步骤

- [ ] 梳理参考实现相对当前 main 的改动与依赖，确定首期功能范围。
- [ ] 在本目录接入 Tauri 壳与 Node sidecar，保持现有 core local-api 契约。
- [ ] 接入 dashboard 与桌面桥，核对登录、同步、托盘、窗口及退出行为。
- [ ] 验证 `tud.pid` owner、CLI/Desktop 互斥、心跳及运行时清理。
- [ ] 添加独立的 Tauri 开发、构建和打包入口，保留 Electron 入口。
- [ ] 核对应用标识、更新地址、签名与发布配置，避免沿用参考仓库的社区发布通道。
- [ ] 完成平台构建和功能验证后，再讨论是否替换 Electron。

共享 UI 或数据层若发生变化，继续核对 `packages/dashboard/src` 与
`apps/desktop/src/renderer` 的同名副本。本阶段不修改这两处代码。
