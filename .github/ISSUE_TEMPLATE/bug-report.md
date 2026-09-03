---
name: 🐞 Bug 报告
about: 报告一个可复现的问题
title: '[Bug] '
labels: ['bug']
assignees: ''
---

<!--
感谢反馈！请完整填写以下信息。
缺少「端 / 版本 / 复现步骤」的 issue 我们无法定位，会被标记 need more info，14 天无回应将关闭。

不确定是不是 Bug、或只是想问用法？请走 Discussions：
https://github.com/juejin-cn/juejin-usage/discussions
-->

### 🖥️ 受影响的端

<!-- 勾选所有出现问题的端；不确定就只勾你实际在用的那个。 -->

- [ ] Desktop（桌面客户端）
- [ ] CLI（`jusage` 命令行）
- [ ] Web（<https://juejin.cn/aiusage/>）

### 📌 版本

<!--
CLI：jusage --version
Desktop：设置 → 关于
Web：无需版本号，写上你访问的日期
-->

### 💻 运行环境

| 项 | 值 |
| --- | --- |
| 操作系统 | <!-- 如 macOS 15.3 / Windows 11 23H2 / Ubuntu 24.04 --> |
| Node 版本 | <!-- node -v，要求 >= 20；Desktop / Web 可不填 --> |
| 安装方式 | <!-- npm i -g / dmg / exe / 源码构建 --> |

### 🔌 涉及的数据源

<!--
哪个 AI 工具的用量数据出了问题？如 Claude Code / Codex / Cursor / Copilot / Gemini / Cline / Zed 等。
与具体数据源无关（比如面板样式问题）请写「无关」。
-->

### 🔁 复现步骤

<!-- 请写成别人照着做就能复现的步骤。 -->

1.
2.
3.

### 🎯 期望结果

### 💥 实际结果

<!--
附上截图或完整报错文案。
日志在 ~/.ai-usage/logs/ 下：daemon.log（本地服务）、sync.log（云端同步）、notify.log（通知）。
贴关键片段即可，注意先去掉里面的敏感信息。
-->

### ✅ 提交前自查

- [ ] 我已搜索过[已有 issue](https://github.com/juejin-cn/juejin-usage/issues?q=is%3Aissue)，没有重复
- [ ] 我已阅读 [FAQ](https://github.com/juejin-cn/juejin-usage/blob/main/FAQ.md)
- [ ] 我确认**没有同时运行 Desktop 和 CLI**（两者共用 `~/.ai-usage/` 与同一个本地服务，同时开会互相抢占，常见表现就是 `LOCAL_RUNTIME_NOT_READY`）
