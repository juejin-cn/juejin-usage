import clickSpritesheet from '@/assets/pets/click/click-spritesheet.webp';
import hawkingSpritesheet from '@/assets/pets/hawking/hawking-spritesheet.webp';
import yoyoSpritesheet from '@/assets/pets/yoyo/yoyo-spritesheet.webp';
import buddySpritesheet from '@/assets/pets/buddy/buddy-spritesheet.webp';

export interface DesktopPetDefinition {
  id: string;
  displayName: string;
  description: string;
  spritesheet: string;
  glow: {
    primary: string;
    accent: string;
  };
}

/**
 * The desktop-pet catalog. To add an IP, place its v2 atlas under
 * `assets/pets/<id>/` and register its display metadata and WebP here.
 */
export const DESKTOP_PETS: DesktopPetDefinition[] = [
  {
    id: 'hawking',
    displayName: 'Hawking',
    description: '橙色、锐眼的土星伙伴',
    spritesheet: hawkingSpritesheet,
    glow: {
      primary: '#ff7a1a',
      accent: '#ffd21f',
    },
  },
  {
    id: 'yoyo',
    displayName: 'Yoyo',
    description: '蓝色、胸前带星标的伙伴',
    spritesheet: yoyoSpritesheet,
    glow: {
      primary: '#2f7df6',
      accent: '#ffd84a',
    },
  },
  {
    id: 'click',
    displayName: 'Click',
    description: '青绿色、亮眼的克里克伙伴',
    spritesheet: clickSpritesheet,
    glow: {
      primary: '#51d6a2',
      accent: '#ff7b8d',
    },
  },
  {
    id: 'buddy',
    displayName: 'Buddy',
    description: '戴蓝色帽子的抽象狗，随时准备玩耍',
    spritesheet: buddySpritesheet,
    glow: {
      primary: '#4A90E2',
      accent: '#FFD700',
    },
  },
];

export function getDesktopPet(id: string): DesktopPetDefinition {
  return DESKTOP_PETS.find((pet) => pet.id === id) ?? DESKTOP_PETS[0]!;
}
