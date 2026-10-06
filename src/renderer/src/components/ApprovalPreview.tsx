// The body of both approval bars, and the one place that decides HOW to show it
// (P2-E22-01, #972, §5.16).
//
// ── WHAT THIS REPLACED, AND WHAT IT DID NOT ─────────────────────────────────
//
// Both bars called `ToolInputPreview` directly. They now call this, and this
// calls one of two things:
//
//   * a real Monaco diff, for the tools that have two sides (`Edit`, `Write`,
//     `MultiEdit` — decided by SHAPE in `lib/approval-diff`, never by name);
//   * `ToolInputPreview`, for everything else.
//
// `ToolInputPreview` is NOT dead code and was not rewritten. It is the non-diff
// renderer — a `Bash` command, a read, a `NotebookEdit`, and the key/value dump
// that is the guarantee a tool nobody has taught us about degrades to something
// legible rather than to silence. It is ALSO the fallback below. Both roles are
// live, which is why its own tests kept every assertion they had.
//
// ── FAIL-OPEN IS THE HARD REQUIREMENT HERE, NOT A NICETY ────────────────────
//
// The card exists to ask a question. A body that fails to render must never cost
// the user the ability to ANSWER, and must never leave them answering with
// nothing on screen — "the only safe answer to a question you cannot read is
// Deny, and a user denied into a corner turns autonomy UP to escape the
// friction" (`ToolInputPreview`'s header). So there are two guards, and they
// catch different failures:
//
//   * **`Suspense`** covers the chunk still being IN FLIGHT. Its fallback is the
//     panes, so the first frame of an approval is always readable and answerable.
//     ⚠️ This does NOT mean Monaco is deferred — `DiffPane` is a static import, so
//     monaco-editor is in the entry chunk and evaluated at startup, and the lazy
//     chunk here is ~6 kB of our own code. The "no new long task on arrival"
//     criterion is met, and it was met before this item; see `ApprovalDiffView`'s
//     header, which says so at length rather than letting this import take credit
//     for it.
//   * **`ContributionBoundary`** covers the chunk FAILING — a rejected dynamic
//     import (offline-ish packaging fault, a corrupted asset) throws during
//     render, which only an error boundary catches. Its `fallback` is the same
//     panes. It was added for this: the boundary rendered `null` before, and a
//     gap here is the one place absence is worse than a simpler truth.
//
// The boundary also bounds its own retries (3 consecutive), so a deterministically
// broken chunk does not re-throw once per feed re-render.
import React from 'react';
import { ContributionBoundary } from '../extensibility/boundary';
import { APPROVAL_DIFF_BLOCK_SIZE, approvalDiff } from '../lib/approval-diff';
import { Markdown } from '../lib/markdown';
import { EXIT_PLAN_MODE_TOOL } from '../../../shared/plan-mode';
import { ToolInputPreview } from './ToolInputPreview';

/**
 * The lazy Monaco half.
 *
 * At module scope, not inside the component: `React.lazy` returns a component
 * whose identity IS the cache key, so one created per render would re-suspend on
 * every keystroke in the composer above it.
 */
const ApprovalDiffView = React.lazy(() => import('./ApprovalDiffView'));

export function ApprovalPreview(props: {
  /** the tool_use input, straight off the CLI — every field is `unknown` */
  input: Record<string, unknown>;
  /**
   * Monaco has exactly two skins, so this takes the RESOLVED answer.
   *
   * Optional, and absent means NO DIFF — the panes instead. A caller that cannot
   * say which skin the app is wearing would make the editor guess, and a diff in
   * the wrong skin on a dark theme is unreadable. Tests and any future embedder
   * get the honest simple body rather than a coin flip.
   */
  colorScheme?: 'light' | 'dark';
  /**
   * `true` on the grouped band above the workspace, which must not shove the
   * workspace around; `false` on the card's own bar. Sizing only — never which
   * branch is taken.
   */
  dense?: boolean;
  /**
   * Which tool is asking (#1071). Only ONE name changes anything here: the
   * plan-approval request, whose input is a document and not arguments.
   * Optional, and absent means what it always meant.
   */
  tool?: string;
}): React.JSX.Element | null {
  const panes = <ToolInputPreview input={props.input} dense={props.dense} />;
  // ── A PLAN IS A DOCUMENT (#1071) ───────────────────────────────────────────
  //
  // `ExitPlanMode` is Claude Code asking for its plan to be approved, and the
  // request carries the plan as Markdown in `input.plan` (measured, #588). It
  // fell through to the key/value dump — one line, `plan="# Plan\n\n1. …"`,
  // line breaks written out as backslash-n — so the thing being approved was
  // unreadable at exactly the moment it mattered.
  //
  // By NAME, unlike the diff below, and deliberately: a `plan` string on some
  // other tool's input is an argument, and rendering an argument as rich text
  // would hide what was actually sent. Same pipeline as the conversation
  // (`Markdown` parses, sanitizes, and nothing here adds to it), and the same
  // fail-open as the diff: if rendering throws, the panes are still the body.
  const plan = props.tool === EXIT_PLAN_MODE_TOOL ? props.input.plan : undefined;
  if (typeof plan === 'string' && plan.trim()) {
    return (
      <div
        data-approval-plan=""
        style={{
          // the part of the bar that gives when the column is short — Allow
          // and Deny never do (#972) — and scrolls rather than clips
          flex: '0 1 auto',
          minBlockSize: 0,
          maxBlockSize: props.dense === true ? 160 : 320,
          overflow: 'auto',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          paddingInline: 10,
          paddingBlock: 4,
          color: 'var(--text)',
        }}
      >
        <ContributionBoundary id="approval-plan" fallback={panes}>
          <Markdown text={plan} />
        </ContributionBoundary>
      </div>
    );
  }
  const diff = React.useMemo(() => approvalDiff(props.input), [props.input]);
  if (!diff || !props.colorScheme) return panes;
  return (
    <DiffSlot dense={props.dense}>
      <ContributionBoundary id="approval-diff" fallback={panes}>
        <React.Suspense fallback={panes}>
          <ApprovalDiffView diff={diff} colorScheme={props.colorScheme} dense={props.dense} />
        </React.Suspense>
      </ContributionBoundary>
    </DiffSlot>
  );
}

/**
 * The room the body gets, and the reason the bar can no longer overflow.
 *
 * ⚠️ TWO PROBLEMS, ONE SLOT, and both were measured rather than reasoned:
 *
 *  1. **The bar used to JUMP.** The `Suspense` fallback was the bare panes, much
 *     shorter than the editor, so everything below the body — Allow and Deny
 *     included — moved down the moment the chunk resolved. A control that shifts
 *     between being aimed at and being pressed is a control that can eat the press,
 *     and Windows CI produced exactly that: a click that landed on Allow (the button
 *     took focus) and never produced a decision. A fixed `flexBasis` means the slot
 *     is the same size before and after, so nothing moves.
 *  2. **The bar used to OVERFLOW.** A fixed height cannot fit in a pane that does not
 *     have it, and the surplus went off the bottom of the column — `toBeInViewport`
 *     on Allow reported a viewport ratio of ZERO at a short window. `flexShrink: 1`
 *     with `minBlockSize: 0` makes the BODY the thing that gives, which is the only
 *     part of a permission that can afford to.
 *
 * So: basis = the diff's height, grow 0, shrink 1. It asks for exactly the room the
 * diff wants, never more, and yields it when the column is short. `ApprovalDiffView`
 * fills the slot rather than setting its own height, so Monaco lays out at the size
 * it actually has and its own scrollbar keeps the rest reachable — clipping the host
 * instead would put the bottom of a diff somewhere no one could scroll to.
 *
 * Wrapped around the boundary as well as the Suspense fallback, deliberately: a
 * failed load then renders the panes in the same slot. That costs some dead space
 * under a short payload in a state that should be rare, and it buys the guarantee
 * that the bar's height never depends on whether a chunk arrived.
 */
function DiffSlot(props: { dense?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      data-approval-diff-slot
      style={{
        flexGrow: 0,
        flexShrink: 1,
        flexBasis:
          props.dense === true ? APPROVAL_DIFF_BLOCK_SIZE.dense : APPROVAL_DIFF_BLOCK_SIZE.roomy,
        minBlockSize: 0,
        // no margin: the bar is a flex column with its own `gap`
        display: 'flex',
        flexDirection: 'column',
        // the panes are the fallback and can be taller than the slot; the diff fills
        // it exactly. Either way the slot is what the column sees.
        overflow: 'auto',
      }}
    >
      {props.children}
    </div>
  );
}
