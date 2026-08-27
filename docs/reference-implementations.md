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
  Nothing above has been exercised, and the standing rule still applies: probe
  the PATH CLI before building. #721 is the ticket that does that.

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
