# 读路径试点与固定样本验证

默认仍为 Node/Core。`TUD_API_ENGINE=rust` 只把 **GET `/functions/tud-usage-daily`** 切到 Rust；其他接口和所有写操作继续走现有 Node 代理。未设置或设置为 `node` 即可回到原路径，未知值拒绝启动。

```bash
TUD_API_ENGINE=rust pnpm dev:desktop:tauri
```

## 数据边界

Node/Core 保留定价匹配、旧数据字段规范化、项目名解析和时区转换。它把封存历史日与当天的规范化行作为版本化快照发布，Rust 从快照读取、筛选日期窗口并聚合当天数据；没有新增 HTTP 服务，也没有重新实现所有 Core 规则。

快照使用独立运行时标识、临时文件与原子 rename，POSIX 权限为 0600。生成时不携带账号配置或凭据；运行时标识用于拒绝其他宿主的快照，不应公开快照文件。同步应用期间先使快照失效，所有并行更新结束后才发布；通知前端前完成发布。定价和配置更新、跨日封存也更新快照。

Sidecar 每次重启先删除旧快照，正常退出删除当前快照，退出后的异步任务不能重新发布。Rust 检查 schema、运行时标识、统计日期和新鲜度；超过 90 秒或来自其他运行时的数据报错，不静默回退 Node。每 30 秒刷新一次快照，因此跨日或休眠恢复时可能短暂不可用。

本试点仍需要常驻 Node，不能据此宣称移除了 Node 内存开销。后续端点迁移应分别扩展契约、固定样本和同步失效机制。

## 金样本

先构建 Core 与 host：

```bash
pnpm --filter @juejin-opensource/jusage-core build
pnpm --filter @juejin-opensource/jusage-desktop-tauri build
pnpm --filter @juejin-opensource/jusage-desktop-tauri golden
pnpm --filter @juejin-opensource/jusage-desktop-tauri golden:rust
```

`golden:rust` 在独立的 `tools/read-daily` crate 中编译验证工具，直接复用应用的 Rust daily 源码，不需要 Tauri/WebView 资源，也不进入安装包。Tauri 主程序的 Rust 构建和测试仍需先运行 `pnpm stage:desktop:tauri`。CI 在原生测试后自动执行 Rust 对比；`test:staged` / `test:packaged` 使用实际随包 Node 和 Core 执行同一套金样本。

样本在 `scripts/golden/fixture.json`：固定时间、UTC 进程时区、英文进程 locale、静态定价覆盖、隔离的数据与身份目录，禁用公网 fetch。不启动 parser、Hook、上传、runtime owner 或定时采集。覆盖空数据、多渠道与模型、UTC+8 跨日、采集下界、旧缓存读取、只有封存历史的场景、定价变化以及 `days` 参数边界。

当前 228 个 API 响应覆盖 summary 及别名、daily、hourly、model-breakdown；额外检查三个统计时区的夏令时边界。72 组 daily 同时交给实际 Rust 实现比较。对象键顺序忽略，数组顺序、金额、字段缺失、`null`、状态码和响应结构严格比较，不使用金额容差或批量删除动态字段。

```bash
# 切换候选 Node，或输出抓取结果到本地文件
pnpm --filter @juejin-opensource/jusage-desktop-tauri golden --node /absolute/path/to/node --output /tmp/golden.json
# 只有确认契约变化并审查 diff 后才更新基线
pnpm --filter @juejin-opensource/jusage-desktop-tauri golden --update
```

`--fixture` 只接受人工准备的固定样本，不会读取真实 `~/.ai-usage`。样本自身的输入路径参与项目名规范化，都是虚构值。比较脚本自测会故意改变金额、数组顺序、缺失字段和 null，确认差异能被发现。

## 组件基准

```bash
node apps/desktop-tauri/scripts/benchmark-read-paths.mjs \
  apps/desktop-tauri/src-tauri/target/read-validation/debug/read-daily /tmp/read-benchmark.json
```

用同一份固定样本，对比 Node 回环 HTTP 与 Rust 快照读取/聚合。默认预热 20 次、采样 1000 次；`TUD_BENCH_SAMPLES` 可调整。macOS 同时保留 `/usr/bin/time -l` 的 CPU 和最大 RSS 统计，包含进程启动。

这是组件基准，排除了 Tauri IPC、WebView 和快照发布成本。两个独立进程的 RSS 不能当作整应用节省内存的数字；debug/高负载结果也不能用作发布性能承诺。
