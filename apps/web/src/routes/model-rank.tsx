import { createFileRoute } from '@tanstack/react-router';
import { ModelRankPage } from '@/pages/ModelRankPage';

export const Route = createFileRoute('/model-rank')({ component: ModelRankPage });
