# Tauri 页面白屏诊断

macOS 的 WKWebView 在部分环境中无法提交回环 HTTP 页面导航。`curl` 能访问、导航回调放行，都不能证明 WebView 已加载页面。判断时区分 `navigation`、`load-started`、`load-finished`、前端模块挂载这几个阶段。

## 前端加载约束

开发和发布都启用 `custom-protocol` Cargo feature，三个窗口使用 `WebviewUrl::App`。开发命令同时带 `--no-dev-server --features custom-protocol`；不使用 Vite HMR，修改前端后重新启动。

macOS/Linux 页面使用 `tauri://localhost`；Windows 使用 Tauri/Wry 的 `http://tauri.localhost` 映射，这不是一个监听回环端口的静态服务器。导航白名单按平台限制这些来源，拒绝 `http://localhost:*`、`http://127.0.0.1:*`。

Rust → Node 的随机回环端口仍用于 API、健康探针；系统浏览器的账号回调也继续使用回环地址。它们不让 WKWebView 导航到回环 HTTP 页面。

## 日志

原生日志位于 Tauri `app_log_dir()/webview.jsonl`，macOS 通常为 `~/Library/Logs/com.juejin.jusage.desktop-tauri/`。日志达到约 1 MB 时轮换为 `webview.previous.jsonl`；开发终端也打印相同事件。

| 最后出现的事件 | 检查方向 |
| --- | --- |
| `navigation-blocked` | 页面来源不符合平台的自定义协议约束 |
| `navigation` / `load-started`，随后 `load-timeout` | 20 秒内未完成原生页面加载；检查协议、嵌入资源、平台 WebView |
| `load-finished`，但没有 `bridge-ready` | 初始化脚本或 Tauri 全局桥未就绪 |
| `resource-error` | 对应资源路径加载失败，检查打包产物和 CSP |
| `script-error` / `unhandled-rejection` | 前端模块执行失败，结合开发工具检查 |
| `dom-ready`，随后 `mount-timeout` | React 根节点 20 秒内仍没有子元素 |
| `app-mounted` | 根节点已有内容；继续检查具体页面数据与样式 |

`app-mounted` 只表示 DOM 已挂载，不代替截图、交互和数据正确性验收。系统休眠或繁忙也可能触发加载超时，事件仅用于诊断，不会强制重载窗口。

日志只保留事件类别、窗口、资源路径和异常类型，省略查询参数、异常消息与调用栈，避免把账号回调信息写进日志。

## 参考项目中的其他回归点

参照 [社区版排障记录](https://github.com/you-want/juejin-usage-tauri/blob/main/apps/desktop-tauri/docs/troubleshooting.md) 核对以下问题：

- **开发期跑到旧 staging**：未打包的 debug 可执行文件只使用 `beforeDevCommand` 本次生成的 `src-tauri/node-app` 与带 target 后缀的 Node，不优先读取可执行文件旁遗留的 `node-app`。判断基于编译输出目录，已打包的 debug 应用仍读取包内资源。
- **Tauri 事件协议漂移**：桥使用 `window.__TAURI__.event.listen`，不手写 `transformCallback` / `plugin:event` 协议；桥测试覆盖异步注册前卸载和数据刷新事件。升级 Tauri 后仍需实机验证。
- **宿主退出后 sidecar 残留**：宿主独占子进程 stdin；入口在 EOF、SIGTERM 或 shutdown 消息时执行限时关闭。此链路不依赖固定端口或强杀同名进程；内核不可中断等待仍不能靠应用层清理解决。
