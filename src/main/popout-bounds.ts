// Parse the `features` string dockview passes to window.open for a popped-out
// card, into Electron BrowserWindow bounds. dockview builds it as
// `top=<screenY>,left=<screenX>,width=<w>,height=<h>` (screen-absolute — see
// dockview popoutWindow.js). Electron's setWindowOpenHandler does NOT apply
// these automatically: unless we copy them into overrideBrowserWindowOptions
// the window cascades to a default spot, so a popout ignores its saved position
// and lands on the wrong monitor (the E8-04 multi-monitor bug).
export interface PopoutBounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export function parsePopoutFeatures(features: string | undefined): PopoutBounds {
  const out: PopoutBounds = {};
  if (!features) return out;
  const map = new Map<string, number>();
  for (const part of features.split(',')) {
    const [k, v] = part.split('=');
    const n = Number(v);
    if (k && Number.isFinite(n)) map.set(k.trim(), n);
  }
  // left/top are screen coordinates -> x/y; only pass finite values so a
  // missing/garbage field leaves Electron to pick a sensible default.
  const left = map.get('left');
  const top = map.get('top');
  const width = map.get('width');
  const height = map.get('height');
  if (left !== undefined) out.x = Math.round(left);
  if (top !== undefined) out.y = Math.round(top);
  if (width !== undefined && width > 0) out.width = Math.round(width);
  if (height !== undefined && height > 0) out.height = Math.round(height);
  return out;
}
