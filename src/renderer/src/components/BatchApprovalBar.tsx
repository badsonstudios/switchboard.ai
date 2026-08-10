// The grouped permission prompt (P2-E9-11, DESIGN §5.8 — the octomux pattern).
//
// Several sessions are asking the SAME question. This is the one card that
// asks it once.
//
// WHY IT IS IN THE SHELL AND NOT IN A CARD
// ----------------------------------------
// The per-card review bar (E10-04, `FeedView`'s `ApprovalBar`) cannot host
// this, and not for a styling reason: a card only ever receives its OWN
// requests (`intakePermission` returns early on `r.cardId !== cardId`), and
// dockview mounts only the panels it is showing — so the sibling asking the
// same question is usually a component that does not exist. A cross-session
// prompt has to live where the urgency strip and the collapsed strip live, and
// for the same reason §5.8 gives them: outside the grid, because the grid is
// the thing whose contents keep changing underneath.
//
// A BAND, NOT A MODAL. A modal would seize the whole app for one of several
// questions, and one that switchboard is not entitled to insist on: the CLI
// owns the decision and our whole job is to carry it (P7). It renders nothing
// when nothing groups, exactly as `CollapsedStrip` does.
//
// THE BUTTON SET, AND WHY DENY IS PER MEMBER
// ------------------------------------------
// §5.16's grouping rule for multi-file edits is "approve the batch or
// cherry-pick", and this is that shape one level up: a group answer plus a
// per-session answer in both directions. The item's done-when — "declining one
// leaves the other held" — is the cherry-pick half, and it has to be a real
// per-member control rather than a decline-all, because the whole reason a
// human is looking at this card is that the sessions might not deserve the same
// answer.
//
// What is deliberately NOT here is "Allow all (this session)". That button
// writes a STANDING grant (`sessions:allowAllSession`) — every future gated
// call in that session answered with no bar, no event and no beep — and doing
// it to N sessions from one click is a much larger promise than "these two
// sessions may run this one command". Every button on this card answers exactly
// the requests it lists.
//
// Ordering, naming and the grouping rule itself are `lib/permission-batches`;
// this file only paints.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { argumentDetail, BatchMemberView, PermissionBatch } from '../lib/permission-batches';

export function BatchApprovalBar(props: {
  /** the group on screen, from the store's derive; null renders nothing */
  batch: PermissionBatch | null;
  /** its members with §5.11 identity resolved, in arrival order */
  members: readonly BatchMemberView[];
  /** answer these requests — the same `sessions:decidePermission` the card's
   *  own bar calls, one call per request */
  onDecide: (requestIds: readonly string[], decision: 'allow' | 'deny') => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const batch = props.batch;
  if (!batch) return null;
  const all = props.members.map((m) => m.requestId);
  const title = t('batchApproval.title', { count: batch.sessionCount, tool: batch.tool });
  // `argumentDetail`, not the bare summary the per-card bar uses: this card
  // must be answerable without the session's conversation next to it
  const summary = argumentDetail(batch.input);
  return (
    <div
      // REMOUNT whenever the question or the membership changes.
      //
      // Without a key, React reconciles a different group's buttons into the
      // same DOM nodes — and `chooseBatch` is only sticky against a second
      // group FORMING, not against the current one dissolving. A member
      // resolving elsewhere (its own popped-out card, a timeout) while the user
      // has the mouse down on "Allow in all 2 sessions" would fire mouse-up on
      // a button now bound to an entirely different tool and command.
      //
      // The member count is in the key for the other half of the same problem.
      // A late joiner is byte-for-byte the same QUESTION — the key guarantees
      // that — but it is not the same CONSENT: the user is authorising a set of
      // SESSIONS, and a fourth worktree is not a free extension of the three
      // they read. Remounting means a click that straddles the change lands on
      // nothing, so every answer is a click on a card the user has seen whole.
      key={batch.key + ':' + props.members.length}
      data-testid="batch-approval"
      role="group"
      aria-label={title}
      style={{
        // never give up height (#274): this is the surface a blocked fleet is
        // waiting behind, and a short window must squeeze the workspace instead
        flexShrink: 0,
        paddingInline: 10,
        paddingBlock: 6,
        fontSize: 11,
        borderBlockStart: '2px solid var(--status-needs-permission)',
        borderBlockEnd: '1px solid var(--border)',
        background: 'color-mix(in srgb, var(--status-needs-permission) 8%, var(--panel2))',
      }}
    >
      {/* The card arrives without anyone navigating to it, so the heading is a
          live region — the EventsPanel notices' idiom (#314), and on the
          message rather than the controls, or every answer would re-announce
          "Allow Deny Allow Deny". */}
      <div
        role="status"
        aria-live="polite"
        style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBlockEnd: 5 }}
      >
        {/* -ink, not the hue: the title sits on this bar's own 8% tint of that
            same hue, where the bare hue measures 2.19:1 on daylight (#246) */}
        <span style={{ fontWeight: 700, color: 'var(--status-needs-permission-ink)' }}>{title}</span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minInlineSize: 0,
            flex: 1,
          }}
        >
          {summary}
        </span>
      </div>
      {/* The CLI's own prose for WHY (P2-E18-07). Safe to show once for the
          whole group only because `reason` is part of the grouping key — see
          lib/permission-batches. `--text` and not a hue token: this background
          is already tinted, and a token validated against a flat background is
          not validated against a tinted one (#125). */}
      {batch.reason && (
        <div style={{ color: 'var(--text)', marginBlockEnd: 5, lineHeight: 1.4, maxBlockSize: 48, overflow: 'auto' }}>
          {batch.reason}
        </div>
      )}
      {typeof batch.input.command === 'string' && (
        <pre style={block}>{batch.input.command.slice(0, 1500)}</pre>
      )}
      {typeof batch.input.old_string === 'string' && typeof batch.input.new_string === 'string' && (
        <div style={{ display: 'flex', gap: 6, marginBlockEnd: 5, maxBlockSize: 96, overflow: 'auto' }}>
          <pre style={pane('var(--diff-removed-bg)')}>{batch.input.old_string.slice(0, 1500)}</pre>
          <pre style={pane('var(--diff-added-bg)')}>{batch.input.new_string.slice(0, 1500)}</pre>
        </div>
      )}
      {/* One row per HELD REQUEST, not per session: a session that happens to
          be asking the same thing twice is waiting on two answers, and a card
          that listed it once would leave one of them held with nothing on
          screen saying so. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBlockEnd: 6 }}>
        {props.members.map((m) => (
          <Member key={m.requestId} member={m} onDecide={props.onDecide} t={t} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          data-testid="batch-allow-all"
          onClick={() => props.onDecide(all, 'allow')}
          style={btn(true)}
        >
          {t('batchApproval.allowAll', { count: batch.sessionCount })}
        </button>
        <button
          type="button"
          data-testid="batch-deny-all"
          onClick={() => props.onDecide(all, 'deny')}
          style={btn(false)}
        >
          {t('batchApproval.denyAll', { count: batch.sessionCount })}
        </button>
      </div>
    </div>
  );
}

/**
 * One session's row: who is asking, and the two answers for that one.
 *
 * Named by the §5.11 identity kit — the session's name and its accent dot, the
 * same pair the rail, the lamps and the card header use. Never the folder: a
 * path is what the user is trying not to have to read, and this is the one
 * surface where several sessions are named side by side.
 *
 * A row whose title has not arrived says so plainly rather than announcing a
 * path or an id. The buttons stay usable — the request is real and the CLI is
 * blocked on it whether or not the rail has caught up.
 */
function Member(props: {
  member: BatchMemberView;
  onDecide: (requestIds: readonly string[], decision: 'allow' | 'deny') => void;
  /** passed down rather than re-subscribed per row */
  t: TFunction;
}): React.JSX.Element {
  const { t, member } = props;
  // A row with no name still has to be TELLABLE APART: this is the one surface
  // where the user chooses between sessions, and two rows reading the same
  // words with different buttons is a coin toss. The tail of the live id is not
  // a name, but it is a difference the eye can hold for the second it takes.
  const who = member.title ?? t('batchApproval.unnamedSession', { id: member.sessionId.slice(-4) });
  const one = [member.requestId];
  return (
    <div
      // the row is a role-less mouse convenience; the BUTTONS are the controls
      // (#197's rule). `title` carries the name for the same reason the urgency
      // lamps' does — it is what an e2e selects on without reading a
      // translated string.
      data-batch-member={member.cardId ?? member.sessionId}
      title={who}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        paddingInline: 5,
        paddingBlock: 2,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-chip)',
        background: 'var(--panel)',
      }}
    >
      <span
        aria-hidden
        style={{
          inlineSize: 8,
          blockSize: 8,
          borderRadius: '50%',
          flex: '0 0 auto',
          background: member.accent ?? 'var(--faint)',
        }}
      />
      <span style={{ fontSize: 11, marginInlineEnd: 3 }}>{who}</span>
      <button
        type="button"
        data-batch-allow={member.requestId}
        aria-label={t('batchApproval.allowOne', { session: who })}
        onClick={() => props.onDecide(one, 'allow')}
        style={rowBtn}
      >
        {t('batchApproval.allow')}
      </button>
      <button
        type="button"
        data-batch-deny={member.requestId}
        aria-label={t('batchApproval.denyOne', { session: who })}
        onClick={() => props.onDecide(one, 'deny')}
        style={rowBtn}
      >
        {t('batchApproval.deny')}
      </button>
    </div>
  );
}

const btn = (primary: boolean): React.CSSProperties => ({
  background: primary ? 'var(--btn-primary-bg)' : 'var(--panel)',
  color: primary ? 'var(--btn-primary-text)' : 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-chip)',
  padding: '4px 14px',
  cursor: 'pointer',
  fontFamily: 'var(--font-ui)',
  fontSize: 12,
});

const rowBtn: React.CSSProperties = {
  background: 'var(--panel2)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-chip)',
  padding: '1px 8px',
  cursor: 'pointer',
  fontFamily: 'var(--font-ui)',
  fontSize: 11,
};

const block: React.CSSProperties = {
  margin: '0 0 5px',
  padding: 6,
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 10.5,
  maxBlockSize: 72,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
};

const pane = (background: string): React.CSSProperties => ({
  flex: 1,
  margin: 0,
  padding: 6,
  background,
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 10,
  fontFamily: 'var(--font-mono)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  minInlineSize: 0,
});
