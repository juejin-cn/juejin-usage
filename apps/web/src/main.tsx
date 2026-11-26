import { StrictMode, useLayoutEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { ResolvedThemeContext } from '@/hooks/resolved-theme';
import { readJuejinTheme, subscribeJuejinTheme } from './juejin-theme';
import { router } from './router';
import { TooltipProvider } from './components/ui/tooltip';
import './web.css';

function WebApp() {
  const theme = useSyncExternalStore(subscribeJuejinTheme, readJuejinTheme);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }, [theme]);

  return <ResolvedThemeContext.Provider value={theme}><RouterProvider router={router} /></ResolvedThemeContext.Provider>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider><WebApp /></TooltipProvider>
  </StrictMode>,
);
