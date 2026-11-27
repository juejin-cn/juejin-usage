---
"@juejin-opensource/jusage-core": patch
---

Use Antigravity CLI's native token counters when available, including cached input and reasoning already included in output. Correct existing session estimates without counting the same conversation twice, and update rewritten completed steps. Skip damaged middle transcript records while retaining completed usage during partial writes, and reduce retained cursor data.
