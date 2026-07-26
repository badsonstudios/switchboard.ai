// Tool-name taxonomy for the Claude Code CLI — the ONE place raw tool names
// are classified. Names are platform/version-volatile (the CLI shells out via
// a `PowerShell` tool on Windows — probe 2026-07-22; a Bash-only gate missed
// it), so both the main-process hold policy and the renderer's block
// presentation dispatch on these, never on raw names at the point of use.

/** Shell executors — platform-dependent (PowerShell on Windows). */
export const SHELLISH = ['Bash', 'PowerShell'];

/** Tools that mutate the workspace or reach the network. */
export const MUTATING = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch'];

/** Read-only tools — only gated when they leave the session folder. */
export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];

/**
 * Tools that BLOCK MID-TURN on a human answering a TUI dialog (#92).
 *
 * These are the odd ones out: every other tool means "Claude is working", but
 * one of these means Claude has stopped and is waiting for a person. Verified
 * against the shipped `sdk-tools.d.ts` of claude 2.1.220 and by a live PTY
 * probe — `-p` mode never offers the tool, so only interactive mode shows it:
 *
 *     {"ev":"PreToolUse","tool":"AskUserQuestion"}
 *     {"ev":"Notification","nt":"permission_prompt","msg":"Claude needs your permission"}
 *
 * The Notification is the CLI's generic "a prompt is on screen" nudge — it is
 * debounced ~6s (S-06) and calls a QUESTION a permission request, which would
 * put a card in needs-permission with no approval bar to act on. The PreToolUse
 * above is immediate and says exactly which tool it is, so that is what we use.
 *
 * NEVER hold one of these: the answer lives in the CLI's own TUI, so parking it
 * behind our approval bar would leave the user with nothing to click and the
 * CLI waiting on a verdict that can never come.
 */
export const INTERACTIVE_TOOLS = ['AskUserQuestion'];

/** Presentation category a Feed tool block is stamped with (review P1 #9). */
export type ToolCategory = 'shell' | 'edit' | 'read' | 'other';

export function toolCategory(name: string): ToolCategory {
  if (SHELLISH.includes(name)) return 'shell';
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit';
  if (READ_TOOLS.includes(name)) return 'read';
  return 'other';
}
