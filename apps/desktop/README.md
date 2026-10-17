# @juejin-opensource/jusage-desktop

Electron 桌面客户端：与 CLI 共用 `~/.ai-usage` 数据，主进程直接跑 `@juejin-opensource/jusage-core`。

## 当前能力

- 主进程嵌入 Core：`loadConfig` → 注册 Claude/Codex Hook → sync → `BucketStore` → 5 分钟轮询 + `notify.signal` 驱动采集
- 共用同一份 `~/.ai-usage/bin/notify.mjs`（纯信号，不 spawn CLI）；由桌面独占 `tud.pid` 执行 sync/上报
- 启动时优先清掉 CLI（含 launchd / Windows 计划任务自启）并强制抢占 runtime，不再降级为 observer
- 心跳文件 `~/.ai-usage/tud.heartbeat`：运行中续期；runtime 挂掉会自动拉起。对端桌面心跳过期时，新实例会 kill 旧进程再启动
- `config.json` 损坏时自动备份为 `config.json.bak.<ts>` 并重建（尽量捞回登录 token）
- 通过 **内存 Hono local-api**（不占 :8452）经 IPC 向渲染层提供与 CLI 相同的 `/functions/tud-*` 契约
- Dashboard / 设置读同一本地 queue

## 启动

```bash
# 启动桌面端
pnpm dev:desktop

# 不读本机账号：Codex / Claude / Cursor 订阅卡片，以及一整年的示例用量
pnpm dev:desktop:mock

# 构建
pnpm build:desktop

# 打包 macOS / Windows
pnpm build:desktop:mac
pnpm build:desktop:win
```

## 测试

使用 Node.js 22.13+（测试会加载 `node:sqlite`），先在仓库根安装依赖并构建 Core：

```bash
pnpm --filter @juejin-opensource/jusage-core build
pnpm --filter @juejin-opensource/jusage-desktop test
```

测试命令会先清理旧的 `dist-test`，编译 `src/**/*.test.ts`，再执行 `dist-test/**/*.test.js`；新增测试无需维护文件列表。

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

- Renderer 的 `api.ts`：存在 `window.tud.api` 时用 IPC，否则回退 `fetch`（兼容非 Electron 场景）

### Copilot 套餐额度

主面板和托盘的订阅区显示 Copilot 套餐剩余额度、内联建议及重置时间，设置中的「订阅渠道」可控制显示。套餐额度独立于 Core 采集的 Copilot Token 用量。

主进程读取 Copilot 官方客户端保存的 `github-copilot/apps.json` / `hosts.json` 中的 OAuth 登录信息；macOS / Linux 默认位于 `~/.config/`，Windows 位于 `%USERPROFILE%\AppData\Local\`，也支持绝对路径 `XDG_CONFIG_HOME`。显式设置的 `GH_COPILOT_TOKEN` / `GITHUB_COPILOT_TOKEN` 优先。凭证仅在主进程使用，IPC 只返回套餐和额度。

存在多个账号时，根据 VS Code `state.vscdb` 的 Copilot 账号记录匹配，无法明确匹配时隐藏卡片，避免展示其他账号余额；自定义 VS Code 数据位置可设置 `VSCODE_STATE_DB_PATH`。仅有 VS Code 加密登录、没有上述可读取的 Copilot 登录信息时，暂不展示额度，不读取系统钥匙串。

额度来自 [VS Code 使用的内部接口](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/chat/common/chatEntitlementService.ts)，成功读数缓存 60 秒，窗口聚焦时刷新。网络异常保留同一账号的最近读数并标为「旧」；账号切换、退出或认证失效后清除旧读数。内部接口变化可能影响可用性。

### Kimi 桌面版与 Kimi Code

订阅区统一显示一张「Kimi」卡片，桌面版和 Code 仅作为底层独立读取来源。优先使用新鲜、带有效额度与套餐名的完整读数；Code 同时提供月度共享额度和滚动限额时可在同一卡片展示，其他情况下优先使用确认的共享额度。一端没有登录或读取失败时，可使用另一端的有效读数；不会拼接不同来源的套餐与额度，也不会把共享池相加。

只登录 Code 时无需打开或登录桌面版。Code 仅请求 main 已验证的 `/usages`，获取 5 小时、周限额及可选月度共享额度；缺失字段不补零，`limit_month_code` 是月度用量构成，不与共享总量相加。两端缓存和账号切换仍独立；Code 首次读取失败、没有有效读数时隐藏卡片，窗口再次聚焦后自动重试。已成功读取的同账号数据可在网络异常时保留并标为「旧」，已确认的 Free 套餐信息、登录或配置异常仍可展示提示并重试。

桌面版数据默认位于 macOS 的 `~/Library/Application Support/kimi-desktop`、Windows 的 `%APPDATA%/kimi-desktop`、Linux 的 `$XDG_CONFIG_HOME/kimi-desktop`（未设置时为 `~/.config/kimi-desktop`），可用 `KIMI_DESKTOP_HOME` 覆盖。支持 `daimon-storage.json` 中的绝对 `shareDir` 迁移路径。

桌面来源的订阅读取需要 Kimi 桌面版正在运行且已登录，通过它的本地 Context IPC 获取当前账号和有效令牌（续期由 Kimi 自身处理），不读取可能在退出后残留的磁盘令牌、不访问系统钥匙串。令牌仅在主进程内存中使用，会员请求只发送到当前账号所属的官方区域（`www.kimi.com` / `www.kimi.ai`）。Code 凭证只访问相应官方区域的 `api.kimi.com/coding/v1` 或 `api.kimi.ai/coding/v1`，不发送到桌面会员接口。缓存按账号、来源和区域隔离，发布读数前再次验证当前账号；退出或认证失效后清除旧额度。

macOS/Linux 自动发现当前用户的私有 Context socket，已退出进程遗留的失效 socket 不影响 Code 读取；Windows 暂需通过 `KIMI_WORK_CONTEXT_IPC` 指定 Kimi 的 Context 命名管道。无法取得当前账号时显示打开 Kimi 的提示，仍可扫描历史用量。该桌面接口为内部接口，已在 macOS Kimi 3.2.15 验证，后续客户端变化可能需要更新适配；Windows/Linux 尚未实机验证。

本地 Token 与项目统计独立读取 `daimon-share/daimon/runtime/kimi-code/home` 中的 `session_index.jsonl` 和 `sessions/**/wire.jsonl`，复用 Kimi Code 的增量解析并去重。上下文占用快照不作为累计消耗；CLI 和 Desktop 可同时采集。内部模型别名没有公开价格时仍使用现有估算兜底，不等同于会员账单。

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
**只有远程更高才更新**（相等或更低忽略，禁止降级）。发现新版本后自动下载，不弹出对话框，也不包含跳过版本的状态、IPC 或偏好存储。
顶部工具栏“关联掘金”左侧和设置中展示下载进度，下载完成即自动停止本地 runtime、放开
主窗口和托盘气泡的关窗拦截，再重启并安装。新版本首次启动时会通过 Toast 提示更新完成。开发模式不会访问更新服务。
如果重启安装未在限定时间内完成，应用会恢复本地 runtime 和关到托盘行为，重新打开主窗口，并在
顶部工具栏和设置的“应用更新”区域提供“更新并重启”按钮，点击一次即可重试，无需重新下载。设置中不再额外显示“自动重启未完成”提示卡片。
更新检查在 runtime 和窗口初始化完成后启动，避免缓存更新与启动流程竞争。退出被取消时保留更新 watchdog 和 IPC；停止 runtime 超时不会让按钮一直等待，也不会让旧尝试的迟到结果触发新一轮安装。
设置中的“检查更新”始终显示在“应用更新”标题右侧，发现更新后在旁边显示与顶部工具栏一致的下载进度或重启按钮，不再另起进度条和下载说明。无新版本时不显示额外提示，更新期间单独显示“最新版本”一行，与“当前版本”的标签和版本号使用相同字体、字号和左右对齐方式；错误提示仍正常显示。

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

## Codex / Claude 订阅额度

桌面端从本机登录状态读取订阅额度：

- Codex 从 `CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）只读获取 ChatGPT 登录凭据，请求 `/backend-api/wham/usage`，无需安装或启动 Codex CLI。不会刷新令牌或改写登录文件；令牌失效时提示重新登录。
- Codex 额度请求使用 Electron 网络栈，支持系统代理与 PAC，不携带浏览器会话 Cookie。临时网络失败后，窗口再次聚焦会自动重试（一分钟缓存限制频率），也可手动刷新；认证过期或访问受限时仍等待手动处理。
- Claude 使用本机 Claude Code 的 `-p /usage --output-format json`；在临时目录运行，关闭工具、MCP、用户/项目 settings 和会话保存，应用不读取 Keychain 或调用 Anthropic OAuth usage 接口。官方账户校验仍排除自定义 provider。
- 两个渠道共享主窗口与托盘的一分钟内存缓存、合并并发请求；账号改变或认证失效时不沿用旧额度。临时失败可显示同账号上次额度和旧数据标记。
- 有登录记录但读取失败时保留卡片并展示原因；没有登录记录的渠道隐藏。

订阅网络回归测试不创建窗口、不读取真实登录文件、不访问真实账号接口。先按上文编译 Desktop 测试，再执行：

```bash
# 在 apps/desktop 目录中
pnpm exec electron scripts/test-subscription-network.cjs
```

该测试使用临时 Electron 用户目录和本地模拟代理，覆盖代理路由、Codex 额度解析、Cookie 隔离、重定向拒绝和超时中止。

### DeepSeek Harness 余额

优先只读 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）中的官方账号 grant，通过 `platform.deepseek.com/api/v0/users/get_user_summary` 读取 CNY 充值与赠送余额；不会刷新、覆盖或删除 Harness 凭证。未找到账号 grant 时兼容 Harness 的 `refs.DEEPSEEK_API_KEY`，再回退到原有 DeepSeek / OpenCode 凭证。显示接口返回的真实余额。

### Qoder App 额度

兼容旧版 CLI 的 `~/.qoder/.auth/user` 与 Qoder App 的 `auth.v1.dat`。App 使用 `/sash/api/v2/me/usage` 读取套餐、资源包等独立额度，零容量套餐保留为 `0/0`，不显示为剩余 100%。登录凭据仅在主进程内存中使用，请求限定到 `https://openapi.qoder.sh`，不跟随重定向，不使用或刷新 refresh token，不改写 Qoder 文件。

macOS App 数据默认位于 `~/Library/Application Support/com.qoder.app.stable`。每次启动 Usage 后首次点击 Qoder 卡片的刷新按钮，会通过系统钥匙串请求读取 `Qoder App Safe Storage`（账号 `Qoder App Key`，区别于旧 IDE 的 `Qoder Safe Storage`）；是否允许由 macOS 控制，失败时显示重试提示。成功后密钥仅在当前进程内缓存，窗口聚焦不会重复请求授权。Windows 从 `%APPDATA%/com.qoder.app.stable` 读取，并使用 Electron 的系统解密接口；该路径尚需 Windows 实机验证。Linux 的 App 加密凭据暂不支持，旧 CLI 路径保持兼容。

账号切换、退出、凭据失效后清除旧额度；临时网络失败仅保留当前账号的最近读数。Qoder App 应自行维护登录有效性；过期时打开 Qoder 更新登录状态。该适配依据 Qoder App 0.4.3 的内部接口，后续版本可能需要调整。
