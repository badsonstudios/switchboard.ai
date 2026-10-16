# E40-02 (#1285) — Codex over ACP, measured, and the ACP-vs-native verdict

**Probes:** `spike/probes/1285/` (README there says how to run each)
**Captures:** `spike/probes/1285/captures/*.jsonl` — every frame quoted below is in one of them
**Date:** 2026-10-16 · Windows 11 Pro 10.0.26300, Node 22.20.0
**Spec:** `docs/plans/e40-multi-ai-design.md` §3, §4, §6

## Versions

| Thing | Version | Where it was read |
|---|---|---|
| ACP adapter | **`@agentclientprotocol/codex-acp@2.2.2`** (pinned; `npm view` latest = `2.2.2`, preview `2.2.3-preview.13`) | `initialize` → `agentInfo.version: "2.2.2"`; `--version` → `@agentclientprotocol/codex-acp 2.2.2` |
| Codex the adapter runs | **`0.160.1`, bundled** (adapter dependency `@openai/codex ^0.160.1`) | the stub MCP server's `initialize`: `"clientInfo":{"name":"codex-mcp-client","title":"Codex","version":"0.160.1"}` (`b-mcp-stub.jsonl`) |
| Codex on PATH | **`codex-cli 0.163.0`** | `codex --version`; app-server `userAgent: "switchboard-probe-1285/0.163.0 (...)"` (`d-app-server.jsonl`) |
| ACP protocol | `protocolVersion: 1` | `initialize` response |
| Account | ChatGPT **Team** plan, the owner's work account | `_auth/status_update` (email redacted) |

**The adapter is itself an app-server client.** Its README: *"codex-acp is a
stdio ACP agent server. It starts the Codex App Server, translates ACP requests
into Codex operations, and maps Codex events back into the client."* The
adapter's source (`dist/index.js`) sends `initialize`, `thread/start`,
`turn/start`, `account/read` and `account/rateLimits/read` to that app-server.
So "ACP vs app-server" is really "the adapter's translation vs talking to the
same app-server directly". By default the adapter runs **its own bundled Codex
(0.160.1), not the user's (0.163.0)**; `CODEX_PATH` overrides that (README;
NOT MEASURED). Both share `~/.codex`, so the user's login is shared (measured:
the adapter saw the PATH-codex login).

**Redaction:** applied at write time by `lib.mjs` `redactValue` — email
addresses, JWT-shaped strings, and the value of any key naming a token, cookie,
secret, API key, password, account id or user id (e.g.
`workspaceRouting.chatgptAccountId`, `accountId`). Nothing else was altered.
A grep of every capture for `@`-addresses, `eyJ`, the account UUID and the user
id returns 0.

**Spend:** 9 model turns sent (8 over ACP, 1 over app-server), plus `/status`
(adapter-local, no model). All on `gpt-6-luna` at `low` effort. Reported
tokens: 190,837 over ACP (of which 152,192 cached input) + 16,230 over
app-server. **Not in those numbers** (see Q6): one hidden "Guardian review"
subagent turn (7,262 tokens, read from its rollout) and the adapter's hidden
title-generation turn (unmeasured). After the run the 5-hour limit read 3 %
used, weekly 0 %.

**Processes:** `tasklist | grep -i codex` was empty before the first probe and
after every probe; during probe A's session there was exactly one `codex.exe`
(73 MB) under the npx/node tree, and it exits on stdin EOF within the 4 s grace (every
probe logged `exited on stdin EOF`; the tree kill was never needed).
**Sessions:** `~/.codex/sessions` held 0 files before; 3 after (the probe
session, its guardian subagent, the app-server thread); all 3 removed with
`codex delete --force <uuid>`, back to 0.

---

## Q1. Spawn on Windows, `initialize`, auth logged in vs out — MEASURED

**Spawn.** Three shapes, `--version` only (`a-spawn-shapes.jsonl`):

| Shape | Result |
|---|---|
| `win-cmd.ts` `execSpec`, absolute `C:\Program Files\nodejs\npx.cmd` | **fails**: `'"C:\Program' is not recognized as an internal or external command` |
| `execSpec`, bare `npx.cmd` (cmd.exe PATH lookup) | **fails**: `Cannot find module 'C:\...\sandbox\node_modules\npm\bin\npx-cli.js'` — the shim's `%~dp0` resolves to the cwd |
| `stream-service.ts` `launchSpec`: `cmd.exe /c "C:\Program Files\nodejs\npx.cmd" -y @agentclientprotocol/codex-acp@2.2.2` | **works**: `@agentclientprotocol/codex-acp 2.2.2`, exit 0 |

All ACP probes used the third shape. The first failure is not specific to npx:
`execSpec` caret-escapes the quotes around the **command token itself**, so
cmd.exe never sees them as quotes and splits any `.cmd` path containing a space
(out of scope; see the end).

**stdout hygiene:** across 5 adapter runs and 1 app-server run, **0 non-JSON
stdout lines and 0 stderr bytes**. The first stdout bytes are the `initialize`
response, `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,...`, about
1.1–2.1 s after spawn (`first-stdout` notes). npx was already cached; a
cold-cache first run was not timed.

**`initialize`** — the response is identical logged in and logged out
(`a-init-in.jsonl`, `a-init-out.jsonl`):

```json
{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","title":"Codex","version":"2.2.2"},
 "agentCapabilities":{"auth":{"logout":{}},"providers":{},"loadSession":true,
   "promptCapabilities":{"embeddedContext":true,"image":true},
   "sessionCapabilities":{"resume":{},"list":{},"close":{},"delete":{},"fork":{},"additionalDirectories":{},"subagents":{}},
   "mcpCapabilities":{"acp":false,"http":true,"sse":false},"_meta":{"authStatus":{}}},
 "authMethods":[{"id":"api-key","name":"API Key","description":"Use an API key to authenticate","_meta":{"api-key":{"provider":"openai"}}},
                {"id":"chat-gpt","name":"ChatGPT","description":"Use ChatGPT to authenticate"}],
 "_meta":{"steering":{"supported":true}}}
```

**The auth answer is a separate, non-spec notification** that follows:

- logged in: `{"method":"_auth/status_update","params":{"authStatus":{"kind":"account","label":"ChatGPT Team","account":{"email":"<redacted-email>","plan":"team"}}}}`
- logged out (`CODEX_HOME` = empty temp dir): `{"method":"_auth/status_update","params":{"authStatus":{"kind":"none","label":"Not logged in"}}}`

and logged out, `session/new` fails: `{"id":2,"error":{"code":-32000,"message":"Authentication required"}}`
— **before** the status notification arrives (t=1118 ms vs 1445 ms). So the
reliable logged-out signal is the `-32000` on `session/new`; the notification
is a nicety that can be late. Logged-out was measured without touching the
real login: `CODEX_HOME` is honoured, and the adapter populated the empty dir
with its sqlite stores (`state_5.sqlite`, `logs_2.sqlite`, …) which the probe
deleted. The `authenticate` call itself (browser sign-in) was NOT MEASURED — it
would open the owner's browser.

## Q2. `session/new` + `mcpServers`, `session/prompt`, update variants, `session/cancel` — MEASURED

**The Session Bus attaches this way.** `session/new` carried

```json
{"cwd":"...\\sandbox","mcpServers":[{"name":"probe-stub","command":"C:\\Program Files\\nodejs\\node.exe",
  "args":["...\\mcp-stub.mjs"],"env":[{"name":"STUB_LOG","value":"..."},{"name":"PROBE_STUB_MARK","value":"1285"}]}]}
```

and the stub's own log (`b-mcp-stub.jsonl`) shows Codex launched it with the
env (`"probeEnv":"1285"`), cwd = the session cwd, sent `initialize`
(`protocolVersion "2025-06-18"`), `notifications/initialized`, `tools/list`,
and on T3 `tools/call` with `_meta["x-codex-turn-metadata"]` (session, turn,
model, sandbox). The model saw and used the tool: reply `stub-echo:hi`. On the
ACP side the call is an ordinary tool call:

```json
{"sessionUpdate":"tool_call","toolCallId":"exec-9c7e…","kind":"execute","title":"mcp.probe-stub.probe_echo","status":"in_progress",
 "rawInput":{"server":"probe-stub","tool":"probe_echo","arguments":{"text":"hi"}},"_meta":{"is_mcp_tool_call":true}}
{"sessionUpdate":"tool_call_update","toolCallId":"exec-9c7e…","status":"completed",
 "rawOutput":{"result":{"content":[{"type":"text","text":"stub-echo:hi"}],"structuredContent":null,"_meta":null},"error":null}}
```

`session/new` returns `sessionId`, `models`, `modes`, `configOptions` (Q4). A
session that never gets a prompt is **not persisted**: probe A's bare
`session/new` did not appear in probe B's `session/list` (count 0).

**`session/prompt`** response (T1):

```json
{"stopReason":"end_turn","usage":{"totalTokens":19269,"inputTokens":11962,"cachedReadTokens":7296,"cachedWriteTokens":0,"outputTokens":11,"thoughtTokens":0},
 "_meta":{"quota":{"token_count":{...same counts, Codex spelling...},"model_usage":[{"model":"gpt-6-luna","token_count":{...}}]}}}
```

**Every `session/update` variant actually emitted** (counts over all captures):

| Variant | Seen | Shape notes |
|---|---|---|
| `agent_message_chunk` | 106 | `{messageId, content:{type:"text",text}}` |
| `user_message_chunk` | 6 | only in the `session/load` replay |
| `tool_call` | 6 | `kind` `execute` (shell AND MCP), `think` (guardian); shell content is `{"type":"terminal","terminalId":…}` even though we declared `terminal:false` |
| `tool_call_update` | 5 | `status` `completed`/`failed`; shell result only `_meta.terminal_exit.exit_code` — **no command output** reached us |
| `usage_update` | 10 | `{used, size}` = context-window tokens (`19269 / 258400`) |
| `session_info_update` | 23 | either `title` (auto-generated, see Q6) or `_meta.codex.threadStatus` = `{type:"active",activeFlags:["waitingOnApproval"]}` / `{type:"active",activeFlags:[]}` / `{type:"idle"}` |
| `available_commands_update` | 6 | `plan mcp skills status review review-branch review-commit compact goal rename logout` + the user's `$skill` entries |

In the adapter source but **not emitted** in these turns: `agent_thought_chunk`
(luna/low reported `thoughtTokens: 0`), `plan`, `plan_update`,
`current_mode_update`, `config_option_update`, `compaction_update`, `notice`,
`subagent_*`, `async_task_*`. NOT MEASURED; the neutral model must fail-open on
them.

**`session/cancel`** (T6): sent as a notification on the first
`agent_message_chunk`; the prompt answered
`{"stopReason":"cancelled","usage":null,"_meta":{"quota":{"token_count":null,"model_usage":[]}}}`
2.6 s after it started, after one chunk (`"AG"`).

## Q3. `session/request_permission` — MEASURED (allow and reject)

Default mode (`agent`, "Auto review") never asked: T3's MCP call was approved
by a hidden **Guardian review** subagent (`tool_call` kind `think`, title
`Guardian Review`, `rawOutput.review = {status:"approved",riskLevel:"low",…,"decisionSource":"agent"}`).
In `read-only` mode, T4 ("create probe.txt") also did not ask — the model just
declined (`I can't create probe.txt because this session's filesystem is read-only.`).
T5 and T8 asked. The payload (T5, `b-session.jsonl`):

```json
{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"01a1458a-…",
 "toolCall":{"toolCallId":"exec-c350…","title":"Run command",
   "rawInput":{"command":"\"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"Set-Content -LiteralPath 'probe.txt' -Value 'hello' -NoNewline\"","cwd":"…\\sandbox"},
   "kind":"execute","status":"pending"},
 "options":[{"optionId":"allow_once","name":"Yes, proceed","kind":"allow_once"},
            {"optionId":"accept_execpolicy_amendment","name":"Yes, and don't ask again for commands that start with `Set-Content -LiteralPath probe.txt -Value hello -NoNewline`","kind":"allow_always"},
            {"optionId":"cancel","name":"No, and tell Codex what to do differently","kind":"reject_once"}]}}
```

- **Option kinds:** `allow_once`, `allow_always`, `reject_once`. **No
  `reject_always`.** `optionId`s are not the kinds (`accept_execpolicy_amendment`,
  `cancel`) — answer with the `optionId`, choose by `kind`.
- **The request id is `0`.** A client that tests `if (msg.id)` drops it.
- **Allow** (`allow_once`): the command ran, `probe.txt` = `hello`, then
  `tool_call_update {status:"completed", _meta.terminal_exit.exit_code:0}`, turn `end_turn`.
- **Reject** (`reject_once`, T8): **the whole turn ends** —
  `tool_call_update {status:"failed", _meta.terminal_exit.exit_code:null}`, then the prompt
  answers `{"stopReason":"cancelled","usage":null}`, no agent text, `probe2.txt` not created.
  "Tell Codex what to do differently" is the user's next prompt, not part of the answer.

## Q4. Models and modes — MEASURED

`session/new` (and `session/load`, `session/resume`) return both spellings:

- `models` (ACP unstable): `currentModelId: "gpt-6.1-sol[medium]"` and 41
  `availableModels`, one per model × effort, ids `"<model>[<effort>]"`.
- `configOptions`, `type:"select"`, each with a `category`: `mode` (4),
  `collaboration_mode` (`default`/`plan`), `model` (7: `gpt-6.1-sol`,
  `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`), `thought_level` (`reasoning_effort`: low…max, plus `ultra`
  for some), `model_config` (`fast-mode`: off/on, "1.5x speed, increased usage").
- `modes`: `read-only`, `workspace-write`, `agent` ("Auto review", **default**),
  `agent-full-access`.

**Switching:** `session/set_config_option {configId:"model",value:"gpt-6-luna"}`
and `{configId:"reasoning_effort",value:"low"}` each return the full updated
`configOptions` (`currentValue` changed); `session/set_model
{modelId:"gpt-6-luna[low]"}` returns `{}`; `session/set_mode
{modeId:"read-only"}` returns `{}`. **No `current_mode_update` or
`config_option_update` notification followed any of them** — the host must
take the response as the truth. `/status` confirmed `**Model:** gpt-6-luna[low]`.
The cheapest model, by Codex's own description ("Fast and affordable"), is
`gpt-6-luna`.

## Q5. `session/load` / resume after the process exits — MEASURED

In a **new** adapter process after probe B's exited (`c-resume.jsonl`,
`c-load.jsonl`):

- `session/list` → `[{"sessionId":"01a1458a-…","cwd":"…\\sandbox","title":"Single-word pong reply","updatedAt":"2026-10-16T16:28:13.000Z"}]`, `nextCursor: null`.
- `session/resume {sessionId,cwd,mcpServers:[]}` → `{models, modes, configOptions}`, **no replay** (one `available_commands_update`).
- `session/load` → same keys, **plus a replay**: `session_info_update` (title),
  6 `user_message_chunk`, 6 `agent_message_chunk`, 2 `tool_call`, 1
  `tool_call_update` — the conversation, minus the guardian frames and the
  cancelled turn's partial text.
- The model kept its context: T7 "what did you first reply?" → `AGENTSWORD-7731 pong`.
- **Load does NOT restore session settings**: after load, `mode=agent`,
  `model=gpt-6.1-sol`, `effort=medium`, `currentModelId=gpt-6.1-sol[medium]` —
  the defaults, though the session had been set to luna/low/read-only. The host
  must re-apply model, effort and mode after every load/resume.

**Where Codex keeps it:** `~/.codex/sessions/YYYY/MM/DD/rollout-<local-ts>-<id>.jsonl`
(first line `session_meta` with `cwd`, `cli_version`, `originator` = our ACP
`clientInfo.name`, `source:"vscode"`), indexed in `~/.codex/session_index.jsonl`
(`{id, thread_name, updated_at}`), alongside `state_5.sqlite` /
`thread_history_1.sqlite`. ACP `sessionId` == Codex thread id (UUIDv7). The
guardian review got its **own** rollout (`parent_thread_id` = the session,
`source:{subagent:{other:"guardian"}}`) and its own index line.

## Q6. Usage and plan limits — MEASURED; plan limits are the gap

**Token counts: yes, structured, per turn.** `session/prompt`'s result carries
`usage` (ACP field) and `_meta.quota.token_count` + `_meta.quota.model_usage[]`
(per model). The adapter's `inputTokens` **excludes** cached input
(`11962 + 7296 + 11 = 19269`); Codex's own `inputTokens` includes it
(app-server `last: {inputTokens:16219, cachedInputTokens:0, outputTokens:11, totalTokens:16230}`).
`usage_update {used,size}` is the context-window meter.

Three holes in the token numbers, all measured:

1. **A cancelled or rejected turn reports `usage: null`** (T6, T8) though the
   model ran.
2. **Hidden turns are not counted.** The guardian review spent 7,262 tokens
   (its rollout's `token_count`) and T3's `model_usage` lists only the session
   model. The adapter also runs an always-on **title generator** — an extra
   ephemeral `thread/start` + `runTurn` on `TITLE_MODEL = "gpt-5.6-luna"`
   (adapter source, `TitleGenerator.generateAndPersist`); its cost was not
   measurable from the outside.
3. Per-turn only; the session total exists only inside `/status`.

**Plan limits (the 5-hour and weekly windows): NOT in any structured ACP
frame.** A grep of every ACP capture for `usedPercent`, `rateLimit`,
`windowDuration` returns 0, and `_meta.quota` holds tokens only. The adapter
*does* receive them (it handles `account/rateLimits/updated` and calls
`account/rateLimits/read`), but it only renders them as **markdown text** in
the `/status` command's reply (no model turn, 0.4 s):

```
**Model:** gpt-6-luna[low]
**Account:** ChatGPT team (<redacted-email>)
**Token usage:** 38.6K total  (12.2K input + 26.4K cached input, 34 output)
**Context window:** 7% used (19.4K used / 258.4K)
**codex 5h limit:** 97% left (resets 15:19)
**codex Weekly limit:** 100% left (resets 10:19 on Oct 23)
```

Hitting a limit is signalled: the adapter maps Codex's `usageLimitExceeded` to
a typed `quota_exhausted` session failure (source; NOT MEASURED — we did not
exhaust a limit).

## Q7. Instruction files — MEASURED: `AGENTS.md` only

The sandbox (its own `git init`, so nothing above it is a project root) held
`AGENTS.md` → "Begin every reply with the code word AGENTSWORD-7731." and
`CLAUDE.md` → "… CLAUDEWORD-4492." Every reply in the session began with
`AGENTSWORD-7731` (T1: `AGENTSWORD-7731 pong`). T2, with tools forbidden:
`AGENTSWORD-7731 — AGENTSWORD-7731, from AGENTS.md.` `CLAUDEWORD` appears in
**0** frames of any capture. Codex read `AGENTS.md` and did not read
`CLAUDE.md`. Whether a Codex config setting can add `CLAUDE.md` as a fallback
was NOT MEASURED (the app-server protocol types have no such key).

---

## The `codex app-server` comparison (only for Q6's plan limits)

`codex.cmd app-server` (PATH 0.163.0), stdio, `launchSpec` shape
(`d-app-server.jsonl`). 0 stderr, 0 non-JSON lines; **its frames omit
`"jsonrpc":"2.0"`** (`{"id":1,"result":{…}}`), so a strict JSON-RPC parser
would reject them.

- `initialize {clientInfo, capabilities:{experimentalApi:true}}` →
  `{userAgent, codexHome:"C:\\Users\\dheinz\\.codex", platformFamily, platformOs}`, then the client sends `initialized`.
- `account/read` → `{"account":{"type":"chatgpt","email":"<redacted>","planType":"team"},"requiresOpenaiAuth":true,…}`.
- **`account/rateLimits/read` — no model turn — returns the limits structured:**

```json
{"ordinaryUsageAllowed":true,
 "rateLimits":{"limitId":"codex","primary":{"usedPercent":3,"windowDurationMins":300,"resetsAt":1792178362},
               "secondary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":1792765162},
               "credits":{"hasCredits":false,"unlimited":false,"balance":null},"individualLimit":null,
               "spendControlReached":false,"planType":"team","rateLimitReachedType":null},
 "rateLimitsByLimitId":{"codex":{…same…}},
 "rateLimitResetCredits":{"availableCount":1,"credits":[{"resetType":"codexRateLimits","status":"available","title":"Full reset (Weekly + 5 hr)",…}]}}
```

  `primary` is the 5-hour window (300 min), `secondary` the weekly (10080 min).
- One turn (`thread/start` + `turn/start`, luna/low) **pushed** both
  `thread/tokenUsage/updated {tokenUsage:{total,last,modelContextWindow}}` and
  `account/rateLimits/updated {rateLimits:{…same shape…}}` before `turn/completed`.

So app-server carries exactly what ACP drops, and it can be read **without a
turn and without a session**: a short-lived `codex app-server` process (or a
timer on one) answering `account/rateLimits/read` is a usage reader, not an
engine. Nothing else in Q1–Q7 failed over ACP, so nothing else was compared.

## Verdict

**Codex rides the general ACP engine (default).** Over ACP, on this machine,
`@agentclientprotocol/codex-acp@2.2.2` spawned cleanly, kept stdout pure JSON,
attached a stdio MCP server through `session/new` `mcpServers` (so the Session
Bus attaches with no Codex-specific code), streamed message and tool-call
updates, asked for permission with standard option kinds, honoured cancel and
reject, listed and resumed conversations across process exits, exposed models,
efforts and modes through `configOptions`, and reported per-turn token counts.
The **one gap is plan limits**: the 5-hour and weekly windows reach an ACP
client only as markdown text inside the `/status` reply. That gap does **not**
justify a native app-server engine: the same structured numbers come from one
zero-token `account/rateLimits/read` call to `codex app-server`, which #1290
can make from a small Codex usage reader beside the ACP engine. The adapter is
itself an app-server client, so this is the same data from the same source,
not a second integration. Smaller costs to account for, none blocking: settings
are not restored by `session/load`, cancelled or rejected turns report no
usage, and the default `agent` mode runs a hidden guardian model that approves
actions without asking the user.

## What this means for #1289 (the ACP engine) and #1290 (the Codex provider)

**#1289 — the general ACP engine**

1. **Spawn:** for a `.cmd` shim use the `launchSpec` shape (`cmd.exe /c
   <absolute .cmd> <args>`). `execSpec` as it stands **cannot launch a `.cmd`
   whose path has a space**, and bare `npx.cmd` breaks the shim's `%~dp0`.
   Either fix `execSpec`'s command token (out of scope here) or resolve to
   `node.exe <npx-cli.js>`; for user-typed "something else" commands the
   injection reasoning in `win-cmd.ts` still applies.
2. **Framing:** newline-delimited JSON on stdout; stderr is diagnostic only.
   Codex-acp wrote 0 non-JSON lines, but the parser must still log-and-skip
   anything non-JSON (fail-open, §6).
3. **Agent → client request ids start at 0.** Correlate on `id !== undefined`.
4. **Auth:** treat `session/new` → `-32000 "Authentication required"` as
   "logged out". `_auth/status_update` (an `_`-prefixed extension
   notification) carries `kind`/`label`/`account.plan`, and can arrive after
   the error.
5. **Client capabilities:** advertising `fs` false and `terminal:false` is
   honoured for *requests* (none arrived), but shell tool calls still carry
   `{"type":"terminal","terminalId"}` content and **no command output** —
   render it as "ran a command" with the exit code from
   `_meta.terminal_exit`, not as a terminal.
6. **Event variants to map** (Q2 table): `agent_message_chunk`,
   `user_message_chunk` (replay), `tool_call`/`tool_call_update` (kinds
   `execute`, `think`), `usage_update`, `session_info_update` (`title`; and
   `_meta.codex.threadStatus.activeFlags:["waitingOnApproval"]`, a free
   "needs you" signal for attention routing), `available_commands_update`.
   Unseen-but-possible variants listed under Q2 must be logged and skipped.
7. **Permissions:** choose by `kind` (`allow_once`, `allow_always`,
   `reject_once`; `reject_always` may be absent), answer with the `optionId`.
   A reject ends the turn with `stopReason:"cancelled"`, so do not show it as
   an error.
8. **Models/modes:** prefer `configOptions` (by `category`: `model`,
   `thought_level`, `mode`, …) and `session/set_config_option`, which echoes
   the new state. `models`/`session/set_model` also work. No change
   notification follows a set; the response is the state.
9. **Resume:** `loadSession:true` + `sessionCapabilities.list/resume`.
   `session/load` replays, `session/resume` does not. **Re-apply model, effort
   and mode after either.** A session with no prompt is not persisted.
10. **Usage:** read `session/prompt` result `usage` (ACP) and `_meta.quota`.
    Expect `null` on cancelled/rejected turns. `usage_update` is the
    context-window meter.
11. **MCP / Session Bus:** `session/new.mcpServers[] = {name, command (absolute),
    args[], env:[{name,value}]}` launches the server and lists its tools.
    Re-send it on `session/load`/`session/resume` (we sent `[]` there, so
    re-attach on load is NOT MEASURED).

**#1290 — the Codex provider**

1. Pin the adapter (`@agentclientprotocol/codex-acp@2.2.2`). Decide whether to
   set `CODEX_PATH` to the user's `codex`: unset, the adapter runs its bundled
   0.160.1 while the user has 0.163.0 (version shown in the status bar would be
   wrong; `CODEX_PATH` NOT MEASURED).
2. **Plan limits:** a usage reader that spawns `codex app-server`, sends
   `initialize` + `initialized` + `account/rateLimits/read`, and exits.
   `primary` = 5 h, `secondary` = weekly, both `usedPercent` + `resetsAt`
   (epoch s). Do not parse `/status` text. Its frames lack `"jsonrpc"`.
3. **Default mode is a product decision** (the owner's): the adapter's default
   `agent` mode lets a hidden guardian model approve actions without asking
   and spends tokens the usage numbers do not show. `workspace-write` (asks
   before writing outside the workspace) or `read-only` route approvals to the
   user. Mention it in the switch menu either way.
4. Login state: `_auth/status_update` / `account/read`; logged-out detection is
   the `session/new` error. The browser login (`authenticate` `chat-gpt`) was
   not run.
5. The briefing must say Codex reads `AGENTS.md`, not `CLAUDE.md` (§6 rule
   confirmed).
6. Sessions live in `~/.codex/sessions/…/rollout-*.jsonl` and
   `session_index.jsonl`; the guardian adds its own entries there.

## Out of scope, found on the way

**`win-cmd.ts` `execSpec` cannot launch a `.cmd` whose path contains a space.**
Measured (`a-spawn-shapes.jsonl`): `execSpec("C:\\Program Files\\nodejs\\npx.cmd", […])`
→ `'"C:\Program' is not recognized as an internal or external command`. The
caret before each quote of the command token makes cmd.exe treat it as a
literal character, so the token splits at the space. It does not bite the
owner today because `claude.cmd` is under `C:\Users\dheinz\AppData\Roaming\npm`
(no space). It would bite a Windows user whose profile path has a space, on
every `execSpec` caller (`mcp/cli.ts`, `mcp/health.ts`,
`bus/mcp-attach-check.ts`, `providers/claude-oneshot.ts`).
