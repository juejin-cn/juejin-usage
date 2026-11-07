import { useEffect, useRef } from 'react';
import { Tabs } from '@heroui/react';
import { AlmostEqual, Globe } from '@gravity-ui/icons';
import { useLocation, useNavigate } from '@tanstack/react-router';

/** Inline panel switcher for the page header. */
export function PanelTabs() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const exitAnimation = useRef<Animation | null>(null);
  const switching = useRef(false);

  useEffect(() => () => exitAnimation.current?.cancel(), []);

  async function switchPanel(key: string | number) {
    const to = key === 'gateway' ? '/gateway' : '/dashboard';
    if (to === pathname || switching.current) return;
    switching.current = true;
    try {
      const content = document.querySelector<HTMLElement>('[data-panel-content]');
      if (content?.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const animation = content.animate(
          [{ opacity: getComputedStyle(content).opacity }, { opacity: 0 }],
          { duration: 120, easing: 'ease-in', fill: 'forwards' },
        );
        exitAnimation.current = animation;
        // An interrupted/unmounted panel must not navigate after its exit.
        try { await animation.finished; } catch { return; }
      }
      await navigate({ to });
    } finally {
      exitAnimation.current?.cancel();
      exitAnimation.current = null;
      switching.current = false;
    }
  }

  return (
    <Tabs
      className="w-fit shrink-0"
      orientation="horizontal"
      selectedKey={pathname === '/gateway' ? 'gateway' : 'dashboard'}
      onSelectionChange={(key) => {
        void switchPanel(key);
      }}
    >
      <Tabs.ListContainer className="w-fit">
        <Tabs.List aria-label="面板切换" className="!h-8 !min-h-8 !gap-1 !p-1">
          <Tabs.Tab id="dashboard" aria-label="用量" className="!h-6 !min-h-6 !w-10 !min-w-10 !px-0 !py-0">
            <AlmostEqual className="size-4" aria-hidden="true" />
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="gateway" aria-label="网关" className="!h-6 !min-h-6 !w-10 !min-w-10 !px-0 !py-0">
            <Globe className="size-4" aria-hidden="true" />
            <Tabs.Indicator />
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}
