// Deny with feedback — the objection field (P2-E22-02, #973, §5.16).
//
// ── WHAT IS SHARED AND WHAT DELIBERATELY IS NOT ─────────────────────────────
//
// Shared: the FIELD. Focus on open, Enter sends, Shift+Enter newlines, Esc
// cancels, `maxLength` at the one constant main clamps to. Those are the
// done-when, they are behaviour rather than paint, and two copies of them would
// drift the first time one host got a fix.
//
// NOT shared: the trigger button, or the decision of where the field goes. The
// two hosts have genuinely different layout constraints and a component that
// owned both would have to satisfy the stricter one everywhere:
//
//   * **The card bar** (`FeedView`'s `ApprovalBar`) is a flex column whose BODY
//     is the shrinkable part — heading, reason and buttons are `flexShrink: 0`
//     on purpose, because whatever gives, the ANSWER does not (#972, measured on
//     Windows CI: `toBeInViewport` on Allow reported a ratio of ZERO). So the
//     field has to sit ABOVE the button row and has to be able to shrink, or it
//     becomes a new way to push Allow and Deny off a short window.
//   * **The Events row** is a compact list item with no height budget at all,
//     and its buttons go through a double-click disarm the field must respect.
//
// So each host places it and this file makes it behave.
//
// ── WHY THE FIELD IS BOUNDED ON BOTH SIDES OF THE WIRE ──────────────────────
//
// `maxLength` here is the courtesy: the user is stopped at the edge and can see
// the counter rather than having prose silently cut later.
// `StreamPermissions.sanitizeDenialReason` is the enforcement, because a
// `maxLength` is a suggestion a renderer makes to itself. Both read
// `MAX_DENIAL_REASON_CHARS`, so they cannot disagree.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_DENIAL_REASON_CHARS } from '../../../shared/ipc/permissions';

/**
 * The block sizes, named because the FLOOR is load-bearing and it took two
 * wrong versions and a red CI run to land.
 *
 * ⚠️ THE FLOOR HAS TO BE ON THE ROOT, AND IT HAS TO INCLUDE THE CHROME. Both
 * failures were the same mistake from opposite ends:
 *
 *  1. **Floor on the root, sized for the textarea alone.** The root also holds
 *     the Send/Cancel row, so at the floor the textarea was handed
 *     `30 - buttons - gap` ≈ 5px — less than its own padding, and compact went
 *     negative. "A field the user cannot see what they are typing in is not a
 *     field" was the comment on the line that produced exactly that.
 *  2. **Floor moved to the TEXTAREA, root left at `minBlockSize: 0`.** Now the
 *     root could be shrunk below its own content, and a flex item smaller than
 *     its content OVERFLOWS — so in a 1024×480 window the Send/Cancel row
 *     painted on top of the answer row and Playwright reported
 *     `<button>Allow all (this session)</button> … intercepts pointer events`.
 *     Allow and Deny were still in the viewport and still unclickable, which is
 *     a more interesting way to fail than #972's and would have read as flake.
 *
 * So: `min` and `max` bound the TEXTAREA, `chrome` is the gap plus the button
 * row, and the root's floor is `min + chrome`. The root can then shrink from its
 * natural height down to that floor and no further, the textarea absorbs all of
 * it, and nothing ever exceeds its box. `overflow: hidden` on the root is the
 * backstop for `chrome` being a measured-by-eye constant rather than a
 * measurement: a bad estimate clips this field, which Escape can still dismiss,
 * instead of covering the answer.
 *
 * The CEILING is the other half, and it is what keeps the card bar's promise:
 * the bar's incompressible height is heading + the CLI's reason (≤64) + this +
 * the button row, and a field with no maximum would put an unbounded term in
 * that sum the moment someone gave the textarea `rows={4}`.
 */
const FIELD = {
  roomy: { min: 30, max: 70, chrome: 28 },
  compact: { min: 24, max: 48, chrome: 23 },
} as const;

export function DenyFeedbackField(props: {
  /** send the typed objection — the host turns this into a deny carrying it */
  onSend: (reason: string) => void;
  /** close without answering; the request stays held */
  onCancel: () => void;
  /** the Events row's cramped variant: smaller type, one row instead of two */
  compact?: boolean;
  /** disables the whole field — the Events row's double-click disarm */
  disabled?: boolean;
  /** what the trigger button's `aria-controls` points at */
  id?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = React.useState('');
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  // WHERE FOCUS CAME FROM, so cancel can put it back (review). Captured on
  // mount, before the focus below moves it. Without this, Escape unmounts the
  // focused element and focus falls to `document.body` — a keyboard user
  // mid-answer has to Tab from the top of the document, and in the Events
  // drawer `body` is the "stranded" branch that makes the NEXT Escape close the
  // whole drawer.
  const cameFrom = React.useRef<HTMLElement | null>(null);
  // Focus lands in the FIELD (done-when), not on the button that opened it. A
  // control that appears under the cursor with focus left behind is one the
  // keyboard cannot reach without hunting, and the whole point of this field is
  // that typing into it is the next thing the user wants to do.
  //
  // `autoFocus` would do it too and is deliberately not used: React applies it
  // during commit, and this element is mounted inside a bar whose own layout is
  // still settling (the diff slot resolving). An effect runs after that.
  React.useEffect(() => {
    const prior = document.activeElement;
    cameFrom.current = prior instanceof HTMLElement ? prior : null;
    ref.current?.focus();
  }, []);
  const cancel = (): void => {
    // Before the unmount, not after: once this component is gone the element it
    // was mounted from is the only place focus can sensibly go, and nothing
    // else remembers it.
    cameFrom.current?.focus();
    props.onCancel();
  };
  // A BARE ENTER SENDS, which is the opposite of the composer's rule one element
  // away, and the difference is what is being typed. The composer holds a prompt
  // that is often several paragraphs; this holds a sentence explaining a refusal,
  // and the request is HELD — a CLI is blocked on it — so the fast path has to be
  // the one that answers. Shift+Enter still gets a newline for the user who wants
  // one, and nothing about that is discoverable, which is why the placeholder says
  // it.
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      // `stopPropagation`, because Escape is also the app's "get me out of here"
      // (the palette, the drawer, a popout). Cancelling this field should not
      // also close the surface the held request is being read in.
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const send = (): void => {
    if (props.disabled === true) return;
    // Empty is allowed to reach main, and main turns it back into a bare denial
    // (`sanitizeDenialReason` returns undefined for whitespace). The alternative
    // — a disabled Send on an empty field — would leave a user who opened the
    // field by mistake with no way out but Escape, on a request that is blocking
    // a session.
    props.onSend(text);
  };
  const compact = props.compact === true;
  const size = compact ? FIELD.compact : FIELD.roomy;
  const fontSize = compact ? 10.5 : 11.5;
  return (
    <div
      data-deny-feedback=""
      id={props.id}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        /* ⚠️ THE CARD BAR'S CONSTRAINT, AND IT IS WHY THIS IS NOT `flexShrink: 0`
           (#972/#973). In the bar this sits between the body and the button row,
           all of which are in one flex column. `flexShrink: 1` lets the column
           take space back from here when the window is short — and the body's
           basis is ~4x larger, so the body gives first and nearly all of it.
           THE FLOOR IS HERE AND INCLUDES THE BUTTON ROW (see `FIELD`): a flex
           item shrunk below its own content overflows, and what it overflows
           onto is Allow and Deny.
           In the Events row the column is not flex and none of this applies. */
        flexShrink: 1,
        minBlockSize: size.min + size.chrome,
        minInlineSize: 0,
        // backstop for `chrome` being an estimate: clip THIS, never the answer
        overflow: 'hidden',
      }}
    >
      <textarea
        ref={ref}
        data-deny-feedback-input=""
        aria-label={t('denyFeedback.label')}
        placeholder={t(compact ? 'denyFeedback.placeholderCompact' : 'denyFeedback.placeholder')}
        value={text}
        maxLength={MAX_DENIAL_REASON_CHARS}
        // DISABLED, not merely ignored on send (review). The Events row disarms
        // its buttons for a beat after an answer; a box that still takes
        // keystrokes and swallows Enter looks live and is not.
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys}
        rows={compact ? 1 : 2}
        style={{
          inlineSize: '100%',
          boxSizing: 'border-box',
          // the root's floor already guarantees this much; `0` here is what lets
          // the textarea absorb the root's shrink instead of overflowing it
          minBlockSize: 0,
          maxBlockSize: size.max,
          flex: 1,
          resize: 'none',
          background: 'var(--panel)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-chip)',
          padding: '4px 6px',
          fontFamily: 'var(--font-ui)',
          fontSize,
          lineHeight: 1.35,
        }}
      />
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexShrink: 0 }}>
        <button
          type="button"
          data-deny-feedback-send=""
          onClick={send}
          disabled={props.disabled}
          style={fieldBtn(fontSize)}
        >
          {t('denyFeedback.send')}
        </button>
        <button type="button" data-deny-feedback-cancel="" onClick={cancel} style={fieldBtn(fontSize)}>
          {t('denyFeedback.cancel')}
        </button>
        {/* The counter only appears once it is nearly relevant. A character count
            sitting under an empty box is chrome; one that arrives as the cap
            approaches is the warning `maxLength` cannot give on its own — a
            textarea that simply stops accepting keystrokes reads as broken. */}
        {text.length >= MAX_DENIAL_REASON_CHARS - 50 && (
          <span
            data-deny-feedback-count=""
            style={{ fontSize: fontSize - 1.5, color: 'var(--muted)' }}
          >
            {t('denyFeedback.count', { n: MAX_DENIAL_REASON_CHARS - text.length })}
          </span>
        )}
      </div>
    </div>
  );
}

const fieldBtn = (fontSize: number): React.CSSProperties => ({
  background: 'var(--panel)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-chip)',
  padding: fontSize > 11 ? '3px 10px' : '1px 8px',
  cursor: 'pointer',
  fontFamily: 'var(--font-ui)',
  fontSize,
});
