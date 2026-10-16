// Which controls this session's AI has — and the reason a missing one gives
// (E40 item 04, #1287; design record `docs/plans/e40-multi-ai-design.md` §5,
// screen 3: "controls one AI lacks grey out, with a reason").
//
// Main answers `sessions:controls` from the provider's own declaration. A
// control the AI lacks is GREYED OUT — still there, disabled, with "Not
// available with <AI>." as its tooltip — never hidden and never clickable into
// a refusal. In both directions: it is the same rule whichever AI is missing
// what, so a control only another AI has greys out on Claude with no new code.
//
// FAIL-OPEN, IN THE DIRECTION THAT CHANGES NOTHING: until main has answered,
// and whenever it cannot (an unknown session, an older preload, a refusal),
// nothing is greyed out. A session that cannot be asked must not look as if
// its AI were missing features it has — and for Claude, which has them all,
// that makes this whole module invisible.
import React from 'react';
import type { EngineControl, SessionControlsWire } from '../../../shared/engine-controls';
import { answered } from '../../../shared/ipc/refusal';

/** This live session's declared controls, or `null` while unknown. */
export function useAiControls(sessionId: string): SessionControlsWire | null {
  const [controls, setControls] = React.useState<SessionControlsWire | null>(null);
  React.useEffect(() => {
    setControls(null);
    if (!sessionId) return;
    let alive = true;
    // `?.`: a window whose preload predates the channel greys nothing out.
    void window.switchboard.sessions.controls?.(sessionId).then(
      (raw) => {
        const c = answered(raw);
        if (alive) setControls(isControlsWire(c) ? c : null);
      },
      () => {
        /* no answer: grey nothing out */
      }
    );
    return () => {
      alive = false;
    };
  }, [sessionId]);
  return controls;
}

/**
 * Why `name` cannot be used on this session, or `null` when it can (or when
 * nobody knows yet). The sentence names the AI: "Not available with Codex."
 */
export function controlUnavailable(
  controls: SessionControlsWire | null,
  name: EngineControl,
  t: (k: string, o?: Record<string, string>) => string
): string | null {
  if (!controls || controls.has.includes(name)) return null;
  return t('feedView.controlUnavailable', { ai: controls.ai });
}

function isControlsWire(v: unknown): v is SessionControlsWire {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.ai === 'string' && Array.isArray(o.has);
}
