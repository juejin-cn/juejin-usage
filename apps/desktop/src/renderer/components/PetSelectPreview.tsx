import { useEffect, useState, type CSSProperties } from 'react';
import { loadPetSpritesheet } from '@/pets';
import {
  DESKTOP_PET_SOURCE_HEIGHT,
  DESKTOP_PET_SOURCE_WIDTH,
} from '../../shared/desktop-pet-layout';

const SHEET_COLS = 8;
const SHEET_ROWS = 11;
/** Compact idle-frame-0 thumbnail for the pet Select. */
const PREVIEW_SCALE = 32 / DESKTOP_PET_SOURCE_WIDTH;

/**
 * Shows the idle (row 0, frame 0) cell of a pet spritesheet.
 * Builtin and local pets both resolve through `loadPetSpritesheet`.
 */
export function PetSelectPreview({
  petId,
  className,
}: {
  petId: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    void loadPetSpritesheet(petId)
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [petId]);

  const width = Math.round(DESKTOP_PET_SOURCE_WIDTH * PREVIEW_SCALE);
  const height = Math.round(DESKTOP_PET_SOURCE_HEIGHT * PREVIEW_SCALE);
  const style: CSSProperties = {
    width,
    height,
    backgroundImage: url ? `url(${url})` : undefined,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${DESKTOP_PET_SOURCE_WIDTH * SHEET_COLS * PREVIEW_SCALE}px ${DESKTOP_PET_SOURCE_HEIGHT * SHEET_ROWS * PREVIEW_SCALE}px`,
    backgroundPosition: '0 0',
  };

  return (
    <span
      aria-hidden
      className={className ?? 'shrink-0 overflow-hidden rounded-sm bg-muted/40'}
      style={style}
    />
  );
}
