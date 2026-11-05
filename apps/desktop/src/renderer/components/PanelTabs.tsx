import { Tabs } from '@heroui/react';
import { ChartColumn, Network } from 'lucide-react';
import { useLocation, useNavigate } from '@tanstack/react-router';

/** Inline panel switcher for the page header. */
export function PanelTabs() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();

  return (
    <Tabs
      className="w-fit shrink-0"
      orientation="horizontal"
      selectedKey={pathname === '/gateway' ? 'gateway' : 'dashboard'}
      onSelectionChange={(key) => {
        void navigate({ to: key === 'gateway' ? '/gateway' : '/dashboard' });
      }}
    >
      <Tabs.ListContainer className="w-fit">
        <Tabs.List aria-label="面板切换" className="!h-8 !min-h-8 !gap-1 !p-1">
          <Tabs.Tab id="dashboard" aria-label="用量" className="!h-6 !min-h-6 !w-10 !min-w-10 !px-0 !py-0">
            <ChartColumn className="size-4" aria-hidden="true" />
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="gateway" aria-label="网关" className="!h-6 !min-h-6 !w-10 !min-w-10 !px-0 !py-0">
            <Network className="size-4" aria-hidden="true" />
            <Tabs.Indicator />
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}
