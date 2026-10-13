// What a tool call is, for the purpose of FOLDING a run of them (#1271).
//
// The Feed folds a burst of alike calls into one row. Two kinds were enough
// while "alike" meant a category: looking around (#1130) and running commands
// (#1200). The owner then had twenty Atlassian calls in a row, each its own
// box, because every MCP tool is `other` and `other` never folds.
//
// "Alike" for the three kinds this file serves needs a fact the category does
// not carry: WHICH server an MCP call went to, and what a web call asked for.
// Both are read here, from the raw name and the call's own input, for the
// reason `tool-taxonomy.ts` exists: tool names are classified in one place and
// never at the point of use. Main stamps the answer on the block; the renderer
// only compares what it was given.
//
// NOTHING HERE IS A JUDGEMENT ABOUT WHAT A CALL DOES. Whether an MCP tool reads
// or writes is not knowable from its name, and is not guessed (#1271, rule 4:
// the CLI's `mcp_status` reports a server's own read-only hint with the default
// already applied, so "said nothing" and "changes things" arrive identical).
// The safeguard is on the closed row, which names every tool that was called.

/** An MCP call: which server, and which of its tools. */
export interface McpCall {
  /** the server's name exactly as the CLI spells it in the tool name */
  server: string;
  /** the tool's own name, without the `mcp__<server>__` in front */
  tool: string;
}

/** what the CLI puts in front of every MCP tool's name */
export const MCP_PREFIX = 'mcp__';

/** the two tools that go out to the web */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/**
 * The two built-in tools that read an MCP server's RESOURCES. They are MCP
 * calls by another name: each says which server in its input.
 */
export const MCP_RESOURCE_TOOLS = ['ListMcpResourcesTool', 'ReadMcpResourceTool'];

/**
 * The server and tool of an MCP call, or null for anything else.
 *
 * `mcp__<server>__<tool>`: the CLI's own spelling, and the split is at the
 * FIRST double underscore after the prefix. A server's name can hold single
 * underscores (`plugin_atlassian_atlassian`, `claude_ai_Claude_Docs`) and a
 * tool's can hold double ones, so the first is the only safe place to cut.
 *
 * A resource tool with no `server` in its input lists every server at once,
 * and belongs to none of them: null.
 */
export function mcpCall(name: string, input?: Record<string, unknown>): McpCall | null {
  if (name.startsWith(MCP_PREFIX)) {
    const rest = name.slice(MCP_PREFIX.length);
    const cut = rest.indexOf('__');
    if (cut <= 0 || cut + 2 >= rest.length) return null;
    return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
  }
  if (MCP_RESOURCE_TOOLS.includes(name)) {
    const server = input?.server;
    if (typeof server !== 'string' || server === '') return null;
    return { server: mcpServerInToolName(server), tool: name };
  }
  return null;
}

/**
 * A server's CONFIGURED name, spelled the way the CLI spells it inside a tool
 * name.
 *
 * They are not the same string. A plugin's server is configured as
 * `plugin:atlassian:atlassian` and its tools are named
 * `mcp__plugin_atlassian_atlassian__…`; a resource tool is handed the first
 * and every other call carries the second. Compared as they come, a resource
 * read in the middle of twenty Atlassian calls would split the run in two
 * and belong to neither half. Found in review.
 *
 * THE RULE IS THE CLI'S OWN, read from the binary on PATH (2.1.288): every
 * character outside `a-zA-Z0-9_-` becomes `_`, and for a `claude.ai `
 * connector runs of `_` are then collapsed and trimmed. NOT MEASURED: that a
 * resource tool's `server` input is the configured name (the desktop has no
 * such call to look at). If it is already the tool-name spelling, this
 * changes nothing: that spelling is a fixed point of the rule.
 */
export function mcpServerInToolName(configured: string): string {
  const plain = configured.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!configured.startsWith('claude.ai ')) return plain;
  return plain.replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/**
 * A server's name, as a person would write it: "Atlassian", not
 * `plugin_atlassian_atlassian`.
 *
 * Three spellings are undone, each one the CLI's own way of building the name:
 *
 *  - `plugin_<plugin>_<server>`: a server that came with a plugin. The usual
 *    case is a plugin with one server named after itself, which would read
 *    "Atlassian Atlassian", so a name that is the same word twice is said once.
 *  - `claude_ai_<Name>`: a connector from the claude.ai account.
 *  - underscores and hyphens, which stand in for spaces.
 *
 * A word that is entirely lower case gets a capital; one with any capital of
 * its own (`GitHub`, `DeepWiki`) is left exactly as its author wrote it.
 *
 * A LABEL, NEVER A KEY: two servers may read the same, and runs are compared
 * on the raw name.
 */
export function mcpServerLabel(server: string): string {
  let s = server;
  const plugin = s.startsWith('plugin_');
  if (plugin) s = s.slice('plugin_'.length);
  else if (s.startsWith('claude_ai_')) s = s.slice('claude_ai_'.length);
  let words = s.split(/[_\-\s]+/).filter(Boolean);
  if (words.length === 0) return server;
  // `atlassian_atlassian`, `foo_bar_foo_bar`: the plugin and its one server.
  // ONLY for a plugin's server: one a person named `go_go` reads "Go Go".
  const half = words.length / 2;
  if (
    plugin &&
    Number.isInteger(half) &&
    words.slice(0, half).join(' ') === words.slice(half).join(' ')
  ) {
    words = words.slice(0, half);
  }
  return words
    .map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** A web call: a search, with what was searched for; or a page, with its site. */
export type WebCall = { kind: 'search'; query: string } | { kind: 'page'; host: string };

/**
 * What a `WebSearch` or `WebFetch` asked for, or null for anything else.
 *
 * The site and not the address for a page: the closed row has room to say
 * WHERE a burst of fetches went, and a query string is as likely as anything
 * in an address to be long, or to be something nobody wanted on a caption.
 */
export function webCall(name: string, input?: Record<string, unknown>): WebCall | null {
  if (!WEB_TOOLS.includes(name)) return null;
  if (name === 'WebSearch') {
    return { kind: 'search', query: typeof input?.query === 'string' ? input.query.trim() : '' };
  }
  return { kind: 'page', host: hostOf(input?.url) };
}

/** the site an address names; '' for one that is not an address */
function hostOf(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Tools that only LOOK, beyond the four the approval gate calls read-only.
 *
 * Its own list on purpose: `READ_TOOLS` in `tool-taxonomy.ts` also decides
 * what the hold policy lets through, and a tool does not become ungated by
 * being folded.
 */
export const FOLD_LOOKUP_TOOLS = ['LSP'];
