import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { DESKTOP_PETS, getDesktopPet, loadPetSpritesheet } from '@/pets';
import {
  DESKTOP_PET_SOURCE_HEIGHT,
  DESKTOP_PET_SOURCE_WIDTH,
} from '../../shared/desktop-pet-layout';
import './PetRunningLoader.css';

const CELL_WIDTH = DESKTOP_PET_SOURCE_WIDTH;
const CELL_HEIGHT = DESKTOP_PET_SOURCE_HEIGHT;
const SHEET_COLS = 8;
const SHEET_ROWS = 11;
const RUN_ROW = 1;
const RUN_FRAMES = 8;
const DEFAULT_SCALE = 0.42;
/** Floor of desktop-pet drag playback — snappy run cycle. */
const FRAME_MS = 60;
/** Half-width of the runway the pet paces across (px). */
const RUN_RANGE_PX = 72;
/** Horizontal speed in px/sec across the runway. */
const RUN_SPEED_PX = 110;
/** Swap to another random pet after a few run laps. */
const PET_SWAP_MS = 2_400;

function pickRandomPetId(exclude?: string): string {
  const pool = DESKTOP_PETS.filter((pet) => pet.id !== exclude);
  const choices = pool.length > 0 ? pool : DESKTOP_PETS;
  return choices[Math.floor(Math.random() * choices.length)]!.id;
}

/**
 * Compact running spritesheet loop for dashboard refresh loading.
 * Randomly cycles through Hawking / Yoyo / Click while visible.
 * Position + frames are written directly to the DOM each rAF so the run
 * stays smooth (no React re-render per frame).
 */
export function PetRunningLoader({
  scale = DEFAULT_SCALE,
}: {
  scale?: number;
}) {
  const [petId, setPetId] = useState(() => pickRandomPetId());
  const [spritesheets, setSpritesheets] = useState<Record<string, string>>({});
  const spriteRef = useRef<HTMLDivElement>(null);

  // Load every atlas up front (the loader swaps pets randomly) so swaps
  // never flash empty once ready.
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      DESKTOP_PETS.map((pet) =>
        loadPetSpritesheet(pet.id).then((url) => ({ id: pet.id, url })),
      ),
    ).then((entries) => {
      if (cancelled) return;
      setSpritesheets(
        Object.fromEntries(entries.map((entry) => [entry.id, entry.url])),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPetId((current) => pickRandomPetId(current));
    }, PET_SWAP_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const el = spriteRef.current;
    if (!el) return;

    const width = Math.round(CELL_WIDTH * scale);
    const height = Math.round(CELL_HEIGHT * scale);
    const sheetW = CELL_WIDTH * SHEET_COLS * scale;
    const sheetH = CELL_HEIGHT * SHEET_ROWS * scale;
    const pet = getDesktopPet(petId);
    const sheet = spritesheets[pet.id];
    if (!sheet) return;

    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.backgroundImage = `url(${sheet})`;
    el.style.backgroundSize = `${sheetW}px ${sheetH}px`;
    el.style.backgroundRepeat = 'no-repeat';

    let raf = 0;
    let previous: number | null = null;
    let frameClock = 0;
    let frame = 0;
    let x = -RUN_RANGE_PX;
    let dir = 1;

    const paint = () => {
      const facingRight = dir > 0;
      el.style.backgroundPosition = `${-(frame % RUN_FRAMES) * width}px ${-RUN_ROW * height}px`;
      el.style.transform = `translateX(${x}px) scaleX(${facingRight ? 1 : -1})`;
    };

    paint();

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (previous == null) {
        previous = now;
        return;
      }
      const dt = Math.min(0.05, (now - previous) / 1000);
      previous = now;

      x += dir * RUN_SPEED_PX * dt;
      if (x >= RUN_RANGE_PX) {
        x = RUN_RANGE_PX;
        dir = -1;
      } else if (x <= -RUN_RANGE_PX) {
        x = -RUN_RANGE_PX;
        dir = 1;
      }

      frameClock += dt * 1000;
      if (frameClock >= FRAME_MS) {
        const steps = Math.floor(frameClock / FRAME_MS);
        frameClock -= steps * FRAME_MS;
        frame += steps;
      }

      paint();
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [petId, scale, spritesheets]);

  const pet = getDesktopPet(petId);
  const width = Math.round(CELL_WIDTH * scale);
  const height = Math.round(CELL_HEIGHT * scale);
  const trackWidth = width + RUN_RANGE_PX * 2;

  return (
    <div
      aria-hidden="true"
      className="pet-running-loader"
      style={
        {
          width: trackWidth,
          height,
          '--pet-glow-primary': pet.glow.primary,
          '--pet-glow-accent': pet.glow.accent,
        } as CSSProperties
      }
    >
      <div className="pet-running-loader__sprite" ref={spriteRef} />
    </div>
  );
}
