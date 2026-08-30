// Reading the MCP config the `claude` CLI owns (§5.17, #632).
//
// §5.17 IN ONE LINE: "read the real config files; mutate via the real CLI".
// This is the read half, and it is a pure function of two parsed JSON blobs —
// no `fs` below the entry point, no CLI, no clock — so the whole scope-
// resolution model is unit-tested on fixtures.
//
// WHY FILES AND NOT `claude mcp list --json`. The ticket said to use it.
// **IT DOES NOT EXIST** (probed 2026-08-25 against the CLI on PATH): `mcp list`
// and `mcp get` accept no options at all beyond `-h`, and emit human-readable
// text with emoji in it. `--json` DOES exist on `claude plugin` (DESIGN §5.18),
// which is almost certainly where the ticket's assumption came from. DESIGN
// §5.17 said "read the real config files" all along, so the design was right
// and the ticket had drifted. Do not re-derive this; re-probe if the CLI moves.
//
// The CLI still owns every WRITE (`main/mcp/cli.ts`) and the one fact no file
// holds — whether a server is actually connected (`main/mcp/health.ts`).
//
// ── WHAT THESE FILES CANNOT TELL YOU (#723, 2026-08-28) ──────────────────────
//
// The inventory below is a strict SUBSET of what the CLI resolves at run time,
// and the gap is large enough to read as a bug: a machine with account
// connectors and plugins showed 3 servers here against 16 in the CLI's own
// `/mcp` picker. The CLI's scope vocabulary in 2.1.245 is `local` · `user` ·
// `project` · `enterprise` · `managed` · `builtin` · `dynamic` · `skills`, plus
// a separate claude.ai connector class. We read three files, so we reach three.
// Connectors and plugin-contributed servers live in NO file at all.
//
// AND `claude mcp list` IS NOT THE WAY OUT. Its own description, read out of
// the PATH binary, is "List CONFIGURED MCP servers" — the same surface this
// file already reads, so shelling out for the inventory buys nothing but a text
// parser. The runtime list has exactly one source: the `mcp_status` control
// request, which answers `{name, status, serverInfo, config, scope, tools[]}`
// per server — structured, and strictly richer than anything here. That is
// #721's channel and the intended replacement for this read.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { samePath } from '../project-key';
import type {
  McpApproval,
  McpInventoryWire,
  McpScope,
  McpServerWire,
  McpTransport,
  McpUnreadableWire,
} from '../../shared/mcp';

/**
 * One server as it appears in a config file.
 *
 * Every field optional and `unknown`-typed on the way in: these files are
 * hand-edited by users, checked into repos by other people, and written by a
 * CLI that can grow fields whenever it likes. Nothing here may assume a shape.
 */
interface RawServer {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
}

/** The shape of `~/.claude.json`, to the extent this file cares. */
interface ClaudeJson {
  mcpServers?: unknown;
  projects?: unknown;
}

/** The shape of a repo's `.mcp.json`. */
interface McpJson {
  mcpServers?: unknown;
}

/** A project entry inside `~/.claude.json`'s `projects` map. */
interface ProjectEntry {
  mcpServers?: unknown;
  enabledMcpjsonServers?: unknown;
  disabledMcpjsonServers?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strings out of an unknown list, garbage dropped. Used for `args` and for the
 *  two approval lists, all three of which are user-editable. */
function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The KEYS of an unknown map — never the values. See `McpServerWire.envKeys`
 *  for why this file has no function that returns the values. */
function keysOf(v: unknown): string[] {
  return isRecord(v) ? Object.keys(v) : [];
}

/**
 * The CLI's `type` field, narrowed — and anything else carried through.
 *
 * `unknown` rather than a drop, for the reason `presentStatus` answers `idle`
 * for a status it has never heard of: a transport a newer CLI grew is still a
 * server this session has, and a manager that silently omits it is a manager
 * lying about the inventory. A missing `type` reads as `stdio` because that is
 * what the CLI itself defaults to — `claude mcp add <name> -- <cmd>` with no
 * `--transport` writes a stdio server, and older configs predate the field.
 */
function transportOf(raw: RawServer): McpTransport {
  const t = raw.type;
  if (t === undefined || t === null) return 'stdio';
  if (t === 'stdio' || t === 'http' || t === 'sse') return t;
  return 'unknown';
}

/**
 * The one line a user sees to answer "what IS this server" — a command or a URL.
 *
 * Never a secret: `command`/`url` are the endpoint, while `env` and `headers`
 * are where credentials live and are reduced to their key names before they
 * leave this module.
 */
function targetOf(raw: RawServer): string {
  if (typeof raw.command === 'string' && raw.command) return raw.command;
  if (typeof raw.url === 'string' && raw.url) return redactUrl(raw.url);
  return '';
}

/**
 * A remote endpoint with its credentials taken out.
 *
 * REMOTE MCP SERVERS ROUTINELY CARRY THE SECRET IN THE URL — `https://
 * user:token@host/mcp` and `?api_key=…` are both documented forms — so
 * `raw.url` is a secret-carrying field in exactly the way `env` and `headers`
 * are, and the first version of this file rendered it verbatim onto the screen.
 * Caught in review; the docstring on `McpServerWire` claimed no field could
 * carry a value and was wrong about two of them.
 *
 * What survives is what identifies the server — scheme, host, port, path — and
 * the NAMES of the query parameters, which is the same trade `envKeys` makes.
 * A string that will not parse as a URL is not guessed at: it is reported as
 * unparseable rather than half-redacted, because a partial redaction of an
 * unknown format is how a secret survives in the tail.
 */
export function redactUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '(unreadable address)';
  }
  u.username = '';
  u.password = '';
  for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, '…');
  return u.toString();
}

// `samePath` LIVED HERE and now lives in `main/project-key.ts` (#724).
//
// It was never an MCP concern — `main/index.ts` imported it to gate session
// folders, and `sessions/trust.ts` needed it and did not have it, which is the
// whole of that bug: two readers of `~/.claude.json`'s `projects` map with two
// different keying rules. Re-exported so this module's own callers keep one
// import, and so the drive-letter finding below stays findable from here.
//
// The finding, kept because it is the reason the function is not `===`: a real
// `~/.claude.json` held TWO entries for this repo differing only in the case of
// the drive letter (`c:/Projects/Switchboard.ai` and `C:/Projects/…`), each with
// its own `mcpServers`. A `===` lookup finds whichever the CLI wrote last and
// reports the other scope as empty — which reads on screen as "you have no local
// servers" rather than as the ambiguity it is.
export { samePath };

/**
 * Every `projects` entry whose key names this folder — plural, deliberately.
 *
 * The duplicate-key case above means "the entry" is not always one object. All
 * matches are merged, later keys winning on a name collision, so a server
 * configured under either spelling is listed exactly once. Merging is the only
 * answer that cannot be wrong on screen: picking one entry hides real servers,
 * and listing both twice claims the user has two.
 */
function projectEntries(
  claude: ClaudeJson,
  folder: string,
  platform: NodeJS.Platform
): ProjectEntry[] {
  const projects = claude.projects;
  if (!isRecord(projects)) return [];
  return Object.entries(projects)
    .filter(([key]) => samePath(key, folder, platform))
    .map(([, value]) => (isRecord(value) ? (value as ProjectEntry) : {}));
}

/**
 * The approval state of one PROJECT-scope server.
 *
 * Derived, not stored: the CLI keeps two lists and treats absence from both as
 * "not yet answered". Disabled is checked FIRST because a name in both lists is
 * a corrupt state we did not create, and refusing to connect is the safe
 * reading of it.
 */
function approvalOf(name: string, entries: ProjectEntry[]): McpApproval {
  const inAny = (key: 'enabledMcpjsonServers' | 'disabledMcpjsonServers'): boolean =>
    entries.some((e) => stringList(e[key]).includes(name));
  if (inAny('disabledMcpjsonServers')) return 'disabled';
  if (inAny('enabledMcpjsonServers')) return 'approved';
  return 'pending';
}

/** One `mcpServers` map -> wire rows. The only place a raw config becomes a
 *  shape the renderer is allowed to see, which is what keeps the secret-
 *  stripping in one place rather than at three call sites. */
function rowsFrom(
  servers: unknown,
  scope: McpScope,
  source: string,
  approval: (name: string) => McpApproval
): McpServerWire[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, value]) => {
    const raw = (isRecord(value) ? value : {}) as RawServer;
    return {
      name,
      scope,
      transport: transportOf(raw),
      approval: approval(name),
      target: targetOf(raw),
      args: stringList(raw.args),
      envKeys: keysOf(raw.env),
      headerKeys: keysOf(raw.headers),
      source,
    };
  });
}

/** Where `~/.claude.json` lives. A function, not a constant, so a test can run
 *  against a fake home without monkey-patching `os`. */
export function claudeJsonPath(home = os.homedir()): string {
  return path.join(home, '.claude.json');
}

/** Where a folder's project-scope config lives. */
export function mcpJsonPath(folder: string): string {
  return path.join(folder, '.mcp.json');
}

/**
 * THE PURE CORE: two parsed blobs and a folder -> the inventory.
 *
 * Exported separately from `readInventory` so every rule above — scope
 * resolution, the duplicate-key merge, approval derivation, secret stripping,
 * the tolerant transport — is tested without touching a disk.
 *
 * ORDER IS project, local, user: most specific first, which is the order the
 * CLI resolves them in and therefore the order that reads correctly when two
 * scopes define the same name. Names are NOT deduplicated across scopes on
 * purpose — two scopes defining `github` is a real and confusing situation, and
 * the manager exists to show it rather than to quietly pick a winner.
 */
export function buildInventory(opts: {
  folder: string;
  claudeJson: unknown;
  mcpJson: unknown;
  unreadable?: readonly McpUnreadableWire[];
  /** injected for the reason `samePath` gives — both branches on every runner */
  platform?: NodeJS.Platform;
}): McpInventoryWire {
  const claude = (isRecord(opts.claudeJson) ? opts.claudeJson : {}) as ClaudeJson;
  const project = (isRecord(opts.mcpJson) ? opts.mcpJson : {}) as McpJson;
  const entries = projectEntries(claude, opts.folder, opts.platform ?? process.platform);

  // local scope: every matching project entry's own map, merged (see
  // `projectEntries` — the duplicate-key case is real)
  // SPREAD, NOT `Object.assign`: assign uses `[[Set]]`, so a server literally
  // named `__proto__` would reassign this object's prototype instead of
  // becoming a row — dropped rather than listed, in a file third parties write.
  // Spread uses define semantics and is immune. (Not a pollution vector either
  // way, since the target is a fresh literal; it is a server going missing.)
  let localServers: Record<string, unknown> = {};
  for (const e of entries) {
    if (isRecord(e.mcpServers)) localServers = { ...localServers, ...e.mcpServers };
  }

  const servers = [
    ...rowsFrom(project.mcpServers, 'project', mcpJsonPath(opts.folder), (name) =>
      approvalOf(name, entries)
    ),
    ...rowsFrom(localServers, 'local', claudeJsonPath(), () => 'n/a'),
    ...rowsFrom(claude.mcpServers, 'user', claudeJsonPath(), () => 'n/a'),
  ];

  return { folder: opts.folder, servers, unreadable: opts.unreadable ?? [] };
}

/**
 * Read one JSON file, or say we could not.
 *
 * `undefined` for "not there", which is the ORDINARY case and not a fault — a
 * repo with no `.mcp.json` is most repos — and is why this answers a discriminated
 * result rather than throwing. A file that exists but will not parse IS worth
 * reporting, because the user has a broken config and the pane saying so is
 * more useful than a scope that silently looks empty.
 */
function readJson(file: string): { ok: true; value: unknown } | { ok: false; missing: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, missing: true };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, missing: false };
  }
}

/**
 * The impure edge: hit the disk, then hand the pure core what it found.
 *
 * FAIL-OPEN PER SCOPE (P6). A `.mcp.json` someone checked in with a trailing
 * comma must not blank the user- and local-scope servers that read perfectly
 * well — so an unparseable file contributes an entry in `unreadable` and
 * nothing else, and the pane reports both halves. Only a parse FAILURE counts:
 * a file that is simply absent is not a problem to report.
 *
 * ONE ENTRY PER FILE, not per scope (#714, from #632's review). `~/.claude.json`
 * backs both the local and the user scope, so a single trailing comma in it used
 * to report "this file could not be read" TWICE, in two sections — which reads
 * as two broken files and sends the user hunting for the second one.
 */
export function readInventory(
  folder: string,
  log?: { warn: (msg: string, fields?: Record<string, unknown>) => void }
): McpInventoryWire {
  const unreadable: McpUnreadableWire[] = [];

  const home = readJson(claudeJsonPath());
  if (!home.ok && !home.missing) {
    unreadable.push({ source: claudeJsonPath(), scopes: ['local', 'user'] });
    log?.warn('~/.claude.json could not be parsed', { file: claudeJsonPath() });
  }

  const project = readJson(mcpJsonPath(folder));
  if (!project.ok && !project.missing) {
    unreadable.push({ source: mcpJsonPath(folder), scopes: ['project'] });
    log?.warn('.mcp.json could not be parsed', { file: mcpJsonPath(folder) });
  }

  return buildInventory({
    folder,
    claudeJson: home.ok ? home.value : {},
    mcpJson: project.ok ? project.value : {},
    unreadable,
  });
}
