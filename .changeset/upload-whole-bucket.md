---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage": patch
"@juejin-opensource/jusage-desktop": patch
---

修复同一时段在多个项目里使用 AI 工具时，云端（网页统计、排行榜）只记到其中一部分项目、明显少于本地面板的问题：每次同步现在都会上报该时段所有项目的合计。升级后首次同步会自动全量比对一次，把此前少报的时段重新上报纠正。
