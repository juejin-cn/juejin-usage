import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_DESKTOP_PET_FRAME_INTERVAL_MS,
  DEFAULT_DESKTOP_PET_SCALE,
  loadDesktopPetPref,
  saveDesktopPetPref,
  type DesktopPetPref,
  type DesktopPetPosition,
} from './autostart';
import { defaultPreloadPath } from './DesktopWindow';
import { getDesktopPetLayout } from '../shared/desktop-pet-layout';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PET_GET_CHANNEL = 'desktop-pet:get';
const PET_SET_ENABLED_CHANNEL = 'desktop-pet:set-enabled';
const PET_SET_SELECTED_CHANNEL = 'desktop-pet:set-selected';
const PET_BEGIN_DRAG_CHANNEL = 'desktop-pet:begin-drag';
const PET_END_DRAG_CHANNEL = 'desktop-pet:end-drag';
const PET_SET_PREFERENCES_CHANNEL = 'desktop-pet:set-preferences';
const PET_SET_MOUSE_IGNORE_CHANNEL = 'desktop-pet:set-ignore-mouse-events';
const PET_ANIMATION_CHANNEL = 'desktop-pet:animation';
const PET_PREFERENCES_CHANNEL = 'desktop-pet:preferences';
const PET_MARGIN = 24;

export interface DesktopPetHostActions {
  showMainWindow: () => void;
  openSettings: () => void;
  triggerSync: () => void;
}

let hostActions: DesktopPetHostActions | null = null;
let contextMenuOpen = false;

type PetAnimation = 'idle' | 'running-left' | 'running-right';

let petWindow: BrowserWindow | null = null;
let latestPosition: DesktopPetPosition | undefined;
let moveStopTimer: ReturnType<typeof setTimeout> | null = null;
let positionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastBounds: DesktopPetPosition | null = null;
/** Cursor→window offset captured on pointer-down, plus drag animation bookkeeping. */
let dragOrigin: {
  offsetX: number;
  offsetY: number;
  lastX: number;
  animation: PetAnimation;
} | null = null;
let dragTicker: ReturnType<typeof setInterval> | null = null;
let autoMoveTimer: ReturnType<typeof setTimeout> | null = null;
let autoMoveTicker: ReturnType<typeof setInterval> | null = null;

interface AutoMovePoint { x: number; y: number }
interface AutoMoveSegment { from: AutoMovePoint; control1: AutoMovePoint; control2: AutoMovePoint; to: AutoMovePoint }
interface AutoMoveRun {
  startedAt: number;
  durationMs: number;
  scale: number;
  segments: [AutoMoveSegment, AutoMoveSegment];
}

let autoMoveRun: AutoMoveRun | null = null;

/** ~120Hz: fast enough to feel glued to the cursor, cheap enough to stay smooth. */
const DRAG_TICK_MS = 8;
/** Ignore sub-pixel jitter so the sprite does not flip direction while held still. */
const DRAG_DIRECTION_THRESHOLD = 1.5;
const AUTO_MOVE_TICK_MS = 16;
const AUTO_MOVE_EDGE_MARGIN = 24;
const AUTO_MOVE_MIN_DURATION_MS = 1600;
const AUTO_MOVE_MAX_DURATION_MS = 5200;

function isPetWindow(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed());
}

function petDimensions(scale: number) {
  const layout = getDesktopPetLayout(scale);
  return {
    width: layout.hostWidth,
    height: layout.hostHeight,
    petWidth: layout.spriteWidth,
    spriteLeft: layout.spriteLeft,
  };
}

function clampPosition(position: DesktopPetPosition, scale: number): DesktopPetPosition {
  const display = screen.getDisplayNearestPoint(position);
  const { workArea } = display;
  const { width, height } = petDimensions(scale);
  return {
    x: Math.round(Math.min(Math.max(position.x, workArea.x), workArea.x + workArea.width - width)),
    y: Math.round(Math.min(Math.max(position.y, workArea.y), workArea.y + workArea.height - height)),
  };
}

function defaultPosition(scale: number): DesktopPetPosition {
  const { workArea } = screen.getPrimaryDisplay();
  const { height, petWidth, spriteLeft } = petDimensions(scale);
  return {
    x: workArea.x + workArea.width - petWidth - spriteLeft - PET_MARGIN,
    y: workArea.y + workArea.height - height - PET_MARGIN,
  };
}

function sendAnimation(animation: PetAnimation): void {
  if (isPetWindow(petWindow)) {
    petWindow.webContents.send(PET_ANIMATION_CHANNEL, animation);
  }
}

function sendPreferences(pref: DesktopPetPref): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(PET_PREFERENCES_CHANNEL, pref);
    }
  }
}

async function setPetEnabled(enabled: boolean): Promise<boolean> {
  const current = await loadDesktopPetPref();
  const saved = await saveDesktopPetPref({
    ...current,
    enabled,
    position: latestPosition ?? current.position,
  });
  sendPreferences(saved);
  await syncDesktopPet();
  return enabled;
}

/** Same first items as the tray; last item hides the pet instead of quitting. */
function buildPetMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => hostActions?.showMainWindow(),
    },
    {
      label: '同步数据',
      click: () => hostActions?.triggerSync(),
    },
    {
      label: '设置',
      click: () => hostActions?.openSettings(),
    },
    { type: 'separator' },
    {
      label: '退出宠物',
      click: () => {
        void setPetEnabled(false);
      },
    },
  ]);
}

function popupPetContextMenu(): void {
  if (!isPetWindow(petWindow) || contextMenuOpen || dragOrigin) return;
  contextMenuOpen = true;
  stopAutoMove();
  buildPetMenu().popup({
    window: petWindow,
    callback: () => {
      contextMenuOpen = false;
      void scheduleAutoMove();
    },
  });
}

function scheduleIdle(): void {
  if (moveStopTimer) clearTimeout(moveStopTimer);
  moveStopTimer = setTimeout(() => sendAnimation('idle'), 180);
}

function schedulePositionSave(delay = 180): void {
  if (positionSaveTimer) clearTimeout(positionSaveTimer);
  positionSaveTimer = setTimeout(() => {
    positionSaveTimer = null;
    const position = latestPosition;
    if (!position) return;
    void loadDesktopPetPref()
      .then((pref) => saveDesktopPetPref({ ...pref, enabled: true, position }));
  }, delay);
}

function stopAutoMoveTicker(): void {
  if (autoMoveTicker) clearInterval(autoMoveTicker);
  autoMoveTicker = null;
}

function clearAutoMoveTimer(): void {
  if (autoMoveTimer) clearTimeout(autoMoveTimer);
  autoMoveTimer = null;
}

function stopAutoMove(): void {
  clearAutoMoveTimer();
  stopAutoMoveTicker();
  autoMoveRun = null;
  sendAnimation('idle');
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * Math.max(0, max - min);
}

function cubicPoint(segment: AutoMoveSegment, progress: number): AutoMovePoint {
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

function createAutoMoveSegments(
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

function randomAutoMoveTarget(scale: number, current: AutoMovePoint): AutoMovePoint | null {
  const display = screen.getDisplayNearestPoint(current);
  const { workArea } = display;
  const { width, height } = petDimensions(scale);
  const minX = workArea.x + AUTO_MOVE_EDGE_MARGIN;
  const minY = workArea.y + AUTO_MOVE_EDGE_MARGIN;
  const maxX = workArea.x + workArea.width - width - AUTO_MOVE_EDGE_MARGIN;
  const maxY = workArea.y + workArea.height - height - AUTO_MOVE_EDGE_MARGIN;
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

function tickAutoMove(): void {
  if (!autoMoveRun || !isPetWindow(petWindow) || dragOrigin) {
    stopAutoMove();
    return;
  }
  const elapsed = Date.now() - autoMoveRun.startedAt;
  const overallProgress = Math.min(1, elapsed / autoMoveRun.durationMs);
  const easedProgress = overallProgress < 0.5
    ? 4 * overallProgress ** 3
    : 1 - ((-2 * overallProgress + 2) ** 3) / 2;
  const segmentProgress = easedProgress < 0.5 ? easedProgress * 2 : (easedProgress - 0.5) * 2;
  const segment = autoMoveRun.segments[easedProgress < 0.5 ? 0 : 1];
  const point = clampPosition(cubicPoint(segment, segmentProgress), autoMoveRun.scale);
  petWindow.setPosition(point.x, point.y);
  const previous = lastBounds;
  lastBounds = point;
  latestPosition = lastBounds;
  if (previous && lastBounds.x !== previous.x) {
    sendAnimation(lastBounds.x < previous.x ? 'running-left' : 'running-right');
  }
  if (overallProgress >= 1) {
    stopAutoMoveTicker();
    autoMoveRun = null;
    schedulePositionSave(0);
    sendAnimation('idle');
    void scheduleAutoMove();
  }
}

function canAutoMove(window: BrowserWindow | null): window is BrowserWindow {
  return isPetWindow(window) && !dragOrigin && !autoMoveRun && !contextMenuOpen;
}

async function startAutoMove(): Promise<void> {
  autoMoveTimer = null;
  if (!canAutoMove(petWindow)) return;
  const pref = await loadDesktopPetPref();
  if (!pref.enabled || !pref.autoMoveEnabled) return;
  if (!canAutoMove(petWindow)) return;
  const [x, y] = petWindow.getPosition();
  const target = randomAutoMoveTarget(pref.scale, { x, y });
  if (!target) {
    await scheduleAutoMove();
    return;
  }
  const distance = Math.hypot(target.x - x, target.y - y);
  const durationMs = Math.min(
    AUTO_MOVE_MAX_DURATION_MS,
    Math.max(AUTO_MOVE_MIN_DURATION_MS, Math.round(distance / 0.12)),
  );
  autoMoveRun = {
    startedAt: Date.now(),
    durationMs,
    scale: pref.scale,
    segments: createAutoMoveSegments({ x, y }, target),
  };
  stopAutoMoveTicker();
  autoMoveTicker = setInterval(tickAutoMove, AUTO_MOVE_TICK_MS);
  sendAnimation(target.x < x ? 'running-left' : 'running-right');
}

async function scheduleAutoMove(delayMs?: number): Promise<void> {
  clearAutoMoveTimer();
  if (!canAutoMove(petWindow)) return;
  const pref = await loadDesktopPetPref();
  if (!pref.enabled || !pref.autoMoveEnabled) return;
  if (!canAutoMove(petWindow)) return;
  autoMoveTimer = setTimeout(() => { void startAutoMove(); }, delayMs ?? pref.autoMoveIntervalMinutes * 60_000);
}

function onPetMoved(): void {
  if (!isPetWindow(petWindow)) return;
  const [x, y] = petWindow.getPosition();
  const next = { x, y };
  if (lastBounds && !dragOrigin && !autoMoveRun) {
    if (next.x < lastBounds.x) sendAnimation('running-left');
    if (next.x > lastBounds.x) sendAnimation('running-right');
    scheduleIdle();
  }
  lastBounds = next;
  latestPosition = next;
  if (!dragOrigin && !autoMoveRun) schedulePositionSave();
}

/**
 * One drag tick. Main polls the OS cursor instead of waiting for renderer
 * pointer events, so window position never lags behind IPC round-trips and the
 * walk animation follows the real horizontal direction of travel.
 */
function tickDrag(): void {
  const drag = dragOrigin;
  if (!drag || !isPetWindow(petWindow)) {
    stopDragTicker();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const x = Math.round(cursor.x - drag.offsetX);
  const y = Math.round(cursor.y - drag.offsetY);
  const [currentX, currentY] = petWindow.getPosition();
  if (x !== currentX || y !== currentY) petWindow.setPosition(x, y);

  const horizontalDelta = cursor.x - drag.lastX;
  if (Math.abs(horizontalDelta) >= DRAG_DIRECTION_THRESHOLD) {
    drag.lastX = cursor.x;
    const next: PetAnimation = horizontalDelta < 0 ? 'running-left' : 'running-right';
    if (drag.animation !== next) {
      drag.animation = next;
      sendAnimation(next);
    }
  }
}

function startDragTicker(): void {
  if (dragTicker) return;
  dragTicker = setInterval(tickDrag, DRAG_TICK_MS);
}

function stopDragTicker(): void {
  if (dragTicker) clearInterval(dragTicker);
  dragTicker = null;
}

/**
 * Keep the native window title from becoming "Juejin Usage" / "pet.html".
 * Chromium synthesizes a title from the file URL when the document title is
 * empty (`explicitSet: false`); preventDefault stops that from hitting HWND.
 */
const PET_WINDOW_TITLE = '\u200B';

function suppressPetWindowTitle(window: BrowserWindow): void {
  window.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  window.setTitle(PET_WINDOW_TITLE);
}

async function loadPetRenderer(window: BrowserWindow): Promise<void> {
  try {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (!app.isPackaged && devUrl) {
      const url = new URL('pet.html', devUrl.endsWith('/') ? devUrl : `${devUrl}/`);
      await window.loadURL(url.toString());
      return;
    }
    await window.loadFile(path.join(__dirname, '../renderer/pet.html'));
  } catch (err) {
    // Window destroyed mid-load (pet disabled / toggled away) — swallow.
    if (window.isDestroyed()) return;
    throw err;
  }
}

async function ensurePetWindow(): Promise<BrowserWindow> {
  if (isPetWindow(petWindow)) return petWindow;
  const pref = await loadDesktopPetPref();
  const position = clampPosition(pref.position ?? latestPosition ?? defaultPosition(pref.scale), pref.scale);
  const { width, height } = petDimensions(pref.scale);
  latestPosition = position;
  lastBounds = position;
  petWindow = new BrowserWindow({
    width,
    height,
    x: position.x,
    y: position.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    title: PET_WINDOW_TITLE,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    ...(process.platform === 'win32'
      ? { roundedCorners: false, thickFrame: false }
      : {}),
    webPreferences: {
      preload: defaultPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const window = petWindow;
  // `titleBarStyle` enables macOS traffic lights even on a frameless window.
  // A floating pet must never expose native window controls over its sprite.
  if (process.platform === 'darwin') window.setWindowButtonVisibility(false);
  suppressPetWindowTitle(window);
  window.setAlwaysOnTop(true, 'floating');
  window.webContents.on('context-menu', (event) => {
    event.preventDefault();
    popupPetContextMenu();
  });
  window.on('move', onPetMoved);
  window.on('closed', () => {
    stopAutoMove();
    // Only clear the ref if it still points at this window; a newer window
    // created by a queued toggle must not be nulled out by the old one.
    if (petWindow === window) {
      petWindow = null;
      lastBounds = null;
    }
  });
  await loadPetRenderer(window);
  sendPreferences(pref);
  return window;
}

/**
 * Rapid toggles previously raced: one call was mid-loadURL while another
 * destroyed the window, killing the navigation with ERR_FAILED (-2). Serialize
 * through a promise chain so each toggle runs to completion before the next.
 */
let syncQueue: Promise<void> = Promise.resolve();

export function syncDesktopPet(): Promise<void> {
  const run = syncQueue.then(() => doSyncDesktopPet());
  // Keep the chain alive even if one run rejects so later toggles still apply.
  syncQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function doSyncDesktopPet(): Promise<void> {
  const pref = await loadDesktopPetPref();
  stopAutoMove();
  latestPosition = pref.position;
  if (!pref.enabled) {
    stopAutoMove();
    // Disabling the pet releases its renderer process entirely instead of
    // keeping a hidden window (and its Chromium process) resident.
    if (isPetWindow(petWindow)) petWindow.destroy();
    return;
  }
  const window = await ensurePetWindow();
  if (window.isDestroyed()) return;
  const { width, height } = petDimensions(pref.scale);
  const bounds = window.getBounds();
  const position = clampPosition({
    x: bounds.x - Math.max(0, Math.round((width - bounds.width) / 2)),
    y: bounds.y,
  }, pref.scale);
  window.setBounds({ x: position.x, y: position.y, width, height });
  latestPosition = position;
  sendPreferences(pref);
  window.setIgnoreMouseEvents(false);
  window.showInactive();
  await scheduleAutoMove();
}

export function registerDesktopPetIpc(actions: DesktopPetHostActions): void {
  hostActions = actions;
  ipcMain.removeHandler(PET_GET_CHANNEL);
  ipcMain.handle(PET_GET_CHANNEL, async () => loadDesktopPetPref());

  ipcMain.removeHandler(PET_SET_ENABLED_CHANNEL);
  ipcMain.handle(PET_SET_ENABLED_CHANNEL, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('desktop pet enabled must be a boolean');
    return setPetEnabled(enabled);
  });

  ipcMain.removeHandler(PET_SET_SELECTED_CHANNEL);
  ipcMain.handle(PET_SET_SELECTED_CHANNEL, async (_event, selectedPetId: unknown) => {
    if (typeof selectedPetId !== 'string' || !['hawking', 'yoyo', 'click'].includes(selectedPetId)) {
      throw new Error('unknown desktop pet');
    }
    const current = await loadDesktopPetPref();
    const saved = await saveDesktopPetPref({ ...current, selectedPetId });
    stopAutoMove();
    sendPreferences(saved);
    void scheduleAutoMove();
    return saved;
  });

  ipcMain.removeHandler(PET_SET_PREFERENCES_CHANNEL);
  ipcMain.handle(PET_SET_PREFERENCES_CHANNEL, async (_event, changes: unknown) => {
    if (!changes || typeof changes !== 'object') throw new Error('desktop pet preferences must be an object');
    const current = await loadDesktopPetPref();
    const next = changes as Partial<Pick<DesktopPetPref, 'scale' | 'frameIntervalMs' | 'autoMoveEnabled' | 'autoMoveIntervalMinutes'>>;
    const scale = typeof next.scale === 'number' && next.scale >= 0.35 && next.scale <= 0.75
      ? next.scale : current.scale ?? DEFAULT_DESKTOP_PET_SCALE;
    const frameIntervalMs = typeof next.frameIntervalMs === 'number' && next.frameIntervalMs >= 120 && next.frameIntervalMs <= 320
      ? Math.round(next.frameIntervalMs) : current.frameIntervalMs ?? DEFAULT_DESKTOP_PET_FRAME_INTERVAL_MS;
    const autoMoveEnabled = typeof next.autoMoveEnabled === 'boolean'
      ? next.autoMoveEnabled : current.autoMoveEnabled;
    const autoMoveIntervalMinutes = typeof next.autoMoveIntervalMinutes === 'number'
      && Number.isInteger(next.autoMoveIntervalMinutes)
      && next.autoMoveIntervalMinutes >= 1
      && next.autoMoveIntervalMinutes <= 120
      ? next.autoMoveIntervalMinutes : current.autoMoveIntervalMinutes;
    const saved = await saveDesktopPetPref({
      ...current,
      scale,
      frameIntervalMs,
      autoMoveEnabled,
      autoMoveIntervalMinutes,
    });
    await syncDesktopPet();
    return saved;
  });

  ipcMain.removeAllListeners(PET_SET_MOUSE_IGNORE_CHANNEL);
  ipcMain.on(PET_SET_MOUSE_IGNORE_CHANNEL, (event, ignore: unknown) => {
    if (!isPetWindow(petWindow) || event.sender !== petWindow.webContents) return;
    if (typeof ignore !== 'boolean') return;
    petWindow.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.removeAllListeners(PET_BEGIN_DRAG_CHANNEL);
  ipcMain.on(PET_BEGIN_DRAG_CHANNEL, (event) => {
    if (!isPetWindow(petWindow) || event.sender !== petWindow.webContents) return;
    stopAutoMove();
    if (moveStopTimer) clearTimeout(moveStopTimer);
    moveStopTimer = null;
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = null;
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = petWindow.getPosition();
    dragOrigin = {
      offsetX: cursor.x - x,
      offsetY: cursor.y - y,
      lastX: cursor.x,
      animation: 'idle',
    };
    startDragTicker();
  });

  ipcMain.removeAllListeners(PET_END_DRAG_CHANNEL);
  ipcMain.on(PET_END_DRAG_CHANNEL, (event) => {
    if (!isPetWindow(petWindow) || event.sender !== petWindow.webContents || !dragOrigin) return;
    stopDragTicker();
    tickDrag();
    dragOrigin = null;
    sendAnimation('idle');
    schedulePositionSave(0);
    void scheduleAutoMove();
  });
}

export function unregisterDesktopPetIpc(): void {
  stopAutoMove();
  hostActions = null;
  contextMenuOpen = false;
  ipcMain.removeHandler(PET_GET_CHANNEL);
  ipcMain.removeHandler(PET_SET_ENABLED_CHANNEL);
  ipcMain.removeHandler(PET_SET_SELECTED_CHANNEL);
  ipcMain.removeHandler(PET_SET_PREFERENCES_CHANNEL);
  ipcMain.removeAllListeners(PET_SET_MOUSE_IGNORE_CHANNEL);
  ipcMain.removeAllListeners(PET_BEGIN_DRAG_CHANNEL);
  ipcMain.removeAllListeners(PET_END_DRAG_CHANNEL);
}

export function disposeDesktopPet(): void {
  stopDragTicker();
  stopAutoMove();
  if (moveStopTimer) clearTimeout(moveStopTimer);
  moveStopTimer = null;
  if (positionSaveTimer) clearTimeout(positionSaveTimer);
  positionSaveTimer = null;
  dragOrigin = null;
  contextMenuOpen = false;
  if (isPetWindow(petWindow)) petWindow.destroy();
  petWindow = null;
}
