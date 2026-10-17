# E40 — More than one AI: design record

> **Status:** designed and filed 2026-10-15 as **#1284–#1296** (milestone
> `Phase 3 - The IDE`). Drawn at the owner's request: *"I want to add the ability
> to use another account from another AI company and model."*
>
> **Mockup:** `mockups/multi-ai.html`. Open it in a browser. It has six screens,
> and every item below names the screen it builds.
>
> **Parent:** `docs/plans/06-phase-3-ide.md` → **E40**. Feature sources: DESIGN
> §5.3 (provider adapter interface), §5.5 "Cross-provider handoff", §5.15
> (Dispatch). **This pulls forward DESIGN §8 Phase 4's "Codex / Gemini / Aider
> adapters" and "Generic adapter"** (owner, 2026-10-15). It does NOT pull forward
> the API-key auth mode: the work Codex account is a ChatGPT login.

---

## 1. What the owner decided (2026-10-15)

| Question | Answer |
|---|---|
| Does the window have to look the same for every AI? | Same Session view for every AI. Differences are fine; the terminal is not. |
| What does switching AI mid-conversation do? | **Handoff.** The new AI is briefed with a summary, and a visible divider marks it. Switching back resumes the original conversation. |
| How do you tell which AI a session is on? | The AI's icon **replaces the status dot** on the tab; a ring around it carries the status. The same icon goes on cards and the header. |
| A feature only one AI has? | Grey it out, with a reason, **both ways**. |
| Which account? | Codex on a **work ChatGPT plan**, i.e. a login, not an API key. |
| Local models? | Later, but the architecture must allow them now. |
| Default AI? | A setting; initially Claude. |
| How are AIs added? | **Detect known AIs on every startup.** Plus a **"Something else"** form for any other program, in v1. |
| Settings tab name? | **AIs**. |
| A different AI reviewing work? | **In scope now** (cross-AI dispatch). |
| Usage? | Show whatever the AI reports, in the same spot. |

---

## 2. Where the code stood before E40

The 2026-10-14 sweep, read off the code:

- **The contract is real.** `ProviderAdapter` (`src/main/extensibility/contributions.ts`)
  with optional capabilities (`transcripts`, `hooks`, `titles`, `resume`, `fork`,
  `trust`, `mcp`); a per-card `providerId` is persisted and resolved through
  `start-plan.ts`. E15's exit (a second adapter without editing
  `sessions/ipc.ts`) holds.
- **But only Claude is ever registered** (`bootstrap.ts`), and there is no
  provider picker.
- **The Session view bypasses the seam.** #952 removed the PTY, so the only
  transport is stream-json, and the Feed, state machine, approvals
  (`can_use_tool`), interrupt (`control_request`), model menu, mode and health
  all read Claude's shapes directly. A second provider would hang or show
  nothing.
- **DESIGN §5.3's "generic adapter = PTY only" is dead.** There is no PTY to
  fall back to. The ACP engine (§4) is what replaces it.
- **Claude-only leftovers outside the providers:**
  - pricing in the renderer (an unknown model prices as Sonnet);
  - the status page pinned to Anthropic's;
  - preflight looks for `claude`;
  - AI labels use a Claude one-shot;
  - the MCP Manager and the slash-command scan read `~/.claude`.
- **The fake provider proves hermeticity, not neutrality.** It replays Claude's
  own frames under the id `claude-code`.

---

## 3. The seam (items 03, 04, 05)

The Session view needs two kinds of thing from an AI: **what happened**
(events) and **what you can do to it** (controls). Today both are Claude's wire
format. After E40:

- **Events.** A provider-neutral event stream covers message chunks, thinking,
  tool call start / update / result, plan/todos, turn boundaries, error,
  compaction and usage. Each engine translates its own wire format into it.
  Claude's translator moves inside the Claude provider; nothing downstream
  changes behaviour. *(item 03)*
- **Controls.** Approve/deny, interrupt, list/set model, set mode, and slash
  commands become provider methods. Each provider also **declares which
  controls it has**, and that declaration is what greys a composer button out,
  in both directions. *(item 04)*
- **Surfaces.** Usage, status page, preflight, AI labels and the MCP list come
  from the provider, or show an honest empty state. *(item 05)*

**Claude keeps its native engine.** It is built, it is measured against
2.1.28x, and it carries detail no common protocol does. The seam wraps it; it
does not replace it.

**As built, item 03 (#1286, 2026-10-16).** The event model is
`src/main/sessions/engine-events.ts`; Claude's translator is
`src/main/providers/claude-events.ts`, declared through a new optional
`events` capability (DESIGN §5.3). How the model is meant to take an ACP agent
(item 06) without a second refactor:

| Neutral event | Claude source | ACP source (item 06) |
|---|---|---|
| `activity` | every `assistant` / `stream_event` frame | any `session/update` during a prompt |
| `chunk-open` / `chunk` / `chunk-close` | `content_block_*` text and thinking | `agent_message_chunk` / `agent_thought_chunk` (the translator owns the index) |
| `message-start` / `message-end` | `message_start` / `message_stop` | synthesised by the translator |
| `tool-call-start` | `content_block_start` tool_use | `tool_call` |
| `message` (content in the Feed's block vocabulary) | `assistant` / `user` | `tool_call` input, `tool_call_update` output, `plan` (todos) |
| `turn-end {failed}` | `result` (`is_error` / `error_*`) | the `session/prompt` response (`stopReason`, or an error) |
| `permission-request` | `control_request:can_use_tool` | `session/request_permission` |
| `conversation` / `conversation-reset` | `system:init` / `conversation_reset` | `session/new` / `session/load` id |
| `compaction` | `system:compact_boundary` | none in ACP's spec (item 02 measures Codex) |
| `usage` | **none** since item 05: Claude's usage is its transcript ledger | Codex: the `session/prompt` result's `usage` (measured, item 02 Q6) |

*(The ACP column was a proposal; item 06 made it real, and §4 "As built, item
06" has the table as built. Where they differ: the user's own prompt is a
`message` the provider loops back, `tool-call-start` is not used, and
`usage` comes from the `session/prompt` result.)*

Turn START is not an event: Claude announces none, and an ACP turn begins with
our own `session/prompt`, so the host's existing `prompt-sent` is it. Mode and
command updates are controls-shaped and are item 04's. Left on the raw frame
path for item 04 (#1287): the permission router (and its hold suppressor, which
reads the request), the slash-command, model and mode stores, the control
channel, and every `shared/stream-protocol` importer. The transcript replay
into the Feed still reads Claude's transcript format (a transcript-reader seam,
not this one). `engine-seam.test.ts` names both lists and fails if either drifts.

**As built, item 04 (#1287, 2026-10-16).** The controls are
`src/main/sessions/engine-controls.ts`, declared through a new optional
`controls` capability (DESIGN §5.3); Claude's are
`src/main/providers/claude-controls.ts`. Both lists above are now EMPTY: no
module outside `src/main/providers/` imports a Claude wire module or speaks
`control_request` / `can_use_tool` (one documented exception, the local-only
`check:mcp-attach` harness), and nothing subscribes to raw frames. The
declaration is the shape of a session's `SessionControls` — a member present is
a control it has — and the composer reads it through `sessions:controls`
(`{ai, has}`) to grey a missing control out with "Not available with <AI>."
(screen 3). How an ACP provider (item 06) declares exactly what item 02
measured (`spike/findings/e40-codex-acp.md`):

| Control | Claude | ACP (Codex, measured) |
|---|---|---|
| `approvals.answer(id, decision)` | `control_response` `{behavior, updatedInput \| message}` | `session/request_permission` answered by `optionId`, chosen by kind: allow -> `allow_once`, deny -> `reject_once` (no `reject_always`); `updatedInput` and `message` have no field and are dropped. The request id can be `0` — the event carries it as a string |
| `interrupt` | `control_request:interrupt` | `session/cancel` (notification) |
| `models.list` / `set` | `list_models` / `set_model` | `configOptions` `category:"model"` / `session/set_config_option` (the reply is the truth) |
| `effort.get` / `set` | `get_settings` + `list_models` / `apply_flag_settings`, verified by effect | `configOptions` `thought_level` / `set_config_option` |
| `contextUsage.get` | `get_context_usage` | the last `usage_update {used, size}` |
| `modes` | no live `set` (`--permission-mode` at next start) | `session/set_mode` (live `set`) |
| `slashCommands` | `/name` as prompt text | `/name` as prompt text |
| `mcp` | `mcp_status` / `toggle` / `reconnect` / `authenticate` / `clear_auth` | none: not declared |
| `prompt` (plumbing) | the `user` frame | `session/prompt` |

The announcements went the other way, onto the event model: `permission-request`
(now carrying the ask), `permission-withdrawn`, `commands`
(`available_commands_update`), `model` and `mode` (`current_mode_update`, or the
`set_*` reply, since item 02 saw no update notification follow a set).
**Not done here, on purpose:** the mode chip still means "applies at the next
start" — Claude has no live switch, and `ModeControl.set` has no caller until a
provider that has one ships (item 06). Load does not restore Codex's settings
(item 02, Q5); re-applying model, effort and mode after a resume is item 06's.

**As built, item 05 (#1288, 2026-10-16).** Six optional capabilities are
appended to `ProviderCapabilities`, and Claude's six live in
`providers/claude-surfaces.ts`, which the real adapter and the fake both
declare. With nothing declared, each surface shows an honest empty state:

| Capability | What it answers | With nothing declared |
|---|---|---|
| `usage` | `estimateCostUsd(tokens, model)` → USD or `undefined` | tokens, no dollar figure |
| `statusPage` | `{ base }`, a Statuspage host | "No public status page for <AI>"; nothing fetched |
| `preflight` | `check()` → `{cliPath, version, configPresent, ok}` | "not checked"; no banner |
| `labels` | `run(req)`, the contained one-shot | no AI label (the card's own AI only) |
| `mcpManager` | inventory, health, add, remove, reset approvals | "This AI has no MCP server list…"; writes refused |
| `commandFiles` | `scan(folder)`, the `/` disk scan | builtins only |

How usage fits a second AI without another refactor:
- **One shape.** `shared/usage-report.ts` defines `{usage, model?, estimateUsd?,
  limits?}`. `limits` is `PlanLimitWindow[]`: `id`, `label?`, `usedPercent`,
  `windowMinutes?`, `resetsAt?`. That is Codex's measured
  `account/rateLimits/read`, so item 07 fills it as it is.
- **One path per provider.** A provider with `transcripts` is counted by the
  transcript ledger. One without them sends per-turn `usage` events (tokens,
  model, limits), which `usage/event-usage.ts` adds up and prices through the
  provider. The result goes out on the same `sessions:usage` message.
- **Item 07's job:** fill `usage` from the `session/prompt` result, and `limits`
  from the native call.
- **Gaps item 07 inherits, from item 02 Q6:**
  - a cancelled turn reports `usage: null` and adds nothing;
  - the guardian and title-generator turns are not counted;
  - nothing is persisted, so a relaunch counts from zero.

What stayed Claude's, on purpose:
- the Manager's live-session verbs (`mcp_status`, toggle, reconnect, auth),
  which are item 04's `controls.mcp`. An AI without them answers
  `unsupported`, and the Manager says so in its own words;
- the `health.state.*` strings, which still name Anthropic.

---

## 4. One general engine: the Agent Client Protocol (items 02, 06, 07, 08)

**The finding that shaped this epic:** most coding AIs now speak one protocol to
host applications. The **Agent Client Protocol (ACP)** is JSON-RPC 2.0 over
stdio. Its public registry
(`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, snapshot of
2026-10-15 kept at `.claude/work_files/acp-registry-2026-10-15.json`) lists about
40 agents:

- **Codex:** `@agentclientprotocol/codex-acp`, an adapter co-authored by OpenAI.
- **Gemini CLI:** `--acp`, native.
- **GitHub Copilot:** `--acp`, native.
- **Others:** Cursor, OpenCode (`opencode acp`), goose (`goose acp`), Qwen Code,
  Mistral Vibe, and more.
- **Claude:** has an entry too, which we do not need.

So E40 builds **one** ACP engine rather than one engine per vendor:

- **Codex is its first user.**
- **"Something else"** is any command that speaks ACP.
- **Local models come along:** OpenCode and goose run Ollama models, which is
  why "later" costs nothing extra.

The protocol surface, from the spec:

- **Client → agent:** `initialize`, `authenticate`, `session/new`,
  `session/prompt`, `session/cancel`; optional `session/load` and
  `session/set_mode`.
- **Agent → client:** `session/update` (message / thought chunks, tool calls,
  plans, commands, mode changes), `session/request_permission`; optional `fs/*`
  and `terminal/*`.
- **`session/new` takes `mcpServers`.** That is how the Session Bus attaches
  (item 13).

**Two decisions, stated:**

1. **v1 offers no client `fs/*` or `terminal/*` capabilities.** The agent uses
   its own file and shell access, which is the host-don't-reimplement posture
   (PHILOSOPHY P7). Offering them later is how a Changes-tab review of an
   AI's edits *before* they land could work. That is a separate decision.
2. **Codex goes over ACP unless the probe says otherwise.** ACP's spec does
   **not** mention usage or plan-limit reporting, and the owner wants Codex's
   usage shown. Codex also has its own first-party protocol, `codex app-server`,
   which carries approvals, threads and token usage. **Item 02 measures both**,
   and native Codex is built only for what ACP cannot carry. The fallback is
   cheap because both engines sit behind the same seam.

**What is measured versus assumed:** everything in this section came from the
ACP site, the registry JSON and OpenAI's app-server docs. Nothing has been run
against a real Codex yet; item 02 exists for that.

**As built, item 06 (#1289, 2026-10-16).** The engine is
`src/main/providers/acp/`: `acp-protocol.ts` (JSON-RPC frames and readers),
`acp-session.ts` (one session: handshake, correlation, controls, lifecycle),
`acp-events.ts` (`session/update` -> neutral events) and `acp-provider.ts`
(`createAcpProvider({id, displayName, command, args?, env?, modeMap?,
authMethodId?, version?, clientVersion?})`, which #1290 and #1291 register
instances of). It is NOT a transport: `StreamService` already spawns through
`launchSpec` (`cmd.exe /c <absolute .cmd>`, the shape item 02 measured working),
frames NDJSON, skips a line that is not JSON, and reports a dead child to the
manager, which ends the session as it ends a dead Claude CLI. The engine is a
translator and a set of controls over it. Two optional seam members made that
possible, both unused by Claude: `createTranslator(hooks, {id})` pairs one
session's translator with its controls, and `ControlSession.loopback(frame)`
lets a provider put a frame of its own making through the pump (ACP does not
echo the user's prompt, and a cancel must withdraw held permission requests).
A looped-back frame is recognised by identity, so an agent cannot forge one.

The handshake: `initialize` (no `fs`, `terminal: false`) -> `session/load` when
resuming and the agent says `loadSession`, else `session/new`, both with `cwd`
and the Session Bus in `mcpServers` -> on -32000, `authenticate` with the
provider's `authMethodId` once, then `session/new` again (no method named: the
error is shown; `authenticate` is unmeasured) -> a failed load falls back to
`session/new` -> model, effort and mode are re-applied (load resets them,
item 02 Q5) -> ready. Prompts sent earlier queue; one prompt is in flight at a
time. Model and effort are remembered per conversation **in memory**, so an app
restart loses them and the agent's defaults stand; the mode comes from the
card's autonomy through `modeMap`.

The real mapping (it replaces the item 03 proposal above where they differ):

| ACP | Neutral event |
|---|---|
| `agent_message_chunk` / `agent_thought_chunk` | `message-start`, `chunk-open`, `chunk`… One SEGMENT per run of one kind (and one `messageId`). ACP sends no authoritative message, so the segment's close sends `chunk-close`, `message-end` and a `message` carrying the whole text, which claims the streamed block |
| `user_message_chunk` (load replay only) | `message {role:user}` |
| our own `session/prompt` | `message {role:user}`, by loopback |
| `tool_call` | `message-start` + `message` carrying a tool block (`toolCallId` = `toolUseId`; `kind` -> category: execute=shell, edit/delete/move=edit, read/search/fetch=read). Terminal content is ignored |
| `tool_call_update` at `completed` / `failed` | `message` carrying the result: content text, a line per diff, `Exit code N` from `_meta.terminal_exit`, else `rawOutput`; `failed` from the status. Earlier updates draw nothing |
| `plan` | a todos block |
| `available_commands_update` | `commands` |
| `current_mode_update`, `config_option_update`, a `set_*` reply, `session/new` / `load` | `mode` (through `modeMap`; an unmapped mode sends nothing) and `model` |
| `usage_update` | no event: the context meter's answer |
| `session_info_update` | understood, silent; Codex's `waitingOnApproval` is NOT used |
| `session/new` / `session/load` result | `conversation {id}` |
| `session/prompt` result | `turn-end {failed:false, label:"acp:<stopReason>"}` + `usage`; held permissions are withdrawn. `cancelled` is not a failure |
| a `session/prompt` error | a visible "<AI> reported an error: …" block + `turn-end {failed:true}` |
| `session/request_permission` | `permission-request {requestId: String(id), tool: title, input: rawInput}` |
| `activity` | every `session/update` that produced events while a prompt is in flight; never during a load replay |

Permissions are answered by KIND with the option's `optionId`: allow ->
`allow_once` (never `allow_always`; no `allow_once` offered fails the answer);
deny -> `reject_once`, else `reject_always`, else the `cancelled` outcome. Stop
sends `session/cancel` and answers every held request `cancelled`.

**Fail-open, as built.** A frame that is not JSON-RPC, an unknown update
variant, an unknown notification (`_auth/status_update` included) and an
unknown agent request are each reported ONCE per type per session (the
translator's `onUnknown`, logged at info) and skipped; an unknown request is
answered -32601 (`fs/*` and `terminal/*` too). A session that cannot be opened
says why on screen, settles any queued turn as failed and refuses further
prompts. No promise the controls hand out rejects; a control waits up to 20 s
for the session to open and 30 s for a reply.

**Declared controls** (`controlsOf`): `approvals`, `interrupt`, `models`,
`effort`, `contextUsage`, `modes`, `slashCommands`. **No `mcp`.** `modes.set` is
live only when the provider gives a `modeMap`; `sessions:setAutonomy` now also
calls it on the card's live session (a no-op for Claude). Attachments: images
when the agent says `promptCapabilities.image`, text files as text blocks; a PDF
(or an image the agent cannot take) refuses the prompt rather than dropping it.

**The fake** (`fake-acp-agent.ts`, run as `out/main/fake-acp-cli.js`; provider
`fake-acp`, "Fake ACP"; registered first when `SWITCHBOARD_FAKE_PROVIDER=acp`):
frames shaped on the Codex captures, `configOptions` for model, effort and mode,
`session/load` replaying history from `<home>/.fake-acp/`, and the directives
`!think`, `!tool`, `!edit`, `!ask`, `!cancel-slow`, `!error`, `!unknown`, `!plan`,
`!mode`, `!state`, `!mcp`, `!fs`. `FAKE_ACP_REQUIRE_AUTH=1` requires
`authenticate`.

**As built, item 08 (#1291, 2026-10-16).** The model of "which AIs exist" is
`src/main/ai-catalog/`, and the renderer reads it through `ais:*`. There is no
screen yet: #1292 builds the AIs tab on it and #1293 the session icons.

*The catalog* ships inside the app (`catalog.json`). It holds 15 entries:
- **Claude Code**, on the native engine (`providerId: claude-code`).
- **14 ACP registry entries we vouch for**, copied from the 2026-10-15
  snapshot:
  - Codex (`codex-acp`, `npx -y @agentclientprotocol/codex-acp@2.2.2`,
    `providerId: codex` for #1290);
  - Gemini CLI, GitHub Copilot, Qwen Code, Cline, Auggie and Factory Droid
    (`npx -y <package> <args>`);
  - Cursor (`cursor-agent acp`), OpenCode (`opencode acp`), goose (`goose acp`),
    Mistral Vibe (`vibe-acp`), Kimi CLI (`kimi acp`) and Junie
    (`junie --acp=true`), which are binary distributions;
  - Kilo, which has both kinds and launches through npx.

The registry's own Claude entry is skipped.

Each entry carries the following. The registry provides the name, maker
(`authors[0]`), description, license, website and launch. We add:
- how to install it: a command to copy, or the maker's page;
- which program on PATH means "installed";
- `runsLocalModels`, which is true for OpenCode and goose only;
- its icon.

The icons were downloaded ONCE from each registry `icon` URL (the registry is
Apache-2.0; each mark is its maker's). They live in
`src/renderer/public/ai-icons/`, so the renderer draws them from its own
origin. The CSP allows no `data:` and no remote image. `registry-snapshot.json`
is all 42 registry agents, trimmed. "Check for new AIs" (`ais:checkRegistry`,
on a press ONLY) fetches the live registry, diffs it against that snapshot
(added / new version / removed), and caches only the diff in userData.

*Detection* uses one new optional capability, `detect` (DESIGN §5.3):
- `detect(signal)` answers `{installed: true|false|'unknown', version?,
  login: 'logged-in'|'logged-out'|'unknown', account?, plan?, detail?}`. The
  runner adds `probedAt` and `ms`.
- **When it runs:** after the FIRST main window's `ready-to-show` → `show()`,
  one turn later, so startup paint is unchanged by construction. "Look again"
  runs it again. Every AI is probed concurrently, each under a hard 5 s
  timeout.
- **What happens when a probe is slow or broken:** at the deadline the probe's
  signal is aborted, so it can kill its children, and the answer is `unknown`
  with the reason. A throw is `unknown` too. A run already in flight is shared.
- **What gets reported:** one `ais:changed` push, and the total time logged at
  info as `AI detection finished`.

How each AI is probed:
- **Claude** asks the CLI itself. `--version` gives the version. `auth status
  --json`, measured on 2.1.288, gives `{loggedIn, email, subscriptionType}`,
  and it exits 1 when logged out. No credential file is read.
- **An ACP provider** gets the engine's default: a PATH scan for its command.
  The version and login stay `unknown`, because asking would mean starting the
  agent, and for an npx agent that is a download.
- **The fake ACP agent** answers installed, version `0.0.0`, and logged out
  exactly when `FAKE_ACP_REQUIRE_AUTH=1`.
- **A catalog AI with no provider** gets a PATH scan for its command, which
  starts nothing. All of a run's scans share ONE asynchronous read of the PATH
  directories (`transport/find-on-path.ts` `pathIndex`). Fifteen synchronous
  `findOnPath` calls measured 133 ms of main-thread stats on the desktop, right
  after first paint. In e2e that stall broke Playwright's main-process
  `evaluate` (`file-menu.spec.ts`, 2 runs in 3) until it was made async.
- **App quit** aborts a run in flight, and its probes kill what they started.
- **Codex** gets its own probe from #1290.

*Custom AIs* ("Something else") are stored in `userData/ais.json`, alongside
the default:
- **Shape:** `{id: 'custom:<slug>', name, command, args, env?, addedAt}`. The
  slug comes from the name, with `-2`, `-3`, … on a collision.
- **Saving:** atomic. A corrupt file is set aside as `ais.json.bad` and the app
  starts with none.
- **Registration:** at startup, and the moment one is added
  (`bootstrap.ts` `registerCustomAi`, a `createAcpProvider` whose command is
  resolved on PATH at each spawn). Removing one unregisters it, and clears the
  default if the default was that AI.
- **What is refused, and why:**
  - Anything containing `( ) % ! ^ " < > &` or `|`, or any control character,
    in the command, the arguments, or the resolved path. The stream transport's
    `launchSpec` is for argv the app writes, not argv a person typed.
  - An argument with whitespace in it. libuv quotes it, and `cmd /c` then drops
    the outer quotes round a quoted `C:\Program Files\…\x.cmd`.
  - A relative command path. It would resolve inside the user's project.
- **A command that is not found** fails that session's spawn with a reason. It
  is never launched by its bare name from the project folder (S-01).
- **Test** (`providers/acp/acp-probe.ts`) spawns the command and sends
  `initialize`. It answers `{ok, agentName?, agentVersion?, protocolVersion?,
  authMethods?, error?, ms}`, then tree-kills the child and resolves only once
  the kill is done. It does NOT open a session, so it cannot report models. The
  mockup's "3 models found" would need a `session/new`, which is a real
  conversation at the agent.

*The default AI* is the user's choice when that AI is registered. Otherwise it
is the first registered provider, which is Claude in production. "Never chosen"
is stored as nothing, not as `claude-code`, so the e2e fakes' registration
order still decides. A choice that is not registered falls back, is logged once
per distinct choice, and the state says `fellBack: true`. `index.ts`'s
`defaultProviderId` reads it.

*Log in* (`ais:login`) runs the AI's OWN sign-in:
- **ACP AIs** get a standalone `initialize` + `authenticate`. The method is the
  one asked for, else the provider's `authMethodId`, else the only one offered.
  When several are offered and none is named, the answer is `{methods}` so the
  UI can ask.
- **Claude** answers `{supported: false}`, because `claude auth login` belongs
  in a terminal.

We never see a password and store nothing.

*The IPC surface:*
- `ais:list` returns `[{kind: catalog|custom|provider, entry, providerId?,
  registered, detection?}]`.
- `ais:default` and `ais:setDefault(id)`.
- `ais:lookAgain`.
- `ais:checkRegistry` and `ais:lastRegistryCheck`.
- `ais:customAdd`, `ais:customRemove` and `ais:customTest`.
- `ais:login(providerId, methodId?)`.
- The push `ais:changed`, which carries `{items, default, detecting}`.

The preload exposes all of these as `switchboard.ais`.

---

## 5. The screens (`mockups/multi-ai.html`)

1. **Switchboard with two AIs** *(item 10)*:
   - the AI icon on every card, tab and header;
   - on tabs, the icon replaces the dot and a ring keeps the status;
   - the status bar shows each AI's version and health.

   **As built, item 10 (#1293, 2026-10-16).** One shared component,
   `components/AiBadge.tsx`, draws all of it.

   - **The badge.** It is the AI's icon (`AiIcon.tsx`) in a 16px ring. The
     icon is looked up by provider id → `ais.list()` → the catalog `icon`, and
     `lib/ais-store.ts` caches it, listening to `ais:changed`.
     - An AI with no icon, or an icon that fails to load, gets a neutral tile
       with its initial. The letter is drawn by CSS from `data-initial`, so a
       tab's `textContent` stays the session's name.
     - The badge is `role="img"`, named "<AI>, <status>". The exception is
       the tab, where it is decoration (`decorative`): dockview's
       `role="tab"` takes its name from its content, and that name stays the
       session's.
   - **Where it replaced the old mark.**
     - On the rail row and the strip pill it replaced `StatusMark`, which was
       the status glyph or spinner.
     - On the tab it replaced `IdentityChip`'s accent dot. The new `mark` prop
       is what makes the swap.
     - It is new at the start of all three card-header arms.
     - The strip's group entry keeps `StatusMark`, because a group has no
       single AI.
   - **The ring.** Its colour is `attentionPaint(status, needsYou).token`,
     the same rule the old mark used.
     - It is painted in `--status-<token>-ink`, not the raw hue, which
       measures about 2:1 on light surfaces.
     - `tokens.drift.test.ts` holds every ink at 3:1 against `--rail-card`,
       `--panel` and `--panel2` in all four themes, and checks that the
       component paints the ink.
     - It spins (`.status-ring`, so #718's six looks still apply) only on
       the row and the pill, where the old mark spun. On the tab and the
       header it stands still: no new animation.
     - Look 3's "bigger spinner" grows the ring from 16px to 20px; the old
       mark went from 12px to 17px. `working-look.spec.ts` asserts 20px.
   - **The wire.** `SessionCardWire` gained `providerId` (the live
     session's, else the card's).
   - **The status bar.** `status-cli-version` became `status-ais`.
     - It shows Claude first, when it is detected as installed or preflight
       read a version. Then come the others with `installed === true`.
     - The health dot follows the default AI, because main polls only that
       AI's page (#1288). When that AI is not listed, the dot falls back to
       its own slot.
     - It never wraps, clips with an ellipsis, and its `title` lists every AI.
     - With no list, it shows the old `claude <version>` line.
   - **Testing.** The fake stream gained a hermetic `detect` (installed,
     `0.0.0`), so the bar does not read the developer's PATH under test.
   - **Not done.** A tab no longer shows the session's accent as a dot. The
     colour is still the open tab's wash and the lang badge's field: that is
     the owner's §1 answer applied to the only dot the tab had.
2. **The switch menu** *(item 11)*:
   - the chip sits before the model chip;
   - each AI shows its login state and account;
   - one that is missing is dimmed, with "set it up…";
   - one sentence says what switching does.
3. **After a switch** *(items 04, 12)*:
   - the divider reads "Claude Code → Codex · time · handed a summary of N
     turns", with **see what it was told**;
   - controls one AI lacks grey out, with a reason.
4. **Settings → AIs** *(item 09)*:
   - the default AI;
   - found / not found, with login state;
   - **Log in** runs the AI's own browser sign-in;
   - **+ Add an AI** and **Look again**.
5. **Add an AI** *(item 09)*:
   - the catalog, with a "Runs local models" filter;
   - "Something else": name / command / arguments, then Test.
6. **Cross-AI review** *(item 13)*: **Run it on** in the dispatch dialog.

**Placeholders in the mockup, not facts:** model names, version numbers, plan
names and the email address. The icons are stand-ins; the registry ships each
AI's real SVG.

---

## 6. Rules that fall out of the decisions

- **One card, one native conversation per AI.** A card keeps each AI's own
  conversation (extending `nativeSessionId` + lineage). Switching back resumes;
  only a first switch starts fresh, and it is briefed. Fork (§5.3, Level 3)
  stays same-provider only: no fake declares it, and neither will an ACP
  provider until measured.
- **The briefing is §5.5 Level 2, mechanical.** It is deterministic and runs no
  model, so it works in the "my window drained" case. The UI calls it a
  *briefed continuation*, never a resume (§5.5 honesty rule). The instruction-file
  mismatch (`CLAUDE.md` vs `AGENTS.md`) is stated in the briefing.
- **Detection never blocks startup.** It runs after first paint, and a slow
  probe answers "unknown".
- **Local-first.** The catalog ships inside the app. The registry is fetched
  only when the user presses "Check for new AIs".
- **Login is always the AI's own.** We run its sign-in and read its state; we
  never see a password, and the app stores no OpenAI credential.
- **Fail-open.** An ACP agent that sends something we do not understand gets it
  logged and skipped; a broken provider never takes down a Claude session.

---

## 7. Work breakdown and order

| # | Issue | Item | Size | Depends |
|---|---|---|---|---|
| 01 | #1284 | `[user]` Install Codex, log in with the work account | S | — |
| 02 | #1285 | Probe: Codex over ACP; the ACP-vs-native verdict | M | 01 |
| 03 | #1286 | Seam 1: neutral events; Claude translated behind the adapter | M | — |
| 04 | #1287 | Seam 2: controls through the adapter, declared (the grey-out) | M | 03 |
| 05 | #1288 | Per-AI surfaces: usage, status page, preflight, labels, MCP | M | 03 |
| 06 | #1289 | The general ACP engine + a hermetic fake ACP agent | M | 03, 04 |
| 07 | #1290 | Codex provider + `check:codex` | M | 02, 06 |
| 08 | #1291 | AI catalog, startup detection, custom AIs, default AI | M | 06 |
| 09 | #1292 | Settings → AIs tab + Add an AI | M | 08 |
| 10 | #1293 | Which AI a session is on, at a glance | S | 08 |
| 11 | #1294 | The AI switch; switching back resumes | M | 04, 07, 10 |
| 12 | #1295 | Handoff: briefing, divider, "what it was told" | M | 11 |
| 13 | #1296 | Cross-AI dispatch | M | 07 |

**Order:**

1. **Start now, without Codex:**
   - **03 → 04 → 06** is the critical path;
   - **05** runs beside 04;
   - **08 → 09/10** follow 06.

   None of these needs a real Codex: the fake ACP agent stands in.
2. **01 → 02** as soon as the owner has installed Codex. 02 can land while the
   seam is in flight.
3. **07** when both 02 and 06 are in.
4. **11 → 12** and **13** last. They are the owner-visible payoff, and need a
   real second AI.

**Epic exit:**

- The owner runs a real Codex session in the same Session view as Claude, and
  answers a Codex approval in-app.
- He switches a card Claude → Codex → Claude, with the Codex half briefed and
  the Claude half resumed.
- He dispatches a Codex review of a Claude session and gets the findings back.
- A second ACP agent (Gemini CLI, or a local model through OpenCode) is added
  through "Something else" **with no code change**.
- Every user-facing item is hand-tested and recorded in
  `docs/plans/dogfood-testing.md` (Phase 3 exit criterion 10).

**Deliberately not here:**

- API-key auth mode (still Phase 4);
- client-side `fs/*` / `terminal/*` (§4 decision 1);
- Aider (no ACP entry);
- a bundled local-model setup (the catalog points at OpenCode / goose; running
  Ollama is the user's).
