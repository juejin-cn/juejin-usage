<p align="center">
  <img src="./assets/icon.png" alt="Juejin Usage logo" width="200">
</p>

<p align="center">
  Token 用量明细追踪工具，本地记录、云端同步，<br>还有线上排行榜看看谁用得最多。
</p>

<p align="center">
  <a href="https://github.com/juejin-cn/juejin-usage">
    <img src="https://img.shields.io/github/stars/juejin-cn/juejin-usage?style=flat-square" alt="stars">
  </a>
  <a href="https://github.com/juejin-cn/juejin-usage/issues">
    <img src="https://img.shields.io/github/issues/juejin-cn/juejin-usage?style=flat-square" alt="issues">
  </a>
  <a href="https://github.com/juejin-cn/juejin-usage/releases">
    <img src="https://img.shields.io/github/downloads/juejin-cn/juejin-usage/total?style=flat-square" alt="downloads">
  </a>
  <a href="https://github.com/juejin-cn/juejin-usage/releases/latest">
    <img src="https://img.shields.io/github/v/release/juejin-cn/juejin-usage?include_prereleases&style=flat-square" alt="release">
  </a>
  <a href="https://github.com/juejin-cn/juejin-usage/commits/main">
    <img src="https://img.shields.io/github/last-commit/juejin-cn/juejin-usage?style=flat-square" alt="last-commit">
  </a>
</p>

<p align="center">
  <a href="https://github.com/juejin-cn/juejin-usage/releases">下载安装包</a>
  ·
  <a href="https://juejin.cn/aiusage/rank">排行榜</a>
  ·
  <a href="./FAQ.md">常见问题</a>
  ·
  <a href="#-用户隐私协议">用户隐私协议</a>
  ·
  <a href="https://juejin.cn">稀土掘金</a>
</p>

## 🖥️ 客户端使用

Juejin Usage 提供 macOS / Windows 桌面客户端，安装即用，无需额外配置。

### 下载安装

前往 [Releases](https://github.com/juejin-cn/juejin-usage/releases) 页面下载对应系统的安装包（macOS 按芯片选 `.dmg`，Windows 选 `.exe`），安装即用。

> 💡 macOS 提示「已损坏」？在终端执行 `sudo xattr -dr com.apple.quarantine` 后把应用拖入终端窗口即可。

### 首次启动

1. 打开 **Juejin Usage** 应用
2. 首次运行会自动尝试注册 Claude / Codex Hook 并同步本地用量
3. 面板将自动弹出，展示用量趋势、模型分布等数据

如未检测到 Claude / Codex 等 Agent 工具，请确认已安装并使用过至少一次。

### 桌面宠物（可选）

在面板「设置」中点击「桌面宠物」，打开 「显示桌面宠物」，提供 3 个可选的宠物

|            Click             |            Yoyo            |             Hawking              |
| :--------------------------: | :------------------------: | :------------------------------: |
| ![Click](./assets/click.png) | ![Yoyo](./assets/yoyo.png) | ![Hawking](./assets/hawking.png) |

在「设置 → 桌面宠物」中点击「打开宠物目录」，将自定义宠物包放入 `~/.ai-usage/pets/`。每次打开设置都会自动扫描该目录；设置保持打开时，可点击「刷新」重新读取。列表会显示每只宠物的 idle 预览；校验失败的包会标为「无效」且不可选。每只宠物使用独立子目录，结构如下：

```text
pets/
└── my-pet/
    ├── pet.json
    └── spritesheet.webp
```

首版仅支持 v2 动画包：`spritesheet.webp` 必须是 8×11 格、每格 192×208 px 的 1536×2288 WebP 图集。尺寸不对时可在仓库根执行 `node pets/normalize-spritesheet.mjs <图集路径>`（需 ImageMagick、带 libwebp 的 ffmpeg，或 `cwebp` + ffmpeg/`sips`）强制拉伸到目标尺寸——仅用于通过校验；正确动画仍需按格子导出。`pet.json` 示例：

```json
{
  "id": "my-pet",
  "displayName": "我的宠物",
  "description": "自定义桌面伙伴",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp",
  "glow": { "primary": "#7c8cff", "accent": "#69d4ff" }
}
```

`id` 必须唯一，不能和内置宠物重名；删除或替换素材后重新打开设置，或点击「刷新」即可生效。早期测试版位于应用数据目录的宠物包不会自动迁移，请手动移入 `~/.ai-usage/pets/`。

### 登录掘金（可选）

在面板「设置」中点击「掘金登录」，绑定账号后可：

- 多设备用量合并查看
- 参与 [AI 使用排行榜](https://juejin.cn/aiusage/rank)

## ⌨️ CLI 使用

需要 Node.js >= 20。macOS / Windows / Linux 安装后后台启动即可打开本地面板：

```bash
npm i -g @juejin-opensource/jusage
jusage service start
# 面板: http://127.0.0.1:8452
```

国内网络较慢可用 `npm i -g @juejin-opensource/jusage --registry=https://registry.npmmirror.com/`。完整命令、选项与数据说明见 [CLI 使用说明](./CLI.md)。

## 🏆 排行榜

前往 [掘金 AI 使用排行榜](https://juejin.cn/aiusage/rank) 查看排名。

## 🔒 用户隐私协议

本产品采用本地优先架构，数据默认仅存储于您的设备。

- 📊 **本地采集**：Token 用量、模型名称、来源渠道（仅本机存储）
- 🚫 **绝不收集**：对话内容、Prompt 文本、主机名、项目名、API Key
- ☁️ **云端同步**：需您主动开启，仅上报脱敏的 Token 计数与匿名设备标识
- 🔐 **存储安全**：本地数据存储在 `~/.ai-usage/`，云端鉴权采用加密 Token
- 🎛️ **您的控制**：随时可开关云端同步，或删除本地数据目录清除全部记录

> 除了上报您使用的用量总数外，不会采集您任何信息。

具体内容前往点击查看用户隐私协议: 《[稀土掘金用户隐私协议](#)》

## 🛠️ 开发注意事项

需要 Node.js >= 20。克隆后先在仓库根执行 `pnpm install`。

如 `pnpm install` 卡在 electron postinstall

Electron 二进制默认从 GitHub Releases 拉取；国内网络可能会超时

请在安装前设置环境变量：

```bash
# Git Bash / macOS / Linux
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
pnpm install
```

```powershell
# PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
pnpm install
```

## 🤝 贡献指南

- 联系Captain:229199157

源码按 Desktop / CLI / Web 三端贡献。分支规范与本地启动见 [Contributing Guide](./CONTRIBUTING.md)。

- [Desktop](./CONTRIBUTING.md#desktop) — Electron 桌面端
- [CLI](./CONTRIBUTING.md#cli) — 命令行与本地面板
- [Web](./CONTRIBUTING.md#web) — 线上看板

## Contributing

感谢各位掘友们的贡献支持！🎉 提交 PR 即可上榜

<a href="https://github.com/juejin-cn/juejin-usage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=juejin-cn/juejin-usage&max=500&columns=20" alt="Juejin Usage contributors" />
</a>

## 📚 参考项目

- [Token Tracker](https://github.com/xiufengsun/TokenTracker): 自动采集 30 款 AI 编码工具 的 token 用量，用一套漂亮的 Dashboard 看真实成本与趋势。
- [vibe-usage](https://github.com/vibe-cafe/vibe-usage): Token 使用量统计工具（CLI）
- [OpenUsage](https://github.com/robinebers/openusage): The Only AI Usage Tracker That's Truly Yours
- [models.dev](https://models.dev): 模型 Token 计价数据源，内置计价表由此增量同步
