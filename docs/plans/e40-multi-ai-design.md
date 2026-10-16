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

---

## 5. The screens (`mockups/multi-ai.html`)

1. **Switchboard with two AIs** *(item 10)*:
   - the AI icon on every card, tab and header;
   - on tabs, the icon replaces the dot and a ring keeps the status;
   - the status bar shows each AI's version and health.
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
