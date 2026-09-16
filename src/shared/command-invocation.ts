// A slash-command invocation, as the CLI writes it into a transcript (#846).
//
// The CLI records `/clear` as an ordinary `user` line whose text is markup:
//
//   <command-name>/clear</command-name>
//   <command-message>clear</command-message>
//   <command-args></command-args>
//
// That is plumbing wearing a prompt's clothes. Two different consumers need two
// different things from it, which is why this module exports two functions
// rather than one:
//
//   * the prompt readers (`promptText`, and through it the history picker's
//     description and the context package's goal) must not treat it as prose —
//     `isCommandPlumbing`;
//   * the Feed DOES render it, as a collapsed "you ran /clear here" marker, and
//     wants it readable — `commandInvocation`.
//
// ── WHY THIS LIVES IN `shared/` ────────────────────────────────────────────
//
// Both halves of the app need it: `main/sessions/context-package.ts` reads it
// when deriving prose, and `renderer/.../feed-blocks.tsx` reads it when drawing
// the block. The renderer cannot import from `src/main` (separate tsconfig
// projects, separate processes), so a helper beside `isPlumbing` in
// `main/feed/blocks.ts` would have forced the renderer to keep its own regex —
// which is the duplication this module exists to remove.
//
// ── MEASURED, AND THE METHOD MATTERS ───────────────────────────────────────
//
// Newest-first by mtime over every directory under `~/.claude/projects`, first
// 128 KB of each file; keep a line iff `type === 'user'` and not `isMeta` and
// not `isSidechain`; text is the string content or the first `text` item; drop
// it if it starts with `<local-command-` (what `isPlumbing` does); take the
// FIRST survivor per transcript. On the owner's machine (3,037 transcripts):
//
//   newest  40 → 5 open with `<command-name>`, 35 with prose
//   newest 150 → 5
//   newest 400 → 39
//
// ⚠️ An earlier pass on this bug reported "28 of 40" and that figure was WRONG —
// it was quoted in three comments and a test before a review re-measured it. The
// method above is spelled out so the next reader can reproduce it rather than
// inherit a number. The bug is real either way: 5 in 40 is what the owner hit.
//
// `<command-message>` never leads a surviving first block in any sample taken
// (12 leading occurrences across 1,200 files overall), so it is in the tag list
// for completeness rather than on observed first-block evidence.
//
// The shapes and the extraction are the Claude Code VS Code extension's own
// (`webview/index.js`, 2.1.226, read 2026-09-16). It keeps a prefix list —
// `<local-command-stdout>`, `<local-command-stderr>`, `<system-reminder>`,
// `<bash-input>`, `<bash-stdout>`, `<bash-stderr>`, `<task-notification>`,
// `<tick>`, `<command-name>`, `<command-message>` — and skips any message
// starting with one; and where it shows a command it joins name and args rather
// than rendering the markup. Only the command tags live here: the
// `<local-command-*>` family is already handled by `isPlumbing` in
// `main/feed/blocks.ts`.
//
// ⚠️ `<task-notification>` IS produced here — 275 leading occurrences on
// surviving user blocks across the 1,200 newest transcripts, far more than the
// command tags. It is deliberately NOT claimed by this module: it never leads a
// transcript's FIRST surviving block (so no description shows it), and adding it
// would change what the Feed renders as well as what the prompt readers skip.
// That is #704's job, and doing it here would be a rendering change smuggled
// into a description fix. It does reach the context package's INSTRUCTIONS
// section today — same defect class as this one, tracked there.
//
// The remaining reference tags (`<system-reminder>`, `<bash-*>`, `<tick>`) were
// not observed leading a surviving user block in any sample, so claiming them
// would be an untested rule on no evidence.

/**
 * The command tags that can OPEN a user line.
 *
 * `<command-args>` is deliberately absent: it never leads — it follows a
 * `<command-name>` in the same blob — so including it would widen the skip
 * without matching anything the CLI actually writes.
 */
const COMMAND_TAGS = ['<command-name>', '<command-message>'] as const;

/**
 * Is this user text a command invocation rather than something the user said?
 *
 * `startsWith` after trimming, exactly like the reference implementation: the
 * markup opens the line, and a prompt that merely MENTIONS `<command-name>`
 * partway through — a user asking about this very format, which is a thing that
 * happens in this repo — is still a prompt and must survive.
 */
export function isCommandPlumbing(text: string): boolean {
  const t = text.trimStart();
  return COMMAND_TAGS.some((tag) => t.startsWith(tag));
}

/**
 * The command as a person would write it: `/clear`, `/next-item 818`.
 *
 * `null` when the text carries no `<command-name>` at all, and when the tags are
 * present but empty — a blank string is not a better answer than "this is not a
 * command", and every caller has a sensible thing to do with `null`.
 *
 * The args half is optional because the CLI omits it for a bare command, and
 * the join is trimmed so a command with no args does not answer `"/clear "`.
 */
export function commandInvocation(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  const joined = `${name[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  if (!joined) return null;
  // ONE LINE, AND BOUNDED — measured, and this is the whole reason the function
  // does not simply return `joined`. An argument is not always a word: in this
  // repo `/startup` and `/next-item` are run with a whole briefing pasted in,
  // and of the 10 commands carrying non-empty args in the 1,200 newest
  // transcripts, **7 are 1,907–5,929 characters with 32–94 newlines**. Both
  // callers want a LABEL — the Feed draws it in a `nowrap` span that doubles as
  // an expander button's accessible name, and a history row draws it in a table
  // cell — so an unbounded multi-line blob is the wrong answer for each of them.
  // The full text is still on the block; only this summary is clamped.
  const flat = joined.replace(/\s+/g, ' ').trim();
  return flat.length > COMMAND_LABEL_CHARS ? `${flat.slice(0, COMMAND_LABEL_CHARS - 1)}…` : flat;
}

/**
 * How long a rendered command may be.
 *
 * Long enough for a real command with a short argument (`/next-item 818`,
 * `/code-review high`), short enough that a pasted briefing cannot take over a
 * one-line marker. It is a label budget, not a content budget.
 */
const COMMAND_LABEL_CHARS = 80;
