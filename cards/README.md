# 用量卡片

每个目录是一款卡片，公开维护，欢迎通过 PR 增加样式。

- `card.json`：稳定的 URL 标识 `id`、名称、简介、排序、SVG 尺寸、头像位置。
- `template.svg`：可编辑的 SVG，使用 `{{name}}` 等占位符。只允许自包含 SVG，不使用脚本、事件、外链资源或 foreignObject。

可用占位符：`avatar`（服务生成的头像片段）、`name`、`total`、`cost`、`today`、`input`、`output`、`since`、`subtitle`、`inputPct`、`outputPct`、`totalPct`。除头像外均为已转义文本；数值已格式化。头像尺寸为 0 时不显示头像。

新增样式时，复制一个目录，修改元信息与 SVG，然后运行：

```bash
node scripts/build-usage-cards.mjs
```

将卡片目录和生成的 `packages/core/src/usage-cards.ts` 一起提交。已有 `id` 用于外部链接，请保持稳定。预览时检查长昵称、零用量、大数值和不同头像。

使用方可从 `@juejin-opensource/jusage-core/usage-cards` 导入统一清单和模板。需要独立 TypeScript 资源文件时，运行 `node scripts/build-usage-cards.mjs <输出文件>`；两种方式都由同一份卡片目录生成。
