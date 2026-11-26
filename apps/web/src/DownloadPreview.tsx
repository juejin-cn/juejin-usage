import { useState } from 'react';
import { Segmented } from './components/Segmented';
import { IconChartBar, IconLayoutDashboard, IconLayoutNavbar } from '@tabler/icons-react';
import { cn } from '@web/lib/utils';

const views = [
  { id: 'overview', label: '用量总览', icon: IconLayoutDashboard },
  { id: 'trends', label: '趋势分析', icon: IconChartBar },
  { id: 'menu-bar', label: '菜单栏', icon: IconLayoutNavbar },
] as const;

const viewOptions = views.map(({ id, label, icon: Icon }) => ({
  id,
  label: <><Icon size={15} aria-hidden="true" />{label}</>,
}));

type ViewId = (typeof views)[number]['id'];

const assets = import.meta.env.BASE_URL;

export function DownloadPreview() {
  const [activeView, setActiveView] = useState<ViewId>('overview');
  const activeIndex = views.findIndex((view) => view.id === activeView);

  const panelClass = (index: number) =>
    cn(
      '[grid-area:1/1] motion-safe:transition-[opacity,translate,scale] motion-safe:duration-180 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:translate-x-0 motion-reduce:scale-100',
      index === activeIndex
        ? 'z-1 translate-x-0 scale-100 opacity-100'
        : index < activeIndex
          ? 'pointer-events-none z-0 -translate-x-2 scale-[0.985] opacity-0'
          : 'pointer-events-none z-0 translate-x-2 scale-[0.985] opacity-0',
    );

  return (
    <section aria-label="产品预览" className="download-preview relative isolate min-w-0 overflow-hidden rounded-[22px] p-[clamp(12px,2vw,30px)]">
      <div className="mb-4 flex justify-center">
        <Segmented appearance="pill" label="选择预览视图" options={viewOptions} value={activeView} onChange={setActiveView} />
      </div>
      <div className="relative overflow-hidden rounded-xl border border-white/40 bg-white/30 p-1">
        <div className="relative grid aspect-[2048/1560] overflow-hidden rounded-lg bg-surface">
          <div inert={activeView !== 'overview'} className={panelClass(0)}>
            <img src={assets + 'e2.png'} alt="用量总览，展示 Token 消耗、预估费用、订阅额度和活动热力图" width={2048} height={1560} fetchPriority="high" loading="eager" decoding="async" className="block size-full rounded-lg object-cover" />
          </div>
          <div inert={activeView !== 'trends'} className={panelClass(1)}>
            <img src={assets + 'e3.png'} alt="按天查看 Token 和费用趋势，以及工具、模型和项目的用量分布" width={2048} height={1560} loading="eager" decoding="async" className="block size-full rounded-lg object-cover" />
          </div>
          <div inert={activeView !== 'menu-bar'} className={panelClass(2)}>
            <div className="flex size-full items-center justify-center gap-[4%] rounded-lg bg-surface">
              <img src={assets + 'e4.png'} alt="菜单栏中的订阅剩余额度" width={850} height={1460} loading="eager" decoding="async" className="w-[39%] max-w-sm rounded-lg" />
              <img src={assets + 'e5.png'} alt="菜单栏中的今日用量趋势" width={860} height={1460} loading="eager" decoding="async" className="w-[39%] max-w-sm rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
