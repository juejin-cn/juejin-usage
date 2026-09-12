import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopPetView } from './components/DesktopPetView';
import { initTudBridge } from './bridge';
import './pet.css';

/** Install the Tauri-backed `window.tud` before the pet view reads it. */
initTudBridge();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopPetView />
  </StrictMode>,
);
