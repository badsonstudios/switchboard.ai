# S-11 (unplanned probe) — local slash commands over stream-json

**Date:** 2026-08-02 · **Probe:** `spike/s11/probe-local-commands.cjs` ·
**Raw output:** `spike/s11/probe-local-commands.json` ·
**CLI:** 2.1.220 on PATH, owner's subscription, Windows 11.

Opened by a bug report, not by the plan: in Direct mode `/usage` displayed
**nothing** in the session window, though the turn plainly completed (the
done-sound played). `/startup` and `/clear` worked; so did ordinary prompts.

**This is not probe 2.** The planned probe 2 is plan mode + `ExitPlanMode` and
is still unstarted. This one is filed beside it because it answers a question
that was in nobody's list.

---

## The hypothesis was wrong, and the wrong answer was the useful one

The obvious reading — *`/usage` is drawn by the TUI, so over stream-json there
is nothing for a host to render, and under amended P7 we may not fake it* —
would have been a comfortable, principled, **incorrect** conclusion, and it was
the one this probe was written to confirm.

**What the CLI actually emits for `/usage`:**

```
system:init -> assistant -> result:success
```

An entirely ordinary turn. The `assistant` message carries the full text —
"You are currently using your subscription… Current session: 2% used · resets
Aug 2, 11:49am…" — and `result.result` repeats it. `/cost` and `/context`
behave identically (`/cost` and `/usage` return byte-identical text; they are
the same command). A plain prompt differs only by a `rate_limit_event`.

**Nothing is withheld. The CLI hands us the output in the most ordinary shape
it has.**

## So why did the session window show nothing?

Because the Feed does not read the stream yet — it reads the **JSONL
transcript** (E18-10 / #140 changes that, and had not landed). And the two
sources do not agree about what a local command is.

What the same turn writes to `~/.claude/projects/<slug>/<uuid>.jsonl`:

| entry | notes |
|---|---|
| `user` (`isMeta: true`) | the `<local-command-caveat>` preamble |
| `user` | `<command-name>/usage</command-name>…` — the invocation |
| **`system`** | `subtype: "local_command"`, `level: "info"`, `isMeta: false`, and the OUTPUT in `content`, wrapped in `<local-command-stdout>…</local-command-stdout>` |

**There is no `assistant` entry at all.** A plain prompt in the same session
wrote one normally (`assistant` / "OK"), which is exactly why plain prompts
render and this does not.

⇒ **The output arrives as `assistant` on the stream and as
`system:local_command` in the transcript.** Our Feed renders the transcript's
assistant/user/tool blocks and has never handled `system:local_command`, so the
text is dropped on the floor.

## Why each of the owner's observations follows

- **`/usage` shows nothing** — the above.
- **The done-sound plays** — `result` arrives normally; the turn really did
  complete. The completion signal and the content travel by different routes,
  and only one of them was broken.
- **`/startup` works** — a skill is not a local command. It expands into a real
  prompt and produces a real `assistant` turn, which the transcript records.
- **`/clear` works** — switchboard handles it itself (`SessionStart` mints a new
  conversation and we draw the cleared divider); it never depended on this path.
- **It looks like a Direct-mode bug and is not one.** The Feed drops
  `system:local_command` in **both** transports. In Terminal mode the CLI also
  draws the output in the terminal, so the gap was invisible. **Direct mode did
  not break this; it removed the surface that was hiding it.**

## What this means for the epic

1. **#140 (E18-10, Feed from typed messages) fixes it** — it moves the Feed onto
   the stream, where this text is an ordinary `assistant` message. It is the
   next item, and this is now a named case in it rather than a hoped-for
   side effect.
2. **There is a smaller fix that helps both transports today**: render
   `system:local_command` from the transcript, stripping the
   `<local-command-stdout>` wrapper. Worth doing if #140 slips, and cheap.
3. **A caution for the transcript stack generally.** The migration's cost case
   rests on "the JSONL transcript survives the transport change untouched"
   (S-10). It does — but this is the first measured case where **the transcript
   is strictly poorer than the stream**, not merely slower. Anything relying on
   the transcript as a faithful record of what the user saw is relying on
   something that was never quite true.

## Method note

Two false conclusions were available and both were avoidable by looking:

- *"the CLI keeps this display for itself"* — refuted by the stream transcript
  above, in one run.
- *"a local command writes nothing to the JSONL"* — also wrong. It writes three
  entries; they are simply not the entry anyone was looking for.

Neither could have been settled by reasoning about the design. Both took one
probe and one `grep` of a transcript.
