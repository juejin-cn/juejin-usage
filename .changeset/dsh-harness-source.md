---
"@juejin-opensource/jusage-core": minor
"@juejin-opensource/jusage": minor
"@juejin-opensource/jusage-desktop": minor
---

新增 DeepSeek Harness（dsh）用量采集：读取 `~/.dsh/sessions/**/session.jsonl(.zstd)`，按消息增量去重统计 input/output/cache-read/cache-write token、模型与项目，支持多帧 zstd、明文日志与模型回退。
