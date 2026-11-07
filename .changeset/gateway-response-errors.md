---
"@juejin-opensource/jusage-dashboard": patch
"@juejin-opensource/jusage-desktop": patch
"@juejin-opensource/jusage-desktop-tauri": patch
---

Show an actionable restart message when an older local gateway service returns a plain-text 404, instead of exposing the WebView JSON parsing error. Validate gateway response envelopes before reading their data.

Wait for sidecar resource preparation before starting Tauri with dashboard HMR, so switching branches cannot leave the new UI connected to an older gateway backend.
