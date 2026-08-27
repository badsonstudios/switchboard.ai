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

/** What `mcp:list` answers: every server a given folder's session would see. */
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
