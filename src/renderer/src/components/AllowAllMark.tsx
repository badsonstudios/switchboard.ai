// The quiet mark a session wears while "Allow all (this session)" is on (#1434).
//
// WHY: with allow-all granted, main answers every gated call Allow with no
// hold, no event and no sound, until the session restarts. Dan's "ask" sessions
// that never asked were exactly that, and nothing outside the card's own menu
// said so. The mode chip under the prompt box now says it in words; this is the
// smaller cue on the three places a session is listed WITHOUT being open — its
// tab, its row in the sessions list and its pill on the strip — so a session
// that will never ask is recognisable from across the workspace.
//
// QUIET ON PURPOSE. It is a fact about the session, not a demand: no fill, no
// pulse, the muted ink the pin mark uses. The glyph is `aria-hidden`, like the
// pin: the row and the pill fold the fact into their own accessible names
// (`sessionSpokenName`). The TAB has no such name of its own to fold it into —
// dockview's `role="tab"` takes its name from its content — so there the mark
// also carries the words, visually hidden (`announce`).
import React from 'react';
import { useTranslation } from 'react-i18next';
import { sessionStore } from '../store/session-store';
import { srOnly } from './sr-only';

const subscribe = (cb: () => void): (() => void) => sessionStore.subscribe(cb);

/** Is any live session of this card on allow-all? A store read, so every
 *  surface answers from main's pushed truth (`setAllowAllFromMain`). */
export function useCardAllowAll(cardId: string | undefined): boolean {
  return React.useSyncExternalStore(subscribe, () => sessionStore.isCardAllowAll(cardId));
}

export function AllowAllMark(props: {
  cardId: string | undefined;
  /** also say it to a screen reader, for a host whose name comes from its content */
  announce?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const on = useCardAllowAll(props.cardId);
  if (!on) return null;
  return (
    <>
      <span
        aria-hidden
        data-allow-all-mark={props.cardId}
        title={t('autonomy.allowAll.markHint')}
        style={{
          fontSize: 9,
          lineHeight: 1,
          flexShrink: 0,
          fontWeight: 700,
          // the pin mark's ink, which is measured on every surface this sits on;
          // the warning ink is the chip's, where the state is spelled out
          color: 'var(--muted)',
        }}
      >
        {t('autonomy.allowAll.mark')}
      </span>
      {props.announce && <span style={srOnly}>{t('autonomy.allowAll.spokenSuffix')}</span>}
    </>
  );
}
