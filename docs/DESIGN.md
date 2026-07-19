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
2. SessionManager spawns the provider CLI in a PTY with `cwd` = that folder.
   Environment is augmented (see 5.4) so the agent can reach the Session Bus.
3. TranscriptWatcher + HookListener feed structured events (status, tool use, cost,
   files touched) to the sidebar without touching the interactive stream.
4. On exit/crash: status badge updates; user can restart with `--resume <session-id>`
   (Claude) to continue the same conversation.

### 5.2 Claude Code integration (first-class adapter)

All integration is via the locally installed CLI — which authenticates through the
user's `claude login` (Max subscription). Three channels:

- **Interactive PTY** (the main surface): spawn `claude` in the session folder.
  Full fidelity: permission prompts, slash commands, plan mode, TUI rendering.
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
- **Headless mode** (v2, for fire-and-forget task panes):
  `claude -p --output-format stream-json --input-format stream-json` with
  `--permission-mode` / `--allowedTools` for autonomy control.

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

**Tier 2 — @-references in prompts (user-driven, app-resolved).**
A prompt composer bar per session supports `@session` tokens:
`"Take @TradingApp's last output and apply the same fix here"`.
Before sending, switchboard.ai resolves `@TradingApp` from the Session Bus (last N
messages, or a named artifact) and injects it as context ahead of the prompt text.
Autocomplete popup lists live sessions by name/color.

**Tier 3 — Session Bus MCP server (agent-driven).**
switchboard.ai runs a local MCP server; each Claude session gets it attached at spawn
(via `--mcp-config` with a per-session identity token). Tools exposed:

- `list_sessions()` → names, folders, providers, statuses
- `get_session_output(session, lastN?)` → recent transcript tail of a sibling
- `send_to_session(session, message)` → queues a message into a sibling's prompt
  composer (delivery policy below)
- `get_session_diff(session)` → sibling's current uncommitted diff
- `publish(key, value)` / `read(key)` → shared scratchpad ("blackboard") for pipelines

Now sessions are genuinely aware of each other: the TradingApp agent can *ask* what the
PropaneMon agent changed. This runs on the subscription like everything else — MCP tool
calls are just tool calls inside a normal Claude Code session.

**Delivery policy (safety):** `send_to_session` never auto-executes in the target by
default. Incoming messages land in the target's composer as a highlighted "from
@Session" block; the user hits Enter. Per-session toggle: "auto-accept from siblings"
for deliberate pipeline setups. This prevents runaway agent-to-agent loops.

### 5.5 Context transfer between sessions

Premise: a session's "context" is not opaque server state — it is the JSONL transcript
replayed to the model each turn. Context is data on disk we can read. What is NOT
possible: splicing A's transcript into B's live conversation (strict alternating
structure, tool-call pairing, unsupported format). So context transfer = getting A's
content into B's conversation as input, at a chosen fidelity:

- **Level 1 — Excerpt injection.** Drag A's last response / text selection / file into
  B's composer. (Same mechanism as Tier 1 drag-and-drop.)
- **Level 2 — Context package handoff (default).** Drag A's *context chip* onto B →
  switchboard.ai generates a structured handoff (goal, decisions, files touched, current
  state, key snippets) and injects it into B with a "Context from @A:" header.
  Generation options: (a) ask A's own agent to write the handoff, or (b) one-shot
  headless pass (`claude -p`) over A's transcript. Summarized > raw: full transcripts
  can be 100k+ tokens and would consume B's context window and rate limits.
- **Level 3 — Full context adoption (experimental).** `claude --resume <id>
  --fork-session` starts a NEW session carrying A's entire conversation history.
  Cross-folder variant: copy A's transcript into the target project's transcript dir,
  then fork-resume there. Relies on undocumented storage layout — ship behind an
  "experimental" flag.
- **Agent-pulled variant.** Session Bus MCP tool `get_session_context(session,
  detail_level)` lets B's agent request a handoff package mid-task on its own.

Drop-dialog UX: dropping a context chip asks "Inject: last response | summary handoff
| full excerpt…" with token-size estimates shown per option.

### 5.6 Agent watcher windows

When a Claude session spawns a subagent (Task tool), its activity appears in the
transcript as a sidechain, and `SubagentStop` hooks fire on completion.

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
  global default + per-group and per-session overrides. DEFAULT is auto-collapse
  (litmus: a new user watching their session vanish on first submit fails
  intuitive-first); auto-hide is one toggle away for power users.
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
  you arrive.
- **Focus mode is a composition, with a keyboard-fail-open invariant** (research
  v2: IntelliJ Zen = Full Screen + Distraction-free; VS Code maximize-toggle):
  "focus on one agent" composes existing presentation-ladder states rather than
  being a bespoke mode. Double-click a session header (or one command) toggles
  maximize and restores the prior layout on repeat. Invariant: hiding chrome
  NEVER removes capability — everything hidden stays reachable via hotkeys and
  the command palette.

### 5.9 Notifications & rules engine

Detection is free: Claude Code fires the `Notification` hook when it needs permission
or sits idle awaiting input, and `Stop` when it finishes. On top:

- **Rules**: when [event] in [session | any] → do [actions]. Actions: play sound
  (per-session distinct sounds; optional TTS announcement "TradingApp needs
  permission"), flash taskbar/dock icon, restore/focus window, OS toast, phone push
  (ntfy / Pushover), webhook.
- **Actionable toasts**: permission toasts carry Allow / Deny buttons that send the
  keystroke to that session's PTY — approve without switching windows.
- Rule conditions include visibility (research v2: Zed's `when_hidden`): fire a
  channel only when the session/app is backgrounded — no toast for a session
  already on screen. This is the calm default for S3.
- Quiet hours / do-not-disturb; missed-events digest per session.

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

### 5.10 The Feed — rich, themeable output rendering

Each session offers two synchronized views of the same underlying session:

- **Terminal** (xterm.js + PTY): the real CLI. All interaction happens here.
- **Feed** (read-only): rendered from structured transcript/stream events —
  assistant text, tool calls, diffs, subagent sidechains — as styled blocks.

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

Guardrail (restated from Non-Goals): the Feed never accepts input beyond
expand/collapse/copy. If the CLI is waiting on a prompt, the Feed shows a "waiting in
Terminal" chip that jumps you there.

### 5.11 Session identity kit

With 7–8 sessions open, "which one is this?" must be answerable in half a second.
Every session carries an identity that renders IDENTICALLY everywhere it appears
(card title bar, sidebar, event feed, toasts, watcher windows, notification sounds):

- **Title**: defaults to folder name (full path in tooltip); user-editable.
- **Accent color**: auto-assigned from a distinguishable palette; user-overridable.
  Applied to card border, sidebar dot, feed entries, toast edge.
- **Icon**: default from project-type detection (`.csproj`→C#, `package.json`→Node,
  `Cargo.toml`→Rust, `pyproject.toml`→Python, …); emoji/icon picker to override.
  Provider badge (Claude/Codex/…) shown alongside.
- **Git context line**: branch · dirty-file count · ahead/behind.
- **Task label**: one-line "what am I doing" — derived from the last user prompt
  (optionally LLM-compressed to ≤6 words). Shown under the title, updated per turn.
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

### 5.12 Event feed — the operator's log

A dockable panel (left, default) receiving typed events from every session; one
unified, filterable inbox. Clicking an event restores/focuses its session (and
scrolls to the relevant spot where applicable). Inline actions on the event itself
where possible.

| Event | Payload / inline actions |
|---|---|
| Done | task label, duration, diff stat (+42 −7, 3 files) · [View diff] |
| Needs permission | what's being asked · [Allow] [Deny] (sends keystroke to PTY) |
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

### 5.13 Usage & ClaudeMon integration

Owner's existing app (ClaudeMon) already parses Claude Code usage; switchboard.ai needs
~80% of the same transcript parsing for the Feed and status machine. Preferred path:
**extract ClaudeMon's parsing/usage engine into a shared library** consumed by both
apps (final decision pending review of ClaudeMon's architecture — see Open Questions).

Per-session attribution is EXACT: each session maps 1:1 to a transcript JSONL,
and every entry records token usage (input/output/cache read+write). Subagent
sidechains land in the parent's transcript → counted where they belong.
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

### 5.16 Approval surfaces — rich edit review

Pain point (owner, VS Code extension): edit approvals are a tiny checkbox on an
opened file tab, or a jump back to the session tab. switchboard.ai replaces the
approval UI entirely rather than decorating it.

**Mechanism.** `PreToolUse` hook on `Edit|Write|MultiEdit` fires BEFORE execution
with the full proposed change (file path, old/new content) and can RETURN the
permission decision (allow / deny / ask). Flow: hook fires → switchboard.ai renders
the change → user decides → hook returns decision → CLI proceeds. The TUI prompt
never appears. Hook-timeout fallback: no response in time → "ask" → normal
terminal prompt (nothing ever blocks on switchboard.ai).
*Verification spike needed early:* exact decision semantics vs the TUI's richer
options ("yes, don't ask again"). Fallback plumbing if hooks can't express it:
detect prompt via Notification hook, render our diff, send keystrokes to PTY —
same UX, uglier mechanism.

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

### 5.17 MCP Manager & slash-command surfaces

Slash commands (`/mcp`, `/model`, `/compact`, …) work natively in the Terminal
tab — it's the real CLI. On top, GUI sugar that never forks CLI behavior:

- **MCP Manager pane**: all configured MCP servers with scope (project `.mcp.json`
  / user settings / Session Bus auto-attached), health status, enable/disable,
  add/remove. Implementation: read the real config files; mutate via the real CLI
  (`claude mcp add/remove/list`); a "reconnect" action injects `/mcp` into that
  session's PTY (live reconnect is in-session CLI behavior — we type, not fake).
  Per-session view (what THIS session sees) and global view (all scopes).
- **Session controls strip**: buttons/palette entries for common slash commands
  (`/model` picker, `/compact`, `/clear`, `/mcp`) that inject the real command
  into the PTY. GUI is sugar; the CLI stays the source of truth (PHILOSOPHY P7).
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
  running sessions" injects `/reload-plugins` into affected PTYs.
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
  and required capabilities (`session:read`, `session:exec`, `git:write`,
  `network:fetch`) in a manifest, least-privilege, Tauri/MetaMask-schema style.
  Main process is the sole enforcer.
- **Dogfood internally (VS Code / Nimbalyst EditorHost pattern).** First-party
  features are built against the same internal contract third parties would
  use. If our own adapter can't be expressed in the contract, the contract is
  wrong.

**The core/extension split (decided 2026-07-18):**

*Kernel — never extensions:* session manager + PTY hosting · layout/docking
engine · Session Bus + event stream · approval/permission enforcer (it judges
extensions; cannot be one) · identity kit · attention queue · git service ·
theming/i18n/logging runtimes · the extension host itself.

*First-party extension roster (each proves a different API surface):*
1. **Provider adapters** (Claude Code, Codex, Gemini, Aider) — flagship;
   `provider:register`, deepest surface.
2. **ClaudeMon usage pane** — panel + event subscription + transcript read.
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
  — badges/feed may thin out, PTY hosting keeps working (fail-open applied to
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
- **Data portability**: versioned app-data schema; workspaces, layouts, themes,
  and settings exportable/importable as plain files — back up or move the whole
  setup.
- **Accessibility**: keyboard-complete (S5) + screen-reader labels on status
  surfaces; lamps/status encode SHAPE as well as color (colorblind-safe — never
  hue alone).

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
  - Session detail = read-only Feed view + prompt composer.
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
- **HookListener + Session Bus (Phases 1–2)**: bind to loopback only;
  server-side Host-header allowlist (127.0.0.1/localhost) AND a per-session
  auth token required on every request — Host validation alone does not stop
  plain CSRF; tokens alone do not stop rebinding; both, always. Prefer stdio
  transport for the Session Bus MCP server where the CLI supports it — stdio
  sidesteps the network attack class entirely.
- **Mobile companion WebSocket (Phase 4)**: the near-isomorphic precedent is
  Cline's local Kanban WebSocket (CVE-2026-44211, CVSS 9.7): no origin check,
  no auth token → any webpage the developer visited received a full workspace
  snapshot and could inject commands into the agent's terminal. Mandatory for
  §5.27: server-side Origin allowlist, per-device pairing tokens (QR pairing),
  TLS on LAN, and default-deny — a new connection receives NOTHING until
  paired. Approval-from-phone hardening remains OQ #12; this section is the
  floor, not the ceiling.

## 6. Tech Stack — Decision

**Chosen: Electron + TypeScript + xterm.js + node-pty + Monaco + React.**

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

**Visual mockup v1** (2026-07-18): [mockups/main-window-v1.html](mockups/main-window-v1.html)
— static rendering of the main window (7-session scenario, approval flip, event
feed, urgency lamps, watcher, status bar), annotations keyed to sections of this
doc. Published copy: https://claude.ai/code/artifact/02a6af9e-0d2f-44e8-b6a4-efb1172d437d
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
main process owns all sessions, PTYs, the Session Bus, and GitService. Any session
card can pop out into its own OS-level subwindow (Electron multi-window over shared
main-process state). Popped-out windows remain owned by the orchestrator: drag-and-drop
and context transfer work across OS windows, sidebar still tracks them, and closing a
popped-out window docks the session back — it never kills the session.

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
- Session Bus MCP server + `list/get/send/publish` tools
- @-references in prompt composer
- Drag-and-drop: text + files between sessions
- Context transfer: context chips + summary handoff (Level 2); `get_session_context` bus tool
- Pop-out session subwindows (orchestrator-owned)
- Watcher windows for subagents, undercard tray + attention bubbling (§5.24)
- Tray mode + session archive v1 (§5.25)
- Context transfer Level 3 (fork-session adoption) behind experimental flag
- Attention-driven layout: auto-minimize on submit, attention queue + hotkey, layout
  modes, idle collapse, urgency strip, presentation ladder w/ auto-hide + policy
  setting, pinning contract, focus-stealing policy, delayed urgency reset,
  composed focus mode (§5.8 research-v2 additions)
- Multi-monitor: pop-out to any display, geometry persistence w/ display
  fingerprints, startup + runtime rescue policy, reconnect offer
- Fleet snapshots + repo auto-grouping (§7): save/restore named fleets, layout
  DSL v1, restore confirm gate + focus-state persistence (§5.25)
- Command palette + complete keyboard vocabulary for session lifecycle
  (spawn / focus / archive / review / merge — Claude Squad proves table-stakes)
- Feed view v1: themed rendering, verbosity presets, collapsible tool calls/diffs
- Notifications v2: rules engine, per-session sounds, actionable Allow/Deny toasts,
  phone push, TTS announcements
- Event feed v2: inline actions, filters, severity tiers, full event catalog
- Identity v2: task labels, git context line, autonomy badge, plan-as-progress
  chip (§5.11)
- Status bar: Anthropic service health polling + local corroboration
- Dispatch v1: role templates (Reviewer/Doc Writer/PR Author), manual dispatch,
  clean-room + briefed context policies, round-trip results, lineage nesting
- Approval surfaces v1: PreToolUse interception spike, approval cards w/ Monaco
  diffs, session-flip mode, review queue pane, deny-with-feedback

**Phase 3 — the IDE**
- Worktree create/merge-back flows with review step
- Cross-session same-repo conflict warnings
- ClaudeMon integration: shared parsing/usage library, per-session usage chips,
  plan-usage meter, burn-rate/rate-limit events
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
- MCP Manager pane + session controls strip (§5.17; MCP Manager may pull into
  Phase 3 if daily pain warrants)
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

1. **Prompt composer vs typing directly in the terminal.** The composer enables
   @-references and drag-drop targets, but duplicates the CLI's own input line.
   Proposal: composer is optional per session; it forwards to the PTY stdin. Validate
   this feels right early in Phase 2.
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
8. **ClaudeMon integration shape.** Shared library vs sidecar process vs full merge —
   requires reviewing ClaudeMon's current architecture first. Also decide whether
   ClaudeMon remains a standalone product (it's independently monetizable — see
   project-ideas list #12) with switchboard.ai as a consumer of its engine.
9. **Merge-conflict endgame.** When 7-8 session branches land against the same main:
   auto-rebase queue? conflicts as attention-queue items? punt to terminal? TWO
   adversarially-verified research passes (2026-07-18) found no precedent anywhere
   — including merge-queue/merge-train/stacked-diff tooling as applied to a local
   single-dev fleet. Reclassified: requires an EMPIRICAL SPIKE (run 7-8 real agent
   branches against one main; design from what breaks), not more literature search.
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

## 10. Ideas Backlog (unscheduled, from brainstorm 2026-07-18)

- ~~Auto-checkpoint & rollback~~ — **PROMOTED** to core (§5.28), with turn-anchored
  restore chips and the reversible-rollback requirement.
- **Broadcast prompts**: one prompt → N selected sessions ("update deps everywhere").
- **Prompt queues**: queue multiple prompts per session; execute serially.
- **Pipelines**: on A `done` → generate handoff → inject into B with a prompt
  template. Builds directly on context-transfer plumbing.
- **Scheduled sessions**: cron-spawned sessions (nightly digest agent gets a home).
- **Global transcript search**: full-text/semantic search across all sessions ever.
- ~~Mission-control dashboard~~ — **PROMOTED** to Phase 3 core (research v2:
  Cursor 2.0, GitHub mission control, and Antigravity Manager made fleet
  dashboards the category standard).
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
- **Peek slot** (IntelliJ preview-tab): one reusable transient pane for glancing
  at archived/background sessions without opening N cards.
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
  session's composer/PTY. §5.16 deny-with-feedback already covers the denial
  case; this is the affirmative-guidance sibling.
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
