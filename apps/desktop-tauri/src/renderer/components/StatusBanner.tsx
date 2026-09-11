import { Alert } from '@heroui/react';

export type BannerTone = 'info' | 'warn' | 'error' | 'success';

const statusByTone = {
  info: 'accent',
  warn: 'warning',
  error: 'danger',
  success: 'success',
} as const;

interface StatusBannerProps {
  tone?: BannerTone;
  title: string;
  description?: string;
}

/** Shared feedback banner using HeroUI's semantic status colors. */
export function StatusBanner({
  tone = 'info',
  title,
  description,
}: StatusBannerProps) {
  return (
    <Alert status={statusByTone[tone]}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        {description && <Alert.Description>{description}</Alert.Description>}
      </Alert.Content>
    </Alert>
  );
}
