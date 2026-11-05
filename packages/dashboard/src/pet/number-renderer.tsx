import { createRoot } from 'react-dom/client';
import { AnimatedNumber } from '../components/AnimatedNumber';
import { formatTokens, formatUsd } from '../lib/format';

/** Only the two numeric slots use React; sprite painting stays outside its render loop. */
export function createPetNumberRenderer(tokens: HTMLElement, cost: HTMLElement) {
  const tokenRoot = createRoot(tokens), costRoot = createRoot(cost);
  let target: { tokens: number; cost: number } | null = null;
  function clear() { target = null; tokenRoot.render(null); costRoot.render(null); }
  return {
    update(next: { tokens: number; cost: number }) {
      if (target?.tokens === next.tokens && target?.cost === next.cost) return;
      target = next;
      tokenRoot.render(<AnimatedNumber value={next.tokens} format={formatTokens} animateFromZero />);
      costRoot.render(<AnimatedNumber value={next.cost} format={formatUsd} animateFromZero />);
    },
    loading() { target = null; tokenRoot.render('…'); costRoot.render('…'); },
    error() { target = null; tokenRoot.render('--'); costRoot.render('--'); },
    clear,
    dispose() { tokenRoot.unmount(); costRoot.unmount(); },
  };
}
