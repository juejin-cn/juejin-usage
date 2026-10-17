import Antigravity from '@lobehub/icons/es/Antigravity';
import Claude from '@lobehub/icons/es/Claude';
import CodeBuddy from '@lobehub/icons/es/CodeBuddy';
import Codex from '@lobehub/icons/es/Codex';
import Cursor from '@lobehub/icons/es/Cursor';
import DeepSeek from '@lobehub/icons/es/DeepSeek';
import GithubCopilot from '@lobehub/icons/es/GithubCopilot';
import Grok from '@lobehub/icons/es/Grok';
import Kimi from '@lobehub/icons/es/Kimi';
import Minimax from '@lobehub/icons/es/Minimax';
import OpenCode from '@lobehub/icons/es/OpenCode';
import Qoder from '@lobehub/icons/es/Qoder';
import Trae from '@lobehub/icons/es/Trae';
import ZAI from '@lobehub/icons/es/ZAI';
import workBuddyIcon from '@/assets/brand-logos/workbuddy.svg';

export type SubscriptionBrand =
  | 'antigravity' | 'claude' | 'codebuddy' | 'codex' | 'copilot' | 'cursor' | 'deepseek'
  | 'grok' | 'kimi' | 'minimax' | 'opencode' | 'qoder' | 'trae' | 'workbuddy' | 'zcode';

const iconClassName = 'size-4.5 shrink-0';
const monoIconClassName = `${iconClassName} text-foreground`;

/** Fixed-size LobeHub brand mark; mono variants inherit the active theme. */
export function SubscriptionBrandIcon({ brand }: { brand: SubscriptionBrand }) {
  switch (brand) {
    case 'antigravity': return <Antigravity.Color aria-hidden className={iconClassName} size={18} />;
    case 'claude': return <Claude.Color aria-hidden className={iconClassName} size={18} />;
    case 'codebuddy': return <CodeBuddy.Color aria-hidden className={iconClassName} size={18} />;
    case 'codex': return <Codex.Color aria-hidden className={iconClassName} size={18} />;
    case 'copilot': return <GithubCopilot aria-hidden className={monoIconClassName} size={18} />;
    case 'cursor': return <Cursor aria-hidden className={monoIconClassName} size={18} />;
    case 'deepseek': return <DeepSeek.Color aria-hidden className={iconClassName} size={18} />;
    case 'grok': return <Grok aria-hidden className={monoIconClassName} size={18} />;
    case 'kimi': return <Kimi aria-hidden className={monoIconClassName} size={18} />;
    case 'minimax': return <Minimax.Color aria-hidden className={iconClassName} size={18} />;
    case 'opencode': return <OpenCode aria-hidden className={monoIconClassName} size={18} />;
    case 'qoder': return <Qoder.Color aria-hidden className="size-4 shrink-0" size={16} />;
    case 'trae': return <Trae.Color aria-hidden className={iconClassName} size={18} />;
    case 'workbuddy':
      return (
        <img
          alt=""
          aria-hidden
          className={`${iconClassName} object-contain`}
          height={18}
          src={workBuddyIcon}
          width={18}
        />
      );
    case 'zcode': return <ZAI aria-hidden className={monoIconClassName} size={18} />;
  }
}
