---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage": patch
---

`jusage sync --source` 与本地 API 的数据源参数现在有明确契约：`all`（含大小写与别名）等同全量同步；未知或拼错的数据源 CLI 以非零码退出并列出全部合法值，本地 API 返回 400（`UNKNOWN_SYNC_SOURCE`），不再静默同步 0 条数据却显示成功、刷新“上次同步”时间。帮助里的数据源列表改为从注册表生成，补上此前缺失的 `dsh`；sync 结果中的 `skipped/error` 会写入日志与终端输出。
