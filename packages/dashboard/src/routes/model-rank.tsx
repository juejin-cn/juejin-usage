import { createFileRoute, redirect } from '@tanstack/react-router';
import { isCliBackend } from '@/lib/api';
import { ModelRankPage } from '@/pages/ModelRankPage';
import { getTauriDesktopBridge } from '@/lib/tauri-desktop';

export const Route = createFileRoute('/model-rank')({
  beforeLoad: () => {
    if (isCliBackend() || getTauriDesktopBridge()) throw redirect({ to: '/dashboard' });
  },
  component: ModelRankPage,
});
