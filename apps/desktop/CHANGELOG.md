# @juejin-opensource/jusage-desktop

## 0.1.7

### Patch Changes

- 修复 Desktop、CLI 与 Web 面板每日趋势费用刻度被裁切，较大金额现在可完整显示。
- 修复 macOS 桌面宠物悬浮窗意外显示原生红绿灯窗口控制按钮。
- 修复设置里桌面宠物大小滑块被裁切，并在未开启「显示桌面宠物」时禁用形象、大小和跑动等参数。
- 降低桌面端后台同步时的主进程卡顿：解析改到独立进程，空轮询不再全量扫描，定价改为启动时拉取一次。
- 新增开机静默启动：开机自启时仅显示托盘、不弹主窗口。
- 托盘驻留时隐藏即销毁主窗口与宠物窗口，按需重建，降低内存占用。
- 统一 Desktop 与 Web 的设置弹窗样式。
- 手动同步后弹出成功或失败 Toast。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.7

## 0.1.6

### Patch Changes

- 用量页时间范围刷新后仍保留上次选择。
- 筛选栏补充 GitHub 仓库入口。
- 同步 core 的定价表增量更新与模型匹配增强。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.6

## 0.1.5

### Patch Changes

- 启动即独占 runtime：停掉 CLI（含自启）并强制抢占 `tud.pid`。
- 心跳 watchdog 监控 runtime；丢失 ownership 或 runtime 掉线时自动 recover。
- `config.json` 损坏可自动恢复；IPC / Dashboard 对 `LOCAL_RUNTIME_NOT_READY` 重试并提示「本地服务正在恢复」。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.5

## 0.1.4

### Patch Changes

- Codex / Every Code 将 unknown 模型用量并入同期主导已知模型；聚合费用按 8 位小数累加，避免分桶先四舍五入到分。
- 定价覆盖层落盘缓存，启动复用上次成功拉取的表，刷新后重建聚合缓存。
- 自动更新禁止降级；看板刷新 overlay 不再给卡片染色。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.4

## 0.1.3

### Patch Changes

- 拿不到 `tud-sync-status` 水位时，历史补报按本地 90 天窗继续上报，避免队列一直 hold。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.3

## 0.1.2

### Patch Changes

- 本地采集与上报窗口扩到 90 天；历史补报在拿不到服务端地板时留队，避免误标已上报。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.2

## 0.1.1

### Patch Changes

- 新增排行榜相关能力，并同步桌面端内嵌看板体验。
- 修复刷新及一批 beta 阶段积累的问题，提升桌面端稳定性。
- 升级内部依赖至 `@juejin-opensource/jusage-core@0.1.1`，整理后发布 `0.1.1` 正式版。

## 0.1.1-beta.13

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.1-beta.9

## 0.1.1-beta.11

### Patch Changes

- fix: allow the macOS updater to close windows and relaunch after installation
- fix: restore the local runtime and close-to-tray behavior if installation fails

## 0.1.1-beta.10

### Minor Changes

- feat: automatically restart and install downloaded updates
- feat: show a one-time success toast after an update completes

## 0.1.1-beta.9

### Minor Changes

- feat: show downloaded auto updates in an actionable toast and check for updates on startup
- chore: upgrade HeroUI to 3.2.4

## 0.1.1-beta.8

### Patch Changes

- test: publish a signed macOS update to verify the in-app auto-update flow

## 0.1.1-beta.7

### Minor Changes

- feat: add signed GitHub Releases auto-update flow for macOS and Windows

## 0.1.1-beta.6

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.8

## 0.1.1-beta.5

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.7

## 0.1.1-beta.4

### Patch Changes

- fix: reefresh
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.6

## 0.1.1-beta.3

### Patch Changes

- feat: ranks
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.5

## 0.1.1-beta.2

### Patch Changes

- chore: update
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.4

## 0.1.1-beta.1

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.3

## 0.1.1-beta.0

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.2
