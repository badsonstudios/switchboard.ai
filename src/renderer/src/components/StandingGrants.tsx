// The door back out of a standing approval (P2-E22-03, #974, §5.16).
//
// ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
//
// "Always allow for this session" had **no revoke surface anywhere**. The grant
// lived in `StreamPermissions.allowAllSessions`, was cleared only by
// `forgetSession`, and nothing in the renderer could take it back — so a
// mis-click on a bar that hands a live session blanket write approval was a
// one-way door until the session died. That was true from #319 (2026-08) until
// this item, and it is why E22-03 was sized M: #974 adds a SECOND kind of
// standing grant, and shipping a second ungrantable-back grant beside the first
// would have doubled the problem rather than noticed it.
//
// ── WHY IT IS A MENU SECTION AND NOT A DIALOG ───────────────────────────────
//
// A modal would be heavier than the fact it manages. A standing grant is a small
// thing about one session — "what has this card been told it may do without
// asking me" — and the card's ⋯ menu is already where this session's other
// standing preferences live (notify-when-done, accept-from-siblings). One click
// to see them, one to take one back.
//
// ⚠️ THE EMPTY STATE RENDERS, and that is not politeness. The whole defect is a
// grant you cannot see; a section that appeared only when there was something to
// show would teach the user nothing about where to look, and its absence would
// be indistinguishable from the feature not existing.
//
// ── WHERE THE TRUTH LIVES ───────────────────────────────────────────────────
//
// MAIN. This component holds no copy it computes itself: it asks on mount and
// re-reads on every `sessions:standingGrantsChanged` push, including the pushes
// caused by its own clicks. Main is the only place that resolves a path against
// the session's folder and folds it with the host's case rule, and a second copy
// of that arithmetic here is exactly how a list would come to show one path
// while the router matched another.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { StandingGrants } from '../../../shared/ipc/permissions';
import { answered } from '../../../shared/ipc/refusal';

const EMPTY: StandingGrants = { allowAll: false, files: [] };

/**
 * Live standing grants for one LIVE session, or the empty set.
 *
 * `liveId` null means no live session — a suspended or crashed card. It holds
 * no grants by definition (they die with the live id), so the hook answers
 * empty without asking.
 */
export function useStandingGrants(liveId: string | null): StandingGrants {
  const [grants, setGrants] = React.useState<StandingGrants>(EMPTY);
  React.useEffect(() => {
    if (!liveId) {
      setGrants(EMPTY);
      return;
    }
    // ⚠️ THE FLAG HAS TO BE CLEARED BY THE CLEANUP, and the first version
    // returned the unsubscribe directly — so it was never set false, the guard
    // below was dead, and a read that resolved after the card's live id changed
    // would have written the OLD session's grants into the new one's list.
    // `prefer-const` is what caught it, which is the lint rule earning its keep.
    let mounted = true;
    // ⚠️ OPTIONAL, BOTH OF THEM, and this is P6 rather than defensive style: a
    // revoke surface is a nicety and MAY NOT COST THE CARD. A bridge without
    // this namespace — an older preload, or one of the many suites that stub
    // the slice they care about — would otherwise throw during render and take
    // the whole card down. `SessionGrid.sound.test.tsx` already asserts exactly
    // this rule for its own entry ("draws no entry at all without the bridge
    // namespace"), and it is what caught this: 39 of its tests went red on a
    // `standingGrants is not a function`.
    //
    // `Partial<...>` is the honest type for a bridge at RUNTIME: the declaration
    // says every method is there, and a preload that predates this item is a
    // counter-example the compiler cannot see.
    const api = window.switchboard?.sessions as
      | Partial<typeof window.switchboard.sessions>
      | undefined;
    if (!api?.standingGrants || !api.onStandingGrants) return;
    // Ask once, then follow. Both halves are needed and neither is enough: the
    // push only fires on a CHANGE, so a menu opened on a session that was
    // granted earlier would show nothing; and a read alone would go stale the
    // moment anything else moved a grant.
    void api
      .standingGrants(liveId)
      .then((g) => {
        // LAUNDERED (#650's rule, enforced by `refusal-truthiness.test.js`): a
        // capability refusal arrives as a BRAND, not as a rejection, and reading
        // `.files` off it would put a brand where a list belongs. `?? EMPTY`
        // is the fail-open this surface wants anyway — see the catch below.
        if (mounted && !pushed) setGrants(answered(g) ?? EMPTY);
      })
      .catch(() => {
        // A failed read leaves the EMPTY set, which is the fail-open that suits
        // this surface: showing no grants when we cannot tell is a list that
        // under-promises. It is also visibly wrong to a user who just made one,
        // where a stale list would not be.
      });
    // ⚠️ A PUSH BEATS THE READ, whenever it lands (review). The mount read is an
    // async round trip and a push can resolve first — main's own writes are
    // synchronous — so without this a stale read would land afterwards and undo
    // a grant the user had just made. The push is always the newer truth.
    let pushed = false;
    const off = api.onStandingGrants((g) => {
      if (!mounted || g.sessionId !== liveId) return;
      pushed = true;
      setGrants({ allowAll: g.allowAll, files: g.files });
    });
    return () => {
      mounted = false;
      off();
    };
    // `liveId` is the real key; the exhaustive-deps plugin is not installed here
  }, [liveId]);
  return grants;
}

/** How many standing approvals are in force — for the ⋯ button's marker. */
export function grantCount(g: StandingGrants): number {
  return (g.allowAll ? 1 : 0) + g.files.length;
}

export function StandingGrantsSection(props: {
  liveId: string;
  grants: StandingGrants;
  // NO `onDone`. A revoke does NOT close the menu, deliberately: taking back
  // three files is three clicks, and a menu that shut after the first would make
  // the common case the awkward one. The list re-renders under the pointer from
  // main's push, which is the feedback.
}): React.JSX.Element {
  const { t } = useTranslation();
  const { grants } = props;
  const revoke = (kind: 'all' | 'file', filePath?: string): void => {
    // No optimistic removal. Main pushes the new set after every mutation, and
    // letting that push be the only writer means the list and the router cannot
    // disagree even for a frame — the same argument `App.tsx`'s `decideHeld`
    // makes for not popping the held-permission ledger locally.
    void window.switchboard.sessions
      .revokeStandingGrant(props.liveId, kind, filePath)
      .catch(() => false);
  };
  const rows = grantCount(grants);
  return (
    <div data-testid="card-standing-grants" style={{ padding: '2px 0' }}>
      <div
        style={{
          padding: '4px 8px 2px',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.2,
          color: 'var(--muted)',
        }}
      >
        {t('grants.heading')}
      </div>
      {rows === 0 && (
        <div
          data-testid="card-standing-grants-empty"
          style={{ padding: '2px 8px 4px', fontSize: 10.5, color: 'var(--faint)' }}
        >
          {t('grants.none')}
        </div>
      )}
      {grants.allowAll && (
        <GrantRow
          testId="card-grant-all"
          // The WIDER rung first, always, whatever else is listed. It is the one
          // a user is most likely to have set by accident and least likely to
          // want, and a list that buried it under three file paths would be
          // sorted by nothing anyone cares about.
          label={t('grants.allowAll')}
          hint={t('grants.allowAllHint')}
          revokeLabel={t('grants.revokeAllowAll')}
          onRevoke={() => revoke('all')}
        />
      )}
      {grants.files.map((f) => (
        <GrantRow
          key={f}
          testId="card-grant-file"
          testValue={f}
          // The tail, not the head: a menu is ~200px and a path is not, so the
          // end of it is what identifies the file. The full path is the title
          // and the accessible name, so nothing is only available on hover.
          label={tailOf(f)}
          hint={f}
          revokeLabel={t('grants.revokeFile', { path: f })}
          onRevoke={() => revoke('file', f)}
        />
      ))}
    </div>
  );
}

function GrantRow(props: {
  testId: string;
  testValue?: string;
  label: string;
  hint: string;
  revokeLabel: string;
  onRevoke: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      data-testid={props.testId}
      data-grant-path={props.testValue}
      title={props.hint}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        fontSize: 10.5,
      }}
    >
      <span
        style={{
          flex: 1,
          minInlineSize: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text)',
        }}
      >
        {props.label}
      </span>
      <button
        type="button"
        // The FULL name on the control, not on the row: a screen-reader user
        // meets this button on its own, and "✕" is not a sentence.
        aria-label={props.revokeLabel}
        title={props.revokeLabel}
        onClick={props.onRevoke}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-chip)',
          color: 'var(--text)',
          cursor: 'pointer',
          padding: '0 6px',
          fontSize: 10,
          fontFamily: 'var(--font-ui)',
          flexShrink: 0,
        }}
      >
        {t('grants.revokeIcon')}
      </button>
    </div>
  );
}

/**
 * The last two segments of a path, which is what identifies a file in a 200px
 * menu. Split on BOTH separators: main folds to the host's spelling, and a
 * grant made on one platform is read on the same one, but a stored fixture or a
 * POSIX path on Windows would otherwise come back whole.
 */
export function tailOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}
