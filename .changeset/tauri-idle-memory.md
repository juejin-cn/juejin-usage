---
"@juejin-opensource/jusage-core": patch
---

减少未变化游标保存时的临时内存分配。Tauri 托盘面板改为首次打开时创建，隐藏两分钟后释放；增加可选的同步阶段内存记录，便于排查资源占用。
