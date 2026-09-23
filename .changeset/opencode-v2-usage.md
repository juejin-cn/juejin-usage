---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage": patch
"@juejin-opensource/jusage-desktop": patch
---

修复 OpenCode 2.0 及之后新产生的用量没有进入统计的问题。下次同步会把当前统计范围内尚未记过的模型调用和上下文压缩补进来；已经统计过的历史不会重复计算。CLI 与 Desktop 使用同一份采集逻辑。
