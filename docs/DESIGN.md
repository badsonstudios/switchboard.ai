# switchboard.ai — Design Document

**An IDE for AI sessions.** One window, many agents, all aware of each other.

- Status: Draft v0.2 (2026-07-18) — iterating. v0.2 folds in three verified
  deep-research passes (2026-07-18): feature mining (IDE/WM patterns), hostile
  critique (risk register), and AI-tools follow-up. New: §5.28 checkpoints,
  §5.29 security; amendments marked "research v2".
- Owner: dheinz
- This doc is the working design record. Edit freely; keep decisions and their reasoning.
- **Governance: every feature here must pass the litmus test in [PHILOSOPHY.md](PHILOSOPHY.md).**

---

## 1. Vision

Developers running AI coding agents today end up with four or five VS Code windows open,
one per project, each hosting its own Claude Code session. There is no single surface to
see every session, no way for sessions to share information, and no IDE-grade view of
what each agent is actually changing.

switchboard.ai is a cross-platform desktop app that hosts many concurrent AI agent sessions
in one window. Each session runs in its own project folder with its own terminal, file
tree, and git/diff view. Sessions are first-class objects that can see each other,
reference each other's output, and pass information between themselves — via user
drag-and-drop or agent-initiated calls. Like a telephone switchboard: many live lines,
and an operator who can connect any of them.

## 2. Goals

1. **One window, many sessions.** Kill the five-VS-Code-windows problem.
2. **Per-session working folders.** Any folder, any repo, or a git worktree of a shared repo.
3. **Subscription-first, API optional.** By default all Claude usage flows through the
   locally installed `claude` CLI and the user's Claude Max subscription — no API keys
   required, no surprise per-token billing, ever. Per-session opt-in: auth mode
   `subscription | api-key` (env injection into the spawned CLI — the CLIs themselves
   support key auth, so no separate agent implementation). API sessions display real
   dollar cost on their usage chips.
4. **Cross-platform.** Windows, macOS, Linux from one codebase.
5. **IDE-grade context panes.** File tree with VCS status decorations, diff viewer,
   git operations (stage/commit/branch/worktree/merge) per session.
6. **Inter-session communication.** Drag-and-drop between sessions, @-references in
   prompts, and an agent-accessible session bus.
7. **Agent watcher windows.** When a session spawns a subagent, optionally surface it as
   its own live mini-view; auto-close or pin on completion.
8. **Multi-provider capable.** Claude Code is the first-class citizen; other CLI agents
   (Codex CLI, Gemini CLI, Aider, opencode) work through the same adapter interface.

## 3. Non-Goals (v1)

- Not a text editor / full IDE. Monaco is embedded for viewing and diffs, but users keep
  their real editor for heavy editing. We are the *session* IDE, not the *code* IDE.
- No cloud service, no accounts, no telemetry. Local-first desktop app.
- No reimplementation of Claude Code's *interaction* surface. Permission prompts,
  slash commands, plan mode etc. happen in the real CLI in a real terminal. We DO
  build a rich read-only renderer of session output (the Feed, §5.10) — display is
  ours, interaction is the CLI's. That line is the guardrail.
- No mobile.

## 4. Core Concepts

| Concept | Definition |
|---|---|
| **Session** | One running agent process + its working folder + terminal + context panes + metadata (name, color, provider, status). |
| **Workspace** | The saved set of sessions (folders, providers, layout) that reloads on app start. |
| **Session Bus** | In-app message bus + local MCP server exposing sessions to each other. |
| **Watcher** | A read-only live view of a subagent spawned inside a session. |
| **Provider Adapter** | Pluggable integration for a given agent CLI (Claude Code, Codex, Gemini, Aider…). |

## 5. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Renderer (UI)                                                  │
│  Session grid/tabs · xterm.js terminals · Monaco file/diff     │
│  Session sidebar w/ status badges · drag-and-drop layer        │
├────────────────────────────────────────────────────────────────┤
│ Main process (orchestrator)                                    │
│  SessionManager      – spawn/kill/restart agent processes      │
│  PtyService          – node-pty (ConPTY on Win, forkpty *nix)  │
│  StreamService       – stream-json over pipes (E18; §6 amend.) │
│  ProviderAdapters    – claude | codex | gemini | aider | …     │
│  TranscriptWatcher   – tails ~/.claude/projects/*.jsonl        │
│  HookListener        – local HTTP endpoint hit by CC hooks     │
│  SessionBus          – pub/sub + local MCP server (per session)│
│  GitService          – status/diff/stage/commit/worktree/merge │
│  WorkspaceStore      – saved layouts, session configs          │
└────────────────────────────────────────────────────────────────┘
```

### 5.1 Session lifecycle

1. User adds a session: picks a folder (or "new worktree from repo X"), a provider,
   a display name/color.
2. SessionManager spawns the provider CLI with `cwd` = that folder, in the
   transport its adapter declares — a PTY, or duplex stream-json over pipes
   (§6 amendment 2026-08-01). Environment is augmented (see 5.4) so the agent
   can reach the Session Bus.
3. TranscriptWatcher + HookListener feed structured events (status, tool use, cost,
   files touched) to the sidebar without touching the interactive stream.
4. On exit/crash: status badge updates; user can restart with `--resume <session-id>`
   (Claude) to continue the same conversation.

### 5.2 Claude Code integration (first-class adapter)

All integration is via the locally installed CLI — which authenticates through the
user's `claude login` (Max subscription). The first two bullets are
**alternative transports**, chosen per session (§6 amendment 2026-08-01); the
transcript and hook channels ride alongside either:

- **Interactive PTY** (**no longer the default, and scheduled for removal** —
  see the amendment notes below): spawn `claude` in the session folder. Full
  fidelity of the TUI: permission prompts, slash commands, plan mode, ANSI
  rendering — and the affordances only a terminal has (Ctrl-R history, vim mode,
  the `/resume` and `--from-pr` pickers).
- **Duplex stream-json** (**the default since 2026-08-09**, per session; epic
  E18): the same CLI over
  `child_process` pipes with `--output-format stream-json --verbose
  --input-format stream-json`, plus a bidirectional control channel. What it
  buys that the PTY cannot: **`can_use_tool` permission requests** carrying
  `decision_reason`, `decision_reason_type` and `permission_suggestions` —
  including the `.claude/` writes the hook path cannot answer at all (see the
  hooks caveat below) — token-by-token `stream_event` deltas, and a live
  `system:init.slash_commands` list instead of a hand-curated one. All three are
  MEASURED (S-10). The protocol also carries `interrupt`,
  `set_permission_mode`, `set_model` and `rewind` as control requests, which
  would replace injected keystrokes — but those are **present, not verified**
  (S-10 §3: interrupt semantics were never exercised, and `rewind` exists as a
  request while its picker does not). E18-12 measures them; until it does, do
  not plan against them. What it costs is in the §6 amendment. The JSONL
  transcript is still written, so the channel below keeps working unchanged.

> **Amendment 2026-08-02 — the PTY is a transitional transport, not a permanent
> one.** The owner decided that Terminal mode is removed once Direct mode is
> tested and working in real use: *"we're going to be dropping Terminal Mode
> anyway once we get Direct Mode completely tested here and working."* The
> per-session choice above is therefore a **migration mechanism**, not the end
> state. Nothing is deleted until the condition is met, and PTY mode must keep
> working the whole way — it is the fallback while Direct mode is under test.
> Execution and the full list of what is lost: `docs/plans/05-transport-migration.md`,
> E18-16. **This does not relax P7:** each terminal-only affordance is rebuilt
> properly or dropped and said so. Screen-scraping stays rejected precedent (§5).
>
> **Amendment 2026-08-09 (#381) — Direct is the default; the PTY is opt-in.**
> Dan: *"all sessions default to direct mode. not terminal."* This inverts what
> E18-08b shipped — Direct opt-in, the PTY by default — and is
> the next step of the same migration, not a new decision: the removal condition
> is "Direct mode tested and working in real use", and a mode nobody is put in
> does not get tested in real use. A card that has explicitly chosen keeps its
> choice either way; a card that never chose follows the default, so untouched
> cards move to Direct. The PTY still works, is still one menu click away, and
> is still the fallback until the condition is met.
>
> ⚠ **Known consequence, measured 2026-08-02 (#156):** the transcript channel
> below is **strictly poorer than the stream** for local slash commands —
> `/usage` and friends write `system:local_command` and no `assistant` entry.
> The terminal was silently covering that gap. Anything treating the transcript
> as a faithful record of what the user SAW is relying on something that was
> never quite true. Findings: `spike/findings/s-11-local-slash-commands.md`.
- **Structured JSONL transcripts**: Claude Code writes per-session transcripts under
  `~/.claude/projects/<folder-slug>/`. Tail these for: current status, token/cost
  tallies, tool calls, files modified, subagent (sidechain) activity. Read-only; zero
  interference. (Prior art: owner's existing Claude Code monitoring app — reuse parsers.)
- **Hooks**: switchboard.ai writes hook entries into the session's `.claude/settings.local.json`
  (or injects via `--settings`) for `Stop`, `Notification`, `PostToolUse`, `SubagentStop`.
  Hook command = tiny bundled script that POSTs to HookListener's localhost port.
  Gives instant "needs input" / "finished" / "subagent started" signals — no polling.
  **Reliability caveat (research v2): hooks are a lossy, best-effort accelerator,
  not the authority.** Hook delivery regressed across at least four Claude Code
  minor releases with zero changelog notice (worked v2.0.25 → broke v2.0.27–29 →
  fixed v2.0.30 → broke again v2.0.31 → recurred v2.0.37; anthropics/claude-code
  #10399/#10401/#10814/#11610), and payload enums mutate undocumented (SessionStart
  grew a `fork` source value while docs listed four). Transcript tailing is the
  AUTHORITATIVE status channel; hooks only lower latency. Never exhaustively match
  hook enum fields; smoke-test hooks on every CLI version bump.
  **Sharper caveat, measured 2026-08-01: a hook's verdict is worth LESS than the
  permission-prompt channel's.** Claude Code guards `.claude/**` writes above
  both the `permissions.allow` layer and the hook layer, so a hook returning
  `permissionDecision: "allow"` satisfies the ordinary permission layer and then
  fails the `.claude/` safety check applied on top — the user is asked, answers,
  and the answer is discarded. This is not a bug to route around (the rules live
  *in* `.claude/`, so a rule there granting write access to `.claude/` would be
  privilege escalation); it is the ceiling on what the hook path can ever do, and
  it is why the stream-json transport exists. See the §6 amendment.
- **Headless mode** (v2, for fire-and-forget task panes):
  `claude -p --output-format stream-json --input-format stream-json` with
  `--permission-mode` / `--allowedTools` for autonomy control. *(Note 2026-07-31,
  S-10: `--print` is NOT required for stream-json — the `--help` text saying so
  is stale. Without it the same flags give a long-lived conversation, which is
  the duplex transport above; headless is that transport plus `-p`, not a
  separate mechanism.)*

### 5.3 Provider adapter interface

```ts
interface ProviderAdapter {
  id: string                          // 'claude-code' | 'codex' | 'gemini' | 'aider' | 'generic'
  spawn(opts: { cwd, env, args }): PtySession
  capabilities: {
    transcripts?: TranscriptReader    // structured session data, if the CLI exposes it
    hooks?: HookInstaller             // event push, if supported
    resume?: (sessionId) => string[]  // CLI args to resume a session
    mcp?: McpConfigWriter             // how to attach the Session Bus MCP server
  }
}
```

Claude Code implements everything. Generic adapter = PTY only (still useful: any CLI
tool becomes a hostable session). Codex/Gemini/Aider adapters grow capabilities as
those CLIs expose them. **Design rule: no feature may assume Claude-only, but features
may degrade gracefully to "Claude-only for now."**

**As built (P2-E15-01, 2026-07-30)** — the sketch above is the intent; the shipped
contract differs in three ways, each deliberate:

- **`trust` is a fourth capability.** Claude refuses to work in a folder the user
  has not accepted, and writing that acceptance into `~/.claude.json` was
  unconditional in the session-start path — a Claude-shaped side effect applied to
  every provider. It is the same class of assumption as the other three, so it is
  declared like them. A provider that has never heard of that file gets nothing
  written on its behalf.
- **`mcp` SHIPPED IN P2-E11-03** *(#763, 2026-09-08)*. It was deferred until "its
  first registrant and first caller" because a capability with no implementation
  and no consumer is exactly what AR-P2-13 had us delete (`event-source`); E11
  is that moment. As predicted it is a config-writing capability, since §5.4
  made the bus stdio-only: `mcp.configFor(sessionId, host)` returns the servers
  block in the provider's OWN schema, and `buildSpawn` writes it and passes
  `--mcp-config <path>`. The host owns the wiring (which endpoint, which token
  file, which binary), the adapter owns the shape — the same split
  `hooks.settingsFor` has.
  - **It NEVER passes `--strict-mcp-config`.** Measured, three runs (#760): that
    flag means "use only the servers in `--mcp-config`" and EVICTS every server
    the user configured. The default merges, verified end to end by
    `npm run check:mcp-attach` — `DeepWiki` before, `DeepWiki` + `switchboard`
    after. A test asserts the flag's absence across the whole option matrix and
    a second one asserts the string appears in no shipping source file.
  - **The host method is `attachSession`, not `busServerFor`, because it has a
    SIDE EFFECT**: it opens the session's endpoint. It is synchronous and does
    not wait for the listener, because `SessionManager.create` is synchronous
    end to end and must stay so — an `await` before it lets two lazy-spawn calls
    both pass the reap and breaks one-live-session-per-card (P2-E15-08). That is
    safe because the endpoint paths are DERIVED (`busEndpointFor`), not
    discovered, and because the child dials at its first tool call rather than
    at spawn.
  - **It has a release pair** (`releaseSession`), called from `abandonStart`.
    The first version did not, and every failed start leaked a listening socket
    and a live token for the life of the app.
  - **A provider that declares no `mcp` capability spawns byte-identically** to
    the pre-E11 recipe — asserted as a whole-recipe comparison against literals,
    not merely "no new flag".
- **`fork` is a sixth capability** *(added by P2-E11-12, #801, 2026-09-19)*. The CLI
  can start a NEW conversation carrying an existing one's entire history, leaving the
  original untouched — §5.5's Level 3. Shipped behind the experimental flag, off by
  default.
  - **Separate from `resume`, and the separation is the whole point.** Resume
    CONTINUES a conversation: measured twice now (2026-08-15, and again here against
    2.1.272) plain `--resume` re-adopts the id and APPENDS to the same transcript.
    Fork MINTS a second conversation from the same history. A provider could easily
    have the first without the second, and conflating them would let a Level 3
    gesture degrade into a resume that writes into the SOURCE session's transcript —
    the damaging failure, because "fork" failing open onto "resume in place" is
    silent and destroys the thing it was asked to preserve.
  - **The query carries the SOURCE's folder, not the target's**, which is why it is
    not `ResumeQuery`. A resume always asks about the folder the session is starting
    in; a fork's defining case is CROSS-FOLDER, and Claude's layout derives the
    transcript directory from the folder path — so reusing the resume shape would
    have looked right on every same-folder test and answered "no such conversation"
    for the case the feature exists for.
  - **The host pins the new id** (`--session-id`, which the CLI validates as a UUID)
    rather than letting the fork mint one. Measured on the stream transport:
    `system:init.session_id` comes back as exactly that value, so the card binds to
    the FORK's transcript from the first frame. Left unpinned, the card's only
    candidate until the id arrives is the SOURCE id — two cards, one transcript,
    which is #484/#539 again.
  - **Same-provider only**, per §5.5: transcript formats are not interchangeable, so
    this must be unreachable from a cross-provider handoff. **Neither fake declares
    it**, and that absence IS the gate — all three adapters register under one
    provider id, so no id check could tell them apart.
  - **What is measured versus assumed is written down**, per the standing rule:
    `spike/findings/e11-801-fork-adoption.md`, against `claude` 2.1.272, with the
    probes committed under `spike/probes/801/`.
- **`titles` is a fifth capability** *(added by P2-E7-06, 2026-08-11)*. The CLI
  writes a title of the conversation into its own transcript and we display it
  as the task label (§5.11). Separate from `transcripts` because that one says
  WHERE the file is and this one says the file contains a title and how to
  recognise it — a provider can easily have the first without the second, and
  the key that carries it is undocumented, so the one thing that must not happen
  is that spelling leaking into shared code.
- **The HOST resolves the transcript root and supplies it to `resume`** *(#432,
  2026-08-13)*. `resume.canResume` takes a query object carrying the root the
  host resolved from this same provider's `transcripts.projectsRoot()` — the one
  it hands the watcher and reads a resumed conversation back from (#395).
  Deriving a root inside `canResume` made one contract two independent
  declarations: an adapter answering "yes" about a directory the host never
  reads would resume and then show an empty session. `resume` is therefore
  deliberately NOT independent of `transcripts` for a transcript-backed
  provider; one that resumes on some other authority ignores the root and
  answers from its own knowledge.
- **A card's native id is a CHAIN, and `resume` gained an optional
  `findOrphaned`** *(#484, 2026-08-15)*. The host records a conversation id the
  moment the CLI announces one, and the CLI writes no transcript for it until a
  real turn happens — so an id can name a conversation that does not exist yet
  and may never. Overwriting the previous id at that moment, and then clearing
  the new one when it proved unresumable, destroyed the card's only pointer to a
  conversation still on disk (owner-reported; two live cards). A card therefore
  persists `nativeSessionId` plus `nativeSessionLineage`, and `canResume` is
  asked about the head and then each ancestor in turn — **the stored id is never
  erased by a start, only pushed down the chain**. `findOrphaned` is the repair
  for cards orphaned before the chain existed: given the root, the folder, the
  ids other cards hold and this card's OWN ids, name the conversation it lost or
  answer null. It is optional (absent = such a card just starts fresh), and it
  is asked ONLY for a card that once held an id whose whole chain `canResume`
  declined. That precondition is deliberately weak on the host's side —
  `canResume` is a boolean and cannot distinguish "not on disk" from "could not
  look" — so the contract puts the re-verification of `ownIds` on the adapter,
  which is the only party that can tell those apart.
- **One conversation has exactly one card, and the host — not the adapter —
  decides which** *(#539, 2026-08-19)*. `findOrphaned`'s `claimed` set stops the
  repair CREATING a two-cards-one-conversation state; it cannot undo the pairs
  that already exist, because neither card is orphaned and the capability is
  never asked about them. So the workspace LOAD unties them, in the host, from
  persisted data alone. "The same conversation" means the same id **in the same
  folder**, because a transcript is `<root>/<slug of the folder>/<id>.jsonl` and
  every lookup on this path is already folder-scoped — one id under two folders
  is two files and no conflict. Given a real collision: a card holding the id as
  its head beats one holding it as an ancestor, and failing that the elder card
  (workspace order is creation order) keeps it. The loser does not lose the pointer — it moves to
  `cededNativeIds`, which is deliberately NOT a resume candidate.
  **And deliberately not a ticket to a repair either.** Widening the sweep's
  precondition to "has this card ever held a conversation" is the tempting move
  and it is wrong: the adoption rests on *my conversation is missing from disk*,
  a ceded card's is present and demonstrably someone else's, and its `ownIds`
  would be empty — so the adapter's own "are they really absent?" re-verification
  goes vacuous at the same moment. It would take the newest unrelated transcript
  in a busy folder. A fully-ceded card therefore starts fresh; the notice and a
  documented hand-edit are the way back. A ceded id is also `claimed` by the card
  that gave it up as well as by the keeper, so no third card can adopt it either.
  Both repairs — adopted and ceded — reach a **dismissible notice persisted in
  the workspace file** rather than only the log: a repair the user cannot see is
  indistinguishable from the bug it repairs, and both are one-time by
  construction, so a notice held only in memory behind a collapsed drawer is lost
  the first time the user quits without opening it.
- **`transcripts` LOCATES transcripts; it does not abstract reading them.** The
  sketch names a `TranscriptReader`. Our tolerant parser, tailer and block builder
  stay host-side and are shared by every provider writing that shape; the adapter
  says only where its conversations live and whether a given one is resumable. The
  day a provider writes a different transcript FORMAT is the day the reader moves
  behind the seam.

The host ASKS these — session creation has no branch on which provider it is
talking to. An adapter that declares nothing spawns a PTY and nothing else: no
settings written, no transcript watch, no resume attempted, nothing done to the
folder. Every capability call is fail-open; a contributor that throws degrades that
one capability, never the session.

Concrete provider lineup: Claude Code (first-class) · OpenAI Codex CLI (ChatGPT) ·
Google Gemini CLI · Aider / opencode (API-native OSS) · generic (any CLI).

**Auth modes per session**: `subscription` (CLI login, default) or `api-key`.
API keys are injected as env vars into the spawned process (ANTHROPIC_API_KEY /
OPENAI_API_KEY / GEMINI_API_KEY) and stored in the OS credential store (Windows
Credential Manager / Keychain / libsecret) — never in config files. Subscription
and API sessions run side-by-side (e.g. Max plan for main work, a metered API
session for overflow when the 5-hour window is drained).

### 5.4 Inter-session communication (the signature feature)

Three tiers, from user-driven to agent-driven:

**Tier 1 — Drag-and-drop (user-driven).**
Draggable objects: a terminal text selection, a file from a session's file tree, a diff
hunk, a session's "last response" chip. Drop targets: another session's terminal input
(pastes as text/path), or its prompt composer. Files dropped across sessions are passed
as absolute paths (agents can read across folders) — with an option to copy into the
target folder instead.

> **As built (audited 2026-09-25) — this tier needs RE-SCOPING, not just
> building, and that is why it never became a work item.** Of the four draggable
> objects named above, exactly one shipped, and the other three are in three
> different states:
>
> | Draggable | State |
> |---|---|
> | a session's "last response" chip | **Shipped** as the **context chip** (E11-10, #799) — §5.5 Level 2 rather than a raw excerpt, which is the better gesture and is what the owner actually uses. |
> | a terminal text selection | **Moot.** The terminal was retired from the UI on 2026-09-19 (#873) after the owner's 2026-08-20 decision. There is no terminal to select in. |
> | a file from a session's file tree | **Blocked.** There is no file tree — the **Files** tab is Phase 3 (§5.7, §5.30 v2). Nothing to drag from. |
> | a diff hunk | **Unbuilt and unfiled.** The Changes tab has the hunks; nothing makes them a drag source. |
>
> The DROP side is in better shape than the drag side: OS files land in a
> composer as attachments (E10-10) and a context chip lands on a feed (E11-10).
> What is missing is a switchboard-internal drag that carries *text*.
>
> **Both surviving items point at the same question**, which is why this is a
> scope decision and not a backlog entry: with `@`-references (Tier 2) and the
> context chip both shipped, is dragging raw text between sessions still worth a
> gesture? §5.5 Level 1 ("excerpt injection") rests entirely on this tier, so
> answering "no" means demoting Level 1 rather than leaving it specified and
> unbuilt. The diff-hunk drag is the one piece with no substitute today — a
> reviewer wanting to say *"fix this hunk"* to another session must copy, switch
> and paste.

**Tier 2 — @-references in prompts (user-driven, app-resolved).**
A prompt composer bar per session supports `@session` tokens:
`"Take @TradingApp's last output and apply the same fix here"`.
Before sending, switchboard.ai resolves `@TradingApp` from the Session Bus (last N
messages, or a named artifact) and injects it as context ahead of the prompt text.
Autocomplete popup lists live sessions by name/color.

> **As built (#797, #798, 2026-09-15).** The popup lists `summariesFrom` — the
> bus's own list. At send, a draft that may mention a session goes to main
> (`sessions:resolveMentions`, gated `transcripts.read`), where the finder
> (`shared/mention-finder.ts`: the LONGEST known name at each word-boundary `@`,
> case-insensitive, `'s` ends a name, code spans skipped) runs over
> `SessionQueries` — the instance the bus tools use — and each resolved session
> is injected ONCE, ahead of the prose, as `renderOutput`'s text (#764's
> wording and fence; default `lastN`). **The mention is rewritten** to
> `"Name" (session)` — spelled **as the user typed it**, and it is that spelling
> that is resolved, not the session list's: two sessions differing only by case
> are the ordinary result of two checkouts, and `resolve` matches exact-first, so
> resolving the list's spelling would hand back a session the user did not name
> while the bus handed an agent the other one (#798 review). Session **ids** are
> candidates too, which is what makes the ambiguity refusal's "Use the session
> id" true in the composer. Injection is deduplicated on the resolved id, and the
> total is bounded (`TOTAL_CONTEXT_CHAR_CAP`): whole blocks only, later ones
> dropped with an in-band note naming them, since each session's 20k cap said
> nothing about four of them at once. The rewrite is measured on CLI 2.1.272
> (`spike/findings/e11-798-cli-at-mention.md`), the CLI expands any `@word` as a
> file mention itself — a same-named file is attached, and even a miss costs the
> model a `Read`. An unresolved `@word`, the composer's own session, and a
> forwarded sibling message's text are sent as typed; slash commands are not
> resolved. An **ambiguous** name refuses the whole send with `resolve`'s reason
> (`code: 'ambiguous'`). A failed lookup fails open: the draft is sent as typed
> and the composer says so. The context is shown in the sent user turn, not
> expanded in the composer; collapsing it there is #830.

**Tier 3 — Session Bus MCP server (agent-driven).**
switchboard.ai runs a local MCP server; each Claude session gets it attached at
spawn via `--mcp-config`.

> **Transport decided 2026-07-26 (architecture review AR-P1-6), owner-confirmed
> the same day: stdio only in v1 — one server process per session, no listener,
> no token.** The earlier
> "per-session identity token" wording assumed an HTTP transport we no longer
> ship. Two reasons. (1) §5.29's whole localhost attack class (DNS rebinding,
> CSRF, missing Origin checks) is *deleted* rather than defended against —
> stdio has no network exposure and its security model is process isolation.
> The HookListener must stay HTTP (hook commands are separate processes); the
> bus has no such constraint, so it shouldn't pay that cost. (2) Decisive: an
> MCP tool call carries **no ambient session identity**, and the bus must know
> which session is calling. With stdio that's free — one process per session,
> identity passed in argv/env at spawn. With HTTP we'd be minting per-session
> tokens again, i.e. adding a transport in order to need the defence the
> transport created. HTTP/WebSocket is deferred to §5.27, where it's genuinely
> unavoidable. A provider declares whether it can take the bus at all via the
> `mcp` capability on the §5.3 adapter contract.
>
> **What this forbids, stated plainly so the trade is never re-argued from
> memory:** the bus is reachable ONLY by processes switchboard itself launches.
> Not a browser tab, not a browser extension, not a hand-run script, not
> another app, not the phone, not another machine. That restriction IS the
> security benefit — there is no door to guard rather than a door guarded
> correctly forever. Owner was asked directly whether anything non-session
> would ever need to reach into running sessions and confirmed nothing came to
> mind (2026-07-26).
>
> **The one thing that reverses this:** a wanted feature where something that
> is *not itself a session* must call the bus. That is the trigger to reopen —
> not general unease about stdio, and not the mobile companion, which is a
> separate §5.27 WebSocket projecting orchestrator state and was never going to
> ride this pipe.

> **AMENDMENT 2026-09-08 (P2-E11-02, #762) — "no listener, no token" was true of
> the AGENT↔BUS hop and is NOT true of the whole design.** The paragraph above
> is left standing because its reasoning about the *agent-facing* transport is
> unchanged and correct. But it overstated the conclusion, and the overstatement
> is worth correcting rather than quietly outgrowing.
>
> A stdio MCP server's stdin and stdout belong to the CLI that spawned it. So
> the bus child **cannot answer `list_sessions` at all** without a second
> channel back to Electron main — the answer lives in the host process, and the
> one pipe it has is already spoken for. AR-P1-6 decided the agent↔bus hop and
> was silent on child↔host; that was a gap in the record, not a decision.
>
> **Decided 2026-09-07 (owner): the child↔host channel is a named pipe / unix
> domain socket.** So there IS a listener and there IS a per-session token —
> just not a network one. What survives intact is the property the stdio
> argument was actually about: no port, no HTTP, no network stack, and nothing
> a browser tab, an extension, another machine or the phone can address. §5.29's
> localhost attack class stays deleted rather than defended. Reusing
> `HookListener`'s loopback HTTP was the cheaper build and was considered and
> rejected for re-admitting that class on a channel that does not need it.
>
> The token follows S-03 unchanged: **a 0600 file referenced by path on the
> child's argv, never the token itself**, because argv is world-readable on
> every platform we ship. The host resolves the caller from the TOKEN and never
> from the `--session` argument the child carries, so identity-at-spawn is a
> property rather than an honour system. Windows named pipes are ACL'd to the
> creating user; on posix the socket is chmod'd 0600 and its name is a digest
> (a path composed from the state dir overflows `sun_path`'s 104 bytes on
> macOS).
>
> **The binary that runs the server is the Electron binary under
> `ELECTRON_RUN_AS_NODE`, not `node` on PATH** — measured 2026-09-08: the server
> is a rollup entry and therefore lives inside `app.asar` when packaged, which
> Electron can read under run-as-node and plain Node cannot read at all.

Tools exposed:

- `list_sessions()` → names, folders, providers, statuses
- `get_session_output(session, lastN?)` → recent transcript tail of a sibling
- `send_to_session(session, message)` → queues a message into a sibling's prompt
  composer (delivery policy below)
- `get_session_diff(session)` → sibling's current uncommitted diff
- `publish(key, value)` / `read(key)` → shared scratchpad ("blackboard") for pipelines

Now sessions are genuinely aware of each other: the TradingApp agent can *ask* what the
PropaneMon agent changed. This runs on the subscription like everything else — MCP tool
calls are just tool calls inside a normal Claude Code session.

> **AS BUILT (P2-E11-06, #796) — the blackboard, and the four decisions it was filed
> with.** The ticket shipped scope, persistence, caps and the keyless `read` as open
> questions to be *named rather than inherited*; here is what they became.
>
> **The tools are `blackboard_publish` / `blackboard_read`, not the bare
> `publish` / `read` this list writes.** A deliberate deviation. Tool NAMES are what an
> agent matches on before it ever fetches a schema (#760 §6), and a bare `read` sits
> directly beside the CLI's own file-reading `Read` — #800 had just measured what
> overlapping tools cost, which is a worse ANSWER rather than an error, and nothing
> surfaces that. The prefix makes the pair unmistakable and keeps them adjacent in a
> listing.
>
> **Scope: one workspace-wide keyspace**, every entry attributed to the publishing
> session — resolved from the TOKEN, never from the child's `--session` argv, so the
> author of a note is a property rather than a claim. The publisher's NAME is resolved
> at read time rather than stored, so a card renamed between publish and read does not
> send its reader looking for a session listed under something else.
>
> **Persistence: in memory, for the life of the app — NOT the workspace store**, and
> the reasons are ordered by weight. A restart has already destroyed the pipeline
> (restore yields SUSPENDED records; nothing is running), so notes that survived would
> be attributed to sessions that no longer exist. Persisting would put disk I/O inside a
> tool call on the main thread, which is the cost #772 measured and bounded. It would
> also put agent-written content into `workspace.json`, which `SIBLING_INBOX_CHAR_CAP`
> already worries about for the same file. And it is the reversible direction: adding
> persistence later is additive, removing it after agents have written to the workspace
> file is not.
>
> **Caps refuse, never truncate** — key 128, value 20,000, 100 keys, 100,000 characters
> overall. A truncated note still reads as a complete one (`SIBLING_MESSAGE_CHAR_CAP`'s
> own argument), and the publishing agent can shorten its own text better than we can.
> The total is charged against *what the write would leave behind*, so an overwrite that
> SHRINKS a value is not refused by a full board — the one accounting bug that would
> make a full board impossible to empty.
>
> **A keyless `read` LISTS the board**, which the ticket named as the case that matters:
> an agent joining a pipeline late has no other way to discover what is there. The
> listing carries key, publisher, size and age but **not** the values, so discovery
> costs a bounded answer rather than the whole ceiling. Only an ABSENT key takes that
> branch — a key that is present but malformed is refused, because listing for it would
> answer a question the agent did not ask.
>
> **Why this is outside §5.4's human-keypress rule rather than an exception to it:** that
> rule is about `send_to_session` injecting into a sibling's composer. This is the other
> shape — a write nobody receives. **Publishing never causes execution, delivery or
> notification in another session:** there is no composer on the path, no submit, no IPC
> and no renderer consumer, so nothing reaches a session that did not call the read tool
> itself. *(Narrowed after review, which was right that the first version — "a session
> that never reads cannot be affected by one that publishes" — claimed more than is true
> and would have been quoted back later. The caps are workspace-global, so a session
> looping on generated keys can exhaust them and make a sibling's next publish fail, and
> the namespace is shared, so one session may overwrite another's key. Both are bounded
> and neither is execution; attribution on every answer is what keeps them honest.)*
> The receipt says so in as many words
> ("NOBODY HAS BEEN TOLD") and points at `send_to_session` for when a person is what is
> actually wanted, because the neighbouring tool promising delivery is exactly what makes
> that mistake available.

> **AS BUILT 2026-09-08 (P2-E11-04, #764) — the two READS are shipped.**
> *(`send_to_session` shipped in #765 — see its as-built note under "Delivery
> policy" below. The blackboard shipped in #796; its note follows this one. This
> sentence read "`send_to_session` and the blackboard are not" until both were
> built, which is how a true line becomes a false one by standing still.)* `list_sessions` landed with
> #762/#763. This item added `get_session_output` and `get_session_diff` as thin
> wrappers over the query core (#761), which owns every cap and every refusal so
> that the composer's `@session` path gets the same answers rather than growing
> a second set.
>
> **Three contract details worth having written down, because each one was a
> decision and not a default:**
>
> - **A bad session reference REFUSES; an empty session does not.** "No such
>   session" and "ambiguous — two sessions share that name" come back as
>   readable `isError` content naming the sessions that do exist, because an
>   agent told that retries usefully. A session that merely has no transcript
>   yet, or a folder that is not a repository, answers `ok` and says so in
>   words. The failure this ordering exists to prevent is an empty success, which
>   an agent reads as "my sibling did nothing" and believes.
> - **Every output answer states that long messages are shortened, whether or
>   not anything was truncated.** `DISPLAY_CAPS` bounds a prose block at 20k
>   characters and a tool result at 4k *inside* the derivation, and the
>   `truncated` flag is unset by those cuts — so a 200 KB test failure arrives as
>   its first 4k and would otherwise read as a complete run.
> - **`CHANNEL_VERSION` stayed at 1** while `BUS_OPS` gained two words. Adding a
>   word to the vocabulary is backwards-compatible by construction (`isBusOp`
>   refuses an unknown op with a reason); the version gate is for a change to the
>   request ENVELOPE, where there is no graceful degradation to fall back on.
>
> `BusHost.answer()` became **async** here — `get_session_diff` shells out to
> git — and the ordering that costs is owned by `answerAndReply`: the idle
> deadline is cleared once a whole request is in hand (a slow `git diff` looks
> exactly like an idle socket, and dropping it would report a busy sibling as an
> unreachable switchboard), and a socket destroyed during the await is noticed
> rather than written to.

**Delivery policy (safety):** `send_to_session` never auto-executes in the target by
default. Incoming messages land in the target's composer as a highlighted "from
@Session" block; the user hits Enter. Per-session toggle: "auto-accept from siblings"
for deliberate pipeline setups. This prevents runaway agent-to-agent loops.

> **AS BUILT 2026-09-10 (P2-E11-05, #765).** The rule is kept by *shape*, not by
> discipline: **main decides, the window only holds.** `sessions/delivery.ts`
> (`SiblingDelivery`) is the only code that can submit a sibling's message, and
> it calls `SessionManager.submitPrompt` from one place, behind the card's own
> flag. The main→renderer push (`sessions:siblingMessage`) carries a message to
> SHOW and has no field that means "send" — a test pins its key set — so no
> renderer bug can promote a hold into a send. The composer sends a held message
> only through the user's own Enter, wrapped in a header saying who wrote it and
> that the user passed it on.
>
> **Four decisions beyond the paragraph above:**
>
> - **Liveness is `exited`, not `status`.** `'done'` is the state machine's word
>   for both a finished turn and a clean exit, so `SessionSummary` gained an
>   `exited` flag from the record's `exitCode`; exited sessions stay listable and
>   readable (#187) but refuse delivery, and `list_sessions` now says "exited".
> - **Never silently dropped.** No window → explicit refusal. The window
>   acknowledges each delivery (`sessions:siblingMessageAck`, with whether a
>   composer for that card is mounted); no ack within 8 s → a hedged
>   "handed over, not confirmed", never "not delivered". 8 s < the host's 12 s
>   answer deadline < the child's 15 s slow-tool deadline, so the truest message
>   fires first. A card holds at most 10 waiting messages.
> - **Auto-accept is Direct-transport only** and only when the target is idle,
>   done or working (the stream queues a mid-turn message). A Terminal-mode
>   session, or one waiting on the user, holds the message instead and the
>   sender is told why — main typing a multi-line message plus Enter into a TUI
>   could answer a dialog the user is looking at.
> - **A loop breaker even with the toggle on**: at most 5 automatic sends per
>   target in 10 minutes, then messages wait for a person. The default-off
>   toggle stops loops for everyone who leaves it off; a user who turns it on
>   for both sessions of a pair has built exactly the loop it guards against.
>   `delivery.test.ts` runs two agents that each answer every message they get:
>   one hop with defaults, bounded at 2×5+1 sends with both toggles on.
>
> **What review added, all so the header's "the user reviewed it" stays true:**
> control characters (C0/C1, DEL, bidi overrides) are REFUSED — a terminal
> escape would turn the reviewed Enter into keystrokes nobody saw; a message
> younger than 1 s is not sent by an Enter that was already on its way for the
> user's own prompt; a slash command goes alone; and the header's markers carry
> a reference derived from an id the sender is never told, so a message cannot
> forge an end marker plus a fake "reviewed" header. The Session tab badges the
> waiting count, since the composer is unmounted on the other tabs.

### 5.5 Context transfer between sessions

Premise: a session's "context" is not opaque server state — it is the JSONL transcript
replayed to the model each turn. Context is data on disk we can read. What is NOT
possible: splicing A's transcript into B's live conversation (strict alternating
structure, tool-call pairing, unsupported format). So context transfer = getting A's
content into B's conversation as input, at a chosen fidelity:

- **Level 1 — Excerpt injection.** Drag A's last response / text selection / file into
  B's composer. (Same mechanism as Tier 1 drag-and-drop.) **Unbuilt as of
  2026-09-25, and it inherits Tier 1's scope question rather than being a separate
  gap — read §5.4's Tier 1 as-built note before planning this.** The "last
  response" half effectively shipped as Level 2's context chip, which is a better
  gesture; the text-selection half has no terminal to select in any more.
- **Level 2 — Context package handoff (default).** Drag A's *context chip* onto B →
  switchboard.ai generates a structured handoff (goal, decisions, files touched, current
  state, key snippets) and injects it into B with a "Context from @A:" header.
  Generation options: (a) ask A's own agent to write the handoff, or (b) one-shot
  headless pass (`claude -p`) over A's transcript. Summarized > raw: full transcripts
  can be 100k+ tokens and would consume B's context window and rate limits.
- **Level 3 — Full context adoption (experimental).** `claude --resume <id>
  --fork-session` starts a NEW session carrying A's entire conversation history.
  Cross-folder variant: spawn in the TARGET folder and fork by id — the CLI resolves
  the conversation across project directories and writes the new transcript into the
  target's own directory. Relies on undocumented storage layout — ship behind an
  "experimental" flag. *(Amended 2026-09-19, P2-E11-12 — see the as-built note.)*

> **AMENDED 2026-09-19 (P2-E11-12, #801) — the cross-folder variant does NOT copy a
> transcript, and this paragraph used to say it did.** The original read *"copy A's
> transcript into the target project's transcript dir, then fork-resume there"*. That
> was a design-time guess made before anyone drove the CLI, and it was the single
> riskiest line in the feature: it would have made switchboard the first code in the
> repo to WRITE into `~/.claude/projects`, a directory the CLI owns.
>
> **Measured instead** (claude **2.1.272**, two probes, `spike/probes/801/`, write-up
> in `spike/findings/e11-801-fork-adoption.md`): `--resume <id> --fork-session
> --session-id <uuid>`, spawned with the cwd set to the TARGET folder, carries the
> source conversation's whole history, leaves the source transcript **byte-identical**
> (sha256, size and mtime), and writes the fork into the **target** folder's project
> directory. No copy, no path construction, nothing written into the CLI's tree.
>
> **The control variant is what settled it.** Cross-folder by absolute `.jsonl` path
> works too — the file form of `--resume` is real, undocumented in `--help`, and has
> its own telemetry entrypoint — but cross-folder by **plain id** works just as well,
> because the CLI's resume resolver carries two cross-directory fallbacks
> (`tengu_resume_worktree_fallback`, `tengu_transcript_id_scan_fallback`). Three ways
> to express it; the one that invents nothing is the one that ships.
>
> **Why `--session-id` is pinned rather than letting the fork mint its own.** Measured
> on the stream transport: `system:init.session_id` comes back as exactly the id we
> passed. The host needs that id to bind the new card — left unpinned, the card's only
> candidate until the id arrives is the SOURCE id, which would bind two cards to one
> transcript (the §5.25 / #484 / #539 failure). Pinning it makes that impossible rather
> than unlikely. The CLI validates it as a UUID and refuses anything else.
>
> **Still same-provider only**, unchanged: transcript formats are not interchangeable,
> and the gate is a `fork` provider capability that only the Claude adapter declares.
> Neither fake declares it — all three adapters register under one provider id, so the
> absence IS the gate.
- **Agent-pulled variant.** Session Bus MCP tool `get_session_context(session,
  detail_level)` lets B's agent request a handoff package mid-task on its own.

Drop-dialog UX: dropping a context chip asks "Inject: last response | summary handoff
| full excerpt…" with token-size estimates shown per option.

**As built (P2-E11-09, #766) — the mechanical generator, and the one heading that
changed.** The fallback rung (a) above shipped FIRST rather than last, for the reason
the ladder itself implies: the canonical trigger is the drained rate-limit window, and
that is precisely when (b) and (c) are unavailable, so the rung that has to exist
anyway is the one worth having first. It is also the only variant that is
deterministic, and therefore the only one whose correctness a test suite can speak to
at all — the package is byte-stable across runs, which no LLM-written variant will
ever be.

Four of the five sections above are honestly mechanical. **"Decisions" is not**, and
the shipped package does not use that heading: recovering *"we chose a named pipe
because HTTP would re-admit the localhost class"* from prose is a language model's
job, and a mechanical extractor printing its best guess under a heading that
confident is the honesty rule broken in the one place it matters most. What ships
instead is the nearest thing that IS a fact — **the user's own later prompts**, which
is where a course correction is actually recorded — under its own name. The
agent-written and `claude -p` variants layer onto the same package shape and are
where a real "Decisions" section comes from.

**Neither of those two variants is built, and neither is filed** (audited
2026-09-25). So Level 2 ships at the deterministic rung only, and the "Generation
options (a)/(b)" sentence above describes one option today. This is the intended
order rather than a slip — the fallback rung had to exist first, and it is the only
one a test suite can hold — but it does mean a handoff currently carries *later
prompts* where a reader of this section would expect *decisions*. Filing either
variant is cheap (the package shape and the injection path both exist); what it
needs first is a judgement on whether an LLM-written handoff is worth the tokens
and the non-determinism, which is a question for whoever has been living with the
mechanical one.

Two further properties, both recorded because a later reader will otherwise assume
the easier thing was done: the package reads **two bounded windows, not the whole
file** — the tail for state, and a small head window for the task statement, which
lives at the opposite end of the transcript and would otherwise be silently replaced
by whatever the user happened to say four hundred turns in; and it reports
**coverage** ("the whole conversation" vs "the most recent part of it") in the
document itself, because a handoff is the worst possible place to describe a blind
spot as a fact about the work. Measured: ~3,100 estimated tokens out of a 7.37 MB
conversation, in 11.2 ms.

**As built (P2-E11-10, #799) — the chip, the dialog, and the seam it rides.** The
gesture ships as §5.5 describes it: a **context chip** in every live card's header
(live only — a package resolves a LIVE id, so a chip on a suspended card would be
a handle on nothing), dragged under its own transfer type onto the composer
dropzone #476 already built. A drop **opens the dialog rather than injecting**,
and a self-drop is refused out loud.

The three fidelities are not invented for the dialog — each is something the #766
package already computes: *last response* is its `state` section, *summary
handoff* is the whole rendered document (**the default**, as §5.5 says), and
*full excerpt* is its `activity` section. **Every size shown is a field copied off
`PackageSection.tokens` / `ContextPackage.tokens`, never recomputed** — the
done-when, and the reason is that a second estimator is a second answer that
drifts the day either side's caps move. The test that pins it hands in a package
whose section estimates are deliberately wrong and asserts the dialog repeats
them, because for a real package a recomputation would agree and the test would
pass by accident.

**One IPC call carries the sizes AND the text of all three options**, from one
build of one package. Sizes-now-text-on-OK was rejected: the source is a LIVE
session, so the second read would happen after however long the user spent
reading, and the estimate they chose from would describe a conversation that had
moved on. Coverage survives into **every** option, not just the whole package —
a single section lifted out carries no `Covers:` line of its own, and an excerpt
that dropped it would walk back exactly the guarantee #766 exists to make.

**Injection rides #765's seam rather than opening a second one.** A chosen block
is parked in the target card's inbox (`lib/sibling-inbox.ts`) — keyed by card,
persisted, pruned at the boot sweep, settle-timed, removed only once a send
resolves, and structurally incapable of submitting, since nothing on the path
calls `submitPrompt`. What it does **not** reuse is `formatSiblingPrompt`'s
header, which says another session sent a message and the user relayed it: the
user went and *fetched* this, and main has already rendered its own header onto
it. A `kind` discriminant tells the two apart; **absent reads as `'sibling'`**,
because every message written before the field existed is sitting in a real
workspace blob without it and a required field would delete them all on the next
launch. Control and invisible characters are **stripped in main** rather than
refused — the refusal exists to teach a sending agent to send plain text, and
here there is no such agent.

**As built (P2-E11-11, #800) — the agent-pulled variant, and the vocabulary it did
NOT invent.** `get_session_context(session, detail_level)` ships as the bullet above
describes it, and the interesting decision is what it reuses. `detail_level` is
**the same `CONTEXT_FIDELITIES` the drop dialog speaks** — `state` | `package` |
`excerpt`, defaulting to `package` — rather than a second set of words written for
an agent. The tool is one more door onto the gesture #799 built, not a second
feature that happens to resemble it, so two vocabularies would have been two
declarations of one contract: the day either moved, a tool would refuse a level the
dialog still offered. The tool's `enum` is spread from that constant, and the host
validates against it once, in the query core, where the refusal that names the valid
levels already lives.

Thin to the point of selecting rather than building: `sessionContextFor` calls
#766's generator and then #799's `buildContextOffer`, and every number it returns
is a field copied off the option it chose. **No second generator, no second
estimator, no second rendering of a package.** The coverage statement therefore
survives to the tool output *verbatim* — not because the bus layer repeats it, but
because it travels inside the rendered document and nothing at the tool edge touches
the text.

Two orderings are deliberate and are the parts worth finding again. **The level is
validated before the session is resolved** — inverting this file's usual rule, and
on purpose: the level is a free comparison against three words, while resolving
first would read up to 2 MB of transcript synchronously on main to answer a call
that cannot succeed either way. And **an absent level takes the default while a
present-but-wrong one is refused**; collapsing those would mean an agent that asked
for "full" was handed the default and told nothing, and would go on believing
"full" is a level this tool has.

It is **not** a slow tool (the package is a bounded two-window read, 9–11 ms on a
7.37 MB transcript) but it **is** subject to the per-endpoint in-flight bound —
which is what `sessionContext`'s own doc comment had been reserving for this item,
since a burst of packages is the one traffic shape that could stall the host. No LLM
runs on this path: it serves #766's mechanical extraction, so §8's containment
question ("a cwd is not a sandbox") is not reached and is not answered here.

**Cross-provider handoff (continue elsewhere).** The same premise extends across
vendors: because context is local data — transcript + working tree + git state — a
session can be continued on a *different provider's* CLI (Claude ⇄ Codex ⇄ Gemini),
the canonical trigger being "my 5-hour window drained mid-task; pick it up in
ChatGPT/Gemini instead of waiting." What can NEVER cross: server-side session
state, Level-3 fork-resume (transcript formats are not interchangeable — L3 is
same-provider only), and whatever model understanding the handoff doc fails to
capture. What crosses fine: everything Level 2 packages — and the biggest piece
travels for free, because the target session spawns in the same project folder
and inherits the working tree and git history untouched.

- **Provider-neutral handoff doc.** The Level-2 package rendered as plain
  markdown (goal, decisions so far, current state, next step, files touched),
  injected as the target CLI's opening prompt via its adapter (§5.3).
- **The generator problem.** The natural summarizer (A's own agent, or `claude
  -p` over A's transcript) is exactly what's unavailable in the rate-limit
  scenario. Fallback ladder: (a) mechanical extraction from the JSONL — task
  statement, todo/plan state, files touched from tool calls; no LLM required;
  (b) export the transcript to readable markdown and let the *target* model
  brief itself ("read handoff-transcript.md, summarize where things stand,
  continue"); (c) when the handoff is voluntary rather than forced (provider
  still available), ask A to write its own briefing — highest fidelity.
- **Impedance mismatches, stated not hidden.** Instruction files (CLAUDE.md vs
  AGENTS.md) follow each CLI's own convention — the adapter knows the target's;
  MCP servers, permissions, and hooks do not transfer (the target session gets
  its own via its adapter). The handoff doc lists what the target won't have.
- **Trigger UX.** Manual: drop A's context chip onto a new-session target of
  another provider. Suggested: when usage tracking (§5.13) sees the window
  drained, A's session card offers "Continue in <provider> →". Hand-back on
  window reset is the same gesture in reverse — the interim session's context
  chip drops back onto a resumed A.
- **Honesty rule.** The UI presents this as a *briefed continuation*, never a
  resumption — the target knows only what the handoff carries. Lossiness is
  accepted; the alternative in the trigger scenario is hours of stall.

Litmus (PHILOSOPHY §4): user-triggered or event-suggested only (calm check);
degrades to raw transcript export or plain copy-paste (fail-open, escape hatch);
drives each CLI exactly as shipped (host check). See OQ #16 for what needs
empirical validation.

### 5.6 Agent watcher windows

When a Claude session spawns a subagent (Task tool), its activity is written to
its own transcript file, `<uuid>/subagents/agent-<id>.jsonl`, beside the
parent's — not into the parent's transcript (corrected 2026-09-15, #807; see
§5.13) — and `SubagentStop` hooks fire on completion.

- Sidebar shows a nested entry under the parent session while a subagent runs.
- If "watcher windows" is enabled (global + per-session toggle), a mini panel/floating
  window opens: read-only live rendering of the subagent's transcript (name, current
  tool call, streamed output tail).
- On completion: auto-close after a linger delay, or stay pinned if the user
  interacted with it / toggled pin. Configurable: `auto-close | linger 10s | pin`.
- Watchers are strictly read-only in v1 (subagents are not interactive surfaces).

### 5.7 Git / IDE panes

- **GitService** shells out to the system `git` (portable, avoids native-binding pain;
  simple-git or hand-rolled). Parses status/diff into structured models.
- **File tree** per session with VCS decorations (modified/added/untracked badges).
- **Diff viewer**: Monaco diff editor (same component VS Code uses) — side-by-side and
  inline modes, per-file and all-changes views.
- **Worktree flows**: "New session as worktree of <repo>" creates
  `git worktree add`, on a new branch, and points the session there. "Merge back" =
  commit (if dirty) → merge branch into main checkout → optionally remove worktree.
  One-click, with a diff review step first.
- **Cross-session diff awareness** (via Session Bus): warn when two sessions have
  uncommitted changes touching the same files in the same repo.
- **Editable diff + commit-from-diff** (table-stakes: Crystal shipped it): edit
  directly in the Monaco diff pane and commit from there.
- **One-click squash-merge to main and update-from-main** per session (table-stakes
  across Crystal / Claude Squad / Conductor / parallel-code).
- **Cross-session review dashboard** (differentiator — verified absent in all
  competitors; Conductor explicitly reviews "one workspace at a time"): a single
  surface listing every session's pending diff, ranked by readiness, for batch
  review-and-merge flows.
- **Worktree isolation caveat**: worktrees separate directories, not resources —
  no protection for shared ports, dev databases, or .env collisions. Surface
  port/resource conflicts between sessions as Feed warnings.

> **As built (audited 2026-09-25), and THREE OF THESE BULLETS ARE IN NO PHASE AT
> ALL.** That is the finding worth recording: they are not late, they were never
> scheduled, and §8 does not mention them — so no amount of working the queue
> would ever have reached them.
>
> Shipped: **GitService** shelling out to the system `git` (P1-E5), the **Monaco
> diff viewer** with side-by-side/inline as a per-workspace choice (#532), and the
> **History** tab's read-only log.
>
> Scheduled, Phase 3 (§8): the **file tree** with VCS decorations (as one epic
> with document viewer v2 — they are the same surface), **worktree create /
> merge-back flows**, **cross-session same-repo conflict warnings**, and the
> **cross-session review dashboard**.
>
> **Unscheduled, and two of the three are flagged in this very section as
> table-stakes that competitors already ship:**
>
> - **Editable diff + commit-from-diff** — "table-stakes: Crystal shipped it".
>   The diff pane is read-only and there is no commit path anywhere in the app.
> - **One-click squash-merge to main + update-from-main** — "table-stakes across
>   Crystal / Claude Squad / Conductor / parallel-code". Neither exists.
> - **Port/resource conflict Feed warnings** — the mitigation the isolation caveat
>   directly above promises. No detector, no event.
>
> The first two are the ones to weigh deliberately: they are the *write* half of
> the git story, and everything shipped so far is the read half. They also sit
> next to the worktree flows in Phase 3 and would be cheaper planned with them
> than bolted on after — the same argument §8 already makes for the file tree.
> The third is small and belongs with the worktree work for the same reason.

### 5.8 Attention-driven layout

Sessions expose a status machine (`working | needs-input | needs-permission | idle |
done | crashed`) fed by hooks + transcript events. The layout engine reacts to it:

- **Auto-minimize on submit** (per-session toggle): submitting a prompt collapses the
  card to a slim status strip; it restores automatically on `Stop` (done) or
  `Notification` (needs human).
- **Attention queue**: sessions needing a human line up in order; a global hotkey
  (e.g. Ctrl+Space) jumps to the next one — inbox-zero for agents. With 7–8 sessions
  this is the primary workflow, not the grid.
- **Layout modes** (per workspace): `grid` (all visible) · `focus` (one large + live
  thumbnails) · `queue` (only attention-needing sessions expanded).
- Keyboard-first: Ctrl+1..9 jump to session N; every mouse flow has a key path.
- **Idle collapse** (validated: i3 tabbed layouts; Claude Code agent-teams panel):
  idle sessions collapse to compact rows; more than ~3 idle aggregate into a single
  "N idle sessions" row. Working / errored / currently-focused sessions always keep
  their own row.
- **Urgency strip** (i3 urgency-hint pattern): a persistent global strip showing
  every session's urgency state at a glance, visible regardless of layout mode.
- **The queue is a persistent ordered work list**, not fire-and-forget toasts —
  distinguishing needs-permission / needs-input / completed-unreviewed / errored.
  Research (2026-07) verified no competitor ships a persistent prioritized queue;
  they ship push notifications (Crystal) or a permission-only inbox (octomux).
  Persistence + the completed-unreviewed state is a core differentiator.
- **Batch permission handling** (octomux pattern): similar pending permission
  prompts across sessions can be grouped and answered once.
- **Presentation ladder** (per session): `expanded → collapsed strip → tabbed →
  hidden`. Hidden = removed from the workspace entirely; the session exists only
  in the sidebar, urgency lamps, and event feed. Reveal triggers: needs-attention
  (permission / input / done) or user click anywhere (sidebar, event, lamp).
  Reveal restores the session to exactly where it was (dock slot or its monitor).
- **Presentation policy setting**: `always-visible | auto-collapse | auto-hide` —
  global default + per-group and per-session overrides. **DEFAULT is
  always-visible** *(amended 2026-08-04, Dan, after dogfooding P2-E9-06 / PR
  #198; the original default was auto-collapse)*: nothing minimizes unasked,
  because under auto-collapse you cannot watch your first turn stream in the card
  you submitted from — the same intuitive-first litmus the earlier parenthetical
  applied to auto-hide, one rung higher. **auto-collapse and auto-hide are
  opt-in**, one click of the titlebar chip away for the many-sessions workflow
  they suit.
- **Pinning is a protection contract** (research v2: VS Code + IntelliJ pinned-tab
  semantics): a pinned session sorts first in the rail, never scrolls out of view
  under overflow, and is exempt from EVERY bulk operation — bulk-close, idle
  aggregation, auto-collapse sweeps, and any future auto-eviction. Pin/unpin is
  one gesture. Pinned ≠ always-expanded: a pinned session may still be a strip —
  pinning protects existence and position, not size.
- **Focus-stealing policy** (research v2: i3 `focus_on_window_activation`): a
  global setting with per-session override governing whether a session that
  finishes or needs attention may grab focus: `smart` (focus if its card is
  visible, else mark urgent — default) · `urgent` (never steal; lamp only) ·
  `focus` (always) · `none`. Settles up front a question every notification
  system otherwise answers by accident.
- **Delayed urgency reset** (research v2: i3 `force_display_urgency_hint`): after
  jumping to a session that demanded attention, its urgency lamp stays lit for a
  configurable beat (~0.5–2s) — you can still see WHICH session called you after
  you arrive. **The beat runs from the first PAINT of the lit lamp, not from the
  keypress** *(amended 2026-08-10, Dan, after #320)*: measured from the keypress,
  a machine busy enough to take longer than a beat to draw the strip showed no
  lit lamp at all — not late, never — and it failed silently in exactly the busy
  moments the signal matters most. The beat exists so a HUMAN can see the lamp,
  so the pixels are the only honest start. Implementation: the jump records
  "lit, no deadline"; the strip converts it to `paint + beat` from the frame
  after the commit that drew it (`requestAnimationFrame` twice — a commit is not
  a paint). A mark that has not painted yet therefore survives a backgrounded
  window rather than burning down unseen; once the beat has started it runs on
  the wall clock like any other. **At most ONE mark may be waiting on a paint —
  the latest** *(amended 2026-08-11, Dan, after #426)*: two lamps whose beats
  are RUNNING still overlap (jump A, jump B a moment later, both rings up), but
  an unpainted mark is discarded by a newer one. `Ctrl+Space` runs in the main
  renderer while focus raises a POPOUT, so an operator working across popouts
  can leave the main window occluded for jump after jump, and a queue of marks
  drained by one paint is a fireworks show of stale "you arrived here" flashes.
  The beat answers "where did I just land?", and after a popout stint only the
  last landing carries that.
- **Focus mode is a composition, with a keyboard-fail-open invariant** (research
  v2: IntelliJ Zen = Full Screen + Distraction-free; VS Code maximize-toggle):
  "focus on one agent" composes existing presentation-ladder states rather than
  being a bespoke mode. Double-click a session header (or one command) toggles
  maximize and restores the prior layout on repeat. Invariant: hiding chrome
  NEVER removes capability — everything hidden stays reachable via hotkeys and
  the command palette.
  *(Amended 2026-09-16, #818: "restores the prior layout" means wherever it is
  still the prior layout. A maximize holds its snapshot until undone, and since
  #813 it stops rearranging anything after the moment it is taken — so it can sit
  for days looking normal and then replay a stale arrangement. Two narrowings,
  both monotone, both of which can only make the undo do LESS: the gesture only
  reads as an undo while the maximized card is still expanded, and the restore
  skips any card whose rung today is not one that maximize could have produced.
  A card the user rearranged since belongs to a NEWER layout, and replaying its
  old rung would discard the more recent arrangement rather than restore the
  prior one.)*

### 5.9 Notifications & rules engine

Detection is free: Claude Code fires the `Notification` hook when it needs permission
or sits idle awaiting input, and `Stop` when it finishes. On top:

- **Rules**: when [event] in [session | any] → do [actions]. Actions: play sound
  (per-session distinct sounds; optional TTS announcement "TradingApp needs
  permission"), flash taskbar/dock icon, restore/focus window, OS toast, phone push
  (ntfy / Pushover), webhook.
  *(Phone push + webhook shipped P2-E14-06. Decisions taken with them, recorded
  so they are not re-litigated: **(a)** the two are conditioned differently on
  purpose — a push goes to a PERSON and fires only while the app is not focused,
  a webhook goes to a PROGRAM and fires at every visibility and on `done` too;
  **(b)** an action payload carries **no destination** (`{type:'push'}`), because
  a destination in a rule is a credential in the workspace file — the handler
  reads it from the credential store when it fires, which caps v1 at one
  destination per channel and hands a future rules editor a slot NAME to
  reference rather than a value to copy; **(c)** neither channel ever uses its
  service's top priority, which on both ntfy and Pushover means "bypass
  do-not-disturb" — a calm-by-design tool does not get to override the user's
  night; **(d)** no retries and no queue, per P6: a missed push is missed, and
  the Events panel is the durable record. The setup surface is a modal reached
  from the palette and from About, explicitly provisional until E14's settings
  screen exists.)*
  *(Per-session sounds + TTS shipped P2-E14-05a. Decisions taken with them:
  **(a)** the cue **replaces** the unconditional beep in `notifier.ts` rather
  than joining it — one event makes one noise — so the `sound` rule fires at
  every visibility, exactly where the beep did, while `speak` follows the
  toast's WHEN_AWAY (reading out what the user is looking at is slow noise);
  **(b)** the action payload carries **no cue name** (`{type:'sound'}`) for the
  same shape of reason `push` carries no destination: which cue a card rings is
  a property of the CARD (§5.11's identity kit), so the handler resolves it when
  it fires — a rule written yesterday rings whatever the card sounds like today,
  and the empty payload keeps `plannedActions`' dedup honest, which is what
  makes "one event, one sound" true when two rules both ask; **(c)** the bank is
  eight **synthesized** cues (Web Audio, `shared/sounds.ts`), not .wav assets —
  data can be unit-tested, localized and shipped without a licensing question or
  a packaging step, and the cues are chosen to be told APART on a laptop speaker
  rather than to be pretty; **(d)** a cue is **auto-assigned by workspace
  position** and user-overridable, mirroring the accent colour, because a hash
  of the card id collides — with eight cues and four sessions, better than one
  in three — and "distinguishable" cannot be a coin flip. The stated cost is
  that deleting a card can shift the cue of the cards after it; pinning is the
  fix and the manual says so; **(e)** the noise happens in the RENDERER: main
  has no audio device and Chromium has both a synthesizer and a voice, so this
  is one code path on all three platforms instead of three shell-outs
  (`powershell`/`afplay`/`paplay`) with a process spawn on the notification
  path. The cost — no window, no sound — is covered by the beep fallback, which
  makes "an attention event always makes a noise" survive a broken audio
  channel. `SWITCHBOARD_MUTE_AUDIO=1` (non-packaged builds only) makes the sink
  log instead of sound, so the e2e suite proves the whole chain on the machine
  its owner is working at without making a sound.)*
- **Actionable toasts**: permission toasts carry Allow / Deny buttons that send the
  verdict on that session's input route — approve without switching windows.
  *(Shipped P2-E14-04. Three decisions worth recording. **One decision path:**
  the buttons call `SessionIpcHandle.decidePermission` — literally the function
  `sessions:decidePermission` calls — so the toast is a fourth button on the
  path the approval bar, the Events panel and the batch band already share,
  not a second route to the CLI. **The toast names what it would allow**
  ("Allow Bash? npm run build"); an Allow beside the words "needs permission"
  would ask the user to grant a call they cannot see, which is the one thing an
  off-screen decision path may not do. **Clicking the body is not a verdict** —
  it raises the window onto the asking card, because dismissing a notification
  by reflex must not be able to grant a tool call, and because that click is the
  whole gesture on a desktop that cannot render buttons.*
  *Platform reality, verified against Electron 43's API docs rather than
  assumed: `NotificationConstructorOptions.actions` and the `action` event are
  `darwin` + `win32` (Windows toast actions landed in the 40.x line — the older
  "macOS only" folklore is out of date); Linux has none. Where buttons cannot
  render — Linux always, an unsigned macOS build, a Windows dev run with no
  Start-menu AppUserModelID — the click path carries it, and the manual says so
  per OS rather than promising a button that will not appear. A decision made on
  any other surface withdraws the toast; a toast for a dead session decides
  nothing and logs.)*
- Rule conditions include visibility (research v2: Zed's `when_hidden`): fire a
  channel only when the session/app is backgrounded — no toast for a session
  already on screen. This is the calm default for S3.
- Quiet hours / do-not-disturb; missed-events digest per session.
  *(Quiet hours shipped P2-E14-05b. Three decisions worth recording.
  **Quiet hours are a rule CONDITION, not a gate above the engine.** They used
  to sit beside the master switch in `notifier.ts`, returning early — so
  between 22:00 and 07:00 the rules engine was never consulted at all. That was
  right while every channel was a person's ears and wrong the moment `webhook`
  shipped. **The applicability decision (delegated here from #424):
  classification is per ACTION, by AUDIENCE.** `os-toast`, `sound`, `speak` and
  `push` are `person` and are held; `webhook` is `machine` and is delivered — a
  webhook goes to a program the user pointed at this app so that something would
  be watching while they are not, and a log with a hole in it every night is a
  broken log whose cause nobody diagnoses at 9am. A per-rule `quietHours:
  'obey' | 'ignore'` override covers both exceptions (a webhook that flashes a
  lamp; a crash worth waking up for). An unknown action type counts as `person`
  — the two errors are not symmetric. **The clock enters `RuleTrigger`
  explicitly**, injected from one place (`RulesEngineDeps.now`), because
  `rules.ts` is deliberately clock-free and a condition each consumer timed
  independently is a condition three code paths can disagree about. Windows are
  local WALL-CLOCK, so DST resolves the way a person reading their own clock
  would: the autumn hour that repeats is quiet twice, the spring hour that never
  happens is never inside. **Held events are recorded as data** — a bounded FIFO
  (200, oldest dropped) in the workspace store, carrying what/when/which
  card/which channels/why, with the title and body captured at the time rather
  than re-derived later. That list is P2-E14-05c's input. UI: a palette command
  and an About-panel button, deliberately not a twelfth title-bar chip.)*
  *(The missed-events digest shipped P2-E14-05c. Four decisions worth
  recording. **The digest is the suppression record's reader and nothing else
  — there is no `away` reason.** The issue asked for "quiet hours OR app
  unfocused/closed", and the second half was deliberately not built: events
  that happen while the app is merely unfocused are not suppressed at all
  (`WHEN_AWAY` is precisely when the toast, push and TTS DO fire) and they
  already occupy a row in the Events list, so digesting them would re-report
  what reached the user, on the surface already listing it. `reason` stays a
  named field, so a future channel that genuinely holds events adds a member
  rather than reshaping the row. **It renders in the Events drawer's notice
  slot as its fifth tenant**, per #482's design-pressure note and the #407
  gate — no twelfth chip — following `historyRepairs`' shape exactly, because
  that is the same problem already solved: main owns a persisted list, the
  renderer catches up at mount, later entries arrive by push, dismissal is
  durable. **"Clears on review" is an explicit gesture, not sight.** Auto-
  clearing on open would mean checking the drawer for something unrelated
  erases a digest that was never read; so it is a Clear button, and it clears
  BY ID — the ids the digest is accounting for — which is why `clearSuppressed`
  was written id-based and left with no caller. The ids buy that a clear takes
  exactly the rows asked for and cannot take one it was not; they are NOT a
  promise about the render-to-click window, and the notice's heading is derived
  from the same list it sends, so the button and the sentence above it cannot
  disagree about how much is going. **The IPC refuses a missing id list rather than reading it as
  "all"**, even though the store's own signature accepts `undefined` for that:
  across a channel, one dropped parameter would erase a night nobody read, and
  a refusal answers with the surviving list so the renderer can put the digest
  straight back.)*
- **Per-session "notify when done" (owner request 2026-07-22):** a checkbox on
  the session card — done-toasts only for sessions the user opted into (long
  tasks), because a toast for every short turn is noise.
  *(Shipped P2-E14-03. It lives in the card's ⋯ menu, beside the transport
  switch — the established home for a durable per-card setting, and reachable
  from every view, which the composer's options row is not. Implementation
  decision, same item: a ticked box is **its own opt-in**, so it fires with the
  global `osToasts` switch below off — a per-session control that silently did
  nothing because of a global one elsewhere would be a lie. The master
  notification toggle and quiet hours still sit above everything, rules
  included.)*
- **The default signal model (owner decision 2026-07-22):** attention events
  produce a **sound + an Events-panel item + a taskbar flash** (when
  backgrounded). **OS toast popups are OFF by default** — an opt-in
  Settings/Options switch (`osToasts`; stored in notification prefs today,
  settings UI ships with E14's rules engine).

> **As built (E14, audited 2026-09-25): every ACTION in the list above ships; the
> `when → then` model has no authoring surface.** Sounds, TTS, taskbar flash,
> window focus, OS toast, phone push and webhook are all real and all reachable
> from the engine (`main/events/rules-engine.ts` + `rules-ipc.ts`). What does not
> exist is a place for the user to WRITE a rule: E14-03 shipped the engine as a
> "minimal core" whose only consumer is the per-session **notify when done**
> checkbox, and the built-in visibility conditions.
>
> That is not a broken promise — §8's Phase 2 line says "rules engine", and the
> engine is what shipped. It is recorded here because this section reads like a
> user-facing feature and is currently an internal one, and because E14-06's own
> note already anticipates the editor ("hands a future rules editor a slot NAME to
> reference rather than a value to copy"). **The trigger to build it is a second
> rule someone actually wants**; until then the engine's generality is paying for
> nothing, and a rules editor with one available rule would be furniture.

**Reducing prompts at the source (autonomy profiles):** per-session spawn profile =
`--permission-mode` + allowed tools + extra dirs, presented as a slider:
Plan / Ask / Auto-edit / Full-auto. Plus a frequent-prompt learner: recurring
permission asks surface a one-click "always allow X in this session" that writes the
project's settings allowlist. Research v2 refinements (validated: Copilot's
Interactive/Plan/Autopilot dropdown; Antigravity's /goal and /grill-me): the
profile is adjustable MID-SESSION, not only at spawn — via the CLI's own mode
mechanisms where it supports live switching, else flagged "takes effect on
restart" (never faked, P7) — and the active mode renders on the session identity
badge (§5.11) so a glance answers "will this one interrupt me?"

### 5.10 The Session view — the primary working surface

> **Revised 2026-07-21 (owner decision, after hands-on E12 use):** the rendered
> view — previously "the Feed", read-only — is now the **Session view**: the
> tab users actually work in, shaped like the VS Code extension panel. It
> renders the conversation AND accepts prompts via a composer that writes to
> the real CLI on the session's transport. Host-don't-reimplement holds: the
> composer is an input route to the real CLI, never a reimplementation of it.
> (The right-panel *event* feed of §5.12 is unrelated and keeps its name.)

Each session offers two synchronized views of the same underlying session:

- **Session** (primary, interactive): rendered from structured transcript/
  stream events — assistant text, tool calls, diffs, subagent sidechains — as
  styled blocks, with a **prompt composer** docked at the bottom (Enter
  submits to the CLI over the session's transport; options row for autonomy/
  model context, plus **Compact and Clear** (#903, owner request 2026-09-21 —
  the two session controls that were previously only in the card's ⋯ menu; they
  stay in the menu too, because the options row exists only on the Session tab
  and the note under §5.9's "notify when done" is the standing reason a control
  that must be reachable from every view cannot live here alone); typing
  `/` pops a slash-command autocomplete — CLI built-ins + the §5.19
  registry's skills/commands — owner request 2026-07-22). In-app
  approvals (§5.16) render inline here as a review bar.
- **Terminal** (xterm.js + PTY): the real CLI — always present as the
  **LAST tab** (owner reversal 2026-07-22: one day of dogfooding showed
  hide-by-default was friction, not calm — "I like having a terminal").
  The Session view's terminal-handoff BAR jumps there when the CLI
  is in a raw TUI state (menus, /login, trust prompts).
  *(2026-08-01: a session on the stream-json transport has no PTY, so this tab
  has nothing to show. It must say so in one sentence and offer no dead
  controls — E18-08 — rather than render an empty black pane. Whether the tab
  survives at all is E18-16's call, on evidence; see the §6 amendment.)*
  **REMOVED 2026-09-19 (#873) — E18-16's call was made.** The tab, the ⋯
  transport switch, the `view.terminal` command and its `Ctrl+backtick` binding
  are all gone, and stored `transport: 'pty'` cards were migrated onto the Direct
  default. The CODE is still in the tree (`TerminalPane`, `terminal-attach`,
  `PtyService`, `node-pty`), reachable only with `SWITCHBOARD_TRANSPORT=pty`, so
  the fallback is now a **developer** fallback rather than a user-facing one. The
  deletion is E18-11 and waits on its own condition; see
  `docs/plans/05-transport-migration.md`. *(This bullet kept describing the tab as
  "always present" for six days after it was removed — the tab-strip list below
  was annotated and this one was missed.)*

**Block presentation (v2 — modeled on the Claude Code VS Code extension;
owner screenshot 2026-07-21).** The reference look: a clean timeline with a
dot gutter, one block per event, everything collapsible. Block taxonomy:

- **Assistant prose** — markdown, rendered clean (no chrome), **no timeline
  dot** (revised 2026-08-02, #91 — see "The dot marks an event" below).
- **Thinking** — collapsed to a single "Thought for Ns" line (duration from
  timestamps); click expands.
- **Edit/Write blocks** — header `Edit <file path>` + a "Added N lines /
  Removed M" subtitle, then an inline **syntax-highlighted diff preview**
  (added regions green-shaded, removed red-shaded) — the screenshot's
  side-by-side panel; click-to-expand for long diffs. File path links to the
  Changes tab.
- **Bash blocks** — header `Bash <description>` (the tool call's own
  description field), then labeled **IN** (command, monospace) and **OUT**
  (output) sections, each independently expandable, long output truncated
  with click-to-expand.
- **Read/Search/other tools** — one-line collapsed rows (name + primary
  argument), expand for the full input/result.
- **TodoWrite** — renders as an "Update Todos" checklist block, not raw JSON.
- **Subagent sidechains** — folded behind an agent header, indented.

**Tool blocks are BOXES** *(added 2026-08-02, owner feedback 2026-07-26 — #91;
v2 above specified the dot gutter and the per-type layouts and said nothing
about a container, which is the gap this closes).*

A Bash/Edit/Read/Todos block renders inside a **bordered, rounded container** —
a half-step surface lift (`--panel2` on the feed's `--panel`) with a `--border`
edge, in every theme. The point is scannability: Dan, after living in the view,
asked for them "enclosed in some sort of rectangular box to make them easy to
see", because a dot plus some text does not read as a *thing* in a wall of
conversation.

Rules the container carries:

- **The whole box is the expand target**, not the header line it used to be —
  "that box, of course, is clickable so I can expand and see what the bash
  command is". For a Bash block the box toggle is the COARSE one (it opens IN
  and OUT together); the per-section chevrons stay for the finer moves.
- **Interactive children own their own clicks.** The existing expanders (Bash
  IN/OUT, the Edit diff panes, and anything later: copy buttons, file links)
  live inside the box and must never also flip it. Implemented as a marked
  subtree the container stands down for, so the rule lives in one place rather
  than in every child's handler.
- **A drag that ends in a text selection is a read, not a click** — selecting a
  path out of a block may not fold the block away underneath the pointer.
- **A block with nothing to expand gets the box and no toggle** (Todos: a
  checklist is already shown in full, and a pointer cursor promising an
  expansion would be a lie).

**Every expander has a keyboard path, and the box is not it** *(added
2026-08-03, #174 — the gap the boxes above opened).*

The box being the mouse target does not make it the control. A box CONTAINS
other interactive controls (Bash IN/OUT, and later copy buttons and file links),
so it may not be a `button` — ARIA forbids it, and a `role="button"` there would
be a lie a screen reader passes on to its user. The rule §5.32 already sets
("keyboard-complete") is met like this instead:

- **Each expander is a real `<button aria-expanded>`** — the block's header line
  itself. Screen readers announce it and its state; Enter and Space come free
  from the platform rather than from a handler of ours. The box keeps its
  whole-body click as a MOUSE convenience that duplicates the header button.
- **The conversation is one Tab stop** — a labelled `region` — and the arrow
  keys move between the expanders inside it (`↑`/`↓`, `Home`/`End`, `Esc` to
  step back out). A Tab stop per expander would put the composer, which sits
  below the conversation, hundreds of presses out of reach in a real session.
  This is the message-list shape (Slack, Discord), and it costs the expanders
  nothing: `tabindex` does not touch the accessibility tree, so screen-reader
  button navigation still reaches every one of them.
- **Focus is visible at both stops** — the region and the focused expander each
  draw a real ring, on `:focus-visible` so the mouse never paints one.
- **The region is named after its SESSION**, not after its kind *(added
  2026-08-04, #196)*. A grid shows many cards at once, so a landmark called
  "Conversation" on every one of them is N identical entries in a screen
  reader's landmark list — enumerable and useless, which is the same failure as
  having no name. The name interpolates the card's title ("Conversation —
  acme-web") and tracks a rename, which means it reads the title from the
  session store rather than from the panel host: dockview is told a panel's
  title once, when the card is created.

**The composer takes attachments, and only on a typed-message transport**
*(added 2026-08-13, P2-E10-09; owner request the same day).* A clipboard bitmap
pasted into the composer attaches as a removable chip and is delivered to the
CLI as an **inline base64 `image` content block** on the session's stdin —
which is what the VS Code extension does, verified against the CLI on PATH in
one turn. No temp file, no `@path` mention, no flag. Two consequences worth
recording because they are not obvious:

- **This is the first composer capability that is transport-DEPENDENT.** The
  §5.10 composer has always been able to stay transport-ignorant (try the typed
  route, fall back to the PTY) precisely because both routes deliver the same
  thing. A bitmap breaks that: a PTY takes keystrokes and there is no keystroke
  for a picture. So an attachment submission is Direct-only, is refused rather
  than downgraded, and the Terminal-mode case is *said out loud* instead of
  half-sent — a half-sent prompt ("what's wrong with this screenshot?" with no
  screenshot) is the §5.10 guardrail's own failure mode, faked interaction
  included.
- **The CSP holds.** `default-src 'self'` refuses a `data:`/`blob:` image, and
  §5.30 leans on exactly that. The chip's preview is therefore painted onto a
  `<canvas>` from bytes we already hold — nothing is fetched and no URL exists —
  rather than by relaxing `img-src`.

The same chip strip is the landing point for dropped files (P2-E10-10), where
non-image types become `document` blocks.

**The dot marks an EVENT, not an answer** *(added 2026-08-02, #91).* The
timeline dot earns its place on things the session or the user *did* — user
prompts, tool calls, thinking. A plain assistant reply is the answer, and Dan
put it plainly: "when you actually answer me and then are waiting for my next
prompt, I shouldn't need the dot". There it is noise, and it costs the prose its
left margin. **The gutter is unconditional and the dot is not**: an undotted
block still reserves the same column, so the left edge of prose stays flush with
the boxed blocks and the conversation never zig-zags.

Feed customization (the "pleasing to the eye" surface):
- Themes: font family/size, color palette, spacing/density. Themes are CSS;
  preset packs ship in-app, user CSS allowed.
- Per-block-type rules: tool calls `hidden | one-line collapsed | full`; diffs
  `inline | click-to-expand`; thinking `show | hide`; subagent output `folded |
  inline`; timestamps on/off.
- Verbosity presets: `quiet` (assistant text + final diffs only) · `normal` ·
  `firehose`. Per session, switchable live.
- Markdown rendering + syntax highlighting; images/screenshots inline.
- Clicking any collapsed block expands the full content; file paths link to the
  file tree / diff pane.

Guardrail (revised 2026-07-21): the Session view's composer and approval bar
are INPUT ROUTES to the real CLI (a write on the session's transport / a
permission verdict — hook verdict on the PTY transport, a `can_use_tool`
response on stream-json) — the view never fakes CLI behavior it can't route.
When the CLI is in a raw TUI state the
rendered view can't answer (menus, /login, trust prompts), the Session view
shows a full-width terminal-handoff bar above the composer that jumps there
(P2 #125 — it was a header chip until then, and nobody saw it); permission
prompts are
answered inline via the §5.16 hook path, not the chip.

**Startup TUI dialogs (2026-07-23, observed live).** The CLI can open an
interactive dialog BEFORE hooks are up — e.g. 2.1.x's resume-from-summary
picker on `--resume` of a big conversation. The Session view cannot see it
(no hooks, no transcript yet), and a composer submit goes straight into the
dialog — the owner's Enter blindly confirmed the picker. Mitigations: a
session that stays `starting` past a normal boot window surfaces the
terminal-handoff bar (shipped, #125); longer-term, consider muting the
composer (or routing it Terminal-first) while the session has not yet
reached its first SessionStart.

**Interrupt (2026-07-23).** A stop button beside the composer send button —
shown only while the session is `working` — triggers the CLI's own interrupt:
Esc on the PTY transport, an `interrupt` control request on stream-json
(E18-12). Same input-route rule: we send the signal, the CLI decides what
stopping means.

**Per-session view tabs (the session window's chrome).** Every session surface —
grid card, maximized, popped-out OS window — carries one compact VS Code-style
tab strip along its top. The tabs are *views over the same session*, not
separate features:

- **Session** — the rendered + composer view above (first tab and **the
  default view** for every session; renamed from "Feed" 2026-07-21).
- **Changes** — source control for the session's folder: file tree with VCS
  decorations, Monaco diff, editable-diff + commit (§5.7 mechanics as a tab).
  *(As built, audited 2026-09-25: the Monaco diff ships with a side-by-side/inline
  choice (#532); the **file tree and the editable-diff + commit half do not** —
  see §5.7's as-built note, where the tree is Phase 3 and editing is in no phase
  at all. The tab is a read-only diff over a flat file list today.)*
- **History** — the checkout's recent commits/branch state (read-only GitService
  log view; §5.7).
- **Files** — the session folder's file tree (§5.7 decorations); clicking a file
  opens it in the §5.30 document viewer. Listed here because E8-05 already ships
  the tab as a disabled "soon" and §5.30 is what fills it (added 2026-07-30).
- **Inspector** — the §5.19 capability pane (Skills / Agents / MCP / Commands),
  present when opened.
- **Terminal** — the real CLI, always present, **last in the strip**
  (2026-07-22 reversal of the one-day hide-by-default experiment).
  **REMOVED 2026-09-19 — see the amendment below.**

Rules: active tab is per-session and remembered across restarts (§5.25). Any
tab can be **split** beside the Session view instead of stacked behind it (Dockview
panes — e.g. terminal left + diff right, as in the maximized mockup); tabs and
splits are the same views in two presentations. On small grid cards the strip
degrades to an icon row; the two-gesture rule holds — any view of any session
is ≤ 2 gestures away. Litmus: pure chrome — every tab renders data the CLI or
git already owns (host check). *Mockup note:* the Control Room export predates
this spec (it shows only a `Diff | Files | Feed` side-panel mini-strip on the
maximized card); the next mockup pass should show the full strip.

> **AMENDMENT 2026-09-19 (#873) — the Terminal tab is gone, and so is the
> ⋯-menu transport switch.** Owner: *"we don't need the Terminal tab anymore,
> and we don't need the option to switch to Terminal in the menu. Remove the tab
> and the menu item — leave the code behind."*
>
> **What changed.** The strip ships three tabs: **Session**, **Changes**,
> **History**. Gone with the tab: the `panel-terminal` contribution,
> `StreamTerminalNotice`, the `view.terminal` command and its Ctrl+backtick
> binding, and the registration of the Terminal find provider. Cards holding a
> stored `transport: 'pty'` are migrated onto the Direct default on next start
> (workspace schema v1 → v2) — otherwise they would spawn a CLI with no surface
> anywhere in the app that could show it.
>
> **What did NOT change.** This is a UI-level removal and **not** §5.2's
> cutover: `TerminalPane`, `terminal-attach`, `PtyService` and `node-pty` all
> remain, still work, and are still reachable with `SWITCHBOARD_TRANSPORT=pty`.
> E18-16's condition — Direct mode tested in real use — is still what governs
> deleting any of it.
>
> **Two clauses above are retired by this, and one of them matters.** "The
> Terminal's shown/hidden state included" describes state that no longer exists.
> More importantly, **"Terminal-only remains a valid presentation (escape
> hatch)"** is no longer true: there is no escape hatch inside the app, and the
> honest fallback is now running `claude` yourself in the project folder. P7 is
> untouched — the CLI still does the deciding, and we still say plainly where a
> decision it kept actually lives. What we no longer do is offer to take you
> there, because there is nowhere in the app left to go.

### 5.11 Session identity kit

With 7–8 sessions open, "which one is this?" must be answerable in half a second.
Every session carries an identity that renders IDENTICALLY everywhere it appears
(card title bar, sidebar, event feed, toasts, watcher windows, notification sounds):

- **Title**: defaults to folder name (full path in tooltip); user-editable.
- **Accent color**: auto-assigned from a distinguishable palette; user-overridable.
  Applied to card border, sidebar dot, feed entries, toast edge.
  **An accent is a FIELD colour, never a text ink** *(amended 2026-08-10, Dan's
  call, #269)* — a stripe, a dot, a ring, a badge's background. It is chosen to
  be DISTINGUISHABLE from the other seven, which is a different job from being
  READABLE, and unlike the status ramp (§5.20, #221/#243) it cannot grow a
  per-theme ink family to swap in: a second shade of an identity is a second
  identity. Measured as 9px text, all eight accents were 1.80–3.11:1 on the light
  theme and as low as 3.39:1 on the dark one. Where words have to sit on an
  accent, the accent is the field and the words take the one neutral
  `--accent-ink-on-fill`, which is theme-independent for the same reason the
  accents are and clears 4.5:1 on every one of them. Enforced, not remembered:
  `tokens.drift.test.ts` fails any `color:` in the renderer that names an accent,
  and `e2e/theme.spec.ts` measures the badge as painted in all four themes.
- **Icon**: default from project-type detection (`.csproj`→C#, `package.json`→Node,
  `Cargo.toml`→Rust, `pyproject.toml`→Python, …); emoji/icon picker to override.
  Provider badge (Claude/Codex/…) shown alongside.
- **Git context line**: branch · dirty-file count · ahead/behind.
- **Task label**: ~~one-line~~ **up to three lines** of "what am I doing", shown
  under the title. *(⚠️ **AMENDED 2026-09-20, #877, on the owner's direct
  instruction: "at least three lines max", then "default to the full width and
  fill the space, but have options to make it smaller in our options
  settings".** "One-line" was never a layout constraint that earned its keep —
  it was an unexamined inheritance from the six-word prompt this section used to
  specify, and it made the model's answer the wrong shape for the space it had.
  The line budget is now a THREE-VALUE VOCABULARY in `shared/task-label-size.ts`
  — `full` (3) / `medium` (2) / `compact` (1), default `full` — shared by both
  surfaces so they cannot disagree about what "full" means, and the prompt was
  widened to match the room. The clamp is presentation only: the stored label is
  never truncated, the edit box always holds the whole of it, and a screen
  reader is read the whole of it. Compact is byte-for-byte the pre-#877
  appearance, so nobody who preferred the density lost it.
  ⚠️ **The rail row was restructured in the same item**, and that is the part
  with teeth: the row used to show EITHER the label or the state on line 2 and
  never both, so a session that needed you lost its task label at the one moment
  you most want to know which piece of work is asking. The state now sits beside
  the NAME as one short word from the same `status.*` vocabulary the card
  header's pill uses; the longer ask stays in the row's accessible name, where
  nothing is lost.)* User-typed,
  and **auto-filled from the CLI's own session title when the user has not set
  one** — see "Auto task labels" below. *(Revised 2026-07-30: this bullet used to
  read "derived from the last user prompt, optionally LLM-compressed to ≤6 words".
  Both halves are now wrong. The CLI already writes a title, so deriving our own
  is redundant, and compressing it with an LLM of ours would spend the user's
  subscription tokens on chrome — the exact P7 move §5.11 has no business making.)*
  *(⚠️ **AMENDED AGAIN 2026-09-20, #883 — BOTH HALVES OF THAT REVISION ARE NOW
  BACK, and the reason is evidence rather than taste.** The LLM half returned as
  #758, which the owner asked for directly. The prompt-derived half returned
  because **the premise of rejecting it turned out to be false**: "the CLI
  already writes a title" does not hold — measured 2026-09-20, the five newest
  transcripts in this repo carry **zero** `ai-title` lines, and the owner hit
  exactly that in v0.8.92 (first prompt sent, card still blank). So a label
  derived from the prompt is now the INSTANT placeholder, free and non-LLM, and
  the AI pass supersedes it when the turn ends. The 2026-07-30 reasoning is kept
  above rather than deleted: it was sound given what was believed then, and the
  thing that changed is the transcripts, not the argument.)*
- **Plan-as-progress chip** (research v2: Cascade's in-conversation Todo lists,
  Antigravity's Artifacts): when the agent maintains a todo/plan in its transcript
  (TodoWrite events), render it as a live progress indicator — "step 3/7: running
  tests" — upgrading the task label from static text to live plan state. Pure
  read-only transcript rendering (textbook P7). Extraction stability across CLI
  versions is OQ #13.
- **Autonomy badge**: the session's current autonomy profile (Plan / Ask /
  Auto-edit / Full-auto, §5.9) on the card and sidebar — "will this one interrupt
  me?" answered at a glance.
- Optional: per-session notification sound doubles as an audio identity.
  *(Shipped P2-E14-05a. Auto-assigned from a bank of eight by workspace
  position, user-overridable from the card's ⋯ menu, and stored on the CARD
  (`PersistedSession.sound`) beside `transport` and `autonomy` — so it survives
  a resume the way the rest of the identity does. Off by default: the global
  🔊 chip is what turns the one beep into eight cues. Decisions in §5.9.)*

**Auto task labels — the CLI already wrote one** *(added 2026-07-30, owner
request; the Claude Code VS Code extension does the same thing to its tab text).*

A session whose label reads "Switchboard.ai" three times over answers nothing.
The fix costs nothing, because **Claude Code writes a title of the conversation
into its own transcript** — verified 2026-07-30 against 27 real transcripts in
`~/.claude/projects/`:

```jsonl
{"type":"ai-title","sessionId":"bd2517c3-…","aiTitle":"Add markdown and file preview feature"}
```

We are already tailing that file (§5.2). Reading a line out of it is textbook
P7: **the CLI computed the description, we display it.** Deriving our own —
summarizing the prompt with a model call — would spend the user's subscription
tokens on window dressing and is explicitly rejected.

Rules, all four decided by the owner on 2026-07-30:

- **It fills the task label, never the title.** Title answers *which project*
  (folder name — how you find a session spatially); the label answers *what it
  is doing*. Collapsing them costs the first answer to buy the second.
- **User-set is sticky, and clearing reverts to auto.** The session record
  carries `labelSource: 'auto' | 'user'`. Typing anything makes the label yours
  and auto never touches it again; clearing the field to empty hands it back to
  auto. "Is it empty?" is NOT the test — if empty meant auto-fill, a deliberately
  blank label would be impossible to keep.
- **While on auto, it keeps tracking, debounced.** The CLI revises its title (an
  observed session went `"…preview windows"` → `"…preview feature"` one line
  later) and then re-emits the settled value **every turn** — 14 identical lines
  in a 171-line transcript. Last-wins with de-duping, so a repeat costs no render
  and no write. Undeduped, this is a persist-per-turn on every session at once.
- **No title means no label** — the folder name simply stands, exactly as today.

Consequences worth designing for, not discovering:

- **Timing is not guaranteed.** Observed first `ai-title` at line 8 of one
  transcript but line 339 and line 510 of others. The label arrives late or
  never, so the card must reserve its space and never reflow when it lands.
- **This is a §5.3 adapter capability, not a Claude special case.** The
  capability object gains `titles`; an adapter that does not declare it gets
  folder names and no dead code path. *(As built the object is
  `{ transcripts, hooks, titles, resume, trust, mcp }` — `mcp` landed in
  P2-E11-03; see §5.3's "as built" note. Its decision belongs in
  `sessions/start-plan.ts` with the rest.)*
  **As built (P2-E7-06):** `titles.titleFrom(line) => string | undefined` — a
  per-LINE reader, not "read the title out of this file". The host is already
  tailing line by line, so handing the adapter the file would make it re-read
  bytes we have decoded, and a per-line reader means the title tracks the
  conversation for free. `ai-title`/`aiTitle` appears exactly once in the tree,
  in `providers/claude.ts`. It is the only capability asked per line, so unlike
  the other four a throw degrades it to absent **for the rest of the session**
  and is reported once — reporting per line would flood the log at transcript
  speed.
- **`ai-title` is undocumented.** No Claude Code contract promises the key
  exists or keeps its name, which makes it a §5.26 version-drift item and the
  natural second customer for the transcript drift detector. Fail-open is
  structural here, not a nicety: the failure mode of a missing key is "the label
  stays empty", which is where the app already lives.
- **The label reaches OS toasts and taskbar text**, where "Add markdown and file
  preview feature needs your input" beats "Switchboard.ai needs your input" —
  the §5.11 problem statement, solved. It also means a prompt-derived phrase
  leaves the app window, so a screen-sharing user needs a way to suppress it:
  notification text falls back to the title when auto labels are turned off
  (§5.9 preference, off-switch per litmus #4).
  **As built (P2-E7-06):** the switch is a WORKSPACE setting (`autoLabels`,
  default on, the `autoTrust` shape) surfaced as a title-bar chip, not a key in
  the notification prefs. §5.9's prefs are about notifications; this governs the
  card first and the toast second, and the person who needs it off needs it off
  mid-screen-share without hunting. Off HIDES rather than deletes: every auto
  label leaves card, rail and toast at once, a label the user TYPED is never
  hidden (those are the user's words, not the CLI's), and flipping back restores
  instantly from a value that was never thrown away.

### 5.12 Events — what needs the operator NOW

> **Revised 2026-07-22 (owner decision, hands-on E10 use).** Renamed
> **"Events"** (UI + code). The panel is NOT a log — it answers "what needs
> me / what just finished". Core semantics:
>
> - **One item per session**: the session's LATEST attention state. A new
>   event from a session replaces its previous one.
> - **Resolved means gone**: a granted permission / answered input removes
>   the item (the status change to `working` clears it). A `done` stays
>   until that session produces something newer.
> - Each item shows the **session name** with the **task label** beneath it
>   (never raw session ids).
> - **Filters** (per the main-window-v1 mockup): All · Needed · By-session.
> - **Questions queue (placeholder)**: when a session needs clarification
>   ("answer these 3 questions"), the item should expand into a small list
>   the operator can come back to — spec'd when E14 lands.
>
> **Shipped in P2-E14-02 (2026-09-22).** *Needed* is the attention queue's
> own predicate (`queueable`), so it hides the reviewed tail and nothing else.
> *By session* is rail order: the feed is already one item per session, so
> "group by session" can only mean listing rows where you'd look for that
> session. A needs-permission row carries **Allow · Allow all · Deny**,
> answering from the renderer's held-request ledger. **Allow all** is the card
> bar's standing grant, plus an allow for everything that session already
> holds. The questions list is **read-only**, with an "Answer in session"
> jump: an allow with no `answers` discards a question (#563), so a blind
> answer is not offered.
>
> A full history/audit view (the original "operator's log") may return later
> as a separate surface; the Events panel itself stays a to-do list.

A dockable panel receiving typed events from every session. Clicking an event
restores/focuses its session (and scrolls to the relevant spot where
applicable). Inline actions on the event itself where possible.

| Event | Payload / inline actions |
|---|---|
| Done | task label, duration, diff stat (+42 −7, 3 files) · [View diff] |
| Needs permission | what's being asked · [Allow] [Deny] (sends the verdict on the session's input route) |
| Needs input | preview of Claude's question · click → jump to terminal |
| Error / crash | exit info · [Restart & resume] |
| Stalled | no output for N min · [Peek] [Nudge] |
| Subagent started/finished | subagent name · click → watcher |
| High usage | burn-rate threshold crossed (tokens/hr) |
| Rate-limit warning | 5-hour window / weekly cap headroom low |
| Git | commit created; cross-session same-file conflict detected |
| Context handoff | A → B transfer occurred · click → see injected package |
| Service status | Anthropic incident started/resolved |

Feed mechanics: severity tiers (info / attention / warning) with visual weight;
filter by session / severity / type; "group by session" toggle; attention-tier
events also enter the attention queue (§5.8) — the feed is the log, the queue is
the to-do list.

### 5.13 Usage & cost tracking

**Usage is FIRST-PARTY and native (decided 2026-07-29).** switchboard.ai parses
Claude Code transcripts for its own usage numbers, in TypeScript, in this
repo. **ClaudeMon integration is dropped** — not deferred pending a decision,
decided against for now; it lives in §10 as a possible future addition.

*Why native, so nobody re-opens it cheaply.* ClaudeMon is .NET 10, so a shared
library was never available: you cannot link .NET into an Electron main process
without shipping the runtime, which collapses "shared library" into "sidecar."
A sidecar means a .NET runtime on three OSes, a second toolchain in CI, and a
second code-signing burden — bought for work that is read JSONL, sum integers,
multiply by a table. Sidecars earn that when they wrap something genuinely hard
to reimplement; this is not that. Phase 3 already plans a `utilityProcess`
offload (§5.23), which is the natural home for a usage engine, in TypeScript.

*ClaudeMon's source remains a REFERENCE, and a valuable one.* The expensive
part is not its code — it is what it knows about the transcript format, which
is invisible from the format itself. Any implementation here must honour:
streaming writes several lines per assistant message repeating the same usage
(dedupe on `messageId:requestId`); `usage.iterations` mirrors the top-level
totals per internal iteration and must **never** be summed on top;
`<synthetic>` is the model on locally-injected messages that never hit the API;
cache writes split by TTL (`ephemeral_5m` / `ephemeral_1h`, different rates)
with a fallback when the breakdown is absent; model ids need normalizing for
Bedrock's `anthropic.` prefix, Vertex's `@` suffix and the API's date suffix;
and a purely NUMERIC suffix means a new model **version** at a new price, so an
unknown version must show tokens with **no cost** rather than a confident wrong
number at the old rate. The pricing table is **data, not code** — a JSON file
keyed by model, so a price change is a data edit.

Per-session attribution matches the CLI's own ledger for everything the CLI
records: each session maps 1:1 to a transcript JSONL plus its subagent files,
and every assistant entry records token usage (input/output/cache read+write).
**Subagent sidechains do NOT land in the parent's transcript** — they are
separate files, `<uuid>/subagents/agent-*.jsonl` (corrected 2026-09-15, #807;
this sentence said the opposite and was wrong on every CLI measured) — so they
are folded into the parent's totals explicitly. Counting rule, measured against
`cost-state.modelUsage` over 25 single-run sessions: **one contribution per
`message.id`, and a later copy REPLACES the earlier one** rather than adding to
it. (Not `message.id:requestId`: no response id ever carries two request ids,
and 16 carry none.) Streaming writes a message several times; in subagent files
the copies carry a growing `output_tokens`, so "first copy wins" under-counts
output by up to a third and "every copy" over-counts every field 1.5–7×. With
the rule, input and both cache fields land at 0.98–1.013 of the CLI's figure
(most at exactly 1.0000) and output at 0.97–1.00. The CLI also bills side
queries (e.g. a Haiku row) that it writes to no transcript, which makes our
totals usually LOW — but not a guaranteed floor: one session read 1.3% high.
**A resumed conversation is unmeasured:** we replay the whole file, the CLI
appears to restore its ledger from the last `cost-state` on resume, and the
corpus holds no resumed session with two non-empty ledgers to check that
against.
Dispatched sessions (§5.15) are their own sessions → counted separately.

Surfaces in switchboard.ai:
- **Sessions-rail usage bars**: thin per-row bar showing each session's SHARE of
  usage in the current 5-hour window (relative, exact). Four sessions, one
  glutton → one long bar, three stubs. Hover: tokens in/out, cache hit ratio,
  burn rate (tokens/hr), real dollars for API-key sessions. "Sort by usage"
  reorders the rail.
- **Threshold highlight**: burn rate over a configurable line → amber tint on
  the bar + "high usage" Feed event (rules engine) — the glutton comes to you.
- Per-session usage chip on each card: tokens + est. cost this session/today.
- **Status-bar Max-plan meter**: GLOBAL 5-hour window + weekly headroom. Rail
  bars show the breakdown; together: "62% used — mostly TradingApp."
- Precision honesty: share-of-usage per session is exact; "percent of plan" is
  a global ESTIMATE (plan-limit weighting is unpublished) — never fake per-
  session plan %.
- Mission-control dashboard (Phase 3 core, promoted — see §8) inherits all of
  this per session.
- Mockup v2 note: add usage bars to the sessions rail.

> **As built (audited 2026-09-25) — the ENGINE is done and one of the five
> surfaces is.** The split is worth stating because #715 was filed against this
> section as though the whole thing were missing, and it is not.
>
> Shipped: the transcript ledger (`main/transcripts/usage-ledger.ts`,
> `cost-state.ts`) implementing the counting rule measured above — one
> contribution per `message.id`, later copy replaces earlier, subagent files
> folded in — plus the **per-card usage readout** (`UsageStrip`, E7-01 #787),
> which shows tokens as the exact primary signal and names which cost source it
> is quoting (our estimate while running, the CLI's own number once ended).
>
> Not built, and all Phase 3 per §8: **sessions-rail usage bars**, the
> **burn-rate threshold highlight + "high usage" Feed event**, the **status-bar
> plan meter**, and **sort-by-usage**. That is the fleet-level half, and it
> shares plumbing with the mission-control and review dashboards — which is why
> §8 and `03-later-phases.md` both say to plan those three together rather than
> shipping the rail bar alone.
>
> ⚠️ **One shipped behaviour still contradicts this section.**
> `renderer/src/lib/usage.ts`'s `estimateCostUsd` lives in the renderer's UI
> layer and **defaults an unknown model to Sonnet rates** — it invents a number,
> which the rule above forbids in as many words ("an unknown version must show
> tokens with **no cost**"). Recorded in `03-later-phases.md` since 2026-07-29 as
> a thing to fix when usage work is scheduled; recorded here because it is a
> spec violation that is live in the app today, not a plan note.

### 5.14 Provider service status

- Poll Anthropic's Statuspage JSON (`status.anthropic.com/api/v2/status.json`,
  `/api/v2/incidents/unresolved.json`) every few minutes.
- Status-bar dot: green/yellow/red + tooltip with active incident summary; incident
  start/resolve emits Feed events.
- **Local corroboration**: if multiple sessions concurrently hit API errors/overload
  responses, raise a "possible provider issue" banner even before the status page
  updates (status pages lag reality). Per-provider once adapters exist.

**Status bar** (bottom of main window): service health dot · plan-usage meter ·
active sessions count · attention-queue count.

### 5.15 Dispatch — session-to-session handoff

Motivation (owner-observed, mechanism understood): a code review run in a FRESH
session finds issues that an in-session/workflow review misses. The in-context
reviewer inherits the author's framing and reviews the intent; a clean session must
reconstruct understanding from the artifact alone. The missing context is the
feature — so Dispatch makes context amount a deliberate, per-role choice.

**Role templates.** A dispatch target = saved template: startup/role prompt,
autonomy profile, own identity (icon/color), workspace policy, and a **context
policy**:

| Policy | New session receives | Default for |
|---|---|---|
| Clean-room | Artifact only: diff + task statement + acceptance criteria. No reasoning history. | Code review |
| Briefed | Level-2 handoff package (§5.5): goals, decisions, files touched | Docs, PR authoring |
| Full | Fork-session adoption (§5.5 L3) | Rare; continuation work |

Built-in templates: Code Reviewer, Doc Writer, PR Author; user-defined templates
are first-class.

**Workspace policy.** For review: spawn in a fresh worktree checkout of the
author's branch (reviewer can run tests without touching the author's tree).
Per-template: same-folder | fresh-worktree | fresh-clone.

**Triggers.**
1. Manual: session-card button / command palette "Dispatch → <template>".
2. Agent-initiated: new Session Bus tool `spawn_session(template, briefing)` —
   the author session dispatches its own review when it believes it's done.
3. Automated: rules engine — "on `done` + tests passed → dispatch clean-room
   review". (The owner's existing auto-review workflow, upgraded with fresh eyes.)

**Round-trip.** Dispatched session's result returns as a Feed event on the parent
("Review of @X complete — 3 findings") with one-click "inject findings into author
session" (normal sibling-message delivery, §5.4 policy applies). Optional bounded
loop: fix → re-dispatch → until clean or N rounds → attention queue.

**Lifecycle & lineage.** Dispatched sessions nest under the parent in the sidebar
("↳ Review of X"), are ephemeral by default (auto-archive after result delivery;
linger/pin options like watchers), and lineage is recorded so the Feed can show
the chain: authored → reviewed → fixed → merged.

**Dispatch vs subagents.** A subagent runs inside the parent session and shares
its fate. A dispatched session is a full peer: own top-level context (the point),
own terminal the user can enter, own permissions, own identity. Skills are how a
session does work; Dispatch is how work moves between sessions. No competitor in
the 2026-07 research expresses this workflow — it composes Session Bus + context
transfer + role templates, all already in the design.

> **As built — E13-01 (#946), the model only.** The role template is real
> (`shared/dispatch.ts`), persisted (`workspace.json` → `dispatchTemplates`), and
> the three built-ins are CODE rather than user data, so they improve on upgrade
> and editing one yields a copy. Both policy unions are closed and complete; the
> **context policy has one place that maps it to a context source**
> (`CONTEXT_SOURCE`), which is what #947 builds against. Nothing dispatches yet.
>
> **Four things this section says that v1 declares and REFUSES with a reason**,
> rather than half-building or silently degrading:
>
> - **`fresh-worktree` and `fresh-clone`** — worktree create/merge-back is Phase 3
>   (#949's scope call). Telling a reviewer it has an isolated checkout while it
>   runs tests in the author's live tree is the surprise §5.7's isolation caveat
>   exists to prevent, so the refusal is explicit.
> - **The `full` context policy** — it needs §5.5 L3 fork adoption (#801), which is
>   experimental and off by default. Falling back to `briefed` would hand a
>   continuation session a summary and let it believe it had the conversation,
>   which is §5.5's own honesty rule from the other end. One table entry is the
>   only line that changes when a later item wires it. **(#947 wired it — see
>   below. The entry is still there; it is now conditional.)**
> - **Triggers 2 and 3** (agent-initiated `spawn_session`, rules-engine
>   auto-dispatch) are Dispatch v2 — #948's scope call.
>
> **Two things this section names that the model deliberately does NOT carry**, so
> the later item that owns them is free to shape them: **ephemerality** (the
> lifecycle paragraph is #951's) and **an icon**. There is no icon vocabulary for a
> session in this app — the one badge slot a card has is §5.11's project-type badge
> — and overwriting it with a role glyph would make one badge mean two things.
> Colour is what the rail paints, so colour is what a template carries; the §5.11
> palette moved to `shared/accents.ts` so that a template could name one without a
> second copy of the hex values.
>
> **As built — E13-02 (#947), what each policy actually hands over.** The table
> above is now three implementations, chosen by `CONTEXT_SOURCE` and by nothing
> else (`main/sessions/dispatch-context.ts`). Still no gesture: the bundle is a
> value, and #948 is the caller.
>
> - **Clean-room is a SUBTRACTION, and it is built as one.** `clean-room.ts` is a
>   pure function of an *artifact* — a diff (from `get_session_diff`'s own answer,
>   #764, not a second git call), the task statement, and optional acceptance
>   criteria. It never sees a transcript, a derived block or a context package, and
>   the test suite asserts that against the module's SOURCE TEXT as well as
>   behaviourally, because the obvious implementation — #766's generator with a
>   "leave the reasoning out" flag — puts the withholding one boolean away inside a
>   generator whose whole job is carrying reasoning forward.
> - **Only the OPENING prompt is the task statement.** Later user turns would pass
>   any "no assistant text" filter — they are prose the user typed — and they are
>   exactly the author's framing ("no, do it the other way round"). §5.15's table
>   says *task statement*, so the bundle carries the opening prompt and stops.
> - **Acceptance criteria are caller-supplied, and absent means it SAYS so.**
>   Nothing in a transcript is labelled "acceptance criteria"; extracting the
>   nearest list-shaped prose and printing it under that heading is the same
>   confident-wrong-answer failure §5.5's "Decisions" section refuses.
> - **No diff is three sentences, not a blank** — a clean tree, a folder that is
>   not a repo, and a git that would not answer imply three different next moves,
>   and a reviewer told "here is the diff" and handed nothing reviews an empty
>   change.
> - **Briefed is a CALLER, not a second generator.** It is
>   `sessionContextFor(id, 'package')` — the same call `get_session_context`
>   answers with — and every field is copied. The text a briefed dispatch receives
>   is byte-identical to the text an agent pulling context gets, which is what
>   makes one honesty rule cover both.
> - **⚠️ `full` IS NOW REACHABLE, which reverses one line E13-01 wrote.** #946
>   refused it outright on the grounds that v1 would not build it; #947's spec says
>   *"reachable only with the experimental flag on"*, and it is right — #801
>   shipped. `contextPolicyRefusalKey` takes an optional `DispatchGates`, and
>   **omitted still means refused**, so no caller written before the gate changed
>   meaning. A `full` dispatch is refused three ways, each naming a different fix:
>   the flag is off, the target runs on a different provider (§5.5 — transcript
>   formats are not interchangeable), or the author session has no conversation to
>   adopt yet. The last two need a provider and a record, so they are settled at
>   dispatch time and not in `shared/`: `undefined` from `templateRefusalKey` means
>   "nothing to grey the menu row out for", never "this will work".
> - **⚠️ A COMPACTION SUMMARY IS NOT THE USER SPEAKING, and fixing that changed
>   §5.5's package too.** The CLI writes its own out-of-context recap onto an
>   ordinary non-meta, non-sidechain `type: 'user'` line, so every filter
>   `promptText` applies let it through — model-written prose summarising the
>   author's whole conversation, arriving in the one document built to withhold
>   exactly that. Found in review; the repo's own fixture holds one 14,452
>   characters long. Compaction entries are now dropped at the entry boundary in
>   **both** readers, which means the Level-2 package no longer prints one under
>   **Goal** or among the user's instructions either — it was a misattribution
>   there as well, and leaving it would have been one rule with two answers.
> - **A fork returns an INSTRUCTION, not a document** — `{ sourceSessionId,
>   sourceFolder }`, which is `sessions:create`'s existing `forkFrom` operand. It
>   is the author's native conversation id and the author's folder, neither of
>   which is the dispatched session's; `StartPlan.requestedFork` spends a paragraph
>   on why collapsing them looks right for the same-folder case and silently
>   answers "no such conversation" for the cross-folder one.
>
> ⚠️ **One default was a guess and is marked as one in the code**: the built-in Code
> Reviewer runs at `plan`, chosen for the CLI's own write block (§5.16's plan-mode
> rule says nothing in-app may Allow past it). But exiting plan mode is an approval
> the CLI keeps, so a plan-mode reviewer may park waiting for a human who by
> definition is not watching. **#948 must measure that rather than assume it**; if
> it parks, the default becomes `ask` plus a deny-writes story, and learning it
> before #950 builds the round-trip is much cheaper. **#948 measured it — see
> below.**
>
> **As built — E13-03 (#948), the gesture. Trigger 1 is real.** `Dispatch…` on the
> card's ⋯ menu and one `session.dispatch.<template>` entry per role in the
> palette, both landing in one dialog; a card whose first turn is the briefing;
> and the autonomy question settled by measurement rather than by argument.
>
> **⚠️ THE `plan` DEFAULT SURVIVES, AND THE FEAR WAS REAL ANYWAY.** Probed against
> claude 2.1.280 on the stream transport, written up in
> `spike/findings/e13-948-plan-unattended.md`. Five things, and the fifth is the
> surprise:
>
> - a plan-mode review **finishes unattended** — one run reached `result` in 19 s
>   with **zero** control requests, because a model asked to *report* reports;
> - but the same prompt **reaches for `ExitPlanMode` anyway** when it decides to
>   write its findings down, **and retries after a refusal** — one run asked twice,
>   31.7 s and 36.9 s apart;
> - an **unanswered** one parks the CLI indefinitely (120 s, no `result`) — which
>   in the app means the 300 s `StreamPermissions` deadline, twice, with the
>   attention machinery ringing for a question whose only in-app answer is the one
>   it will get anyway;
> - a **denial costs the findings nothing** — both denied runs produced their full
>   review;
> - and **plan mode's write block holds**, measured twice, including a control at
>   `acceptEdits` that proves the model genuinely tried. **But a plan-mode `Write`
>   does not fail: the CLI redirects it into `~/.claude/plans/`, named after the
>   prompt.** The author's tree is untouched, which is the guarantee `plan` was
>   chosen for — but a dispatched reviewer can leave litter outside anything
>   switchboard tracks, and **#950 should not expect a findings FILE**.
>
> So the fix is the deny-writes story #946 predicted, *underneath* the default
> rather than instead of it: a dispatched session's `ExitPlanMode` is refused **at
> once** (`StreamPermissions.setDispatched`), narrowly — every other held tool on a
> dispatched session is a genuine "this needs a human" and the attention queue is
> the right answer for it. `ask` was never better: it gates `SHELLISH ∪ MUTATING`
> in our own hold policy, so an `ask` reviewer reaching for a write parks on OUR
> hold, having given up the CLI's write block to get there.
>
> **And the mark lifts the moment a person types into the session**
> (`clearDispatched`, called from `sessions:submitPrompt` and from nowhere else).
> Found in review: without it, §5.15's own premise breaks — a dispatched session is
> a full peer the user can *enter and type at*, so a user who opens the reviewer
> they just dispatched and asks it to make the fix would be told "nobody is sitting
> in front of it" while sitting in front of it. A typed prompt is the proof, and it
> is proof precisely because `delivery.ts`'s automatic sibling send does **not** come
> through that channel — an auto-accepted message is a session running with nobody
> there. Two smaller review findings on the same branch: the gain is **duration, not
> silence** (the beep has already fired at the pump one message earlier), and the
> branch must not walk the session back to `working` while a *different* request is
> still held — parallel tool calls make that reachable, and it would hide a genuine
> hold behind a card claiming to be working.
>
> **⚠️ THERE IS A DIALOG, WHICH §5.15's "Dispatch → <template>" DOES NOT ASK FOR**,
> and the reason is a second measurement. #947 found that `taskStatement` answers
> **`"do it."`** for a session started from a slash command — correct, and nearly
> useless, because what precedes it is command plumbing and an `isMeta` line.
> Clean-room is defined by withholding everything else, so that one field has to
> carry the job and it is the field most likely to be empty. A menu row that
> dispatched in one click would hand a reviewer a review of nothing, and #950's
> round-trip would be built on it. So the gesture offers a **task line, prefilled
> and editable**, beside the `acceptanceCriteria` seam #947 already shipped —
> **and a blank line is honoured as a choice**, printing "not known" rather than
> quietly restoring the `"do it."` the user just deleted. The dialog is also the
> only place a refusal that needs a provider or a record (#947's cross-provider
> fork, its no-conversation case) can be read *before* a turn is spent.
>
> **⚠️ BOTH FIELDS ARE OFFERED ONLY FOR `clean-room`, and review is why.** The first
> cut showed them for every role, which was a promise the code did not keep: the
> `context-package` branch reads neither (#766's package derives its own Goal, and a
> second source for one fact is the drift #947 refused), so a user writing a careful
> task for a PR Author got a PR authored from a package that never saw it — and the
> copy asserted the effect too. Hiding them keeps ONE answer per fact and teaches
> something true: clean-room is the policy that needs you to state the task, because
> it has nothing else. It also makes `taskStatement` a genuine THREE-state field —
> absent (read the transcript), empty (the user cleared it), stated — with all three
> reachable from the UI rather than two of them theoretical.
>
> **The briefing never crosses to the renderer, and the template never crosses
> inward.** `dispatch:prepare` builds the document in main and hands back an opaque
> single-use handle that rides `CardParams` to `sessions:create` — the same path
> `forkFrom` already travels. Two reasons the text stays put: a clean-room bundle is
> defined by what it withholds, and panel params are serialized into the saved
> layout, so a briefing in one would write the author's diff into `workspace.json`
> for ever. Inward, only an **id** travels, which is #946's contract stated in the
> type system: `isSaneRoleTemplate` refuses the `builtin:` namespace, so a predicate
> validating a template object would refuse the three templates a fresh install has.
>
> **Single use is the safety property, not tidiness.** A panel param is re-sent on
> every remount and every restart, so without consuming it a reviewer would be
> briefed a second time mid-conversation in the voice of a user who typed nothing.
> A handle that no longer resolves starts an ordinary session and says which card
> lost its briefing — fail-open (P6), because a restored layout must still start.
>
> **What the gesture refuses rather than half-doing:** a dispatch with no
> typed-message transport is refused **before** the spawn, because `submitPrompt`
> needs a stream handle and a live card wearing a role with no instruction in it
> looks exactly like a dispatch that worked.
>
> **Found and fixed in passing, on the line dispatch had to touch:**
> `CardParams.forkFrom` had been written into the panel since #801 and **never
> forwarded to `sessions:create`** — so every "fork this conversation" from the ⋯
> menu since that item landed started an ordinary session, and main's whole fork
> path was unreachable from the UI. Fixed here because #948 needs the identical
> forwarding one field along.
>
> **Still #951's, and deliberately untouched:** lineage nesting ("↳ Review of X")
> and ephemerality. A dispatched card is titled `<role> of <session>` and is an
> ordinary card in every other respect; a title that tried to be the nesting would
> have to be unpicked when the real nesting arrives.

> **As built — E13-04 (#949), the workspace policy. v1 is `same-folder`, and
> that is now said out loud.** The paragraph above wants a fresh worktree for
> review. **It is not built and it is not faked.** A dispatched session runs in
> the author's own folder: `dispatch:prepare` resolves the author session and
> returns *its* folder, the renderer creates the card at exactly that folder, and
> `dispatch.spec.ts` asserts the two are the same place end to end — which is the
> only level at which that can be proved rather than inferred.
>
> **Most of this item was already standing when it was picked up**, which is worth
> recording because the issue queue could not show it: #946 declared the union and
> the refusal keys, #947 wrote the parallel refusal for `full`, and #948 put the
> refusal on the template row and on the disabled Dispatch button. What #949 added
> was the missing half of *declared* and refused, plus the proof.
>
> - **A row names both of its policies now.** It said what the role is handed and
>   never where it runs, which made the refusal unreadable in both directions: a
>   `fresh-worktree` row showed a red sentence refusing a worktree it had never
>   said it wanted, and `same-folder` — the policy that ships, and the one whose
>   consequence a user should know — was invisible.
> - **The dialog names the actual folder**, from `DispatchOptions.folder`. That is
>   **main's `queries.resolve`, the same call `prepare` makes**, not the renderer's
>   copy of the card identity: two descriptions of one folder can disagree, and the
>   one on screen would be the one that spawned nothing. It sits **below** the role
>   list and appears only for a role that **will actually run** — the predicate is
>   the whole refusal, not the workspace half of it. Review caught both: above the
>   list it shifted every row under the pointer as the selection changed, and a
>   workspace-only check printed a folder under a `full` role the fork flag had
>   already refused.
> - **It matters more than it looks.** A reviewer in the author's folder runs its
>   tests against the tree the author is editing. That is precisely §5.7's
>   isolation caveat, and precisely why `fresh-worktree` is refused rather than
>   silently downgraded to this.
>
> **⚠️ THERE IS NO WORKSPACE PICKER, AND THAT IS THE ANSWER TO THE DONE-WHEN, NOT
> AN OMISSION.** The issue offered two: ship the picker with two options disabled
> and labelled (§5.32's "announced as unavailable, not absent"), or ship one value
> and document the gap. Neither is quite available, because **there is no template
> editor to put a picker in** — #948 declined to build one and said so, and the
> only way to author a template today is by hand in `workspace.json`. Building an
> editor to hold a disabled radio button is the half-build this item exists to
> refuse. So the value is **declared where it is chosen** (all three names are
> storable and round-trip through `workspace.json` — pinned by a test named
> "ACCEPTS a policy v1 cannot carry out — storable is not dispatchable") and
> **refused where it is dispatched**, with the reason on the row. When the editor
> arrives it gets the picker, and §5.32 applies to it then.
>
> **What Phase 3 deletes:** the two rows of `WORKSPACE_POLICY_REFUSAL_KEYS`, their
> two sentences in `en.json`, and the `same-folder` condition on the dialog's
> folder line. Everything else — the union, the storage, the DTO field, the row's
> workspace phrase — is already shaped for three answers, and a test now fails the
> moment either union grows without its catalogue sentences, because the dialog
> builds `dispatch.workspace.<policy>` from a union member and i18next renders the
> raw key when it cannot resolve one.

### 5.16 Approval surfaces — rich edit review

Pain point (owner, VS Code extension): edit approvals are a tiny checkbox on an
opened file tab, or a jump back to the session tab. switchboard.ai replaces the
approval UI entirely rather than decorating it.

> **Plan-mode rule (owner decision 2026-07-23):** plan sessions are NEVER
> held in-app. A hook `permissionDecision:'allow'` bypasses the CLI's whole
> permission system — including plan mode's write-block — so an in-app Allow
> would let a "read-only planning" session write files. The CLI's own plan
> enforcement is authoritative; in-app approvals apply to ask/auto-edit.
> Also settled: "Allow all (this session)" is scoped to the LIVE session
> (a respawn/resume prompts again), held requests QUEUE per card, a hold
> auto-surfaces the Session tab, and pending holds replay to a reloading
> renderer so a missed push can never park the CLI.
> Refined 2026-07-23 (owner's phantom-beep find): allow-all is answered in
> the MAIN process — a granted session's gated calls never hold, never
> emit needs-permission, never beep; the grant dies with the live session.

**Mechanism.** `PreToolUse` hook on `Edit|Write|MultiEdit` fires BEFORE execution
with the full proposed change (file path, old/new content) and can RETURN the
permission decision (allow / deny / ask). Flow: hook fires → switchboard.ai renders
the change → user decides → hook returns decision → CLI proceeds. The TUI prompt
never appears. Hook-timeout fallback: no response in time → "ask" → normal
terminal prompt (nothing ever blocks on switchboard.ai).
*Verification spike needed early:* exact decision semantics vs the TUI's richer
options ("yes, don't ask again"). ~~Fallback plumbing if hooks can't express it:
detect prompt via Notification hook, render our diff, send keystrokes to PTY —
same UX, uglier mechanism.~~ **That fallback is REJECTED (2026-07-31).** It is
screen-scraping a decision the CLI kept, which the amended P7's third line
forbids outright and PHILOSOPHY §5 records as precedent (S-09 option 3): a
mis-parse answers the wrong question on the user's behalf. Where hooks cannot
express it, the answers are the stream-json transport (below) or saying plainly
that the decision lives in the terminal (§5.10's handoff bar).

> **The mechanism above is transport-scoped (added 2026-08-01, E18-01).**
> Everything in this section describes the **PTY transport's** approval path,
> and it is bounded by the hook ceiling recorded in §5.2: a hook's `allow` does
> not satisfy the CLI's `.claude/` safety check, so those prompts cannot be
> answered here at all. On the **stream-json transport** the CLI delegates the
> same decision as a `can_use_tool` control request — richer payload
> (`decision_reason`, `decision_reason_type`, `permission_suggestions`), no
> hold-and-release dance, and the `.claude/` case included. **This section is
> rewritten by E18-07, which builds it** — deliberately not before, so DESIGN
> keeps describing what exists rather than what is planned. The plan-mode rule
> above is one of the things E18-11 re-examines: it rests on hook semantics that
> the control channel may not share.

**The approval card.** Session identity banner (color stripe · icon · name · task
label) + file path + full Monaco diff (side-by-side/inline) + button row:
Approve · Approve all in this file · Always allow for this session (writes
allowlist via §5.9 learner) · Deny · **Deny with feedback** (objection text is
returned as the denial message so the agent knows why).

**Placement modes** (user preference):
1. **Session-flip**: the session card flips to review mode — diff + approval bar
   on top; flips back on decision. Best when already watching that session.
2. **Review queue pane**: pending approvals from ALL sessions line up in one
   surface; arrow through, Enter to approve — a PR-review flow for live agent
   edits. Feeds the attention queue (§5.8); batch-groups similar prompts.
3. **Floating approval window**: pops centered above other apps, decide, gone.

**Grouping.** Multi-file logical changes group into one card: file list +
per-file diffs; approve the batch or cherry-pick. Non-edit permissions (Bash,
reads) get simpler cards — command + cwd + allow/deny — same banner, same keys.

> **As built (E10, audited 2026-09-25) — this section is the one the app is
> furthest behind, and it is the epic the plan called "the crown jewel."**
>
> What ships and works: the `PreToolUse` hold and decision round-trip (E10-03),
> the inline bar on the Session tab (E10-04), **session-flip** as the placement
> mode, batch grouping across sessions with per-member and approve-all buttons
> (E9-11's `BatchApprovalBar`), always-allow-for-this-session, and deny. A real
> permission is answered in-app without touching a TUI — exit criterion 3 is
> genuinely met.
>
> **Four things in the paragraphs above do not exist**, and none of them is
> tracked by an issue as of this audit:
>
> - **The diff is not Monaco.** It is two `<pre>` panes tinted with the diff
>   tokens and **truncated at 1500 characters each**. For a one-line edit that is
>   honest and fast; for the multi-file change this card exists to review it is
>   not a review surface at all. Monaco is already in the bundle and already
>   diffing in the Changes tab, so this is wiring, not new capability.
> - **"Deny with feedback" is absent.** The decision wire is
>   `'allow' | 'deny'` with no message field, so the objection text this section
>   promises has nowhere to go. The agent learns it was refused and never learns
>   why — which is the difference between a correction and a wall.
> - **"Approve all in this file" is absent.** The two ends of the ladder ship
>   (approve this one, always allow this session); the middle rung, which is the
>   one that matches how a human actually reviews a file, does not.
> - **Review queue pane (mode 2) and floating approval window (mode 3) are
>   absent.** Only session-flip exists, so "placement modes (user preference)"
>   describes a preference with one value. Mode 2 is on §8's Phase 2 list and is
>   a genuine gap; mode 3 is not, and should be treated as Phase 3 or dropped.
>
> **Why this matters more than the item count suggests.** The owner's stated #1
> pain was TUI approvals, and the *interception* half solved it. What is missing
> is everything that makes the answer INFORMED — a real diff to read, a reason to
> send back, a per-file rung, and one place to work through a queue of them. The
> honest summary is: approvals are unblocked, not yet reviewable.
>
> **⚠️ AND A FIFTH THING, FOUND WHEN THE OWNER ASKED WHAT THE GAPS ACTUALLY WERE
> (2026-09-25) — THIS ONE IS A DEFECT, NOT A MISSING FEATURE. Filed as #953.**
>
> The bar previews the tool input with exactly two branches: `command` (a `<pre>`)
> and `old_string` + `new_string` (the pane pair). But the default `ask` autonomy
> gates all of `MUTATING = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit',
> 'WebFetch']`, so:
>
> | Held tool | What the user is shown |
> |---|---|
> | `Bash` | the command — fine |
> | `Edit` | old and new text, ~6 lines visible, truncated at 1500 chars each |
> | `WebFetch` | the URL — fine |
> | **`Write`** | **the file path. Nothing else.** |
> | **`MultiEdit`** | **the file path. Nothing else.** |
> | **`NotebookEdit`** | **the path. Nothing else.** |
>
> `Write` is how an agent creates a file and how it replaces one wholesale, so
> **Allow on a `Write` is a blind signature.** `argumentDetail`'s key/value fallback
> exists and the bar never reaches it. Identical on both transports — Direct passes
> the CLI's own `input` straight through.
>
> This reframes the four gaps above. Those make the answer *less good*; this one
> makes it *uninformed*, and an uninformed prompt teaches the user to turn autonomy
> up to escape the friction — the exact opposite of what this section is for. The
> fix needs no Monaco: a branch per tool shape plus a default branch, so the next
> mutating tool the CLI invents degrades to a key/value dump rather than silence.
>
> **✅ FIXED the same day (#953).** One `ToolInputPreview` rendered by BOTH bars
> — the card's own and the grouped band — because a body that differed between
> them would show the user two things and call them one question, which is the
> rule `permission-batches` already writes down for the summary line. A branch
> per shape (`command`, `edits[]`, old/new, `content`, `new_source`) and then a
> **default** branch, which is the load-bearing one.
>
> **Two measurements made the default's case, in both directions, and neither
> was guessed — both came off the CLI on PATH rather than out of a client.**
> `NotebookEdit` keys its path **`notebook_path`**, not `file_path` (the
> binary's own tool→input map), so it had been slipping past `argumentSummary`
> for months: it was the one gated tool that named nothing *and* showed
> nothing. And **`MultiEdit` has disappeared from the published
> `sdk-tools.d.ts` by claude 2.1.280** while still being listed in the binary's
> own `["Write","Edit","MultiEdit","NotebookEdit"]` edit set. Tools arrive,
> tools leave, and tools rename their keys — so a list of names is not
> something a permission surface may depend on being complete.
>
> The 1500-character clip and the short scroll boxes are untouched and remain
> the Monaco item's question. What changed is that a clip now SAYS it clipped —
> a first page that looks like a whole file is this same bug one size down.

### 5.17 MCP Manager & slash-command surfaces

Slash commands (`/mcp`, `/model`, `/compact`, …) work natively in the Terminal
tab — it's the real CLI. On top, GUI sugar that never forks CLI behavior:

- **MCP Manager pane**: all configured MCP servers with scope (project `.mcp.json`
  / user settings / Session Bus auto-attached), health status, add/remove.
  Implementation: read the real config files; mutate via the real CLI
  (`claude mcp add/remove`).
  Per-session view (what THIS session sees) and global view (all scopes).

  **Four corrections from building it (#632, #714, #723), because §5.17 as
  written was wrong about all four:**

  - **`claude mcp list --json` does not exist.** `mcp list` and `mcp get` take
    no options beyond `-h` and print human text with emoji in it. The listing is
    read from the config files (which this section always said) and the health
    column is parsed leniently out of `mcp list`, degrading to `unknown`.
  - **No `claude mcp` SUBCOMMAND enables or disables a server.** The full
    subcommand set is `add`, `add-from-claude-desktop`, `add-json`, `get`,
    `list`, `login`, `logout`, `remove`, `reset-project-choices`, `serve`
    (probed 2026-08-25, re-probed 2026-08-26). Approval lives in
    `enabledMcpjsonServers` / `disabledMcpjsonServers`, which only a session or
    a settings write moves. So the pane **shows** approval state and **hands the
    change off**: Reconnect opens the CLI's own picker, and *Reset approvals*
    runs the one real subcommand, `reset-project-choices` — project-wide,
    resetting approved and rejected together. Writing those keys ourselves was
    declined on P7: it is config the CLI owns, on a shape it can change under us.

    **THE SCOPE OF THAT CLAIM WAS WRONG, and #714 shipped it too broadly.** It
    said "there is no enable/disable verb" full stop. There is one — just not a
    subcommand. The stream-json **control protocol** carries `mcp_toggle`
    (`{serverName, enabled}`), `mcp_reconnect` and `mcp_status`, all present in
    the PATH CLI 2.1.245 and used by Anthropic's own VS Code extension. What we
    never built is the ability to SEND a control request (we only parse them
    inbound, for permissions). See #721; the correction is on #714 and #633.

    **AND THEY ARE NOW MEASURED, NOT JUST LOCATED (#729, 2026-08-29).** Both
    verbs answer `Server not found: <name>` for a server that does not exist,
    where a verb the CLI genuinely lacks answers `Unsupported control request
    subtype: <name>` — so existence was proved with no mutation at all.

    **SHIPPED in #729 PR 2**, after a second probe against a throwaway server.
    Three measurements shape the implementation, all in
    `docs/reference-implementations.md` §1.2.2:

    - ⚠️ **`mcp_toggle` WITH NO `enabled` FIELD DISABLES THE SERVER and answers
      `success`.** The `set_model` trap, made worse — that one was inert, this
      one acts. `enabled` is validated as a STRICT boolean before the wire;
      coercion is exactly the CLI behaviour that makes it dangerous.
    - **The toggle PERSISTS**, to `projects[<folder>].disabledMcpServers` — a
      different key from the `disabledMcpjsonServers` approval mechanism. It is
      not session-scoped and the UI must not say it is.
    - **`mcp_reconnect` pulls in a server the session NEVER LOADED**, so it
      serves "you added a server" as well as "reconnect the one that dropped".

    So the paragraph above — "no `claude mcp` SUBCOMMAND enables or disables a
    server" — is still literally true and no longer the whole story: there is no
    subcommand, but there is a verb, and the pane now uses it. Approval remains
    separate: `enabledMcpjsonServers` is a different mechanism and `mcp_toggle`
    has NOT been measured against an unapproved server.
  - **The picker commands do NOT dead-end after all — we had never learned to
    ask (#721).** §5.17 treated `/model`, `/permissions` and friends as
    unreachable in Direct mode because they open a TUI picker and a Direct
    session has no terminal. True of the *typed* command; false of the CLI. The
    stream-json **control protocol** carries `list_models`, `set_model`,
    `mcp_toggle`, `mcp_reconnect`, `mcp_status` and `get_context_usage`, and we
    had only ever parsed control requests INBOUND. `main/transport/
    control-channel.ts` is the outbound half, and `/model` is the first surface
    on it. Measured shapes: `docs/reference-implementations.md` §1.2.2.

    Two constraints that fell out of measuring rather than designing:
    **nothing the CLI returns marks the CURRENT model** — not `list_models`,
    not `initialize` — so the only source is `system:init.model`, once per TURN,
    and a picker on a session that has run no turn must say "not known yet"
    rather than tick a default; and **`set_model` with no `model` field answers
    `success` while changing nothing**, so arguments are validated before the
    wire rather than after.
  - **"Reconnect injects `/mcp` into that session's input route" is true on ONE
    transport.** On **pty** it is exactly right: the CLI's picker opens in a
    terminal the user is looking at, and we type rather than fake. On **stream**
    there is no terminal for the picker to appear in, so typing `/mcp` sends a
    command, opens a picker nobody can see, and leaves the session sitting there
    — the dead end #633 is about. So on stream we **send nothing** and say
    "restart the session to pick up the change". Main decides this from the LIVE
    record's transport, not the renderer: `lib/composer.ts`'s
    `sendSessionCommand` is deliberately transport-blind, which is correct for
    `/compact` (both routes deliver the same thing) and wrong here (one route
    delivers nothing).
  - **"Per-session view (what THIS session sees)" over-promises, and the gap is
    large (#723).** The config files are a STRICT SUBSET of the CLI's runtime
    inventory. Its scope vocabulary in 2.1.245 is `local` · `user` · `project` ·
    `enterprise` · `managed` · `builtin` · `dynamic` · `skills`, plus a separate
    claude.ai connector class (`dynamic` covers `--mcp-config`, plugins, the IDE
    bridge and chrome). We read three files, so we reach three of those — and
    the two blocs that dominate a real machine, **account connectors and
    plugin-contributed servers, live in no file at all**. A machine with both
    showed **3 servers in our pane against 16 in the CLI's own `/mcp` picker**,
    which is what got it reported as a bug.

    And `claude mcp list` is not the way out: its own description is "List
    **configured** MCP servers", the same surface we already read. The runtime
    list has exactly one source — the `mcp_status` control request, which
    answers `{name, status, serverInfo, config, scope, tools[]}` per server
    (measured against a session spawned with our own flag list, 2026-08-28).
    That is #721's channel, and sourcing the pane from it is the real fix; #723
    shipped only the honest disclosure in the meantime.

    **DONE (#729), and the sentence above is now the description of a FALLBACK.**
    A live stream session is asked `mcp_status` and the pane draws that; the
    config files are read alongside it, no longer as the inventory but as the
    **mutability floor** — a row a file declares can be removed and carries its
    env/header key names, and a row no file declares is rendered visibly
    read-only, because `claude mcp remove` has nothing to edit for a connector.
    The config-only list survives for the two cases with no control channel: a
    suspended card and a Terminal-transport session. Both now say WHICH of those
    they are, which is the part #723's blanket footer could not.

    **The runtime scope vocabulary is a READ-side type, deliberately separate
    from the write-side `McpScope`.** Widening the three-value scope to cover
    all eight would type-check `claude mcp remove -s builtin`, which is neither
    a scope that subcommand accepts nor a server we may delete. `shared/mcp.ts`
    keeps `McpRuntimeScope` and `McpScope` apart so the compiler enforces what
    is mutable.

    ⚠️ **AND IT IS FROZEN AT SPAWN.** A server added with `claude mcp add`
    while a session ran never appeared in that session's `mcp_status`, and one
    removed never disappeared (measured 2026-08-29). The CLI resolves its MCP
    set once, at startup — which is what Reconnect has always been for. So the
    config files are still read for a LIVE session: the set difference is drawn
    as its own group ("in your files, not loaded by this session"), because a
    runtime-only pane answers Add with a list that does not change and answers
    Remove by leaving the row on screen. That regression was caught in review of
    #729 PR 1, not in the field.

    ⚠️ **`mcp_status` SETTLES; the 2026-08-28 capture above is the WARM answer.**
    A freshly spawned session reports every server `pending` with `serverInfo`
    and `tools` **absent** for several seconds — measured at 0.9 s pending,
    5.0 s connected (2026-08-29). So `pending` is a state a surface must DRAW,
    a one-shot read on open shows a healthy session as a wall of grey, and the
    pane re-polls while any row is pending. `system:init.mcp_servers` carries an
    inventory too but arrives once per TURN, so it cannot serve a pane opened on
    a session that has run none.

    **"Restart instead" is HONEST, not OPTIMAL, and the difference matters.**
    The stream transport is not actually mute here: `mcp_reconnect` is a control
    request that does this properly, with no terminal and no restart. Read the
    paragraph above as "what we built and why it is defensible", not as "what
    the CLI permits" — and if you are about to repeat the reasoning for another
    surface, check the control protocol first (#721).

  **Mutations go through a hardened launcher.** On Windows the CLI is a `.cmd`
  shim, so its arguments are parsed twice — by `cmd.exe` and again by the CLI —
  and `child_process` quoting is not sufficient for either
  (`main/transport/win-cmd.ts` carries the measurements). A double quote cannot
  be delivered faithfully AND safely through that path, so it is refused rather
  than escaped.
- **Session controls strip**: buttons/palette entries for common slash commands
  (`/model` picker, `/compact`, `/clear`, `/mcp`) that inject the real command
  into the session's input route. GUI is sugar; the CLI stays the source of
  truth (PHILOSOPHY P7). *(Slash commands work as plain user text on the
  stream-json transport too — verified S-10 probe C — so this surface is
  transport-independent.)*

  **THE PICKER TRIAGE #633 ASKED FOR — settled 2026-08-30, and mostly by
  discovering the question was stale.** #633 listed seven picker commands that
  "dead-end in Direct mode" and asked for a disposition per command. Existence-
  tested against `initialize.commands` on PATH CLI 2.1.245 (69 entries;
  `spike/probes/721/probe-command-verbs.mjs`, findings in
  `docs/reference-implementations.md` §1.2.2):

  | Command | Disposition |
  |---|---|
  | `/model` | **GUI.** Picker over `list_models` / `set_model` (#721) |
  | `/mcp` | **GUI.** Routes to the MCP Manager (#632, #714, #723, #729, #734) |
  | `/permissions` `/hooks` `/resume` `/rewind` `/output-style` `/status` | **MOOT — not commands on 2.1.245 at all.** There is no dead end to fix and nothing to hand off |
  | `/agents` | **MOOT.** It exists, and its own description begins `(removed)` |
  | `/config` | **PASSES THROUGH.** "Set a setting by key" — takes an argument, opens no picker |
  | `/context` `/usage` | **SHIPPED** already (#715) — the CLI answers them itself and the Session view renders it |

  So the ticket's premise — a large class of unreachable interactive commands —
  was true of an older CLI and is now true of exactly none. **Five of the seven
  were fixed by the CLI deleting them, not by us**, which is worth stating
  plainly rather than claiming as a win.

  `initialize` also carries `current_permission_mode`, `output_style`,
  `available_output_styles` and the full `agents` array, so several of those
  surfaces are **readable** even where no dedicated control verb exists. That is
  a starting point if any of them ever earns a pane — not a plan to build one.

  ⚠️ **KNOWN DRIFT, DELIBERATELY LEFT.** `main/providers/claude.ts`'s static
  builtin catalogue still lists all six of the deleted commands, so Terminal-mode
  autocomplete offers things the CLI no longer has. #633 scoped catalogue drift
  out explicitly ("mitigated by Direct mode's live list"), and Direct mode — the
  default, and the mode that is staying — replaces that list wholesale with the
  CLI's own. Recorded here so the next person finds the measurement rather than
  re-running it.
- Non-Claude adapters map the same surface to their CLI's equivalents where they
  exist; the pane degrades gracefully to "not supported by this provider."

### 5.18 Plugin & Marketplace Manager

Claude Code's marketplace system is fully file-based and headless-scriptable —
ideal foundation for a GUI that never forks CLI behavior (verified against docs
2026-07-18; see code.claude.com/docs/en/plugin-marketplaces):

- A marketplace = git repo with `.claude-plugin/marketplace.json` (owner's work
  marketplace is exactly this).
- Headless CLI for everything: `claude plugin marketplace add <repo|url>[@ref]` /
  `list --json` / `update` / `remove`; `claude plugin install <p>@<mkt> --scope
  user|project|local` / `enable` / `disable` / `list --json` / `details`.
- State on disk: `~/.claude/plugins/known_marketplaces.json`, cloned marketplaces,
  install cache — readable without running Claude.
- Team distribution: `extraKnownMarketplaces` + `enabledPlugins` in a repo's
  `.claude/settings.json` auto-prompts every trusted teammate.
- Live reload: `/reload-plugins` — no session restart.
- Private-repo auth rides git credential helpers / ssh-agent. Caveat: background
  auto-update disables credential helpers by default (SSH keys or token URL
  rewrite are the workarounds) — surface this in the UI instead of failing quietly.

**The switchboard.ai advantage — cross-session view** (the CLI `/plugin` TUI and
VS Code extension are single-session):
- One pane: all marketplaces + plugins × WHICH SESSIONS each is active in
  (user/project/local scope resolved per session folder).
- Scope-aware install/enable toggles → shell out to real CLI commands; "reload in
  running sessions" injects `/reload-plugins` on each affected session's input
  route.
- Add the company marketplace once; see instantly which projects carry it.
- `strictKnownMarketplaces` (managed policy) surfaced explicitly: "blocked by org
  settings," never a mystery failure.
- Errors tab equivalent: plugin load failures per session, aggregated.

### 5.19 Capability Inspector — skills & agents, per session

"What can this session do?" — a per-session pane with tabs **Skills / Agents /
MCP (§5.17) / Plugins (§5.18)**. Skills and agents are plain files
(`.claude/skills/<name>/`, `.claude/agents/*.md`, user-scope equivalents in
`~/.claude/`), so this is a directory scan + frontmatter parse: chip per
skill/agent with name, description, and a scope/provenance badge.

**Drag a chip to another session — provenance decides the semantics:**
- **Project-scope** → copies the files into the target project's `.claude/`
  (the headline feature). Feed event records the copy; same-name conflict →
  Monaco side-by-side diff with overwrite / keep-both / cancel.
- **User-scope** → already available everywhere; chip says so. Drag = "pin a
  copy into this project" so it travels with the repo (teammates get it via git).
- **Plugin-provided** → copying would orphan it from plugin updates; the drop
  offers "enable <plugin>@<marketplace> here instead" → real
  `claude plugin enable --scope project`.

Spike note: verify whether a running session picks up newly copied skills/agents
on next turn or needs a restart — degrade to a "restart session to load" chip if
needed. Litmus: pure GUI sugar over file ops (P7 ✓), manual escape hatch is the
filesystem itself (✓), fail-open trivially (✓).

### 5.20 Theming — token-based design system

Day-one architecture (retrofit is brutal); v1 ships dark + light only.

- Every color resolves through semantic tokens (CSS custom properties): base
  (`surface`, `text`, `accent`, `border`, …) → component tokens
  (`button.primary.bg`, `card.header.border`, `feed.toolchip.text`, …).
  **Components never use raw colors — only tokens** (lint-enforced).
- **A theme = a JSON token map.** Ship: dark, light, high-contrast (accessibility,
  not decoration), a couple of presets. Mockup v1's palette seeds the dark/light maps.
- "Every button customizable" = token granularity + inheritance: override a base
  token and derived tokens follow; override `button.primary.bg` and only it changes.
  Preset users, ten-token tweakers, and full-file authors all served.
- User themes: import/export JSON (shareable like layouts). Theme editor GUI
  (element picker → color picker) is a later convenience; the JSON escape hatch
  satisfies the litmus from day one.
- OS sync (follow system dark/light) default. §5.10 Feed themes fold into this
  one engine (chrome + feed = two surfaces, one system). Session accent colors
  are SEPARATE from themes — identities survive theme switches.
- Boundary (P7): terminal pane CONTENT colors belong to the CLI. We theme the
  frame and may offer xterm.js palette mapping; we never repaint CLI output.

**As built (P2-E15-05, 2026-07-31)** — ships **four** themes, not the three
listed above: dark (nordic), light (daylight), **high-contrast**, and
**soft-contrast** — high-contrast with pure white and pure black pulled back a
step, held to the same measured ratios. The fourth was asked for after the
mechanism was built and cost one JSON file plus one list entry, which is the
section's "a theme = a JSON token map" claim being cashed rather than asserted.
Three deliberate differences from the wording above, each recorded because the
code is the thing that ships:

1. **A theme is a base preset PLUS an overlay**, not always a whole map:
   `{id, base: 'nordic'|'daylight', colorScheme, tokens}`, where `tokens` is
   applied to `documentElement` as custom properties. nordic and daylight stay
   as the `[data-theme]` blocks in `tokens.css` with EMPTY maps — they are what
   an overlay inherits, and they are also the first paint, which a map applied
   by JS can never be. This is what serves the "ten-token tweaker" the section
   promises: a small theme is a small file, not a 42-token fork.
2. **The semantic tokens are defaults, not constants.** `tokens.css` called
   layer 2 (status hues, diff colors, links) "theme-INDEPENDENT"; a theme may
   now override them, because a status hue tuned for a dark panel is not
   readable on pure black and a high-contrast theme that cannot touch them is
   decoration. **Session accents stay theme-independent** — an accent is an
   identity, and §5.11 says it survives a theme switch.
3. **Colors only, so far.** The 42 enumerated tokens (`theme/tokens.ts`, with a
   test that fails when they drift from `tokens.css`) are colors and shadows —
   typography, radii and spacing are not themeable yet. Widening the map later
   is additive and does not invalidate a stored theme.

Not built here and NOT started: user theme import/export, the theme editor GUI,
and following the OS `prefers-contrast` signal (OS sync today is light/dark
only). The JSON escape hatch the section calls the day-one litmus answer exists
as a FILE FORMAT — `high-contrast` proves it — but there is no import path for a
theme the app did not ship, and values from outside the bundle would need
validation `applyTheme` does not do (names are allow-listed; values are not).

### 5.21 Internationalization

Day-one architecture; v1 ships English only.

- **No hardcoded user-facing strings — ever** (lint-enforced from first commit).
- i18next-class library; JSON locale files; ICU message format (correct plurals:
  "2 sessions need you" in languages with non-English plural rules); English
  fallback chain; live language switcher in settings.
- Dates/numbers via `Intl` API, never hand-formatted.
- RTL insurance now, not later: logical CSS properties (`margin-inline-start`,
  not `margin-left`) throughout.
- Pseudo-localization dev mode (inflated accented strings) to catch hardcoded
  text and overflow layouts before any real translation exists.
- Adding a language later = drop in one JSON locale file.
- Boundary: we translate our chrome, not CLI output.

**Shipped record — the MAIN process (#471, 2026-08-21).** The first bullet
("no hardcoded user-facing strings — ever") was true of the renderer and false
of main, which composes the OS toast's title and body, the Allow/Deny buttons on
it, and — because push and the webhook forward the same two fields — the copy
that reaches a phone. A permission decision was rendered in English regardless
of locale. Three mechanisms were considered and one recorded:

- **Rejected — route the text through the renderer**, the way the right-click
  menu labels travel (#526). That works for four static labels published at
  boot; it cannot work for a toast, whose text is composed per event from live
  data and whose entire purpose is to fire when the window is blurred,
  minimized or not yet mounted. It would make a notification depend on a
  renderer that may be gone — fail-closed on the one path that must fail open.
- **Rejected — accept English-only for main surfaces and document it.** §5.9's
  promise is that answering from the notification is the same decision the user
  would have made at the bar; "the same decision" cannot survive the two
  surfaces speaking different languages.
- **Adopted — one catalog, one configuration, two instances.** The catalog and
  the pseudo-locale moved to `src/shared/i18n/`, which both bundles may import,
  and `configureI18nBase` there is the single i18next configuration (#380's rule
  now spans both processes; a caller may only ADD plugins — the renderer adds
  `initReactI18next`, main adds nothing). **Locale needed no new IPC:** the
  preference already lives in the workspace `ui` blob, which is *main's own
  file*, so `main/i18n.ts` reads it through a thunk on every `t()` via
  `getFixedT`. A mid-session switch is therefore instant, there is no second
  copy of the preference to go stale, and nothing has to await — which matters
  because `changeLanguage` is async and a toast fires on an OS callback.

Two boundaries are now enforced by tests rather than by intent: the toast's
buttons resolve `approval.allow` / `approval.deny`, the approval bar's *own*
keys, so the surfaces cannot be worded differently in any language; and the
detail half of "Allow Bash? npm run build" is never translated, which is this
section's last bullet made literal. The repo still ships exactly one real locale
— #471 fixed the mechanism, not the coverage.

**Scope, stated so nobody has to grep for it.** All four NOTIFICATION channels
are translated: the OS toast, push, the webhook, and the spoken announcement
(`announcementFor` moved from `shared/sounds.ts` to `main/events/
notification-text.ts` with the code, since composing a sentence needs a
translator and a `src/shared` test may not import one from `src/main`). Main's
remaining English is chrome rather than notification — the application menu
(`app-menu.ts`) and the quit-with-busy-sessions dialog — both reachable only
with the window in front of you, both out of #471's scope, both still open.

Folded in from the same discovery: `app.setAppUserModelId` is called at boot
with the installer's `appId`, so Windows files a toast under the app's identity
rather than Electron's default (`src/shared/app-identity.ts`). That buys
attribution and filing; *re-activating* an expired toast from the Action Center
is documented as needing a ToastActivatorCLSID, which the NSIS shortcut does not
write — recorded as a hand-test rather than claimed.

### 5.22 Logging & diagnostics

Day-one architecture: structured JSON-lines logs, rotating files in the app data
dir, one pipeline fed by main process + all renderer windows.

- **Every entry**: timestamp · level · subsystem · **session ID** (filter the
  whole log to one misbehaving session instantly). Subsystems mirror the
  architecture: `session-lifecycle`, `pty`, `hooks`, `session-bus`, `git`,
  `approvals`, `transcript-watcher`, `ui`.
- **The CLI boundary is logged completely** — spawn cmd/args/env (redacted),
  cwd, exit codes, hook events in + decisions out, Session Bus calls,
  rescue-policy actions, approval outcomes. Troubleshooting is always "what did
  we tell the CLI, what did it tell us."
- **Redaction in the logger, not by discipline**: keys/tokens/credentials can
  never reach a log. Prompt/transcript CONTENT excluded at default level (logs
  record events, not conversations); explicit opt-in debug level for payloads,
  visibly labeled while active.
- **In-app log viewer**: filter by session / subsystem / level / time, follow
  mode, session color+icon on entries. Files on disk remain the escape hatch.
- **Diagnostics bundle**: one click → local zip (recent logs, app + provider CLI
  versions, OS/display topology, sanitized settings). Produced locally, sent
  nowhere unless the user sends it (P8-compatible).
- Fail-open: full disk / broken pipe degrades logging, never the app. Log level
  + per-subsystem debug toggles in settings.

### 5.23 Extensibility architecture — design now, ship later

Decision (2026-07-18, research-backed): build the seams from day one; expose a
public plugin API only after the core is stable. NOT a market differentiator —
Nimbalyst already ships an extension marketplace in our category — so this is
architectural future-proofing + owner's own add-ons, at zero roadmap urgency
for a public store.

- **Contribution points + capability manifest (day one).** Extension-shaped
  things declare contributions (panels, themes, event rules, provider adapters)
  and required capabilities in a manifest, least-privilege, Tauri/MetaMask-schema
  style. Main process is the sole enforcer.

  *Vocabulary amended 2026-07-28 (P2-E15-04).* The illustrative
  `session:read` / `session:exec` / `git:write` / `network:fetch` above predate
  the implementation. The shipped IPC vocabulary is dot-separated and plural —
  `sessions.read`, `sessions.spawn`, `pty.write`, `git.read`, `dialog.open`,
  `environment.probe`, … — and lives in `src/shared/ipc/capabilities.ts`, which
  is authoritative. **Note there are currently TWO capability vocabularies:**
  these IPC-channel capabilities, and the free-form `capabilities: string[]` on
  `CapabilityManifest` that contributions declare (`sessions.spawn`,
  `commands.contribute`, `panel.render`, …). They overlap by accident of naming
  rather than by design. Joining them — a plugin manifest's declared set
  gating the IPC broker — is exactly the Phase-4 work this seam exists to make
  mechanical, and it is where that join belongs.

> **Amended 2026-07-26 (architecture review AR-P0-2).** The seam shipped in
> Phase 1 covers the MAIN process only — `provider-adapter` and an unconsumed
> `event-source`. But **eight of the nine first-party extensions in the roster
> below are RENDERER contributions**, so seven of them had nowhere to land and
> the consumer count was stuck at one. Two consequences were structural, not
> cosmetic: the API-stability gate ("2–3 dissimilar consumers before freeze")
> was **unreachable by construction**, and the preload bridge grew into ~60
> hand-maintained methods with no capability scoping at all — so "main process
> is the sole enforcer" was true only because there was nothing to enforce.
>
> The correction (Phase 2, **E15**): `ContributionRegistry` becomes
> process-agnostic with one instance per process (the bootstrap rule — only one
> module imports contributors — holds on both sides); renderer points
> `command-set`, `panel`, `feed-block-renderer`, `status-bar-item`,
> `notification-channel`, and `theme` are added and **dogfooded by first-party
> features that already exist as hardcoded switches**; and every IPC channel
> gets a declared capability with a live main-side enforcement point (a no-op
> for first-party today — the point of it is that Phase 4 wires a plugin
> manifest into an existing check rather than inventing one).
>
> Owner decision the same day: **third-party plugin support is a real goal**,
> initially serving first-party add-ons. So capability brokering ships
> full-size rather than being trimmed to "internal structure only."
- **Dogfood internally (VS Code / Nimbalyst EditorHost pattern).** First-party
  features are built against the same internal contract third parties would
  use. If our own adapter can't be expressed in the contract, the contract is
  wrong.

**The core/extension split (decided 2026-07-18):**

*Kernel — never extensions:* session manager + transport hosting · layout/docking
engine · Session Bus + event stream · approval/permission enforcer (it judges
extensions; cannot be one) · identity kit · attention queue · git service ·
theming/i18n/logging runtimes · the extension host itself.

*First-party extension roster (each proves a different API surface):*
1. **Provider adapters** (Claude Code, Codex, Gemini, Aider) — flagship;
   `provider:register`, deepest surface.
2. **Usage pane** — panel + event subscription + transcript read. (Was framed as
   a ClaudeMon pane until 2026-07-29; the integration was dropped, the pane is
   first-party and the surface it proves is unchanged.)
3. **Notification channels** — phone push / TTS / webhooks (core keeps
   sounds/toasts); proves the action-contribution surface.
4. **Dispatch role templates** — declarative, data-only contributions.
5. **Service status monitor** — status-bar item + feed-event producer; the
   "hello world" example future authors copy.
6. **Manager panes** (MCP §5.17, Plugins §5.18, Capability Inspector §5.19) —
   prove the dangerous-capability path: panels using brokered exec through
   approval cards.
7. **Theme presets** — shipped in the same format as user themes.
8. **Feed block renderers** (§5.10) — per-tool-type rich renderers; our
   equivalent of Nimbalyst's custom editors, the likeliest community-creativity
   surface.
9. Backlog fits: voice input (local Whisper), global transcript search, log
   viewer pane.

Consumers 1–3 alone satisfy the "2–3 dissimilar consumers before freeze" rule
from our own roadmap. **Pragmatic guardrail:** never delay a feature purely to
make it a purer extension — Phase 1 defines contract shapes, Phases 2–3 consume
them in-process, Phase 4 moves them into the real plugin host. Attention-ROI
applies to us too.
- **PTY power is brokered, never sandboxed.** No JS sandbox can safely grant
  process/PTY access (vm2 = repeated critical CVEs; WASM/SES structurally
  forbid it). Deep plugins call permission-gated host APIs
  (`session.exec(...)`); dangerous calls surface through the EXISTING approval
  cards (§5.16) — approvals double as the plugin permission UI.
- **Two trust tiers, honestly labeled.** Tier 1 sandboxed: UI panels (sandboxed
  webviews, postMessage only), themes, event subscriptions — future
  community-store safe. Tier 2 trusted: provider adapters + deep integration —
  security via review + capability disclosure (Raycast/Obsidian model), never
  a fake sandbox claim.
- **Runtime evolution:** internal plugins may run in-process initially; when
  third-party code arrives, plugin logic moves to a dedicated Electron
  `utilityProcess` plugin host with typed RPC (VS Code extension-host shape).
  Activation events are domain-specific (`onSessionStart`,
  `onProviderNeeded:<id>`, `onEvent:<type>`) so installed-but-unused plugins
  cost nothing.
- **API stability discipline (solo-sized VS Code rule):** everything lives in
  an experimental namespace — breaking changes expected — until an API has
  2–3 DISSIMILAR internal consumers; only then freeze + semver. (Cautionary
  tales: premature stable APIs lock awkward shapes; retroactive tightening on
  a live ecosystem = Manifest V3 backlash.)
  **Consumer count is a tracked number, not a vibe** (added 2026-07-26): it sat
  at 1 for all of Phase 1–2 and could not grow, which is what the E15
  correction above exists to fix. Check `extensibility.md`'s roster table —
  which states the real count — before anyone schedules the Phase 4 alpha.
  E15-03 alone takes it to 4 by rewiring code that already exists.
- **Distribution (deferred until real demand):** git-PR registry + automated
  scanning + tiered review (Obsidian's model — ~3 engineers sustained 2,700
  plugins; structurally identical to owner's work git-marketplace pattern).

### 5.24 Child surfaces — the undercard tray

Spatial model for a session's children (subagent watchers §5.6, dispatched
sessions §5.15):

- **Undercard tray**: every session card has a collapsible tray docked beneath
  it — the DEFAULT home for its children. Visual tether: tray carries the
  parent's accent color + a lineage connector ("these belong to that" in half a
  second).
- Multiple children stack as rows in the tray; each row can individually pop out
  (float / another monitor) — the tray is a default home, not a cage. Popped-out
  children keep the lineage tint + a "↳ parent" chip.
- **Attention bubbling**: a child needing attention lights the PARENT's lamp with
  a distinct satellite dot (not the plain urgent glow) — "your reviewer needs
  you" is distinguishable from "your session needs you." Sidebar nesting mirrors
  the tray.
- Collapsed tray ≠ paused children: they keep running headless and surface via
  the normal attention machinery.

### 5.25 Lifecycle — first run, quit, crash, archive

Sessions are child processes: closing the app would kill every agent mid-task.
Designed answer:

- **Quit protection**: quitting with working sessions → confirmation listing
  who's mid-task (the one modal that earns its existence).
- **Tray mode** (optional, likely the daily driver): closing the window
  minimizes to system tray; agents keep working; notifications keep flowing.
- **The Restoration Guarantee** (clean quit and crash are the SAME flow —
  transcripts are the source of truth, written by the CLI itself, so even our
  crash cannot lose them):
  1. *Workspace restores exactly*: session identities, folders, groups, tab
     stacks, dock slots, pop-out windows on their monitors (§7 fingerprint
     matching + rescue policy if hardware changed).
  2. *Conversations restore exactly*: `--resume <session-id>` reconstructs full
     history from the JSONL up to the last persisted event.
  3. *Working trees are untouched*: uncommitted changes are files on disk.
  4. *Honest limit — the in-flight moment*: output not yet persisted when a
     process dies is gone; the resumed session continues from the last completed
     event (a "continue" nudge — manual or automatic — picks the task back up).
     Quit protection + tray mode exist precisely to make this case rare.
- **Resume policy** (resolves Open Question #7): default **resume-on-focus** —
  on startup the full workspace renders instantly, every session card present in
  a "suspended — tap to resume" state; the CLI process relaunches on focus or
  when anything targets the session (event click, bus message, hotkey). Avoids
  a thundering herd of 8 CLI spawns at startup for zero benefit. Options:
  resume-all-immediately | ask-per-session.
- **Restore never silently relaunches agents** (research v2: Zellij places
  resurrected commands behind a "Press ENTER to run" gate precisely to avoid
  re-running destructive commands): anything that would START an agent process
  during restore asks once — one fleet-level confirm, not twelve dialogs (batch
  semantics: OQ #14). Resume-on-focus already implies this; stated here as an
  explicit safety property so no future mode (resume-all, layout apply, snapshot
  restore) forgets it.
- **Focus state is part of the workspace** (research v2: tmux-resurrect persists
  active session/window/pane, even zoom state): save which session had focus and
  which pane was active; restore lands the user exactly where they were, not at
  a default card. Cheap, invisible, serves attention-driven layout directly.
- **Renderer preferences live in the workspace store, never `localStorage`**
  (P2-E15-06). Not a style rule — a correctness one, measured 2026-07-31: the
  packaged renderer is served from a random loopback port, so launch 1 is
  `http://127.0.0.1:58814` and launch 2 is `:57029`. Different origin, different
  storage, and every preference written to it is gone. Theme and language were
  the last two holdouts and cost exactly that; anything a user chooses in the
  renderer goes in the `ui` blob behind `workspace.getUi`/`setUi`.
- **First-run & preflight** (P1): detect installed provider CLIs (found?
  version? logged in?) with guided fixes; then point-at-a-folder → first
  session in under a minute. Preflight re-runs per spawn ("you're logged out"
  surfaces BEFORE a session mysteriously fails).
- **Session archive**: ended sessions keep identity, transcript, diff summary,
  and lineage; browsable + searchable (global search's corpus); one click
  resurrects via `--resume`. Sidebar shows the living; archive remembers all.

### 5.26 Updates, version drift & data portability

- **App self-update**: standard Electron updater; update check only — no
  telemetry ride-alongs (P8).
- **CLI version drift**: transcript schema, hook payloads, and storage layout
  are UNOFFICIAL contracts that move per Claude Code release. Compat layer:
  detect CLI version per session; warn on untested versions; degrade gracefully
  — badges/feed may thin out, session hosting keeps working (fail-open applied to
  parsing). **Verified track record (research v2)**: the schema is explicitly
  unversioned (anthropics/claude-code#53516 is an open feature request);
  claude-code-log needed schema-driven parser fixes in three of its four
  releases Apr–Jul 2026. **Mandated ingestion patterns**: (a) *tolerant reader*
  — unknown types/fields warned once per type and skipped, NEVER fatal
  (Anthropic's own Python SDK hard-fails on unknown types; that is the
  anti-pattern); (b) *round-trip drift detector* — re-serialize each parsed
  line and diff against the original to catch new fields within a day of a CLI
  release (claude-code-transcripts crate pattern). **Named accepted risk**:
  schema drift is a MONTHLY expected-maintenance line item, not a background
  assumption.

  > **As built (P2-E15-10, 2026-07-31) — the drift detector is a declared
  > key-set diff, not a re-serialize-and-compare.** The mechanism above was
  > written from the claude-code-transcripts pattern; implementing it turned up
  > two reasons to change it, both measured rather than argued.
  >
  > *Re-serializing would report noise as drift.* `JSON.stringify` of a parsed
  > line differs from the original on key order and number formatting, neither
  > of which is a schema change. The comparison that carries the actual signal
  > is over KEYS, so that is what `src/main/transcripts/drift.ts` walks —
  > against a declared contract in `schema.ts`, warning once per newly-seen key
  > and once per unknown line `type`.
  >
  > *A naive detector would have been muted within a day.* Measured against the
  > real corpus in `~/.claude/projects` — **250 transcripts, 10,138 lines** —
  > a line carries **75 distinct top-level keys** across **12 line types**, and
  > we consume 7 of the 75. "Warn on anything we don't read" is therefore ~50
  > warnings on the first real session. The declared list splits the corpus
  > into *read* and *seen-and-skipped*, so a warning means "the CLI wrote
  > something the file has not been told about" and nothing else.
  >
  > Two consequences worth writing down. The corpus is a **lower bound on the
  > format**, not the format — it is one machine's history, so block types
  > nobody here has triggered are absent from the measurement without being
  > absent from the schema; those keys are declared from the public API shape
  > and marked as such. And the detector is scoped **per transcripts root**,
  > because the watcher has been provider-generic since §5.3's capability
  > object while this schema is Claude-shaped: a process-wide budget would let
  > one foreign-dialect adapter exhaust it and switch drift detection off for
  > the Claude sessions too.
  >
  > `npm run check:transcripts` now prints the drifted keys against the
  > installed CLI — the only check in the tree that can see real drift, since
  > every unit fixture is a shape we wrote ourselves.

- **Binding transparency** (P2-E15-10, AR-P1-8): the Session view renders only
  if transcript binding succeeds, and binding rides two undocumented contracts
  in series — the storage layout, and hooks liveness. An empty pane therefore
  used to mean any of four things. The watcher now derives a **binding state**
  (`bound` · `awaiting-prompt` · `searching` · `unbound`) and the view says
  which, with the diagnosis naming the contract that went quiet. Two rules keep
  it honest: **`awaiting-prompt` never times out** (a session you opened and
  walked away from is not broken — transcripts appear on the first prompt, per
  S-04/S-05), and **`unbound` always rests on positive evidence** — a turn that
  actually ran, or a transcript under our folder that nobody can claim. With
  hooks dead and nothing on disk we cannot distinguish "not yet asked" from
  "written somewhere we aren't looking", and announcing a failure we cannot
  tell from silence would be a guess in a warning's clothes.
- **Data portability**: versioned app-data schema; workspaces, layouts, themes,
  and settings exportable/importable as plain files — back up or move the whole
  setup.
- **Accessibility** — **moved to §5.32** (#369, 2026-08-08). The keyboard-
  complete / screen-reader / colorblind-safe rules and their as-built
  appendix lived here until then, which made a bare `§5.26` citation
  ambiguous and cost one wrong bug report (#358 → #367). A `§5.26` citation
  now always means updates, version drift or data portability.

### 5.27 Mobile companion — fleet remote control

Sessions are PC processes; Electron has no mobile target — and shouldn't. The
companion extends the existing "windows are views over orchestrator state" model
over the network: **the phone is another view.**

- **Remote API**: orchestrator exposes a WebSocket (TLS) serving session state,
  identity, lamps, usage, the event stream, and approval routing — all data that
  already exists; mobile is a projection, not a new subsystem.
- **Phone UI (deliberately thin — a remote, not a second IDE):**
  - Home = the attention queue: swipe through approval cards (read-only diff,
    Allow / Deny / deny-with-feedback) like an inbox.
  - Sessions rail (status, lamps, usage bars) + event feed with inline actions.
  - Session detail = the rendered Session view (read-only on phone) + prompt composer.
  - NOT on phone: terminal emulation, layout management, git operations,
    settings, drag-and-drop.
- **Form: PWA served by the orchestrator itself** on the LAN — no app store, no
  second codebase (reuses React components + theme tokens + identity system).
  Pairing: QR code on desktop → device token, per-device revocation. iOS
  supports web push for installed PWAs. Native wrapper is a LATER option
  (owner has iOS/Android experience) if PWA push/polish falls short.
- **Reach tiers (P8-preserving):** T0 = ntfy/Pushover one-way push (already in
  Notifications v2, works from anywhere). T1 = full companion on LAN.
  T2 = remote anywhere via the USER'S own tunnel (documented Tailscale recipe) —
  no switchboard.ai cloud relay, no accounts, ever.
- **vs Anthropic's mobile remote**: theirs is per-session hopping; ours is
  fleet-level — every session, every approval, one queue. Same differentiator
  thesis as desktop, extended to the pocket.

### 5.28 Checkpoints & rollback — turn-anchored seatbelts

Promoted from the Ideas Backlog (research v2: Zed ships a "Restore Checkpoint"
button on every user message that triggered edits, persisting even through
mid-edit interruption; Windsurf/Cascade ships per-prompt revert plus user-named
snapshots navigable from the conversation — the pattern is proven in shipping
products).

- **Auto-checkpoint per turn**: GitService snapshots the working tree (shadow
  commit / stash object — never touches the user's branch history) before each
  prompt executes. Zero-config, silent until needed.
- **Turn-anchored UX**: checkpoint chips anchor to prompt turns in the Feed
  (§5.10) — "restore to before this prompt," never "dig through the reflog."
- **Rollback is itself reversible** (hard requirement): both shipping
  implementations document destructive restores (Cascade: "Reverts are currently
  irreversible"; Zed's restore has no redo and open reliability issues). We
  capture the pre-rollback state as its own checkpoint, so a restore can always
  be un-restored.
- Litmus: zero-config ✓ · attention ROI (the seatbelt that makes 8 autonomous
  agents tolerable) ✓ · fail-open (checkpoints are ordinary git objects on disk;
  feature off = plain git) ✓ · escape hatch (git itself) ✓ · calm ✓ · host check
  ✓ — the CLI has no checkpoint UI to fork.

### 5.29 Security — the localhost attack surface

Research v2 (hostile-critique pass): every localhost channel in this design sits
in an attack class with recent, repeated CVEs. These are design requirements
specified BEFORE the first listener ships — not hardening-later items.

- **Threat model**: a malicious website in the user's browser can reach
  localhost listeners. DNS rebinding is proven fast and practical (~3s against
  Ollama, CVE-2024-28224; the MCP Python SDK itself shipped without default
  protection, CVE-2025-66416; Anthropic's own MCP Inspector had a CVSS 9.4 RCE
  from a missing client↔proxy auth check, CVE-2025-49596). Browsers do NOT
  same-origin-block WebSocket handshakes (RFC 6455 leaves origin enforcement to
  the server); Chrome's Local Network Access prompts are one-click-bypassable
  and absent in Firefox/Safari — server-side defenses are mandatory.
- **HookListener (Phase 1, shipped)**: bind to loopback only; server-side
  Host-header allowlist (127.0.0.1/localhost) AND a per-session auth token
  required on every request — Host validation alone does not stop plain CSRF;
  tokens alone do not stop rebinding; both, always. The token lives in an ACL'd
  file referenced by path, never on argv (S-03). HTTP is forced here: hook
  commands are separate processes.
- **Session Bus (Phase 2): stdio only — decided 2026-07-26** (architecture
  review AR-P1-6; §5.4 carries the full reasoning). The earlier "prefer stdio
  where the CLI supports it" is now a requirement, not a preference: Claude
  Code's stdio transport has no network exposure and no auth to get wrong, so
  this section's entire attack class does not apply to the bus. **No new
  localhost listener ships in Phase 2.** If a future provider cannot do stdio,
  it declares no `mcp` capability (§5.3) and simply does not get the bus —
  we do not add an HTTP fallback to accommodate it.
- **User credentials — the OS credential store (P2-E14-06, first use)**: this
  section's "credentials live in the OS credential store, never in files" is
  implemented with Electron's **`safeStorage`** (`src/main/secrets/store.ts`).
  The nuance, stated rather than hidden behind the phrase: the *key* is the
  OS's — DPAPI on Windows, the login Keychain on macOS, libsecret
  (gnome-keyring / kwallet) on Linux — and what lands on disk beside the
  workspace file is ciphertext only that OS user on that machine can open. Three
  rules the store keeps and a test pins: **no plaintext fallback** (a machine
  with no keyring is told it cannot keep a secret, and stores nothing), **no
  read path to the renderer** (the IPC surface writes credentials and answers
  with booleans — there is no `getSecret`, so a compromised renderer cannot
  exfiltrate one), and **no value in any log line**. `update/token.ts` reserved
  a slot for this store before it existed; the slot is still empty because
  nothing yet asks the user to paste a GitHub token in, but the store it named
  is now real.
- **Mobile companion WebSocket (Phase 4)**: the near-isomorphic precedent is
  Cline's local Kanban WebSocket (CVE-2026-44211, CVSS 9.7): no origin check,
  no auth token → any webpage the developer visited received a full workspace
  snapshot and could inject commands into the agent's terminal. Mandatory for
  §5.27: server-side Origin allowlist, per-device pairing tokens (QR pairing),
  TLS on LAN, and default-deny — a new connection receives NOTHING until
  paired. Approval-from-phone hardening remains OQ #12; this section is the
  floor, not the ceiling.

### 5.30 Document viewer — rendered markdown & file preview

*(Added 2026-07-30, owner request.) Agents write markdown: `PROGRESS.md`, plan
files, findings notes, review reports, hand-off summaries. Reading any of them
meant alt-tabbing to VS Code — the exact five-windows trip this app exists to
delete. And markdown source is the wrong artifact to read: a wall of `**`, `|`,
and backticks is what the agent wrote, not what it said.*

**The surface.** A **viewer** is a *document surface*: a panel whose content is a
file on disk, rendered read-only. It is session-**attributed**, not
session-**owned** — opened from a session it carries that session's accent tint
and a `↳ session` chip (the §5.24 lineage convention), but it outlives that
session, needs no session at all, and never appears in the sessions rail, the
attention queue, or any bulk session operation.

- **Rendered by default, source one gesture away.** A `.md` opens rendered; a
  `Rendered | Source` toggle in the panel header flips to the raw text (Monaco,
  read-only, syntax-highlighted) and back with scroll position kept. The default
  is **per file type**, not per file: markdown → rendered, everything else →
  source.
- **Read-only, permanently.** PHILOSOPHY §5 already rejected a built-in editor
  by name ("Monaco stays read-only + diff-only"), and this is that precedent
  applied rather than a limitation to fix later. The escape hatch — **Open in
  default app** / **Reveal in folder** — is always in the header. Edit-in-place
  would be a philosophy amendment first and a feature second.
- **Lives anywhere a group lives.** A viewer is a Dockview panel, so tabbing,
  splitting, popping out to another monitor, geometry persistence, and
  display-rescue are the §5.8 + E8 machinery already shipped, not new code.
  "Pop it open in its own window" is the same `addPopoutGroup` a session card
  uses; a popped-out viewer is a **viewer window**.
- **Every file opens its own tab** (owner decision, 2026-08-15 — #530). Opening
  a file always adds a viewer beside the ones already open; nothing is ever
  replaced, and a document closes only when the **user** closes it. Opening a
  file that is already open focuses its tab rather than opening a second copy.
  **This supersedes "one peek slot, pin to keep"** — the IntelliJ preview-tab
  rule promoted from §10 and shipped in P2-E16-03 (#460), where a second glance
  re-pointed the panel you were reading and a 📌 was how you kept it. That rule
  was defended as the calm check applied to accretion: without it "the app
  accumulates thirty stale document tabs". The owner's answer, having used it:
  *"when a file opens it should just open a new tab automatically… it doesn't
  close the previous file window. That's what I want as standard behavior. Let's
  get rid of that pin altogether."* Recorded rather than smoothed over, because
  the calm-check argument was real and is being consciously outweighed — thirty
  stale tabs are a mess the user can see and close, while a document that
  vanishes because they glanced at something else is a thing taken away that
  they never asked to lose. The pin affordance is gone entirely; there is no
  setting behind it.
- **Closing is a gesture, and there are two of them** (#543, following #530).
  The tab's **✕** takes one document; **`Close all documents`** in the palette
  takes the lot. The second exists because removing the peek slot removed the
  only ceiling on tab count and put nothing in its place — "a mess the user can
  see and close" is only an answer if closing is not thirty clicks. Deliberately
  the cheapest possible answer: no LRU, no tab groups, no eviction policy, until
  real use says this is not enough.
  - **Popped-out viewers are exempt from the bulk close**, and the palette entry
    names its own exemption the way `Close all sessions (keeps pinned ones)`
    does. Having moved a document to another monitor is the nearest thing left
    to the pin #530 deleted; taking that window away from a command typed in a
    different window is the vanished-document failure arriving by another door,
    and it is the cross-window surprise E8-04/#434 keep re-litigating. The
    command is **disabled**, with a reason, when every open document is popped
    out — never offered and inert.
  - **No confirmation**, unlike the session bulk close. That confirm is not
    about the count: closing a card ends a child process and forgets its record.
    A viewer is a read-only lens on a file, and re-opening one is the same two
    clicks that opened it.
- **A viewer never displaces a session.** It opens into the document area or its
  own window — never as a tab inside a session's group. This is the E8-04 "new
  sessions land in whatever popout is active" defect in mirror image, and the
  rule is what keeps S1's two-gesture guarantee true.
- **Opened from wherever a path already appears:** a file path in a Session-view
  block (§5.10 promises those paths link somewhere), the Changes tab's file
  list, the Files tree (§5.7), drag-and-drop of a file onto the window, and
  `Open file…` in the command palette. Later a session may *offer* to show a
  file — a Feed offer, like E8-06's restore-layout offer. An agent never opens a
  window at the user; that fails the calm check outright.

**Live documents are the point.** The agent is rewriting the file WHILE it is on
screen. The viewer watches the file and re-renders on change, preserving scroll
position, with an optional follow-tail for append-shaped files (logs, findings
notes). This is the attention-ROI argument (litmus #2) and the one thing an
external editor does badly: reading `PROGRESS.md` as it is being written should
not need a reload, and a silently stale render is worse than no render at all.

**Markdown rendering, aimed at what AIs actually emit.** GFM — tables, task-list
checkboxes (agents write plans as `- [ ]`), strikethrough, autolinks.
*(Amended by #612, 2026-08-20: this said "rendered as disabled checkboxes", and
they are now rendered as `☐`/`☑` GLYPHS. `<input>` is in the sanitizer's
`FORBID_TAGS` — a native control is focusable with no `tabindex`, so an
`<input>` in content was a tab stop and a text box content could draw — and
`marked`'s task-list checkbox was the one thing markdown itself emitted on that
list. It was always `disabled`, i.e. decoration drawn with a control, so it is
now drawn with decoration. The marker survives; the tag does not.)* Fenced code with a language label and a copy button
(you copy the command it just gave you). YAML front matter as a collapsed
metadata chip, not an `<hr>` and a line of garbage. Heading anchors plus a
**document outline** — our own docs run past 1,700 lines. Relative links
navigate IN the viewer with back/forward (`DESIGN.md` → `docs/plans/00-process.md`
works), which is what makes a cross-linked doc tree readable at all. A readable
measure instead of 3,000-pixel lines, a sticky heading breadcrumb, wide tables
scrolling inside their own container, and **find-in-page wired explicitly** —
Chromium's find needs `webContents.findInPage` in Electron, so Ctrl+F does not
come free. *(Corrected 2026-07-30: `findInPage` is right for a viewer in its
**own window** and wrong everywhere else, because it searches the entire
webContents — in the main window it would cheerfully match text in three other
sessions' panes. A docked viewer registers a §5.31 find provider like every
other panel; only the popped-out case may use `findInPage`.)*

**One markdown renderer, shared with the Session view.** `marked` + DOMPurify
already render assistant prose (§5.10). The viewer uses the same module and the
same sanitizer configuration — stated as a requirement because two pipelines
would drift, and the security configuration would drift with them.

**File types beyond markdown.** One dispatch table, honest about its edges:
text/code → Monaco read-only with syntax highlighting (already bundled) ·
images (png/jpg/gif/webp/svg) → fit-to-pane with zoom, SVG via `<img>` and never
inlined so it cannot carry script · JSON → pretty-printed and collapsible, JSONL
→ record-per-line · CSV → a plain table · **PDF and everything binary → not
rendered**: name, type, size, and "Open externally" (Chromium's PDF viewer inside
a packaged Electron app is a rabbit hole, and users own a PDF reader) · very
large text → truncate with a tail option, never "the app froze".

**Security — this renders content we did not write.** §5.29 applies in full: a
repository can contain hostile markdown, and an agent can be talked into writing
some.

- Every rendered byte goes through DOMPurify. No exceptions, no "trusted folder"
  bypass.
- **CSP stays `'self'`, so remote images do not load** — they render as a
  click-to-load chip. A tracking pixel in a markdown file is both a beacon and a
  read-receipt canary; fetching it silently would break P8 (local-first, no
  telemetry) in the one place a user would never think to look.
- Local images are served through a scoped protocol handler that resolves the
  path and refuses anything outside the document's root, symlinks included.
- `http`/`https`/`mailto` links open in the OS browser via `shell.openExternal`
  against a scheme allowlist; every other scheme is refused. No in-app
  navigation to remote content, ever.
- **A new `fs.read` capability** joins §5.23's vocabulary. The existing
  `fs.probe` reveals only a path's existence and type; reading arbitrary file
  CONTENTS is strictly more power and must not ride in on it. Scope: anything
  under an open session's folder, plus paths the user picks through the native
  dialog (`dialog.open`) — nothing else. An agent must not be able to steer the
  viewer at `~/.ssh`.
- The size cap is enforced in main, before the bytes cross the bridge.

**Litmus (§4).** (1) Zero-config — a `.md` opens rendered with no setup. (2)
Attention ROI — it deletes the alt-tab trip for the document the agent just
wrote, and live re-render is the part an editor cannot do. (3) Fail-open —
read-only and out of band, wrapped in `ContributionBoundary`; a viewer that
throws cannot touch a session, and the fallback is the editor the user already
has. (4) Escape hatch — Open externally is always present, source view is one
click, and a file type's default can be set to source-first. (5) Two-gesture —
viewers never occupy a session's slot. (6) Calm — no badges, no notifications,
nothing opens itself. (7) Host check — we render files the filesystem owns, and
refuse to become an editor.

**Deliberately out of scope:** editing · mermaid diagrams in v1 (rendered as a
labeled code fence; §10 carries them with their CSP cost) · PDF ·
rendered-markdown diffs (the Changes tab owns diffs; §10) · `[[wikilinks]]`.

### 5.31 Session find — Ctrl+F over a session

*(Added 2026-07-30, owner request; the Claude Code VS Code extension does NOT
have this, and the absence is felt. You worked in a session for two hours, you
know the agent printed that path, and there is no way to ask where.)*

Ctrl+F, the way a browser means it: a bar, a term, Enter and Shift+Enter to
step, a count, Esc to close.

**Search runs in main, against the transcript file — not against what is
rendered.** This is the load-bearing decision, and it is forced by measurement
(2026-07-30, three real transcripts from this project):

| transcript | lines | derived blocks | text |
|---|---|---|---|
| `ff322375` | 4,697 | **3,356** | 1.2 MB |
| `2074da1e` | 2,963 | 2,163 | 744 KB |
| `bfcc7af0` | 1,897 | 1,363 | 495 KB |

`BLOCK_CAP` is **1,000** and the feed is explicitly "a view buffer, not an
archive", so roughly **70% of that first session is already gone from memory**.
A find that searched the DOM would answer "no results" for a string that is
provably in the session — worse than shipping nothing, because it teaches the
user to distrust the one tool whose whole value is being trusted. The transcript
JSONL is the complete archive; main scans it.

Rules, all four decided by the owner on 2026-07-30:

- **One Ctrl+F covers the whole session, results grouped by view** — "14 in
  Session · 3 in Terminal". You remember that you saw the error, not which tab
  it was in. The grouping is also where the honesty lives (below).
- **It searches everything, including what the view is hiding.** Verbosity
  presets hide tool calls, thinking folds to one line, and tool detail truncates
  at `DETAIL_CAP`. Find ignores all of it and jumping to a hit **expands that
  block**. A find that respected a display filter would be the same silent lie
  as searching the DOM, only subtler — and `quiet` mode hides exactly the tool
  output where error strings live.
- **Hybrid presentation: the browser bar plus an expandable results list** with
  context snippets. The list is not a nicety — it is the only way to reach hits
  in the ~2,300 blocks that were evicted, because you cannot scroll-to-highlight
  a block that no longer exists in the renderer.
- **Per-session now; scope is a parameter, not a rewrite.** §10's global
  transcript search is the same engine with a wider scope and its own result
  surface (which session · jump-and-focus), which is a real design job rather
  than a flag.

**Two engines, one bar, and the boundary is stated out loud.** The Session view
searches the transcript (complete). The Terminal searches xterm's scrollback via
the official search addon — and that is **5,000 lines**, with a byte-capped ring
buffer behind it, so it is genuinely shallower. The bar labels it
("terminal: scrollback only") instead of letting a 0 imply absence. Shipping two
sources of truth with one number on top of them would be the kind of small lie
that costs more than the feature earns.

**One keybinding, per-panel find providers.** Ctrl+F dispatches to the focused
panel's registered provider, which is what keeps it correct: **Electron's
`webContents.findInPage` is the wrong primitive here** — it searches the whole
webContents, so in a four-card grid it would match text in the three sessions
you are not looking at. Immediate registrants: Session view (transcript engine),
Terminal (xterm addon), the §5.30 document viewer, and Changes (delegating to
Monaco's own find, which already exists and should not be reimplemented). Four
dissimilar consumers is the bar `extensibility.md` sets for adding a
contribution point, and this clears it on day one rather than on a promise.

**Litmus (§4):** (1) zero-config — Ctrl+F, no setup; (2) attention ROI — this is
the "where did I see that" tax, paid once per lookup instead of by re-reading;
(3) fail-open — search is read-only and out of band, a failed scan reports "could
not search" and the session is untouched; (4) escape hatch — the transcript is a
file on disk and `grep` still works; (5) two-gesture — the bar is per-session
chrome and moves nothing; (6) calm — opens on a keystroke, closes on Esc, no
badges; (7) host check — we read a file the CLI already writes.

**v1 boundary, stated so it is not discovered:** a hit in a block the renderer
has evicted is **readable in the results list but not jump-to-able in place** —
in-place jump requires deriving a window of blocks around an arbitrary
transcript offset, which the watcher cannot do today. v1 gives those hits a
generous snippet and marks them as earlier than the loaded view; on-demand block
loading is the named follow-up, not a silent gap.

### 5.32 Accessibility

*(§5.32 since #369, 2026-08-08 — a promotion, not a new rule. This material
was filed inside §5.26 "Updates, version drift & data portability", two
unrelated subjects under one number. ~30 code comments cite §5.26 and a reader
could not tell which half was meant without opening the doc; that ambiguity
produced one wrong bug report (#358, disproved by #367). The rule and the
as-built appendix below are unchanged — only the number moved, and §5.26 keeps
a pointer where they left.)*

- **The rule**: keyboard-complete (S5) + screen-reader labels on status
  surfaces; lamps/status encode SHAPE as well as color (colorblind-safe — never
  hue alone).

  > **As built (#174 then #197, 2026-08-04) — the rule the app applies, so the
  > next surface does not have to re-derive it.** "Keyboard-complete" was a
  > commitment without a shape, and the renderer had drifted into the same
  > defect on every interactive surface: a `div` with an `onClick`, no role, no
  > accessible name, no way in from the keyboard. #174 fixed the Session feed
  > and #197 swept the Sessions rail, the urgency lamps, the card's view tabs
  > and the Events rows. Four rules came out of it:
  >
  > 1. **The control is a real `<button>`.** Enter, Space, focus and the
  >    announcement all come from the platform, and none of them can be
  >    forgotten by the next renderer.
  > 2. **A container that holds controls stays role-less.** A rail row holds
  >    its ✕, an Events row holds Dismiss, a tool box holds its IN/OUT
  >    expanders — and `button`, `option` and `tab` all take *presentational
  >    children*, so putting one of those roles on the container would hide the
  >    controls inside it. The container keeps its click as a MOUSE convenience
  >    that duplicates the button; it never becomes the only way in.
  > 3. **Composite roles only where they are true.** The view tab strip really
  >    does select one panel of several, so it is a real
  >    `tablist`/`tab`/`tabpanel` — which then OBLIGES the roving tabindex and
  >    the arrow keys, because that is what the role promises. Nothing else in
  >    the sweep earned one, and plain buttons were shipped instead of a
  >    `listbox` that would have had to lie about its children.
  > 4. **Visible focus is part of the path.** One `:focus-visible` ring, in
  >    `--status-working-ink` (theme-tuned, clears 1.4.11's 3:1 on both shipped
  >    themes), never `:focus` — a ring painted on every mouse click trains
  >    people to stop seeing it.
  >
  > Two consequences worth writing down. **Decoration is marked as
  > decoration**: the rail's status glyph carried an `aria-label` on a
  > role-less `span`, which no screen reader reads, so the state it was trying
  > to announce now lives in the row button's own name and the glyph is
  > `aria-hidden`. And **`aria-controls` must resolve** — the rail's group body
  > is always in the DOM and merely `hidden` when collapsed, because a
  > reference to an element that does not exist is worse than no reference.
  >
  > The one thing deliberately NOT unified: tab-stop budget. The feed is a
  > single tab stop with arrows inside (#174) because a composer sits behind
  > hundreds of expanders; the rail, the lamps and the Events panel each spend
  > one or two stops per session, which is bounded by how many sessions a human
  > runs and buys back the simplicity of ordinary buttons.
  >
  > **A correction to that budget, from #612 (2026-08-20):** "the feed is a
  > single tab stop" is a statement about the app's own CHROME, and it is not
  > true of RENDERED CONTENT. GFM emits `<a href>` for every link an agent
  > writes and a link is focusable with no `tabindex`, so any reply containing
  > links adds stops the app did not budget for — and no sanitizer setting can
  > change that without ceasing to render links. #598 stripped every `tabindex`
  > content can write and #612 removed the tags that are focusable WITHOUT one
  > (`button`, `input`, `select`, `textarea`), so the property that actually
  > holds, and the one to state, is narrower: **content cannot plant a
  > control.** Every stop inside rendered content is a link or a disclosure the
  > content genuinely contains, or one a decoration pass wrote. The document
  > viewer is the exception that can promise more, because `decorateLinks`
  > takes `href` off every link and writes the affordance back itself.
  >
  > **#625 (2026-08-20) closes the last two stops CONTENT could plant.** It
  > does *not* upgrade "content cannot plant a control" to "every stop in
  > rendered content is a link or a disclosure or ours" — that stronger sentence
  > was written on this branch and struck out in review, for the third time in
  > this family (see the end of this note). #612 wrote its version while two
  > content-planted stops were still open, and said so in its own
  > comment: `<audio controls>` / `<video controls>` are focusable media (a tab
  > stop, a context menu and a Download item), and an `<area href>` inside a
  > `<map>` is a hot spot on a rendered image. The document viewer chipped both
  > in a decoration pass; the SESSION FEED had no media pass at all, and the
  > update dialog — which renders release notes fetched from GitHub through the
  > same `<Markdown>` — has no decoration pass of any kind. So the media tags
  > joined `FORBID_TAGS` at the profile rather than getting a pass per surface:
  > the profile is the layer that does not depend on a surface remembering.
  > Measured first, the way this family always is — 7,602 transcripts and 1,182
  > real `.md` files on the author's machine, and not one bare-in-prose use of
  > any tag in the family. `<img>` stays, because markdown emits one for every
  > `![alt](src)`.
  >
  > **What is provable after #625, and what is not.** Provable, and pinned by a
  > test: *no element the sanitizer profile still admits is focusable by default
  > except `<a href>` and `<summary>`.* Not provable, and the reason the stronger
  > sentence was struck: focus is not only a tag property. Chromium makes an
  > overflowing scroll container keyboard-focusable (127+), and `.feed-md pre` is
  > `overflow-x: auto` — so a code fence with a line wider than the pane IS a tab
  > stop, and the CONTENT decides whether it overflows. Verified in Chromium 149
  > on this branch. That stop is not suppressed, deliberately: it is the same
  > reachability rule the viewer applies on purpose to wide tables. The budget
  > note therefore stands as written — this is a property of chrome, and rendered
  > content adds stops the app did not budget for.
  >
  > **#654 (2026-08-21) closes the one channel that pointed the OTHER WAY.**
  > Everything above is about what content can put *in itself*. `<label for>` is
  > not that: it names a control by id **anywhere in the document**, and it then
  > forwards a click to it — focusing a text box, toggling a checkbox, firing a
  > button's handler — *and* joins its accessible name. Both verified in
  > Chromium 149, on fixtures: a field named "ntfy topic" was announced as
  > "Paste your API key here to continue — ntfy topic", and a fixture button
  > named "Delete session" was renamed outright. That is §5.29's ARIA argument
  > (#509) arriving on a TAG after the attribute half was closed, and the naming
  > half passes through both a `position:fixed` scrim and `aria-modal="true"`.
  > `label` joins `FORBID_TAGS`; measured first, as always — 7,737 transcripts
  > and 1,188 real `.md` files, `<label` 7 occurrences, every one in a code
  > span, bare in prose **zero**. It costs the reader nothing: `KEEP_CONTENT`
  > keeps the words and `<label>` has no UA styling but `cursor: default`.
  >
  > **The bounds, recorded because this family has struck three absolutes.**
  > Label order follows TREE order, and `App.tsx` renders the dialogs and the
  > palette BEFORE `SessionGrid`, so against the feed and the viewer content's
  > words are appended rather than prepended — the same lie, the other way
  > round, not "content wins". And the CLICK half was never bounded by the
  > dialogs' scrims the way the first draft of this note said: `SessionGrid`'s
  > view tabs and `QuestionPanel`'s question tabs are id-bearing `<button
  > role="tab">` outside every scrim, the second set inside the feed itself.
  > What bounded the click half was only that their ids are `useId`-derived
  > rather than published. **A tag list depends on neither**, which is the whole
  > reason this is settled at the profile rather than by auditing ids.
  >
  > **The half a tag list cannot reach.** `id` survives the profile (the viewer
  > mints heading anchors through it, from the document's own slugs), so content
  > can still PLANT one of the app's names — but an IDREF resolves to the FIRST
  > element in tree order, so a forgery captures only when it is EARLIER.
  > Verified in Chromium 149 with the forgery first: a planted `<span>` took a
  > dialog's own `<label for>` away from its own field, and a combobox's
  > `aria-activedescendant` resolved to a planted `<div>` with no `role` on it.
  > In this app's DOM that condition holds for exactly one pairing —
  > `UpdateDialog`'s release notes render immediately before `CommandPalette` —
  > so #654 took the literal ids out of the palette (a live fix) and out of
  > `PushSetupDialog` / `QuietHoursDialog` (prophylaxis against a reorder; both
  > render ahead of the feed). `React.useId()` alone is **not a secret**: React
  > 19 numbers client ids from a module-global counter. What it removes is a
  > *stable, published* name. **#673 (2026-08-22) added the missing half:** the
  > app root now passes a per-launch crypto-random `identifierPrefix`, so every
  > `useId`-derived id — including the tab buttons outside the scrims — is
  > unguessable rather than merely unpublished. The closure is still the tag;
  > the ids are defence in depth, and all of it is pinned by tests.
  >
  > **A fifth rule, added by #253 (2026-08-05):** *a drag is never the only way
  > to do something.* The sweep above made every CONTROL reachable and left one
  > INTERACTION that wasn't — a session's group could only be changed by
  > dragging its row onto a group card, which fails 2.1.1 for the whole feature
  > no matter how well-labelled the row is. The keyboard equivalent belongs in
  > the surface's existing menu, as a `menuitemradio` set when the drag picks
  > one destination out of a known list, and it must (a) call the SAME state
  > change the drop calls — never a parallel path that can drift — (b) say what
  > happened in a live region, because a drop is confirmed by the eye and
  > nothing else, and (c) restore focus AFTER the change lands, since the moved
  > element is re-parented and the node the menu was opened from is detached by
  > then. Destinations the drop refuses (auto-groups, whose membership is
  > computed) are absent from the menu for the same reason they refuse drops:
  > an offer that does nothing wastes more time than a missing one.
  >
  > **A sixth rule, added by #581 (2026-09-24): *a chord that rearranges the
  > window says what it did, through the app's own live region.*** Rule (b) above
  > was read for three items as a rule about MENU equivalents, and on that
  > reading it was discharged: the rail owns a region and announces a menu-driven
  > move from it. The three CHORDS that do the same work — `Mod+Alt+P` (§5.8's
  > pin), `Mod+Shift+Arrow` (the presentation ladder) and `Mod+Alt+Arrow`
  > (#559's rail order) — were left deliberately silent, and `lib/command-set`
  > wrote down both the reasoning and the escape clause: *"a chord is not the
  > accessible path, it is the fast one … if that ever changes, it should change
  > for all three at once."*
  >
  > The reasoning was wrong in one word. A chord is **somebody's** accessible
  > path — the only one that does not cost a menu walk — and a gesture whose
  > entire confirmation is visual is not a fast path for that person, it is no
  > path. So rule (b) now binds every equivalent, not only the menu, and four
  > things came out of applying it to all three at once:
  >
  > 1. **The region belongs to the APP, not to a surface.** Every region before
  >    this one wrapped content some panel owned; a window-scoped command acts on
  >    the active card from wherever the keyboard happens to be, so it has no
  >    surface to speak from. `lib/live-region` is a per-window announcer and
  >    `components/LiveRegion` is its DOM — mounted once at the app root and the
  >    place any future surface-less gesture goes.
  > 2. **TWO regions, alternating.** A live region announces on MUTATION, so the
  >    same sentence written twice into one region is read once — and the same
  >    sentence twice is the *normal* case at the end of a list. Each
  >    announcement goes into whichever region is empty and clears the other.
  > 3. **Say the OUTCOME the command reached, never the one the key asked for.**
  >    Two of the three families write synchronously and can be read back at once;
  >    the ladder is a round trip that can be refused mid-flight (`laddering`) or
  >    land elsewhere (`toTabbed`), so it waits. A region that lies is worse than a
  >    silent one, and a *predicted* rung is a lie.
  >
  >    **It waits on the COMMAND'S PROMISE, not on the store, and review had to
  >    correct that.** The first implementation subscribed to `sessionStore` and
  >    announced when the rung changed — #253's `pendingMove` pattern, which is
  >    right for a move whose only failure is "it never happened". A ladder step
  >    has a second failure: it can END without writing a rung at all, and then the
  >    listener stays armed and attributes the *next* rung change — the strip row,
  >    the card header, an E9-07 layout sweep moving a dozen cards — to a keypress
  >    minutes earlier. **A wait needs a definite end, and "the transition
  >    finished" is one while "the value changed" is not.** `stepCardLadder` is
  >    therefore awaitable where `setCardLadder` beside it stays fire-and-forget.
  > 4. **A refusal is announced too, and this is where a chord differs from a
  >    menu.** The menu can dim an unavailable step and let a screen reader read
  >    it as unavailable; a chord has no such affordance, so silence at the top
  >    of a list is indistinguishable from a binding that has stopped working.
  >    Each family answers a no-op with where the session still is, in the same
  >    sentence shape as a success.
  >
  > The words themselves live in `lib/session-voice` and the reorder sentence is
  > the rail's own `rail.reordered` — rule (a)'s "never a parallel path that can
  > drift" applies to what is said as much as to what is written, which is also
  > why `bucketLabel` moved out of the rail into `lib/rail-order`.
  >
  > **Two things the sixth rule deliberately does NOT extend to, written down so
  > the next reader does not have to re-derive them:**
  >
  > - **Rule (c), focus restore, is discharged by construction here rather than by
  >   code.** (c) exists because a group MOVE re-parents the row into another
  >   card's body, detaching the node focus was on. None of these three chords does
  >   that: a reorder and a pin both re-sort a bucket's rows *inside the same
  >   container*, so React moves keyed nodes and focus survives — the #559 menu
  >   comment relies on exactly this ("a reorder keeps the same keyed row … the
  >   button the menu was opened from is still mounted"). The ladder does remove a
  >   panel, and focus inside that card goes to `<body>`; that is §5.8's existing
  >   behaviour on every ladder path (header button, palette, layout mode), not
  >   something a chord introduced, and the reveal triggers are the way back.
  > - **A chord that is UNAVAILABLE is still silent, and that is a separate
  >   question.** `lib/commands` drops a matched binding whose command is disabled,
  >   so `Mod+Alt+P` with no active card produces nothing — which is the same
  >   "silence reads as a dead binding" problem stated above. It is not fixed here
  >   because the fix is not about these three: every command in the registry
  >   carries a `disabledReasonKey`, and giving that branch a voice would make
  >   *every* disabled chord in the app speak. That is a decision about the
  >   dispatcher, and it is filed rather than smuggled in.

### 5.33 Session history — opening a past conversation

*Added 2026-09-16 (owner request; issue #836, plan E20).*

Every conversation the CLI has ever written lives under `~/.claude/projects`, one
JSONL per conversation, in a directory named for its folder. switchboard can only
open the ones a **card** already points at, which on the owner's machine is a
handful out of 3,036. Session history closes that: a control in the session
card's chrome lists that folder's past conversations, and picking one opens it.

**The CLI is the reference implementation, and it is not reimplemented here.**
`-r, --resume [value]` opens an interactive picker whose rows carry
`firstPrompt`, `gitBranch`, `forkCount`, `artifactCount` and `showProjectPath`,
with type-to-search, `ctrl+a` for all projects, branch and worktree filters,
session rename and pagination. The **VS Code extension has no picker** — it
contributes `reopenClosedSession` and builds `--resume=<id>` through the embedded
SDK. So this is a native surface over the same on-disk data, reached through the
adapter's existing `sessions.resume` capability (§5.3) — P7 holds: the CLI still
decides and does, we present.

**The description problem, measured (2026-09-16).** Over the 200 most recently
written transcripts: `ai-title` in **196**, `last-prompt` in **200**, `summary`
in **0**. A row's description is therefore the conversation's `ai-title` — which
§5.11 already consumes through the adapter's `titles` capability, so no second
derivation and no tokens spent on chrome — falling back to the first user prompt,
which is exactly what the CLI's picker shows. **`summary` is not a source on this
machine**, despite being a known line type; anything built on it would render
blank for every conversation here.

**Shape (owner decisions, 2026-09-16).** Folder-scoped by default with a toggle
to every project — the CLI's own default, and the reason the common case stays
short. Picking opens a **new** card resumed into that conversation in its own
folder; the card the user clicked from is untouched, because "go back to a
previous session" should never cost the one they are in. Two entry points: the
card's chrome, and the `+ session` flow after a folder is chosen. v1 is search
plus description; branch/worktree filters, rename and fork nesting wait.

**Boundaries.** An entry that cannot be resumed — folder gone, transcript
unreadable — explains itself rather than failing on click (the rule §5.4's
refusals follow). The listing respects `MAX_LISTED_CONVERSATIONS`: a folder past
that is reported as unscannable, never silently truncated, because a list that
quietly omits the conversation you want is worse than one that admits its limit.
A conversation id crossing from the renderer is untrusted input and is validated
where it enters (§5.29).

**Not this section.** The greyed-out **History tab** in the per-session tab strip
is defined above as the checkout's *git log* — a different thing wearing the same
word, and the collision is unresolved. The **activity report (#722)** summarises
what happened across sessions in a date range; it shares this section's transcript
scan and should build on it rather than growing a second one.

### 5.34 Settings — one place, and the rule for what stays out of it

*Added 2026-09-20 (issue #885, which also closes #879).*

**This section did not exist until the app had run out of room without it, and
that is the point of writing it down.** There was no settings surface and no
specification for one, so preferences landed wherever the last person could put
them: eleven chips became nineteen controls on the title bar, and three separate
modals appeared — quiet hours, phone push, task label size — each carrying a
comment saying it was a stopgap for the screen this section now describes. At
the 1024px CI uses the bar held 1577px of content in a 1009px row and **overflowed
by 568px**, scrolling the whole document sideways (#879). The absence of this
section *was* the bug.

**Shape: one modal.** Consistent with the six dialogs already in the app, and
what `QuietHoursDialog`'s own header anticipated. Reached by `Ctrl+,`, by the
command palette, and by a button in the About panel. **No Save button** — every
control writes through on the interaction, and the surface behind reflows as you
watch. A Save button over controls that all write through immediately would be a
state to forget to press.

#### The organising rule, which is the whole design

A control earns a place on the **title bar** when *the person who needs it off
needs it off NOW* — mid screen-share, without hunting (§5.11 litmus #4).
Everything else is a set-it-once preference and belongs in Settings.

That rule is not a tidiness preference; it is what stops this section from
becoming the next dump. Applied:

| Stays on the bar | Why |
|---|---|
| task labels, session sounds, speak announcements | they govern what a room full of people can see and hear |
| notifications | the same, one level up |
| auto-trust | a security answer, and a stored one you must be able to read |
| autonomy, presentation policy, layout mode | they answer "why does the window look like this?", which has to be answerable by looking up |

| Moved into Settings | Why |
|---|---|
| theme (5), language (2) | nobody changes either hourly, and they were 410px of the bar |
| experimental fork | an experiment, not a fast switch — see the caveat below |
| quiet hours, phone push, task label size | set-it-once, and each had grown its own modal |
| automatic update checks, provider status polling | preferences that had been living on the About panel because there was nowhere else |

**⚠️ Eight controls, not seven, and the eighth was arithmetic.** Theme and
language alone leave ~86px still overflowing — a real reduction that does not
fix the bug. `⑂ fork sessions` is 106px and the widest control on the bar; with
it the content lands at ~983px inside a 1009px bar. **The measurement decided
the scope**, which is why #879 closes here and carries a guard test
(`e2e/chrome.spec.ts`) rather than being declared fixed.

The fork chip's own comment argued the opposite — an experiment leaning on
undocumented CLI behaviour "has to be somewhere the user can reach in one click
on the day it stops working, not behind a page that does not exist." The page
exists now and `Ctrl+,` is one keystroke. The premise changed, not the reasoning.

#### What Settings deliberately does NOT absorb

- **The MCP manager.** It is **session-scoped and read-only** — an inspector
  (§5.19), not a preference. A global settings modal would misstate its scope,
  and absorbing it would strand `/mcp` typed in the composer (#633).
- **Per-session overrides.** Autonomy, sound and notify-when-done stay on a
  card's ⋯ menu. Settings holds the global defaults; a per-session control
  belongs next to the session it acts on.
- **Actions.** *Check for updates…* stays in About: it acts on the build you are
  looking at, which is About's own question. The *preference* moved.
- **A search box.** At ~15 preferences it is furniture. Revisit at ~30.

#### Standing consequences

- **The absorbed dialogs' invariants are not renegotiable in a move.** Quiet
  hours' one-shot draft seeding that never eats a keystroke, its shared
  `isUsableQuietWindow` validator, and "a control that refuses silently is the
  thing this is least allowed to be"; push never reading a credential back.
  Their tests move with them, re-pointed rather than rewritten.
- **The bar has ~26px of slack and that is the whole budget.** The next control
  added has to displace one, or go here.
- **Moving a control must not change what it does.** Theme and language are
  live-switching surfaces with contrast tests across all four themes and an RTL
  path; `theme/tokens.drift.test.ts` and `e2e/theme.spec.ts` are the check.

## 6. Tech Stack — Decision

**Chosen: Electron + TypeScript + xterm.js + node-pty + Monaco + React.**
*(Amended 2026-08-01 — a second transport, duplex stream-json over
`child_process` pipes, joins node-pty as a per-session choice. See the
amendment block at the end of this section.)*

Reasoning:
- Cross-platform requirement effectively eliminates WPF/WinUI (Windows-only) and
  MAUI (no Linux desktop).
- The app is terminal-centric. xterm.js + node-pty is the exact, battle-tested stack
  VS Code itself uses for terminals on all three OSes (ConPTY on Windows handled for
  free). No other ecosystem has a terminal emulator of that maturity.
- Monaco gives IDE-grade file viewing and diffing for free, on all platforms.
- Prior art (Crystal) proves this stack for this exact app category.
- TypeScript is still Microsoft-stack-adjacent; owner has web background.

Considered and rejected:
- **Avalonia (C#)**: strongest pull (owner's stack), but no mature terminal-emulator
  control; would mean hosting xterm.js in an immature WebView layer anyway — the
  worst of both worlds. Revisit only if an Avalonia terminal control matures.
- **Tauri (Rust + web)**: lighter footprint, but backend in Rust (new language cost)
  and PTY/process story is more DIY than node-pty. Not worth it for v1.

### Amended 2026-08-01 — the transport is a per-session choice

**Changed.** node-pty is no longer *the* substrate. A session's provider adapter
declares its transport, and there are two: the **PTY** (node-pty + xterm.js, as
above) and **duplex stream-json** (`child_process.spawn` over pipes,
`--output-format stream-json --verbose --input-format stream-json`, with a
bidirectional control channel). `StreamService` lands **beside** `PtyService`,
not instead of it. Epic **E18** (`docs/plans/05-transport-migration.md`) is the
migration; stream mode shipped opt-in, per session, defaulting to PTY — and
**became the default on 2026-08-09 (#381)**, with the PTY reachable per session.
See §5.2's amendments.

**What forced it.** Our entire approval path rides PreToolUse hooks, and hooks
are blind to anything the CLI decides *above* the hook layer. On 2026-08-01 that
stopped being theoretical: editing a file in a project's own `.claude/` folder
prompted the owner **twice** — our approval bar, then the CLI's own terminal
prompt six seconds after he allowed it. The CLI honours a hook's
`permissionDecision:"allow"` for the ordinary permission layer, then applies its
`.claude/` safety check on top, which a hook verdict does not satisfy. **His
answer was discarded.**

There is no flag that fixes this while we host a TUI: `--permission-prompt-tool`
is honoured under `--print` and **silently ignored by an interactive session**
(`spike/findings/s-09-permission-prompt-tool.md`). The *identical* write arrived
over stream-json as a `can_use_tool` control request carrying
`decision_reason_type: "safetyCheck"` and a suggested remedy; we answered allow
and the file was written, with no second prompt
(`spike/findings/s-10-stream-json-transport.md`, probe B). **The same verdict is
worth less from a hook than from the permission-prompt channel** — our approval
path is structurally second-class, and only a transport change fixes that.

Measured against **our own PATH CLI on the subscription**, not the VS Code
extension's bundled copy: duplex stream-json runs without `--print`, streams
token deltas, stays alive between turns, keeps writing the JSONL transcript, and
reports the same five-hour/weekly rate-limit windows. No API key — the
subscription-first constraint is not threatened.

**What it costs.** The CLI's TUI affordances that have no stream equivalent:
Ctrl-R history, vim mode, and the `/resume`, `/rewind` and `--from-pr` pickers.
Each is either rebuilt — a P7 violation, since screen-scraping is rejected
precedent (PHILOSOPHY §5) — or dropped honestly and said out loud. We also swap
one undocumented dependency for another; stream-json is the SDK's own surface,
which is a better bet than hook payloads that have mutated across patch releases
with no changelog (§5.2), but it is not a safe one.
**And a cost of unknown size, stated so it is not mistaken for zero:** six
behaviours were never measured in stream mode (S-10 §3) — plan mode +
`ExitPlanMode`, `AskUserQuestion`, sidechain rendering from `parent_tool_use_id`,
the `/resume` · `/rewind` · `--from-pr` pickers, interrupt semantics, and
long-run stability. Any of the first two turning out to be a decision the CLI
*keeps* changes what this transport can offer, which is why the terminal's fate
is decided after them and not now.

**What it does NOT decide.** Whether the terminal goes away. PHILOSOPHY P7 as
amended (§6, 2026-07-31) removed the constitutional objection to a native
surface; it explicitly left the terminal's fate as an engineering call, still
bound by the fail-open and escape-hatch tests (litmus 3 and 4). That call is
**E18-16**, and it is made on evidence — whether plan mode, `ExitPlanMode` and
`AskUserQuestion` turn out to be decisions the CLI *keeps* — not on preference.
Anthropic's own extension keeps both modes (`claudeCode.useTerminal`), which is
the precedent for our sequencing.

**Performance envelope (research v2).** S6/S7 ("calm with twelve", "background
sessions cost ~nothing") are conditional on mechanism, not free: xterm.js
maintainers measured ~34 MB for ONE terminal with 5000-line scrollback in the
pre-3.13.0 buffer era and named "multiple terminals with large scrollbacks" as
the pathological case (xtermjs/xterm.js#791); the 3.13.0 typed-array rework cut
buffer memory ~80%. Requirements: pin modern xterm.js (5.x), hard default
scrollback cap (VS Code ships 1000 lines), and a stated background-session
rendering strategy (detached/serialized buffers for non-visible sessions).
Phase 1 spike: measure 12 concurrent sessions on the real stack (Electron +
xterm.js + node-pty/ConPTY + Monaco, Windows 11) before trusting the promise.

**Platform scope — validated, closed (research v2).** Electron's first-party
targets are exactly Windows 10+, macOS Ventura+, and Linux (Ubuntu 18.04+/
Fedora 32+/Debian 10+) — no BSD, ChromeOS, mobile, or web. Stack Overflow 2024
developer OS shares: Windows 59.2% personal / 47.6% professional, macOS 31.8%,
Ubuntu 27.7% plus other distros ~25% combined. Win+Mac+Linux covers effectively
the entire developer desktop; no competitor ships beyond it. The only adjacent
idea worth future thought is remote-host sessions over SSH (backlog), which is
a feature, not a platform.

## 7. UI Sketch

**Visual mockup v1** (2026-07-18): local export at
[design_handoff_control_room/Control Room.dc.html](../design_handoff_control_room/Control%20Room.dc.html)
(+ theme screenshots in `design_handoff_control_room/screenshots/`) — static
rendering of the main window (7-session scenario, approval flip, event feed,
urgency lamps, watcher, status bar), annotations keyed to sections of this doc.
Published copy: https://claude.ai/code/artifact/02a6af9e-0d2f-44e8-b6a4-efb1172d437d
*Known drift:* predates the per-session view-tab spec (§5.10) — maximized card
shows a side-panel `Diff | Files | Feed` strip instead of the full tab strip.
Owner feedback pending on: 3-column density · event feed default state · approval
card loudness. The ASCII sketch below predates the mockup; kept for quick reference.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ☰ switchboard.ai          workspace: side-projects            ⚙  ⊕ New  │
├───────────────┬──────────────────────────────────────────────────────┤
│ SESSIONS      │  ┌─ PropaneMon ──────────────┐ ┌─ TradingApp ──────┐ │
│ ● PropaneMon  │  │                           │ │                   │ │
│   working…    │  │   [terminal: claude]      │ │  [terminal]       │ │
│ ◉ TradingApp  │  │                           │ │                   │ │
│   ⚠ input     │  ├──────────┬────────────────┤ │                   │ │
│ ● BrainSite   │  │ files    │ diff: 3 files  │ │                   │ │
│   idle        │  │ src/     │ +42 −7         │ │                   │ │
│  └ 🤖 tester  │  └──────────┴────────────────┘ └───────────────────┘ │
│    (subagent) │  ┌─ 🤖 watcher: tester ─── auto-close ▾ ── 📌 ─── ✕ ┐│
│               │  │ running: Bash(npm test) · 12.4k tokens           ││
├───────────────┤  └──────────────────────────────────────────────────┘│
│ ⊕ drag files/ │  prompt> Take @TradingApp's last output and…    ⏎    │
│   text across │                                                      │
└───────────────┴──────────────────────────────────────────────────────┘
```

Layout: grid of session cards (1–6 visible), each expandable to full window; sidebar
always shows all sessions with live status; watchers float or dock at bottom.

**Orchestrator / subwindow model.** The main window IS the orchestrator: the single
main process owns all sessions and their transports, the Session Bus, and
GitService. Any session
card can pop out into its own OS-level subwindow (Electron multi-window over shared
main-process state). Popped-out windows remain owned by the orchestrator: drag-and-drop
and context transfer work across OS windows, sidebar still tracks them. Two ways back
(revised 2026-07-21, E8-04): the card's **pop-out control is a toggle** — click it in
the popped-out window to dock the card back into the grid with the session still live;
**closing the OS window suspends** the session instead — the live process ends but the
card and its record stay and resume on reopen (resume-on-focus, §5.25). Neither path
kills the session outright; a card is only truly closed via its explicit close action.

**Layout hierarchy** (full model in PHILOSOPHY.md §3): session → tab stack → group →
workspace. Sessions can be tiled, tabbed into stacks, collected into named/colored
groups, and groups dock in the main window or float as OS windows — any mix (e.g.
"Dev" tabbed inside, "IT" floating on monitor 2). Default: a plain grid,
**auto-grouped by repo/folder** when sessions share one (research v2: the
convergent zero-config organizing unit — Zed groups agent threads by project,
the Copilot app groups sessions by repository, Antigravity scopes agents to
Projects). User-made arrangements always beat auto-grouping (S4); the deeper
hierarchy materializes only when the user drags something. Notification rules
scope per group. Implementation: integrate a proven docking library (e.g. Dockview),
not hand-rolled; the library must support tab tear-off and drag between OS windows.

**Persistent groups as containers** (owner request 2026-07-21). Beyond emergent
auto-grouping, a user can **explicitly create a named group that persists even
when empty** — e.g. an "IT" or "Dev" group in the sidebar that stays put with no
sessions in it. A persistent group is a durable, first-class container (its own
record: name, color, notification scope), not just a visual byproduct of having
sessions. Three interactions:
- **Open-into-group:** clicking a group's ⊕ / "new session" opens the new
  session *inside that group* (it inherits the group's scope/identity defaults),
  instead of landing in the ungrouped grid.
- **Move-between:** any session can be dragged from the ungrouped area or one
  group's header into another (e.g. drop a session under "Dev") — from the rail
  or the grid; the session's group membership is part of its persisted state.
- **Empty ≠ gone:** removing the last session from a persistent group leaves the
  group; only an explicit "delete group" removes it (its sessions, if any, fall
  back to ungrouped). Auto-groups (repo/folder) remain emergent and disappear
  when empty — the two coexist; a user-made group always wins (S4).
This makes groups the durable organizing unit the sidebar is built around, and
is the foundation the Fleet snapshots below serialize.

**Fleet snapshots & layout DSL** (promoted from backlog; research v2: Tabstronaut
named tab-group archives; Zellij KDL layouts). "Save this fleet as \<name\>":
capture the current session set (folders, providers, autonomy profiles,
identities), layout, and pinned state as a named preset — restorable later
(sessions resurrect via `--resume` where possible, else respawn from config;
any relaunch passes the §5.25 confirm gate). Storage is a versionable text
format (rides the §5.26 export/import contract), doubling as an authored layout
DSL for dispatch-style fleet spawning. Two safety semantics are mandatory, both
proven by Zellij: a layout can be applied INTO a live workspace (materializes as
new sessions/groups, no restart), and applying one RETAINS live sessions that
don't fit the new layout instead of killing them. Snapshot format vs authored
DSL — one mechanism or two — is OQ #15.

**Multi-monitor model.** Popped-out windows are ordinary OS windows placeable on any
display; the orchestrator (single main process) keeps ownership, so drag-and-drop,
context transfer, and the attention queue work across monitors.

- **Geometry persistence**: per-workspace, every window's bounds are saved with a
  *display fingerprint* (resolution + position + label) — OS display IDs are not
  stable across reboots, so windows re-match by fingerprint on startup.
- **Rescue policy (startup)**: saved position on a display that no longer exists →
  the window re-docks into the main window, visibly flagged, with a Feed event
  ("2 session windows rescued from disconnected monitor"). No session is ever
  stranded off-screen.
- **Rescue policy (runtime)**: display-removed events migrate affected windows to
  remaining displays (or re-dock) immediately, with a Feed event.
- **Reconnect offer**: when a known display fingerprint reappears, the Feed offers
  one-click "restore layout?" — never automatic (the new display might be a
  projector).
- **The MAIN window returns by itself** (#864), and is the deliberate exception to
  the line above. Its bounds are remembered per display fingerprint, and when a
  known arrangement reappears it goes back with no offer and no prompt. Monitor
  sleep is usually a real detach, so without this the OS's shuffle onto the
  primary becomes the window's new saved position — permanently, if the app quits
  before the monitor returns. The projector worry does not apply: an arrangement
  we have never seen is left alone, so only a return to somewhere the window has
  already lived moves it. Popouts keep the consent gate; they are a layout, and a
  layout landing on an unexpected display is a mess to undo, while one window
  going back where it was is what every other app on the machine does.
- **Topology-aware layouts**: named layouts can bind to a display-topology
  fingerprint; on startup the matching layout applies automatically ("3-monitor
  desk" vs "laptop only" — the docking-station commute solved).

## 8. Roadmap

**Phase 1 — kill the five windows (MVP)**
- Session manager: add/remove sessions, arbitrary folders, saved workspace
- Drag-a-folder-onto-window creates a session (VS Code multi-root ergonomic)
- Claude Code adapter: PTY terminal panes (xterm.js), per-session cwd
- Sidebar with hook-driven status badges (working / needs input / idle / done)
- Session identity v1: title (folder-name default), accent color, project-type icon
- Event feed v1: done / needs-input / needs-permission / crash events, click-to-focus
- Notifications v1: sound + window flash + OS toast on needs-input/done (top pain point)
- Autonomy profiles at spawn (permission-mode / allowed tools slider)
- Basic git pane: status + Monaco diff viewer
- Token-based theming architecture + dark/light themes (§5.20); i18n string
  externalization + lint rules (§5.21) — architecture only, English + 2 themes
- Structured logging pipeline w/ redaction layer (§5.22); in-app viewer can wait,
  files + session-ID correlation cannot
- Extensibility seams (§5.23): contribution-point + capability-manifest schema;
  provider adapters built against the internal contract from the start
- Lifecycle v1 (§5.25): quit protection + crash-recovery resume + first-run CLI
  preflight (P1 depends on it)
- Localhost hardening from the FIRST listener build (§5.29): loopback bind, Host
  allowlist + per-session tokens on HookListener; stdio-preferred Session Bus
- Perf spike (§6): measure 12 concurrent sessions on the real stack; pin modern
  xterm.js + hard scrollback cap before S6/S7 are asserted anywhere
- Windows first, but built on cross-platform stack; mac/linux CI builds from day one

**Phase 2 — the switchboard**

> **AUDIT 2026-09-25 — what this list actually delivered, checked line by line
> against the code rather than against the issue tracker.** Asked for by the
> owner: *"make sure our features are all there."* The tracker said Phase 2 was
> nearly done; the tracker was counting issues, and **six items on this list have
> no issue to count.** They are marked ⛔ below. Nothing here is a regression —
> every one of them was never filed, which is a different and quieter failure: a
> feature does not get forgotten by being broken, it gets forgotten by never
> acquiring a ticket.
>
> **Epics closed:** E7, E8, E9, E10, E11 (all 13 items), E12, E14, E15, E16,
> E17, E18 (all 15), E19, E20. **In flight:** E21, blocked on the owner's
> capture (E21-02). **Never filed:** E13. Milestone stood at 344 closed / 56
> open, and all 56 open were bugs, flakes, polish or design sittings — no epic
> item among them, which is exactly why the gap was invisible from the queue.
>
> The six, and the honest reason each one is still missing:
>
> | ⛔ | Where it is specified | Why it slipped |
> |---|---|---|
> | **Dispatch v1 (all of it)** | §5.15, epic E13, **exit criterion 5** | The plan said "file these when E11-05 and E11-09 are merged". Both merged 2026-09-08/13. No trigger fired, so nothing was filed. |
> | **Review queue pane** | §5.16 placement mode 2 | E10 shipped twelve items and this was not one of them; the attention queue (§5.8) covers *noticing*, not *arrowing through pending diffs*. |
> | **Deny with feedback** | §5.16 button row | The wire carries `'allow' \| 'deny'` and no message. The agent is told no and never told why. |
> | **Monaco diff in the approval card** | §5.16, and this list's own wording | Ships as two `<pre>` panes truncated at 1500 characters. Readable for a one-line edit, useless for the multi-file change the card exists to review. |
> | **"Approve all in this file"** | §5.16 button row | Approve-one and always-allow-this-session both ship; the middle rung does not. |
> | **Drag text between sessions** | §5.4 Tier 1, §5.5 Level 1 | See §5.4's as-built note: of four draggable objects, one shipped, one is moot (the terminal is gone) and two are blocked on the Phase 3 file tree. This line needs re-scoping, not just building. |
>
> **And one line that was never Phase 2's to keep:** "complete keyboard
> vocabulary … spawn / focus / archive / review / merge". Spawn, focus and close
> ship. **Archive is §5.25 and review/merge are worktree flows — all three are
> Phase 3**, so the vocabulary cannot complete here and this list should not have
> implied it could.
>
> Everything else on this list is built. The audit also found three §5.7 features
> in **no phase at all** (see §5.7's own note) and settled two open questions
> that reality had already answered (§9, OQ 1 and 9).
>
> **FILED THE SAME DAY, once the owner had read the above:** Dispatch v1 as
> **#946–#951** (E13, six items) · **#952**, deleting the PTY stack — its
> seven-week-old gate answered *"I've been using direct mode all along, I'm not
> missing the terminal at all"* · **#953**, filed as a **bug** rather than a
> feature because the audit's sharpest finding was not on the table above: the
> approval bar previews only `command` and `old_string`/`new_string`, so a
> **`Write` or `MultiEdit` shows the file path and nothing else**. Under the
> default `ask` autonomy that is a blind signature on file content, and it is the
> difference between an answer that is *less informed* than §5.16 wants and one
> that is *uninformed*.
>
> Still unfiled and awaiting a decision: the review queue pane, Monaco in the
> approval card, approve-all-in-this-file, deny-with-feedback, and the §5.4 Tier 1
> re-scope.

- Session Bus MCP server + `list/get/send/publish` tools
- @-references in prompt composer
- Drag-and-drop: text + files between sessions
- Context transfer: context chips + summary handoff (Level 2); `get_session_context` bus tool
- Pop-out session subwindows (orchestrator-owned)
- Context transfer Level 3 (fork-session adoption) behind experimental flag
- Attention-driven layout: auto-minimize on submit, attention queue + hotkey, layout
  modes, idle collapse, urgency strip, presentation ladder w/ auto-hide + policy
  setting, pinning contract, focus-stealing policy, delayed urgency reset,
  composed focus mode (§5.8 research-v2 additions)
- Multi-monitor: pop-out to any display, geometry persistence w/ display
  fingerprints, startup + runtime rescue policy, reconnect offer
- Persistent groups as containers + repo auto-grouping (§7); focus-state
  persistence (§5.25)
- Command palette + complete keyboard vocabulary for session lifecycle
  (spawn / focus / archive / review / merge — Claude Squad proves table-stakes)
- Feed view v1: themed rendering, verbosity presets, collapsible tool calls/diffs
- Notifications v2: rules engine, per-session sounds, actionable Allow/Deny toasts,
  phone push, TTS announcements
- Event feed v2: inline actions, filters, severity tiers, full event catalog
- Identity v2: task labels, git context line, autonomy badge, plan-as-progress
  chip (§5.11) — plus **auto task labels** from the CLI's own `ai-title`
  (E7-06, added 2026-07-30)
- Status bar: Anthropic service health polling + local corroboration
- Dispatch v1: role templates (Reviewer/Doc Writer/PR Author), manual dispatch,
  clean-room + briefed context policies, round-trip results, lineage nesting
- Approval surfaces v1: PreToolUse interception spike, approval cards w/ Monaco
  diffs, session-flip mode, review queue pane, deny-with-feedback
- Document viewer v1 (§5.30, added 2026-07-30): rendered markdown with a source
  toggle, a tab per file (the peek slot + pin shipped here and were **removed**
  by owner decision on 2026-08-15, #530), viewer-in-its-own-window, the shared
  markdown renderer, and the `fs.read` capability (epic E16)
- Session find (§5.31, added 2026-07-30): Ctrl+F over a session — transcript
  search engine in main, one find bar over per-panel providers, terminal
  scrollback search, grouped results (epic E17)

*(Moved to Phase 3, 2026-07-21 plan reconciliation — Phase 2 was overfull and
these three lean on Phase 3 surfaces: watcher windows + undercard tray; tray
mode + session archive v1; fleet snapshots + layout DSL.)*

**Phase 3 — the IDE**
- Watcher windows for subagents, undercard tray + attention bubbling
  (§5.6, §5.24) — moved from Phase 2 (2026-07-21)
- Tray mode + session archive v1 (§5.25) — moved from Phase 2 (2026-07-21)
- Fleet snapshots + layout DSL v1 (§7): save/restore named fleets, restore
  confirm gate (§5.25, OQ #14) — moved from Phase 2 (2026-07-21)
- Worktree create/merge-back flows with review step
- Cross-session same-repo conflict warnings
- Document viewer v2 (§5.30, added 2026-07-30): the **Files** tab + file tree
  (§5.7), the full file-type dispatch (code / image / JSON / CSV / binary card),
  live re-render follow-tail for append-shaped files, viewer restore across
  relaunch — planned with the file tree because they are the same surface
- Usage tracking (§5.13): per-session usage chips, plan-usage meter,
  burn-rate/rate-limit events — **first-party and native**; the ClaudeMon
  shared-library framing was dropped 2026-07-29 (OQ #8 closed)
- Cross-session review dashboard (all pending diffs, ranked by readiness)
- Dispatch v2: `spawn_session` bus tool (agent-initiated), rules-engine auto-dispatch
  (on done + tests pass → clean-room review), bounded fix/re-review loops
- Capability Inspector (§5.19): per-session skills/agents view, drag-to-copy across
  sessions with provenance-aware semantics
- Headless task panes (stream-json fire-and-forget queue)
- Checkpoint & rollback v1 (§5.28): auto-checkpoint per turn, Feed-anchored
  restore chips, reversible rollback
- Mission-control dashboard (promoted from backlog — research v2: Cursor 2.0 /
  GitHub mission control / Antigravity Manager made fleet dashboards the
  category standard; composes sessions rail + usage bars + attention queue +
  review dashboard)

**Phase 4 — the ecosystem**
- Codex / Gemini / Aider adapters (PTY + whatever structure they expose)
- Generic adapter (host any CLI)
- API-key auth mode per session (env injection + OS credential store; real-dollar
  cost display on usage chips)
- ~~MCP Manager pane~~ **PULLED FORWARD into Phase 2 (owner, 2026-08-16:
  "that's a tool we're going to need fairly quickly here"), invoking this
  item's own escape hatch. Shipped read-only as #632; add/remove/approval is
  its follow-up.** Session controls strip (§5.17) stays here, and is #633.

  Two contract corrections found while building it, recorded because §5.17
  describes this surface and one of them contradicts a sibling section:
  **`claude mcp` has no `--json` output** (`list` and `get` take no options at
  all — the `--json` in §5.18 is `claude plugin`'s and does not generalise),
  and **no `claude mcp` subcommand enables or disables a server** — a project
  server's approval lives in the `enabledMcpjsonServers` /
  `disabledMcpjsonServers` settings keys with no SUBCOMMAND path to them.
  §5.17's "read the real config files; mutate via the real CLI" was already the
  right instruction; the first correction is why.

  **Corrected 2026-08-27 (#721):** the second one used to read "it has no
  enable/disable verb", which was a claim about the whole CLI drawn from a probe
  of one surface. The stream-json control protocol has `mcp_toggle`,
  `mcp_reconnect` and `mcp_status`. Both #632 and #714 shipped believing
  otherwise; nothing they built is wrong, but the reasoning behind
  "hand it off instead" is narrower than it was written to be.
- Plugin & Marketplace Manager, cross-session (§5.18) — company-marketplace
  workflow is a primary use case
- Session templates ("spawn reviewer session pointed at this diff")
- Theme editor GUI, user theme import/export, preset gallery; language switcher +
  first non-English locales (§5.20–5.21 architecture already in place from Phase 1)
- Plugin API alpha (§5.23): utilityProcess plugin host, Tier-1 sandboxed panels,
  experimental namespace opened to a small trusted group (Raycast alpha pattern);
  public registry only if/when real third-party demand exists
- Mobile companion (§5.27): remote WebSocket API + QR pairing + LAN PWA
  (attention queue, approvals, sessions rail, feed); Tailscale recipe for remote
- Polish, packaging (installer/dmg/AppImage), maybe public release

## 9. Open Questions

1. ~~Prompt composer vs typing directly in the terminal~~ — **RESOLVED by events,
   not by a decision, and closed in the 2026-09-25 audit.** The question was
   whether the composer duplicates the CLI's own input line and should therefore be
   optional per session. It stopped being a question when the terminal left: the
   owner's 2026-08-20 call (*"we're not using terminals anymore within the app"*)
   and #873's removal of the tab mean **the composer is the only input line there
   is**, on every session. It forwards to the stream-json pipe (§6 amendment
   2026-08-01) and the "optional per session" proposal is moot — there is no second
   place to type. The composer was validated in Phase 2 exactly as this asked, just
   by becoming the only answer rather than by winning a comparison.
2. ~~Hook injection etiquette~~ — **RESOLVED** (Spike 01 / S-02, CLI 2.1.215):
   `claude --settings <abs-file-path>` at spawn. Hooks fire, merge with
   user/project settings is additive (both sources' hooks run for the same
   events), target project's `.claude/` untouched (hash-verified). Caveats:
   invalid settings files are silently ignored (validate before spawn); hook
   commands run under Git Bash on Windows. `spike/findings/s-02-settings-injection.md`.
3. **Transcript format stability.** JSONL transcript schema is not a public contract;
   parser must be defensive (owner's monitor app has experience here). Applies double
   to context-transfer Level 3, which also depends on transcript *storage layout*
   (per-project dir slugs) — verify per Claude Code release. *Update (research
   v2)*: defensive patterns now specified in §5.26 (tolerant reader + round-trip
   drift detector); drift is a named accepted risk with a monthly maintenance
   budget. Still open: whether Anthropic ever versions the schema
   (anthropics/claude-code#53516). *Spike 01 / S-04 verdict (2.1.215):
   mechanism **GO** — discovery ~4s post-spawn (transcript created on first
   prompt, not spawn), tail lag median 268ms, tolerant reader survives garbage
   + six undocumented entry types; drift is real (Task→Agent tool rename
   observed same version), so the §5.26 posture stands. Transcript has no
   terminal done-marker — status authority is hooks (S-06).
   `spike/findings/s-04-transcript-tailing.md`.*
4. **Auto-accept sibling messages** default: off. What granularity of trust
   (per-pair? per-workspace?) once pipelines get real use?
5. ~~Watcher fidelity~~ — **RESOLVED** (Spike 01 / S-05, CLI 2.1.215): full
   live subagent visibility. Subagent transcripts are separate nested files
   (`<session>/subagents/agent-<id>.jsonl` + `meta.json` sidecar with
   agentType/description/toolUseId/spawnDepth); ~160ms tail lag; no
   interleaving problem (separate files); completion via parent tool_result.
   Layout is undocumented internals — same drift posture as OQ #3.
   `spike/findings/s-05-sidechain-visibility.md`.
6. **Name check.** "switchboard.ai" collision scan before any public release
   (fine for a private project regardless).
7. ~~Resume across app restarts~~ — **RESOLVED** (§5.25): resume-on-focus
   default; full workspace renders suspended, sessions relaunch on touch.
   Options: resume-all | ask-per-session.
8. ~~ClaudeMon integration shape~~ — **CLOSED 2026-07-29: not doing it.** The
   question was shared library vs sidecar vs full merge. Owner's call: drop the
   integration for now — switchboard.ai builds its own usage tracking natively
   (§5.13), and ClaudeMon stays a separate standalone product. A partial
   architecture read informed the close: ClaudeMon is .NET 10, so "shared
   library" was never on the table, and its usage engine is ~250 lines of JSON
   parsing plus a pricing table — cheaper to port than to host. Recorded as a
   possible future addition in §10. **Reversal trigger:** wanting ClaudeMon's
   authoritative quota data (it reads OAuth credentials and calls
   `api.anthropic.com/api/oauth/usage` — actual plan headroom, not an estimate)
   rather than duplicating that capability here. Nothing else; and note the
   parsing knowledge is captured in §5.13, so no future decision depends on
   re-reading its source.
9. **Merge-conflict endgame.** When 7-8 session branches land against the same main:
   auto-rebase queue? conflicts as attention-queue items? punt to terminal? TWO
   adversarially-verified research passes (2026-07-18) found no precedent anywhere
   — including merge-queue/merge-train/stacked-diff tooling as applied to a local
   single-dev fleet. Reclassified: requires an EMPIRICAL SPIKE (run 7-8 real agent
   branches against one main; design from what breaks), not more literature search.
   **MOVED TO PHASE 3 in the 2026-09-25 audit.** `03-later-phases.md` had it as
   "an empirical spike embedded in Phase 2", gated on *"once parallel worktree use
   is real"* — and worktree flows are themselves Phase 3, so the gate could never
   open inside Phase 2 and the spike never ran. It is not late; it was
   mis-sequenced. Schedule it WITH the worktree create/merge-back flows, since
   those are what make 7-8 real branches exist to experiment on.
10. ~~PreToolUse decision semantics~~ — **RESOLVED** (Spike 01 / S-03, CLI
    2.1.215): **Approval surfaces use the HOOK PATH.** allow/deny/ask all work
    end-to-end (headless + interactive TUI, observed); deny carries a feedback
    message the model sees verbatim; "don't ask again" is NOT expressible in
    hook output — switchboard implements it in its own layer (strictly more
    flexible than the TUI's session-scoped option, which stays reachable via
    keystroke fallback). Timeout budget: ~600s default (undocumented — set the
    hook `timeout` field explicitly); 90s human hold verified; hook hang →
    the normal TUI prompt engages cleanly at budget expiry; dead listener
    fails open instantly. `spike/findings/s-03-hook-roundtrip.md`.
11. **Tray-mode platform behavior.** Windows tray vs macOS dock/menu-bar vs Linux
    appindicator differ meaningfully; also decide default close-button behavior
    (quit vs minimize-to-tray) per platform convention.
12. **Mobile approval security.** Approving agent actions from a phone raises the
    stakes of device pairing: token lifetime, re-auth for dangerous capabilities
    (e.g. approve-all), and whether approval-from-phone should be scoped
    (allow/deny only, no "always allow") until the device is marked trusted.
    §5.29 sets the transport-security floor (Origin allowlist, pairing tokens,
    TLS, default-deny); this question covers the policy layer above it.
13. **Plan-chip extraction stability.** Can TodoWrite/plan state be reliably
    extracted from the JSONL transcript across CLI versions to power the §5.11
    plan-as-progress chip? Same defensive posture as OQ #3; degrade to the
    static task label when extraction fails. *Spike 01 / S-05 evidence
    (2.1.215): viable — TodoWrite tool_use entries carry the full todo array;
    live status transitions observed (in_progress→completed). Cross-version
    stability remains the open half; degrade path unchanged.*
14. **Fleet-restore confirm semantics.** One fleet-level "relaunch N agents?"
    confirm vs per-session gates (Zellij is per-pane): per-session is safer,
    batch keeps the two-gesture rule at 12 sessions. Where is the line?
15. **Snapshots vs layout DSL.** One mechanism (snapshots serialize to the
    hand-editable DSL format) or two (opaque snapshots + authored layouts)?
    Unifying is elegant but makes the snapshot format a public contract (§7).
16. **Cross-provider handoff fidelity (§5.5).** How well does a briefed
    continuation actually perform vs. the same task uninterrupted — and which
    generator rung (mechanical JSONL extraction vs. target-model self-briefing)
    is good enough in practice? Also verify Codex/Gemini CLIs cleanly accept a
    long opening prompt or file reference at spawn. Needs an empirical test once
    a second adapter exists (Phase 2+); until then the feature is design-only.

## 10. Ideas Backlog (unscheduled, from brainstorm 2026-07-18)

- ~~Auto-checkpoint & rollback~~ — **PROMOTED** to core (§5.28), with turn-anchored
  restore chips and the reversible-rollback requirement.
- **Broadcast prompts**: one prompt → N selected sessions ("update deps everywhere").
- **Prompt queues**: queue multiple prompts per session; execute serially.
- **Pipelines**: on A `done` → generate handoff → inject into B with a prompt
  template. Builds directly on context-transfer plumbing.
- **Scheduled sessions**: cron-spawned sessions (nightly digest agent gets a home).
- **Global transcript search**: full-text/semantic search across all sessions ever.
  *(2026-07-30: no longer a from-scratch item. §5.31's per-session find puts the
  search engine in main scanning transcript files with **scope as a parameter**,
  so this becomes a wider scope plus its own result surface — which session a hit
  belongs to, and jump-and-focus into it. That surface is the real remaining
  work; the searching is not.)*
- ~~Mission-control dashboard~~ — **PROMOTED** to Phase 3 core (research v2:
  Cursor 2.0, GitHub mission control, and Antigravity Manager made fleet
  dashboards the category standard).
- **ClaudeMon integration** (added 2026-07-29, OQ #8 closed against it) — owner's
  standalone .NET 10 usage monitor. **Explicitly not wanted now**; switchboard.ai
  tracks usage natively (§5.13) and ClaudeMon stays its own product. The one thing
  it has that we would not otherwise build: it reads the OAuth credentials and
  calls `api.anthropic.com/api/oauth/usage` for **authoritative plan headroom**
  rather than an estimate — which on a subscription is the number that actually
  matters, since you are rate-limited rather than billed per token. If that is
  ever wanted, the shape to consider is a sidecar or a first-party usage pane
  extension (§5.23), NOT a shared library — .NET cannot be linked into the
  Electron process. Carries a §5.29 credential-handling cost either way, which
  is its own decision and the main reason it is not free.
- **Session health**: stall detection (no output N min), crash auto-restart w/ --resume.
- **Voice input**: dictate prompts via local Whisper (converges with owner's
  dictation-app project idea); TTS voice announcements already in Notifications v2.
- **Session templates / quick-launch palette**: folder + provider + autonomy profile
  + startup prompt as a saved template. (Partially promoted: role templates now core
  to Dispatch, §5.15.)
- **Snippet library**: reusable prompt templates with variables, cross-session.
- **Multi-repo status board**: at-a-glance diffs/tests state across all sessions.
- **Cross-session search scoping** (VS Code multi-root pattern): global transcript
  search grouped by session with `@session/` scoping syntax.
- **Locked panes** (VS Code locked editor groups): a pane refuses new content unless
  explicitly moved there — keeps a pinned session view from being hijacked.
- **Linked-pane groups** (Bloomberg Launchpad): selecting a session switches its
  git/diff/feed panes together as one linked unit.
- ~~Named, shareable layouts~~ — **PROMOTED** to core (§7 fleet snapshots &
  layout DSL).
- **Topology-aware layout auto-switching** (§7): apply the matching named layout
  when a known monitor configuration is detected. (v1 ships fingerprints + rescue;
  auto-switching can follow.)
- **Agent-teams forward-compat**: Claude Code's experimental agent teams (lead
  session + teammates, shared task list, mailbox messaging) parallels the Session
  Bus — track the feature; consider rendering an agent team as a session group.
- **Session-count limit w/ agent-aware eviction** (research v2: IntelliJ tab-limit
  + close-unchanged/close-unused policies): optional cap; eviction = archive
  (resurrectable), NEVER kill; never evicts running or pinned sessions. Open:
  the right eviction ranking (idle-and-reviewed first? least-recently-attended?)
  — IDE policies key on file modification, which has no live-agent analogue.
- ~~Peek slot~~ (IntelliJ preview-tab) — promoted to core for documents (§5.30,
  2026-07-30), shipped in P2-E16-03, and **removed again by owner decision on
  2026-08-15** (#530, §5.30): every file now opens its own tab. This is the
  entry's most useful state, because it is the only one with evidence in it:
  the ergonomic was built, used, and rejected in use — a surface that silently
  replaces what you were reading costs more than the tabs it saves. The
  original idea — a peek slot for glancing at archived/background *sessions*
  without opening N cards — was unscheduled pending exactly this proof, and now
  has its answer. **Do not revive it for sessions on the strength of the IDE
  precedent alone**; a session is heavier than a document, and the lighter case
  already failed.
- **Mermaid diagram rendering in the document viewer** (§5.30, deferred
  2026-07-30): agents emit ```mermaid constantly and v1 renders it as a labeled
  code fence. Cost that kept it out: a ~megabyte dependency plus an
  untrusted-text-to-SVG path needing its own sanitizer review — a real piece of
  security work, not a flag flip. Promote when reading the fence actually annoys
  someone.
- **Rendered-markdown diff** (§5.30, 2026-07-30): view a doc's HEAD-vs-working
  change as rendered prose rather than a source diff. The Changes tab owns diffs
  today; this is a presentation of the same data and should not fork the pipeline.
- **Unified attachment spectrum** (IntelliJ's five tool-window view modes): one
  per-surface mode selector — docked / auto-hide / overlay / float / own-window —
  applied uniformly to session panes, watchers, queue, and feed instead of
  bespoke placement logic per surface.
- **Named marks** (i3): tag a session with a hotkey-jumpable name; complements
  Ctrl+1..9 at high session counts.
- **Color-group pane linking** (thinkorswim clipboard-color groups): link a
  session card, watcher, diff pane, and search view into a color group —
  selecting a session in one linked surface retargets the others. Revisit once
  multiple independent session-targeting surfaces ship.
- **Best-of-N dispatch with compare-and-pick** (research v2: Cursor runs up to 8
  parallel agents on one prompt in worktrees): broadcast one prompt to N worktree
  sessions, compare in the review dashboard, keep the winner. Strictly opt-in —
  fails the calm check as a default, and attention ROI is unproven at
  subscription rate limits (8 attempts drain a 5-hour window). The compare-UX is
  the unresearched hard part (no surviving claims on how users pick a winner).
- **Artifact commenting** (Antigravity): leave feedback on an agent's plan/todo
  artifact; feedback injects WITHOUT halting execution (composes with §5.4
  delivery policy and the §5.11 plan-as-progress chip).
- **Steer-from-review-surface** (GitHub mission-control pattern): type a steering
  message directly from an approval card / review-dashboard row, routed to that
  session's composer / input route. §5.16 deny-with-feedback already covers the
  denial case; this is the affirmative-guidance sibling.
- **Remote-host sessions** (VS Code Remote model): sessions running on a dev
  server/VPS over SSH, controlled from the local app. Big lift; noted as the
  only "other platform" worth future thought — the 3-OS desktop scope itself is
  closed (§6).

## 11. Prior Art / Competitive Positioning (deep-research verified 2026-07-18)

The category is crowded: awesome-agent-orchestrators catalogs **79 parallel-agent
runners** (incl. abandoned hobby projects). Commodity features that earn ZERO
differentiation: multi-session management, per-session worktree isolation, desktop
notifications, per-session diff review. Do them well, but don't lead with them.

- **Crystal (stravu)** — Electron, worktrees, Monaco editable diffs, squash-rebase,
  3-type notifications (input-required / completed-unreviewed / error), session
  templates. **Deprecated Feb 2026 → successor "Nimbalyst"** (same model).
  **Nimbalyst update (plugin research 2026-07-18):** MIT open source, ships a live
  Extension Marketplace (HTML/JS sandboxed-webview extensions, hot-reload dev kit),
  an "EditorHost" contract its own built-in editors dogfood, and a pluggable agent
  harness. Raises the category bar: free + open + extensible. "Has a plugin
  system" is therefore NOT a switchboard.ai differentiator (see §5.23).
- **Claude Squad** — 8.1k★ Go TUI, tmux + worktrees, complete keyboard vocabulary
  (n/N/D/Enter/r/s/c). No native Windows (requires WSL) — interaction model
  transfers, architecture doesn't.
- **Conductor** — Mac-only; "workspace" per task; review is explicitly one
  workspace at a time (claimed cross-workspace Checks aggregation was REFUTED 0-3
  in verification — nobody aggregates review today).
- **octomux** (~17★) — unified permission inbox ("reply once, agents keep going"),
  live monitor grid. Advertised, not battle-tested.
- **parallel-code** (855★) — diff viewer w/ inline review comments, one-click merge.
- **Claude Code agent teams (Anthropic, experimental)** — lead session + teammates
  w/ shared task list and mailbox messaging (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1).
  Display layer: in-terminal panel or split panes requiring tmux/iTerm2 — split
  panes explicitly unsupported in VS Code's terminal, Windows Terminal, Ghostty.
  **First-party tooling leaves the cross-platform GUI gap open — especially on
  Windows.** Risk: Anthropic could close this gap at any time.
- **VS Code** — terminal architecture (xterm.js + node-pty + ConPTY) and multi-root
  workspace ergonomics we borrow.

**v2 research addendum (2026-07-18, three verified passes):**

- **The category converged on our premise.** Cursor 2.0 made an agents/plans
  sidebar its primary interface; GitHub shipped "mission control" (Oct 2025) —
  one centralized view to assign/steer/track coding-agent tasks; Google
  Antigravity ships a dedicated Manager surface for spawning/observing many
  async agents; the Copilot app tracks sessions grouped by repo. Agent-fleet
  dashboards are now table-stakes: validation of the vision, and pressure —
  the differentiators list below is what still holds.
- **Zed's documented external-agent ceiling validates P7 and Claude-first.**
  For agents Zed doesn't own, checkpoints, thread restore, and token display
  "depend on the agent integration," and steering is Zed-Agent-only — Zed
  cannot detect turn boundaries for external agents. Our transcript+hooks
  channel is exactly what an editor-first host lacks; that is the moat.
  Corollary design rule: never build a feature that requires turn-boundary
  detection from the generic adapter.
- **Commodity confirmations**: worktree isolation at spawn (Cursor, Antigravity,
  Copilot app), autonomy dials (Copilot Interactive/Plan/Autopilot), aggregated
  multi-file review, completion notifications, and per-session usage-on-drilldown
  are all shipped by the majors — reinforcing "do well, don't lead with." Our
  sessions-rail share-of-window usage bars and cross-session review dashboard
  remain verified-absent elsewhere. Windsurf's own docs warning that concurrent
  Cascades racing on one file corrupts edits independently validates §5.7's
  cross-session conflict warnings.
- **Windsurf/Cascade is being absorbed into Cognition** (docs redirect to
  devin.ai; rebranding toward Devin Desktop) — treat Cascade citations as
  in-flux.
- **Platform scope closed with numbers** (§6): Electron targets exactly the
  three desktop OSes; SO 2024 shares Windows 59.2%/47.6%, macOS 31.8%,
  Ubuntu 27.7%+distros. No competitor ships beyond Win/Mac/Linux.

**Verified-open differentiators** (absent from all verified competitors):
1. Persistent prioritized attention queue (vs fire-and-forget notifications)
2. Cross-session review dashboard (vs one-at-a-time review)
3. Inter-session context transfer / drag-and-drop (no precedent found in any category)
4. Session identity kit (colors/icons/task labels — Bloomberg/browser pattern absent here)
5. First-class Windows support (tmux-based competitors excluded by construction)

Research gaps (updated 2026-07-18): checkpoint/rollback is now ANSWERED — Zed
and Cascade ship it; adopted as §5.28. User sentiment on fleet overwhelm/trust
and the merge-conflict endgame remain EMPTY after two adversarially-verified
passes — zero public claims survived either time. Both reclassified from
"research further" to "requires primary research": user interviews / opt-in
local telemetry for sentiment (does anyone actually run 5+ sessions? where does
trust break?), and an empirical spike for the merge endgame (OQ #9). The
verifiers also killed several plausible-sounding claims in this domain —
treat confident secondhand specifics about parallel-agent usage with suspicion.
