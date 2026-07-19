// Pure window-geometry helpers. Persistence lives in the workspace store
// (P1-E2-04, workspace/store.ts) — these stay side-effect-free and testable.
import { Rectangle } from 'electron';

export interface WindowState {
  /** null = no usable saved bounds — let Electron center the window */
  bounds: Rectangle | null;
  isMaximized: boolean;
}

const DEFAULT_SIZE = { width: 1280, height: 800 };

/** Tolerant merge of possibly-corrupt persisted window state. */
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

/** Is at least a usable corner of the window visible on some display? */
export function isOnAnyDisplay(bounds: Rectangle, workAreas: Rectangle[]): boolean {
  return workAreas.some(
    (a) =>
      bounds.x < a.x + a.width - 100 &&
      bounds.x + bounds.width > a.x + 100 &&
      bounds.y < a.y + a.height - 100 &&
      bounds.y + bounds.height > a.y + 40
  );
}

export function windowOptionsFrom(state: WindowState): {
  width: number;
  height: number;
  x?: number;
  y?: number;
} {
  if (!state.bounds) return { ...DEFAULT_SIZE };
  return {
    width: state.bounds.width,
    height: state.bounds.height,
    x: state.bounds.x,
    y: state.bounds.y,
  };
}
