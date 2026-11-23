import { Link } from '@tanstack/react-router';
import { Button } from '@web/components/ui/button';
import { openJuejinAccountLogin } from '@/lib/juejin-client-link';
import { Card } from './components/UsageCard';
import usageEmpty from './assets/usage-empty.png';

const action = 'inline-flex h-9 min-w-24 items-center justify-center rounded-sm border px-3 text-sm font-normal';

export function UsageLoginGate({ checking }: { checking: boolean }) {
  return (
    <Card className="flex min-h-[clamp(248px,24vw,308px)] flex-col items-center justify-center text-center" aria-label="我的用量">
      <img src={usageEmpty} alt="" className="aspect-square w-[clamp(112px,10vw,148px)] max-w-full object-contain" />
      <p className="mt-1 text-[15px]/6 text-[#8a919f]" role="status">{checking ? '正在确认登录状态…' : '登录以后，可以查看我的 AI 用量'}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <Button variant="ghost" className={`${action} border-accent/32 bg-accent/5 text-accent enabled:hover:border-accent enabled:hover:bg-(--web-primary-soft) disabled:opacity-55`} disabled={checking} onClick={openJuejinAccountLogin}>
          立即登录
        </Button>
        <Link className={`${action} border-transparent bg-accent text-white hover:bg-[#1171ee]`} to="/download">下载客户端</Link>
      </div>
    </Card>
  );
}
