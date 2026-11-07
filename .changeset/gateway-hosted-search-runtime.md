---
"@juejin-opensource/jusage-core": patch
---

新增与供应商无关的网关内置搜索执行层，统一四种客户端协议的搜索声明、执行循环、来源结果和历史回放，避免 Codex 通过 Chat/Messages/Gemini 上游时仅因携带 web_search 就触发协议转换错误。保留原生直通及客户端自定义工具，搜索后端不可用时如实返回工具失败结果。
