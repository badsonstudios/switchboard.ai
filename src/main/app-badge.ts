// The "N need you" count on switchboard's own icon (#1605): the Windows
// taskbar overlay first (Dan, 2026-11-17), the macOS Dock badge, and the Linux
// launcher where Electron can set one.
//
// THE RENDERER COUNTS, THIS ONLY DRAWS. The number is the window's own
// "N need you" total (`needCount`), sent here whenever it changes, so the icon
// and the window can never disagree. A setting in the window turns it off, and
// "off" arrives here as a count of 0, which clears the badge.
//
// The overlay picture is drawn by the renderer too (it has a canvas and the
// theme's colours) and arrives as a PNG data URL. Renderer input is untrusted
// (§5.29): the count must be a small whole number, the picture a PNG data URL
// of a sane size, and the words a short string; anything else is refused.
//
// FAIL-OPEN: no window, a platform without a badge, or Electron throwing all
// leave things as they were and log once.

export interface BadgeRequest {
  count: number;
  /** a PNG data URL: the overlay picture, Windows only */
  png?: string;
  /** what a screen reader says for the overlay, Windows only */
  label?: string;
}

const PNG_PREFIX = 'data:image/png;base64,';
/** a 32x32 PNG is a few hundred bytes; this is generous and still bounded */
const MAX_PNG_CHARS = 64 * 1024;

/** The request, cleaned, or a reason it was refused. */
export function parseBadgeRequest(raw: unknown): { ok: true; req: BadgeRequest } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
  const r = raw as Record<string, unknown>;
  const count = r.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 9999)
    return { ok: false, reason: 'count must be a whole number 0-9999' };
  const req: BadgeRequest = { count };
  if (r.png !== undefined) {
    if (typeof r.png !== 'string' || !r.png.startsWith(PNG_PREFIX) || r.png.length > MAX_PNG_CHARS)
      return { ok: false, reason: 'png must be a PNG data URL under 64 KB' };
    req.png = r.png;
  }
  if (r.label !== undefined) {
    if (typeof r.label !== 'string' || r.label.length > 200) return { ok: false, reason: 'label must be a short string' };
    req.label = r.label;
  }
  return { ok: true, req };
}

/** What the platform needs, injected so the decisions are testable. */
export interface BadgeHost {
  platform: NodeJS.Platform;
  /** the main window, or null when there is none */
  window(): { setOverlayIcon(img: unknown, description: string): void; isDestroyed(): boolean } | null;
  /** `nativeImage.createFromDataURL` */
  image(dataUrl: string): { isEmpty(): boolean };
  /** `app.setBadgeCount` (macOS Dock, Linux Unity launchers) */
  setBadgeCount(n: number): boolean;
}

/** Show the count (or clear it at 0). Answers what it did, for the log. */
export function applyBadge(host: BadgeHost, req: BadgeRequest): 'overlay' | 'cleared' | 'badge' | 'no-window' | 'no-picture' {
  if (host.platform === 'win32') {
    const win = host.window();
    if (!win || win.isDestroyed()) return 'no-window';
    if (req.count === 0) {
      win.setOverlayIcon(null, '');
      return 'cleared';
    }
    if (!req.png) return 'no-picture';
    const img = host.image(req.png);
    if (img.isEmpty()) return 'no-picture';
    win.setOverlayIcon(img, req.label ?? String(req.count));
    return 'overlay';
  }
  host.setBadgeCount(req.count);
  return req.count === 0 ? 'cleared' : 'badge';
}
