---
"@juejin-opensource/jusage-core": minor
"@juejin-opensource/jusage-dashboard": patch
"@juejin-opensource/jusage-desktop": patch
"@juejin-opensource/jusage-desktop-tauri": patch
---

Add a Runtime tool picker with default model selection, compact integration cards, and reversible configuration for MiniMax Code, Pi, and the Claude Code VS Code extension alongside Claude Code, Codex, ZCode, and OpenCode. Add guided Claude Desktop setup without modifying its configuration or claiming a verified connection.

Display local tool cards in a responsive grid with three full-width columns on desktop, two on smaller windows, and one on narrow screens. Label the entry “添加本地工具”.

Match the local tool picker to the compact supplier picker and distinguish installed tools from leftover configuration. Detect executable CLIs, valid desktop app bundles and VS Code extension manifests, with cached login-shell PATH discovery and explicit refresh. Keep uninstalled integrations removable.
