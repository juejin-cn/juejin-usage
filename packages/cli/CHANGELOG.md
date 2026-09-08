# @juejin-opensource/jusage

## 0.1.9

### Patch Changes

- 新增 GPT-6 Astra 的官方 Token 定价，并补上缓存读取与缓存写入单价；命中缓存的输入 Token 不再按 0 计费。
- 修复保存设置失败后，云端同步开关等设置仍可能在运行中生效、与已保存配置不一致的问题。
- 修复后台同步或上报完成时可能覆盖刚保存的设置、重新开启云端同步的问题，并避免保存设置时回退最近同步或上报时间。
- 修复把面板时间范围从 7 天扩大到 30 / 90 天后 Token、费用和会话数被重复计算的问题：扩大范围触发的历史重扫改为用重扫结果覆盖已有数据，不再和旧数据相加。
- 内置面板：主题切换收敛为单个按钮，支持跟随系统；排行榜公开榜扩到前 100，加载失败时显示错误并支持重试。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.9

## 0.1.8

### Patch Changes

- 新增 DeepSeek Harness（dsh）用量采集：读取本地 `~/.dsh` 会话，按消息增量统计 token、模型与项目。
- 定价表补充 Claude Fable 5.1 与 Gemini 3.8 Flash，费用统计按最新价格计算。
- 修复项目分布把工作目录编码路径（如 `%2FUsers%2F...`）直接当标题展示的问题。CLI、Web 与 Desktop 面板同步修复。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.8

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
