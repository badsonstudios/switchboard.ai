// One session, as a row (#1143).
//
// Lifted out of SessionsRail.tsx, where it was a closure over the whole rail,
// so that the sessions strip's drop-down lists can draw THE SAME ROW rather
// than a second one that agrees with it today. The three rules at the top of
// SessionsRail.tsx (no icon, a needy row is loud, the ring is the only
// animation) are rules about this row, and bind it wherever it is drawn.
//
// It is presentational. What a drag means, where the context menu opens,
// which row is being renamed and what has been typed into it so far are facts
// about the LIST the row is in, so they arrive as props: the rail and the
// strip answer them differently.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { RailSession } from '../model/types';
import { railDepthIndent } from '../lib/dispatch-lineage';
import { attentionPaint, presentStatus } from '../lib/rail-view';
import { tint } from '../lib/tint';
import { StatusMark } from './StatusMark';
import { DEFAULT_TASK_LABEL_SIZE, LABEL_LINES } from '../../../shared/task-label-size';

/**
 * The rename box.
 *
 * THE DRAFT IS NOT STATE HERE, and that is deliberate. A row is unmounted and
 * remounted whenever its list re-parents it: into or out of the sticky pinned
 * block, or into a folder group that forms when a second session opens beside
 * it. Neither needs the user to do anything. A draft kept in this component
 * would come back as the old name halfway through typing a new one, and Enter
 * would then commit the old name.
 */
function RenameField(props: {
  draft: string;
  onDraftChange: (draft: string) => void;
  onRename: (name: string) => void;
  onEnd: () => void;
}): React.JSX.Element {
  const draft = props.draft;
  return (
    <input
      autoFocus
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => props.onDraftChange(e.target.value)}
      onBlur={() => props.onEnd()}
      /* A BLANK NAME IS NOT A RENAME (#294).
         An empty commit used to put `''` in the store as a legal title,
         and every display site (card header, tab, close confirm) grew its
         own "empty counts as absent" rule to compensate. Worse, the rail
         row itself renders the raw title, so the session went nameless in
         the one place you would go to fix it.
         Two guards, deliberately: main's `sessions:renameCard` is what
         makes `''` impossible, and this is what makes the FIELD behave —
         in the idiom it already has for an edit that goes nowhere. Escape
         and blur both end the edit and leave the name that was there, and
         so does this; a rejection the user cannot dismiss is a trap. The
         name is trimmed on the way through for the same reason the task
         label is — surrounding whitespace is never what was meant, and it
         is what makes "blank" a rule you can state. */
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // CONSUMED (#1143). In the strip's list, ending the edit hands the
          // keyboard back to this row's button, and a button that gains focus
          // while Enter is still going down is "clicked" by that same Enter —
          // which there means "go to this session" and closes the list. See
          // `StripRenameBox`, where it was found.
          e.preventDefault();
          const name = draft.trim();
          if (name) props.onRename(name);
          props.onEnd();
        }
        if (e.key === 'Escape') props.onEnd();
      }}
      style={{
        inlineSize: '100%',
        background: 'var(--panel2)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        fontSize: 11.5,
        fontFamily: 'var(--font-ui)',
      }}
    />
  );
}

/**
 * What a session is called out loud: its name, pinned or not, what it is
 * doing, what it is working on, and what other sessions have left in it.
 *
 * A function of its own since #1143: the strip's pill is a second control that
 * stands for a session, and two controls for one session must not describe it
 * differently.
 */
export function sessionSpokenName(
  t: TFunction,
  s: RailSession,
  isPinned: boolean,
  waiting: number
): string {
  const p = presentStatus(s.status);
  return t(isPinned ? 'rail.rowLabelPinned' : 'rail.rowLabel', {
    title: s.title,
    state: ((): string => {
      // #877: the label is announced WHENEVER there is one, including
      // on a row that needs you. It used to be dropped in exactly
      // that case — so the one moment you most want to know WHICH
      // piece of work is asking, the row stopped saying. The ask
      // (`p.labelKey`) still leads, because that is the demand; the
      // label follows as the detail.
      const state = s.taskLabel
        ? t('rail.rowDetail', { detail: s.taskLabel, state: t(p.labelKey) })
        : t(p.labelKey);
      return waiting > 0 ? t('rail.rowWaiting', { state, count: waiting }) : state;
    })(),
  });
}

export function SessionRow(props: {
  session: RailSession;
  /** is this session one of the N its list's "N need you" is counting (#1137) */
  needsYou: boolean;
  /** the card the grid is currently showing, for the selected-row tint */
  selected: boolean;
  pinned: boolean;
  /** messages other sessions have left here, waiting for the user (#774) */
  waiting: number;
  /** how deep the list nested this row under the session that dispatched it
   *  (#951); `undefined` for a row that is not nested at all */
  depth: number | undefined;
  /**
   * How many lines the task label may take (#877) — `LABEL_LINES` from the
   * shared size vocabulary, never a number invented by a caller. Omitted reads
   * as the DEFAULT size, which is the truth for a render test that never
   * mentions it.
   */
  labelLines?: number;
  /** show the rename box in place of the name */
  editing: boolean;
  /** what the rename box holds; the list's, so it outlives a remount of the row */
  draft: string;
  onDraftChange: (draft: string) => void;
  /** draw the insertion line on this side of the row (#559) */
  dropEdge?: 'before' | 'after';
  /**
   * This session's place in the jump order — the N of `Ctrl+N` (#1143).
   *
   * Only the strip's drop-down lists pass it. The rail never has: there the
   * position is the row's place on screen, where you can count it. A list that
   * opens from a group entry has no such place — the entry shows a range and
   * the rows say which is which.
   */
  ordinal?: number;
  /**
   * This is the session the last jump landed on, for the beat that says so
   * (§5.8). The rail and the strip's lists both pass it: since #1164 there is
   * no row of lamps, and this outline is the whole of that signal.
   */
  flash?: boolean;
  /**
   * Its card is collapsed or hidden: not on screen until asked for (#1143).
   * The rail and the strip's lists both pass it: since #1164 there is no
   * Collapsed strip, and this dashed edge is the only thing that says so.
   */
  folded?: boolean;
  onFocus: () => void;
  onClose: () => void;
  /** a non-blank, trimmed name; the edit ends either way */
  onRename: (name: string) => void;
  onStartRename: () => void;
  onEndRename: () => void;
  onDragStart?: React.DragEventHandler<HTMLDivElement>;
  onDragOver?: React.DragEventHandler<HTMLDivElement>;
  onDrop?: React.DragEventHandler<HTMLDivElement>;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const s = props.session;
  const p = presentStatus(s.status);
  // WHO NEEDS YOU is the count's own answer (#1137), not the status's: a row
  // is lit exactly when its session is one of the N the header is counting.
  const paint = attentionPaint(s.status, props.needsYou);
  const hue = `var(--status-${paint.token})`;
  const ink = `var(--status-${paint.token}-ink)`;
  const accent = s.accent ?? 'var(--faint)';
  const selected = props.selected;
  const isPinned = props.pinned;
  const waiting = props.waiting;
  const depth = props.depth;
  const indent = railDepthIndent(depth);
  // a needy session outranks selection: the attention tint is the signal the
  // whole panel exists to carry
  const rowTint = paint.lit ? tint(hue, 10) : selected ? tint(accent, 10) : 'transparent';

  return (
    <div
      className="rail-row"
      // `data-needs-you` is the SEMANTIC one — does a human have to act —
      // and is read by the specs. Its old companion `data-tinted` went with
      // the dead hover rule it existed for (#253): its only reader was
      // `.rail-row[data-tinted='true']:hover`, the exception that kept a
      // needy row's tint from being repainted. No hover rule, nothing to
      // except it from.
      data-needs-you={paint.lit}
      data-session-status={p.token}
      // which row is the session you have open, for the stylesheet (#718): a
      // "working" look repaints the tint and the edge bar that used to be the
      // only things saying so
      data-selected={selected ? 'true' : undefined}
      // §5.8's pinning contract (E9-09). An attribute rather than only a
      // glyph: the protection is a fact about the row that the e2e suite has
      // to be able to read, and styling may want it later.
      data-pinned={isPinned}
      // #559: the row a drop would land against, and which side of it. Read
      // by the e2e — an insertion line is a 2px bar and nothing else on the
      // page can be asked whether it is in the right place.
      data-drop-edge={props.dropEdge}
      // only where the list has said what a drag means: a row that can be
      // picked up and dropped nowhere is a gesture that goes nowhere
      draggable={props.onDragStart !== undefined}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onClick={() => props.onFocus()}
      onDoubleClick={() => {
        // THE SECOND DOOR TO THE SAME FIELD (#687). The menu's Rename is
        // dimmed for a card main has never heard of, because
        // `sessions:renameCard` is `if (prior) upsert(...)` and would write
        // nothing while the next refresh painted the old name back. Gating one
        // of the two entry points would just move the silent no-op behind a
        // gesture with no label on it. Per ROW, not the rail menu's `notStartedRow`
        // — that one is about whichever row the menu was opened on.
        if (s.status === 'not-started') return;
        props.onStartRename();
      }}
      onContextMenu={props.onContextMenu}
      // #951: how deep the nesting put this row. An attribute because the e2e
      // has to be able to ask — indentation is a few pixels of padding and
      // nothing else on the page can be asked whether it is right.
      data-rail-depth={depth ?? undefined}
      data-flash={props.flash ? 'true' : undefined}
      // hover shows this session's last prompt (#631, `LastPromptHover`)
      data-last-prompt-for={s.id}
      data-folded={props.folded ? 'true' : undefined}
      // the pill's own hint: a dashed edge is not self-explanatory
      title={props.folded ? t('strip.pillFoldedHint') : undefined}
      style={{
        // the session's own colour, for whichever "working" look is in force
        // (#718, tokens.css "a working session"). A row only says what its
        // colour is; the look is CSS.
        ['--work-accent' as string]: accent,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        // LOGICAL padding, and the inline-start edge carries the nesting indent
        // (#951). Logical rather than `padding: '8px 8px 8px 13px'` because the
        // rail is mirrored in RTL and a nested row has to indent toward the
        // reading direction, not always to the right.
        paddingBlock: 8,
        paddingInlineEnd: 8,
        paddingInlineStart: 13 + indent,
        borderRadius: 7,
        marginBlockEnd: 2,
        background: rowTint,
        // the post-jump beat (§5.8): the focus accent, drawn INSIDE the row so
        // it costs no layout and cannot be clipped by the list it is in
        boxShadow: props.flash ? 'inset 0 0 0 2px var(--status-working-ink)' : undefined,
        // folded away: the pill's dashed edge, on a row. An outline, so it
        // costs no layout and a row that is not folded is untouched.
        outline: props.folded ? '1px dashed var(--group-frame)' : undefined,
        outlineOffset: props.folded ? -1 : undefined,
      }}
    >
      {props.dropEdge && (
        // The insertion line. `--status-working-ink` is the app's one
        // per-theme-tuned accent (tokens.css) — the same one the focus ring
        // uses, because this is the same kind of statement: here is where the
        // thing you are doing will land.
        <span
          aria-hidden
          data-drop-line={props.dropEdge}
          style={{
            position: 'absolute',
            insetInline: 0,
            [props.dropEdge === 'before' ? 'insetBlockStart' : 'insetBlockEnd']: -2,
            blockSize: 2,
            borderRadius: 1,
            background: 'var(--status-working-ink)',
          }}
        />
      )}
      <span
        aria-hidden
        data-accent-bar
        style={{
          position: 'absolute',
          insetInlineStart: 0,
          insetBlockStart: 3,
          insetBlockEnd: 3,
          // thickens to 4px when it needs you — legible from the far edge of
          // the screen without reading a word
          inlineSize: paint.lit ? 4 : 2.5,
          borderRadius: '0 2px 2px 0',
          background: paint.lit ? hue : selected ? accent : tint(accent, 45),
        }}
      />
      {depth !== undefined && (
        // THE CONNECTOR. `aria-hidden` like every other glyph on the row: the
        // relationship is already in the card's own TITLE, which
        // `dispatchedTitle` built as "<role> of <session>" back at #948 and
        // which the row label reads out. A second spoken "nested under" would
        // say the same thing twice to the one user who cannot see the indent
        // doing the work.
        <span
          aria-hidden
          data-rail-lineage={s.id}
          style={{ fontSize: 11, lineHeight: 1, color: 'var(--faint)', flex: 'none' }}
        >
          {t('rail.lineageMark')}
        </span>
      )}
      {props.editing ? (
        <RenameField
          draft={props.draft}
          onDraftChange={props.onDraftChange}
          onRename={props.onRename}
          onEnd={props.onEndRename}
        />
      ) : (
        <>
          {/* The row's real control (#197). It carries the whole name block
              rather than just the title so the focus ring outlines what a
              sighted user reads as "the row", and so the sub-label — which is
              the ASK when the session needs you — is part of the accessible
              name instead of loose text beside it. */}
          <button
            type="button"
            className="rail-row-open"
            data-rail-open={s.id}
            // The state in words, because the only other place it appears is
            // the status glyph, which is decorative to a screen reader. The
            // detail is the row's OWN second line, and an `aria-label`
            // replaces the contents outright — so it has to be folded in here
            // or a task label would be readable to the eye and to nobody
            // else. (Not when the session needs you: the second line IS the
            // ask then, and the state already says it.)
            // …and a sibling's waiting message is wrapped around that same
            // `state` argument (#774) rather than given its own pair of row
            // labels. Composing keeps this at two row labels instead of four,
            // exactly as `rowDetail` already does for the task label — and it
            // has to be here at all because the mark beside the row is
            // `aria-hidden` decoration like every other glyph on the row.
            aria-label={
              props.folded
                ? t('strip.pillFolded', { name: sessionSpokenName(t, s, isPinned, waiting) })
                : sessionSpokenName(t, s, isPinned, waiting)
            }
            // "this is the session the grid is showing" — a fact about the
            // rail's own list, which is what aria-current is for
            aria-current={selected ? 'true' : undefined}
            onClick={(e) => {
              // the row div below already focuses on click; without this the
              // mouse would run it twice
              e.stopPropagation();
              props.onFocus();
            }}
            style={{
              flex: 1,
              minInlineSize: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 2,
              background: 'transparent',
              border: 'none',
              padding: 0,
              margin: 0,
              textAlign: 'start',
              font: 'inherit',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            {/* LINE 1 — the name, and the state as ONE SHORT WORD to its
                right (#877, the layout Dan picked off the mockup).

                The row used to show EITHER the label or the status on line 2,
                never both, so a session that needed you lost its task label
                entirely — at the one moment you most want to know which piece
                of work is asking. The short word is
                `presentStatus().shortKey` — the same `status.*` vocabulary the
                card header's pill uses, so two surfaces cannot describe one
                session differently.

                ⚠️ IT IS NOT DERIVED FROM `token`, which is what this first
                did. `token` is the COLOUR RAMP stem and the ramp collapses
                states that share a hue, so that spelling renamed a SUSPENDED
                session "idle" — the very distinction the rail exists to draw.
                CI caught it on Windows; `rail-view.test.ts` pins all three
                collapsed pairs now.

                The longer ask ("Wants
                permission to run") leaves the visible row and stays in the
                row button's accessible name, where nothing is lost to a
                screen reader. */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, inlineSize: '100%' }}>
              {props.ordinal !== undefined && (
                // Decoration, like every other mark on the row: the chord is a
                // fact about the keyboard, not part of the session's name.
                <span
                  aria-hidden
                  data-rail-ordinal={props.ordinal}
                  style={{
                    flexShrink: 0,
                    minInlineSize: 12,
                    paddingInline: 3,
                    borderRadius: 3,
                    textAlign: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    lineHeight: 1.4,
                    color: 'var(--muted)',
                    background: 'var(--chip)',
                  }}
                >
                  {props.ordinal}
                </span>
              )}
              <span
                // A NAMED hook, because the structural one broke here (#877).
                // Four e2e specs read the rail's order through
                // `[data-rail-open] > span` — the title was the button's first
                // direct child span until this row grew a flex wrapper, and
                // then that selector silently started returning the TASK
                // LABEL instead. Three tests failed on a mismatched string
                // rather than on anything to do with ordering, which is a
                // twenty-minute detour for whoever next touches this markup.
                data-rail-title={s.id}
                style={{
                  flex: 1,
                  minInlineSize: 0,
                  fontSize: 11.5,
                  fontWeight: paint.lit ? 700 : 600,
                  color: 'var(--text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.title}
              </span>
              <span
                // Named, like the title and the label beside it: the visible
                // state moved from the long ask on line 2 to this short word
                // (#877), and a spec that looks for it by its words is a spec
                // that breaks the next time the vocabulary is reworded.
                data-rail-state={s.id}
                style={{
                  flexShrink: 0,
                  fontFamily: 'var(--font-ui)',
                  fontSize: 9,
                  fontWeight: 700,
                  // the ask's ink when it needs you, quiet otherwise — the
                  // §5.8 ladder still reads at a glance, and the tint, the
                  // 4px edge bar and the bold name all still carry it
                  // …and a BLOCKED session whose event was dismissed keeps
                  // the ink without the rest: off the count, still asking
                  color: paint.stateInk ? ink : 'var(--muted)',
                  whiteSpace: 'nowrap',
                }}
              >
                {t(p.shortKey)}
              </span>
            </div>
            {/* LINES 2…N — the task label, in its own space.

                `labelLines` comes from the shared size vocabulary, so "full"
                means the same here as on the card header. The em dash holds
                ONE line open when there is no label yet: §5.11 asks that the
                row not reflow when one lands, and a label arrives late or
                never. */}
            <span
              // The clamp is the only thing the size setting DOES, and it is
              // a computed style — so e2e needs a name to measure it on.
              data-rail-label={s.id}
              style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 400,
                fontSize: 9.5,
                lineHeight: 1.35,
                color: s.taskLabel ? 'var(--muted)' : 'var(--faint)',
                display: '-webkit-box',
                WebkitLineClamp: props.labelLines ?? LABEL_LINES[DEFAULT_TASK_LABEL_SIZE],
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                maxInlineSize: '100%',
              }}
            >
              {s.taskLabel ?? '—'}
            </span>
          </button>
          {/* §5.8's pin (E9-09), on the row itself. AFTER the name block and
              not before it: a marker in front of the title would indent the
              pinned row's name away from every other row's, so the one row
              you pinned is the one that no longer lines up. Decoration to a
              screen reader — the fact is folded into the row button's own
              accessible name above, where it is read as part of "this
              session" rather than as a loose glyph beside it. */}
          {isPinned && (
            <span
              aria-hidden
              title={t('rail.pinnedHint')}
              style={{ fontSize: 9, lineHeight: 1, flexShrink: 0, color: 'var(--muted)' }}
            >
              {t('rail.pinIcon')}
            </span>
          )}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 4,
              flexShrink: 0,
              alignSelf: 'stretch',
            }}
          >
            <button
              className="rail-x"
              title={t('rail.closeSession')}
              aria-label={t('rail.closeSession')}
              onClick={(e) => {
                e.stopPropagation();
                props.onClose();
              }}
              style={{ fontSize: 10 }}
            >
              {t('rail.closeSessionIcon')}
            </button>
            {/* #774: what other sessions have left here. Decoration, like
                every other mark on the row — the count is in the row button's
                accessible name above.

                IN THE STATUS COLUMN, NOT REPLACING THE STATUS GLYPH: what the
                session is doing and what is waiting for you in it are
                independent facts, and a working session with a message in it
                is the normal case rather than a corner. It sits ABOVE the
                glyph so the status column still ends on the glyph every row
                has, and it is BLUE, the same ink the Session tab's badge
                uses. It was the "needs input" yellow until #1165: a message
                waiting to be read is something to read, not a session
                blocked on you (it is kept out of the "N need you" count for
                the same reason), and yellow is now for that and nothing
                else. Rule 3 of SessionsRail.tsx's header holds: no
                animation. */}
            {waiting > 0 && (
              <span
                aria-hidden
                data-rail-waiting={s.id}
                title={t('rail.waitingHint', { count: waiting })}
                style={{
                  minInlineSize: 16,
                  blockSize: 16,
                  borderRadius: 8,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingInline: 4,
                  fontFamily: 'var(--font-ui)',
                  fontWeight: 700,
                  fontSize: 9.5,
                  lineHeight: 1,
                  color: 'var(--status-working-ink)',
                  background: tint('var(--status-working)', 18),
                }}
              >
                {waiting}
              </span>
            )}
            {/* The glyph and the ring are DECORATION: `aria-label` on a
                role-less span is ignored by every screen reader anyway, and
                the state it was trying to announce is now in the row button's
                own name. `title` stays — that one is for the mouse. */}
            <StatusMark status={s.status} needsYou={props.needsYou} />
          </div>
        </>
      )}
    </div>
  );
}
