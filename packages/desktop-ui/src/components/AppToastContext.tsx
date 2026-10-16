import { createContext, useContext, type ReactNode } from 'react';
import type { ToastContentValue, ToastQueue } from '@heroui/react';

const AppToastContext = createContext<ToastQueue<ToastContentValue> | null>(
  null,
);

export function AppToastProvider({
  children,
  queue,
}: {
  children: ReactNode;
  queue: ToastQueue<ToastContentValue>;
}) {
  return (
    <AppToastContext.Provider value={queue}>
      {children}
    </AppToastContext.Provider>
  );
}

export function useAppToastQueue(): ToastQueue<ToastContentValue> {
  const queue = useContext(AppToastContext);
  if (!queue) {
    throw new Error('useAppToastQueue must be used within AppToastProvider');
  }
  return queue;
}
