# CLI 使用说明

需要 Node.js >= 20。

## 安装

```bash
npm i -g @juejin-opensource/jusage
```

国内网络较慢时，可使用镜像源：

```bash
npm i -g @juejin-opensource/jusage --registry=https://registry.npmmirror.com/
```

也可免安装直接用 `npx`：

```bash
# 后台常驻（推荐，支持开机自启）
npx @juejin-opensource/jusage service start

# 前台运行（当前终端占用，方便看日志，Ctrl+C 停止）
npx @juejin-opensource/jusage start

# 面板: http://127.0.0.1:8452
```

## 快速开始

推荐用后台服务启动（常驻，支持开机自启，macOS / Windows / Linux）：

```bash
jusage service start
# 面板: http://127.0.0.1:8452
```

Linux 后台服务依赖 systemd 用户实例（`systemctl --user`）。无 systemd 时改用 `jusage start` 前台运行。

首次启动会写入数据目录 `~/.ai-usage/`，尝试注册 Claude / Codex Hook，并同步本地用量。

常用管理：

```bash
jusage service status
jusage service stop
jusage status
```

需要前台运行（当前终端占用、方便看日志）时再用：

```bash
jusage start
# Ctrl+C 停止
```

## 命令一览

| 命令 | 说明 |
|------|------|
| `jusage service <action>` | **推荐** 后台服务与开机自启；`action`: `start` \| `stop` \| `status` |
| `jusage` / `jusage start` | 前台启动本地面板与同步 |
| `jusage stop` | 停止当前进程内的前台服务 |
| `jusage status` | 查看 CLI / 面板当前状态 |
| `jusage sync` | 手动同步本地用量数据 |
| `jusage upload` | 上报数据到云端 |
| `jusage help` | 显示帮助 |

## 常用选项

```bash
jusage start --port 8452
jusage start --host 0.0.0.0          # 局域网可访问；默认 127.0.0.1
jusage sync --source=claude          # claude | codex | cursor | all
jusage upload --force                # 忽略云端同步开关，强制上报
jusage upload --reconcile            # 全量对账后上报
```

## 数据与同步

- 数据目录：`~/.ai-usage/`
- Claude / Codex：优先 Hook 触发 `jusage sync`；失败时回退定时轮询
- Cursor：轮询模式（无 Hook）
- 云端同步：面板「设置」可配置 Server 地址、Token 与开关；也可手动 `jusage upload`

调试日志：`~/.ai-usage/logs/notify.log`、`~/.ai-usage/logs/sync.log`。
