// How hard the model thinks, as a chip beside the model chip (#1115).
//
// The owner: "like how hard the model works. There's a feature for that. The
// button goes at the bottom, next to the button to switch the model."
//
// WHAT IT SHOWS IS WHAT THE SESSION SAYS, never what we last asked for. The
// CLI can be asked which level is in force (`get_settings`, measured — see
// shared/effort.ts), so the chip reads it: when the card appears, when the
// session's model changes, and after every change of its own. A model with no
// effort levels (Haiku 4.5) answers `null`, and then there is no chip at all:
// an inert control for something this model does not have would be an offer of
// nothing.
//
// A NATIVE <select>, dressed as a chip, and not a second ModelQuickMenu. The
// choice is one out of at most five short words; the platform's list does that
// in one click with the keyboard already working and no placement of our own
// to get wrong against the window edge (#641). The model menu is hand-built
// because its rows carry two lines each and a refusal to print; this has
// neither. Its one failure is said in the row, beside the chip.
//
// THE CHOICE IS REMEMBERED PER CARD and put back when the card's session
// starts again. The CLI keeps the level only for the life of the process (it
// is a flag setting, not a saved one), so a resumed session comes up on the
// model's default; the ticket asks for it to be restored, like any other
// choice made on a card.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../shared/ipc/refusal';
import type { EffortState } from '../../../shared/effort';
import { uiGet, uiSet } from '../lib/ui-state';

/** the ui-blob key a card's chosen level is kept under */
export const effortKey = (cardId: string): string => `effort.${cardId}`;

/**
 * The live sessions a remembered level has already been put back on.
 *
 * MODULE-LEVEL, not a ref (found in review). The card's panel unmounts on
 * every tab switch while the session lives on, so a ref meant "once per
 * mount": a level changed some other way (the CLI's own command, another
 * window) was quietly put back to the remembered one the next time the tab
 * was shown, and a restore the session refused was retried on every visit.
 * Live ids are never reused, so this only grows by one small string per
 * session started.
 */
const restoredSessions = new Set<string>();

/** for tests: forget which sessions have had their level put back */
export function resetEffortRestores(): void {
  restoredSessions.clear();
}

/** how long after a read nobody answered before asking once more */
export const EFFORT_RETRY_MS = 4000;

function readState(response: Record<string, unknown>): EffortState {
  const levels = Array.isArray(response.levels)
    ? response.levels.filter((l): l is string => typeof l === 'string' && !!l)
    : [];
  return {
    effort: typeof response.effort === 'string' && response.effort ? response.effort : null,
    levels,
  };
}

export function EffortChip(props: {
  /** the LIVE session this acts on — the composer's own, as the model chip's is */
  liveId: string;
  /** the card, for remembering the choice; absent, nothing is remembered */
  cardId?: string;
  /** what the model chip says. Not read here: a CHANGE in it is the cue to ask
   *  again, because the levels and the level in force both depend on the model */
  model: string | null | undefined;
  /**
   * The session is in the middle of a turn. The chip shows the level and
   * cannot be changed until the turn is over.
   *
   * NOT because a change mid-turn is known to do harm — because it is not
   * known at all. The contract was measured on an idle session (the probes
   * send no prompt), and "what does the CLI do with a new level halfway
   * through a turn" would cost real turns to find out. Until someone
   * measures it, the honest control is one that waits.
   */
  working?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { liveId, cardId, model, working } = props;
  const [state, setState] = React.useState<EffortState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  /** bumped to ask again after a read nobody answered (once: see below) */
  const [attempt, setAttempt] = React.useState(0);

  // WHEN A CHANGE IN THE MODEL IS A REASON TO ASK AGAIN (#1174).
  //
  // The read below is also what tells a fresh card its model: main seeds the
  // model store from the same answer, and the model chip (and so `model` here)
  // changes a moment later. Asking again on that would be the chip answering
  // its own echo, twice per card. So the test is not "did `model` change" but
  // "is the session on a model the last read did NOT report":
  //
  //  * a change while no read is out asks again unless it is the very model
  //    the last read reported (`reported`). A read that got no answer reported
  //    nothing, so any model turning up after it still asks.
  //  * a change WHILE a read is out waits for it, and then asks again only if
  //    the answer names a different model: a switch that landed between the
  //    question and the answer (found in review).
  //
  // A model that was already different when the read went out and did not move
  // (a resumed card showing the transcript's name) is not a change at all.
  const [again, setAgain] = React.useState(0);
  const latest = React.useRef<string | null>(model ?? null);
  latest.current = model ?? null;
  /** the model the last ANSWERED read said the session is on, if it said */
  const reported = React.useRef<string | null>(null);
  const inFlight = React.useRef(false);

  React.useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setNotice(null);
    // FAIL OPEN (PHILOSOPHY P6): a bridge with no effort channel — an older
    // preload, a test's stand-in — means no chip. It must never be a throw in
    // an effect of the composer, which is the one thing a session cannot lose.
    const sessions = window.switchboard?.sessions as
      | Partial<typeof window.switchboard.sessions>
      | undefined;
    if (typeof sessions?.effort !== 'function') {
      setState(null);
      return;
    }
    inFlight.current = true;
    const sentWith = latest.current;
    void sessions
      .effort(liveId)
      .catch(() => undefined)
      .then(async (raw) => {
      // `answered` launders a capability refusal into undefined; see the note
      // in ModelQuickMenu for the defect that reading `.ok` raw once caused
      const v = answered(raw);
      if (!alive) return;
      inFlight.current = false;
      if (!v?.ok) {
        // no answer is not "no effort levels", but the surface is the same:
        // nothing to show, and nothing claimed
        setState(null);
        // ASK ONCE MORE, a little later (found in review). A session that
        // was still starting, or busy, answers nothing the first time, and
        // the only other cue to ask again is the model changing — which on
        // a resumed card may never happen, leaving no chip for the whole
        // session. Once, not a loop: a session with no control channel
        // will never answer, and must not be asked for ever.
        if (attempt === 0) retry = setTimeout(() => alive && setAttempt(1), EFFORT_RETRY_MS);
        return;
      }
      const told = typeof v.response.model === 'string' && v.response.model ? v.response.model : null;
      reported.current = told;
      // the model moved while this was out, and not to what this answer says
      const now = latest.current;
      if (now && now !== sentWith && now !== told) setAgain((n) => n + 1);
      let next = readState(v.response);
      const saved = cardId ? uiGet<string>(effortKey(cardId), '') : '';
      if (
        saved &&
        next.effort !== null &&
        saved !== next.effort &&
        next.levels.includes(saved) &&
        !restoredSessions.has(liveId)
      ) {
        restoredSessions.add(liveId);
        const put = answered(
          await window.switchboard.sessions.setEffort(liveId, saved).catch(() => undefined)
        );
        if (!alive) return;
        // a level that would not go back is simply not shown as in force; the
        // chip says what the session is on
        if (put?.ok) next = { ...next, effort: saved };
      } else {
        // answered, and nothing to put back: this session is settled
        restoredSessions.add(liveId);
      }
      setState(next);
    })
      // nothing in the chain may reach the composer as an unhandled rejection
      .catch(() => alive && setState(null));
    return () => {
      alive = false;
      inFlight.current = false;
      if (retry) clearTimeout(retry);
    };
  }, [liveId, cardId, again, attempt]);

  // AFTER the effect above, on purpose: on mount that one has already marked
  // its read as out, so this does not send a second.
  React.useEffect(() => {
    if (!model || inFlight.current) return;
    if (model !== reported.current) setAgain((n) => n + 1);
  }, [model]);

  if (!state || state.effort === null) return null;

  const label = (level: string): string => t(`effort.level.${level}`, { defaultValue: level });

  const choose = (level: string): void => {
    if (busy || level === state.effort) return;
    setBusy(true);
    setNotice(null);
    void window.switchboard.sessions
      .setEffort(liveId, level)
      .then((raw) => {
        const v = answered(raw);
        if (v?.ok) {
          setState((s) => (s ? { ...s, effort: level } : s));
          if (cardId) uiSet(effortKey(cardId), level);
          return;
        }
        // The select is CONTROLLED by `state.effort`, which did not move, so it
        // shows the level that is really in force again. Say why, in the CLI's
        // or main's own sentence when there is one.
        setNotice(
          t('effort.failed', {
            level: label(level),
            reason: v && !v.ok && v.message ? v.message : t('effort.noAnswer'),
          })
        );
      })
      .catch(() => setNotice(t('effort.failed', { level: label(level), reason: t('effort.noAnswer') })))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <select
        data-testid="composer-effort"
        className="composer-chip"
        aria-label={t('effort.label')}
        title={t(working ? 'effort.hintWorking' : 'effort.hint')}
        value={state.effort}
        disabled={busy || working}
        onChange={(e) => choose(e.target.value)}
        // a select draws its own arrow; the chip's side padding is for text
        style={{ paddingInline: 4, minInlineSize: 0 }}
      >
        {state.levels.map((level) => (
          <option key={level} value={level}>
            {t('effort.chip', { level: label(level) })}
          </option>
        ))}
      </select>
      {notice && (
        <span
          // `status`, not `alert`: it is news, not an emergency, and an alert
          // would cut across whatever a screen reader is saying
          role="status"
          data-testid="composer-effort-notice"
          title={notice}
          style={{
            fontSize: 10,
            color: 'var(--status-crashed-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minInlineSize: 0,
          }}
        >
          {notice}
        </span>
      )}
    </>
  );
}
