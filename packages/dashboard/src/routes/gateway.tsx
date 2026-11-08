import { createFileRoute, redirect } from '@tanstack/react-router';
import { AIGatewayCard } from '@/components/AIGatewayCard';
import { hasAgentRouter } from '@/lib/agent-router';

export const Route = createFileRoute('/gateway')({
  beforeLoad: () => {
    // Gateway host is Tauri-only; CLI and online Web stay on usage.
    if (!hasAgentRouter()) {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: GatewayPage,
});

function GatewayPage() {
  return <AIGatewayCard />;
}
