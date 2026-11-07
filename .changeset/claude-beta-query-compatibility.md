---
"@juejin-opensource/jusage-core": patch
"@juejin-opensource/jusage-desktop-tauri": patch
---

Accept the Anthropic SDK's `?beta=true` on the gateway Messages endpoint so Claude Code does not report a configured model as unavailable before inference. Preserve authentication and reject unrelated query parameters.
