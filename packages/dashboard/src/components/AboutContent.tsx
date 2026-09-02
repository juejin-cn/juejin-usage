import { Link } from '@heroui/react';
import { JUEJIN_PRIVACY_POLICY_URL } from '@/components/JuejinLoginConsentModal';
import { SupportedToolsGrid } from '@/components/SupportedToolsGrid';
import { APP_DISPLAY_NAME, appVersion } from '@/lib/about';

const FEEDBACK_URL = 'http://github.com/juejin-cn/juejin-usage/issues/new';

/** Shared about body — version + supported tools. */
export function AboutContent() {
  const version = appVersion();

  return (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <h3 className="text-sm font-medium text-foreground">版本信息</h3>
        <p className="text-sm text-foreground/70">
          {APP_DISPLAY_NAME}{' '}
          <span className="font-mono text-foreground/90">v{version}</span>
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-sm font-medium text-foreground">隐私与协议</h3>
        <Link
          className="w-fit text-sm text-accent"
          href={JUEJIN_PRIVACY_POLICY_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          查看用户隐私协议
          <Link.Icon />
        </Link>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-sm font-medium text-foreground">问题反馈</h3>
        <Link
          className="w-fit text-sm text-accent"
          href={FEEDBACK_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          提交问题反馈
          <Link.Icon />
        </Link>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">支持的工具</h3>
        <p className="text-xs text-foreground/55">
          同一系列的多端形态用括号标出。
        </p>
        <SupportedToolsGrid />
      </section>
    </div>
  );
}
