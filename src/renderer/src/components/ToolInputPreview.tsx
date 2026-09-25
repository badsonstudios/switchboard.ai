// What the pending tool call will actually DO — the body of both approval bars
// (#953, DESIGN §5.16).
//
// WHY THIS IS ONE COMPONENT AND NOT TWO BRANCHES IN TWO FILES
// ----------------------------------------------------------
// There are two placements of the permission question: the per-card bar above
// the composer (`FeedView`) and the grouped band above the workspace
// (`BatchApprovalBar`). §5.16 treats them as one question in two places, and
// `permission-batches` already writes the consequence down for the summary
// line — a user who reads one thing on one surface and another on the other has
// been shown two things and told they are the same. The body has to obey that
// rule too, so it lives here once and both bars render it.
//
// THE BUG THIS EXISTS TO FIX
// --------------------------
// Both bars used to preview exactly two shapes: `command`, and
// `old_string` + `new_string`. The default autonomy is `ask`, and `ask` gates
// all of `MUTATING` — so a held `Write` rendered the file path and NOTHING
// ELSE. `Write` is how an agent creates a file and how it rewrites one
// wholesale, which made Allow on a Write a blind signature. An uninformed
// prompt is worse than a missing one: the only safe answer to a question you
// cannot read is Deny, and a user denied into a corner turns autonomy UP to
// escape the friction, which is the opposite of what the section is for.
//
// THE DEFAULT BRANCH IS THE LOAD-BEARING PART
// -------------------------------------------
// Named branches go stale in BOTH directions and we have measured both:
// `NotebookEdit` keys its path `notebook_path` rather than `file_path` (the
// CLI's own input map), which is why it slipped through a `file_path`-shaped
// summary for months; and `MultiEdit` has DISAPPEARED from the published
// `sdk-tools.d.ts` by claude 2.1.280 while still being named in the binary's
// own edit set. Tools arrive, tools leave, and tools rename their keys. So the
// last branch here is not a fallback for exotica — it is the guarantee that a
// tool nobody has taught this file about degrades to a key/value dump rather
// than to silence.
//
// What is deliberately NOT here: any change to how MUCH is shown. The 1500-char
// clip and the short scroll boxes are a separate, deliberate question (the
// Monaco-in-the-approval-card item). This file is about branches that did not
// exist, not about their size.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { inputFallback } from '../lib/permission-batches';

/** Per-field clip. Same number both bars have always used. */
const MAX_CHARS = 1500;

/**
 * How many of a `MultiEdit`'s changes get a pane pair.
 *
 * A cap rather than a scroll: this is a band the user answers from, not a
 * review surface, and twelve pane pairs in a 96px box is a scroll bar with a
 * decision behind it. The count of what was hidden is always shown, so the cap
 * never quietly hides the size of what is being approved.
 */
const MAX_EDITS = 4;

/** One `{old_string, new_string}` off a `MultiEdit`, once it has been checked. */
type EditPair = { old: string; next: string };

export function ToolInputPreview(props: {
  /** the tool_use input, straight off the CLI — every field is `unknown` */
  input: Record<string, unknown>;
  /**
   * `true` on the grouped band above the workspace, which must not shove the
   * workspace around; `false` on the card's own bar, which can afford a few
   * more pixels. Sizing only — never which branch is taken.
   */
  dense?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const input = props.input;
  const dense = props.dense === true;
  const blockMax = dense ? 72 : 90;
  const paneMax = dense ? 96 : 120;

  // FIRST MATCH WINS, and the order is not alphabetical. `edits` is tested
  // before `old_string`/`new_string` because the CLI itself treats the two as
  // mutually exclusive on the same input — when `edits` is present it strips
  // the singular pair off before rendering — so an input carrying both is a
  // multi-edit, not an edit.

  // Bash / PowerShell
  if (typeof input.command === 'string') {
    return (
      <pre data-preview="command" style={block(blockMax)}>
        {clip(input.command)}
      </pre>
    );
  }

  // MultiEdit
  const edits = editPairs(input.edits);
  if (edits) {
    const hidden = edits.pairs.length - MAX_EDITS;
    return (
      <div data-preview="edits" style={{ marginBlockEnd: 5 }}>
        <Caption>{t('approvalPreview.multiEdit', { count: edits.pairs.length })}</Caption>
        {/* THE LIST SCROLLS AS A WHOLE, and that is not a style choice.
            Each pair caps its own height, but four of them stacked is ~440px
            of a band that declares `flexShrink: 0` (#274) above a workspace
            that is the only thing in the column willing to give. Unbounded,
            a four-change edit held across two sessions pushes Allow and Deny
            off a short window with no scroller to reach them — the approval
            surface made unusable by the approval detail. */}
        <div data-preview-list style={{ maxBlockSize: paneMax * 2, overflow: 'auto' }}>
          {edits.pairs.slice(0, MAX_EDITS).map((e, i) => (
            <Panes key={i} old={e.old} next={e.next} max={paneMax} />
          ))}
        </div>
        {hidden > 0 && <Caption>{t('approvalPreview.moreEdits', { count: hidden })}</Caption>}
        {/* A malformed entry loses ITSELF, never its readable siblings. The
            all-or-nothing version of this dropped six legible changes to show
            a third of a JSON blob, which is the bug this file exists to fix,
            one layer down. */}
        {edits.unreadable > 0 && (
          <Caption>{t('approvalPreview.unreadableEdits', { count: edits.unreadable })}</Caption>
        )}
      </div>
    );
  }

  // Edit
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return (
      <div data-preview="edit" style={{ marginBlockEnd: 5 }}>
        <Panes old={input.old_string} next={input.new_string} max={paneMax} />
      </div>
    );
  }

  // Write — the one that showed nothing at all
  if (typeof input.content === 'string') {
    const content = input.content;
    return (
      <div data-preview="content" style={{ marginBlockEnd: 5 }}>
        {/* The caption says LINES and not "replacing N lines": the renderer is
            holding a tool_use payload, not the disk. Whether this path exists
            is a question only the main process can answer, and a stat over IPC
            per held request is a new wire for one word. So it says what the
            input says and nothing it would be guessing.
            It does not say "whole FILE" either, for the same reason one notch
            up: the dispatch here is by SHAPE, and plenty of tools that are not
            writing a file take a `content`. The caption may only claim what
            having a `content` actually proves. */}
        <Caption>
          {content === ''
            ? t('approvalPreview.writeEmpty')
            : t('approvalPreview.write', { count: lineCount(content) })}
        </Caption>
        {content !== '' && (
          <pre style={{ ...pane('var(--diff-added-bg)'), maxBlockSize: paneMax, overflow: 'auto' }}>
            {clip(content)}
          </pre>
        )}
      </div>
    );
  }

  // NotebookEdit
  if (typeof input.new_source === 'string') {
    const cell = asText(input.cell_id);
    return (
      <div data-preview="new_source" style={{ marginBlockEnd: 5 }}>
        <Caption>
          {cell
            ? t('approvalPreview.notebookCell', { cell })
            : t('approvalPreview.notebookNewCell')}
        </Caption>
        <pre style={{ ...pane('var(--diff-added-bg)'), maxBlockSize: paneMax, overflow: 'auto' }}>
          {clip(input.new_source)}
        </pre>
      </div>
    );
  }

  // Everything else, including everything that does not exist yet.
  const dump = inputFallback(input);
  if (!dump) return null;
  return (
    <pre data-preview="fallback" style={block(blockMax)}>
      {dump}
    </pre>
  );
}

/**
 * `input.edits` as pairs, or `null` if it is not a MultiEdit's array at all.
 *
 * Checked entry by entry rather than cast: this is a payload off the CLI, and
 * the taxonomy comment in `tool-taxonomy.ts` exists because its shapes have
 * moved under us before.
 *
 * **A bad entry costs only itself.** The array is salvaged, not rejected —
 * `unreadable` carries the count so the card can say that something was in the
 * payload it could not render. Only an array with nothing legible in it at all
 * falls through to the dump, because then the dump genuinely is the better
 * answer.
 */
function editPairs(value: unknown): { pairs: EditPair[]; unreadable: number } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const pairs: EditPair[] = [];
  let unreadable = 0;
  for (const entry of value) {
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    if (e && typeof e.old_string === 'string' && typeof e.new_string === 'string') {
      pairs.push({ old: e.old_string, next: e.new_string });
    } else {
      unreadable++;
    }
  }
  return pairs.length === 0 ? null : { pairs, unreadable };
}

/** The before/after pair, the one shape the bars already rendered. */
function Panes(props: { old: string; next: string; max: number }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 6, marginBlockEnd: 5, maxBlockSize: props.max, overflow: 'auto' }}>
      <pre style={pane('var(--diff-removed-bg)')}>{clip(props.old)}</pre>
      <pre style={pane('var(--diff-added-bg)')}>{clip(props.next)}</pre>
    </div>
  );
}

/** A line of context above a pane. `--muted`, because the payload is the point. */
function Caption(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div data-preview-caption style={{ fontSize: 10, color: 'var(--muted)', marginBlockEnd: 3 }}>
      {props.children}
    </div>
  );
}

/**
 * Clip a field, and SAY that it was clipped.
 *
 * The bars used to `slice(0, 1500)` silently, which is the same failure one
 * size down from the one this file fixes: a user who cannot tell a short file
 * from the first page of a long one is answering about something they have not
 * seen the end of.
 */
function clip(s: string): string {
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + '\n…' : s;
}

/**
 * Lines the way a person counts them: a trailing newline ENDS the last line, it
 * does not begin another.
 *
 * `split('\n').length` says 3 for `"a\nb\n"`, and almost every file an agent
 * writes ends in a newline — so the naive version would have overstated the
 * size of the common case by one, on the one caption whose entire job is to
 * tell the user how big the thing they are signing for is.
 *
 * Counted rather than split because this runs on every render of the card's
 * feed, on a string that can be megabytes.
 */
function lineCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.endsWith('\n') ? n : n + 1;
}

/** A cell id is `unknown`; a malformed one is not worth rendering as a label. */
function asText(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : '';
}

const block = (maxBlockSize: number): React.CSSProperties => ({
  margin: '0 0 5px',
  padding: 6,
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 10.5,
  maxBlockSize,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
});

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
