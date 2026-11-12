import { useEffect, useState, type RefObject } from 'react';
import { gatewayProviderColumns, gatewayRuntimeColumns } from '@/lib/gateway-grid-visible';

export function useGatewayProviderColumns(): number {
  const [columns, setColumns] = useState(() =>
    typeof window === 'undefined' ? 3 : gatewayProviderColumns(window.innerWidth));
  useEffect(() => {
    const update = () => setColumns(gatewayProviderColumns(window.innerWidth));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return columns;
}

export function useGatewayRuntimeColumns(ref: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setColumns(gatewayRuntimeColumns(node.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}
