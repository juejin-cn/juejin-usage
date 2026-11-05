import type { Protocol } from './config.js';
export const SUBSCRIPTION_IDS = ['claude', 'codex', 'github-copilot', 'cursor', 'grok', 'kimi-work', 'kiro', 'minimax-code', 'minimax-code-global', 'qoder', 'qoder-cn', 'qwenwork', 'qwenwork-enterprise', 'trae-cn', 'trae-global', 'workbuddy', 'workbuddy-ai', 'zcode', 'opencode-zen-free', 'opencode-go', 'volcengine', 'antigravity'] as const;
export interface ChannelCatalogEntry {
  id: typeof SUBSCRIPTION_IDS[number]; name: string; icon: string; protocol: Protocol;
  baseUrl: string; models: string[]; modelsByProtocol: Partial<Record<Protocol, string[]>>;
  methods: Array<{ index: number; type: string; label: string }>;
}
export const CHANNEL_CATALOG: ChannelCatalogEntry[] = [
  {
    "id": "claude",
    "name": "Claude",
    "icon": "claude",
    "protocol": "messages",
    "baseUrl": "https://api.anthropic.com/v1",
    "models": [
      "sonnet",
      "opus",
      "haiku"
    ],
    "methods": [
      {
        "index": 0,
        "type": "oauth",
        "label": "Claude"
      }
    ],
    "modelsByProtocol": {
      "messages": [
        "sonnet",
        "opus",
        "haiku"
      ]
    }
  },
  {
    "id": "codex",
    "name": "Codex",
    "icon": "codex",
    "protocol": "responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "models": [
      "gpt-5.3-codex"
    ],
    "methods": [
      {
        "index": 0,
        "type": "oauth",
        "label": "Codex"
      }
    ],
    "modelsByProtocol": {
      "responses": [
        "gpt-5.3-codex"
      ]
    }
  }
];
const subscriptions: Array<[typeof SUBSCRIPTION_IDS[number], string, string, Protocol, string]> = [
  ['github-copilot', 'Copilot', 'github-copilot', 'chat', 'https://api.githubcopilot.com'],
  ['cursor', 'Cursor', 'cursor', 'chat', 'https://api2.cursor.sh'],
  ['grok', 'Grok', 'grok', 'responses', 'https://cli-chat-proxy.grok.com/v1'],
  ['kimi-work', 'Kimi Work', 'kimi', 'chat', 'https://agent-gw.kimi.com/coding/v1'],
  ['kiro', 'Kiro', 'kiro', 'chat', 'https://runtime.us-east-1.kiro.dev'],
  ['minimax-code', 'MiniMax 国内', 'minimax', 'messages', 'https://agent.minimax.cn/mavis/api/v1/llm/v1'],
  ['minimax-code-global', 'MiniMax 国际', 'minimax', 'messages', 'https://agent.minimax.io/mavis/api/v1/llm/v1'],
  ['qoder', 'Qoder 国际', 'qoder', 'chat', 'https://api3.qoder.sh'],
  ['qoder-cn', 'Qoder 国内', 'qoder', 'chat', 'https://gateway.qoder.com.cn'],
  ['qwenwork', '千问办公公有云', 'qwen', 'chat', 'https://gateway.qwenwork.cn'],
  ['qwenwork-enterprise', '千问办公企业', 'qwen', 'chat', 'https://gateway.qwenwork.cn'],
  ['trae-cn', 'Trae 国内', 'trae', 'chat', 'https://trae-api-cn.mchost.guru'],
  ['trae-global', 'Trae 国际', 'trae', 'chat', 'https://coresg-normal.trae.ai'],
  ['workbuddy', 'WorkBuddy 国内', 'workbuddy', 'chat', 'https://copilot.tencent.com/v2'],
  ['workbuddy-ai', 'WorkBuddy 国际', 'workbuddy', 'chat', 'https://www.workbuddy.ai/v2'],
  ['zcode', 'ZCode', 'zcode', 'messages', 'https://api.z.ai/api/anthropic/v1'],
  ['opencode-go', 'OpenCode Go', 'opencode', 'chat', 'https://opencode.ai/inference/go/openai/v1'],
  ['volcengine', '火山引擎', 'volcengine', 'chat', 'https://ark.cn-beijing.volces.com/api/coding/v3'],
  ['antigravity', 'Antigravity', 'antigravity', 'chat', 'https://daily-cloudcode-pa.googleapis.com'],
  ['opencode-zen-free', 'OpenCode Zen Free', 'opencode', 'chat', 'https://opencode.ai/inference/openai/v1'],
];
for (const [id, name, icon, protocol, baseUrl] of subscriptions) CHANNEL_CATALOG.push({ id, name, icon, protocol, baseUrl, models: [], modelsByProtocol: { [protocol]: [] }, methods: [{ index: 0, type: 'oauth', label: name }] });

for (const channel of CHANNEL_CATALOG) {
  if (channel.id === 'opencode-go' || channel.id === 'volcengine') channel.methods = [{ index: 0, type: 'api', label: 'API Key' }];
}
