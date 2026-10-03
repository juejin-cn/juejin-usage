# 常见问题

### 本地 90 天用量和线上对不上，怎么强制同步？

需要 Node.js 20+。桌面端和 CLI 共用 `~/.ai-usage`。

```bash
npx @juejin-opensource/jusage@latest upload --force --reconcile
```

### 数据校对提示 `reconcile failed: HTTP 422 INVALID_USAGE_EVENT`？

已知服务端问题（详见 [#178](https://github.com/juejin-cn/juejin-usage/issues/178)）：`/v1/model-usage/reconcile` 在校验事件前会先把 `occurred_at` 做 +8 小时归一化，再检查是否落在目标日期的覆盖窗口内，导致北京时间 16:00 及以后的事件被拒。普通自动同步（ingest）不受此窗口校验问题影响。

云端事件查询的分页游标也存在同类时差：每次翻页可能跳过 8 小时的记录，让实际存在的数据被误报为「线上缺失」，补传后仍然校验失败。客户端现在会把需要分页的查询拆成更小的时间区间，完整读取后再判断差异；无法读全时会停止校准。

如果完整查询后确有线上缺失记录，就通过正常上报接口补齐缺失事件，并回查确认数据一致后才显示成功。事件时间保持原值，已有记录不会被整日删除重建。

如果某天存在数值不一致或线上多余记录，仍需调用整日覆盖接口，可能继续遇到该服务端问题。报错会保留失败日期、事件数和窗口；这类覆盖操作需等待服务端修复后重试。请勿通过调整事件时间或扩大覆盖窗口来绕过校验。

### 客户端提示 `LOCAL_RUNTIME_NOT_READY` 怎么办？

关窗口不会退出（会留在托盘）。先从托盘点 **退出**，再按下面的 case 排查。

**Case 1：刚启动 / 刚自动更新**

等 2 秒，从托盘退出后重开。不要在更新过程中刷新。

- macOS：菜单栏图标 → 右键 **退出**
- Windows：任务栏右下角托盘（可能在 `^` 里）→ **退出**

**Case 2：同时开着 CLI**

```bash
npx @juejin-opensource/jusage@latest service stop
```

然后重开桌面端。

**Case 3：`config.json` 格式坏了（parse 失败）**

```bash
# macOS / Linux
python3 -m json.tool ~/.ai-usage/config.json
# 修不好则备份后让应用重建（需重新登录）
mv ~/.ai-usage/config.json ~/.ai-usage/config.json.bak
```

```powershell
# Windows
python -m json.tool $env:USERPROFILE\.ai-usage\config.json
Move-Item $env:USERPROFILE\.ai-usage\config.json $env:USERPROFILE\.ai-usage\config.json.bak
```

修好或改名后，托盘退出再打开。

**Case 4：残留进程 / 锁文件**

```bash
# macOS / Linux
killall "Juejin Usage" 2>/dev/null; pkill -f jusage || true
rm -f ~/.ai-usage/tud.pid
```

```powershell
# Windows（任务管理器结束 Juejin Usage / jusage 后）
Remove-Item $env:USERPROFILE\.ai-usage\tud.pid -ErrorAction SilentlyContinue
```

然后重开。日志：macOS / Linux `~/.ai-usage/logs/`，Windows `%USERPROFILE%\.ai-usage\logs\`。

### Linux 上 `jusage service start` 失败？

CLI 后台服务在 Linux 上走 systemd 用户服务。若提示 `systemctl --user` 不可用，可改用前台运行：

```bash
jusage start
```

WSL 需先启用 systemd。在 `/etc/wsl.conf` 写入：

```
[boot]
systemd=true
```

然后执行 `wsl --shutdown`，再打开发行版。

排障：

```bash
journalctl --user -u jusage
# 以及
less ~/.ai-usage/logs/daemon.log
```
