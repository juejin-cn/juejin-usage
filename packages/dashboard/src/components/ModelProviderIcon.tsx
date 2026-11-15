import ai21Icon from '@lobehub/icons-static-svg/icons/ai21-brand-color.svg';
import alibabaIcon from '@lobehub/icons-static-svg/icons/alibaba-color.svg';
import awsIcon from '@lobehub/icons-static-svg/icons/aws-color.svg';
import azureIcon from '@lobehub/icons-static-svg/icons/azure-color.svg';
import baiduIcon from '@lobehub/icons-static-svg/icons/baidu-color.svg';
import bytedanceIcon from '@lobehub/icons-static-svg/icons/bytedance-color.svg';
import cerebrasIcon from '@lobehub/icons-static-svg/icons/cerebras-color.svg';
import claudeIcon from '@lobehub/icons-static-svg/icons/claude-color.svg';
import codexIcon from '@lobehub/icons-static-svg/icons/codex-color.svg';
import cloudflareIcon from '@lobehub/icons-static-svg/icons/cloudflare-color.svg';
import cohereIcon from '@lobehub/icons-static-svg/icons/cohere-color.svg';
import deepseekIcon from '@lobehub/icons-static-svg/icons/deepseek-color.svg';
import doubaoIcon from '@lobehub/icons-static-svg/icons/doubao-color.svg';
import fireworksIcon from '@lobehub/icons-static-svg/icons/fireworks-color.svg';
import googleIcon from '@lobehub/icons-static-svg/icons/google-color.svg';
import grokIcon from '@lobehub/icons-static-svg/icons/grok.svg';
import groqIcon from '@lobehub/icons-static-svg/icons/groq.svg';
import huggingfaceIcon from '@lobehub/icons-static-svg/icons/huggingface-color.svg';
import hunyuanIcon from '@lobehub/icons-static-svg/icons/hunyuan-color.svg';
import kimiIcon from '@lobehub/icons-static-svg/icons/kimi.svg';
import metaIcon from '@lobehub/icons-static-svg/icons/meta-color.svg';
import minimaxIcon from '@lobehub/icons-static-svg/icons/minimax-color.svg';
import mistralIcon from '@lobehub/icons-static-svg/icons/mistral-color.svg';
import moonshotIcon from '@lobehub/icons-static-svg/icons/moonshot.svg';
import nvidiaIcon from '@lobehub/icons-static-svg/icons/nvidia-color.svg';
import openaiIcon from '@lobehub/icons-static-svg/icons/openai.svg';
import perplexityIcon from '@lobehub/icons-static-svg/icons/perplexity-color.svg';
import stepfunIcon from '@lobehub/icons-static-svg/icons/stepfun-color.svg';
import togetherIcon from '@lobehub/icons-static-svg/icons/together-color.svg';
import zaiIcon from '@lobehub/icons-static-svg/icons/zai.svg';
import yiIcon from '@lobehub/icons-static-svg/icons/yi-color.svg';
import zhipuIcon from '@lobehub/icons-static-svg/icons/zhipu-color.svg';
import type { ModelProvider } from '@/lib/model-provider';

// These SVGs use `currentColor`. Since they are rendered through <img>, the
// external SVG cannot inherit the surrounding text color, so invert them in
// dark mode to keep the monochrome marks visible.
const MONOCHROME_ICONS = new Set(['grok', 'groq', 'kimi', 'moonshot', 'openai', 'zai']);

const ICONS: Record<string, string> = {
  ai21: ai21Icon,
  alibaba: alibabaIcon,
  aws: awsIcon,
  azure: azureIcon,
  baidu: baiduIcon,
  bytedance: bytedanceIcon,
  cerebras: cerebrasIcon,
  claude: claudeIcon,
  codex: codexIcon,
  cloudflare: cloudflareIcon,
  cohere: cohereIcon,
  deepseek: deepseekIcon,
  doubao: doubaoIcon,
  fireworks: fireworksIcon,
  google: googleIcon,
  grok: grokIcon,
  groq: groqIcon,
  huggingface: huggingfaceIcon,
  hunyuan: hunyuanIcon,
  kimi: kimiIcon,
  meta: metaIcon,
  minimax: minimaxIcon,
  mistral: mistralIcon,
  moonshot: moonshotIcon,
  nvidia: nvidiaIcon,
  openai: openaiIcon,
  perplexity: perplexityIcon,
  stepfun: stepfunIcon,
  together: togetherIcon,
  zai: zaiIcon,
  yi: yiIcon,
  zhipu: zhipuIcon,
};

export function ModelProviderIcon({
  fallbackText,
  provider,
  size = 22,
}: {
  fallbackText?: string;
  provider: ModelProvider;
  size?: number;
}) {
  const src = ICONS[provider.icon];
  const isMonochrome = MONOCHROME_ICONS.has(provider.icon);
  if (!src) {
    const initial = fallbackText?.match(/[a-z]/i)?.[0]?.toUpperCase()
      ?? [...(fallbackText?.trim() || provider.label)][0]?.toUpperCase()
      ?? '?';
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center font-sans font-semibold text-foreground/65"
        style={{ fontSize: Math.max(11, Math.round(size * 0.65)), height: size, width: size }}
      >
        {initial}
      </span>
    );
  }

  return (
    <img
      alt=""
      aria-hidden
      className={`shrink-0 object-contain ${isMonochrome ? 'dark:invert' : ''}`}
      height={size}
      src={src}
      width={size}
    />
  );
}
