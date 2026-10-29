// Reading the MCP config the `claude` CLI owns (§5.17, #632).
//
// CLAUDE'S, AND ONLY CLAUDE'S (#1288). This lived in `main/mcp/config.ts` until E40
// item 05 moved it behind the Claude provider: it is reached only through the
// `mcpManager` capability (`claude-surfaces.ts`), so an AI with no MCP list
// never has `~/.claude.json` read or `claude mcp` run on its behalf.
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
// The CLI still owns every WRITE (`main/providers/claude-mcp-cli.ts`) and the one fact no file
// holds — whether a server is actually connected (`main/providers/claude-mcp-health.ts`).
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
import { redactUrl } from '../mcp/redact-url';
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
 * The approval keys a Claude Code SETTINGS file may carry (#1500).
 *
 * The same two lists as a `~/.claude.json` project entry, plus the blanket
 * `enableAllProjectMcpServers`. Read from the settings schema in the PATH
 * binary (2.1.312): "List of approved MCP servers from .mcp.json", "Whether to
 * automatically approve all MCP servers in the project".
 */
interface ApprovalSettings {
  enabledMcpjsonServers?: unknown;
  disabledMcpjsonServers?: unknown;
  enableAllProjectMcpServers?: unknown;
}

/**
 * The settings files whose approval keys count, already parsed (#1500).
 *
 * `user` is `~/.claude/settings.json`, `local` the folder's
 * `.claude/settings.local.json`, `project` the folder's committed
 * `.claude/settings.json`. Each is `{}` when absent or unreadable.
 */
export interface ApprovalSources {
  user?: unknown;
  local?: unknown;
  project?: unknown;
  /** the folder IS the home directory, where project settings = user settings */
  projectIsHome?: boolean;
}

/**
 * The approval state of one PROJECT-scope server — THE CLI'S RULE (#1500).
 *
 * Read from the PATH binary (2.1.312, `yht` / `ODn`), not guessed:
 *
 *   1. **Rejected wins.** A name in `disabledMcpjsonServers` in the MERGED
 *      settings — every source, the committed project file included — is
 *      rejected. Also in a legacy `~/.claude.json` project entry.
 *   2. **Approved** if `enabledMcpjsonServers` names it, or
 *      `enableAllProjectMcpServers` is true, in the USER or LOCAL settings — or
 *      in the legacy `~/.claude.json` lists, which the CLI migrates into
 *      `settings.local.json` at startup.
 *   3. **The committed `.claude/settings.json` cannot approve.** The CLI skips
 *      `projectSettings` here unless the folder is the home directory (where
 *      the two files are the same file): a repo must not be able to approve
 *      the servers it brings. Its rejections still count, per (1).
 *   4. Otherwise pending.
 *
 * THE BUG THIS FIXES: only the `~/.claude.json` lists were read. The CLI's own
 * approval prompt writes to `.claude/settings.local.json` and migrates the old
 * lists there, so every server approved by a current CLI read as "waiting for
 * your approval" here — Dan's `ado`, approved in Ashenfall's
 * `settings.local.json`, with 34 tools live beside the label.
 *
 * NOT MODELLED, on purpose: the CLI also gates `settings.local.json` when it is
 * tracked by git in an untrusted workspace, and reads managed/flag settings.
 * Those decide the CLI's own prompt; for a live session the reported status
 * beats this guess anyway (`runtimeStatus` in `McpManagerDialog.tsx`).
 */
function approvalOf(name: string, entries: ProjectEntry[], sources: ApprovalSources): McpApproval {
  const settings = (v: unknown): ApprovalSettings => (isRecord(v) ? v : {});
  const user = settings(sources.user);
  const local = settings(sources.local);
  const project = settings(sources.project);
  const lists = (key: 'enabledMcpjsonServers' | 'disabledMcpjsonServers', from: ApprovalSettings[]) =>
    from.some((s) => stringList(s[key]).includes(name));

  if (
    lists('disabledMcpjsonServers', [user, local, project]) ||
    entries.some((e) => stringList(e.disabledMcpjsonServers).includes(name))
  ) {
    return 'disabled';
  }

  const approving = sources.projectIsHome ? [user, local, project] : [user, local];
  if (
    approving.some((s) => s.enableAllProjectMcpServers === true) ||
    lists('enabledMcpjsonServers', approving) ||
    entries.some((e) => stringList(e.enabledMcpjsonServers).includes(name))
  ) {
    return 'approved';
  }
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

/** Where the user's Claude Code settings live (#1500). */
export function userSettingsPath(home = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json');
}

/** Where a folder's Claude Code settings live: committed, and local (#1500). */
export function projectSettingsPaths(folder: string): { project: string; local: string } {
  return {
    project: path.join(folder, '.claude', 'settings.json'),
    local: path.join(folder, '.claude', 'settings.local.json'),
  };
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
  /** the settings files whose approval keys count (#1500); absent = none */
  approvals?: ApprovalSources;
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
      approvalOf(name, entries, opts.approvals ?? {})
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
    // A byte-order mark (Notepad writes one) is not JSON, and would read a
    // working settings file as broken.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
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

  // The settings files only feed APPROVAL (#1500). One that will not parse is
  // logged and read as empty, not listed as unreadable: it holds no servers,
  // and the CLI reports its own settings errors where the user will see them.
  const settings = (file: string): unknown => {
    const r = readJson(file);
    if (!r.ok && !r.missing) log?.warn('claude settings could not be parsed', { file });
    return r.ok ? r.value : {};
  };
  const own = projectSettingsPaths(folder);

  return buildInventory({
    folder,
    claudeJson: home.ok ? home.value : {},
    mcpJson: project.ok ? project.value : {},
    unreadable,
    approvals: {
      user: settings(userSettingsPath()),
      local: settings(own.local),
      project: settings(own.project),
      projectIsHome: samePath(folder, os.homedir(), process.platform),
    },
  });
}
