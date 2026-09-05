# @juejin-opensource/jusage-desktop

Electron 桌面客户端：与 CLI 共用 `~/.ai-usage` 数据，主进程直接跑 `@juejin-opensource/jusage-core`。

## 当前能力

- 主进程嵌入 Core：`loadConfig` → 注册 Claude/Codex Hook → sync → `BucketStore` → 5 分钟轮询 + `notify.signal` 驱动采集
- 共用同一份 `~/.ai-usage/bin/notify.mjs`（纯信号，不 spawn CLI）；由桌面独占 `tud.pid` 执行 sync/上报
- 启动时优先清掉 CLI（含 launchd / Windows 计划任务自启）并强制抢占 runtime，不再降级为 observer
- 心跳文件 `~/.ai-usage/tud.heartbeat`：运行中续期；runtime 挂掉会自动拉起。对端桌面心跳过期时，新实例会 kill 旧进程再启动
- `config.json` 损坏时自动备份为 `config.json.bak.<ts>` 并重建（尽量捞回登录 token）
- 通过 **内存 Hono local-api**（不占 :8452）经 IPC 向渲染层提供与 CLI 相同的 `/functions/tud-*` 契约
- Dashboard / 设置读同一本地 queue，默认关闭 mock

## 启动

```bash
# 真实本地数据（默认）
pnpm dev:desktop

# 仅 UI 联调样本 fixtures
pnpm --filter @juejin-opensource/jusage-desktop dev:mock

# 构建
pnpm build:desktop

# 打包 macOS / Windows
pnpm build:desktop:mac
pnpm build:desktop:win
```

## 与 CLI 的关系

| | CLI (`jusage start`) | Desktop |
|--|--|--|
| 数据目录 | `~/.ai-usage` | 同左 |
| Hook | 同一 `notify.mjs` | 同左（启动时自动注册） |
| 读数方式 | HTTP `:8452` | 主进程 Core + IPC |
| Sync / poll | owner 时有；遇桌面 owner 则观察模式 | 启动即 owner：先停 CLI 再独占 sync |

同一时刻只有一个进程通过 `tud.pid`（JSON：`{pid,kind}`，`kind` 为 `cli` | `desktop`）做 sync/upload。打开桌面端会停止 CLI 服务与开机自启并接管；之后若再手动 `jusage start`，CLI 只开面板读数（观察模式），不抢占 runtime、不重复上报。

## 技术栈

- electron 35.4.0（Node 22.15，主进程可用 `node:sqlite`）+ electron-vite ^5（Vite 6）
- React 19 + TanStack Router（与 jusage-dashboard 一致）
- Tailwind CSS v4 + HeroUI v3
- electron-builder（macOS + Windows）

## 目录

```
apps/desktop/
├── electron.vite.config.ts
├── electron-builder.yml
├── src/main/
│   ├── index.ts            # 生命周期 + 启动 local runtime
│   ├── local-runtime.ts    # jusage-core 运行时（无 HTTP 端口）
│   ├── local-api-ipc.ts    # IPC → 内存 local-api
│   └── DesktopWindow.ts
├── src/preload/index.ts    # window.tud（窗口控制 + api.request）
└── src/renderer/           # 与 dashboard 同构 UI
```

## 数据层

- 默认 `VITE_ENABLE_MOCK_DATA=false`：走 IPC → Core
- `dev:mock`：仓库 sample fixtures 兜底（无本地数据时看 UI）
- Renderer 的 `api.ts`：存在 `window.tud.api` 时用 IPC，否则回退 `fetch`（兼容非 Electron 场景）

## 窗口外观

- macOS：隐藏标题栏，保留红绿灯
- Windows / Linux：无边框
- `window.tud`：最小化 / 最大化 / 关闭 + `api.request` / `onDataSynced`

## 待统一规划

- 顶层菜单与窗口拖拽区域
- Windows 代码签名 / macOS 公证（发版前按团队现有证书流程配置）

## 自动更新发布

正式安装包使用 `electron-updater` 从
[Gitee juejin-cn/juejin-usage 仓库 `releases/` 目录](https://gitee.com/juejin-cn/juejin-usage/tree/main/releases)
检查更新；安装包二进制发布在
[GitHub Releases](https://github.com/juejin-cn/juejin-usage/releases)
（全量留档），并**必须再手动上传到**
[Gitee 发行版](https://gitee.com/juejin-cn/juejin-usage/releases)
（国内下载页 + 自动更新 `files.url`）。Gitee 附件配额 1G，只能留最新一套：先删旧版附件，再删旧版 Release，再传新包。
应用启动后立即检查一次，之后每 6 小时检查；yml 的 `version` 用 semver 与已装版本比较，
**只有远程更高才提示更新**（相等或更低忽略，禁止降级）。发现新版本后不会弹出对话框，顶部工具栏“关联掘金”左侧显示“下载并更新”按钮；用户也可在设置的“应用更新”区域操作，该区域不再显示“跳过此版本”按钮。已有跳过记录仍兼容，
手动检查更新可清除旧记录并重新选择更新。点击“下载并更新”后会在顶部按钮原位和设置中展示下载进度，下载完成即自动停止本地 runtime、放开
主窗口和托盘气泡的关窗拦截，再重启并安装。新版本首次启动时会通过 Toast 提示更新完成。开发模式不会访问更新服务。
如果重启安装未在限定时间内完成，应用会恢复本地 runtime 和关到托盘行为，重新打开主窗口，并在
设置的“应用更新”区域仍提供“重启并更新”按钮供用户手动重试。
检查完成后，无新版本时不显示额外提示，有新版本时仅显示“最新版本：v版本号”；下载进度和错误提示仍正常显示。

发版前先提高 `apps/desktop/package.json` 的 `version`。版本包含预发布段（例如
`0.1.1-beta.8`）时进入预发布更新通道；稳定版本使用普通 Release。

设置具备 GitHub Releases 写权限的 `GH_TOKEN` 后，在对应系统执行：

```bash
# macOS：构建、签名、公证并上传 dmg/zip、blockmap 和 latest-mac.yml
pnpm release:desktop:mac

# Windows：构建并上传 NSIS/portable、blockmap 和 latest.yml
pnpm release:desktop:win
```

`electron-builder.yml` 的 `publish` 仍然指向 GitHub Release，所以上一步只会把
dmg/zip/exe、blockmap、`latest*.yml` 推到 GitHub。客户端检查更新从 Gitee 拉
`releases/*.yml`，真正下载走 yml 里的 `files.url`（当前为 Gitee 发行版直链）。
因此需要把 `latest.yml`、`latest-mac.yml`、`beta.yml`、`beta-mac.yml` 写进
Gitee 镜像的 `main` 分支 `releases/` 目录（只 push GitHub `main` 即可），
并把 `files.url` 指到 Gitee 附件的实际文件名（网页上传常带空格，url 里写成 `%20`）。
Gitee 发行版必须手动传安装包；Action 不同步附件。配额只够一套，发新版前先清旧附件再删旧版本。

两个平台可以向同一个版本的 GitHub Release 追加产物。GitHub Release 上的安装包及
`.blockmap` 不要删。Gitee 端 `releases/` 目录需要保留上述 yml；安装包不必再拷进
该 git 目录。换下载渠道时只改四个 yml 的 `files.url` 再 push `main`。
electron-builder 默认先创建 Draft；两个平台上传并验收完成后，再到 GitHub 将 Draft
发布。beta 版本应勾选为 Pre-release，稳定版本发布为普通 Release，避免客户端看到
产物不完整的版本。
公开发布 Windows 自动更新前应补齐代码签名；portable 包仍可手动下载，但自动更新
安装使用 NSIS 产物。

## 已知环境差异

### Electron 二进制下载

pnpm 10 默认屏蔽 native build scripts（`onlyBuiltDependencies` 白名单）。
仓库根 `package.json` 已把 `electron` 加入白名单；`apps/desktop/.npmrc`
进一步允许 pre/post scripts。

`apps/desktop/.npmrc` 已配置国内镜像（`electron_mirror` /
`electron_builder_binaries_mirror`）。若仍下载失败，可临时覆盖：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
pnpm dev:desktop
```
