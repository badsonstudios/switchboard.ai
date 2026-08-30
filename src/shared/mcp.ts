// The MCP Manager's wire shapes (§5.17, #632).
//
// ONE DECLARATION, imported by main, preload and the renderer — the rule #618
// established after `status` and `transport` drifted between hand-written
// copies of `SessionRecord` on the two sides of the IPC boundary. A field added
// here is declared to everyone; a field main keeps to itself does not go here.
//
// WHAT THIS IS NOT: an MCP protocol type. Nothing in switchboard speaks MCP.
// The `claude` CLI owns the connections, the config and the handshake; these
// are the shapes of what we READ OFF ITS CONFIG FILES so a pane can draw them
// (§5.17: "read the real config files; mutate via the real CLI"). If a field
// here cannot be pointed at a byte in `.mcp.json` or `~/.claude.json`, or at a
// line of `claude mcp list`, it does not belong.

/**
 * Where a server is configured, in the CLI's own vocabulary.
 *
 * These are the three values `claude mcp add -s` accepts, spelled exactly as it
 * spells them — so a scope can be handed straight back to `add`/`remove` with
 * no translation table in between. VERIFIED against `claude mcp add --help`
 * 2026-08-25: `(local, user, or project) (default: "local")`.
 *
 *   project  the repo's own `.mcp.json`, checked in and shared with the team.
 *            The only scope with an APPROVAL step (see `McpApproval`).
 *   local    private to you AND to one project — `~/.claude.json` under
 *            `projects[<path>].mcpServers`. The default, and the one most
 *            people end up with without meaning to.
 *   user     yours everywhere — `~/.claude.json`'s TOP-LEVEL `mcpServers`.
 *
 * `local` resolving to the REPO rather than to the cwd is worth knowing and is
 * not ours to change: `claude mcp add -s local` run from a subdirectory of this
 * repo wrote into the entry for the repo root (probed 2026-08-25).
 */
export type McpScope = 'project' | 'local' | 'user';

/**
 * How a server is reached. `stdio` is a child process; the other two are
 * remote. Read off the config's own `type` field, which the CLI writes.
 *
 * TOLERANT ON THE WAY IN (see `readScope`): a `type` we do not recognise — a
 * transport a newer CLI grew — is carried through as `unknown` rather than
 * dropping the server from the list. A server we cannot label is still a
 * server the session has, and hiding it would make the pane lie about the
 * inventory. Same fail-open direction as the rail's `presentStatus`.
 */
export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown';

/**
 * The approval state of a PROJECT-scope server.
 *
 * Only `.mcp.json` servers have one: a repo you cloned can carry a server
 * definition, and the CLI will not connect to it until you say so. It is not a
 * field in any config — it is derived from two LISTS on the project entry,
 * `enabledMcpjsonServers` and `disabledMcpjsonServers`, and the CLI reports the
 * untouched state as `⏸ Pending approval (run \`claude\` to approve)`.
 *
 * `n/a` is what local- and user-scope servers get: they were added by you, on
 * purpose, and there is nothing to approve.
 */
export type McpApproval = 'approved' | 'pending' | 'disabled' | 'n/a';

/**
 * Is the CLI actually talking to this server right now?
 *
 * The one fact NOT in any config file, and therefore the one fact worth
 * shelling out for. It is deliberately a separate call from the listing
 * (`mcp:health`, not a field filled in by `mcp:list`), because a health check
 * CONNECTS TO EVERY SERVER and is slow — seconds, sometimes — and a manager
 * that will not open until every remote endpoint has answered is a manager that
 * hangs when your VPN is off.
 *
 * `unknown` is the honest default and the fail-open answer: before the check
 * lands, when it fails, and when its output cannot be parsed. §4 — our own
 * blind spot must never be reported as a fault in the user's setup.
 */
export type McpHealth = 'connected' | 'failed' | 'unknown';

/** One configured MCP server, as the manager draws it. */
export interface McpServerWire {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  approval: McpApproval;
  /**
   * The executable (stdio) or the endpoint (http/sse).
   *
   * A URL is REDACTED on the way out (`redactUrl`): userinfo dropped, query
   * values replaced by `…`. Remote MCP servers routinely carry the credential
   * in the address — `https://user:token@host/mcp`, `?api_key=…` are both
   * documented forms — so this is a secret-carrying field and was rendered
   * verbatim until review said so.
   */
  target: string;
  /**
   * Stdio arguments, in order; empty for a remote server.
   *
   * **NOT REDACTED, and that is a known limit rather than a decision that it is
   * safe.** `npx -y @some/mcp-server --api-key sk-live-…` is the documented
   * install form for several published servers, and masking it means guessing
   * which of an arbitrary program's flags are secrets — a guess that is wrong
   * in both directions (it hides a `--port` and misses a `--pat`). Left visible
   * on purpose, said out loud in `docs/manual/17-mcp-servers.md`, and revisited
   * with PR 2's add form, which is where switchboard would first have a reason
   * to know which flag is which.
   */
  args: readonly string[];
  /**
   * The NAMES of the environment variables and headers this server carries —
   * never their values (§5.29, and #632's plan call).
   *
   * `claude mcp add -e API_KEY=xxx` and `-H "Authorization: Bearer …"` put live
   * credentials in plaintext in `.mcp.json` and `~/.claude.json`. A pane that
   * lists servers reads those files, so the values would otherwise be one
   * render away from a screen-share, a screenshot and a log line. The names are
   * what a human needs to answer "is this configured?"; the values are what
   * only the CLI needs, and it reads them from disk itself.
   *
   * No field on this shape carries an `env` or `header` VALUE. That is
   * deliberate and is the enforcement: a reveal affordance would have to add
   * one, which is a decision someone has to make on purpose rather than a
   * default that leaked.
   *
   * THE CLAIM IS THAT NARROW ON PURPOSE. It used to read "no field on this
   * shape can carry a secret value", which was false of two of them: `target`
   * (a URL with userinfo or a query token) and `args` (`--api-key sk-live-…`).
   * `target` is redacted now; `args` is a stated limit. See both fields.
   */
  envKeys: readonly string[];
  headerKeys: readonly string[];
  /** the file this definition was read out of — what the pane points at when
   *  it says where a server came from, and what a future "open config" uses */
  source: string;
}

/**
 * One CONFIG FILE that would not parse, and the scopes it takes down with it.
 *
 * KEYED BY FILE, NOT BY SCOPE, and that is the fix for a real complaint from
 * #632's review: `~/.claude.json` backs BOTH the local and the user scope, so a
 * single trailing comma in it used to produce two identical "this file could
 * not be read" lines in two different sections — which reads as two problems
 * and sends the user looking for a second broken file that does not exist.
 *
 * One entry per file says it once, names the file, and still names every scope
 * that went with it.
 */
export interface McpUnreadableWire {
  /** the file that would not parse — what the user has to go and fix */
  source: string;
  /** every scope it backs: `.mcp.json` is `project`; `~/.claude.json` is both
   *  `local` and `user` */
  scopes: readonly McpScope[];
}

/**
 * What `mcp:list` answers: every server a given folder's session has CONFIGURED.
 *
 * NOT every server that session can use (#723). This is resolved from three
 * config files, and the CLI's runtime inventory is strictly larger — claude.ai
 * account connectors and plugin-contributed servers appear in no file at all,
 * so nothing on this wire can carry them. The runtime list has one source, the
 * `mcp_status` control request (#721).
 */
export interface McpInventoryWire {
  /** the folder the scopes were resolved against — echoed back so a stale
   *  answer arriving after the user switched sessions can be discarded */
  folder: string;
  servers: readonly McpServerWire[];
  /**
   * Files that could not be read, with the reason in the log.
   *
   * NOT an error, and never a reason to show nothing: a malformed `.mcp.json`
   * in one repo must not blank the user- and local-scope servers that are
   * perfectly readable (P6). The pane says which file it could not read beside
   * the servers it DID find, which is both halves of the truth.
   */
  unreadable: readonly McpUnreadableWire[];
}

/** What `mcp:health` answers — a name→state map, merged onto the inventory the
 *  pane already drew rather than replacing it. */
export interface McpHealthWire {
  folder: string;
  states: Readonly<Record<string, McpHealth>>;
  /**
   * Did the check itself run? (#714, carried over from #632's review.)
   *
   * WITHOUT THIS THE MAP CANNOT SAY WHICH OF TWO THINGS HAPPENED, because both
   * are an absent key: "the CLI ran and has never heard of that server" and
   * "the CLI could not be found / timed out / printed nothing we understood".
   * The pane rendered `status unknown` for both, which is honest about the
   * server and silent about the far more useful fact that NOTHING was checked.
   *
   * `false` means the spawn produced no usable output at all, and the pane says
   * so once at the bottom of the list instead of stamping every row with a
   * verdict it did not earn. `true` with an absent key still means `unknown`
   * for that one server — which is now a real answer rather than an ambiguity.
   */
  ok: boolean;
}

// ── The RUNTIME inventory (#729) ─────────────────────────────────────────────
//
// Everything above this line describes what the CONFIG FILES hold. Everything
// below describes what the SESSION actually has, which is a strictly larger set
// and comes from one place: the `mcp_status` control request.

/**
 * Where a server comes from, in the CLI's **runtime** vocabulary.
 *
 * NOT `McpScope`, AND THE DIFFERENCE IS LOAD-BEARING. `McpScope` is the write
 * side: three values, spelled the way `claude mcp add -s` spells them, so a
 * scope can be handed straight back to `add`/`remove` with no translation. This
 * is the read side, and the CLI resolves eight — `local`, `user`, `project`,
 * `enterprise`, `managed`, `builtin`, `dynamic`, `skills` — plus a separate
 * claude.ai connector class that is in no file at all.
 *
 * WIDENING `McpScope` TO COVER THESE WOULD BE THE BUG. It would type-check a
 * call that hands `builtin` to `claude mcp remove -s builtin`, which is not a
 * scope that subcommand accepts and not a server we are allowed to delete. The
 * two vocabularies are kept apart so the compiler enforces what is mutable —
 * see `McpRuntimeServer.readOnly`.
 *
 * `unknown` is the tolerance, same direction as `McpTransport`: a scope a newer
 * CLI grows is carried through rather than dropping the server from the list. A
 * server we cannot label is still a server the session has.
 */
export type McpRuntimeScope =
  | McpScope
  | 'enterprise'
  | 'managed'
  | 'builtin'
  | 'dynamic'
  | 'skills'
  | 'unknown';

/**
 * Is the session talking to this server right now — the CLI's own word.
 *
 * `pending` IS NOT A LOADING SPINNER, it is an answer, and it is the one this
 * type exists to make drawable. Measured on a freshly spawned session
 * (`spike/probes/721/probe-mcp-settle.mjs`): `pending` at 0.9s, `connected` at
 * 5.0s, with `serverInfo` and `tools` absent for the whole pending window. A
 * surface that treats it as "not loaded yet" and hides the row will blink every
 * server out of existence for five seconds on every fresh session.
 *
 * `unknown` is ours, not the CLI's: a status string we do not recognise. Fail
 * open (§4) — we do not know is never rendered as a fault in the user's setup.
 */
export type McpRuntimeStatus =
  | 'connected'
  | 'pending'
  | 'failed'
  | 'needs-auth'
  /**
   * Switched off with `mcp_toggle` — and this is a MEASURED value, not a
   * speculative one (#729 PR 2, 2026-08-29): after a toggle, `mcp_status`
   * reported the server as `"disabled"`. It was folded into `unknown` in PR 1,
   * which would have made a server the user had just turned off read as "we do
   * not know" — and left the toggle looking like it had failed.
   */
  | 'disabled'
  | 'unknown';

/** One server the SESSION has, as `mcp_status` reports it. */
export interface McpRuntimeServer {
  name: string;
  scope: McpRuntimeScope;
  status: McpRuntimeStatus;
  /** the endpoint or command, REDACTED by the same `redactUrl` the config path
   *  uses — a runtime row carries a credential in its address just as readily */
  target: string;
  /**
   * How the session reaches this server — and the field decides whether the row
   * offers SIGN IN (#734).
   *
   * ⚠️ **AN ABSENT `config` IS `unknown`, NEVER `stdio`.** This field was here
   * in #729 PR 1, was removed in PR 2 as computed-but-unrendered, and review was
   * right about the second half of its objection: it asserted `stdio` whenever
   * `mcp_status` reported no `config` — which is EXACTLY the claude.ai connector
   * case, the one class of server this field now exists to identify. It comes
   * back with a renderer behind it and that bug fixed.
   *
   * NOT READ THE SAME WAY AS `McpServerWire.transport`, deliberately. That one
   * reads a missing `type` as `stdio` and is right to: it is parsing a file the
   * CLI wrote, where stdio is the documented default of `claude mcp add`. Here
   * there is no such guarantee — an absent `config` is not a default, it is an
   * absence, and the honest word for it is the one `McpTransport` already
   * carries. See `status.ts`'s `transportOf`, which says the same thing from the
   * other side.
   *
   * WHY IT MATTERS: `mcp_authenticate` is refused BY TYPE for a stdio server
   * (`Server type "stdio" does not support OAuth authentication`, measured
   * 2026-08-30), so offering sign-in on a stdio row is offering a button that
   * cannot work. Every other value may legitimately want it.
   */
  transport: McpTransport;
  /** the server's self-reported name and version, once it has connected.
   *  Absent for the whole `pending` window — see `McpRuntimeStatus`. */
  version?: string;
  /**
   * The tool names this server exposes, once connected.
   *
   * NAMES ONLY, and empty until the handshake completes. This is the fact no
   * config file can hold and the reason `mcp_status` is worth the round trip:
   * "which of my sixteen servers is actually giving me tools" is the question
   * the pane could never answer.
   */
  tools: readonly string[];
  /**
   * Can we change this server, or only show it?
   *
   * TRUE MEANS THE ROW MUST NOT OFFER REMOVE. You cannot `claude mcp remove` a
   * claude.ai connector or a plugin's server — they are in no file, so there is
   * nothing for the subcommand to edit. It is set by MATCHING against the config
   * inventory rather than by guessing from the scope: a scope we have never
   * heard of is not mutable, and a `local` row that no file actually declares is
   * not either.
   *
   * VISIBLY read-only, not an inert button (#729's own acceptance criterion) —
   * a button that fails is worse than no button.
   */
  readOnly: boolean;
  /**
   * The scope to hand `claude mcp remove -s`, present exactly when `readOnly`
   * is false.
   *
   * THE CONFIG ENTRY'S SCOPE, NEVER `scope` ABOVE. The two vocabularies do not
   * agree — a row the CLI resolved as `dynamic` may be backed by a `user`-scope
   * definition, and `remove -s dynamic` is not a call that means anything.
   * Carrying the write-side scope explicitly is what stops the renderer
   * inventing one by narrowing a type it should not narrow.
   */
  removeScope?: McpScope;
  /**
   * The env/header KEY NAMES, from the config entry that backs this row.
   *
   * FLOWS THE OTHER WAY. `mcp_status` has no field for either, and "is my API
   * key configured?" is answerable only from the file — so a runtime row that no
   * file declares has empty lists here and that is the truth, not a gap. Values
   * never travel; see `McpServerWire.envKeys` for the whole argument.
   */
  envKeys: readonly string[];
  headerKeys: readonly string[];
  /**
   * The approval state, for a row a `.mcp.json` declares — absent otherwise.
   *
   * ALSO FROM THE FILE ONLY. It is not a field `mcp_status` reports and not a
   * field in any config either: it is derived from two LISTS on the project
   * entry. Carrying it across is what keeps "waiting for your approval" — and
   * the rule that approval BEATS connection state, because an unapproved server
   * reported as "not connected" describes the symptom instead of the cause —
   * alive on the runtime path.
   */
  approval?: McpApproval;
}

/**
 * What `mcp:status` answers: the servers the session really has.
 *
 * ECHOES THE SESSION ID for the same reason `McpInventoryWire` echoes the
 * folder — a slow answer for the session the user has already left must not
 * paint the one they are looking at now.
 */
export interface McpStatusWire {
  sessionId: string;
  servers: readonly McpRuntimeServer[];
  /**
   * Config-file servers this session has NOT loaded.
   *
   * ⚠️ **`mcp_status` IS FROZEN AT SESSION START** — measured
   * (`spike/probes/721/probe-mcp-add-live.mjs`): a server added with `claude mcp
   * add` while a session ran never appeared in its `mcp_status`, and one removed
   * never disappeared. The CLI resolves its MCP set once, at spawn.
   *
   * WITHOUT THIS FIELD THE ADD BUTTON IS BROKEN. `mcp:add` would succeed, the
   * pane would re-ask, the same rows would come back, and the user would read
   * "Added github." over a list that did not change. Remove is worse: the row
   * stays, and — its config entry now gone — silently turns read-only.
   *
   * These are drawn under their own heading with the ordinary config rendering,
   * which is where Reconnect earns its place.
   */
  notLoaded: readonly McpServerWire[];
  /**
   * Why there are no servers, when there are none.
   *
   * THE WHOLE POINT OF THE SHAPE. An empty list means four different things and
   * the pane has to say which: the session answered and genuinely has none
   * (`ok`), this session has no control channel at all (`not-stream` — a PTY),
   * there is no live session behind the card (`no-session`), or the CLI did not
   * answer (`unavailable`). #723 shipped because "no servers configured" was
   * rendered for a case that meant "we cannot see them", and this field is what
   * stops that recurring on the new path.
   */
  reason: 'ok' | 'no-session' | 'not-stream' | 'unavailable';
}

/** One `KEY=value` / `Header: value` pair as the add form collects it.
 *
 *  A LIST OF PAIRS, NOT A RECORD, and deliberately: a record loses the order
 *  the user typed them in, silently drops a duplicate key (a form can produce
 *  one, and swallowing it is how a user ends up with a credential they think
 *  they set), and has the `__proto__` problem `config.ts` already documents. */
export interface McpKeyValue {
  key: string;
  value: string;
}

/**
 * What the add form asks for — the shape `claude mcp add` is built from.
 *
 * THE VALUES IN `env` AND `headers` ARE SECRETS BY CONSTRUCTION, and this is
 * the one shape in the family that carries them. They travel renderer → main
 * → the CLI's own config file and NEVER come back: `McpServerWire` has
 * `envKeys`/`headerKeys` and no field that can hold a value, which is what
 * makes the round trip one-way by type rather than by discipline.
 *
 * That one-way trip is also what makes `args` tractable at last (#632 left it
 * as a stated limit). The old advice — "keep keys in environment variables" —
 * was true and useless, because switchboard had nowhere to type one. Now it
 * does, so the form can say *put it here instead* at the moment the user is
 * deciding, rather than the manual apologising afterwards for a key on screen.
 */
export interface McpAddRequest {
  name: string;
  scope: McpScope;
  /** `unknown` is a READ-side tolerance (see `McpTransport`) and is not
   *  something we can ask the CLI to create, so the write side is narrower. */
  transport: 'stdio' | 'http' | 'sse';
  /** the executable for `stdio`, the endpoint URL for `http`/`sse` */
  target: string;
  /** arguments for the child process — `stdio` only, passed after the CLI's
   *  own `--` so a leading `-` is the child's flag and not the CLI's */
  args?: readonly string[];
  /** `stdio` only */
  env?: readonly McpKeyValue[];
  /** `http`/`sse` only */
  headers?: readonly McpKeyValue[];
}

/** Which part of a request we refused, so the form can point at the right box
 *  rather than showing one banner for six different mistakes. */
export interface McpFieldError {
  field: 'name' | 'scope' | 'transport' | 'target' | 'args' | 'env' | 'headers';
  /**
   * `double-quote` is the one that needs explaining, and it is a real platform
   * limit rather than fussiness. On Windows the CLI is a `.cmd` shim, so its
   * arguments are parsed twice — once by `cmd.exe` and once by the CLI — and
   * the two disagree about how an embedded quote is spelled. `\"` is what the
   * CLI wants and is a command-injection hole in cmd.exe (measured); `""` is
   * inert in cmd.exe and arrives at the CLI merged with the following argument
   * (also measured). No spelling satisfies both, so the argument is refused
   * rather than delivered as something other than what was typed.
   * `main/transport/win-cmd.ts` carries the measurements.
   */
  code:
    | 'required'
    | 'format'
    | 'control-character'
    | 'double-quote'
    | 'looks-like-a-flag'
    | 'too-long';
  /** the offending key/index, when there is a list to point into */
  at?: string;
}

/**
 * What every mutation channel answers.
 *
 * RESOLVES, NEVER REJECTS — the house shape of the whole family (see
 * `main/mcp/ipc.ts`'s header). A dialog whose button throws behind it is a
 * button that does nothing and says nothing.
 *
 * The failures are split by WHOSE fault they are, because the sentence the user
 * needs is different in each case: `invalid` is theirs and is fixable in the
 * form, `no-cli` is the install, `cli-failed` is the CLI's own opinion (and
 * `detail` carries its exact words — "MCP server x already exists in
 * .mcp.json" is a better message than anything we would write), `refused` is
 * ours and means the request never left main.
 */
export type McpMutationResult =
  | { ok: true }
  | { ok: false; reason: 'invalid'; error: McpFieldError }
  | { ok: false; reason: 'refused' }
  | { ok: false; reason: 'no-cli' }
  | { ok: false; reason: 'timeout' }
  | { ok: false; reason: 'cli-failed'; detail: string };

/**
 * What "reconnect" did — and the reason it is a RESULT rather than a `void`.
 *
 * §5.17 says reconnect "injects `/mcp` into that session's input route — we
 * type, not fake". That sentence is true on ONE transport. On the Terminal
 * transport the CLI's picker opens in a terminal the user is looking at, which
 * is the whole idea. On the Direct transport there is no terminal, so typing
 * `/mcp` sends the command, opens a picker nobody can see, and leaves the
 * session sitting there — the exact dead end #632's `/mcp` intercept exists to
 * remove. Doing it anyway would reinstate the bug through a different button.
 *
 * So Direct sends NOTHING and says so. That is the honest answer, and it is why
 * main decides this rather than the renderer: `lib/composer.ts`'s
 * `sendSessionCommand` is deliberately blind to transports, which is right for
 * `/compact` and wrong for exactly this.
 *
 * HONEST IS NOT THE SAME AS OPTIMAL, and this docstring originally read as
 * though it were (#721, 2026-08-27). The stream transport is not mute here:
 * the control protocol has `mcp_reconnect {serverName}`, which does the real
 * thing with no terminal and no restart. `restart-required` is what we built
 * because we have never sent an outbound control request — not what the CLI
 * imposes. When that channel exists, this outcome should shrink to the cases
 * that genuinely have no session.
 */
export type McpReconnectResult =
  /** `/mcp` was typed into a live terminal — the picker is on screen */
  | { outcome: 'typed' }
  /** Direct transport: nothing was sent, and the pane says to restart instead */
  | { outcome: 'restart-required' }
  /** the card has no live session to type into */
  | { outcome: 'no-session' }
  /** the folder gate said no, or the id was not a string */
  | { outcome: 'refused' };
