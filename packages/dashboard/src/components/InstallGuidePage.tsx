import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy } from '@gravity-ui/icons';
import { Button, Popover } from '@heroui/react';
import { SupportedToolsGrid } from '@/components/SupportedToolsGrid';
import { WeChatSupportTrigger } from '@/components/WeChatSupportTrigger';
import {
  DOWNLOAD_TARGETS,
  GITEE_REPO_URL,
  GITHUB_REPO_URL,
  detectMacArch,
  detectOsFamily,
  fallbackReleasePage,
  fetchDesktopReleaseAssets,
  getDownloadTarget,
  matchReleaseAsset,
  resolveDefaultTarget,
  type DownloadTargetId,
  type ReleaseSource,
} from '@/lib/downloads';
import { cn } from '@/lib/utils';

export type InstallGuideReason = 'new_user' | 'uninstalled';

interface InstallGuidePageProps {
  reason: InstallGuideReason;
}

interface GuideCopy {
  badge: string;
  headline: [string, string, string];
  description: string;
}

type CliVariantId = 'npx' | 'install-start';

const copyByReason: Record<InstallGuideReason, GuideCopy> = {
  new_user: {
    badge: 'Juejin Usage',
    headline: [
      'Cursor、Claude、Codex',
      '多工具 Token 与费用',
      '本地面板一张表看完。',
    ],
    description:
      '汇总你实际在用的 AI 编码工具用量与趋势，安装后即可查看。',
  },
  uninstalled: {
    badge: '客户端暂未连接',
    headline: [
      '客户端暂未连接',
      '启动后继续',
      '同步本机用量。',
    ],
    description:
      '下载并打开 Juejin Usage，即可把本机 AI 用量同步回这块面板。',
  },
};

const PREVIEW_SRC = `${import.meta.env.BASE_URL}e1.png`;
const CLI_VARIANTS: readonly {
  id: CliVariantId;
  label: string;
  command: string;
}[] = [
  {
    id: 'install-start',
    label: 'npm',
    command: 'npm i -g @juejin-opensource/jusage && jusage service start',
  },
  {
    id: 'npx',
    label: 'npx',
    command: 'npx @juejin-opensource/jusage start',
  },
] as const;

const SESSION_TARGET_KEY = 'tud.downloadTarget';

function readSessionTarget(): DownloadTargetId | null {
  try {
    const raw = sessionStorage.getItem(SESSION_TARGET_KEY);
    if (raw && DOWNLOAD_TARGETS.some((t) => t.id === raw)) {
      return raw as DownloadTargetId;
    }
  } catch {
    // sessionStorage unavailable in some private browsing modes
  }
  return null;
}

function writeSessionTarget(id: DownloadTargetId): void {
  try {
    sessionStorage.setItem(SESSION_TARGET_KEY, id);
  } catch {
    // ignore
  }
}

/**
 * Server-only download landing. Two-column hero: copy + OS-aware installer
 * on the left, product preview on the right.
 * Installers prefer Gitee Releases, then fall back to GitHub.
 */
export function InstallGuidePage({ reason }: InstallGuidePageProps) {
  const content = copyByReason[reason];
  const [targetId, setTargetId] = useState<DownloadTargetId>(() => {
    const saved = readSessionTarget();
    if (saved) return saved;
    if (typeof navigator === 'undefined') return 'macos-arm';
    return resolveDefaultTarget(
      detectOsFamily(navigator.userAgent, navigator.platform),
      detectMacArch(navigator.userAgent),
    );
  });
  const [assetUrls, setAssetUrls] = useState<
    Partial<Record<DownloadTargetId, string>>
  >({});
  const [releaseSource, setReleaseSource] = useState<ReleaseSource | undefined>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [cliMenuOpen, setCliMenuOpen] = useState(false);
  const [cliVariant, setCliVariant] = useState<CliVariantId>('npx');
  const [copied, setCopied] = useState(false);
  const [starLabel, setStarLabel] = useState<string | null>(null);
  const userPickedRef = useRef(readSessionTarget() !== null);

  const target = getDownloadTarget(targetId);
  const releasesFallback = fallbackReleasePage(releaseSource);
  const activeCliVariant =
    CLI_VARIANTS.find((item) => item.id === cliVariant) ?? CLI_VARIANTS[0];

  useEffect(() => {
    let cancelled = false;
    const nav = navigator as Navigator & {
      userAgentData?: {
        platform?: string;
        getHighEntropyValues?: (
          hints: string[],
        ) => Promise<{ architecture?: string; platform?: string }>;
      };
    };

    const apply = (architecture?: string, uaPlatform?: string) => {
      if (cancelled || userPickedRef.current) return;
      setTargetId(
        resolveDefaultTarget(
          detectOsFamily(
            nav.userAgent,
            nav.platform,
            uaPlatform ?? nav.userAgentData?.platform ?? '',
          ),
          detectMacArch(nav.userAgent, architecture),
        ),
      );
    };

    apply();
    void nav.userAgentData
      ?.getHighEntropyValues?.(['architecture', 'platform'])
      .then((highEntropy) => {
        apply(highEntropy.architecture, highEntropy.platform);
      })
      .catch(() => {
        // Sync UA detection is enough when Client Hints are blocked.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchDesktopReleaseAssets()
      .then((release) => {
        if (cancelled) return;
        const next: Partial<Record<DownloadTargetId, string>> = {};
        for (const item of DOWNLOAD_TARGETS) {
          const url = matchReleaseAsset(release.assets, item.id);
          if (url) next[item.id] = url;
        }
        setAssetUrls(next);
        setReleaseSource(release.source);
      })
      .catch(() => {
        // Direct asset lookup is best-effort; Gitee/GitHub releases page remains the fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    let cancelled = false;
    void fetch('https://api.github.com/repos/juejin-cn/juejin-usage', {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { stargazers_count?: number } | null) => {
        const count = payload?.stargazers_count;
        if (cancelled || typeof count !== 'number' || !Number.isFinite(count)) {
          return;
        }
        setStarLabel(formatStarCount(count));
      })
      .catch(() => {
        // Star count is decorative; the GitHub link still works without it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startDownload = (id: DownloadTargetId) => {
    const url = assetUrls[id] ?? releasesFallback;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.rel = 'noopener noreferrer';
    anchor.target = '_blank';
    if (assetUrls[id]) anchor.download = '';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };

  const copyCliCommand = async () => {
    try {
      await navigator.clipboard.writeText(activeCliVariant.command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="flex min-h-[calc(100svh-9rem)] items-start pt-4 pb-10 sm:pt-6 sm:pb-14 lg:pt-8">
      <div className="flex w-full flex-col gap-14 sm:gap-16 lg:gap-20">
        <div className="grid w-full items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-16 xl:gap-20">
        <div className="max-w-2xl motion-safe:animate-[fade-up_420ms_ease-out] lg:max-w-none">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base text-muted">
            <span>{content.badge}</span>
            <span aria-hidden="true" className="text-foreground/25">
              ·
            </span>
            {target.os === 'windows' ? (
              <WindowsMark className="size-4 text-foreground/70" />
            ) : (
              <AppleMark className="size-4 text-foreground/70" />
            )}
            <span>适用于 {target.badgePlatform}</span>
          </p>

          <h1 className="mt-6 text-[2.15rem] leading-[1.15] font-semibold tracking-tight text-foreground sm:text-5xl sm:leading-[1.12] lg:text-[3.15rem] lg:leading-[1.1]">
            {content.headline[0]}
            <br />
            {content.headline[1]}
            <br />
            {content.headline[2]}
          </h1>

          <p className="mt-5 max-w-xl text-lg leading-8 text-muted">
            {content.description}
          </p>

          <div className="mt-9 flex flex-col gap-4">
            <div
              aria-label="下载客户端"
              className="inline-flex max-w-full shrink-0 overflow-hidden rounded-full shadow-[0_1px_2px_rgb(0_0_0/0.06)]"
              role="group"
            >
              <button
                className={cn(downloadBtnClass, 'rounded-l-full ps-6 pe-5')}
                type="button"
                onClick={() => startDownload(targetId)}
              >
                {target.os === 'windows' ? (
                  <WindowsMark className="size-4.5" />
                ) : (
                  <AppleMark className="size-4.5" />
                )}
                {target.label}
              </button>
              <Popover isOpen={menuOpen} onOpenChange={setMenuOpen}>
                <Button
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  aria-label="选择其它系统"
                  className={cn(
                    downloadBtnClass,
                    'h-14! min-h-14! min-w-14 rounded-l-none rounded-r-full border-0 p-0 shadow-none',
                    'bg-[#1e80ff]! text-white! hover:bg-[#1171ee]!',
                    'relative before:absolute before:inset-y-2.5 before:left-0 before:w-px before:bg-white/30',
                    'dark:bg-[#4b9cff]! dark:hover:bg-[#3a8ff0]!',
                  )}
                  isIconOnly
                  variant="primary"
                >
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      'size-4.5 transition-transform duration-200 motion-reduce:transition-none',
                      menuOpen && 'rotate-180',
                    )}
                  />
                </Button>
                <Popover.Content
                  className="min-w-56 overflow-hidden rounded-[10px] border-0 bg-overlay p-0 text-overlay-foreground shadow-surface"
                  placement="bottom start"
                >
                  <Popover.Dialog className="p-0 outline-none">
                    <Popover.Heading className="sr-only">
                      选择下载平台
                    </Popover.Heading>
                    <div className="flex flex-col py-1" role="menu">
                      {DOWNLOAD_TARGETS.map((item) => {
                        const selected = item.id === targetId;
                        return (
                          <button
                            aria-current={selected ? 'true' : undefined}
                            className={cn(
                              'flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left text-sm',
                              'transition-colors duration-150',
                              'hover:bg-surface-secondary',
                              'focus-visible:bg-surface-secondary focus-visible:outline-none',
                              selected
                                ? 'text-foreground'
                                : 'text-foreground/80',
                            )}
                            key={item.id}
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              userPickedRef.current = true;
                              writeSessionTarget(item.id);
                              setTargetId(item.id);
                              setMenuOpen(false);
                            }}
                          >
                            {item.os === 'windows' ? (
                              <WindowsMark className="size-4 text-foreground/70" />
                            ) : (
                              <AppleMark className="size-4 text-foreground/70" />
                            )}
                            <span className="min-w-0 flex-1">{item.menuLabel}</span>
                            {selected ? (
                              <Check
                                aria-hidden="true"
                                className="size-4 text-[#1e80ff] dark:text-[#4b9cff]"
                              />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>
            </div>

            <div className="flex min-h-14 min-w-0 max-w-2xl items-center gap-2 rounded-2xl border border-border bg-surface-secondary/80 p-2 ps-3 dark:bg-overlay/60">
              <Popover isOpen={cliMenuOpen} onOpenChange={setCliMenuOpen}>
                <Button
                  aria-expanded={cliMenuOpen}
                  aria-haspopup="menu"
                  aria-label="选择 CLI 启动方式"
                  className="h-10 min-h-10 shrink-0 gap-1 rounded-full bg-background/80 px-3 text-xs font-medium text-foreground shadow-none hover:bg-background dark:bg-black/10 dark:hover:bg-black/20"
                  variant="secondary"
                >
                  <span>{activeCliVariant.label}</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      'size-3.5 transition-transform duration-200 motion-reduce:transition-none',
                      cliMenuOpen && 'rotate-180',
                    )}
                  />
                </Button>
                <Popover.Content
                  className="min-w-60 overflow-hidden rounded-[10px] border-0 bg-overlay p-0 text-overlay-foreground shadow-surface"
                  placement="bottom start"
                >
                  <Popover.Dialog className="p-0 outline-none">
                    <Popover.Heading className="sr-only">
                      选择 CLI 启动方式
                    </Popover.Heading>
                    <div className="flex flex-col py-1" role="menu">
                      {CLI_VARIANTS.map((item) => {
                        const selected = item.id === cliVariant;
                        return (
                          <button
                            aria-current={selected ? 'true' : undefined}
                            className={cn(
                              'flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left text-sm',
                              'transition-colors duration-150 hover:bg-surface-secondary',
                              'focus-visible:bg-surface-secondary focus-visible:outline-none',
                              selected ? 'text-foreground' : 'text-foreground/80',
                            )}
                            key={item.id}
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setCliVariant(item.id);
                              setCliMenuOpen(false);
                            }}
                          >
                            <span className="min-w-0 flex-1">{item.label}</span>
                            {selected ? (
                              <Check
                                aria-hidden="true"
                                className="size-4 text-[#1e80ff] dark:text-[#4b9cff]"
                              />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>
              <div className="min-w-0 flex-1 overflow-hidden rounded-xl bg-background/75 px-3 py-2 dark:bg-black/10">
                <code className="block overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground/85 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  $ {activeCliVariant.command}
                </code>
              </div>
              <button
                aria-label={copied ? '安装命令已复制' : '复制 CLI 安装命令'}
                className={cn(
                  'inline-flex size-11 shrink-0 items-center justify-center rounded-full',
                  'text-muted transition-colors duration-150',
                  'hover:bg-background hover:text-foreground',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  'touch-manipulation',
                )}
                type="button"
                onClick={() => {
                  void copyCliCommand();
                }}
              >
                {copied ? (
                  <Check
                    aria-hidden="true"
                    className="size-4 text-[#1e80ff] dark:text-[#4b9cff]"
                  />
                ) : (
                  <Copy aria-hidden="true" className="size-4" />
                )}
              </button>
            </div>
          </div>
          <p aria-live="polite" className="sr-only">
            {copied ? '安装命令已复制' : ''}
          </p>

          <p className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span>{target.requirement}</span>
            <span aria-hidden="true">·</span>
            <span>CLI 需 Node.js 20+</span>
            <span aria-hidden="true">·</span>
            <a
              className="inline-flex items-center gap-1 text-foreground/70 transition-colors hover:text-foreground"
              href={GITEE_REPO_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              <GiteeMark className="size-3.5" />
              Gitee
            </a>
            <span aria-hidden="true">·</span>
            <WeChatSupportTrigger variant="link" />
          </p>

          <a
            aria-label="在 GitHub 上 Star 本项目"
            className="mt-4 flex w-full max-w-xl items-center gap-4 rounded-2xl border border-border bg-surface-secondary/80 px-5 py-4 shadow-[0_1px_2px_rgb(0_0_0/0.06)] outline-offset-2 transition-colors hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-accent dark:bg-overlay/60 dark:hover:bg-overlay/80"
            href={GITHUB_REPO_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GithubMark className="size-8 shrink-0" />
            <span className="min-w-0">
              <span className="flex items-baseline gap-2">
                <span className="text-base font-medium text-foreground">
                  ⭐️ Star
                </span>
                {starLabel ? (
                  <span className="text-sm font-medium tabular-nums text-foreground/55">
                    {starLabel}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block text-sm leading-6 text-muted">
                开源共享，欢迎提 Issue 与贡献代码
              </span>
            </span>
          </a>
        </div>

        <div className="min-w-0 motion-safe:animate-[fade-up_520ms_ease-out]">
          <figure className="overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-[0_24px_48px_-28px_rgb(15_23_42/0.45)] dark:shadow-[0_24px_48px_-24px_rgb(0_0_0/0.65)]">
            <img
              alt="Juejin Usage 用量看板界面预览：费用、Token、热力图与趋势图"
              className="h-auto w-full"
              decoding="async"
              fetchPriority="high"
              height={1560}
              src={PREVIEW_SRC}
              width={2102}
            />
          </figure>
        </div>
        </div>

        <section aria-labelledby="supported-tools-heading" className="w-full">
          <h2
            className="text-lg font-semibold tracking-tight text-foreground sm:text-xl"
            id="supported-tools-heading"
          >
            支持的工具
          </h2>
          <div className="mt-4">
            <SupportedToolsGrid className="lg:grid-cols-3" collapsible />
          </div>
        </section>
      </div>
    </section>
  );
}

const downloadBtnClass = cn(
  'inline-flex h-14 min-h-14 cursor-pointer items-center justify-center gap-2.5',
  'bg-[#1e80ff] text-base font-medium whitespace-nowrap text-white',
  'transition-colors duration-200 motion-reduce:transition-none',
  'hover:bg-[#1171ee] active:brightness-[0.96]',
  'focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1e80ff]',
  'dark:bg-[#4b9cff] dark:hover:bg-[#3a8ff0] dark:focus-visible:outline-[#4b9cff]',
  'touch-manipulation',
);

function formatStarCount(count: number): string {
  if (count < 1000) return String(Math.floor(count));
  const thousands = count / 1000;
  const digits = count >= 10_000 ? 0 : 1;
  return `${thousands.toFixed(digits).replace(/\.0$/, '')}k`;
}

/** GitHub Octicon `mark-github` (24×24). */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      focusable="false"
      overflow="visible"
      viewBox="0 0 24 24"
    >
      <path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943" />
    </svg>
  );
}

/** Official Apple () mark — bitten apple with leaf, not a fruit icon. */
function AppleMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

function GiteeMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M11.984 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.016 0zm6.09 5.333c.328 0 .593.266.592.593v1.482a.594.594 0 0 1-.593.592H9.777c-.982 0-1.778.796-1.778 1.778v5.63c0 .327.266.592.593.592h5.63c.982 0 1.778-.796 1.778-1.778v-.296a.593.593 0 0 0-.592-.593h-4.15a.592.592 0 0 1-.592-.592v-1.482a.593.593 0 0 1 .593-.592h6.815c.327 0 .593.265.593.592v3.408a4 4 0 0 1-4 4H5.926a.593.593 0 0 1-.593-.593V9.778a4.444 4.444 0 0 1 4.445-4.444h8.296z" />
    </svg>
  );
}

function WindowsMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M3 5.2 11.2 4v7.4H3V5.2Zm8.9-1.4L21 2.6v8.8h-9.1V3.8ZM3 13.4h8.2V21L3 19.7v-6.3Zm8.9 0H21V21.4l-9.1-1.3v-6.7Z" />
    </svg>
  );
}
