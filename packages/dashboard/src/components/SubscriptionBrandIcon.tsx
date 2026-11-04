import Antigravity from '@lobehub/icons/es/Antigravity/components/Color';
import Claude from '@lobehub/icons/es/Claude/components/Color';
import CodeBuddy from '@lobehub/icons/es/CodeBuddy/components/Color';
import Codex from '@lobehub/icons/es/Codex/components/Color';
import Cursor from '@lobehub/icons/es/Cursor/components/Mono';
import DeepSeek from '@lobehub/icons/es/DeepSeek/components/Color';
import GithubCopilot from '@lobehub/icons/es/GithubCopilot/components/Mono';
import Grok from '@lobehub/icons/es/Grok/components/Mono';
import Kimi from '@lobehub/icons/es/Kimi/components/Mono';
import Minimax from '@lobehub/icons/es/Minimax/components/Color';
import OpenCode from '@lobehub/icons/es/OpenCode/components/Mono';
import Qoder from '@lobehub/icons/es/Qoder/components/Color';
import Trae from '@lobehub/icons/es/Trae/components/Color';
import ZAI from '@lobehub/icons/es/ZAI/components/Mono';
import workBuddyIcon from '@/assets/brand-logos/workbuddy.svg';

export type SubscriptionBrand =
  | 'antigravity' | 'claude' | 'codebuddy' | 'codex' | 'copilot' | 'cursor' | 'deepseek'
  | 'grok' | 'kimi' | 'minimax' | 'opencode' | 'qoder' | 'trae' | 'workbuddy' | 'zcode';

const iconClassName = 'size-4.5 shrink-0';
const monoIconClassName = `${iconClassName} text-foreground`;

/** Fixed-size LobeHub brand mark; mono variants inherit the active theme. */
export function SubscriptionBrandIcon({ brand }: { brand: SubscriptionBrand }) {
  switch (brand) {
    case 'antigravity': return <Antigravity aria-hidden className={iconClassName} size={18} />;
    case 'claude': return <Claude aria-hidden className={iconClassName} size={18} />;
    case 'codebuddy': return <CodeBuddy aria-hidden className={iconClassName} size={18} />;
    case 'codex': return <Codex aria-hidden className={iconClassName} size={18} />;
    case 'copilot': return <GithubCopilot aria-hidden className={monoIconClassName} size={18} />;
    case 'cursor': return <Cursor aria-hidden className={monoIconClassName} size={18} />;
    case 'deepseek': return <DeepSeek aria-hidden className={iconClassName} size={18} />;
    case 'grok': return <Grok aria-hidden className={monoIconClassName} size={18} />;
    case 'kimi': return <Kimi aria-hidden className={monoIconClassName} size={18} />;
    case 'minimax': return <Minimax aria-hidden className={iconClassName} size={18} />;
    case 'opencode': return <OpenCode aria-hidden className={monoIconClassName} size={18} />;
    case 'qoder': return <Qoder aria-hidden className="size-4 shrink-0" size={16} />;
    case 'trae': return <Trae aria-hidden className={iconClassName} size={18} />;
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
