---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage": patch
"@juejin-opensource/jusage-desktop": patch
---

修复云端查询分页游标的时差导致记录漏读、误报线上缺失和反复校准失败的问题。需要分页时按时间区间拆分查询，确认数据完整后再校验，无法读全时停止校准。

确有缺失时通过正常上报补齐并回查确认；校准期间新增的本地用量不会被误标为已同步。存在数值不一致或线上多余记录时仍使用整日覆盖，依赖服务端修复时区校验问题。
