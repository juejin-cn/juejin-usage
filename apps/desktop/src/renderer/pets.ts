import type { DesktopPetDefinition } from '../shared/desktop-pet-catalog';
export type { DesktopPetDefinition } from '../shared/desktop-pet-catalog';

/**
 * The desktop-pet catalog. To add an IP, place its v2 atlas under
 * `assets/pets/<id>/` and register its display metadata and WebP loader here.
 * Spritesheets are loaded on demand (loadPetSpritesheet) so the pet renderer
 * only decodes the atlas it actually displays.
 */
export const DESKTOP_PETS: DesktopPetDefinition[] = [
  {
    id: 'hawking',
    displayName: 'Hawking',
    description: '橙色、锐眼的土星伙伴',
    glow: {
      primary: '#ff7a1a',
      accent: '#ffd21f',
    },
    source: 'builtin',
  },
  {
    id: 'yoyo',
    displayName: 'Yoyo',
    description: '蓝色、胸前带星标的伙伴',
    glow: {
      primary: '#2f7df6',
      accent: '#ffd84a',
    },
    source: 'builtin',
  },
  {
    id: 'click',
    displayName: 'Click',
    description: '青绿色、亮眼的克里克伙伴',
    glow: {
      primary: '#51d6a2',
      accent: '#ff7b8d',
    },
    source: 'builtin',
  },
];

export function getDesktopPet(id: string, catalog: DesktopPetDefinition[] = DESKTOP_PETS): DesktopPetDefinition {
  return catalog.find((pet) => pet.id === id) ?? DESKTOP_PETS[0]!;
}

/** Dynamic imports so an unchosen pet's WebP is never loaded by the pet window. */
const SPRITESHEET_LOADERS: Record<string, () => Promise<string>> = {
  hawking: () =>
    import('@/assets/pets/hawking/hawking-spritesheet.webp').then((m) => m.default),
  yoyo: () =>
    import('@/assets/pets/yoyo/yoyo-spritesheet.webp').then((m) => m.default),
  click: () =>
    import('@/assets/pets/click/click-spritesheet.webp').then((m) => m.default),
};

export function loadPetSpritesheet(id: string): Promise<string> {
  const loader = SPRITESHEET_LOADERS[id];
  return loader ? loader() : window.tud.getDesktopPetSpritesheetUrl(id);
}
