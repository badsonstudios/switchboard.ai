// "Where did my card go?" answered at the moment it goes (#1210).
//
// §5.8's auto-minimize on submit is opt-in, and the title bar chip says which
// setting is in force. That turned out not to be enough: the owner's global
// setting had been on Hide on submit for hours without his knowing, he pasted
// a prompt, pressed Enter, and the card he was typing in left the screen. The
// log named the rule; nothing on screen did.
//
// So when the policy puts a card away, ONE LINE above the cards says which
// session, which setting, and at which level (this session, its group, or
// everything), and carries the two things he wanted in that moment: the card
// back, and this stopped.
//
// Deliberate choices:
//
// - **A strip, not a toast.** It holds two actions, and an action that fades
//   on a timer is one a slower reader never gets to press. It leaves by
//   itself when the card is back on screen. It does NOT promise that: with
//   "never jump" chosen for when a session needs you, a finished session
//   stays away, so the sentence says only what is always true.
// - **In the flow, not over the cards.** An overlay at the foot of the grid
//   would sit on a prompt box. This is the grid's own "takes a line only while
//   there is something to say" slot, the one `grid-error` uses.
// - **"Stop telling me" lasts until the app restarts**, and is not saved. A
//   saved switch with no control to turn it back on is a one-way door; the
//   person who chose this setting on purpose pays one click per launch.
// - **The live region is always mounted**, empty until there is something to
//   say, and the buttons sit outside it: a status that arrives with its text is
//   announced by almost nothing, and one that contains buttons reads them out.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { hasPanel } from '../lib/ladder';
import { sessionStore } from '../store/session-store';

/** a card the submit policy just put away, and the rung it went to */
export interface SubmitNotice {
  cardId: string;
  rung: 'collapsed' | 'hidden';
}

let muted = false;

/** "Stop telling me" was pressed during this run. */
export function submitNoticeMuted(): boolean {
  return muted;
}

/** Tests only: a module flag outlives the test that set it. */
export function resetSubmitNoticeMuteForTests(): void {
  muted = false;
}

const subscribeStore = (cb: () => void): (() => void) => sessionStore.subscribe(cb);

export function SubmitPolicyNotice(props: {
  notice: SubmitNotice | null;
  /** put the card back where it was */
  onRestore: (cardId: string) => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { notice, onDismiss, onRestore } = props;
  const cardId = notice?.cardId;
  const title = React.useSyncExternalStore(subscribeStore, () =>
    sessionStore.getCardTitle(cardId)
  );
  const ladder = React.useSyncExternalStore(subscribeStore, () =>
    cardId ? sessionStore.getPresentation(cardId).ladder : null
  );
  // LEVEL IS READ ONCE PER NOTICE, when the card went: the sentence explains
  // why that move happened, and must not rewrite itself if a setting changes
  // while it is up.
  const level = React.useMemo(
    () => (notice ? sessionStore.policyLevelFor(notice.cardId) : 'global'),
    [notice]
  );

  // The card came back (it finished, it needs someone, or the user fetched it
  // from the list), or it was closed: either way there is nothing left to
  // explain. "Back" is any rung with a panel: a card brought back as a TAB is
  // on screen too. `wasAway` so that a notice about a card whose move was
  // dropped (it still has its panel) is not read as "it came back".
  // THE BUTTONS UNMOUNT WITH THE SENTENCE. If the keyboard is on one of them
  // when that happens (it was just pressed, or the card came back while it had
  // focus), focus would fall to the body and the next Tab would start from the
  // top of the window. The wrapper stays mounted, so it takes the focus first:
  // Tab then carries on from here, straight into the cards below. Asked of the
  // wrapper's OWN document, as the viewer's strip does (#506).
  const wrap = React.useRef<HTMLDivElement | null>(null);
  const keepFocus = React.useCallback(() => {
    const el = wrap.current;
    if (el && el.contains(el.ownerDocument.activeElement)) el.focus();
  }, []);
  const leave = React.useCallback(() => {
    keepFocus();
    onDismiss();
  }, [keepFocus, onDismiss]);
  const wasAway = React.useRef(false);
  React.useEffect(() => {
    wasAway.current = false;
  }, [notice]);
  React.useEffect(() => {
    if (!notice) return;
    if (title === undefined) return leave();
    if (ladder === null || !hasPanel(ladder)) wasAway.current = true;
    else if (wasAway.current) leave();
  }, [notice, ladder, title, leave]);

  const shown = notice !== null && title !== undefined;
  return (
    <div
      ref={wrap}
      data-testid="submit-notice"
      // focusable by script only, as the place focus rests when the buttons go
      tabIndex={-1}
      className={shown ? 'doc-notice doc-unfollowed' : undefined}
      // three buttons and a sentence: on a narrow window they wrap under the
      // sentence rather than pushing the last one out of the window
      style={shown ? { flexWrap: 'wrap', flexShrink: 0, outline: 'none' } : { outline: 'none' }}
    >
      <span role="status">
        {shown
          ? t(`submitNotice.${notice.rung}.${level}`, {
              name: title,
              setting: t(`policy.${notice.rung === 'hidden' ? 'auto-hide' : 'auto-collapse'}`),
            })
          : ''}
      </span>
      {shown ? (
        <>
          <button
            type="button"
            className="doc-btn"
            data-testid="submit-notice-restore"
            onClick={() => {
              keepFocus();
              onRestore(notice.cardId);
            }}
          >
            {t('submitNotice.restore')}
          </button>
          <button
            type="button"
            className="doc-btn"
            data-testid="submit-notice-off"
            title={t(`submitNotice.offHint.${level}`, { keep: t('policy.always-visible') })}
            onClick={() => {
              // the level the SENTENCE named, not one recomputed now: the
              // button must do what its own words say
              sessionStore.turnPolicyOffFor(notice.cardId, 'submit notice', level);
              keepFocus();
              onRestore(notice.cardId);
            }}
          >
            {t('submitNotice.off')}
          </button>
          <button
            type="button"
            className="doc-btn"
            data-testid="submit-notice-mute"
            title={t('submitNotice.muteHint')}
            onClick={() => {
              muted = true;
              leave();
            }}
          >
            {t('submitNotice.mute')}
          </button>
        </>
      ) : null}
    </div>
  );
}
