import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router';
// Sidebar / FAB chrome temporarily hidden — actions moved to FilterChromeActions.
// import {
//   AppSidebar,
//   readSidebarCollapsed,
//   writeSidebarCollapsed,
// } from './AppSidebar';
import { AboutModal } from './AboutModal';
import { AppToastProvider } from './AppToastContext';
import { BackendConfigModal } from './BackendConfigModal';
// import { MobileActionBubble } from './MobileActionBubble';
import { ServerLoginGate } from './ServerLoginGate';
import { ServerTopNav } from './ServerTopNav';
import { ShareActivityModal } from './ShareActivityModal';
import {
  InstallGuideUiProvider,
  type InstallGuideUiContextValue,
} from '@/hooks/InstallGuideUiContext';
import { JuejinAuthProvider } from '@/hooks/JuejinAuthContext';
import { ShareSnapshotProvider } from '@/hooks/ShareSnapshotContext';
import { useJuejinClientLinkFlow } from '@/hooks/useJuejinClientLinkFlow';
import {
  fetchConfig,
  fetchInstallGuide,
  isCliBackend,
  type InstallGuideResponse,
} from '@/lib/api';
import {
  openJuejinLogin,
  resolveClientLinkSearch,
} from '@/lib/juejin-client-link';
import { cn } from '@/lib/utils';

const AUTO_INSTALL_GUIDE_KEY = 'tud.installGuideAutoOpened';
const AUTO_JUEJIN_LOGIN_KEY = 'tud.autoJuejinLoginPrompted';

/** Root shell: filter chrome actions + nested route outlet. */
export function AppShell() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  // const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [installGuide, setInstallGuide] = useState<InstallGuideResponse | null>(
    null,
  );
  const [installGuideReady, setInstallGuideReady] = useState(false);
  const cliBackend = isCliBackend();
  const {
    authStatus,
    userId,
    userName,
    avatarLarge,
    refreshAuth,
    toastQueue,
    ToastProvider,
  } = useJuejinClientLinkFlow();

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

  // Preserve the existing client association flow: on a fresh CLI launch,
  // prompt once when no linked Juejin account exists.
  useEffect(() => {
    if (!cliBackend) return;
    if (resolveClientLinkSearch().userId) return;
    void (async () => {
      try {
        const config = await fetchConfig();
        if (config.juejin.userId) return;
        if (sessionStorage.getItem(AUTO_JUEJIN_LOGIN_KEY)) return;
        sessionStorage.setItem(AUTO_JUEJIN_LOGIN_KEY, '1');
        await openJuejinLogin();
      } catch {
        // The manual association action remains available.
      }
    })();
  }, [cliBackend]);

  // Server mode: ask the cloud whether the current user should see the
  // installation guide. Only fires once authentication is ready to avoid
  // a 401 when the token is still being hydrated.
  useEffect(() => {
    if (cliBackend) return;
    if (authStatus !== 'authenticated') {
      setInstallGuide(null);
      // Guest / logged-out: entry is still shown; treat as no usage data.
      setInstallGuideReady(true);
      return;
    }
    let cancelled = false;
    setInstallGuideReady(false);
    void fetchInstallGuide()
      .then((result) => {
        if (!cancelled) {
          setInstallGuide(result);
          setInstallGuideReady(true);
        }
      })
      .catch(() => {
        // Guide lookup is best-effort: still show the download entry.
        if (!cancelled) {
          setInstallGuide(null);
          setInstallGuideReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cliBackend, authStatus]);

  // Auto-open download page once for users who should see the guide.
  useEffect(() => {
    if (cliBackend) return;
    if (!installGuide?.shouldShowGuide) return;
    if (pathname === '/download') return;
    if (localStorage.getItem(AUTO_INSTALL_GUIDE_KEY)) return;
    localStorage.setItem(AUTO_INSTALL_GUIDE_KEY, '1');
    void navigate({ to: '/download', replace: true });
  }, [cliBackend, installGuide?.shouldShowGuide, navigate, pathname]);

  const installGuideUiValue = useMemo<InstallGuideUiContextValue>(
    () => ({
      // Web shell always exposes the entry; guests count as ready with no data.
      ready: cliBackend
        ? false
        : installGuideReady || authStatus !== 'authenticated',
      hasUserData: installGuide?.reason === 'active',
      reason:
        installGuide?.reason === 'uninstalled'
          ? 'uninstalled'
          : installGuide?.reason === 'active'
            ? 'active'
            : 'new_user',
    }),
    [authStatus, cliBackend, installGuide, installGuideReady],
  );

  // const toggleSidebarCollapsed = () => {
  //   setSidebarCollapsed((prev) => {
  //     const next = !prev;
  //     writeSidebarCollapsed(next);
  //     return next;
  //   });
  // };

  return (
    <AppToastProvider queue={toastQueue}>
      <JuejinAuthProvider
        authStatus={authStatus}
        userId={userId}
        userName={userName}
        avatarLarge={avatarLarge}
      >
        <ShareSnapshotProvider>
        <InstallGuideUiProvider value={installGuideUiValue}>
          <div className="flex h-svh min-w-0 max-w-full flex-col overflow-hidden bg-background text-foreground">
            <ToastProvider placement="top end" queue={toastQueue} />
            {cliBackend ? (
              <div
                aria-hidden="true"
                className={`pointer-events-none fixed inset-x-0 top-0 z-40 h-8 transition-[background-color,backdrop-filter] duration-200 ${
                  hasScrolled
                    ? 'bg-white/35 backdrop-blur-xl dark:bg-black/30'
                    : 'bg-transparent'
                }`}
              />
            ) : (
              <ServerTopNav
                authStatus={authStatus}
                avatarLarge={avatarLarge}
                pathname={pathname}
                userName={userName}
              />
            )}
            <div
              className={cn(
                'relative min-h-0 flex-1 overflow-x-hidden overscroll-contain',
                pathname === '/pricing' ? 'overflow-y-hidden' : 'overflow-y-auto',
              )}
              onScroll={(event) => {
                setHasScrolled(event.currentTarget.scrollTop > 4);
              }}
            >
              {/* {cliBackend ? (
            <aside
              className="fixed top-1/2 z-30 hidden -translate-x-full -translate-y-1/2 min-[1488px]:block"
              style={{
                left: `max(0.75rem, calc(50% - ${CONTENT_HALF_PX}px - ${SIDEBAR_CONTENT_GAP}))`,
              }}
            >
              <AppSidebar
                collapsed={sidebarCollapsed}
                onToggleCollapsed={toggleSidebarCollapsed}
              />
            </aside>
          ) : null} */}

              <div
                className={cn(
                  'relative mx-auto w-full px-4 py-4 sm:px-4 sm:py-6 md:px-8',
                  pathname === '/download' ? 'max-w-328' : 'max-w-240',
                  cliBackend ? 'pb-12 min-[1040px]:pb-10' : 'pb-10',
                )}
              >
                <main className="min-w-0 w-full">
                  {!cliBackend && authStatus === 'unauthenticated' && pathname === '/dashboard' ? (
                    <ServerLoginGate
                      loading={false}
                      onDownload={() => {
                        void navigate({ to: '/download' });
                      }}
                      onRetry={refreshAuth}
                    />
                  ) : (
                    <Outlet />
                  )}
                </main>
              </div>

              {/* {cliBackend ? <MobileActionBubble /> : null} */}

              <BackendConfigModal
                hideTrigger
                isOpen={settingsOpen}
                onOpenChange={setSettingsOpen}
              />
              <AboutModal
                hideTrigger
                isOpen={aboutOpen}
                onOpenChange={setAboutOpen}
              />
              <ShareActivityModal />
            </div>
          </div>
        </InstallGuideUiProvider>
        </ShareSnapshotProvider>
      </JuejinAuthProvider>
    </AppToastProvider>
  );
}
