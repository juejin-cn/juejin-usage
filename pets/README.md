# 宠物资源

每个子目录是一只可直接安装到 Desktop 的宠物包：

```text
pets/
  <pet-id>/
    pet.json
    spritesheet.webp
```

拉取仓库后，将一个宠物目录复制到本机数据目录即可：

```bash
cp -R pets/<pet-id> ~/.ai-usage/pets/
```

`<pet-id>` 必须与 `pet.json` 中的 `id` 相同。运行时只读取这两个文件：

- `pet.json`：`spriteVersionNumber` 固定为 `2`，`spritesheetPath` 固定为 `spritesheet.webp`。
- `spritesheet.webp`：1536×2288 的 WebP 图集，最大 12MB。

## 尺寸规范化

若图集不是 1536×2288，可用仓库脚本强制拉伸（需本机具备其一：ImageMagick `magick`、带 libwebp 的 ffmpeg、或 `cwebp` + ffmpeg/`sips`）：

```bash
node pets/normalize-spritesheet.mjs ~/.ai-usage/pets/<pet-id>/spritesheet.webp
# 或写出到新文件：
node pets/normalize-spritesheet.mjs ./source.png -o ~/.ai-usage/pets/<pet-id>/spritesheet.webp
```

拉伸只能让包通过扫描器尺寸校验。源图若不是 8×11 格、每格 192×208 的动画表，桌面动画仍会错位；正确流程仍是按格子导出。

请勿在这里提交源文件、预览图或中间产物。每个 PR 只新增或修改一个 `pets/<pet-id>/` 包。
