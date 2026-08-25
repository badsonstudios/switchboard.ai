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

/** What `mcp:list` answers: every server a given folder's session would see. */
export interface McpInventoryWire {
  /** the folder the scopes were resolved against — echoed back so a stale
   *  answer arriving after the user switched sessions can be discarded */
  folder: string;
  servers: readonly McpServerWire[];
  /**
   * Scopes that could not be read, by name, with the reason in the log.
   *
   * NOT an error, and never a reason to show nothing: a malformed `.mcp.json`
   * in one repo must not blank the user- and local-scope servers that are
   * perfectly readable (P6). The pane says "project scope could not be read"
   * beside the servers it DID find, which is both halves of the truth.
   */
  unreadable: readonly McpScope[];
}

/** What `mcp:health` answers — a name→state map, merged onto the inventory the
 *  pane already drew rather than replacing it. */
export interface McpHealthWire {
  folder: string;
  states: Readonly<Record<string, McpHealth>>;
}
