---
'@juejin-opensource/jusage-core': patch
---

Include WorkBuddy's international edition in the WorkBuddy source by scanning
both the domestic `~/.workbuddy` and international `~/.workbuddy-ai` data
directories. Usage produced by the international edition no longer shows up as
missing in the dashboard.

`session_usage` rows for the same session id across the two edition DBs are
merged before the incremental delta is computed (largest `used` wins), so a
session mirrored in both homes is counted once and a lagging mirror cannot
flip the sqlite cursor back and forth.
