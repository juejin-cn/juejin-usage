# 发版与里程碑规范

面向维护者。贡献者只需要看 [Changeset 怎么写](#changeset-怎么写) 一节。

版本遵循 [Semantic Versioning 2.0.0](https://semver.org/lang/zh-CN/)。

## 版本策略

四个包由 [Changesets](https://github.com/changesets/changesets) 管理，各自独立升版，不强制对齐：

| 包 | 路径 | 发布方式 |
| --- | --- | --- |
| `@juejin-opensource/jusage` | `packages/cli` | npm |
| `@juejin-opensource/jusage-core` | `packages/core` | npm |
| `@juejin-opensource/jusage-dashboard` | `packages/dashboard` | `private`，随 CLI 产物与线上 `/aiusage/` 分发 |
| `@juejin-opensource/jusage-desktop` | `apps/desktop` | `private`，产物为 dmg / exe |

`.changeset/config.json` 中 `updateInternalDependencies: patch`，因此 core 一升版，依赖它的三个包会自动收到 patch 级联。

版本号含义：

- **patch** — Bug 修复、文案与样式微调、依赖升级、新增数据源解析器（不改变已有行为）
- **minor** — 新功能、新增 CLI 参数或面板能力、向后兼容的增强
- **major** — 破坏性变更：删改 CLI 参数、变更 `~/.ai-usage/` 数据结构、变更对外 API

> 破坏性变更必须在 changeset 描述里以 `**Breaking:**` 开头，并在 PR 正文中写明迁移方式。

## Changeset 怎么写

每个影响用户的 PR 都要带 changeset。纯文档、CI、注释改动可以跳过。

```bash
pnpm changeset
```

按提示选包 → 选 patch / minor / major → 写描述，会在 `.changeset/` 下生成一个 markdown 文件，**和代码一起提交**。

描述遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的原则：**写这个改动对用户产生了什么影响，而不是你怎么实现的。**

| ❌ 不要这样写 | ✅ 这样写 |
| --- | --- |
| 重构 pricing 匹配逻辑 | 修复 Cursor 模型被误判为 MiniMax 导致费用偏高 |
| 加了个 useMemo | 修复排行榜筛选项在模型重名时重复渲染 |
| 修改 RankFilter 样式 | 统一 Desktop 与 Web 的设置弹窗样式 |

跨端改动要在描述里点明范围，例如「Desktop 与 Web 面板同步修复」。

## 里程碑（Milestone）

一个里程碑对应一次 minor 发布，命名与 tag 一致：`v0.2.0`、`v0.3.0`。

**该挂里程碑的：**

- 计划在该版本内交付的需求 issue 及其 PR
- 阻塞发布的 Bug：崩溃、数据错误、回归

**不该挂的：**

- 提问、使用求助、暂无排期的需求 —— 留在 backlog，不要为了「看起来有规划」塞进里程碑
- 随时可发的 patch 修复

**关闭条件：** 里程碑下所有 issue 已关闭或改挂下一个里程碑，且对应 tag 已发布。发版时未完成的条目一律顺延，保证「里程碑关闭 = 版本已发布」这个等式始终成立。

## 发版流程

### 1. 生成版本号与 changelog

```bash
pnpm version-packages   # changeset version：消费 .changeset/*，更新各包 package.json 与 CHANGELOG.md
```

**必须人工 review 生成的 `CHANGELOG.md`。** changesets 会原样搬运 changeset 描述，措辞问题在这一步改掉，不要等发布后再返工。

以 `chore(release): version packages` 提交，走 PR 合入 `main`。

### 2. 打 tag

```bash
git tag v0.2.0 && git push origin v0.2.0
```

tag 与里程碑同名。

### 3. 发布产物

```bash
pnpm release                 # 构建 CLI 并 changeset publish 到 npm
pnpm release:desktop:mac     # electron-builder → 上传至 GitHub Release
pnpm release:desktop:win
```

`electron-builder.yml` 的 publish 目标是 GitHub，安装包会自动挂到对应 tag 的 Release 上。

### 4. 撰写 GitHub Release

按下方模板填写正文。发布后 [`sync-release.yml`](.github/workflows/sync-release.yml) 会自动把 **tag、标题、正文**同步到 Gitee 发行版。

> ⚠️ 该 workflow **不同步安装包附件**。dmg / exe 需要手动上传到 Gitee 发行版，否则 Gitee 侧用户下载不到。
>
> ⚠️ 若 Job 报 tag 不存在，是 Gitee 镜像尚未同步完 GitHub 的 tag，等几分钟重跑即可。

### 5. 确认自动更新源

Desktop 的更新源默认指向 Gitee（见 [AGENTS.md](./AGENTS.md)）。发布后确认更新源配置已指向新版本，历史做法见 `chore(release): point auto-update feeds to vX.Y.Z` 一类提交。

## Release 正文模板

正文格式：一条一句话，句首用 emoji 标类型，句末带 PR 链接与贡献者。按端分组，端内按重要程度排序 —— 用户最可能关心的放最前面。

emoji 与 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)的分类保持一致：🆕 新功能、🐞 修复、🔌 数据源、💄 样式交互、⚡️ 性能、🛠 重构、🤖 类型、📝 文档、📦 构建、🔒 安全。

```markdown
## 🖥️ Desktop

- 🆕 新增 xxx。[#123](https://github.com/juejin-cn/juejin-usage/pull/123) [@someone](https://github.com/someone)
- 🐞 修复 xxx 导致 xxx 的问题。[#124](https://github.com/juejin-cn/juejin-usage/pull/124) [@someone](https://github.com/someone)

## ⌨️ CLI

- 🔌 新增 xxx 数据源解析支持。[#125](https://github.com/juejin-cn/juejin-usage/pull/125) [@someone](https://github.com/someone)

## 🌐 Web

- 💄 优化 xxx 的展示。[#126](https://github.com/juejin-cn/juejin-usage/pull/126) [@someone](https://github.com/someone)

## 📦 下载

| 平台 | 获取方式 |
| --- | --- |
| macOS (Apple Silicon) | 见下方附件 `*-arm64.dmg` |
| macOS (Intel) | 见下方附件 `*.dmg` |
| Windows | 见下方附件 `*-setup.exe` |
| CLI | `npm i -g @juejin-opensource/jusage` |

**Full Changelog**: https://github.com/juejin-cn/juejin-usage/compare/v0.1.6...v0.2.0
```

若某一端本次无改动，删掉对应分组，不要留空标题。

## 标签约定

| 标签 | 用途 |
| --- | --- |
| `type: bug` | 已确认的缺陷 |
| `type: feature` | 新功能与增强 |
| `type: docs` | 文档 |
| `surface: desktop` / `surface: cli` / `surface: web` | 受影响的端，与分支命名的 `<end>` 保持一致 |
| `need more info` | 缺少复现信息，等待作者补充；14 天无回应则关闭 |
| `good first issue` | 适合新贡献者，issue 内需写清楚要改哪些文件 |
| `help wanted` | 欢迎社区认领 |
| `duplicate` / `wontfix` | 关闭前必须说明理由并给出指向 |
