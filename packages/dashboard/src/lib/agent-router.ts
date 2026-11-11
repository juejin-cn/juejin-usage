import type { RouterPreset } from '@juejin-opensource/jusage-core/agent-router/presets';
import type { AgentGateway, AgentRouterConfig, LocalLoginStatus, SubscriptionState } from '@juejin-opensource/jusage-core/agent-router';
export function hasAgentRouter(): boolean {
  return typeof window !== 'undefined' && (window as unknown as { tud?: { runtime?: string } }).tud?.runtime === 'tauri';
}

export interface AgentRouterSnapshot extends ReturnType<AgentGateway['status']> {
  archive?: { directory: string; enabled: boolean; error: string | null; pending: number; maxBytes: number; maxBodyBytes: number };
  history: { error: string | null; pending: number };
  config: AgentRouterConfig;
  presets?: RouterPreset[];
  error: string | null; credentialError?: string | null; providers: Array<{ id: string; ready: boolean; saved?: boolean; subscription?: SubscriptionState }>; localLogins: LocalLoginStatus[];
}
export async function routerRequest<T>(path = '', init?: RequestInit): Promise<T> {
  if (!hasAgentRouter()) throw new Error('AgentRouter 仅在 Tauri 客户端提供');
  const response = await fetch('/functions/tud-agent-router' + path, init);
  return readRouterResponse<T>(response);
}

/** Older sidecars return a plain-text 404; don't expose WebView JSON errors. */
export async function readRouterResponse<T>(response: Response): Promise<T> {
  let value: unknown;
  try { value = await response.json(); }
  catch {
    if (response.status === 404) throw new Error(routerErrorMessage('ROUTE_NOT_FOUND'));
    throw new Error(`本地网关响应无效（HTTP ${response.status}），请重启客户端后重试。`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('本地网关响应格式无效，请重启客户端后重试。');
  }
  const body = value as { success?: unknown; data?: T; message?: unknown };
  if (!response.ok || body.success !== true) {
    throw new Error(routerErrorMessage(typeof body.message === 'string' ? body.message : 'AGENT_ROUTER_FAILED'));
  }
  if (!Object.hasOwn(body, 'data') || body.data === undefined) {
    throw new Error('本地网关响应缺少数据，请重启客户端后重试。');
  }
  return body.data;
}
const messages: Record<string, string> = {
  ARCHIVE_NOT_FOUND: '该请求详情已被清理或尚未归档。',
  ARCHIVE_CURSOR_EXPIRED: '日志列表已更新，请刷新后继续查看。',
  ARCHIVE_READ_FAILED: '读取请求详情失败，请检查本地日志文件。',
  ARCHIVE_WRITE_FAILED: '请求详情写入失败，请检查磁盘空间和目录权限。',
  ARCHIVE_QUEUE_FULL: '请求详情写入队列已满，部分记录未保存。',
  INVALID_ARCHIVE_ID: '请求日志标识无效。',
  INVALID_ARCHIVE_CURSOR: '请求日志分页标识无效，请刷新。',
  INTEGRATION_FORMAT_UNSUPPORTED: '无法识别工具配置格式，请检查配置文件或手动接入。',
  INTEGRATION_PATH_UNSUPPORTED: '工具配置目录必须是绝对路径，请检查环境变量。',
  INTEGRATION_PATH_UNSAFE: '配置路径是符号链接或权限不匹配，请手动接入。',
  INTEGRATION_PATH_CHANGED: '工具配置目录已变更，请先恢复原路径并关闭旧接入。',
  INTEGRATION_CONFLICT: '工具或用户修改了接入字段，已保留当前文件，未覆盖外部修改。',
  INTEGRATION_RECOVERY_CONFLICT: '上次写入未完成且文件已变更，请检查配置后重试清理。',
  INTEGRATION_STATE_INVALID: '工具配置备份无法读取，未修改任何工具配置。',
  INTEGRATION_WRITE_FAILED: '写入工具配置失败，请检查文件权限后重试。',
  INTEGRATION_NO_MODELS: '没有可用模型，请先登录供应商并开放模型。',
  INTEGRATION_MODEL_UNAVAILABLE: '部分模型已不可用，请刷新后重新选择。',
  INTEGRATION_NOT_INSTALLED: '未检测到该工具，请安装或启动一次后刷新。',
  INTEGRATION_CONFIG_TOO_LARGE: '工具配置文件过大，请手动配置。',
  INTEGRATION_MANUAL_ONLY: '此工具或平台暂不支持自动配置，请使用手动接入。',
  INTEGRATION_INVALID_SELECTION: '模型选择无效，请刷新后重试。',

  SUBSCRIPTION_TIMEOUT: '额度查询超时，请稍后刷新重试。',
  SUBSCRIPTION_ADAPTER_UNAVAILABLE: '账户服务暂不可用，请重启客户端后重试。',
  ROUTER_BUSY: '网关正在处理其他操作，请稍后重试。',
  INVALID_SUBSCRIPTION: '渠道预设、协议或登录方式不匹配。若刚更新应用，请重启后重新选择工具。',
  INVALID_PRESET: '当前渠道配置与工具预设不匹配，请重新选择工具。',
  SUBSCRIPTION_REFRESH_FAILED: '账号续期失败，请稍后重试或重新登录。',
  SUBSCRIPTION_INPUT_INVALID: '请检查登录选项、必填项或验证码后重试。',
  SUBSCRIPTION_ZCODE_LOGIN_EXPIRED: 'ZCode 授权已过期，请重新登录并在有效期内完成浏览器授权。',
  SUBSCRIPTION_ZCODE_LOGIN_DECLINED: 'ZCode 授权被拒绝，请确认选择的是 Z.ai 或智谱对应的账户后重试。',
  SUBSCRIPTION_ZCODE_LOGIN_RESPONSE: 'ZCode 授权响应缺少必要信息，请重新登录；若仍失败，请更换登录方式。',
  SUBSCRIPTION_ZCODE_DESKTOP_SIGNED_OUT: '未读取到本机 ZCode 登录，请先登录 ZCode 客户端，或改用浏览器登录。',
  SUBSCRIPTION_ZCODE_TEAM_UNAVAILABLE: '此账户没有可用的团队套餐席位，请联系团队管理员，或选择个人套餐登录。',
  SUBSCRIPTION_ZCODE_PROJECT_UNAVAILABLE: '此账户没有可创建 API Key 的项目，请在对应平台检查项目及权限。',
  SUBSCRIPTION_ZCODE_PLAN_UNAVAILABLE: '此账户没有可用的 GLM Coding Plan，且 ZCode Start Plan 已结束或尚未开通。',
  SUBSCRIPTION_ZCODE_PLAN_FAILED: '浏览器授权后读取套餐失败，请确认对应平台的套餐状态，稍后重试。',
  SUBSCRIPTION_ZCODE_NETWORK_FAILED: '连接 ZCode 登录服务失败，请检查网络后重试。',
  SUBSCRIPTION_CLAUDE_NOT_INSTALLED: '未找到 Claude Code，请先安装 Claude Code 并重启应用。',
  SUBSCRIPTION_CLAUDE_SIGNED_OUT: '请先运行 claude auth login 登录订阅账户，或选择 setup-token 登录。',
  SUBSCRIPTION_CLAUDE_ACCOUNT_CHANGED: '本机 Claude Code 账户已切换或退出，请重新添加当前账户。',
  SUBSCRIPTION_CODEX_PORT_BUSY: 'Codex 登录回调端口 1455 被占用，请关闭其他登录窗口后重试。',
  SUBSCRIPTION_ANTIGRAVITY_PORT_BUSY: 'Antigravity 登录回调端口 51121 被占用，请关闭其他授权窗口后重试。',
  SUBSCRIPTION_ANTIGRAVITY_LOGIN_DECLINED: 'Google 授权已取消或拒绝，请重新登录。',
  SUBSCRIPTION_ANTIGRAVITY_ACCOUNT_UNAVAILABLE: '当前 Google 账号无法使用 Antigravity，请检查账号资格。',
  SUBSCRIPTION_ANTIGRAVITY_PROJECT_UNAVAILABLE: '未获取到 Antigravity 项目，请先在官方客户端完成账号初始化后重试。',
  SUBSCRIPTION_LOGIN_TIMEOUT: '登录授权超时，请重新登录。',
  SUBSCRIPTION_LOGIN_FAILED: '登录未完成或凭据无效，请重新连接。',
  SUBSCRIPTION_LOGIN_URL_INVALID: '插件返回了无效的登录链接。',
  SUBSCRIPTION_MODELS_FAILED: '无法获取该账号的可用模型，请稍后重试。',
  SECURE_STORAGE_UNAVAILABLE: '本机凭据目录不可用，无法保存或恢复登录。请检查 ~/.ai-usage 权限后重启客户端。',
  CREDENTIAL_STORE_UNREADABLE: '已保存的登录信息无法解密或文件异常。原文件已保留，请恢复凭据备份或重新登录供应商。',
  CREDENTIAL_SAVE_FAILED: '加密凭据保存失败，请检查本地目录权限和磁盘空间。',
  CREDENTIAL_INVALID: 'API Key 格式无效。',
  SUBSCRIPTION_CREDENTIAL_SAVE_FAILED: '登录凭据无法保存，请检查 ~/.ai-usage 目录权限。',
  ROUTE_NOT_FOUND: '当前本地网关服务尚未更新，请重启客户端后重试。',
  SAVE_AND_LOGIN_BEFORE_MODELS: '请先开启渠道并登录，再拉取官方模型。',
  MODEL_CATALOG_UNAUTHORIZED: '官方模型接口鉴权失败，请检查渠道凭据。',
  MODEL_CATALOG_UNAVAILABLE: '官方模型列表暂不可用，请检查地址或稍后重试。',
  MODEL_CATALOG_INVALID: '官方接口返回的模型列表格式无效。',
  MODEL_CATALOG_TOO_LARGE: '官方模型列表超出读取上限。',
  STOP_GATEWAY_BEFORE_EDITING: '请先停止网关，再修改供应商或路由。',
  START_GATEWAY_BEFORE_LOGIN: '请先启动网关，再登录供应商。',
  ROUTER_CONFIG_UNREADABLE: '网关配置无法读取，原文件已保留。请检查本地配置。',
  INVALID_ENDPOINT: '请输入 HTTPS 地址；本机测试可以使用回环 HTTP 地址。',
  INVALID_MEMBERS: '路由成员必须是已配置的供应商模型。',
  INVALID_ID: '标识只能包含字母、数字、点、下划线和短横线。',
  INVALID_LIMITS: '并发或超时超出范围；全局并发与等候数之和不能超过 48。',
  INVALID_STRATEGY: '请选择有序或轮转策略。',
  GATEWAY_START_FAILED: '网关启动失败，请检查端口是否被占用。',
  SUBSCRIPTION_DESKTOP_ENCRYPTED: 'WorkBuddy 登录文件已加密，请改用浏览器登录。',
  SUBSCRIPTION_DESKTOP_UNREADABLE: '无法读取本机登录，请打开 WorkBuddy 登录或改用浏览器登录。',
  SUBSCRIPTION_LOGIN_REQUIRED: '请重新登录供应商。',
  SUBSCRIPTION_LOGIN_BUSY: '登录正在进行，可先取消后重新开始。',
  SUBSCRIPTION_FAILED: '供应商登录或请求失败，请重试。',
  SUBSCRIPTION_WORKER_LIMIT: '最多同时保留 8 个订阅会话，请先退出不使用的会话。',
  CREDENTIAL_UNAVAILABLE: '密钥环境变量未设置，请在启动客户端的终端中设置后重启。',
  FORBIDDEN: '管理连接不可用，请在 Tauri 客户端中打开。',
  TEST_TIMEOUT: '90 秒内未返回，已超时。',
  MODEL_NOT_FOUND: '模型不存在或未开放。',
  NO_READY_PROVIDER_FOR_PROTOCOL: '没有可用的供应商处理该模型，请检查登录状态。',
  GATEWAY_STOPPED: '网关未启动。',
  GATEWAY_FAILED: '网关请求失败。',
};
export function routerErrorMessage(code: string) { return messages[code] ?? code; }
export function saveRouter(config: AgentRouterConfig) {
  return routerRequest('/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
}
