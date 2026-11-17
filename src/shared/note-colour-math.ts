// The colour arithmetic behind the notes' picked colours (#1601).
//
// HERE, NOT IN THE RENDERER, for the reason `group-palette.ts` is: these are
// colours as DATA (a user's pick, the default a picker starts at, and the two
// inks a note can be written in), not theme colours, and the renderer's
// no-raw-colour rule exists to keep THEME colours in tokens.css. The defaults
// are pinned to the tokens they copy by `note-colours.test.ts`.

export type NoteKind = 'waiting' | 'session';


/** today's colours, shown in the pickers while nothing is picked. The waiting
 *  note's is the yellow `--status-needs-input` at 42% on white, worked out for
 *  the default theme; the session note's is `--note-paper`. */
export const DEFAULT_NOTE_COLOURS: Record<NoteKind, string> = {
  waiting: '#f3dfaf',
  session: '#d3ecca',
};

export type NoteColours = Partial<Record<NoteKind, string>>;

const HEX = /^#[0-9a-f]{6}$/i;

/** What was stored, keeping only well-formed colours. */
export function noteColoursOf(raw: unknown): NoteColours {
  const out: NoteColours = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['waiting', 'session'] as const) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string' && HEX.test(v)) out[k] = v.toLowerCase();
  }
  return out;
}

// ── contrast ────────────────────────────────────────────────────────────────

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexOf([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` blended toward `b` by `t` (0 = a, 1 = b), in sRGB like `color-mix` */
export function mixHex(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hexOf([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as [number, number, number]);
}

export const DARK_INK = '#141a12';
export const LIGHT_INK = '#f7f8f5';

export interface NoteInks {
  /** the words */
  ink: string;
  /** the byline and the ×: softer, still 4.5:1 */
  muted: string;
  /** the session note's folded bottom edge */
  edge: string;
}

/**
 * The inks for a picked fill: dark or light, whichever reads better, then a
 * softer one for the byline that is pulled toward the fill only as far as it
 * still clears 4.5:1. The edge is the fill a third of the way to the ink.
 */
export function inksFor(fill: string): NoteInks {
  // the softened pair first; on a fill near the middle (a mid grey) neither
  // reaches 4.5:1, and pure black or white always does (at worst 4.58:1)
  const better = (a: string, b: string): string => (contrast(a, fill) >= contrast(b, fill) ? a : b);
  const soft = better(DARK_INK, LIGHT_INK);
  const ink = contrast(soft, fill) >= 4.5 ? soft : better('#000000', '#ffffff');
  let muted = ink;
  for (let t = 0.05; t <= 0.4; t += 0.05) {
    const next = mixHex(ink, fill, t);
    if (contrast(next, fill) < 4.5) break;
    muted = next;
  }
  return { ink, muted, edge: mixHex(fill, ink, 0.33) };
}
