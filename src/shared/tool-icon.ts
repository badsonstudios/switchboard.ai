// Which small picture goes beside a tool's name in the conversation (#757).
//
// The owner: "an icon for an agent, an icon for an ask-question, an icon for
// read, an icon for a bash or PowerShell command. Everything has its own little
// icon after the text, so it's easy to spot — just look at the icon and know
// what you are doing."
//
// A SECOND, FINER CLASSIFICATION, beside `toolCategory` and not instead of it.
// `ToolCategory` (shell | edit | read | other) is stamped on every block and
// decides which RENDERER draws it; widening it would change dispatch for the
// sake of a picture. This one only picks the picture, and it is decided here,
// from the raw name, for the same reason `tool-taxonomy.ts` exists: tool names
// are platform- and version-volatile (PowerShell on Windows is that file's own
// cautionary tale), so they are classified in ONE place and never sprinkled
// through the renderer.
//
// THERE IS ALWAYS A PICTURE. An unknown tool gets `other`, never nothing: a
// tool row with no icon among rows that have one would read as "not a tool".
import { ASK_USER_QUESTION_TOOL } from './ask-user-question';
import { READ_TOOLS, SHELLISH } from './tool-taxonomy';

export const TOOL_ICONS = [
  'agent',
  'question',
  'read',
  'search',
  'shell',
  'edit',
  'todos',
  'web',
  'mcp',
  'other',
] as const;

export type ToolIconKind = (typeof TOOL_ICONS)[number];

/** a subagent: `Task` is the long-standing name, `Agent` the newer one */
const AGENT_TOOLS = ['Task', 'Agent'];
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
/** looking for something, as opposed to opening a file you already named */
const SEARCH_TOOLS = ['Glob', 'Grep', 'LS', 'ToolSearch'];
/** the checklist, under its old names and the newer per-task ones */
const TODO_TOOLS = ['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
/** tools that watch or stop a command already running in the background:
 *  the same kind of step as running one (found in review; three of these are
 *  in this repo's own captured transcript) */
const BACKGROUND_SHELL_TOOLS = ['BashOutput', 'KillShell', 'Monitor', 'TaskOutput', 'TaskStop'];
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

/**
 * The icon for a tool, by its raw name.
 *
 * ORDER MATTERS in one place: `Glob`, `Grep` and `LS` are in `READ_TOOLS` (they
 * are read-only for the permission gate) and are `search` here, so the search
 * test runs first. An MCP tool is recognised by the `mcp__` prefix the CLI
 * gives every one of them, whatever server it came from.
 */
export function toolIconFor(name: string | undefined | null): ToolIconKind {
  if (!name) return 'other';
  if (AGENT_TOOLS.includes(name)) return 'agent';
  if (name === ASK_USER_QUESTION_TOOL) return 'question';
  if (SHELLISH.includes(name) || BACKGROUND_SHELL_TOOLS.includes(name)) return 'shell';
  if (EDIT_TOOLS.includes(name)) return 'edit';
  if (SEARCH_TOOLS.includes(name)) return 'search';
  if (READ_TOOLS.includes(name) || name === 'NotebookRead') return 'read';
  if (TODO_TOOLS.includes(name)) return 'todos';
  if (WEB_TOOLS.includes(name)) return 'web';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}
