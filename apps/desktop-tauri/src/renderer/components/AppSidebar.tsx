import {
  ArrowsRotateRight,
  CircleInfo,
  Gear,
  NodesRight,
  Pin,
  PinSlash,
} from '@gravity-ui/icons';
import { Tooltip } from '@heroui/react';
import { useState, type ReactNode } from 'react';
import { isCliBackend, triggerSync } from '@/lib/api';
import {
  dispatchDataSynced,
  dispatchOpenAbout,
  dispatchOpenSettings,
  shareCurrentPage,
} from '@/lib/shell-events';
import { cn } from '@/lib/utils';

const SIDEBAR_COLLAPSED_KEY = 'tud.sidebarCollapsed';

export function readSidebarCollapsed(): boolean {
  try {
    const v = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    // Default collapsed (icon rail) for floating chrome.
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

export function writeSidebarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // ignore
  }
}

/** Glass fill — always soft rect so expand doesn't morph through an ellipse. */
const glassShell =
  'rounded-[14px] border border-white/50 bg-white/75 p-1.5 shadow-[0_8px_28px_rgb(0_0_0/0.10)] backdrop-blur-xl dark:border-white/10 dark:bg-black/55';

const itemBase =
  'inline-flex items-center text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-foreground/20';

const itemIdle =
  'bg-transparent text-foreground/80 hover:bg-black/[0.04] dark:text-foreground/70 dark:hover:bg-white/10';

interface AppSidebarProps {
  /** Pinned collapsed preference (true = icon rail when not hovered). */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/** Floating desktop action rail. */
export function AppSidebar({
  collapsed,
  onToggleCollapsed,
}: AppSidebarProps) {
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const expanded = !collapsed || hovered;
  const cliBackend = isCliBackend();
  const refreshLabel = cliBackend ? '同步数据' : '刷新数据';

  const refreshData = async () => {
    setBusy(true);
    try {
      if (cliBackend) {
        await triggerSync();
        if (typeof window.tud?.onDataSynced !== 'function') {
          dispatchDataSynced();
        }
      } else {
        dispatchDataSynced();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(glassShell, 'w-max')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <nav
        aria-label="快捷操作"
        className="flex w-max flex-col items-stretch gap-0.5"
      >
        <SidebarAction
          expanded={expanded}
          icon={<Gear className="size-4.5 shrink-0" />}
          label="设置"
          onPress={() => dispatchOpenSettings()}
        />
        <SidebarAction
          disabled={busy}
          expanded={expanded}
          icon={
            <ArrowsRotateRight
              className={cn(
                'size-4.5 shrink-0',
                busy && 'animate-spin',
              )}
            />
          }
          label={refreshLabel}
          onPress={() => {
            void refreshData();
          }}
        />
        <SidebarAction
          expanded={expanded}
          icon={<NodesRight className="size-4.5 shrink-0" />}
          label="分享"
          onPress={() => {
            void shareCurrentPage();
          }}
        />
        <SidebarAction
          expanded={expanded}
          icon={<CircleInfo className="size-4.5 shrink-0" />}
          label="关于"
          onPress={() => dispatchOpenAbout()}
        />

        <div
          aria-hidden
          className={cn(
            'my-0.5 h-px bg-black/10 dark:bg-white/15',
            expanded ? 'mx-2.5' : 'mx-2',
          )}
        />

        <SidebarAction
          expanded={expanded}
          icon={
            collapsed ? (
              <Pin className="size-4.5 shrink-0" />
            ) : (
              <PinSlash className="size-4.5 shrink-0" />
            )
          }
          label={collapsed ? '固定' : '取消固定'}
          onPress={onToggleCollapsed}
        />
      </nav>
    </div>
  );
}

function SidebarAction({
  expanded,
  icon,
  label,
  onPress,
  disabled,
}: {
  expanded: boolean;
  icon: ReactNode;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const button = (
    <button
      aria-label={label}
      className={cn(
        itemBase,
        itemIdle,
        expanded
          ? 'w-full gap-2 rounded-[10px] px-3 py-2'
          : 'size-10 justify-center rounded-full',
        disabled && 'pointer-events-none opacity-40',
      )}
      disabled={disabled}
      onClick={onPress}
      type="button"
    >
      {icon}
      {expanded ? <span className="whitespace-nowrap">{label}</span> : null}
    </button>
  );

  if (expanded) return button;

  return (
    <Tooltip closeDelay={80} delay={100}>
      {button}
      <Tooltip.Content placement="right">
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );
}
