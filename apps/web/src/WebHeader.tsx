import { useContext, useState } from 'react';
import { ResolvedThemeContext } from '@/hooks/resolved-theme';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuLinkItem } from '@web/components/ui/dropdown-menu';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { IconBellFilled, IconCaretDownFilled, IconChevronDown, IconSearch } from '@tabler/icons-react';
import { useJuejinAuth } from '@/hooks/JuejinAuthContext';
import { openJuejinAccountLogin } from '@/lib/juejin-client-link';

const home = 'https://juejin.cn';
const links = [
  ['首页', home], ['沸点', home + '/pins'], ['课程', home + '/course'],
  ['APP', home + '/download'], ['AI用量', import.meta.env.VITE_ROUTER_BASE],
  ['作品广场', home + '/vibe-work'], ['专家标注', 'https://corexpert.juejin.cn/'],
] as const;
const assetRoot = 'https://lf-web-assets.juejin.cn/obj/juejin-web/xitu_juejin_web/';
const creatorLinks = [
  ['写文章', home + '/editor/drafts/new?v=2', '69704c654798bb27cffca68e5a79976e'],
  ['发沸点', home + '/pins?source=mainHeader', 'c225c20007c699a48fe9aa8a32be2ee6'],
  ['写笔记', home + '/flash-note', '92ff1e17678887b64c952833d9d0dd0b'],
  ['写代码', 'https://code.juejin.cn/', 'cf3f3dbcd5a32a7a4de5c7b834402cef'],
  ['写小册', home + '/editor/book/new/section?v=2', '01bac1a83da050f7f4f952c49cbfb865'],
  ['写视频课', home + '/editor/video/new/section?v=2', '16dffa790d175e97382100483d69996f'],
  ['草稿箱', home + '/editor/drafts?v=2', 'b1008fc20ddf1733b5bd800ed4bcc18e'],
] as const;

const popup = 'bg-surface text-foreground outline-none';
const menuItem = 'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-(--web-primary-soft) hover:text-accent data-highlighted:bg-(--web-primary-soft) data-highlighted:text-accent';
const avatar = 'grid size-9 flex-none place-items-center overflow-hidden rounded-full bg-[#e8f3ff] text-accent dark:bg-(--web-primary-soft)';

function CreatorActions() {
  return (
    <div className="mr-3 flex h-9 flex-none items-stretch rounded-[3px] bg-accent text-white max-[800px]:hidden">
      <a className="grid place-items-center rounded-l-[3px] px-3 hover:bg-[#1171ee]" href={home + '/creator/home'}>创作者中心</a>
      <DropdownMenu modal={false} orientation="horizontal">
        <DropdownMenuTrigger openOnHover delay={0} closeDelay={200} aria-label="展开创作菜单" className="group grid w-5 cursor-pointer place-items-center rounded-r-[3px] border-l border-white/20 hover:bg-[#1171ee] aria-expanded:bg-[#1171ee]">
          <IconCaretDownFilled aria-hidden="true" size={12} className="group-aria-expanded:rotate-180" />
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label="创作菜单" align="end" sideOffset={10} className={`${popup} grid w-[400px] max-w-[calc(100vw-16px)] grid-cols-5 gap-y-1 rounded-[4px] border border-border p-5 shadow-lg ring-0`}>
          {creatorLinks.map(([label, href, icon]) => (
            <DropdownMenuLinkItem
              key={label}
              label={label}
              href={href}
              className="grid h-[70px] min-w-0 cursor-pointer grid-rows-[40px_20px] content-center justify-items-center gap-1 rounded-md text-center text-sm/5 text-[#515767] outline-none hover:bg-(--web-primary-soft) hover:text-accent data-highlighted:bg-(--web-primary-soft) data-highlighted:text-accent dark:text-muted"
            >
              <img alt="" className="block size-10" width={40} height={40} src={assetRoot + icon + '.svg'} />
              <span className="whitespace-nowrap">{label}</span>
            </DropdownMenuLinkItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}


export function WebHeader() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const theme = useContext(ResolvedThemeContext);
  const { authStatus, userId, userName, avatarLarge } = useJuejinAuth();
  return (
    <header className="flex-none bg-white font-sans text-sm/normal text-[#515767] shadow-[0_2px_8px_rgb(0_0_0/3%)] dark:bg-surface dark:text-foreground">
      <div className="mx-auto flex h-[60px] w-full max-w-[1440px] items-center px-6 whitespace-nowrap max-[641px]:h-[52px] max-[641px]:px-3">
        <a className="mr-3 flex-none max-[641px]:mr-2" href={home}>
          <picture>
            <source media="(max-width: 640px)" srcSet={assetRoot + '6c61ae65d1c41ae8221a670fa32d05aa.svg'} />
            <img className="block h-[22px] w-[107px] max-[641px]:h-6 max-[641px]:w-[31px]" alt="稀土掘金" width="107" height="22" src={assetRoot + (theme === 'dark' ? '17d2678259b01bde1db1825a3307e5d2.svg' : 'e08da34488b114bd4c665ba2fa520a31.svg')} />
          </picture>
        </a>
        <nav className="flex self-stretch max-[1150px]:hidden" aria-label="掘金主导航">
          {links.map(([text, href]) => <a className="relative grid place-items-center px-3 aria-[current=location]:text-accent hover:text-[#252933] hover:after:absolute hover:after:inset-x-3 hover:after:bottom-0 hover:after:h-0.5 hover:after:bg-accent dark:hover:text-foreground" key={text} href={href} aria-current={text === 'AI用量' ? 'location' : undefined}>{text}</a>)}
        </nav>
        <DropdownMenu modal={false} open={navigationOpen} onOpenChange={setNavigationOpen}>
          <DropdownMenuTrigger aria-label="展开掘金导航" className="hidden items-center gap-1 text-accent max-[1150px]:inline-flex max-[641px]:mr-2 max-[641px]:flex-none max-[360px]:mr-auto">AI用量<IconChevronDown size={14} /></DropdownMenuTrigger>
          <DropdownMenuContent aria-label="掘金导航" align="start" sideOffset={10} className={`${popup} w-36 p-1`}>
            {links.map(([text, href]) => <DropdownMenuLinkItem className={menuItem} key={text} href={href}>{text}</DropdownMenuLinkItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <form className="group ml-auto mr-[17px] flex h-[34px] w-[346px] min-w-0 items-center rounded-[4px] border border-[#c2c8d1] pr-0.5 transition-[width] duration-200 hover:border-[#8a919f] focus-within:w-[480px] focus-within:border-accent dark:border-border dark:focus-within:border-accent max-[1351px]:w-[180px] max-[1351px]:focus-within:w-[324px] max-[1191px]:w-[260px] max-[1191px]:focus-within:w-[396px] max-[1070px]:w-[240px] max-[1070px]:focus-within:w-[382px] max-[800px]:w-[220px] max-[800px]:focus-within:w-[322px] max-[641px]:mr-2 max-[641px]:h-8 max-[641px]:w-auto max-[641px]:flex-1 max-[641px]:max-w-[172px] max-[641px]:focus-within:w-auto max-[641px]:focus-within:max-w-[220px] max-[360px]:hidden motion-reduce:transition-none" role="search" action={home + '/search'}>
          <Input type="search" maxLength={64} aria-label="搜索稀土掘金" name="query" placeholder="探索稀土掘金" className="h-full min-w-0 flex-1 border-0 bg-transparent py-0 ps-3 text-[13px] text-foreground focus-visible:ring-0" required />
          <Button variant="ghost" className="grid h-[30px] w-11 flex-none cursor-pointer place-items-center rounded-[2px] bg-[#f2f3f5] p-0 group-focus-within:bg-[#e8f3ff] group-focus-within:text-accent dark:bg-surface-secondary max-[641px]:h-7 max-[641px]:w-8" type="submit" aria-label="搜索"><IconSearch size={18} stroke={1.6} /></Button>
        </form>
        <CreatorActions />
        {authStatus === 'authenticated' && (
          <a className="mr-6 grid place-items-center text-[#8a919f] hover:text-[#515767] max-[641px]:mr-2" aria-label="消息通知" href={home + '/notification/system'}><IconBellFilled size={20} fill="currentColor" /></a>
        )}
        {authStatus === 'authenticated' ? (
          <a className={avatar} aria-label={userName || '个人主页'} href={home + '/user/' + encodeURIComponent(userId || '')}>
            {avatarLarge ? <img className="size-full object-cover" src={avatarLarge} alt="" referrerPolicy="no-referrer" /> : userName.slice(0, 1)}
          </a>
        ) : authStatus === 'loading' ? <span className={`${avatar} motion-safe:animate-pulse`} role="status" aria-label="正在加载账号" /> : (
          <Button variant="ghost" className="inline-flex h-9 cursor-pointer items-center rounded-[4px] border border-[#bcd9ff] bg-[#f4f9ff] px-3 text-sm font-normal text-accent dark:bg-(--web-primary-soft)" onClick={openJuejinAccountLogin}>登录<span className="flex items-center before:mx-1.5 before:h-3 before:w-px before:bg-[#abcdff] max-[800px]:hidden">注册</span></Button>
        )}
      </div>
    </header>
  );
}
