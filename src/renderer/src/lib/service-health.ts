// What the service-health record LOOKS like (P2-E14-07, §5.14).
//
// Pure, and separate from the components, because two surfaces render the same
// record — the status-bar dot and the banner — and "what does degraded look
// like" must have one answer. The functions here return i18n KEYS, never
// sentences: §5.21's rule is that a word on screen comes out of the catalogue.
import { ServiceHealthStatus } from '../../../shared/service-health';

export interface HealthTone {
  /**
   * Filled for a state we know, hollow for one we do not. A SHAPE, so the dot
   * is not colour-only — §5.32, and the same reason the urgency lamps carry
   * more than a hue.
   */
  glyph: '●' | '○';
  /** a token name, never a literal colour (the renderer's lint rule and #206) */
  colorVar: string;
  /** the i18n key for the state's own sentence */
  labelKey: string;
  /**
   * The word the bar shows NEXT to the dot, or null when the bar stays quiet.
   *
   * Only trouble gets words. An "all systems operational" label in the corner
   * of every screen forever is the status bar spending pixels to say nothing —
   * §5.14 asks for a dot, and the litmus test asks what earns its place.
   */
  shortKey: string | null;
}

export function healthTone(status: ServiceHealthStatus): HealthTone {
  switch (status.state) {
    case 'operational':
      return {
        glyph: '●',
        colorVar: 'var(--status-done-ink)',
        labelKey: 'health.state.operational',
        shortKey: null,
      };
    case 'degraded':
      return {
        glyph: '●',
        colorVar: 'var(--status-needs-input-ink)',
        labelKey: 'health.state.degraded',
        shortKey: 'health.short.degraded',
      };
    case 'outage':
      return {
        glyph: '●',
        colorVar: 'var(--status-crashed-ink)',
        labelKey: 'health.state.outage',
        shortKey: 'health.short.outage',
      };
    default:
      return {
        glyph: '○',
        colorVar: 'var(--status-idle-ink)',
        labelKey: 'health.state.unknown',
        // Unknown says nothing out loud on purpose: not knowing is the normal
        // state of a machine that is offline, or has polling off, or asked once
        // and got nothing. It is not news, and it is certainly not an error.
        shortKey: null,
      };
  }
}

export interface TooltipLine {
  key: string;
  params?: Record<string, string | number>;
}

/**
 * The tooltip, as translatable lines.
 *
 * Ordered as a person reads it: what the state is, why (when the why is "we
 * could not find out"), what is actually broken, what the machine itself has
 * noticed, and when we last looked.
 */
export function healthTooltip(status: ServiceHealthStatus): TooltipLine[] {
  const tone = healthTone(status);
  // Our verdict leads, always. The page's own summary follows when it gave one
  // — it is more specific than we can be, but it is also untranslated marketing
  // copy, and a tooltip must not consist only of words we did not choose.
  const lines: TooltipLine[] = [{ key: tone.labelKey }];
  if (status.description) lines.push({ key: 'health.page', params: { page: status.description } });
  if (status.reason !== 'ok' && status.reason !== 'never-checked') {
    lines.push({ key: `health.reason.${status.reason}` });
  }
  for (const i of status.incidents) {
    lines.push({ key: 'health.incident', params: { name: i.name, status: i.status } });
  }
  if (status.corroboration) {
    lines.push({
      key: 'health.corroborated',
      params: { count: status.corroboration.sessions },
    });
  }
  if (status.checkedAt) {
    const t = new Date(status.checkedAt);
    if (!Number.isNaN(t.getTime())) {
      lines.push({
        key: 'health.checkedAt',
        // The user's own clock formatting — a bare ISO string in a tooltip is
        // a timestamp for a log reader, not for a person.
        params: { time: t.toLocaleTimeString() },
      });
    }
  }
  return lines;
}
