import { net, protocol } from 'electron';
import { DEFAULT_DATA_DIR, petsDir } from '@juejin-opensource/jusage-core';
import { pathToFileURL } from 'node:url';
import type { DesktopPetCatalog } from '../shared/desktop-pet-catalog';
import { BUILTIN_DESKTOP_PET_IDS, scanDesktopPetDirectory } from './desktop-pet-scanner';

let localPets = new Map<string, string>();
let protocolRegistered = false;

export function desktopPetDirectory(): string {
  return petsDir(DEFAULT_DATA_DIR);
}

export async function scanDesktopPets(): Promise<DesktopPetCatalog> {
  const { catalog, spritesheets } = await scanDesktopPetDirectory(desktopPetDirectory());
  // Replace the asset map only after the whole directory was read successfully.
  localPets = spritesheets;
  return catalog;
}

export async function isKnownDesktopPet(id: string): Promise<boolean> {
  if (BUILTIN_DESKTOP_PET_IDS.has(id)) return true;
  await scanDesktopPets();
  return localPets.has(id);
}

export async function getDesktopPetSpritesheetUrl(id: string): Promise<string> {
  await scanDesktopPets();
  if (!localPets.has(id)) throw new Error('未找到本地宠物图集');
  return `pet-asset://desktop-pet/${encodeURIComponent(id)}`;
}

export function registerDesktopPetAssetProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  protocol.handle('pet-asset', async (request) => {
    const url = new URL(request.url);
    const id = url.hostname === 'desktop-pet' ? decodeURIComponent(url.pathname.slice(1)) : '';
    const path = localPets.get(id);
    if (!path) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path).toString());
  });
}
