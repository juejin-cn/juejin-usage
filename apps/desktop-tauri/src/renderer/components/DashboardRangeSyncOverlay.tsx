import { useEffect, useState } from 'react';
import { PetRunningLoader } from '@/components/PetRunningLoader';

const LOADING_LINES = [
  '小伙伴跑腿去了…',
  '数据在前面，冲！',
  '再跑两步就好…',
  '正在追 Token…',
  '加载加速中，呼呼～',
  '马上就回来～',
  '别急，它跑得很快',
  '捡数据路上…',
];

const LINE_SWAP_MS = 1_800;

function pickLine(exclude?: string): string {
  const pool = LOADING_LINES.filter((line) => line !== exclude);
  const choices = pool.length > 0 ? pool : LOADING_LINES;
  return choices[Math.floor(Math.random() * choices.length)]!;
}

/** Centered pet-running overlay while range-driven dashboard refresh runs. */
export function DashboardRangeSyncOverlay({
  visible,
}: {
  visible: boolean;
}) {
  const [line, setLine] = useState(() => pickLine());

  useEffect(() => {
    if (!visible) return;
    setLine(pickLine());
    const timer = window.setInterval(() => {
      setLine((current) => pickLine(current));
    }, LINE_SWAP_MS);
    return () => window.clearInterval(timer);
  }, [visible]);

  if (!visible) return null;

  // Transparent on purpose: bg-background/40 tints white --surface cards with
  // page gray. Electron can keep that mix after unmount; CLI restores fine.
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="absolute inset-0 z-10 bg-transparent"
      role="status"
    >
      {/* Pet is locked to the true window center; caption sits under it. */}
      <div className="pointer-events-none fixed inset-0 z-10 flex items-center justify-center">
        <div className="relative flex items-center justify-center">
          <PetRunningLoader />
          <p
            className="absolute top-full mt-3 min-h-5 w-max text-center text-sm text-muted transition-opacity duration-200"
            key={line}
          >
            {line}
          </p>
        </div>
      </div>
    </div>
  );
}
