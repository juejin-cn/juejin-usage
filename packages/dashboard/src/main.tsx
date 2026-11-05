import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { ThemeProvider } from './hooks/useTheme';
import { getTauriDesktopBridge } from './lib/tauri-desktop';
import { TrayPopoverView } from './components/TrayPopoverView';
import { router } from './router';
import './index.css';

if (getTauriDesktopBridge()?.platform === 'darwin') {
  document.documentElement.classList.add('tauri-darwin');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      {getTauriDesktopBridge() && new URLSearchParams(location.search).get('view') === 'tray-popover' ? <TrayPopoverView /> : <RouterProvider router={router} />}
    </ThemeProvider>
  </StrictMode>,
);
