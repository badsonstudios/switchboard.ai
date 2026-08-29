// The session's REAL MCP inventory, off the `mcp_status` control request (#729).
//
// WHAT THIS FIXES. `config.ts` reads three files and reaches three of the CLI's
// eight runtime scopes. The two blocs that dominate a real machine — claude.ai
// account connectors and plugin-supplied servers — live in NO file, so nothing
// on that path can ever see them: 3 servers shown against 16 the CLI actually
// had, on the machine that reported #723. This module parses the one source
// that has all sixteen.
//
// ── IT ALSO RETIRES A TEXT PARSER ────────────────────────────────────────────
//
// `health.ts` exists because `claude mcp list --json` does not, so connection
// state had to be scraped out of prose and matched on glyphs (`✔`, `✘`, `⏸`).
// `mcp_status` answers `status` as a STRING, per server, structured — so for a
// live session that scraping is dead weight. `health.ts` stays for the SUSPENDED
// card, which has no control channel and no other source; see `merge.ts`.
//
// ── THE MEASUREMENT THAT SHAPES THE WHOLE FILE ───────────────────────────────
//
// The answer SETTLES (`spike/probes/721/probe-mcp-settle.mjs`, 2026-08-29):
//
//     [896ms]  {name:"DeepWiki", status:"pending",   scope:"local"}
//     [5012ms] {name:"DeepWiki", status:"connected", …, serverInfo:{version:"2.14.3"}, tools:[…3]}
//
// so `serverInfo` and `tools` are ABSENT FOR SECONDS on a fresh session, not
// missing. Every field but `name` is therefore optional here, and their absence
// is never read as a fault.
import { redactUrl } from './config';
import type { McpRuntimeScope, McpRuntimeServer, McpRuntimeStatus } from '../../shared/mcp';

/**
 * The runtime scopes the CLI resolved in 2.1.245, spelled as it spells them.
 *
 * A LIST RATHER THAN A CAST, because the point of the type is that we know
 * which ones we have seen. A scope outside this set becomes `unknown` and its
 * server is still shown — the same tolerance `McpTransport` established on the
 * config path.
 */
const RUNTIME_SCOPES: readonly string[] = [
  'local',
  'user',
  'project',
  'enterprise',
  'managed',
  'builtin',
  'dynamic',
  'skills',
];

function scopeOf(raw: unknown): McpRuntimeScope {
  return typeof raw === 'string' && RUNTIME_SCOPES.includes(raw)
    ? (raw as McpRuntimeScope)
    : 'unknown';
}

/**
 * The CLI's status word -> ours.
 *
 * `pending` IS CARRIED THROUGH AS ITSELF and not folded into `unknown`, which
 * is the whole finding: it is a real, five-second-long state on every fresh
 * session, and collapsing it would make the pane say "we do not know" about
 * something the CLI told us plainly.
 *
 * `needs-auth` is mapped speculatively — a claude.ai connector that has not been
 * authorised is the obvious candidate for a fourth word, and this machine has no
 * connector to produce one. UNMEASURED, and it costs nothing to be wrong about:
 * an unrecognised string lands on `unknown`, which is the honest default.
 */
function statusOf(raw: unknown): McpRuntimeStatus {
  switch (raw) {
    case 'connected':
      return 'connected';
    case 'pending':
      return 'pending';
    case 'failed':
      return 'failed';
    // MEASURED (#729 PR 2): this is what the CLI reports after `mcp_toggle`
    // turns a server off. PR 1 folded it into `unknown`, which would have made
    // a server the user had just switched off read as "status unknown" — and
    // the toggle look broken.
    case 'disabled':
      return 'disabled';
    case 'needs-auth':
    case 'needs_auth':
      return 'needs-auth';
    default:
      return 'unknown';
  }
}

/**
 * The endpoint or command — REDACTED on the same terms as the config path.
 *
 * NOT AN OVERSIGHT THAT THIS REDACTS TOO. A runtime row's `config.url` is the
 * same string the config file holds, so `https://user:token@host/mcp` reaches
 * the screen by this route just as readily as by the other one. `redactUrl` is
 * imported rather than reimplemented so the two paths cannot drift into
 * disagreeing about what a secret looks like.
 */
function targetOf(config: Record<string, unknown> | null): string {
  if (!config) return '';
  if (typeof config.command === 'string' && config.command) return config.command;
  if (typeof config.url === 'string' && config.url) return redactUrl(config.url);
  return '';
}

/** Tool NAMES only. The payload's entries carry an `annotations` object we have
 *  no use for, and a shape that claims it invites a surface that half-draws it. */
function toolsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === 'string' && name) out.push(name);
  }
  return out;
}

/**
 * A `mcp_status` payload -> typed rows.
 *
 * LENIENT LIKE `readModels`: a malformed entry is dropped rather than failing
 * the whole list, because one server the CLI describes in a way we do not
 * understand must not blank the other fifteen.
 *
 * `readOnly` is left TRUE here, and `envKeys`/`headerKeys` empty, because none
 * of the three is knowable from this payload — `merge.ts` fills them from the
 * config entry that backs each row. That default is the safe direction: a row we
 * have not proved mutable offers no Remove button, so the failure mode of a
 * merge bug is a missing button rather than a button that deletes the wrong
 * thing.
 */
export function readMcpStatus(response: Record<string, unknown>): McpRuntimeServer[] {
  const raw = response.mcpServers;
  if (!Array.isArray(raw)) return [];
  const out: McpRuntimeServer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || !e.name) continue;
    const config =
      e.config && typeof e.config === 'object' ? (e.config as Record<string, unknown>) : null;
    const info =
      e.serverInfo && typeof e.serverInfo === 'object'
        ? (e.serverInfo as Record<string, unknown>)
        : null;
    const version = info && typeof info.version === 'string' ? info.version : undefined;
    out.push({
      name: e.name,
      scope: scopeOf(e.scope),
      status: statusOf(e.status),
      target: targetOf(config),
      ...(version ? { version } : {}),
      tools: toolsOf(e.tools),
      readOnly: true,
      envKeys: [],
      headerKeys: [],
    });
  }
  return out;
}
