import { Link } from '@tanstack/react-router';
import { emptyActionClass, UsageEmptyAction, UsageEmptyIllustration } from './components/UsageEmptyState';
import { openJuejinAccountLogin } from '@/lib/juejin-client-link';
import { Card } from './components/UsageCard';

export function UsageLoginGate() {
  return (
    <Card className="flex min-h-[clamp(248px,24vw,308px)] flex-col items-center justify-center text-center" aria-label="我的用量">
      <UsageEmptyIllustration />
      <p className="mt-1 text-[15px]/6 text-[#8a919f]" role="status">登录以后，可以查看我的 AI 用量</p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <UsageEmptyAction onClick={openJuejinAccountLogin}>
          立即登录
        </UsageEmptyAction>
        <Link className={`${emptyActionClass} border-transparent bg-accent text-white hover:bg-[#1171ee]`} to="/download">下载客户端</Link>
      </div>
    </Card>
  );
}
