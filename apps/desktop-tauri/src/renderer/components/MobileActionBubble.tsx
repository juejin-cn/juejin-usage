import {
  ArrowsRotateRight,
  CircleInfo,
  Ellipsis,
  Gear,
  NodesRight,
  Xmark,
} from '@gravity-ui/icons';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { isCliBackend, triggerSync } from '@/lib/api';
import {
  dispatchDataSynced,
  dispatchOpenAbout,
  dispatchOpenSettings,
  shareCurrentPage,
} from '@/lib/shell-events';
import { cn } from '@/lib/utils';

const FAB_SIZE = 'size-9'; // 36px
const FAB_SHADOW = 'shadow-[0_2px_12px_rgba(0,0,0,0.12)] dark:shadow-[0_2px_12px_rgba(0,0,0,0.4)]';
const FAB_SURFACE =
  'rounded-full border border-black/[0.08] bg-white/85 text-[#333] outline-none backdrop-blur-md transition-colors hover:bg-[#f7f7f7] focus-visible:ring-2 focus-visible:ring-black/15 dark:border-white/10 dark:bg-black/70 dark:text-foreground dark:hover:bg-white/10 dark:focus-visible:ring-white/20';
const ACTION_GAP_MS = 40;
const EXIT_MS = 180;

type FabActionId = 'share' | 'about' | 'refresh' | 'settings';

/** Floating action button — expands upward into share / refresh / settings. */
export function MobileActionBubble() {
  const [open, setOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const cliBackend = isCliBackend();
  const refreshLabel = cliBackend ? '同步数据' : '刷新数据';

  useEffect(() => {
    if (open) {
      setMenuMounted(true);
      return;
    }
    if (!menuMounted) return;
    const timer = window.setTimeout(() => setMenuMounted(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, menuMounted]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

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
      setOpen(false);
    }
  };

  const actions: Array<{
    id: FabActionId;
    label: string;
    onClick: () => void;
    icon: ReactNode;
    disabled?: boolean;
  }> = [
    {
      id: 'share',
      label: '分享',
      onClick: () => {
        void shareCurrentPage();
        setOpen(false);
      },
      icon: <NodesRight className="size-4 shrink-0" />,
    },
    {
      id: 'about',
      label: '关于',
      onClick: () => {
        dispatchOpenAbout();
        setOpen(false);
      },
      icon: <CircleInfo className="size-4 shrink-0" />,
    },
    {
      id: 'refresh',
      label: refreshLabel,
      disabled: busy,
      onClick: () => {
        void refreshData();
      },
      icon: (
        <ArrowsRotateRight
          className={cn('size-4 shrink-0', busy && 'animate-spin')}
        />
      ),
    },
    {
      id: 'settings',
      label: '设置',
      onClick: () => {
        dispatchOpenSettings();
        setOpen(false);
      },
      icon: <Gear className="size-4 shrink-0" />,
    },
  ];

  return (
    <div
      ref={rootRef}
      className={cn(
        'fixed right-4 z-40 flex flex-col-reverse items-center gap-2 min-[1488px]:hidden',
        'bottom-[max(1rem,calc(0.75rem+env(safe-area-inset-bottom,0px)))]',
      )}
    >
      <button
        type="button"
        aria-label={open ? '收起快捷操作' : '打开快捷操作'}
        aria-expanded={open}
        aria-controls={menuMounted ? menuId : undefined}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          FAB_SIZE,
          FAB_SHADOW,
          FAB_SURFACE,
          'relative flex items-center justify-center',
        )}
      >
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center transition-transform duration-200 ease-out',
            open && 'rotate-90',
          )}
        >
          <Ellipsis
            className={cn(
              'size-4 shrink-0 transition-opacity duration-150',
              open ? 'opacity-0' : 'opacity-100',
            )}
          />
          <Xmark
            className={cn(
              'absolute size-4 shrink-0 transition-opacity duration-150',
              open ? 'opacity-100' : 'opacity-0',
            )}
          />
        </span>
      </button>

      {menuMounted ? (
        <div
          id={menuId}
          role="menu"
          aria-label="快捷操作"
          className="flex flex-col-reverse items-center gap-2"
        >
          {actions.map((action, index) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              aria-label={action.label}
              title={action.label}
              disabled={action.disabled}
              onClick={action.onClick}
              className={cn(
                FAB_SIZE,
                FAB_SHADOW,
                FAB_SURFACE,
                'flex items-center justify-center transition-[opacity,transform,background-color,color] duration-200 ease-out disabled:pointer-events-none disabled:opacity-40',
                open
                  ? 'scale-100 opacity-100'
                  : 'pointer-events-none scale-50 opacity-0',
              )}
              style={{
                transitionDelay: open
                  ? `${index * ACTION_GAP_MS}ms`
                  : `${(actions.length - 1 - index) * ACTION_GAP_MS}ms`,
              }}
            >
              {action.icon}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
