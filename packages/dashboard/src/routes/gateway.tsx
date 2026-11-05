import { createFileRoute } from '@tanstack/react-router';
import { AIGatewayCard } from '@/components/AIGatewayCard';

export const Route = createFileRoute('/gateway')({
  component: GatewayPage,
});

function GatewayPage() {
  return <AIGatewayCard />;
}
