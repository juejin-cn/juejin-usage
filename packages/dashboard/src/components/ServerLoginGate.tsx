import { useState } from 'react';
import { Button } from '@heroui/react';
import { ArrowDownToLine } from '@gravity-ui/icons';
import { LogIn, RefreshCw, ShieldCheck } from 'lucide-react';

import { openJuejinAccountLogin } from '@/lib/juejin-client-link';

interface ServerLoginGateProps {
  loading: boolean;
  onRetry: () => Promise<boolean>;
  onDownload: () => void;
}

/**
 * Dashboard-only login boundary. Other public pages remain browsable while
 * personal usage data requires a signed-in Juejin session.
 */
export function ServerLoginGate({
  loading,
  onRetry,
  onDownload,
}: ServerLoginGateProps) {
  const [message, setMessage] = useState('');

  const retry = async () => {
    setMessage('');
    const authenticated = await onRetry();
    if (!authenticated) {
      setMessage('仍未检测到掘金登录，请完成登录后再重试。');
    }
  };

  return (
    <section className="flex min-h-[calc(100svh-9rem)] items-start pt-4 pb-10 sm:pt-6 sm:pb-14 lg:pt-8">
      <div className="w-full max-w-2xl motion-safe:animate-[fade-up_420ms_ease-out]">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base text-muted">
          <span>个人用量</span>
          <span aria-hidden="true" className="text-foreground/25">
            ·
          </span>
          <ShieldCheck aria-hidden="true" className="size-4 text-foreground/70" />
          <span>登录后查看</span>
        </p>

        <h1 className="mt-6 text-[2.15rem] leading-[1.15] font-semibold tracking-tight text-foreground sm:text-5xl sm:leading-[1.12] lg:text-[3.15rem] lg:leading-[1.1]">
          登录掘金账号
          <br />
          查看你的 AI 用量
          <br />
          与趋势明细。
        </h1>

        <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Button
            className="h-14 min-h-14 rounded-full px-6 text-base font-medium"
            onPress={() => {
              setMessage('完成登录后返回此页面，再点击“我已完成登录”。');
              openJuejinAccountLogin();
            }}
            variant="primary"
          >
            <LogIn aria-hidden="true" size={18} />
            去登录
          </Button>
          <Button
            className="h-14 min-h-14 rounded-full px-6 text-base font-medium"
            isDisabled={loading}
            isPending={loading}
            onPress={() => void retry()}
            variant="outline"
          >
            <RefreshCw aria-hidden="true" size={18} />
            我已完成登录
          </Button>
          <Button
            className="h-14 min-h-14 rounded-full px-6 text-base font-medium"
            onPress={onDownload}
            variant="outline"
          >
            <ArrowDownToLine aria-hidden="true" className="size-4.5" />
            去下载客户端
          </Button>
        </div>

        {message ? (
          <p aria-live="polite" className="mt-4 text-sm leading-6 text-foreground/55">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
