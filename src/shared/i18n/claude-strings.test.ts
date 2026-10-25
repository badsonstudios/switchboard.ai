// Which strings may name Claude or Anthropic (#1316).
//
// WHY THIS FILE EXISTS
// --------------------
// E40 made the app host more than one AI, and the words did not follow: the
// Stop button said "Stop Claude" on a Codex card, the status dot said
// "Anthropic: all systems operational" whatever the default AI was, and the
// mode chip described Claude Code's `acceptEdits` to a session that had never
// heard of it. Each was fixed by saying the AI's own name, or a sentence that
// is true of any AI.
//
// What is left below is the ALLOW-LIST: strings that are genuinely about
// Claude, each with its reason. Genuinely about Claude means one of two
// things: it is only ever shown when the AI is Claude, or it is a statement
// about Claude Code itself that stays true whoever reads it. It is a
// list on purpose. A new string that names Claude fails this test until
// somebody adds it here and writes down why it is about Claude, which is
// the decision that went unmade the first time. An entry whose string stops
// naming Claude fails too, so the list never claims more than is true.
//
// If the string is shown for every AI, do not add it: say `{ai}` (the session's
// AI, from the catalog) or write the AI-neutral sentence.
import { describe, it, expect } from 'vitest';
import en from './locales/en.json';

/** Every leaf string in the resource tree, with the dotted key that found it. */
function leaves(node: unknown, path: string[] = []): Array<[string, string]> {
  if (typeof node === 'string') return [[path.join('.'), node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, [...path, k]));
}

const NAMES_CLAUDE = /claude|anthropic/i;

/** key → why this string is about Claude, whoever reads it. */
const ALLOWED: Readonly<Record<string, string>> = {
  // A fact about the fork feature (the `fork` provider capability, which only
  // Claude declares).
  'titlebar.forkHint': 'says forking relies on undocumented Claude Code behaviour, which is true for any reader',
  // The autonomy tooltip's Claude half: added only when the AI is Claude
  // (`autonomyTooltip`'s `claude` argument).
  'autonomy.claude.ask': 'shown only when the AI is Claude',
  'autonomy.claude.plan': 'shown only when the AI is Claude',
  'autonomy.claude.auto-edit': 'shown only when the AI is Claude',
  'autonomy.claude.full-auto': 'shown only when the AI is Claude',
  'autonomy.claude.session': 'shown only when the AI is Claude',
  // Preflight: only Claude declares a `preflight` check (claude-surfaces.ts),
  // so the banner and the fallback version line are only ever Claude's.
  'preflight.missingCli': "Claude's own preflight check; the install command is Claude Code's",
  'preflight.version': "the fallback for Claude's preflight version, before the AIs list arrives",
  // Context meter: `autoCompactAt` is only ever set from Claude's context
  // report; the ACP engine reports null.
  'contextMeter.hoverCompacts': "auto-compact threshold comes from Claude's context report only",
  // Skills: Claude's `commandFiles` capability and its `.claude/skills` layout.
  'feedView.completion.misplacedSkills': "Claude Code's skills folder layout",
  // Cost: the `cli` source is Claude's own transcript figure.
  'usage.costTitleCli': "the `cli` cost source is Claude Code's transcript figure",
  'usage.costTitleCliFloor': "the `cli` cost source is Claude Code's transcript figure",
  // MCP Manager: everything past "unsupported" needs Claude's `mcpManager`
  // capability (an AI without one sees `mcp.unsupported`, which is neutral).
  // In a folder shared with a Claude session the rows ARE Claude Code's
  // config, whichever session opened the dialog, so the words stay true.
  'mcp.healthUnavailable': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.configuredOnly': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.whyConfiguredOnly.not-stream': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.cliNote': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.signInTitle': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.signOutTitle': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.signInStarted': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.signInAlready': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.signInNoUrl': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.signInOpenFailed': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.signedOut': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.signInTimedOut': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.control.notStream': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.readOnlyWhy': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.scope.builtin': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.error.noCli': "MCP Manager writes run `claude mcp`",
  'mcp.error.timeout': "MCP Manager writes run `claude mcp`",
  'mcp.reconnect.restart-required': "MCP Manager rows exist only for Claude's `mcpManager`",
  'mcp.form.error.double-quote': "the add form builds a `claude mcp add` command line",
  'mcp.form.error.looks-like-a-flag': "the add form builds a `claude mcp add` command line",
};

const NAMING = leaves(en).filter(([, v]) => NAMES_CLAUDE.test(v));

describe('only strings about Claude name Claude (#1316)', () => {
  it('finds strings to check at all', () => {
    expect(leaves(en).length).toBeGreaterThan(100);
  });

  it('every string naming Claude or Anthropic is on the allow-list', () => {
    const unlisted = NAMING.map(([k]) => k).filter((k) => !(k in ALLOWED));
    // On failure: say the AI's name with `{ai}`, write a sentence true of any
    // AI, or — only if no other AI can ever see it — add it above with why.
    expect(unlisted).toEqual([]);
  });

  it('every allow-listed key still exists and still names Claude', () => {
    const naming = new Set(NAMING.map(([k]) => k));
    expect(Object.keys(ALLOWED).filter((k) => !naming.has(k))).toEqual([]);
  });

  it('the words #1316 was filed about are AI-neutral or take the AI by name', () => {
    expect(en.feedView.stop).toContain('{ai}');
    expect(en.feedView.workingStrip).toContain('{ai}');
    for (const v of Object.values(en.health.state)) expect(v).toContain('{name}');
    expect(en.health.settingHint).not.toMatch(NAMES_CLAUDE);
    expect(en.settings.providerStatus).not.toMatch(NAMES_CLAUDE);
  });
});
