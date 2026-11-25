import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import {
  IconAward,
  IconChartBar,
  IconDownload,
  IconGitPullRequest,
  IconMailOpened,
  IconStack2,
  IconTag,
} from '@tabler/icons-react';
import { AppToastProvider } from '@/components/AppToastContext';
import { BackendConfigModal } from '@/components/BackendConfigModal';
import { UsageReceiptModal } from './components/UsageReceiptModal';
import { FeedbackPopoverTrigger } from './components/FeedbackPopoverTrigger';
import { InstallGuideUiProvider, type InstallGuideUiContextValue } from '@/hooks/InstallGuideUiContext';
import { JuejinAuthProvider } from '@/hooks/JuejinAuthContext';
import { ShareSnapshotProvider } from '@/hooks/ShareSnapshotContext';
import { useJuejinClientLinkFlow } from '@/hooks/useJuejinClientLinkFlow';
import { fetchInstallGuide, type InstallGuideResponse } from '@/lib/api';
import { GITHUB_REPO_URL } from '@/lib/downloads';
import { WebHeader } from './WebHeader';

const AUTO_INSTALL_GUIDE_KEY = 'tud.installGuideAutoOpened';
const GITHUB_PULLS_URL = `${GITHUB_REPO_URL}/pulls`;

const sections = [
  ['/dashboard', '我的用量', IconChartBar],
  ['/rank', '用户排行', IconAward],
  ['/model-rank', '模型排行', IconStack2],
  ['/pricing', '模型价格', IconTag],
] as const;

const sidebarTileItem =
  'group flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center py-4 text-[14px] leading-5 text-[#8a919f] transition-colors hover:bg-[#f7f8fa] hover:text-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent dark:text-muted dark:hover:bg-surface-secondary sm:max-[761px]:min-h-[42px] sm:max-[761px]:flex-none sm:max-[761px]:py-0';

const sidebarCardFooterItem =
  'group flex min-h-[44px] w-full items-center justify-center gap-2 border-t border-[#f0f0f0] text-[14px] text-[#8a919f] transition-colors hover:bg-[#f7f8fa] hover:text-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent dark:border-white/10 dark:text-muted dark:hover:bg-surface-secondary sm:max-[761px]:min-h-[42px]';

function useIsMobileViewport() {
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

export function WebShell() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: location => location.pathname });
  const isDownloadPage = pathname === '/download';
  const isMobile = useIsMobileViewport();
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
                <div
                  className={
                    isDownloadPage
                      ? 'mx-auto max-w-[1312px] px-4 pt-5 pb-10'
                      : 'mx-auto grid w-[calc(100%-32px)] max-w-[1200px] grid-cols-[180px_minmax(0,1fr)] items-start gap-6 pt-5 pb-10 max-[761px]:w-[calc(100%-16px)] max-[761px]:grid-cols-[48px_minmax(0,1fr)] max-[761px]:gap-2 max-[761px]:pt-3 max-sm:w-full max-sm:grid-cols-1 max-sm:gap-0 max-sm:pt-0 max-sm:pb-6'
                  }
                >
                  {!isDownloadPage && (
                    <aside className="sticky top-5 flex max-h-[calc(100svh-100px)] flex-col gap-3 overflow-y-auto max-[761px]:top-3 max-[761px]:gap-2 max-sm:contents">
                      <nav
                        className="grid bg-surface p-2 max-[761px]:p-0.5 max-sm:sticky max-sm:top-0 max-sm:z-20 max-sm:order-1 max-sm:grid-cols-4 max-sm:border-b max-sm:border-[#f0f0f0] max-sm:px-1.5 max-sm:py-1 dark:max-sm:border-white/8"
                        aria-label="AI用量导航"
                      >
                        {sections.map(([to, label, Icon]) => (
                          <Link
                            key={to}
                            to={to}
                            aria-label={label}
                            title={label}
                            className="group flex min-h-[46px] items-center gap-3 rounded-md px-4 text-base text-[#515767] hover:bg-[#f7f8fa] hover:text-accent aria-[current=page]:bg-(--web-primary-soft) aria-[current=page]:font-medium aria-[current=page]:text-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent dark:text-foreground dark:hover:bg-surface-secondary max-[761px]:justify-center max-[761px]:px-0 max-sm:min-h-[40px] max-sm:flex-col max-sm:gap-0.5 max-sm:py-1 max-sm:text-[11px]/4"
                          >
                            <Icon
                              className={`flex-none group-hover:text-current group-aria-[current=page]:text-current ${to === '/rank' ? 'text-[#e6ad4c]' : 'text-[#8a919f] dark:text-muted'}`}
                              aria-hidden="true"
                              size={19}
                            />
                            <span className="sm:max-[761px]:hidden">{label}</span>
                          </Link>
                        ))}
                      </nav>

                      <div className="max-sm:order-3 max-sm:mt-3">
                        {/* 参与贡献 & 问题反馈 + 客户端下载 合并卡片 */}
                        <div
                          aria-label="参与贡献、问题反馈与客户端下载"
                          className="overflow-hidden bg-surface max-sm:rounded-lg"
                        >
                          <div className="flex items-stretch sm:max-[761px]:flex-col">
                            <a
                              href={GITHUB_PULLS_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="参与贡献"
                              title="参与贡献"
                              className={sidebarTileItem}
                            >
                              <IconGitPullRequest
                                size={22}
                                stroke={1.75}
                                aria-hidden="true"
                                className="shrink-0 transition-colors sm:max-[761px]:size-[19px]"
                              />
                              <span className="mt-2 whitespace-nowrap sm:max-[761px]:hidden">参与贡献</span>
                            </a>

                            <div
                              aria-hidden="true"
                              className="my-4 w-px shrink-0 bg-[#f0f0f0] dark:bg-white/10 sm:max-[761px]:hidden"
                            />

                            <FeedbackPopoverTrigger
                              variant="sidebar"
                              side={isMobile ? 'top' : 'right'}
                              align={isMobile ? 'end' : 'center'}
                              label="问题反馈"
                              icon={(
                                <IconMailOpened
                                  size={22}
                                  stroke={1.75}
                                  aria-hidden="true"
                                  className="shrink-0 transition-colors sm:max-[761px]:size-[19px]"
                                />
                              )}
                              className={sidebarTileItem}
                              labelClassName="mt-2 whitespace-nowrap sm:max-[761px]:hidden"
                            />
                          </div>

                          <Link
                            to="/download"
                            aria-label="客户端下载"
                            title="客户端下载"
                            className={sidebarCardFooterItem}
                          >
                            <IconDownload
                              size={18}
                              stroke={1.75}
                              className="shrink-0 transition-colors"
                              aria-hidden="true"
                            />
                            <span className="truncate sm:max-[761px]:hidden">客户端下载</span>
                          </Link>
                        </div>
                      </div>
                    </aside>
                  )}
                  <main
                    data-panel-content
                    className={
                      isDownloadPage
                        ? undefined
                        : `min-w-0 bg-white dark:bg-surface max-sm:order-2 ${pathname === '/dashboard' || pathname === '/pricing' || pathname === '/rank' || pathname === '/model-rank' ? '' : 'p-[12px]'}`
                    }
                  >
                    <Outlet />
                  </main>
                </div>
              </div>
              <ToastProvider placement="top end" queue={toastQueue} />
              <BackendConfigModal hideTrigger isOpen={settingsOpen} onOpenChange={setSettingsOpen} />
              <UsageReceiptModal />
            </div>
          </InstallGuideUiProvider>
        </ShareSnapshotProvider>
      </JuejinAuthProvider>
    </AppToastProvider>
  );
}
