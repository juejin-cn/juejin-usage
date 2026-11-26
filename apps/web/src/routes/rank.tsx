import { createFileRoute } from '@tanstack/react-router';
import { UserLeaderboardView } from '@web/components/UserLeaderboardView';

export const Route = createFileRoute('/rank')({ component: UserLeaderboardView });
