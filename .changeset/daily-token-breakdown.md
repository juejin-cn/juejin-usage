---
'@juejin-opensource/jusage-core': patch
'@juejin-opensource/jusage-dashboard': patch
'@juejin-opensource/jusage-desktop': patch
---

Token 趋势图的「输入 / 输出 / 缓存」改用真实用量：日视图此前按固定比例（总量 × 0.78 等）推算构成，小时视图则把缓存读取截断到未缓存输入之内，缓存几乎显示不出来。现在日粒度接口直接给出这三项，两个视图口径一致；「总 Token」曲线也改用该行真实总量。数据源未提供明细时（目前只有线上用量页会遇到）图表会注明「构成为估算值」，不再当作实测值展示。
