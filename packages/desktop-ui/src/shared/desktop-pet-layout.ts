export const DESKTOP_PET_SOURCE_WIDTH = 192;
export const DESKTOP_PET_SOURCE_HEIGHT = 208;
export const DESKTOP_PET_POPOVER_WIDTH = 136;
/**
 * Headroom above the sprite for the two-row token bubble, its arrow, and the
 * gap above the sprite. Sized so the bubble stays inside the host window.
 */
export const DESKTOP_PET_POPOVER_TOP_SPACE = 116;
export const DESKTOP_PET_HORIZONTAL_GUTTER = 12;

export interface DesktopPetLayout {
  hostWidth: number;
  hostHeight: number;
  spriteWidth: number;
  spriteHeight: number;
  spriteLeft: number;
  spriteTop: number;
  popoverWidth: number;
  popoverTop: number;
}

/** Single source of truth for the native host, sprite, and bubble centerline. */
export function getDesktopPetLayout(scale: number): DesktopPetLayout {
  const spriteWidth = Math.round(DESKTOP_PET_SOURCE_WIDTH * scale);
  const spriteHeight = Math.round(DESKTOP_PET_SOURCE_HEIGHT * scale);
  const topSpace = DESKTOP_PET_POPOVER_TOP_SPACE;
  const hostWidth = Math.max(
    spriteWidth,
    DESKTOP_PET_POPOVER_WIDTH + DESKTOP_PET_HORIZONTAL_GUTTER * 2,
  );

  return {
    hostWidth,
    hostHeight: spriteHeight + topSpace,
    spriteWidth,
    spriteHeight,
    spriteLeft: Math.round((hostWidth - spriteWidth) / 2),
    spriteTop: topSpace,
    popoverWidth: DESKTOP_PET_POPOVER_WIDTH,
    popoverTop: topSpace,
  };
}
