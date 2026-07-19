// Window bounds persistence with a missing-display rescue.
// Full workspace/display-fingerprint handling arrives with P1-E2-04 (§7);
// this is the scaffold-level slice: remember bounds, restore them safely.
import { app, screen, BrowserWindow, Rectangle } from 'electron';
import fs from 'fs';
import path from 'path';

export interface WindowState {
  /** null = no usable saved bounds — let Electron center the window */
  bounds: Rectangle | null;
  isMaximized: boolean;
}

const DEFAULT_SIZE = { width: 1280, height: 800 };

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

export function loadWindowState(): WindowState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const merged = mergeState(raw);
    if (merged.bounds && !isOnAnyDisplay(merged.bounds, screen.getAllDisplays().map((d) => d.workArea))) {
      // saved display is gone: rescue to a centered window, keep maximized state
      return { bounds: null, isMaximized: merged.isMaximized };
    }
    return merged;
  } catch {
    return { bounds: null, isMaximized: false };
  }
}

/** Exported for tests: tolerant merge of possibly-corrupt persisted state. */
export function mergeState(raw: unknown): WindowState {
  if (typeof raw !== 'object' || raw === null) return { bounds: null, isMaximized: false };
  const r = raw as { bounds?: Partial<Rectangle>; isMaximized?: unknown };
  const b = r.bounds;
  const boundsOk =
    !!b &&
    [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n)) &&
    (b.width as number) >= 400 &&
    (b.height as number) >= 300;
  return {
    // pick fields explicitly (corrupt files must not smuggle extra keys back
    // to disk) and round — Electron bounds want integers
    bounds: boundsOk
      ? {
          x: Math.round(b.x as number),
          y: Math.round(b.y as number),
          width: Math.round(b.width as number),
          height: Math.round(b.height as number),
        }
      : null,
    isMaximized: r.isMaximized === true,
  };
}

/** Exported for tests: is at least a usable corner of the window visible? */
export function isOnAnyDisplay(bounds: Rectangle, workAreas: Rectangle[]): boolean {
  return workAreas.some(
    (a) =>
      bounds.x < a.x + a.width - 100 &&
      bounds.x + bounds.width > a.x + 100 &&
      bounds.y < a.y + a.height - 100 &&
      bounds.y + bounds.height > a.y + 40
  );
}

export function windowOptionsFrom(state: WindowState): { width: number; height: number; x?: number; y?: number } {
  if (!state.bounds) return { ...DEFAULT_SIZE };
  return {
    width: state.bounds.width,
    height: state.bounds.height,
    x: state.bounds.x,
    y: state.bounds.y,
  };
}

export function trackWindowState(win: BrowserWindow): void {
  // last known normal (unmaximized) bounds, tracked in memory — the state
  // file is storage, not working state
  let lastNormalBounds: Rectangle = win.getNormalBounds();
  let saveTimer: NodeJS.Timeout | null = null;

  const save = () => {
    if (win.isDestroyed()) return;
    const state: WindowState = {
      bounds: win.isMaximized() ? lastNormalBounds : win.getNormalBounds(),
      isMaximized: win.isMaximized(),
    };
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify(state));
    } catch {
      // persistence is best-effort; never let it break the app (fail-open)
    }
  };
  const debounced = () => {
    if (!win.isMaximized()) lastNormalBounds = win.getNormalBounds();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('maximize', debounced);
  win.on('unmaximize', debounced);
  win.on('close', save);
}
