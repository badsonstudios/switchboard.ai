// Yellow and gold mean "a session needs you", and nothing else (#1165).
//
// The owner, 2026-10-08: "None of our colors should use yellow or a yellowish
// color. We just use yellowish for a warning that you're needed for something.
// That's the only time you see a yellow color. Everything stays within blues,
// greens, reds, etc., … yellow, gold, etc., are only used when you're needed,
// when that session needs you."
//
// ── WHAT COUNTS AS YELLOWISH, WRITTEN DOWN ───────────────────────────────────
//
// A colour is RESERVED when its hue is between 20° and 70° and it is saturated
// enough to read as a colour at all (25% or more). That band is orange (25°,
// the "needs permission" status), amber (42°, "needs input"), gold (~50°),
// yellow (60°) and the olive-yellows up to 70°. Orange is inside it on
// purpose: "wants permission" IS a session needing you, and its colour is as
// much a part of that signal as the yellow is.
//
// Below 20° is red and coral; above 70° is yellow-green and green. Neither is
// reserved. A colour near an edge is a judgement the next person can make
// against this number instead of against a memory of the rule.
//
// The audit that produced the band (2026-10-09) found, outside the four
// "needs you" status tokens: two session colours (amber and orange, the first
// of which was the SAME hex as "needs input"), two group colours, and about
// forty places that used the "needs input" ink as a general warning colour.
// `theme/reserved-hue.test.ts` is the guard that keeps them out.
//
// In `shared/` because both sides need it: main remaps saved colours on load,
// and the renderer's tests check the palettes and the stylesheet against it.

export const RESERVED_HUE_FROM = 20;
export const RESERVED_HUE_TO = 70;
export const RESERVED_MIN_SATURATION = 0.25;

/** `#rrggbb` → hue in degrees and saturation 0..1 (HSL), or null if it is not one */
export function hueOf(hex: string): { hue: number; saturation: number } | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { hue: 0, saturation: 0 };
  const l = (max + min) / 2;
  const saturation = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  let hue = h * 60;
  if (hue < 0) hue += 360;
  return { hue, saturation };
}

/** Is this colour in the family reserved for "a session needs you"? */
export function isReservedColor(hex: string): boolean {
  const c = hueOf(hex);
  if (!c) return false;
  return (
    c.saturation >= RESERVED_MIN_SATURATION &&
    c.hue >= RESERVED_HUE_FROM &&
    c.hue <= RESERVED_HUE_TO
  );
}

/** how far apart two hues are, the short way round the wheel */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * A saved colour, moved out of the reserved family if it was in it.
 *
 * Sessions and groups are saved WITH their colour, so a workspace from before
 * the rule carries yellows that no palette offers any more. They are remapped
 * when the file is read (decided in #1165: "none is drawn in one after an
 * update" is the acceptance, and leaving stored values alone would not meet
 * it).
 *
 * `successors` is the one-to-one map for the colours that used to be in the
 * palette: each retired colour has ONE named replacement, so two sessions that
 * were amber and orange are still two different colours afterwards. Anything
 * else in the band (a hand-edited file, a colour from some older build) goes
 * to the allowed colour nearest in hue. A colour that is not reserved comes
 * back untouched, as the same string.
 */
export function outOfReserved(
  hex: string,
  allowed: readonly string[],
  successors: Readonly<Record<string, string>> = {}
): string {
  if (!isReservedColor(hex)) return hex;
  const known = successors[hex.trim().toLowerCase()];
  if (known) return known;
  const from = hueOf(hex)!.hue;
  let best = allowed[0] ?? hex;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const c = hueOf(candidate);
    if (!c || isReservedColor(candidate)) continue;
    const d = hueDistance(from, c.hue);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}
