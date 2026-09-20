# 758 — can a headless label pass be made harmless, and what does it cost?

**Probe:** `spike/probes/758/` (`node spike/probes/758/probe-label-containment.mjs > report.json 2> summary.txt`)
**CLI:** claude **2.1.272**, native Windows, model `haiku`, run 2026-09-20.
**Captured RC: 0** (read from the probe's own `$?`, not from a reported exit code — the harness has misreported that four times, #801/#864).

## Why it was run

`main/sessions/context-package.ts` records that a headless `claude -p` pass was
**considered and rejected** for the neighbouring feature, citing #760: a `-p`
probe in a temp cwd with `--permission-mode bypassPermissions` enumerated the
machine's other live sessions, read the user's transcripts, and **messaged six
sessions across four unrelated projects**. Recorded lesson: **"a cwd is not a
sandbox"**, and that finding names its own heirs — *"anything that runs a
headless pass over a transcript inherits this exact question."* #758 is one.

## The headline

**Containment holds, but ONLY the combination does — and the flag whose NAME
sounds like containment is the one that does not provide it.**

| run | tools | MCP servers |
|---|---|---|
| **control** (no containment flags) | **33** | 1 (`claude.ai Claude Docs`) |
| `--restricted` alone | **34** | 1 |
| `--strict-mcp-config` alone | 33 | **0** |
| **`--tools "" --restricted --strict-mcp-config`** | **0** | **0** |

The control is what makes the zero mean anything: the same harness reading the
same `system:init` envelope sees 33 tools when they exist.

## ⚠️ `--restricted` ALONE WOULD HAVE REPRODUCED #760 ALMOST EXACTLY

This is the finding worth carrying forward. `--restricted` removes exactly:

```
Bash, PowerShell, Monitor, Workflow, CronCreate, RemoteTrigger, WebFetch
```

— the command/code-runners and web fetch, as advertised. **What it LEAVES is the
#760 attack surface itself:**

```
Read, Glob, Grep          → read the user's transcripts
SendMessage, ListAgents   → enumerate and message other sessions
Task, Skill, Write, Edit  → …and act
```

plus every MCP tool (the count went *up*, 33 → 34, because the MCP tools are
enumerated individually). A labeler built on `--restricted` because the name
sounded protective would have shipped the exact defect #760 documented. **Only
`--tools ""` empties the list**, and MCP servers need `--strict-mcp-config`
separately. Neither flag substitutes for the other; both are load-bearing.

## Q4 — the #760 control, and the second surprise

A fully contained turn (tools 0, servers 0) was asked point-blank to enumerate
the machine's sessions and read transcripts.

**Containment held: nothing ran.** But the model's *output* is the interesting
part — it emitted `<function_calls>` blocks as **plain text**, inventing calls
to `glob` and `bash`, and then narrated results it never received ("the glob
searches came up empty") before concluding it had no access.

Two consequences for #758, both concrete:

1. **Never read the model's word for what it could do.** The probe's verdict is
   taken from `system:init`'s capability list, not from the sentence — which is
   why `mentionsNoTools: false` did not fail the check. An LLM claiming
   helplessness is not evidence of containment; an empty tool array is.
2. **The label is untrusted text and must be treated as such.** A labeler writes
   the model's stdout into a card label. Here that stdout contained fabricated
   tool-call markup. A transcript carrying adversarial content can therefore
   push arbitrary text into the label — so the existing trim + 120-char cap in
   `auto-label.ts` is a *security* boundary here, not just a layout one, and the
   label must never be interpreted as markup anywhere it renders. (Compare #832:
   another session's output steering *this* session's attachments.)

## The other answers

| # | question | answer |
|---|---|---|
| Q3 | Does `--restricted` refuse `bypassPermissions`? | **Yes.** Exit 1 in 156 ms: `Error: bypassPermissions not supported in restricted mode`. Help was accurate. |
| Q5 | A real label over a real transcript | **14,071 ms**, 34 turns / 24 KB excerpt → `"Plan session history feature"` — 4 words, 28 chars, inside the 120 cap |
| Q6a | Unknown model | Exit 1 in 1,610 ms, `[claude-code:unrecognized_model]`. Readable, fast, no hang |
| Q6b | A 1,500 ms deadline on a live turn | Killed at **1,534 ms**. A labeler can abandon a run |

**Latency is the cadence input: ~14 s per label.** That is far too slow to sit
anywhere near a user gesture, and entirely fine for a background pass triggered
by a turn ending. It also means the "discard if the user typed a label while it
was in flight" rule is not theoretical — 14 seconds is plenty of time to type.

## Cost and hygiene

Eight turns on `haiku`; Q3 and Q6a errored before any model call. **8 of 8
minted transcripts deleted**, and `claude agents --json` afterwards showed 5
interactive sessions, **0 of them the probe's** (nothing matching its scratch
cwd) — the probe never passes `--bg`, asserted rather than assumed.

## What this settles for #758

- The contained argv is **`--tools "" --restricted --strict-mcp-config
  --permission-mode default --model haiku`**, and every element earns its place.
- `--strict-mcp-config` is genuinely required, which **inverts the standing rule
  in `providers/claude.ts`** that it is never passed. That rule protects a
  *user's session* from losing their MCP servers; a labeler is not a user
  session and must not hold the user's tools. The guard in `claude-mcp.test.ts`
  gets the labeler module added to its bounded `EXEMPT` list **with its own
  positive test**, rather than being widened.
- `--max-turns` **does not exist** on 2.1.272. The bound is print mode + a
  timeout, and Q6b proves the timeout is enforceable.
- Fail-open is written against observed behaviour: a bad model exits 1 fast, and
  a hung turn dies to `kill()`.

## Open, and measured next rather than assumed

**How the prompt reaches the CLI.** This probe passed the 24 KB excerpt as an
**argv string** to `claude.exe` directly, and it worked. The app cannot copy
that: `providers/claude.ts`'s `resolveCliPath` finds **`claude.cmd`** on Windows,
and argv through the shim goes via `transport/win-cmd.ts`'s `execSpec`, which
**throws on double quotes and control characters** (#714) — and a transcript
excerpt is made of both. So prompt delivery is its own contract:
`probe-prompt-delivery.mjs` measures stdin against argv, through the shim as
well as the exe, before a line of the feature depends on either.
