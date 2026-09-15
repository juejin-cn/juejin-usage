import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './hooks/useTheme';
import { dispatchDataSynced } from './lib/shell-events';
import { TrayPopoverView } from './components/TrayPopoverView';
import { initTudBridge } from './bridge';
import './index.css';

/** Install the Tauri-backed `window.tud` before anything reads it. */
initTudBridge();

/** Bridge main-process Core sync → same CustomEvent the tray view listens for. */
if (typeof window.tud?.onDataSynced === 'function') {
  window.tud.onDataSynced(() => {
    dispatchDataSynced();
  });
}

// This entry only hosts the tray popover (`?view=tray-popover`). The main
// dashboard window no longer loads this renderer — it loads the CLI-hosted
// dashboard dist served over loopback (`http://127.0.0.1:8462/`, see
// `tauri.conf.json` main window url + `sidecar.rs`), so the dashboard
// router / `AppShell` / `DashboardPage` copy that used to live under
// `routes/` + `pages/` was removed in the same pass.
const isTrayPopover = new URLSearchParams(window.location.search).get('view') === 'tray-popover';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isTrayPopover ? (
      <ThemeProvider>
        <TrayPopoverView />
      </ThemeProvider>
    ) : (
      <div data-tud-shell-fallback />
    )}
  </StrictMode>,
);
