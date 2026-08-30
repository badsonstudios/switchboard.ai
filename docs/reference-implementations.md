# Reference implementations on this machine

Undocumented contracts are the biggest recurring risk in this project — DESIGN
§5.2 records hook payloads mutating across patch releases with no changelog, and
S-09 burned four runs on false negatives before producing evidence. When a
contract is unclear, **there is a working implementation of it sitting on disk.**

This file says where, and how to read it without wasting a session.

There are **three** sources, and they answer different questions. §1 the VS Code
extension — a known-correct *client*, so it shows what a caller **sends**. §2.1
the `claude` binary on PATH — the other end of the same contract, so it shows
what the CLI **does with what it received**. §2.2 `--help` — what the CLI
**accepts**.

Reading any of those three costs nothing. **Running a probe is a different
thing**: a flag-validation probe (`--permission-mode <v> --version`, §2.3) is
free, but the probes in §3 send real turns to the real CLI and spend Dan's
subscription quota. Exhaust the readable sources before you spend one.

---

## 1. The Claude Code VS Code extension

```
~/.vscode/extensions/anthropic.claude-code-<version>-win32-x64/
```

Several versions are usually installed side by side — **take the highest**, and
check it against `claude --version`, because the extension ships its own CLI and
can be ahead of or behind the one on PATH:

```bash
ls -d ~/.vscode/extensions/anthropic.claude-code-* | sort -V | tail -1
```

### What is in there

| Path | Size | What it is |
|---|---|---|
| `extension.js` | ~2.6 MB, **907 lines** | The extension host. Minified — **line 235 is a verbatim embed of `@anthropic-ai/claude-agent-sdk`**, including the CLI arg builder and the whole stream-json transport |
| `webview/index.js` | ~4.8 MB, 2057 lines | The React app that renders the message stream. No xterm, no ANSI handling |
| `webview/index.css` | ~379 KB | Their styling, if a visual question ever comes up |
| `claude-code-settings.schema.json` | ~133 KB | **The complete JSON Schema for `settings.json`** — see §1.3, this is the most immediately useful file in the bundle |
| `package.json` | ~15 KB | Every setting and command the extension contributes, in readable JSON. **Start here** — it is the only unminified overview |
| `resources/native-binary/claude.exe` | ~287 MB | Their bundled CLI. We do not use it, but its existence is why a probe must be run against **our PATH CLI**, never assumed from their behavior |

### 1.1 How to read the minified files

Both big files are a handful of enormous lines, so line-oriented tools are
useless and `Read` will blow up your context. Use `grep -o` with fixed context
widths — this is the technique that produced S-10:

```bash
cd ~/.vscode/extensions/anthropic.claude-code-2.1.220-win32-x64

# Is a concept present at all, and where? Cheap first move.
grep -c -F 'can_use_tool' extension.js

# Pull a readable window around a hit (tune the widths; 400-900 works well).
grep -o -E '.{400}stdio.{800}' extension.js | head -3

# Enumerate string literals of a known shape — good for protocol discovery.
grep -o -E '"(can_use_tool|hook_callback|mcp_message|interrupt)"' extension.js \
  | sort | uniq -c
```

Two habits worth keeping:

- **Count before you extract.** A zero count is itself a finding (`node-pty`
  appears **0** times — that is how we know there is no PTY anywhere).
- **Grep both files.** The extension host and the webview split the work; a
  concept present in one and absent in the other tells you which side owns it.

**A grep window that is too wide returns NOTHING, silently** *(found 2026-08-13
during P2-E10-09's contract research).* On `webview/index.js` — one 4.8 MB line
— a `grep -o -E '.{400}needle.{900}'` matched **zero** while `grep -o -F
'needle'` counted the literal as present. A zero from a wide window is a tool
limit, not a finding, and reading it as one is how a real contract gets
declared absent. Two rules follow:

- **Confirm any zero with a plain `grep -c -F`** before you write it down.
- **When you need a window wider than ~800 chars, use node instead of grep** —
  it is still a pure read and it has no window limit:

  ```bash
  node -e "const s=require('fs').readFileSync('webview/index.js','utf8');
           const i=s.indexOf('media_type');
           console.log(s.slice(i-600,i+900))"
  ```

### 1.2 What the bundle is good for

It is a **known-correct consumer of every CLI contract we depend on**. Reach for
it when:

- A CLI flag is hidden from `--help` and you need to know whether it is real and
  what it pairs with. (`--permission-prompt-tool` is undocumented; the arg
  builder shows exactly when the SDK sets it and to what.)
- You need the **shape of a payload** before writing a parser — control requests,
  `system:init`, `stream_event`, `transcript_mirror`.
- You want to know whether a capability exists at all before designing around
  it. `grep -c` answers that in seconds.
- You are choosing between two designs and want to know what Anthropic chose.
  They kept a terminal escape hatch (`claudeCode.useTerminal`, default `false`)
  — that is evidence, not proof, but it is better than a guess.

#### 1.2.1 The outbound control protocol — the one that keeps being missed

**Read this before concluding that the CLI "cannot" do something.** Twice now
(#632, #714) a design decision was made on the strength of a `--help` probe,
and twice the capability existed on the control channel instead. The subcommand
surface and the protocol surface are DIFFERENT SURFACES; `--help` describes one
of them.

The SDK's outbound requests all take the same shape —
`await this.request({subtype:"…", …})` — and are answered with
`{type:"control_response", response:{request_id, …}}`, correlated by
`request_id`. One grep lists them all:

```bash
grep -o -E 'subtype:"[a-z_]+"' extension.js | sort -u
```

Observed in `anthropic.claude-code-2.1.226` and confirmed present in the PATH
CLI 2.1.245: `set_model`, `set_permission_mode`, `set_thinking_level`,
`set_max_thinking_tokens`, `set_cwd`, `mcp_toggle`, `mcp_reconnect`,
`mcp_status`, `mcp_set_servers`, `mcp_authenticate`, `get_context_usage`,
`get_settings`, `get_usage`, `rewind_files`, `reload_plugins`, `reload_skills`,
`interrupt`, `stop_task`, `background_tasks`, `initialize`, and more.

Two things worth knowing beyond the list:

- **`initialize`'s RESPONSE carries data, not just an ack.** `supportedModels()`
  is `(await this.initialization).models`; `supportedAgents()` is `.agents`. A
  model picker needs no discovery mechanism of its own.
- **Locating a subtype is not verifying it.** These are symbols in a binary.
  The list above was never exercised — §1.2.2 is what happened when it was.

#### 1.2.2 The control protocol, MEASURED (#721, 2026-08-28, PATH CLI 2.1.245)

**This section outranks §1.2.1.** That one is a map drawn from grepping a
binary; this one is what the CLI actually did when driven. The harnesses are
committed at **`spike/probes/721/`** (with a README mapping each probe to the
question it answers), spawned with the exact stream flag list from
`providers/claude.ts`.

##### The envelope, and the trap in it

```jsonc
// out
{"type":"control_request","request_id":"sb-1","request":{"subtype":"set_model","model":"haiku"}}
// back — success
{"type":"control_response","response":{"subtype":"success","request_id":"sb-1","response":{…}}}
// back — refusal
{"type":"control_response","response":{"subtype":"error","request_id":"sb-4","error":"<sentence>"}}
```

⚠️ **`request_id` IS NESTED AT `msg.response.request_id`, AND IS ABSENT AT THE
TOP LEVEL** — measured, `topLevelRequestId=undefined` on every reply. The
INBOUND `can_use_tool` requests we already parse carry theirs at the TOP level
(`stream-permissions.ts` reads `msg.request_id`), so **the two directions
differ**. A correlator written by copying the inbound reader matches nothing,
for ever, and looks exactly like a CLI that never answers.

Also: **`response` is absent entirely on a payload-free success.** `set_model`
answers `{subtype:"success", request_id}` with no `response` key — not `{}`.

##### Verb by verb

| verb | measured result |
|---|---|
| `initialize` | Works, repeatable, ~28 KB. Keys: `commands` (60, **with `description` and `argumentHint`**), `agents`, `models`, `output_style`, `available_output_styles`, `account`, `pid`, `current_permission_mode`, `fast_mode_state`, `session_state`, `analytics_disabled`, `remote_control_*`. |
| `list_models` | **In no grep list on either ticket.** Returns `{models:[…]}` alone — the right call for a picker. 5 entries, each `{value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels, …}`. |
| `set_model` | Genuinely switches the model mid-session, no restart — verified BY EFFECT (below), not by its ack. |
| `get_context_usage` | Works. `{categories[], …}` with a `percentage` — #715 is served directly. |
| `mcp_status` | Works. `{mcpServers:[{name, status, serverInfo, config, scope, tools[]}]}` — structured, and strictly richer than parsing `claude mcp list`. This is #723's real fix. |
| `set_permission_mode`, `get_settings`, `get_usage` | All work. |
| `supported_models`, `get_models`, `status` | **Do not exist** — `Unsupported control request subtype: …` |

##### Four findings that change how you write a consumer

1. **Control requests work on a cold session — you do NOT need `initialize`
   first.** Measured separately (`spike/probes/721/probe721c.mjs`) because the first version of
   this finding said the opposite and was wrong: `list_models` sent as the very
   first thing to a freshly spawned session, with no `initialize` and no turn,
   answered with all 5 models in ~680 ms (process startup, not the verb).

   The claim it replaces — "send `initialize` first or it hangs" — came from a
   probe that **hung on its own logic**: it only sent its verb from inside a
   `system:init` handler, and `system:init` is emitted **once per TURN**, so on
   a session that had run no turn it never sent anything at all. The CLI was
   never refusing. **A silent CLI is worth suspecting your own probe over**, and
   this one cost a wrong line in this document before it was caught in review.

   The turn-scoped `system:init` is still true and still matters — see finding
   3 — it just is not a precondition for the control channel.
2. **`set_model` WITH NO `model` FIELD RETURNS `success` AND DOES NOTHING.** A
   non-string is properly refused (`set_model: model must be a string`) and an
   unknown id is refused with a sentence — but the ABSENT case is a silent
   no-op dressed as a working feature. **Validate before sending; the CLI will
   not catch a dropped field for you.**
3. **Nothing tells you the CURRENT model.** `list_models` marks none of its
   entries, and `initialize` has no current-model key (both dumped and
   checked). The only source is `system:init.model`, which arrives **once per
   turn** — so before a session's first turn its model is genuinely unknown,
   and a picker must say so rather than defaulting to `default`.
4. **The channel is NOT blocked by a turn in flight.** Round trips measured at
   **0–2 ms while the model was mid-reply**. A consumer needs no busy state and
   must not serialise behind a turn.

##### How `set_model` was verified

By effect, not by acknowledgement: `set_model(haiku)` → the next turn's
`system:init.model`, the assistant message's `message.model` and
`result.modelUsage` **all three** reported `claude-haiku-4-5-20251001`; then
`set_model(sonnet)` → all three reported `claude-sonnet-5`, mid-session, no
restart.

##### Fail-open is real

An unknown subtype comes back as an ordinary error response
(`Unsupported control request subtype: no_such_verb_xyz`) and **the session
lives**. That is the P6 answer for a future CLI that renames a verb — measured,
not hoped. Refusals are written for a human, so pass the CLI's own sentence
through rather than rewording it.

The implementation of all this is `main/transport/control-channel.ts`; the
builders and readers are in `shared/stream-protocol.ts`.

##### The three MCP verbs, MEASURED (#729, 2026-08-29, PATH CLI 2.1.245)

**`mcp_toggle` AND `mcp_reconnect` BOTH EXIST.** #632 and #714 each concluded
there is no verb for enabling and disabling a server, and shipped a hand-off to
the CLI's picker on that basis. That was **a claim about `claude mcp --help`
stated as a fact about the whole CLI**, and it is wrong.

Probed without mutating anything, by naming a server that does not exist — the
CLI distinguishes an unknown VERB from an unknown ARGUMENT, so existence is
provable without a side effect (`spike/probes/721/probe-mcp-verbs.mjs`):

```
mcp_toggle    {serverName:"__does_not_exist__", enabled:false}
  -> error "Server not found: __does_not_exist__"
mcp_reconnect {serverName:"__does_not_exist__"}
  -> error "Server not found: __does_not_exist__"
__definitely_not_a_verb__                                        <- the control
  -> error "Unsupported control request subtype: __definitely_not_a_verb__"
```

The control line is what makes this conclusive rather than suggestive: a verb
the CLI does not have answers with a *different sentence entirely*. Also
measured: `mcp_toggle` with **no `serverName`** answers `Server not found:
undefined` — refused, not the `set_model` silent no-op.

##### Both verbs, MEASURED against a real server (#729 PR 2, 2026-08-29)

Probed with a **throwaway server the harness adds and removes itself**
(`spike/probes/721/probe-mcp-toggle.mjs`) — so no real server was touched and
`~/.claude.json` was verified clean afterwards. That trick is what made the
remaining questions answerable at all: the CLI's server lookup runs first, so a
fake name can never reach the interesting behaviour.

**1. ⚠️ `mcp_toggle` WITH NO `enabled` FIELD DISABLES THE SERVER AND ANSWERS
SUCCESS.** This is the `set_model` trap made worse — that one was a silent
*no-op*; this one performs a destructive action:

```
-> {"subtype":"mcp_toggle","serverName":"sbprobe"}     // no `enabled`
<- {"subtype":"success"}                                // payload is null
-> {"subtype":"mcp_status"}
<- sbprobe: "disabled"                                  // it turned it OFF
```

An absent field reads as falsy. So a dropped or mistyped `enabled` anywhere
upstream turns off a user's MCP server and reports that it worked. Validate for
a **strict boolean** — not truthiness, since coercion is the very behaviour that
makes this dangerous. `mcpToggleRequest` refuses anything else.

**2. THE TOGGLE PERSISTS.** It writes `projects[<folder>].disabledMcpServers` in
`~/.claude.json` — a key **distinct from `disabledMcpjsonServers`**, which is the
`.mcp.json` approval mechanism. Toggle off adds the name; toggle on removes it,
leaving `[]`. So it is **not session-scoped**: it survives a restart and applies
to every future session in that folder, and a surface must not say "for this
session".

**3. `mcp_status` REPORTS `status:"disabled"`** for a toggled-off server — a
fourth status word beyond the three §1.2.2 had. A reader that folds it into
`unknown` makes a server the user just switched off read as "status unknown",
and the toggle look broken.

**4. `mcp_reconnect` PULLS IN A SERVER THE SESSION NEVER LOADED.** The finding
that makes it more than a retry button, given `mcp_status` is frozen at spawn:

```
mcp_status                        -> DeepWiki, sbprobe          // sbprobe2 added mid-session, absent
mcp_reconnect {name:"sbprobe2"}   -> success
mcp_status                        -> DeepWiki, sbprobe, sbprobe2(connected)
```

So "you added a server, pull it in" and "reconnect the one that dropped" are the
same verb, and #714's `restart-required` is avoidable wherever a live stream
session exists.

##### The FULL subtype set, existence-tested (#633 audit, 2026-08-30)

Every verb in the SDK's grepped list, asked of the PATH CLI 2.1.245 with a
negative control to keep the discriminator honest
(`spike/probes/721/probe-command-verbs.mjs`). **All but one exist:**

`apply_flag_settings` · `background_tasks` · `cancel_async_message` ·
`channel_enable` · `generate_session_title` · `get_context_usage` ·
`get_settings` · `get_usage` · `mcp_authenticate` · `mcp_clear_auth` ·
`mcp_oauth_callback_url` · `mcp_set_servers` · `mcp_status` · `mcp_toggle` ·
`mcp_reconnect` · `message_rated` · `read_file` · `reload_plugins` ·
`reload_skills` · `remote_control` · `rewind_files` · `seed_read_state` ·
`set_cwd` · `set_max_thinking_tokens` · `set_mcp_permission_mode_override` ·
`set_model` · `set_permission_mode` · `side_question` · `stop_task` ·
`submit_feedback` · `ultrareview_launch` · `list_models` · `initialize`

**`status` is the only one that does NOT exist** on this build, matching what
§1.2.2 already recorded.

⚠️ **A PROCESS WARNING, PAID FOR.** The #729 probes GUESSED verb names
(`list_agents`, `get_hooks`, `resume_session`, …) — none of which exist — while
the real list had been sitting in **#633's own comment** since 2026-08-16. That
is how `mcp_authenticate` went unnoticed through two PRs and a release cycle
(now #734). **Read the recorded list before inventing names.**

⚠️ **AND A HAZARD REPEATED.** Existence was tested by sending each verb with NO
arguments. Most refuse with a validation complaint, which is the safe answer —
but `remote_control`, `seed_read_state` and `set_max_thinking_tokens` all
answered **success with a `null` payload**, which is the `set_model` shape and
means they may have ACTED. Nothing persisted (`~/.claude.json` diffed clean
against a snapshot; the 39 changes were all CLI-managed caches, and each probe
spawns a throwaway session), but that was checked afterwards rather than
designed for. **If you existence-test a `set_*`/action verb, expect it to fire.**

##### The picker commands #633 was written about are mostly GONE

`initialize.commands` on 2.1.245 lists 69 entries. Of the seven #633 asks to
triage, **five are not commands at all**: `/permissions`, `/hooks`, `/resume`,
`/rewind`, `/output-style`, `/status`. `/agents` exists and its own description
begins **"(removed)"**. What survives is `/config` ("Set a setting by key" —
takes an argument, so it passes through), `/context` (#715) and `/usage`.

`initialize` also carries `current_permission_mode`, `output_style`,
`available_output_styles` and the full `agents` array — so several of those
surfaces are READABLE even where no dedicated verb exists.

##### MCP connector sign-in (#734, 2026-08-30)

```
mcp_authenticate {}                       -> "Server not found: undefined"        (refused, not a silent act)
mcp_authenticate {serverName:<stdio>}     -> 'Server type "stdio" does not support OAuth authentication'
mcp_clear_auth   {serverName:<stdio>}     -> 'Cannot clear auth for server type "stdio"'
mcp_oauth_callback_url {serverName:<srv>} -> "No active OAuth flow for server: <name>"
```

So **auth is remote-only** — the control belongs on http/sse rows, not every
row. Unlike `mcp_toggle`, the missing-argument case is properly refused; do not
generalise that, validate anyway.

⚠️ **THE OAUTH SUCCESS PATH IS UNMEASURED AND UNMEASURABLE HERE.** No claude.ai
connector exists on the dev machine, so what `mcp_authenticate` returns when it
really starts a flow — whether a browser opens, what `mcp_oauth_callback_url` is
for, how a row leaves `needs-auth` — is unknown. **Do not infer it from the
refusals above.** Treat an unrecognised answer as "we do not know".

⚠️ **STILL UNMEASURED:** whether `mcp_toggle` works on a **claude.ai connector**
or a plugin-supplied server. This machine has neither. The pane offers the
control on those rows anyway and renders the CLI's own refusal if it says no —
fail-open. Do not narrow that to "config-backed rows only" without measuring it
first; the toggle works by NAME, not through a file, so there is no reason to
assume it cannot.

##### ⚠️ `mcp_status` SETTLES — the §1.2.2 capture above is the WARM answer

Measured by polling one session (`spike/probes/721/probe-mcp-settle.mjs`):

```
[  896ms] {name:"DeepWiki", status:"pending",   scope:"local"}    // no serverInfo, no tools
[ 2014ms] (unchanged)
[ 5012ms] {name:"DeepWiki", status:"connected", scope:"local",
           serverInfo:{name:"DeepWiki",version:"2.14.3"},
           tools:[{name:"ask_question"},{name:"read_wiki_contents"},{name:"read_wiki_structure"}]}
[10015ms] (unchanged)
```

So a consumer that asks **once, on open, gets a strictly poorer answer** than one
that waits — every server greyed and toolless on a session that is perfectly
healthy. `pending` is a state the surface must be able to DRAW, not a transient
to code around, and `serverInfo`/`tools` are **absent rather than empty** for the
whole window. `main/mcp/status.ts` is written to that; the pane re-polls at 2 s
while any row is `pending`, bounded at eight asks.

`system:init.mcp_servers` carries an inventory too, but it arrives **once per
turn** (the same constraint as `system:init.model`), so it is useless to a pane
opened on a session that has not run one.

##### ⚠️ AND `mcp_status` IS FROZEN AT SPAWN — it does NOT re-resolve

Measured (`spike/probes/721/probe-mcp-add-live.mjs`): with a session running,
`claude mcp add sbprobe -s local` wrote the config (the CLI confirmed
`File modified: …\.claude.json`) and **the new server never appeared** in that
session's `mcp_status`, across polls at 6 s, 10 s and 16 s. Removing it again
likewise changed nothing. The CLI resolves its MCP set **once, at spawn** —
which is why `mcp_reconnect` and the whole Reconnect affordance exist.

**This is a UI constraint, not a footnote.** A pane sourced only from
`mcp_status` answers Add with a list that does not change, and answers Remove by
leaving the row on screen — where, its config entry now gone, it silently turns
read-only. Both read as bugs. So the config files stay in the picture for a live
session too: `main/mcp/merge.ts`'s `notLoaded` is the set difference, drawn under
its own heading.

The consumers are `main/mcp/status.ts` (parse), `main/mcp/merge.ts` (the join to
the config files, which is what decides whether a row can be removed) and the
`mcp:status` channel in `main/mcp/ipc.ts`.

### 1.3 The settings schema is the standout

`claude-code-settings.schema.json` is the full, authoritative schema for
`settings.json` — ~150 top-level keys, each with a description. We generate a
settings file per session (`writeSessionSettings` in
`src/main/providers/claude.ts`, the S-02 mechanism) and the CLI **silently
ignores a malformed one**, which is precisely why that function validates before
spawn.

Use the schema to check a key exists and is spelled right, rather than
discovering at runtime that our hooks quietly vanished:

```bash
node -e "const s=require('$SCHEMA');console.log(Object.keys(s.properties).join('\n'))"
node -e "const s=require('$SCHEMA');console.log(JSON.stringify(s.properties.hooks,null,2))"
```

It is also worth diffing across CLI upgrades — a key appearing or disappearing
is an early warning for the drift class DESIGN §5.2 describes.

### 1.4 Rules for using it

- **Read it to learn contracts. Do not copy code from it.** The extension is
  proprietary (`© Anthropic PBC. All rights reserved`). Payload shapes, flag
  names and protocol behavior are facts about an interface we are entitled to
  interoperate with; their implementation is not ours to lift.
- **Their behavior is not our guarantee.** They bundle their own CLI. Anything
  load-bearing gets **verified against the CLI on PATH** before we build on it —
  that is the entire reason `spike/s10/` exists as runnable probes rather than
  as a prose summary of the bundle.
- **Record what you find in a findings note**, not just in a commit message. The
  bundle changes with every extension update; a note dated against a version
  stays useful, a memory of what you once saw does not.

---

## 2. The CLI itself

The CLI is two references, not one. **The binary can be read** (§2.1) — it
embeds its own source, and that is where a question about *behaviour* gets
answered. **`--help`** (§2.2) tells you what it accepts, and a probe (§2.3 for
the free kind, §3 for the kind that spends tokens) settles what it does.

### 2.1 The binary is greppable — read what the CLI actually does

```
~/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe
```

~320 MB, Bun-compiled to a single executable — which means it **carries its own
JavaScript inside it as plain text**, including the zod schemas for every
message it accepts and emits, the stdin message loop, and its log strings. All
of it greps like a minified bundle, because that is what it is.

**Reach for this when the question is "what does the CLI DO with X?".** The
extension (§1) cannot answer that class of question at all — it is a client, so
it shows what gets *sent*. #490 is the worked example: both sources agree that
the user envelope carries a `uuid`, but only the binary says that the CLI's
entire de-duplication pass is **guarded on the field being present**, so
omitting it means every frame executes, always. That is the difference between
"they send it, so we probably should" and a reason.

| Question | Source |
|---|---|
| What fields does a client put on the wire? | §1, the extension |
| Which flags pair with which, and when? | §1, the SDK's arg builder |
| Is this field required, optional, or a literal? | §2.1, the zod schemas |
| What does the CLI do when it's present / absent? | §2.1, the message loop |
| Does the CLI accept this flag value at all? | §2.2, `--help` + a probe |

#### The recipe

Same shape as §1.1, with `-a` added — **without `-a`, grep sees a binary and
prints `Binary file … matches` instead of your window**, which reads exactly
like a hit with no content.

```bash
cd ~/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin

# 1. COUNT FIRST. Cheap, and a zero is itself a finding — after §1.1's rule.
grep -a -o -F 'cli_user_message_dedup_skipped' claude.exe | wc -l

# 2. Then pull a readable window. 250-700 either side is proven; go wider and
#    grep can return NOTHING silently (§1.1's trap applies here too).
grep -a -o -E '.{700}cli_user_message_dedup_skipped.{700}' claude.exe

# 3. A name you read in step 2 is a handle on everything that uses it — this
#    is how you get from a function to its call sites.
grep -a -o -E '.{250}RCg\(.{150}' claude.exe
```

**A short alias is only unambiguous inside its own module.** The bundle keeps
per-module scopes, so `Mr` is `z.enum` in the schema module and a highlight.js
language definition somewhere else entirely (`grep -a -o -E 'var Mr=.{80}'
claude.exe` returns the latter). Long names like `RCg` are effectively unique
and safe to chase; two- and three-character ones are not. Before you follow an
alias, confirm its definition appears in the same window as the use.

Three habits that make this fast:

- **Enter through a log string, not through a name.** Minified identifiers
  (`RCg`, `yt`, `Vr`) are unguessable, but the messages beside them are
  English and survive minification verbatim: `Skipping duplicate user message`,
  `Sending acknowledgment for duplicate user message`. Grep the sentence, read
  the code around it, *then* pick up the identifiers.
- **Schemas cluster.** Find one (`isReplay:kt(!0)`) and the whole family of
  message shapes is inside the same window, because they are defined together.
  Inside that module `kt` is `z.literal`, `F()` is `z.string()` and `Mr` is
  `z.enum` — re-derive the aliases once per session from a schema you already
  understand, and re-derive them again if you move to a different window.
- **A `.describe()` string is documentation Anthropic wrote and never
  published.** Several fields carry a paragraph explaining intent, and some say
  outright that a client must not set them (`"@internal … Injected
  server-side"`).

#### Rules

- **NEVER `Read` or `cat` this file.** It is 320 MB. §1.1's context warning
  about a 2.6 MB bundle applies here roughly a hundred-fold; `grep -a -o` with
  a fixed window is the only safe access. The node-slurp fallback in §1.1 is
  also **not** available at this size — it would read the whole file into a
  string.
- **This binary is the one that counts.** The extension bundles CLI **2.1.226**
  (`resources/native-binary/`); the PATH CLI is **2.1.233**. Where they differ,
  PATH wins, because PATH is what the app spawns and what Dan runs. Check with
  `claude --version` and write the version into whatever you record — a finding
  without one rots silently.
- **Read contracts, don't copy code** — §1.4's rule, unchanged. The same
  copyright applies, and minified source is not ours to lift.
- **It costs nothing.** No model call, no tokens, no session state. There is
  never a reason to guess a message shape when this is on disk.

### 2.2 `--help`

`claude --help` is the other reference, with one caveat proven in S-10:
**it can be stale.** It states that `--input-format` / `--output-format` "only
works with `--print`". They do not — the SDK omits `--print` entirely and the
CLI is fine with it. Treat `--help` as a strong hint and the bundle's arg
builder as the tiebreaker, then verify with a probe.

Flags that are real but hidden from `--help` exist (`--permission-prompt-tool`
is one). Absence from help is not absence from the CLI.

### 2.3 Contract note — `--permission-mode` (verified 2026-08-19, CLI 2.1.233)

The mode we pass per autonomy profile lives in `AUTONOMY_PERMISSION_MODE`
(`src/main/providers/claude.ts`), with the full reasoning. The facts behind it,
so the next person does not re-derive them:

- **The built-in default moved.** From **v2.1.228** (macOS/Linux/WSL) and
  **v2.1.233** on native Windows, a Pro/Max/Team session that passes no
  `--permission-mode` starts in **`auto`** — a classifier reviews each action
  instead of a person. Before those versions it started in Manual. This is why
  `ask` no longer inherits (#587): **no profile may leave the mode unset.**
- **Manual mode's config value is `default`; `manual` is an alias** added in
  v2.1.200. `--help` on 2.1.233 advertises only `manual`, but `default` is what
  the SDK, hooks and `permissions.defaultMode` use, and it is what `manual`
  normalizes to (the extension bundle's SDK carries a literal
  `manual -> default` mapping next to its enum). Prefer `default`.
- **`--help`'s "Allowed choices" list is a display list, not the validator.**
  2.1.233 lists `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`
  and omits `default` — yet `default` is accepted. Do not read a missing value
  as an unsupported one.
- **`--permission-mode` outranks every settings file**, so pinning the flag
  makes writing `permissions.defaultMode` redundant. (Also: an `"auto"` value in
  project or local settings is ignored outright.)
- **Probing a flag value costs nothing.** `claude --permission-mode <v>
  --version` validates the option and exits — no model call, no tokens. A bogus
  value errors, so acceptance is a real signal rather than a silent pass:

  ```bash
  for m in zzzbogus default manual auto dontAsk; do
    printf '%s => ' "$m"; claude --permission-mode "$m" --version 2>&1 | head -1
  done
  ```

Re-verify on a CLI major bump; this is exactly the drift class DESIGN §5.2
describes.

---

## 3. Existing probes

`spike/s09/` and `spike/s10/` are runnable and committed. Before writing a new
probe, read `spike/findings/s-09-permission-prompt-tool.md` §"Four false
negatives" — a `.cmd` shim, inherited `CLAUDE_CODE_*` env, a bracket-pasted
single-line prompt, and the trust dialog each produced a result indistinguishable
from "the flag does nothing".

**The transferable lesson: a silent result is indistinguishable from a broken
harness.** Assert that your input actually arrived *before* you read any verdict
out of a probe.
