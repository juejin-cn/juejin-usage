import type { ToastContentValue, ToastQueue } from '@heroui/react';
import { Spinner, Toast } from '@heroui/react';

export type AppToastContent = ToastContentValue;

export function AppToastProvider({
  queue,
}: {
  queue: ToastQueue<AppToastContent>;
}) {
  return (
    <Toast.Provider
      // Keep the toast and its outer close button below the 32px window drag region.
      className="top-12 sm:min-w-0"
      placement="top end"
      queue={queue}
      width={0}
    >
      {({ toast: toastItem }) => {
        const content = toastItem.content as AppToastContent;

        return (
          <Toast
            className="start-auto w-max max-w-[calc(100vw-2rem)]"
            toast={toastItem}
            variant={content.variant}
          >
            {content.indicator === null ? null : content.isLoading ? (
              <Toast.Indicator variant={content.variant}>
                <Spinner color="current" size="sm" />
              </Toast.Indicator>
            ) : (
              <Toast.Indicator variant={content.variant}>
                {content.indicator}
              </Toast.Indicator>
            )}
            <Toast.Content>
              {content.title ? (
                <Toast.Title>{content.title}</Toast.Title>
              ) : null}
              {content.description ? (
                <Toast.Description>{content.description}</Toast.Description>
              ) : null}
            </Toast.Content>
            {content.actionProps?.children ? (
              <Toast.ActionButton {...content.actionProps}>
                {content.actionProps.children}
              </Toast.ActionButton>
            ) : null}
            <Toast.CloseButton />
          </Toast>
        );
      }}
    </Toast.Provider>
  );
}
