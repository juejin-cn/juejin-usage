/** Motion geometry shared by the Electron and Tauri pets. Coordinates are logical pixels. */
export interface AutoMovePoint { x: number; y: number }
export interface AutoMoveSegment { from: AutoMovePoint; control1: AutoMovePoint; control2: AutoMovePoint; to: AutoMovePoint }
export const AUTO_MOVE_TICK_MS = 16;
export const AUTO_MOVE_MIN_DURATION_MS = 1600;
export const AUTO_MOVE_MAX_DURATION_MS = 5200;
export function petFrameInterval(animation: string, interval: number): number {
  return animation === 'idle' ? interval : Math.max(60, Math.round(interval * 0.55));
}
export function randomBetween(min: number, max: number): number {
  return min + Math.random() * Math.max(0, max - min);
}

export function cubicPoint(segment: AutoMoveSegment, progress: number): AutoMovePoint {
  const t = progress;
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * segment.from.x
      + 3 * inverse ** 2 * t * segment.control1.x
      + 3 * inverse * t ** 2 * segment.control2.x
      + t ** 3 * segment.to.x,
    y: inverse ** 3 * segment.from.y
      + 3 * inverse ** 2 * t * segment.control1.y
      + 3 * inverse * t ** 2 * segment.control2.y
      + t ** 3 * segment.to.y,
  };
}

export function createAutoMoveSegments(
  from: AutoMovePoint,
  to: AutoMovePoint,
): [AutoMoveSegment, AutoMoveSegment] {
  const midpoint = {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
  };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const perpendicular = { x: -dy / distance, y: dx / distance };
  const bend = randomBetween(-Math.min(180, distance * 0.35), Math.min(180, distance * 0.35));
  const bentMidpoint = {
    x: midpoint.x + perpendicular.x * bend,
    y: midpoint.y + perpendicular.y * bend,
  };
  const firstControl = {
    x: from.x + dx * 0.22 + perpendicular.x * bend * 0.35,
    y: from.y + dy * 0.22 + perpendicular.y * bend * 0.35,
  };
  const secondControl = {
    x: bentMidpoint.x - dx * 0.16 + perpendicular.x * bend * 0.12,
    y: bentMidpoint.y - dy * 0.16 + perpendicular.y * bend * 0.12,
  };
  const thirdControl = {
    x: bentMidpoint.x + dx * 0.16 + perpendicular.x * bend * 0.12,
    y: bentMidpoint.y + dy * 0.16 + perpendicular.y * bend * 0.12,
  };
  const fourthControl = {
    x: to.x - dx * 0.22 + perpendicular.x * bend * 0.35,
    y: to.y - dy * 0.22 + perpendicular.y * bend * 0.35,
  };
  return [
    { from, control1: firstControl, control2: secondControl, to: bentMidpoint },
    { from: bentMidpoint, control1: thirdControl, control2: fourthControl, to },
  ];
}

export function chooseAutoMoveTarget(
  workArea: {x:number; y:number; width:number; height:number},
  size: {width:number; height:number},
  current: AutoMovePoint,
): AutoMovePoint | null {
  const {width, height} = size;
  const minX = workArea.x + 24;
  const minY = workArea.y + 24;
  const maxX = workArea.x + workArea.width - width - 24;
  const maxY = workArea.y + workArea.height - height - 24;
  if (maxX <= minX || maxY <= minY) return null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const target = {
      x: Math.round(randomBetween(minX, maxX)),
      y: Math.round(randomBetween(minY, maxY)),
    };
    if (Math.hypot(target.x - current.x, target.y - current.y) >= Math.min(180, Math.max(80, width * 0.8))) {
      return target;
    }
  }
  return {
    x: Math.round(randomBetween(minX, maxX)),
    y: Math.round(randomBetween(minY, maxY)),
  };
}

