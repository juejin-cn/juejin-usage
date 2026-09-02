import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowsRotateRight,
  Gear,
  LogoGithub,
  NodesRight,
} from '@gravity-ui/icons';
import { Button, Tooltip } from '@heroui/react';
import { JuejinLoginConsentModal } from '@/components/JuejinLoginConsentModal';
import { useAppToastQueue } from '@/components/AppToastContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import { fetchConfig, isCliBackend, triggerSync } from '@/lib/api';
import { openJuejinLogin } from '@/lib/juejin-client-link';
import {
  JUEJIN_LINK_CHANGED_EVENT,
  OPEN_SETTINGS_EVENT,
  dispatchDataSynced,
  dispatchOpenSettings,
  shareCurrentPage,
} from '@/lib/shell-events';
import { cn } from '@/lib/utils';

const linkJuejinBtn =
  'inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-[#1e80ff] px-2.5 text-[12px] font-medium text-white outline-none transition-colors hover:bg-[#1171ee] focus-visible:ring-2 focus-visible:ring-[#1e80ff]/40 disabled:pointer-events-none disabled:opacity-40 dark:bg-[#4b9cff] dark:hover:bg-[#3a8ff0]';
const RANK_PAGE_URL = 'https://juejin.cn/aiusage/rank';
const GITHUB_REPO_URL = 'https://github.com/juejin-cn/juejin-usage';

function openRankPage(): void {
  void window.tud.openExternal(RANK_PAGE_URL);
}

function openGithubRepository(): void {
  void window.tud.openExternal(GITHUB_REPO_URL);
}

function JuejinMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      role="img"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="m12 14.316 7.454-5.88-2.022-1.625L12 11.1l-.004.003-5.432-4.288-2.02 1.624 7.452 5.88Zm0-7.247 2.89-2.298L12 2.453l-.004-.005-2.884 2.318 2.884 2.3Zm0 11.266-.005.002-9.975-7.87L0 12.088l.194.156 11.803 9.308 7.463-5.885L24 12.085l-2.023-1.624Z"
        transform="translate(2.4 2.4) scale(.8)"
      />
    </svg>
  );
}

/** Filter-bar chrome: link / share / refresh / settings + theme toggle. */
export function FilterChromeActions() {
  const cliBackend = isCliBackend();
  const toastQueue = useAppToastQueue();
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const refreshLabel = cliBackend ? '同步数据' : '刷新数据';

  const refreshLinkState = useCallback(() => {
    void (async () => {
      try {
        const config = await fetchConfig();
        setLinked(Boolean(config.juejin.userId));
      } catch {
        setLinked(null);
      }
    })();
  }, []);

  useEffect(() => {
    refreshLinkState();
    const onRefresh = () => refreshLinkState();
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ loginSuccess?: boolean }>).detail;
      if (detail?.loginSuccess) {
        // Hide immediately; confirm via config fetch.
        setLinked(true);
      }
      refreshLinkState();
    };
    // Note: intentionally not listening to DATA_SYNCED — link state never
    // changes on data sync, and it would cost an extra config IPC per sync.
    window.addEventListener('focus', onRefresh);
    window.addEventListener(OPEN_SETTINGS_EVENT, onSettings);
    window.addEventListener(JUEJIN_LINK_CHANGED_EVENT, onRefresh);
    return () => {
      window.removeEventListener('focus', onRefresh);
      window.removeEventListener(OPEN_SETTINGS_EVENT, onSettings);
      window.removeEventListener(JUEJIN_LINK_CHANGED_EVENT, onRefresh);
    };
  }, [refreshLinkState]);

  const refreshData = async () => {
    setBusy(true);
    try {
      if (cliBackend) {
        const result = await triggerSync();
        if (!result.ok) {
          toastQueue.add({
            title: '同步失败，请稍后重试',
            variant: 'danger',
          });
          return;
        }
        toastQueue.add({ title: '同步成功', variant: 'success' });
        // Electron IPC already pushes DATA_SYNCED; a second dispatch double-reloads charts.
        if (typeof window.tud?.onDataSynced !== 'function') {
          dispatchDataSynced();
        }
      } else {
        dispatchDataSynced();
      }
    } catch {
      toastQueue.add({
        title: '同步失败，请稍后重试',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      {linked === false ? (
        <button
          className={linkJuejinBtn}
          onClick={() => setConsentOpen(true)}
          type="button"
        >
          <JuejinMark className="size-3.5" />
          关联掘金
        </button>
      ) : null}
      <JuejinLoginConsentModal
        isOpen={consentOpen}
        onConfirm={() => {
          void openJuejinLogin();
        }}
        onOpenChange={setConsentOpen}
      />
      <Button
        className="h-8 min-h-8 shrink-0 px-2.5 text-xs font-normal"
        onPress={openRankPage}
        size="sm"
        variant="tertiary"
      >
        排行榜
      </Button>
      <ChromeAction
        icon={<LogoGithub className="size-4" />}
        label="GitHub 仓库"
        onPress={openGithubRepository}
      />
      <ChromeAction
        icon={<NodesRight className="size-4" />}
        label="分享"
        onPress={() => {
          void shareCurrentPage();
        }}
      />
      <ChromeAction
        disabled={busy}
        icon={
          <ArrowsRotateRight
            className={cn('size-4', busy && 'animate-spin')}
          />
        }
        label={refreshLabel}
        onPress={() => {
          void refreshData();
        }}
      />
      <ChromeAction
        icon={<Gear className="size-4" />}
        label="设置"
        onPress={() => dispatchOpenSettings()}
      />
      <ThemeToggle />
    </div>
  );
}

function ChromeAction({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip closeDelay={80} delay={100}>
      <Button
        aria-label={label}
        className="size-8 min-h-8 min-w-8 shrink-0 p-0"
        isDisabled={disabled}
        isIconOnly
        onPress={onPress}
        size="sm"
        variant="tertiary"
      >
        {icon}
      </Button>
      <Tooltip.Content placement="bottom">
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );
}
