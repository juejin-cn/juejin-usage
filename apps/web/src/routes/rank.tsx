import { createFileRoute } from '@tanstack/react-router';
import { RankPage } from '@/pages/RankPage';

export const Route = createFileRoute('/rank')({ component: RankPage });
