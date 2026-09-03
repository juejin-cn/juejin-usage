export interface ModelProvider {
  key: string;
  label: string;
  icon: string;
}

const PROVIDER_BY_KEY: Record<string, Omit<ModelProvider, 'key'>> = {
  ai21: { label: 'AI21 Labs', icon: 'ai21' },
  alibaba: { label: 'Alibaba', icon: 'alibaba' },
  aws: { label: 'AWS', icon: 'aws' },
  anthropic: { label: 'Claude', icon: 'claude' },
  azure: { label: 'Azure', icon: 'azure' },
  baidu: { label: 'Baidu', icon: 'baidu' },
  bytedance: { label: 'ByteDance', icon: 'bytedance' },
  cerebras: { label: 'Cerebras', icon: 'cerebras' },
  claude: { label: 'Claude', icon: 'claude' },
  cohere: { label: 'Cohere', icon: 'cohere' },
  cloudflare: { label: 'Cloudflare', icon: 'cloudflare' },
  codex: { label: 'Codex', icon: 'codex' },
  deepseek: { label: 'DeepSeek', icon: 'deepseek' },
  doubao: { label: 'Doubao', icon: 'doubao' },
  fireworks: { label: 'Fireworks', icon: 'fireworks' },
  gemini: { label: 'Google', icon: 'google' },
  google: { label: 'Google', icon: 'google' },
  grok: { label: 'xAI', icon: 'grok' },
  groq: { label: 'Groq', icon: 'groq' },
  huggingface: { label: 'Hugging Face', icon: 'huggingface' },
  hunyuan: { label: 'Tencent', icon: 'hunyuan' },
  kimi: { label: 'Kimi', icon: 'kimi' },
  meta: { label: 'Meta', icon: 'meta' },
  minimax: { label: 'MiniMax', icon: 'minimax' },
  mistral: { label: 'Mistral', icon: 'mistral' },
  moonshot: { label: 'Moonshot', icon: 'moonshot' },
  nvidia: { label: 'NVIDIA', icon: 'nvidia' },
  openai: { label: 'OpenAI', icon: 'openai' },
  perplexity: { label: 'Perplexity', icon: 'perplexity' },
  qwen: { label: 'Alibaba', icon: 'alibaba' },
  stepfun: { label: 'StepFun', icon: 'stepfun' },
  together: { label: 'Together AI', icon: 'together' },
  xai: { label: 'xAI', icon: 'grok' },
  yi: { label: '01.AI', icon: 'yi' },
  zai: { label: 'Z.ai', icon: 'zai' },
  zhipu: { label: 'Zhipu AI', icon: 'zhipu' },
};

const NAMESPACE_ALIASES: Record<string, string> = {
  'alibaba-cn': 'alibaba',
  'amazon-bedrock': 'aws',
  'azure-cognitive-services': 'azure',
  'cloudflare-ai-gateway': 'cloudflare',
  'fireworks-ai': 'fireworks',
  'github-copilot': 'openai',
  'google-vertex': 'google',
  'google-vertex-anthropic': 'claude',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
  moonshotai: 'moonshot',
  'openrouter': 'openai',
  'perplexity-agent': 'perplexity',
  togetherai: 'together',
  xiaomi: 'kimi',
  zai: 'zai',
  zhipuai: 'zhipu',
};

const MODEL_MATCHERS: Array<[RegExp, string]> = [
  [/claude/, 'claude'],
  [/(^|[\/_ .-])(opus|sonnet|haiku|fable)([\/_ .-]|$)/, 'claude'],
  [/\bcodex\b/, 'codex'],
  [/(^|[\/_-])gpt([\/_.-]|$)|chatgpt|(^|[\/_-])o[1-9]([\/_.-]|$)/, 'openai'],
  [/gemini|gemma/, 'google'],
  [/qwen/, 'qwen'],
  [/deepseek/, 'deepseek'],
  [/grok/, 'grok'],
  [/mistral|mixtral/, 'mistral'],
  [/kimi/, 'kimi'],
  [/moonshot/, 'moonshot'],
  [/(^|[\/_ .-])k(2[._-]7|3)([\/_ .-]|$)/, 'moonshot'],
  [/minimax/, 'minimax'],
  [/llama|meta-llama/, 'meta'],
  [/command|cohere/, 'cohere'],
  [/jamba/, 'ai21'],
  [/ai21/, 'ai21'],
  [/nova|titan/, 'aws'],
  [/doubao/, 'doubao'],
  [/hunyuan/, 'hunyuan'],
  [/glm|chatglm|zhipu|(^|[\/_-])zai([\/_.-]|$)/, 'zhipu'],
  [/ernie/, 'baidu'],
  [/yi-/, 'yi'],
  [/step[-_]?\w/, 'stepfun'],
  [/sonar|perplexity/, 'perplexity'],
  [/nvidia|nemotron/, 'nvidia'],
  [/groq/, 'groq'],
  [/cerebras/, 'cerebras'],
];

function providerFromKey(key: string): ModelProvider {
  const canonicalKey = PROVIDER_BY_KEY[key] ? key : NAMESPACE_ALIASES[key];
  const provider = canonicalKey ? PROVIDER_BY_KEY[canonicalKey] : undefined;
  if (provider) return { key: canonicalKey, ...provider };
  return { key: 'unknown', label: 'Other', icon: 'unknown' };
}

/** Infer the model family first, then fall back to the catalog namespace. */
export function getModelProvider(model: string): ModelProvider {
  const normalized = model.trim().toLowerCase();
  for (const [matcher, key] of MODEL_MATCHERS) {
    if (matcher.test(normalized)) return providerFromKey(key);
  }

  const namespace = normalized.split('/').filter(Boolean)[0] ?? '';
  return providerFromKey(namespace.replace(/\s+/g, '-'));
}
