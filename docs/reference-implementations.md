# Reference implementations on this machine

Undocumented contracts are the biggest recurring risk in this project — DESIGN
§5.2 records hook payloads mutating across patch releases with no changelog, and
S-09 burned four runs on false negatives before producing evidence. When a
contract is unclear, **there is a working implementation of it sitting on disk.**

This file says where, and how to read it without wasting a session.

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
| `resources/native-binary/claude.exe` | 265 MB | Their bundled CLI. We do not use it, but its existence is why a probe must be run against **our PATH CLI**, never assumed from their behavior |

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

`claude --help` is the other reference, with one caveat proven in S-10:
**it can be stale.** It states that `--input-format` / `--output-format` "only
works with `--print`". They do not — the SDK omits `--print` entirely and the
CLI is fine with it. Treat `--help` as a strong hint and the bundle's arg
builder as the tiebreaker, then verify with a probe.

Flags that are real but hidden from `--help` exist (`--permission-prompt-tool`
is one). Absence from help is not absence from the CLI.

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
