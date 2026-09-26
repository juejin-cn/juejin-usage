---
'@juejin-opensource/jusage-core': minor
---

Add WPS Comate usage collection: reads `~/.wpscomate/agent/task-sessions/*.jsonl` (assistant message usage snapshots) with per-file inode/offset cursors, entry-id dedup, project attribution from the session cwd, and `WPS_COMATE_HOME` override support. Registers the `wps-comate` tool across sync, upload, and dashboard/desktop UI.
