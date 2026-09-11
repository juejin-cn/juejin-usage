import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { ToastQueue } from '@heroui/react';
// Sidebar / FAB chrome temporarily hidden — actions moved to FilterChromeActions.
// import {
//   AppSidebar,
//   readSidebarCollapsed,
//   writeSidebarCollapsed,
// } from './AppSidebar';
import { AboutModal } from './AboutModal';
import { AppToastProvider as AppToastQueueProvider } from './AppToastContext';
import { AutoUpdateNotice } from './AutoUpdateNotice';
import {
  AppToastProvider,
  type AppToastContent,
} from './AppToastProvider';
import { BackendConfigModal } from './BackendConfigModal';
// import { MobileActionBubble } from './MobileActionBubble';
import { ShareActivityModal } from './ShareActivityModal';
import { WindowTitleControls } from './WindowTitleControls';
import {
  dispatchJuejinLinkChanged,
  dispatchOpenSettings,
  type SettingsTabId,
} from '@/lib/shell-events';
import { ShareSnapshotProvider } from '../../../../../packages/dashboard/src/hooks/ShareSnapshotContext';

/** Root shell: filter chrome actions + nested route outlet. */
export function AppShell() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  // const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('pet');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [toastQueue] = useState(
    () => new ToastQueue<AppToastContent>({ maxVisibleToasts: 2 }),
  );

  // useEffect(() => {
  //   setSidebarCollapsed(readSidebarCollapsed());
  // }, []);

  useEffect(() => {
    if (pathname !== '/settings') return;
    setSettingsOpen(true);
    void navigate({ to: '/dashboard', replace: true });
  }, [pathname, navigate]);

  useEffect(() => {
    const updateScrolledState = () => setHasScrolled(window.scrollY > 4);
    updateScrolledState();
    window.addEventListener('scroll', updateScrolledState, { passive: true });
    return () => window.removeEventListener('scroll', updateScrolledState);
  }, []);

  useEffect(() => {
    if (typeof window.tud?.onOpenSettings !== 'function') return;
    return window.tud.onOpenSettings((detail) => {
      if (detail?.tab) setSettingsTab(detail.tab);
      dispatchOpenSettings(detail);
      setSettingsOpen(true);
    });
  }, []);

  // Deep-link association: silent (no settings modal), refresh chrome + toast.
  useEffect(() => {
    if (typeof window.tud?.onJuejinLinkResult !== 'function') return;
    return window.tud.onJuejinLinkResult((detail) => {
      dispatchJuejinLinkChanged();
      if (detail.ok) {
        toastQueue.add({ title: '登录成功', variant: 'success' });
        return;
      }
      toastQueue.add({
        title: '关联失败',
        description: detail.message,
        variant: 'danger',
      });
    });
  }, [toastQueue]);

  useEffect(() => {
    if (typeof window.tud?.onRuntimeNotice !== 'function') return;
    return window.tud.onRuntimeNotice((detail) => {
      if (detail.kind !== 'config-reset' || detail.tokenSalvaged) return;
      toastQueue.add({
        title: '配置文件已损坏并已重置，请重新登录掘金',
        variant: 'warning',
      });
    });
  }, [toastQueue]);

  // const toggleSidebarCollapsed = () => {
  //   setSidebarCollapsed((prev) => {
  //     const next = !prev;
  //     writeSidebarCollapsed(next);
  //     return next;
  //   });
  // };

  return (
    <AppToastQueueProvider queue={toastQueue}>
      <ShareSnapshotProvider>
        <div className="flex min-h-svh flex-col bg-background text-foreground">
        <AppToastProvider queue={toastQueue} />
        <AutoUpdateNotice toastQueue={toastQueue} />
      {/* Fixed title chrome: transparent until scrolled, then frosted; always draggable. */}
      <div
        className={`desktop-window-drag-region fixed inset-x-0 top-0 z-50 flex items-stretch transition-[background-color,backdrop-filter] duration-200 ${
          hasScrolled
            ? 'bg-white/35 backdrop-blur-xl dark:bg-black/30'
            : 'bg-transparent'
        }`}
      >
        <div className="min-w-0 flex-1" />
        <WindowTitleControls />
      </div>
      {/* Reserve layout space matching the fixed 32px drag region. */}
      <div className="h-8 shrink-0" aria-hidden="true" />
      <div className="relative flex-1">
        {/* <aside
          className="fixed top-1/2 z-30 hidden -translate-x-full -translate-y-1/2 min-[1488px]:block"
          style={{
            left: `max(0.75rem, calc(50% - ${CONTENT_HALF_PX}px - ${SIDEBAR_CONTENT_GAP}))`,
          }}
        >
          <AppSidebar
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebarCollapsed}
          />
        </aside> */}

        <div className="relative mx-auto w-full max-w-240 px-8 py-5 pb-12 sm:px-4 sm:py-6 min-[1040px]:pb-10">
          <main className="min-w-0 w-full">
            <Outlet />
          </main>
        </div>

        {/* <MobileActionBubble /> */}

        <BackendConfigModal
          hideTrigger
          isOpen={settingsOpen}
          onOpenChange={setSettingsOpen}
          activeTab={settingsTab}
          onTabChange={setSettingsTab}
        />
        <AboutModal hideTrigger isOpen={aboutOpen} onOpenChange={setAboutOpen} />
        <ShareActivityModal />
      </div>
        </div>
      </ShareSnapshotProvider>
    </AppToastQueueProvider>
  );
}
