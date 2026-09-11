import { MoonIcon, SunIcon, SunMoonIcon } from 'lucide-react';
import { Button, Tooltip } from '@heroui/react';
import type { ThemeMode } from '@/lib/theme';
import { useTheme } from '@/hooks/useTheme';

/** Icon component per mode; rendered lazily so only the active one mounts. */
const MODE_ICON: Record<ThemeMode, typeof SunMoonIcon> = {
  system: SunMoonIcon,
  light: SunIcon,
  dark: MoonIcon,
};

const MODE_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

/**
 * Single button that cycles the theme mode system → light → dark → system.
 * The icon and tooltip always show the currently active mode.
 */
export function ThemeToggle() {
  const { themeMode, toggleTheme } = useTheme();
  const Icon = MODE_ICON[themeMode];
  const label = MODE_LABEL[themeMode];

  return (
    <Tooltip closeDelay={80} delay={100}>
      <Button
        aria-label={`切换主题：当前${label}`}
        className="size-8 min-h-8 min-w-8 shrink-0 p-0"
        isIconOnly
        onPress={toggleTheme}
        size="sm"
        variant="tertiary"
      >
        <Icon className={themeMode === 'system' ? 'size-4 scale-[1.2]' : 'size-4'} />
      </Button>
      <Tooltip.Content placement="bottom">
        <p>{`主题：${label}`}</p>
      </Tooltip.Content>
    </Tooltip>
  );
}
