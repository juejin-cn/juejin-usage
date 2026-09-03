# @juejin-opensource/jusage-core

## 0.1.7

### Patch Changes

- 降低后台同步占用：解析改到独立进程，空轮询不再全量扫描，定价改为启动时拉取一次。

## 0.1.6

### Patch Changes

- 内置定价表按 models.dev 官方渠道增量同步，手工补充的模型价保留不丢。
- 定价匹配增强：Claude 模型名归一化、推理档后缀剥离，精确命中优先于 fuzzy 兜底。
- 修复 Cursor 模型被误判为 MiniMax 导致费用偏高。

## 0.1.5

### Patch Changes

- 新增 runtime 心跳与 ownership 监督，僵死 / 过期 owner 可被识别并清掉。
- `config.json` 损坏时自动备份并重建，尽量捞回登录 token 与设备 ID。

## 0.1.4

### Patch Changes

- Codex / Every Code 将 unknown 模型用量并入同期主导已知模型，减少 unknown 分桶。
- 定价覆盖层落盘缓存，启动可复用上次成功拉取的表，刷新后重建聚合缓存。
- 聚合费用统一按 8 位小数累加，避免分桶先四舍五入到分造成误差。

## 0.1.3

### Patch Changes

- 拿不到 `tud-sync-status` 水位时，历史补报按本地 90 天窗继续上报，避免队列一直 hold。

## 0.1.2

### Patch Changes

- 本地采集与上报窗口扩到 90 天；历史补报在拿不到服务端地板时留队，避免误标已上报。

## 0.1.1

### Patch Changes

- 改进 `jusage service start` 的启动就绪判断，修复 PID 时间戳误判和写盘时序导致的误超时，并增加 `/health` 兜底检查。
- 补齐排行榜相关能力所需的核心数据与配套逻辑。
- 汇总 beta 阶段的稳定性修复，并发布首个 `0.1.1` 正式版。

## 0.1.1-beta.9

### Patch Changes

- fix: `jusage service start` 不再因 PID 时间戳误判 / 写盘过晚而报超时，并以 `/health` 作为就绪兜底
- fix: cli 启动检测失败问题

## 0.1.1-beta.8

### Patch Changes

- fix: some bugs

## 0.1.1-beta.7

### Patch Changes

- fix: some bugs

## 0.1.1-beta.6

### Patch Changes

- fix: reefresh

## 0.1.1-beta.5

### Patch Changes

- feat: ranks

## 0.1.1-beta.4

### Patch Changes

- chore: update

## 0.1.1-beta.3

### Patch Changes

- fix: some bugs

## 0.1.1-beta.2

### Patch Changes

- fix: some bugs

## 0.1.1-beta.1

### Patch Changes

- chore: init

## 0.1.1-beta.0

### Patch Changes

- chore: init
