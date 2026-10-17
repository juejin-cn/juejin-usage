import type { ClaudeSubscriptionSnapshot } from '../../shared/claude-subscription';
import type { CodexSubscriptionSnapshot } from '../../shared/codex-subscription';
import type { CursorSubscriptionSnapshot } from '../../shared/cursor-subscription';

/** `pnpm dev:desktop:mock` injects this so the three subscription cards render without local accounts. */
export function isDesktopMockEnabled(): boolean {
  return import.meta.env.VITE_DESKTOP_MOCK === 'true';
}

function hoursFromNow(hours: number): number {
  return Math.floor(Date.now() / 1000) + hours * 60 * 60;
}

export function desktopMockCodexSubscription(): CodexSubscriptionSnapshot {
  return {
    status: 'ready',
    hasAccount: true,
    fetchedAt: Math.floor(Date.now() / 1000),
    stale: false,
    planLabel: 'Plus',
    fiveHour: { usedPercent: 28, resetsAt: hoursFromNow(3) },
    weekly: { usedPercent: 61, resetsAt: hoursFromNow(24 * 4) },
    message: null,
  };
}

export function desktopMockClaudeSubscription(): ClaudeSubscriptionSnapshot {
  return {
    status: 'ready',
    hasAccount: true,
    planLabel: 'Max',
    fiveHour: { usedPercent: 18, resetsAt: hoursFromNow(2) },
    sevenDay: { usedPercent: 44, resetsAt: hoursFromNow(24 * 5) },
    fetchedAt: Math.floor(Date.now() / 1000),
    stale: false,
    message: null,
  };
}

export function desktopMockCursorSubscription(): CursorSubscriptionSnapshot {
  return {
    status: 'ready',
    planLabel: 'Pro',
    cursorModels: { usedPercent: 22, resetsAt: hoursFromNow(24 * 12) },
    otherModels: { usedPercent: 71, resetsAt: hoursFromNow(24 * 12) },
    plan: null,
    fetchedAt: Math.floor(Date.now() / 1000),
    stale: false,
    message: null,
  };
}
