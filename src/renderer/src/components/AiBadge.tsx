// Which AI a session is on, and what it is doing (E40 item 10, #1293).
//
// The owner's answer (design record §1, 2026-10-15): "The AI's icon REPLACES
// the status dot on the tab; a ring around it carries the status. The same
// icon goes on cards and the header." This is that mark, the ONE component the
// tab, the rail card, the strip pill and the card header all draw, so a
// session cannot be on one AI in one place and another AI in the next.
//
// THE RING IS THE OLD MARK'S STATUS, UNCHANGED. Its colour is
// `attentionPaint(status, needsYou).token`, the same call `StatusMark` makes,
// so a row that was lit orange is still lit orange; and a busy session's ring
// still spins on the surfaces whose mark spun (`.status-ring`, which the six
// working looks of #718 restyle: bigger in look 3, swapped for `.status-bars`
// in look 6). The tab and the header never had a moving mark, so they get the
// same ring standing still (`spin={false}`): no new animation (§4, calm).
//
// THE RING IS IN THE STATUS INK, not the raw hue. The raw `--status-*` hues are
// one set of values for every theme and measure about 2:1 on the light
// surfaces; a ring that carries meaning owes 1.4.11's 3:1, and the per-theme
// inks are what clear it — `tokens.drift.test.ts` measures every ink against
// every surface the badge sits on, in all four themes.
//
// NEVER COLOUR-ONLY: every surface that draws this also writes the state in a
// word beside it (the rail's and the strip's short word, the header's pill),
// and the badge's own name says both facts: "<AI>, <status>".
import React from 'react';
import { useTranslation } from 'react-i18next';
import { AiIcon } from './AiIcon';
import { aiLook, getAisState, subscribeAis } from '../lib/ais-store';
import { attentionPaint, presentStatus } from '../lib/rail-view';
import { tint } from '../lib/tint';

/** the badge's box — the old glyph tile's size, so nothing around it moves */
export const AI_BADGE_SIZE = 16;
/**
 * The icon inside the ring, with a CLEAR GAP between the two (#1326). The icon
 * is drawn in its AI's colour now, and every AI colour sits near some ramp
 * position — Claude's coral and the needs-permission orange, Codex's green and
 * done, Gemini's blue and working — so an icon touching its ring could read as
 * one blob of one colour. They are kept apart by space, not by bending the AI
 * hues away from the ramp: 10px inside a ring whose inside is 12.8px leaves
 * 1.4px of the surface showing between them (was 12px, which touched).
 * AiBadge.test.tsx measures it.
 */
const ICON_SIZE = 10;

export function AiBadge(props: {
  /** the provider the session is on; absent = not known yet (neutral glyph) */
  providerId?: string;
  status: string | undefined;
  /** is this session one of the N being counted (#1137) — it decides the hue */
  needsYou: boolean;
  /** spin while busy, as the rail's and the strip's mark always did. Default on. */
  spin?: boolean;
  /**
   * Pure decoration: no image role, no name, no tooltip. For the TAB. Dockview's
   * `role="tab"` takes its name from its content, so a named image in it would
   * make every tab's name start "Claude Code, working …" and change with every
   * status. The tab's name stays the session's, and the AI and status are said
   * by the card header's badge and the rail row's below it. And hovering a tab
   * already opens its last prompt (#631), so a native tooltip there would be a
   * second popup for one hover.
   */
  decorative?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const ais = React.useSyncExternalStore(subscribeAis, getAisState);
  const look = aiLook(ais, props.providerId, t('aiBadge.unknownAi'));
  const p = presentStatus(props.status);
  const paint = attentionPaint(props.status, props.needsYou);
  const ink = `var(--status-${paint.token}-ink)`;
  const label = t('aiBadge.label', { ai: look.name, status: t(p.shortKey) });
  const spinning = p.spinner && props.spin !== false;
  return (
    // ONE box for the badge and look 6's bars, side by side: the rail row
    // stacks its marks in a column, and two loose siblings there would put the
    // bars UNDER the icon and make a working row taller in that look.
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
      <span
        {...(props.decorative
          ? { 'aria-hidden': true }
          : { role: 'img', 'aria-label': label, title: label })}
        className="ai-badge"
        data-ai-badge={props.providerId ?? ''}
        data-ai-name={look.name}
        // the ramp position the ring is painted in — what a spec asserts
        data-ring={paint.token}
        data-ring-spin={spinning ? 'true' : 'false'}
        style={{
          position: 'relative',
          inlineSize: AI_BADGE_SIZE,
          blockSize: AI_BADGE_SIZE,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {spinning ? (
          <span
            aria-hidden
            // the handle the working looks restyle (#718)
            className="status-ring"
            style={{
              position: 'absolute',
              insetBlockStart: '50%',
              insetInlineStart: '50%',
              translate: '-50% -50%',
              inlineSize: AI_BADGE_SIZE,
              blockSize: AI_BADGE_SIZE,
              boxSizing: 'border-box',
              borderRadius: '50%',
              border: `1.6px solid ${tint(ink, 22)}`,
              borderBlockStartColor: ink,
              animation: 'sb-spin 1.1s linear infinite',
            }}
          />
        ) : (
          <span
            aria-hidden
            data-ai-ring
            style={{
              position: 'absolute',
              inset: 0,
              boxSizing: 'border-box',
              borderRadius: '50%',
              border: `1.5px solid ${ink}`,
            }}
          />
        )}
        <AiIcon look={look} size={ICON_SIZE} />
      </span>
      {/* Look 6's dancing bars (#718), beside the badge and `display: none`
          unless that look is in force — exactly as `StatusMark` drew them. */}
      {spinning && (
        <span aria-hidden className="status-bars">
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );
}
