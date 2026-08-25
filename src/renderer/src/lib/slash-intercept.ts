// Which typed slash commands switchboard answers itself (§5.17, #632).
//
// THE PROBLEM THIS IS THE FIRST HALF OF (#633). A handful of the CLI's slash
// commands — `/mcp`, `/model`, `/permissions`, `/agents`, … — open an
// INTERACTIVE PICKER in the CLI's own TUI. In Terminal mode that is fine: there
// is a terminal, and the picker appears in it. In **Direct mode**, which is how
// every session now starts, there is no terminal for it to appear in, so typing
// one of them is a dead end: the text goes to the CLI, the CLI opens a picker
// nobody can see, and the session sits there.
//
// #632 gives exactly ONE of them somewhere to land — `/mcp` opens the MCP
// Manager. The rest are #633's, and are deliberately NOT listed here: an
// intercept with no surface behind it would be strictly worse than the current
// dead end, because it would swallow the command as well as failing to answer
// it.
//
// P7 AS AMENDED (PHILOSOPHY §6, "the terminal is a transport, not the
// constitution"): a GUI surface that answers the same question the CLI's picker
// answers is legitimate. What is NOT legitimate is faking an interaction the
// CLI kept for itself — which is why this file routes to a pane that reads the
// CLI's own config and shells out to the CLI to mutate, rather than
// reimplementing what `/mcp` does.

/** What the app should do with a submitted composer line. */
export type SlashIntercept =
  /** send it to the session, unchanged — the answer for almost everything */
  | { kind: 'send' }
  /** open the MCP Manager instead, and do NOT send (§5.17) */
  | { kind: 'open-mcp' };

const SEND: SlashIntercept = { kind: 'send' };

/**
 * Does this composer line belong to switchboard rather than to the CLI?
 *
 * STRICT ON PURPOSE. It matches `/mcp` and nothing else that starts with it:
 * `/mcp-foo` is somebody's project command and `/mcp list` carries an argument
 * the CLI's own parser should see. Swallowing either would be us taking a
 * command that was not addressed to us — the exact failure mode that makes an
 * intercept worse than a dead end.
 *
 * Trailing whitespace is tolerated because the composer trims its own text
 * before submitting anyway, and a leading-space variant (` /mcp`) is NOT
 * matched: the CLI does not treat that as a command either, so neither do we.
 *
 * Case-insensitive, because the CLI's own command matching is.
 */
export function interceptSlash(text: string): SlashIntercept {
  return /^\/mcp\s*$/i.test(text) ? { kind: 'open-mcp' } : SEND;
}
