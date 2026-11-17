// The "N need you" count on the app icon (#1605): the setting, the picture,
// and the one effect that keeps the icon in step with the window.
//
// The number is the window's own "N need you" total, the same `needCount` the
// sessions list's footer and the strip show, so the icon cannot disagree with
// the window. On by default (Dan approved the ticket as written); Settings ▸
// Attention turns it off, which clears the badge. No sound, no animation, and
// nothing at 0.
//
// THE PICTURE IS DRAWN HERE because this side has a canvas and the theme: the
// attention yellow (`--status-needs-input`, the same in every theme) with the
// near-black `--note-ink` on it. Windows shows it as the taskbar button's
// overlay; macOS and Linux draw their own badge from the count alone.
import * as React from 'react';
import { uiGet, uiSet } from './ui-state';

/** the ui-blob key */
export const APP_BADGE_KEY = 'appBadge';

/** Stored values other than `false` read as ON. */
export function appBadgeOf(raw: unknown): boolean {
  return raw !== false;
}

/** What the badge says: up to 9, then "9+" (the overlay is 16 px across). */
export function badgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

let current = true;
const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Read the stored choice, once the ui blob has loaded (App calls this). */
export function initAppBadge(): void {
  current = appBadgeOf(uiGet<unknown>(APP_BADGE_KEY, undefined));
  emit();
}

/** Settings: on or off, at once. */
export function setAppBadge(on: boolean): void {
  current = on;
  uiSet(APP_BADGE_KEY, on);
  emit();
}

export function useAppBadge(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => current,
    () => true
  );
}

/** Tests only. */
export function resetAppBadgeForTests(on = true): void {
  current = on;
  emit();
}

/** The overlay picture as a PNG data URL, or undefined where there is no canvas. */
export function drawBadge(count: number, doc: Document = document): string | undefined {
  try {
    const size = 32;
    const canvas = doc.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const css = getComputedStyle(doc.documentElement);
    const fill = css.getPropertyValue('--status-needs-input').trim();
    const ink = css.getPropertyValue('--note-ink').trim();
    if (!fill || !ink) return undefined;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
    const text = badgeText(count);
    ctx.fillStyle = ink;
    ctx.font = `bold ${text.length > 1 ? 17 : 22}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2 + 1);
    return canvas.toDataURL('image/png');
  } catch {
    return undefined; // fail-open: no picture, no badge
  }
}

type BadgeBridge = (req: { count: number; png?: string; label?: string }) => Promise<boolean>;

/**
 * Keep the icon's count in step: sends whenever the count, the setting or the
 * words change, and clears it when the window goes away.
 */
export function useAttentionBadge(count: number, label: (n: number) => string): void {
  const on = useAppBadge();
  const shown = on ? count : 0;
  const words = shown > 0 ? label(shown) : '';
  React.useEffect(() => {
    const send = (window as unknown as { switchboard?: { setAttentionBadge?: BadgeBridge } }).switchboard
      ?.setAttentionBadge;
    if (!send) return;
    void send(shown > 0 ? { count: shown, png: drawBadge(shown), label: words } : { count: 0 }).catch(() => undefined);
  }, [shown, words]);
}
