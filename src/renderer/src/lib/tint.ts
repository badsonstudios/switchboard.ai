/** Tint helper: the group and accent colors are runtime DATA (user-picked from
 *  the stored palette), so they can't be tokens — color-mix keeps the alpha
 *  compositing in CSS instead of hand-rolling rgba in TS (§5.20). */
export const tint = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;
