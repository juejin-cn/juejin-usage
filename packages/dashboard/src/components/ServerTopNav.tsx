import { useState } from 'react';
import { ChevronDown } from '@gravity-ui/icons';
import { Link } from '@tanstack/react-router';
import { Button, Popover, Skeleton } from '@heroui/react';
import type { JuejinAuthStatus } from '@/hooks/useJuejinClientLinkFlow';
import { useTheme } from '@/hooks/useTheme';
import { openJuejinAccountLogin } from '@/lib/juejin-client-link';
import { cn } from '@/lib/utils';

const JUEJIN_HOME_URL = 'https://juejin.cn';
const JUEJIN_DARK_LOGO_URL =
  '//lf-web-assets.juejin.cn/obj/juejin-web/xitu_juejin_web/e08da34488b114bd4c665ba2fa520a31.svg';
const JUEJIN_LIGHT_LOGO_URL =
  'https://lf-web-assets.juejin.cn/obj/juejin-web/xitu_juejin_web/17d2678259b01bde1db1825a3307e5d2.svg';

type NavItem =
  | { kind: 'internal'; to: '/dashboard' | '/rank' | '/pricing'; label: string }
  | { kind: 'external'; href: string; label: string };

const NAV_ITEMS: NavItem[] = [
  { kind: 'internal', to: '/dashboard', label: '用量' },
  { kind: 'internal', to: '/rank', label: '排行榜' },
  { kind: 'internal', to: '/pricing', label: '模型价格' },
  { kind: 'external', href: 'https://juejin.cn/vibe-work', label: '作品广场' },
  { kind: 'external', href: 'https://juejin.cn/pins', label: '沸点' },
];

const navLinkClass = (active: boolean) =>
  cn(
    'inline-flex h-full items-center text-[15px] font-normal transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-accent',
    active
      ? 'text-[#1e80ff] dark:text-[#4b9cff]'
      : 'text-foreground/70 hover:text-foreground dark:text-foreground/65 dark:hover:text-foreground',
  );

const dropdownItemClass = (active: boolean) =>
  cn(
    'flex min-h-11 w-full items-center px-4 text-[15px] font-normal whitespace-nowrap',
    'transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
    active
      ? 'text-[#1e80ff] dark:text-[#4b9cff]'
      : 'text-[#515767] hover:text-foreground dark:text-foreground/65 dark:hover:text-foreground',
  );

interface ServerTopNavProps {
  pathname: string;
  authStatus: JuejinAuthStatus;
  userName?: string;
  avatarLarge?: string;
}

function navItemKey(item: NavItem) {
  return item.kind === 'internal' ? item.to : item.href;
}

function isNavItemActive(item: NavItem, pathname: string) {
  return item.kind === 'internal' && item.to === pathname;
}

function currentNavLabel(pathname: string) {
  const match = NAV_ITEMS.find((item) => isNavItemActive(item, pathname));
  return match?.label ?? '用量';
}

function NavItemLink({
  item,
  pathname,
  className,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  className: (active: boolean) => string;
  onNavigate?: () => void;
}) {
  if (item.kind === 'external') {
    return (
      <a
        className={className(false)}
        href={item.href}
        rel="noreferrer"
        target="_blank"
        onClick={onNavigate}
      >
        {item.label}
      </a>
    );
  }

  const active = isNavItemActive(item, pathname);

  return (
    <Link
      aria-current={active ? 'page' : undefined}
      className={className(active)}
      to={item.to}
      onClick={onNavigate}
    >
      {item.label}
    </Link>
  );
}

function MobileNavDropdown({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const currentLabel = currentNavLabel(pathname);

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button
        aria-label={`当前栏目：${currentLabel}，展开导航`}
        className={cn(
          'h-11 min-h-11 min-w-11 gap-1 rounded-none border-0 bg-transparent px-1 py-0',
          'text-[15px] font-normal text-[#1e80ff] shadow-none',
          'hover:bg-transparent hover:text-[#1e80ff]',
          'data-[pressed=true]:bg-transparent data-[pressed=true]:text-[#1e80ff]',
          'dark:text-[#4b9cff] dark:hover:text-[#4b9cff]',
          'dark:data-[pressed=true]:text-[#4b9cff]',
        )}
        variant="ghost"
      >
        <span>{currentLabel}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 opacity-80 transition-transform duration-200',
            'motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </Button>
      <Popover.Content
        className="min-w-28 overflow-hidden rounded-md border-0 bg-white p-0 text-foreground shadow-[0_4px_16px_rgba(0,0,0,0.12)] dark:bg-[#181818] dark:shadow-[0_4px_16px_rgba(0,0,0,0.45)]"
        placement="bottom start"
      >
        <Popover.Dialog className="p-0 outline-none">
          <Popover.Heading className="sr-only">站点导航</Popover.Heading>
          <nav aria-label="主导航" className="flex flex-col py-1">
            {NAV_ITEMS.map((item) => (
              <NavItemLink
                className={dropdownItemClass}
                item={item}
                key={navItemKey(item)}
                pathname={pathname}
                onNavigate={() => setOpen(false)}
              />
            ))}
          </nav>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

function AvatarFallback({ userName }: { userName: string }) {
  const initial = userName.trim().slice(0, 1) || '?';
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-8 items-center justify-center rounded-full bg-[#1e80ff]/12 text-[13px] font-medium text-[#1e80ff] dark:bg-[#4b9cff]/15 dark:text-[#4b9cff]"
    >
      {initial}
    </span>
  );
}

/** Public server header. Kept separate from the CLI's floating navigation. */
export function ServerTopNav({
  pathname,
  authStatus,
  userName = '',
  avatarLarge = '',
}: ServerTopNavProps) {
  const { theme } = useTheme();
  const logoUrl = theme === 'dark' ? JUEJIN_LIGHT_LOGO_URL : JUEJIN_DARK_LOGO_URL;
  const showLogin = authStatus === 'unauthenticated';
  const showAvatar = authStatus === 'authenticated';
  const showAvatarSkeleton = authStatus === 'loading';
  const nickname = userName.trim();

  return (
    <header className="relative z-40 h-15 shrink-0 bg-white shadow-none dark:bg-[#181818]">
      <div className="mx-auto flex h-full w-full max-w-240 items-center gap-3 px-4 sm:gap-8 md:gap-12 md:px-8">
        <a
          aria-label="前往稀土掘金"
          className="shrink-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          href={JUEJIN_HOME_URL}
        >
          <img alt="稀土掘金" className="h-[22px] w-[107px]" src={logoUrl} />
        </a>

        <div className="md:hidden">
          <MobileNavDropdown pathname={pathname} />
        </div>

        <nav
          aria-label="主导航"
          className="hidden h-full items-center gap-7 md:flex"
        >
          {NAV_ITEMS.map((item) => (
            <NavItemLink
              className={navLinkClass}
              item={item}
              key={navItemKey(item)}
              pathname={pathname}
            />
          ))}
        </nav>

        {showLogin ? (
          <Button
            className="ml-auto shrink-0 font-normal"
            onPress={openJuejinAccountLogin}
            size="sm"
            variant="outline"
          >
            登录
          </Button>
        ) : null}

        {showAvatarSkeleton ? (
          <Skeleton
            aria-hidden="true"
            className="ml-auto size-8 shrink-0 rounded-full"
          />
        ) : null}

        {showAvatar ? (
          <span
            className="ml-auto inline-flex size-8 shrink-0 overflow-hidden rounded-full"
            title={nickname || undefined}
          >
            {avatarLarge ? (
              <img
                alt={nickname || '用户头像'}
                className="size-8 rounded-full object-cover"
                referrerPolicy="no-referrer"
                src={avatarLarge}
                title={nickname || undefined}
              />
            ) : (
              <AvatarFallback userName={nickname} />
            )}
          </span>
        ) : null}
      </div>
    </header>
  );
}
