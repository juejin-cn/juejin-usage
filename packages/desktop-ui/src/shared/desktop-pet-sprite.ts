import {
  DESKTOP_PET_SOURCE_HEIGHT,
  DESKTOP_PET_SOURCE_WIDTH,
} from './desktop-pet-layout';

export type PetAnimation = 'idle' | 'running-left' | 'running-right';

const PET_SPRITE_COLS = 8;
const PET_SPRITE_ROWS = 11;
export const PET_SPRITESHEET_WIDTH = DESKTOP_PET_SOURCE_WIDTH * PET_SPRITE_COLS;
export const PET_SPRITESHEET_HEIGHT = DESKTOP_PET_SOURCE_HEIGHT * PET_SPRITE_ROWS;

const PET_ANIMATION_ROWS: Record<PetAnimation, { row: number; frames: number }> = {
  idle: { row: 0, frames: 6 },
  'running-right': { row: 1, frames: 8 },
  'running-left': { row: 2, frames: 8 },
};

/**
 * Click's generated running-left row contains a corrupt frame with neighboring
 * poses baked into the same cell. Its right-running row is mirror-safe, so use
 * that complete row as the left-running source instead of displaying the
 * damaged pixels.
 */
function resolvePetAnimation(
  selectedPetId: string,
  animation: PetAnimation,
): { source: PetAnimation; mirrorX: boolean } {
  if (selectedPetId === 'click' && animation === 'running-left') {
    return { source: 'running-right', mirrorX: true };
  }
  return { source: animation, mirrorX: false };
}

export function petSpriteCell(
  selectedPetId: string,
  animation: PetAnimation,
  frame: number,
) {
  const rendered = resolvePetAnimation(selectedPetId, animation);
  const { row, frames } = PET_ANIMATION_ROWS[rendered.source];
  const currentFrame = ((frame % frames) + frames) % frames;
  return {
    currentFrame,
    frames,
    row,
    sourceX: currentFrame * DESKTOP_PET_SOURCE_WIDTH,
    sourceY: row * DESKTOP_PET_SOURCE_HEIGHT,
    mirrorX: rendered.mirrorX,
  };
}

/** Write the current atlas cell onto the sprite node without a React render. */
export function paintPetSpriteFrame(
  el: HTMLElement | null,
  selectedPetId: string,
  animation: PetAnimation,
  frame: number,
  spriteWidth: number,
  spriteHeight: number,
) {
  const cell = petSpriteCell(selectedPetId, animation, frame);
  if (!el) return;
  el.style.backgroundPosition = `${-cell.currentFrame * spriteWidth}px ${-cell.row * spriteHeight}px`;
  el.style.transform = cell.mirrorX ? 'scaleX(-1)' : 'none';
}
