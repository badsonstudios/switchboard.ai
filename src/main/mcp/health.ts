// Is the CLI actually talking to these servers? (§5.17, #632)
//
// THE ONE FACT NO CONFIG FILE HOLDS, and therefore the only thing in the MCP
// manager worth shelling out for. `main/mcp/config.ts` reads the definitions;
// this asks the CLI what became of them.
//
// WHY IT IS PARSED OUT OF HUMAN TEXT. Because there is no other way:
// `claude mcp list --json` DOES NOT EXIST (probed 2026-08-25 — `mcp list` and
// `mcp get` take no options beyond `-h`). `--json` exists on `claude plugin`,
// not here. Parsing a human-readable CLI surface is a contract we do not own
// and cannot pin, so EVERY failure mode in this file degrades to `unknown`
// rather than to a claim: an unparsed line, a changed glyph, a non-zero exit, a
// timeout. §4 — our blind spot must never render as a fault in the user's setup.
//
// THE REAL OUTPUT, captured from the CLI on PATH 2026-08-25 (a server was
// registered, connected, broken and removed to get each line):
//
//     Checking MCP server health…
//
//     selftest: claude mcp serve - ✔ Connected
//     broken: no-such-binary-xyz --flag - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed
//     probe-a: node fake-server.js - ⏸ Pending approval (run `claude` to approve)
//
// ...and, with nothing registered:
//
//     No MCP servers configured. Use `claude mcp add` to add a server.
import { execFile } from 'child_process';
import type { McpHealth } from '../../shared/mcp';

/**
 * How long the CLI gets before we stop waiting.
 *
 * A health check CONNECTS TO EVERY SERVER — a remote endpoint behind a VPN that
 * is off does not fail fast, it hangs. This is not a correctness bound, it is a
 * promise that the manager stays usable: the pane has already drawn the
 * inventory from the config files by the time this runs, so a timeout costs the
 * status column and nothing else.
 */
export const HEALTH_TIMEOUT_MS = 20_000;

/**
 * One line of `claude mcp list` -> a name and a state.
 *
 * `null` for anything that is not a server line: the `Checking MCP server
 * health…` header, blank lines, the `No MCP servers configured.` notice, and
 * whatever the CLI adds next. Recognising a line we do not understand as a
 * server would be worse than ignoring it.
 *
 * SPLIT ON THE FIRST COLON, not on the last and not on a greedy match: the
 * remainder routinely contains more colons — a URL (`https://mcp.sentry.dev`),
 * a Windows path (`C:\tools\x.exe`), and the error tail
 * (`CONNECTION_CLOSED: Connection closed`) all do.
 *
 * CLASSIFIED BY GLYPH FIRST, then by word. The glyphs (✔ ✘ ⏸) are what the CLI
 * prints; the word fallback exists because this output crosses a Windows
 * console-encoding boundary, and a mangled glyph must not turn every server on
 * screen into `unknown` when the English word beside it is still perfectly
 * readable. Neither is a contract — hence the `unknown` default.
 */
export function parseHealthLine(line: string): { name: string; health: McpHealth } | null {
  const at = line.indexOf(':');
  if (at <= 0) return null;
  const name = line.slice(0, at).trim();
  const rest = line.slice(at + 1);
  if (!name || name.includes(' ')) return null; // a sentence, not a server name
  if (!rest.trim()) return null;
  // ...AND IT HAS TO LOOK LIKE A SERVER LINE. Every real one is
  // `<name>: <target> - <status>`; the ` - ` is the structural signal that this
  // is a row and not prose. Without it `Note: something happened` — a notice a
  // future CLI could easily add — parses as a server called "Note".
  //
  // That would be bounded rather than fatal (the pane MERGES this map onto the
  // servers it read from config, so a phantom name matches nothing and shows
  // nowhere), which is exactly why it is worth refusing here instead of relying
  // on the merge to hide it. A line we cannot recognise contributes no entry,
  // and a server with no entry renders `unknown` — the same honest answer,
  // reached without inventing a row.
  if (!rest.includes(' - ')) return null;

  const has = (glyph: string, word: RegExp): boolean => rest.includes(glyph) || word.test(rest);
  // ORDER MATTERS: "Failed to connect" contains "connect", so the failure test
  // has to run before the success one or every broken server reads as healthy.
  if (has('✘', /\bfailed\b/i)) return { name, health: 'failed' };
  if (has('⏸', /\bpending approval\b/i)) return { name, health: 'unknown' };
  if (has('✔', /\bconnected\b/i)) return { name, health: 'connected' };
  return { name, health: 'unknown' };
}

/**
 * The whole listing -> a name→state map.
 *
 * A PENDING-APPROVAL server is deliberately `unknown` rather than a state of
 * its own: it is not a health answer at all, it is an approval answer, and the
 * pane already has that from the config files (`McpApproval`, derived from
 * `enabledMcpjsonServers`/`disabledMcpjsonServers`). Two sources for one fact is
 * how two surfaces start disagreeing; the file is the authority because it is
 * the one that cannot time out.
 */
export function parseHealth(stdout: string): Record<string, McpHealth> {
  const states: Record<string, McpHealth> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const hit = parseHealthLine(line);
    if (hit) states[hit.name] = hit.health;
  }
  return states;
}

/** Run `claude mcp list` in a folder and read the health out of it. Answers an
 *  empty map for every failure — see the header. */
export function checkHealth(
  folder: string,
  opts: { bin?: string; timeoutMs?: number } = {}
): Promise<Record<string, McpHealth>> {
  return new Promise((resolve) => {
    execFile(
      opts.bin ?? 'claude',
      ['mcp', 'list'],
      {
        cwd: folder,
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? HEALTH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      // STDOUT IS READ EVEN ON A NON-ZERO EXIT, and that is not sloppiness: the
      // CLI prints the servers it did reach before whatever made it exit
      // non-zero, and a partial answer is strictly better than none for a
      // column that is allowed to say `unknown`. A spawn that produced nothing
      // yields `{}`, which is the same thing said honestly.
      (_err, stdout) => resolve(parseHealth(stdout ?? ''))
    );
  });
}
