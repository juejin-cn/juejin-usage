import { DownloadWordmark } from '../DownloadWordmark';
import { DownloadPreview } from '../DownloadPreview';
import { DownloadCliBlock } from '../DownloadCliBlock';
import { DownloadCommunityBar, DownloadContributorsWall } from '../DownloadCommunity';
import { useGithubCommunity } from '../useGithubCommunity';
import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RiAppleFill, RiArrowDownSLine, RiWindowsFill } from '@remixicon/react';
import juejinLogo from '@/assets/juejin-qr-logo.svg';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuLinkItem } from '@web/components/ui/dropdown-menu';
import { SUPPORTED_TOOLS } from '@/lib/about';
import { ToolLogoMarquee } from '../ToolLogoMarquee';
import { useDesktopDownload } from '@/hooks/useDesktopDownload';
import { useInstallGuideUi } from '@/hooks/InstallGuideUiContext';
import { DOWNLOAD_TARGETS } from '@/lib/downloads';
import { Button } from '@web/components/ui/button';

export const Route = createFileRoute('/download')({ component: DownloadPage });

const primaryAction = 'inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-[18px] text-base text-background';

function DownloadPage() {
  const { target, targetConfirmed, selectTarget, assetUrls, loadingAssets, release, releasesFallback } = useDesktopDownload();
  const community = useGithubCommunity();
  const disconnected = useInstallGuideUi()?.reason === 'uninstalled';
  const PlatformIcon = target.os === 'macos' ? RiAppleFill : RiWindowsFill;
  const [showCli, setShowCli] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const version = target.os === 'windows' ? 'Windows（x64）' : target.menuLabel;

  return (
    <article className="pt-[clamp(32px,4.5vw,72px)] text-foreground">
      <div className="mb-14 grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-12">
        <div className="min-w-0 lg:pt-10">
          <header>
            <h1 className="text-[clamp(30px,2.8vw,42px)] leading-tight font-medium tracking-[-.045em] text-balance">用<span className="download-name relative isolate mx-[.14em] inline-flex items-center gap-[.18em] overflow-hidden rounded-full px-[calc(.32em+2px)] py-0.5 align-baseline"><img className="size-[.75em] object-contain" src={juejinLogo} alt="" /><span className="sr-only">掘金 AI 用量</span><span aria-hidden="true" className="inline-grid text-center whitespace-nowrap [&>span]:[grid-area:1/1]"><span className="motion-safe:animate-[download-name-zh_8s_ease-in-out_infinite]">掘金 AI 用量</span><span className="opacity-0 motion-safe:animate-[download-name-en_8s_ease-in-out_infinite]" lang="en">Juejin Usage</span></span></span>看清 Token 花在哪里</h1>
            <p className="mt-3 max-w-[34rem] text-[17px]/[1.65] text-muted">
              {disconnected && '客户端暂未连接。'}把 Codex、Claude Code 和 Cursor 的用量汇总到一个面板。按项目查看 Token 消耗和预估费用，随时从菜单栏查看订阅剩余额度。
            </p>
            <div className="mt-6 flex flex-wrap gap-2.5">
              {targetConfirmed ? (
                loadingAssets ? (
                  <Button disabled className={primaryAction}>加载中…</Button>
                ) : (
                  <a className={primaryAction}
                    href={assetUrls[target.id] ?? releasesFallback} download={assetUrls[target.id] ? '' : undefined}
                    target="_blank" rel="noopener noreferrer"><PlatformIcon size={18} aria-hidden="true" />{assetUrls[target.id] ? `下载 ${version}` : `前往发布页 · ${version}`}</a>
                )
              ) : (
                <Button className={primaryAction} aria-haspopup="menu" aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(true)}>选择下载版本</Button>
              )}
              <Button className="h-11 min-w-32 cursor-pointer rounded-full border border-border bg-transparent px-[18px] text-base text-foreground hover:bg-surface-secondary aria-expanded:bg-surface-secondary" aria-expanded={showCli}
                aria-controls="download-cli" onClick={() => setShowCli(!showCli)}>使用 CLI</Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-sm text-muted">
              <DropdownMenu modal={false} triggerId="download-platform-trigger" open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger id="download-platform-trigger" className="group download-ghost-button" aria-label="选择其他下载平台">
                  其他版本 · {targetConfirmed
                    ? target.os === 'windows' ? 'Apple Silicon · Intel' : target.id === 'macos-arm' ? 'Intel · Windows' : 'Apple Silicon · Windows'
                    : 'Apple Silicon · Intel · Windows'}
                  <RiArrowDownSLine size={16} className="motion-safe:transition-transform group-aria-expanded:rotate-180" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent aria-label="下载平台" align="start" sideOffset={8}
                  className="w-[268px] max-w-[calc(100vw-32px)] p-1.5">
                  {DOWNLOAD_TARGETS.filter((item) => !targetConfirmed || item.id !== target.id).map((item) => {
                    const url = assetUrls[item.id];
                    const size = release?.assets.find((asset) => asset.browser_download_url === url)?.size;
                    const windows = item.os === 'windows';
                    const Icon = windows ? RiWindowsFill : RiAppleFill;
                    return (
                      <DropdownMenuLinkItem label={item.badgePlatform} key={item.id} className="group flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm/[1.35] hover:bg-surface-secondary focus-visible:bg-surface-secondary data-highlighted:bg-surface-secondary motion-safe:transition-colors" href={url ?? releasesFallback}
                        target="_blank" rel="noopener noreferrer" download={url ? '' : undefined}
                        onClick={() => selectTarget(item.id)}>
                        <span className="grid size-[34px] flex-none place-items-center rounded-lg bg-surface-secondary group-hover:bg-surface group-focus-visible:bg-surface group-data-highlighted:bg-surface motion-safe:transition-colors"><Icon size={16} aria-hidden="true" /></span>
                        <span>
                          {item.badgePlatform} <span className="text-muted">{windows ? 'x64' : item.id === 'macos-arm' ? 'Apple Silicon' : 'Intel'}</span>
                          <small className="mt-0.5 block text-[12.5px]/[1.3] text-muted">{windows ? '.exe' : '.dmg'} · {size && size > 0 ? `${Math.round(size / 1_000_000)} MB` : item.requirement}</small>
                        </span>
                      </DropdownMenuLinkItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div id="download-cli" className="grid grid-rows-[0fr] opacity-0 data-[open=true]:grid-rows-[1fr] data-[open=true]:opacity-100 motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-200" data-open={showCli} inert={!showCli}>
              <div className="min-h-0 overflow-hidden">
                <DownloadCliBlock />
              </div>
            </div>
          </header>
          <DownloadCommunityBar contributors={community.contributors} />
        </div>
        <DownloadPreview />
      </div>
      <section>
        <h2 className="mb-4 text-xl font-semibold">支持的工具（{SUPPORTED_TOOLS.length}）</h2>
        <ToolLogoMarquee />
      </section>
      <DownloadContributorsWall contributors={community.contributors} status={community.status} />
      <DownloadWordmark />
    </article>
  );
}
