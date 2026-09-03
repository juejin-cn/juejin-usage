import { Moon, Sun } from '@gravity-ui/icons';
import { Tabs } from '@heroui/react';
import { useTheme } from '@/hooks/useTheme';

/** Light/dark selector matching the dashboard filter chrome. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const changeTheme = (key: string) => {
    const nextTheme = key;
    if (nextTheme === 'light' || nextTheme === 'dark') {
      setTheme(nextTheme);
    }
  };

  return (
    <Tabs
      className="w-fit shrink-0 text-center"
      selectedKey={theme}
      onSelectionChange={(key) => changeTheme(String(key))}
    >
      <Tabs.ListContainer>
        <Tabs.List aria-label="页面主题" className="w-fit">
          <Tabs.Tab
            aria-label="使用亮色模式"
            className="h-6 w-6 px-0 text-xs aria-selected:text-accent-foreground"
            id="light"
          >
            <Sun className="size-3.5" />
            <Tabs.Indicator className="bg-accent" />
          </Tabs.Tab>
          <Tabs.Tab
            aria-label="使用暗色模式"
            className="h-6 w-6 px-0 text-xs aria-selected:text-accent-foreground"
            id="dark"
          >
            <Moon className="size-3.5" />
            <Tabs.Indicator className="bg-accent" />
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}
