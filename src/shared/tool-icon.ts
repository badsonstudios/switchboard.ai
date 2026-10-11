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
  // #1207: finer kinds, for the gutter
  'write',
  'notebook',
  'explore',
  'git',
  'node',
  'python',
  'powershell',
  'container',
] as const;

export type ToolIconKind = (typeof TOOL_ICONS)[number];

/** a subagent: `Task` is the long-standing name, `Agent` the newer one */
const AGENT_TOOLS = ['Task', 'Agent'];
const EDIT_TOOLS = ['Edit', 'MultiEdit'];
/** a whole new file, as against a change to one */
const WRITE_TOOLS = ['Write'];
const NOTEBOOK_TOOLS = ['NotebookEdit', 'NotebookRead'];
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
  if (WRITE_TOOLS.includes(name)) return 'write';
  if (NOTEBOOK_TOOLS.includes(name)) return 'notebook';
  if (SEARCH_TOOLS.includes(name)) return 'search';
  if (READ_TOOLS.includes(name)) return 'read';
  if (TODO_TOOLS.includes(name)) return 'todos';
  if (WEB_TOOLS.includes(name)) return 'web';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

// ── THE GUTTER, AND WHAT A COMMAND IS RUNNING (#1207) ───────────────────────
//
// #757 put the picture after the tool's name, inside the box. The owner then
// approved a mock that moves it: the picture REPLACES the grey dot in the
// timeline gutter, and the box goes back to name and subject. So the column
// you already scan to find where things happened now says what kind of thing
// each one was.
//
// That asks one more question than `toolIconFor` answers, because the gutter
// belongs to a BLOCK and not to a tool name: a checklist is a block with no
// tool on it, a folded run is no block at all, and a shell command can say
// more than "shell" by what it runs.

/** What the gutter needs to know about a block. Structural, so the renderer's
 *  block type and a test's plain object both fit. */
export interface GutterBlock {
  kind: string;
  tool?: { name: string; category?: string; summary?: string };
}

/**
 * The first word of a command says what it is running. DATA, NOT A PARSER:
 * one lookup on the first token, no shell grammar. `a && b` is whatever `a`
 * is, and that is fine. Adding a program is one line.
 */
const COMMAND_ICONS: Readonly<Record<string, ToolIconKind>> = {
  git: 'git',
  gh: 'git',
  npm: 'node',
  npx: 'node',
  node: 'node',
  pnpm: 'node',
  yarn: 'node',
  bun: 'node',
  python: 'python',
  python3: 'python',
  py: 'python',
  pip: 'python',
  pip3: 'python',
  uv: 'python',
  powershell: 'powershell',
  pwsh: 'powershell',
  docker: 'container',
  podman: 'container',
};

/** ...and, failing that, what kind of script it is handed */
const SCRIPT_ICONS: ReadonlyArray<[RegExp, ToolIconKind]> = [
  [/\.ps1$/i, 'powershell'],
  [/\.py$/i, 'python'],
  [/\.(?:js|mjs|cjs|ts)$/i, 'node'],
];

/**
 * What a command line is running, or null when nothing here recognises it.
 *
 * Leading `NAME=value` assignments are skipped (they are how a command is
 * given its environment, not what it is). A path is reduced to its last part
 * and an `.exe`, `.cmd` or `.bat` to its name, so `C:\tools\git.exe status`
 * is git and `npm.cmd test` is node.
 *
 * ONE PREFIX IS LOOKED PAST: `cd <somewhere> &&`. It is how the CLI writes a
 * great many of its commands ("cd packages/app && npm test"), and without
 * this most of them would stay plain terminals. It is the only one: `sudo`,
 * `time`, `env`, a subshell and a second `&&` are all left alone, and the
 * answer for those is the terminal, which is never wrong.
 */
export function commandIconFor(command: string | undefined | null): ToolIconKind | null {
  const tokens = (command ?? '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  // `cd <dir> && <the command>`: exactly that shape, one directory, one `&&`
  if (tokens[i] === 'cd' && tokens[i + 2] === '&&') i += 3;
  const first = tokens[i];
  if (!first) return null;
  const bare = first.replace(/^["']|["']$/g, '');
  const name = (bare.split(/[\\/]/).pop() ?? '').replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  if (Object.hasOwn(COMMAND_ICONS, name)) return COMMAND_ICONS[name];
  for (const [ext, kind] of SCRIPT_ICONS) if (ext.test(bare)) return kind;
  return null;
}

/**
 * The picture a block wears in the timeline gutter, or null for the plain dot.
 *
 * NULL IS A REAL ANSWER, and it is the answer for anything unrecognised: a
 * tool this file has never heard of keeps the dot it has always had, never a
 * placeholder shape that would read as "some particular kind of tool".
 */
export function gutterIconFor(b: GutterBlock): ToolIconKind | null {
  if (b.kind === 'todos') return 'todos';
  if (b.kind !== 'tool' || !b.tool) return null;
  const kind = toolIconFor(b.tool.name);
  if (kind === 'other') return null;
  // only something that RUNS a command line has one to read: `BashOutput` and
  // its relatives are shell-family too, and their subject is a task id
  if (kind === 'shell' && SHELLISH.includes(b.tool.name)) {
    return (
      commandIconFor(b.tool.summary) ?? (b.tool.name === 'PowerShell' ? 'powershell' : 'shell')
    );
  }
  return kind;
}
