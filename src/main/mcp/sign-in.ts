// What a successful `mcp_authenticate` answer asks the HOST to do (#1420).
//
// THE DIVISION OF LABOUR, and it is the CLI's, not ours. In the stream-json
// transport Claude Code does NOT open a browser for an MCP sign-in. It starts
// the OAuth flow (and runs the callback listener itself), then hands the host
// the address the user must visit. A host that reads `ok: true` and drops the
// payload, as #734 shipped, gives the user a sign-in that silently never
// starts: both of Dan's clicks in #1420 were accepted and nothing opened.
//
// Read off both reference sources, 2026-10-22:
//
//   PATH CLI 2.1.288, the `mcp_authenticate` handler:
//     tt(D,{authUrl:qt,requiresUserAction:!0,callbackExpected:!0,
//           redirectScheme:rt,state:rr,...rt==="localhost"&&{callbackPort:bt}})
//     else tt(D,{requiresUserAction:!1,callbackExpected:!1})
//   and for a claude.ai connector (`claudeai-proxy`) the CLI builds the
//   connector's start-auth address ITSELF and answers
//     {authUrl:Pe,requiresUserAction:!0,callbackExpected:!1}
//
//   VS Code extension 2.1.289, `authenticateMcpServer`:
//     let W=await Q.query.mcpAuthenticate(J);if(W.error)throw Error(W.error);
//     if(W.authUrl)try{await this.openURL(W.authUrl)}catch(G){...}
//
// So the host's whole job is: open `authUrl` if there is one. That is the
// extension's division of labour exactly, and it is host-don't-reimplement:
// the CLI decides and does the flow; we only open the address it handed us.
// The extension builds the claude.ai connector URL itself, but the CLI on PATH
// already does that, so copying it here would reimplement something the CLI
// keeps for itself.
//
// ⚠️ **PRIVACY (Dan, #1420): THE URL IS NEVER LOGGED, AND THE SERVER NAME IS
// NEVER LOGGED.** An auth URL carries an OAuth `state` and client details; the
// app log is a file users attach to bug reports. Log lines carry timestamps, so
// a server name in one would put "who signed in to what, when" in that file.
// Nothing in this module logs; the one caller that does (`ipc.ts`) logs a fixed
// sentence and the session id, and `ipc.test.ts` pins it.
import type { McpSignInOutcome } from '../../shared/mcp';

/** What the success payload asks for. */
export type SignInAnswer =
  | { kind: 'open'; url: string }
  | { kind: 'already-signed-in' }
  | { kind: 'no-url' };

/**
 * An http(s) address, or `null`.
 *
 * The address goes to `shell.openExternal`, which will hand ANY scheme to the
 * OS — `file:`, a custom protocol handler, `javascript:` in some browsers. The
 * CLI is trusted, but the string crossed a pipe from a child process, and the
 * only addresses a sign-in ever needs are web pages.
 */
export function safeAuthUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // THE PARSED FORM, not `raw`: the URL parser strips surrounding whitespace
  // and inner tabs/newlines before it checks anything, so `raw` is not quite
  // the string that was checked. Hand the OS the one that was.
  return parsed.href;
}

/**
 * Read a successful `mcp_authenticate` answer.
 *
 * `requiresUserAction: false` with no URL is the CLI saying the server is
 * already authorised (its `else` branch above). Anything else without a usable
 * URL is `no-url`: the CLI accepted the request but gave us nothing we may
 * open, and the pane says exactly that rather than pretending a browser is
 * coming.
 */
export function readSignInAnswer(response: Record<string, unknown>): SignInAnswer {
  const url = safeAuthUrl(response.authUrl);
  if (url) return { kind: 'open', url };
  if (response.authUrl === undefined && response.requiresUserAction === false) {
    return { kind: 'already-signed-in' };
  }
  return { kind: 'no-url' };
}

/**
 * Carry a sign-in answer out: open the browser if asked, and say what happened.
 *
 * Returns the OUTCOME only. The URL is deliberately not part of it, so it never
 * crosses into the renderer: the pane needs to know whether a browser opened,
 * not where to.
 *
 * `openExternal` rejects when the OS has no handler for the scheme; that is
 * `open-failed`, never a rejection out of here.
 */
export async function carryOutSignIn(
  response: Record<string, unknown>,
  openExternal: (url: string) => Promise<void>
): Promise<McpSignInOutcome> {
  const answer = readSignInAnswer(response);
  if (answer.kind === 'already-signed-in') return 'already-signed-in';
  if (answer.kind === 'no-url') return 'no-url';
  try {
    await openExternal(answer.url);
    return 'opened';
  } catch {
    return 'open-failed';
  }
}
