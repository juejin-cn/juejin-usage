# @juejin-opensource/jusage-dashboard

## 0.1.7

### Patch Changes

- 修复 Desktop、CLI 与 Web 面板每日趋势费用刻度被裁切，较大金额现在可完整显示。
- 排行榜默认显示今天并记住上次选择的时间范围；下载页改为选取 Gitee 最新安装包，并展示支持的工具与 GitHub Star 入口。
- 统一 Desktop 与 Web 的设置弹窗样式。
- 手动同步后弹出成功或失败 Toast。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.7

## 0.1.5

### Patch Changes

- 个人用量页时间范围刷新后仍保留上次选择。
- 排行榜筛选下拉过长时改为内部滚动；同名模型选项去重，避免异步刷新时列表异常。
- 筛选栏补充 GitHub 仓库入口。
- Updated dependencies
  - @juejin-opensource/jusage-core@0.1.6

## 0.1.4

### Patch Changes

- 同步 core 的费用精度与 unknown 模型对齐逻辑。
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

- 新增排行榜相关页面与配套交互，完善看板侧的展示能力。
- 修复刷新与一批 beta 阶段暴露的界面问题，提升日常使用稳定性。
- 升级内部依赖至 `@juejin-opensource/jusage-core@0.1.1`，整理后发布首个 `0.1.1` 正式版。

## 0.1.1-beta.9

### Patch Changes

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

## 0.1.1-beta.0

### Patch Changes

- chore: init
