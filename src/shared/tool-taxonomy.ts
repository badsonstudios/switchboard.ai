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

/** Presentation category a Feed tool block is stamped with (review P1 #9). */
export type ToolCategory = 'shell' | 'edit' | 'read' | 'other';

export function toolCategory(name: string): ToolCategory {
  if (SHELLISH.includes(name)) return 'shell';
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit';
  if (READ_TOOLS.includes(name)) return 'read';
  return 'other';
}
