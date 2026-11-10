# Grok Bot 订阅额度

Grok Bot 是独立客户端。本适配读取它自己的当前登录账号，不依赖 Cursor 安装或 Grok Build CLI，也不从另一个产品的登录态回退。仅接入订阅额度，不新增 Token 日志采集。

## 使用

在 Grok Bot 中登录，然后在本地面板的订阅区域查看「Grok Bot」。macOS 首次读取加密凭据时，点击卡片刷新并按系统提示允许钥匙串访问。应用启动或窗口聚焦不会主动请求新的钥匙串授权。Windows 使用当前系统用户的 DPAPI 解锁该客户端的 OSCrypt 密钥。

当前提供 macOS 和 Windows 加密存储适配。Linux 加密钥匙环尚未适配。未找到凭据文件时不展示卡片；已找到凭据但未登录、解密失败、网络错误或没有个人额度时保留提示。

## 数据来源

官方 [Grok Bot 文档](https://docs.x.ai/grok-bot/get-started) 与 [设置说明](https://docs.x.ai/grok-bot/settings-and-notifications) 说明登录和额度入口。本次还核对本机 Grok Bot 0.79.3 应用资源中的 secret-store、DashboardService 和 weekly-usage 实现。

- 凭据：系统应用数据目录下的 `Grok Bot/sand-secrets.json`。
- 选择 `cursor-accounts` 的 `active` 账号；支持旧版顶层凭据格式。已退出时不回退到其他账号。
- macOS：`Grok Bot Safe Storage` / `Grok Bot Key`；Windows：该目录的 `Local State` 与当前用户 DPAPI。
- 接口：`https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus`，Connect JSON POST，Bearer 身份验证，保留所选团队上下文。
- 只展示服务端确认的个人每周/试用额度。组织共享额度、缺失额度不显示为 0%。试用到期不视为周期重置。不推断新老套餐差异或额度上限。

凭据仅在本机读取，不刷新登录令牌、不修改 Grok Bot 文件、不输出原始凭据/服务端错误。缓存最多 60 秒，凭据变化会失效；请求过程中切换账号或退出后，旧响应不会展示。网络请求拒绝重定向，10 秒超时，沿用运行时现有订阅 transport。

## 验证边界

使用合成凭据验证加解密、账号切换、网络失败和本地 API；未解锁本机真实账号做已登录额度验收。无凭据请求已确认接口返回 HTTP 401 和 Connect JSON 的未登录错误。Windows 加解密单元测试不等同于 Windows 实机验证。未自动操作浏览器。
