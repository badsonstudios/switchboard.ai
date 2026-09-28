// Which file a held tool call would touch (P2-E22-03, #974).
//
// ── WHY THIS IS SHARED AND NOT A FOURTH COPY ────────────────────────────────
//
// The key list exists twice in the renderer already, and both are right where
// they are: `lib/approval-diff.ts`'s `pathOf` answers "what do I label this
// diff", and `lib/permission-batches.ts`'s `SUMMARY_KEYS` answers "what does
// this call touch, in one line" — a list that also carries `command` and `url`,
// because a `Bash` call has something to say and no file to say it about.
//
// This one answers a third question that MAIN also has to answer, and it is the
// only one of the three where a disagreement is a security bug rather than a
// cosmetic one:
//
//   * the renderer decides whether to OFFER "Approve all in this file", and for
//     which path;
//   * main decides whether a later gated call FALLS UNDER that grant.
//
// If those two used different key lists, a button could grant one path while the
// router matched another — a standing auto-allow the user never agreed to, on a
// file they never saw. So it lives on the boundary, with both ends importing it,
// exactly as `PermissionRequest` does one file over.
//
// ── THE KEYS, AND WHY THIS ORDER ────────────────────────────────────────────
//
// `file_path` is what `Edit`, `Write` and `MultiEdit` use. `notebook_path` is
// `NotebookEdit`'s, measured against the CLI's own tool→input map on 2.1.280
// (`NotebookEdit:{input:"notebook_path"}`) — the one gated tool that would
// otherwise name nothing. `path` is the generic fallback for a tool nobody has
// taught us about, which is a real case: the gated set is not ours to fix.
//
// Order is precedence and must not be sorted. It matches `pathOf`'s, so a card
// that draws a diff for one path cannot grant another.

/** In precedence order, the input keys a tool spells its target file with. */
export const TOOL_PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;

/**
 * The file this tool input would touch, or `null` for a call that touches none.
 *
 * `null` is the ORDINARY answer, not a failure — a `Bash` command, a `WebFetch`,
 * a question. The renderer reads it as "do not draw the per-file button" and
 * main reads it as "no grant can cover this call", and both of those are the
 * safe way round: a tool we cannot scope is a tool that keeps asking.
 *
 * RETURNS THE STRING VERBATIM. Resolution and case-folding belong to main
 * (`StreamPermissions.grantKey`), because they need the session's folder and the
 * host's own path rules — and because a renderer that normalised on its way in
 * would be deciding what "the same file" means on the untrusted side of the
 * wire. This function only finds the field.
 */
export function targetPath(input: Record<string, unknown> | null | undefined): string | null {
  if (!input || typeof input !== 'object') return null;
  for (const key of TOOL_PATH_KEYS) {
    const v = input[key];
    // A non-string or empty value is NOT a reason to try the next key. An input
    // whose `file_path` is an object still has a path field — it is malformed,
    // and reading its `path` instead would scope a grant to whichever key
    // happened to parse. Same rule `summaryKey` applies for the same reason.
    if (key in input) return typeof v === 'string' && v !== '' ? v : null;
  }
  return null;
}
