import { Tabs, TabsList, TabsTrigger, TabsContent } from '@web/components/ui/tabs';
import { IconChartBar, IconLayoutDashboard, IconLayoutNavbar } from '@tabler/icons-react';

const views = [
  { id: 'overview', label: '用量总览', icon: IconLayoutDashboard },
  { id: 'trends', label: '趋势分析', icon: IconChartBar },
  { id: 'menu-bar', label: '菜单栏', icon: IconLayoutNavbar },
] as const;

const assets = import.meta.env.BASE_URL;

export function DownloadPreview() {
  return (
    <section aria-label="产品预览" className="download-preview relative isolate min-w-0 overflow-hidden rounded-[22px] p-[clamp(12px,2vw,30px)]">
      <Tabs defaultValue="overview">
        <TabsList aria-label="选择预览视图" className="relative mx-auto flex h-9 w-fit max-w-full gap-0 rounded-full border border-white/40 bg-surface/80 p-0.5 shadow-sm">
          {views.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id} className="relative inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs text-muted sm:text-sm motion-safe:transition-[color,background-color,box-shadow] motion-safe:duration-200 data-active:text-foreground sm:px-3">
              <Icon size={15} aria-hidden="true" />{label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="relative grid overflow-hidden rounded-xl border border-white/40 bg-white/30 p-1">
          <TabsContent className="[grid-area:1/1] motion-safe:transition-opacity motion-safe:duration-[280ms] motion-safe:starting:opacity-0 " value="overview">
            <img src={assets + 'e2.png'} alt="用量总览，展示 Token 消耗、预估费用、订阅额度和活动热力图" width={2048} height={1560} className="block w-full rounded-lg" />
          </TabsContent>
          <TabsContent className="[grid-area:1/1] motion-safe:transition-opacity motion-safe:duration-[280ms] motion-safe:starting:opacity-0 " value="trends">
            <img src={assets + 'e3.png'} alt="按天查看 Token 和费用趋势，以及工具、模型和项目的用量分布" width={2048} height={1560} className="block w-full rounded-lg" />
          </TabsContent>
          <TabsContent className="[grid-area:1/1] motion-safe:transition-opacity motion-safe:duration-[280ms] motion-safe:starting:opacity-0 " value="menu-bar">
            <div className="flex aspect-[2048/1560] items-center justify-center gap-[4%] rounded-lg bg-surface">
              <img src={assets + 'e4.png'} alt="菜单栏中的订阅剩余额度" width={850} height={1460} className="w-[39%] max-w-sm rounded-lg" />
              <img src={assets + 'e5.png'} alt="菜单栏中的今日用量趋势" width={860} height={1460} className="w-[39%] max-w-sm rounded-lg" />
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </section>
  );
}
