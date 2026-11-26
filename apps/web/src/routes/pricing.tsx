import { createFileRoute } from '@tanstack/react-router';
import { PricingCatalogView } from '@web/components/PricingCatalogView';

export const Route = createFileRoute('/pricing')({ component: PricingCatalogView });
