import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { RiBarChartBoxFill, RiAwardFill, RiStackFill, RiPriceTag3Fill } from '@remixicon/react';
import { AppToastProvider } from '@/components/AppToastContext';
import { BackendConfigModal } from '@/components/BackendConfigModal';
import { ShareActivityModal } from '@/components/ShareActivityModal';
import { InstallGuideUiProvider, type InstallGuideUiContextValue } from '@/hooks/InstallGuideUiContext';
import { JuejinAuthProvider } from '@/hooks/JuejinAuthContext';
import { ShareSnapshotProvider } from '@/hooks/ShareSnapshotContext';
import { useJuejinClientLinkFlow } from '@/hooks/useJuejinClientLinkFlow';
import { fetchInstallGuide, type InstallGuideResponse } from '@/lib/api';
import { WebHeader } from './WebHeader';

const AUTO_INSTALL_GUIDE_KEY = 'tud.installGuideAutoOpened';
const sections = [
  ['/dashboard', '我的用量', RiBarChartBoxFill],
  ['/rank', '用户排行', RiAwardFill],
  ['/model-rank', '模型排行', RiStackFill],
  ['/pricing', '模型价格', RiPriceTag3Fill],
] as const;

export function WebShell() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: location => location.pathname });
  const isDownloadPage = pathname === '/download';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [installGuide, setInstallGuide] = useState<InstallGuideResponse | null>(null);
  const [installGuideReady, setInstallGuideReady] = useState(false);
  const { authStatus, userId, userName, avatarLarge, toastQueue, ToastProvider } = useJuejinClientLinkFlow();

  useEffect(() => {
    if (pathname === '/settings') {
      setSettingsOpen(true);
      void navigate({ to: '/dashboard', replace: true });
    }
  }, [pathname, navigate]);

  // Server mode: ask the cloud whether the current user should see the
  // installation guide. Only fires once authentication is ready to avoid
  // a 401 when the token is still being hydrated.
  useEffect(() => {
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
  }, [authStatus]);

  // Auto-open download page once for users who should see the guide.
  useEffect(() => {
    if (!installGuide?.shouldShowGuide) return;
    if (pathname === '/download') return;
    if (localStorage.getItem(AUTO_INSTALL_GUIDE_KEY)) return;
    localStorage.setItem(AUTO_INSTALL_GUIDE_KEY, '1');
    void navigate({ to: '/download', replace: true });
  }, [installGuide?.shouldShowGuide, navigate, pathname]);

  const installGuideUiValue = useMemo<InstallGuideUiContextValue>(
    () => ({
      // Web shell always exposes the entry; guests count as ready with no data.
      ready: installGuideReady || authStatus !== 'authenticated',
      hasUserData: installGuide?.reason === 'active',
      reason:
        installGuide?.reason === 'uninstalled'
          ? 'uninstalled'
          : installGuide?.reason === 'active'
            ? 'active'
            : 'new_user',
    }),
    [authStatus, installGuide, installGuideReady],
  );

  return (
    <AppToastProvider queue={toastQueue}>
      <JuejinAuthProvider {...{ authStatus, userId, userName, avatarLarge }}>
        <ShareSnapshotProvider>
          <InstallGuideUiProvider value={installGuideUiValue}>
            <div className="flex h-svh flex-col bg-[#f2f3f5] dark:bg-background">
              <WebHeader />
              <div className={`min-h-0 flex-1 overflow-auto ${isDownloadPage ? 'bg-background' : ''}`} key={pathname}>
                <div className={isDownloadPage ? 'mx-auto max-w-[1312px] px-4 pt-5' : 'mx-auto grid w-[calc(100%-32px)] max-w-[1200px] grid-cols-[180px_minmax(0,1fr)] items-start gap-6 pt-5 pb-10 max-[761px]:w-[calc(100%-16px)] max-[761px]:grid-cols-[48px_minmax(0,1fr)] max-[761px]:gap-2 max-[761px]:pt-3'}>
                  {!isDownloadPage && (
                    <aside className="sticky top-5 max-h-[calc(100svh-100px)] overflow-y-auto max-[761px]:top-3">
                      <nav className="grid bg-surface p-2 max-[761px]:p-0.5" aria-label="AI用量导航">
                        {sections.map(([to, label, Icon]) => (
                          <Link key={to} to={to} aria-label={label} title={label} className="group flex min-h-[46px] items-center gap-3 rounded-md px-4 text-base text-[#515767] hover:bg-[#f7f8fa] hover:text-accent aria-[current=page]:bg-(--web-primary-soft) aria-[current=page]:font-medium aria-[current=page]:text-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent dark:text-foreground dark:hover:bg-surface-secondary max-[761px]:justify-center max-[761px]:px-0">
                            <Icon className={`flex-none group-hover:text-current group-aria-[current=page]:text-current ${to === '/rank' ? 'text-[#e6ad4c]' : 'text-[#8a919f] dark:text-muted'}`} aria-hidden="true" size={20} />
                            <span className="max-[761px]:hidden">{label}</span>
                          </Link>
                        ))}
                      </nav>
                    </aside>
                  )}
                  <main data-panel-content className={isDownloadPage ? undefined : `min-w-0 bg-white dark:bg-surface ${pathname === '/dashboard' || pathname === '/pricing' ? '' : 'p-[12px]'}`}>
                    <Outlet />
                  </main>
                </div>
              </div>
              <ToastProvider placement="top end" queue={toastQueue} />
              <BackendConfigModal hideTrigger isOpen={settingsOpen} onOpenChange={setSettingsOpen} />
              <ShareActivityModal />
            </div>
          </InstallGuideUiProvider>
        </ShareSnapshotProvider>
      </JuejinAuthProvider>
    </AppToastProvider>
  );
}
