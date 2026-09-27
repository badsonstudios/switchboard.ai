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
import { approvalDiff } from '../lib/approval-diff';
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
}): React.JSX.Element | null {
  const panes = <ToolInputPreview input={props.input} dense={props.dense} />;
  const diff = React.useMemo(() => approvalDiff(props.input), [props.input]);
  if (!diff || !props.colorScheme) return panes;
  return (
    <ContributionBoundary id="approval-diff" fallback={panes}>
      <React.Suspense fallback={panes}>
        <ApprovalDiffView diff={diff} colorScheme={props.colorScheme} dense={props.dense} />
      </React.Suspense>
    </ContributionBoundary>
  );
}
