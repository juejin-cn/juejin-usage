import { TraeGlobalSubscriptionCard } from './TraeGlobalSubscriptionCard';
import { TraeCnSubscriptionCard } from './TraeCnSubscriptionCard';

export function TraeSubscriptionGroup({ showGlobal = true, showMainland = true }: { showGlobal?: boolean; showMainland?: boolean } = {}) {
  return <>{showGlobal ? <TraeGlobalSubscriptionCard /> : null}{showMainland ? <TraeCnSubscriptionCard /> : null}</>;
}
