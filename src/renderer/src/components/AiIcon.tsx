// One AI's icon (E40 item 10, #1293) — the bare mark, no ring, no status.
//
// Its own file so every surface that names an AI draws it the same way: the
// session badge (`AiBadge`), the status bar's list of AIs, the AI switch, and
// the Settings → AIs tab (#1292, through `AiRowIcon`).
//
// IN THE AI'S OWN COLOUR (#1326), as a CSS MASK. The shipped SVGs are drawn
// `fill="currentColor"`, and they used to be shown through an `<img>` — but an
// SVG loaded as an image is its own document, cannot inherit the page's
// `color`, and so painted BLACK on every theme (black on near-black on the
// dark ones). A mask takes the file's shape and paints it with this element's
// `background-color`, which is the AI's per-theme ink (`look.ink`, from
// `ai-ink.ts`; measured on every surface by tokens.drift.test.ts). The files
// are unchanged, and a theme can repaint every AI.
//
// DECORATION, always (`aria-hidden`): whatever this sits in says the AI's name
// in words — the badge's `aria-label`, the status bar's text. Colour is a
// quicker read, never the only one.
//
// FAIL-OPEN (PHILOSOPHY §4): an AI with no icon, or an icon that does not load,
// is a neutral tile with the AI's initial. A mask whose image fails paints
// NOTHING (it does not fire `error` the way an `<img>` does), so the URL is
// checked once through an `Image()` beside it (`iconLoads`) and a failure swaps
// in the tile.
// The letter is drawn by CSS from `data-initial` (`.ai-icon[data-initial]::before`,
// tokens.css) rather than as a text node, so a tab's or a row's `textContent` —
// which e2e specs read as the session's name — never gains a stray letter.
//
// POPOUTS: `look.iconUrl` is already absolute (`ais-store.ts` `iconUrl`), and a
// `url()` in an inline style resolves against the document it is in, exactly as
// an `<img src>` did, so the popout gets the main window's file.
import React from 'react';
import type { AiLook } from '../lib/ais-store';
import { NEUTRAL_AI_INK } from '../lib/ai-ink';

/**
 * Does this icon file load, checked the way the MASK fetches it (#1326)?
 *
 * Two things make the check honest: it is made through the icon's OWN window
 * (a popout is a second document, and a relative URL resolves against the
 * document it is in, as the mask's `url()` does), and in CORS mode, because
 * Chromium fetches a mask image that way — on the app's `file://` fallback page
 * a plain request can succeed where the mask's is refused, and the icon would
 * be an empty ring with no letter.
 *
 * ONE check per file, shared by every icon that draws it, so a tab strip of
 * Claude sessions asks once. A failure is not remembered: the next icon that
 * mounts asks again, so a server that was not ready yet does not cost the
 * whole run its pictures.
 */
const checks = new Map<string, Promise<boolean>>();

function iconLoads(url: string, view: (Window & typeof globalThis) | null): Promise<boolean> {
  let key = url;
  try {
    key = new URL(url, view?.document.baseURI).href;
  } catch {
    /* an odd URL is its own key */
  }
  const known = checks.get(key);
  if (known) return known;
  const check = new Promise<boolean>((resolve) => {
    try {
      const probe = new (view?.Image ?? Image)();
      probe.crossOrigin = 'anonymous';
      probe.onload = () => resolve(true);
      probe.onerror = () => resolve(false);
      probe.src = url;
    } catch {
      // no way to check it: draw the mask, which is what an `<img>` would have tried
      resolve(true);
    }
  });
  checks.set(key, check);
  void check.then((ok) => {
    if (!ok) checks.delete(key);
  });
  return check;
}

/** Tests only: forget every check, so one test's file is not another's answer. */
export function resetAiIconChecksForTests(): void {
  checks.clear();
}

export function AiIcon(props: { look: AiLook; size: number }): React.JSX.Element {
  const { look, size } = props;
  // which URL failed, not a bare flag: a list that later names a NEW icon for
  // this AI gets a fresh try
  const [failed, setFailed] = React.useState<string | null>(null);
  const url = look.iconUrl;
  const showMask = url !== undefined && failed !== url;
  const el = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    if (url === undefined || failed === url) return;
    let live = true;
    const view = el.current?.ownerDocument.defaultView ?? null;
    void iconLoads(url, view).then((ok) => {
      if (live && !ok) setFailed(url);
    });
    return () => {
      live = false;
    };
  }, [url, failed]);

  if (showMask) {
    // JSON's quoting is a valid CSS string for any URL this is handed
    const image = `url(${JSON.stringify(url)})`;
    return (
      <span
        ref={el}
        aria-hidden
        className="ai-icon"
        data-ai-icon="mask"
        data-ai-icon-src={url}
        style={{
          inlineSize: size,
          blockSize: size,
          flexShrink: 0,
          display: 'block',
          backgroundColor: look.ink ?? NEUTRAL_AI_INK,
          maskImage: image,
          maskSize: 'contain',
          maskRepeat: 'no-repeat',
          maskPosition: 'center',
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="ai-icon"
      data-ai-icon="initial"
      data-initial={look.initial}
      style={{
        inlineSize: size,
        blockSize: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 3,
        background: 'var(--chip)',
        color: 'var(--text)',
        fontFamily: 'var(--font-ui)',
        fontWeight: 700,
        fontSize: Math.max(8, Math.round(size * 0.7)),
        lineHeight: 1,
      }}
    />
  );
}
