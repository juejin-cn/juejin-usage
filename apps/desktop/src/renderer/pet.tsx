import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopPetView } from './components/DesktopPetView';
import './pet.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopPetView />
  </StrictMode>,
);
