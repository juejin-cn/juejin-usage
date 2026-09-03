# @juejin-opensource/jusage

## 0.1.7

### Patch Changes

- CLI 支持 `--host` 指定面板监听地址（默认 127.0.0.1；局域网访问可用 0.0.0.0）。
- 新增 Linux systemd 用户服务，便于后台自启；注册失败时回滚残留 unit，并避免将未启用的服务误报为已注册。
- 修复 Desktop、CLI 与 Web 面板每日趋势费用刻度被裁切，较大金额现在可完整显示。
- 后台同步更轻：空轮询不再全量扫描，定价改为启动时拉取一次。
- 手动同步后弹出成功或失败 Toast。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.7

## 0.1.6

### Patch Changes

- 内置面板：用量页时间范围刷新后仍保留上次选择。
- 排行榜筛选下拉过长时改为内部滚动；同名模型选项去重，避免异步刷新时列表异常。
- 筛选栏补充 GitHub 仓库入口。
- 同步 core 的定价表增量更新与模型匹配增强，修复 Cursor 模型被误判为 MiniMax 导致费用偏高。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.6

## 0.1.5

### Patch Changes

- 桌面端在线时 CLI 进入观察模式，不抢占 sync/上报 runtime。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.5

## 0.1.4

### Patch Changes

- 定价覆盖层启动时等待首次拉取并落盘缓存，刷新后重建本地聚合缓存。
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

- 改进 `jusage service start` 的启动可靠性，修复 PID 时间戳误判和写盘时序问题，并增加 `/health` 兜底检查。
- 新增排行榜相关能力，便于在本地端配合最新看板功能使用。
- 升级内部依赖至 `@juejin-opensource/jusage-core@0.1.1`，并合并 beta 阶段的稳定性修复后发布正式版。

## 0.1.1-beta.9

### Patch Changes

- fix: `jusage service start` 不再因 PID 时间戳误判 / 写盘过晚而报超时，并以 `/health` 作为就绪兜底
- fix: cli 启动检测失败问题
- Updated dependencies
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.1-beta.9

## 0.1.1-beta.8

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.8

## 0.1.1-beta.7

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.7

## 0.1.1-beta.6

### Patch Changes

- fix: reefresh
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.6

## 0.1.1-beta.5

### Patch Changes

- feat: ranks
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.5

## 0.1.1-beta.4

### Patch Changes

- chore: update
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.4

## 0.1.1-beta.3

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.3

## 0.1.1-beta.2

### Patch Changes

- fix: some bugs
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.2

## 0.1.1-beta.1

### Patch Changes

- chore: init
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.1

## 0.1.1-beta.0

### Patch Changes

- chore: init
- Updated dependencies
  - @juejin-opensource/tud-core@0.1.1-beta.0
