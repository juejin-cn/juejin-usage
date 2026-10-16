import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopPetView } from '@juejin-opensource/jusage-desktop-ui/components/DesktopPetView';
import { initTudBridge } from './bridge';
import './pet.css';

/** Install the Tauri-backed `window.tud` before the pet view reads it. */
initTudBridge();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopPetView onContextMenuReport={(x: number, y: number) => window.tud.showPetContextMenu?.(x, y)} />
  </StrictMode>,
);
