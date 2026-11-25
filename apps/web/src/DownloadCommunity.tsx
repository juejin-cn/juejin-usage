import { type MouseEvent } from 'react';
import { FeedbackPopoverTrigger } from './components/FeedbackPopoverTrigger';
import { Tooltip, TooltipTrigger, TooltipContent } from '@web/components/ui/tooltip';
import { IconArrowUpRight, IconPlus } from '@tabler/icons-react';
import { GITHUB_REPO_URL } from '@/lib/downloads';
import {
  withAvatarSize,
  type GithubCommunityData,
} from './useGithubCommunity';

const PULLS_URL = `${GITHUB_REPO_URL}/pulls`;

export function DownloadCommunityBar({
  contributors,
}: Pick<GithubCommunityData, 'contributors'>) {
  const previewAvatars = contributors.slice(0, 5);

  function scrollToContributors(event: MouseEvent<HTMLAnchorElement>) {
    const target = document.getElementById('contributors');
    if (!target) return;
    event.preventDefault();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'start',
    });
  }

  return (
    <div
      aria-label="开源社区与支持"
      className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2.5 text-sm"
    >
      <a
        className="inline-flex items-center gap-2 text-muted transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        href="#contributors"
        onClick={scrollToContributors}
      >
        {previewAvatars.length > 0 ? (
          <>
            <span aria-hidden="true" className="flex -space-x-1.5">
              {previewAvatars.map((contributor) => (
                <img
                  key={contributor.id}
                  alt=""
                  className="size-5.5 rounded-full bg-surface-secondary object-cover ring-2 ring-background"
                  decoding="async"
                  height={22}
                  src={withAvatarSize(contributor.avatarUrl, 64)}
                  width={22}
                />
              ))}
            </span>
            <span className="tabular-nums">{contributors.length} 位贡献者</span>
          </>
        ) : (
          <span>贡献者墙</span>
        )}
      </a>

      <span aria-hidden="true" className="h-3 w-px bg-border" />

      <FeedbackPopoverTrigger />
    </div>
  );
}

export function DownloadContributorsWall({
  contributors,
}: Pick<GithubCommunityData, 'contributors'>) {

  return (
    <section
      aria-labelledby="contributors-heading"
      className="mt-14 scroll-mt-20"
      id="contributors"
    >
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="text-xl font-semibold" id="contributors-heading">
          开源贡献者{contributors.length > 0 ? `（${contributors.length}）` : ''}
        </h2>
        <a
          className="group inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          href={PULLS_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          <span>提交 PR 即可上榜</span>
          <IconArrowUpRight
            aria-hidden="true"
            className="size-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
          />
        </a>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto p-1 [scrollbar-width:thin]">
          {contributors.map(contributor => (
            <Tooltip key={contributor.id}>
              <TooltipTrigger delay={120} closeDelay={60} render={<a aria-label={`${contributor.login}（${contributor.contributions} 次提交）`}
                href={contributor.htmlUrl} rel="noopener noreferrer" target="_blank"
                className="block shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-accent" />}>
                <img alt="" className="size-9 rounded-full object-cover ring-1 ring-border"
                  loading="lazy" src={withAvatarSize(contributor.avatarUrl, 96)} width={44} height={44} />
              </TooltipTrigger>
              <TooltipContent>@{contributor.login}{contributor.contributions > 0 && ` · ${contributor.contributions} 次提交`}</TooltipContent>
            </Tooltip>
          ))}
          <Tooltip>
            <TooltipTrigger delay={120} closeDelay={60} render={<a aria-label="提交 PR 成为贡献者" href={PULLS_URL} rel="noopener noreferrer" target="_blank"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted hover:text-foreground" />}>
              <IconPlus aria-hidden="true" size={18} />
            </TooltipTrigger>
            <TooltipContent>提交 PR 即可上榜</TooltipContent>
          </Tooltip>
      </div>
    </section>
  );
}
