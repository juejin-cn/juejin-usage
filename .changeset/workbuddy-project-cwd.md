---
"@juejin-opensource/jusage-core": patch
---

修复 WorkBuddy 用量的项目归属：此前所有 WorkBuddy 用量都固定归到 `unknown` 项目——SQLite 兜底查询明明已取回 `sessions.cwd` 却未使用，JSONL 明细路径也未解析项目。现在两条路径都通过 `sessions` 表的工作目录解析真实项目名（目录不存在回退 basename，cwd 缺失/为空保持 `unknown`），项目维度报表对 WorkBuddy 生效。
