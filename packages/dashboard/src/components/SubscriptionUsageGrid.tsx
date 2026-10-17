import { AntigravitySubscriptionCard } from './AntigravitySubscriptionCard';
import { ClaudeSubscriptionCard } from './ClaudeSubscriptionCard';
import { CodexSubscriptionCard } from './CodexSubscriptionCard';
import { CopilotSubscriptionCard } from './CopilotSubscriptionCard';
import { CursorSubscriptionCard } from './CursorSubscriptionCard';
import { DeepSeekSubscriptionCard } from './DeepSeekSubscriptionCard';
import { GrokSubscriptionCard } from './GrokSubscriptionCard';
import { KimiSubscriptionCard } from './KimiSubscriptionCard';
import { MiniMaxSubscriptionCard } from './MiniMaxSubscriptionCard';
import { OpenCodeSubscriptionCard } from './OpenCodeSubscriptionCard';
import { QoderSubscriptionCard } from './QoderSubscriptionCard';
import { ZcodeSubscriptionCard } from './ZcodeSubscriptionCard';
import { useSubscriptionChannelVisibility } from '@/hooks/useSubscriptionChannelVisibility';

interface SubscriptionUsageGridProps {
  className?: string;
}

/** Shared subscription allowance cards used by the macOS tray and dashboard. */
export function SubscriptionUsageGrid({ className = '' }: SubscriptionUsageGridProps) {
  const { isEnabled } = useSubscriptionChannelVisibility();

  return (
    <section
      aria-label="订阅额度"
      className={`grid empty:hidden ${className}`.trim()}
    >
      {isEnabled('codex') ? <CodexSubscriptionCard /> : null}
      {isEnabled('claude') ? <ClaudeSubscriptionCard /> : null}
      {isEnabled('cursor') ? <CursorSubscriptionCard /> : null}
      {isEnabled('copilot') ? <CopilotSubscriptionCard /> : null}
      {isEnabled('grok') ? <GrokSubscriptionCard /> : null}
      {isEnabled('kimi') ? <KimiSubscriptionCard /> : null}
      {isEnabled('zcode') ? <ZcodeSubscriptionCard /> : null}
      {isEnabled('antigravity') ? <AntigravitySubscriptionCard /> : null}
      {isEnabled('qoder') ? <QoderSubscriptionCard /> : null}
      {isEnabled('minimax') ? <MiniMaxSubscriptionCard /> : null}
      {isEnabled('opencode') ? <OpenCodeSubscriptionCard /> : null}
      {isEnabled('deepseek') ? <DeepSeekSubscriptionCard /> : null}
    </section>
  );
}
