<!--
提交前请对照 CONTRIBUTING.md 确认：
- 分支从 main 拉出，也 PR 回 main，命名为 <type>/<end>/<short-desc>
- 影响用户的改动已执行 pnpm changeset，并把生成的文件一起提交
- 下面的信息填完整，维护者 review 通过后合并
-->

### 🏷️ 变动类型

<!-- 勾选一项；如果一个 PR 同时做了好几类事情，考虑拆开提。 -->

- [ ] 🆕 新功能
- [ ] 🐞 Bug 修复
- [ ] 🔌 新增 / 修复数据源解析器（parser）
- [ ] 💄 样式与交互改进
- [ ] ⚡️ 性能优化
- [ ] 🛠 重构
- [ ] 🤖 TypeScript 类型改进
- [ ] 📝 文档改进
- [ ] 📦 构建 / 打包 / 依赖
- [ ] ✅ 测试用例
- [ ] ⏩ 工作流 / CI
- [ ] 🔒 安全修复
- [ ] ❓ 其他（请说明是关于什么的改动）

### 🖥️ 影响范围

<!-- 勾选本次改动实际影响的端。跨端改动请全部勾上，并在下方说明各端的差异。 -->

- [ ] Desktop
- [ ] CLI
- [ ] Web

### 🔗 关联 Issue

<!--
写 close #123 或 fix #123，合并时 GitHub 会自动关掉对应 issue。
没有对应 issue 的话，说明这个改动是怎么来的（自己踩到的坑、群里反馈的、等等）。
-->

### 💡 改动说明

<!--
说清三件事：
1. 原来有什么问题，什么场景下会遇到；
2. 这版怎么改的，为什么选这个方案（如果有其他方案被否掉，也提一句）；
3. 动了 UI 或交互，贴改动前后的对比图或录屏。
-->

### 📝 Changelog

<!--
下表填你在 `pnpm changeset` 里写的那句话，两边保持一致；删掉本次没有改动的包。

这段会原样进入 CHANGELOG 和 Release 说明，是给用户看的 —— 请写「用户能感知到什么变化」，
而不是「我改了哪个函数」。破坏性变更以 **Breaking:** 开头，并在上面的改动说明里写清迁移方式。

纯文档 / CI 改动不需要 changeset，可以整表删掉，写一句「无需 changeset」。
写法可参考 https://keepachangelog.com/zh-CN/1.1.0/
-->

| 包 | 版本类型 | 变更描述（面向用户） |
| --- | --- | --- |
| `@juejin-opensource/jusage`（CLI） | patch / minor / major | |
| `@juejin-opensource/jusage-core` | patch / minor / major | |
| `@juejin-opensource/jusage-desktop` | patch / minor / major | |
| `@juejin-opensource/jusage-dashboard` | patch / minor / major | |

### ☑️ 自查清单

- [ ] 分支命名符合 `<type>/<end>/<short-desc>`（见 [CONTRIBUTING.md](https://github.com/juejin-cn/juejin-usage/blob/main/CONTRIBUTING.md#分支规范)）
- [ ] 已在受影响的端本地自测通过
- [ ] 若改动了面板 UI：已确认 `packages/dashboard/src` 与 `apps/desktop/src/renderer` 这两份同构但独立的代码是否都需要改
- [ ] 已执行 `pnpm changeset`（纯文档 / CI 改动可跳过）
- [ ] `pnpm build` 通过
