# S-11 addendum — the slash-command bug was OURS, and the stream's message shape is not what we assumed

**Date:** 2026-08-02 · **Probe:** `spike/s11/probe-140-slash-flags.cjs` ·
**Raw output:** `spike/s11/probe-140-ours.json` ·
**CLI:** 2.1.220 on PATH, owner's subscription, Windows 11.

Opened by a hand-test, not by the plan. Dan on PR #163 (P2-E18-10, the Feed from
typed messages):

> *"/usage does not work, nor does /agents, /model, etc. It seems like NONE of
> the slash commands work [in a Direct session]. These do work in terminal mode.
> All the other manual tests listed in the PR worked for me, other than the
> slash commands."*

Both a unit test and an end-to-end test asserted the opposite — against the
fake. Same shape as #153, #154 and #139: **the fake passed and the real thing
did not.**

---

## 1. The CLI was innocent, and that took one run to establish

`probe-local-commands.cjs` had already measured `/usage` working over
stream-json. The one thing it did NOT reproduce was our **argument list** — it
spawned with four flags where `providers/claude.ts` uses seven. That was the
obvious suspect and it was wrong.

Run with our exact recipe (`--output-format stream-json --verbose --input-format
stream-json --permission-prompt-tool stdio --replay-user-messages
--include-partial-messages`):

| command | sequence | renderable text? |
|---|---|---|
| `/usage` | `system:init -> assistant -> result:success` | **yes** |
| `/cost` | same | **yes** |
| `/context` | same | **yes** |
| `/model` | same | **yes** — "Current model: Fable 5 / Usage: /model <name>…" |
| `/agents` | same | **yes** — "The /agents wizard has been removed…" |

**Every local slash command answers with an ordinary `assistant` message
carrying its full output. Nothing is withheld, so P7 has nothing to say here** —
there is no CLI-kept display we would have to either rebuild or say goodbye to.
(`/agents` is the interesting one: the wizard this project assumed was an
interactive chooser *no longer exists*. The CLI says so in prose and points at
the files.)

## 2. So it was ours: the composer never sent them

Measured through the **real app driving the real CLI** (a temporary Playwright
diagnostic, since a probe cannot reach our own renderer):

```
draft after ONE Enter:        "/usage "     <- not sent; the popup completed it
draft after Escape + Enter:   ""            <- sent, and the output rendered
```

The autocomplete popup claimed **Enter** to confirm a completion. Typing a
command **in full** and pressing Enter therefore replaced `/usage` with
`/usage ` and ran nothing — and because the text it produced was the text
already on screen, the keystroke looked like the app ignoring you. A second
Enter worked. Terminal mode "worked" because a slash command there is typed into
the TUI, which has its own completion and runs on the first Enter.

**Not a Direct-mode bug at all** — the composer is transport-agnostic, so it was
equally broken for PTY sessions. Direct mode only removed the terminal you could
fall back to. (The same sentence as the original `/usage` finding, about a
different defect, one layer up.)

### The part worth keeping

**Our own e2e hit this and worked around it.** The `/usage` test pressed Escape
before Enter "to dismiss the popup", and the PR's hand-off instructions told Dan
to do the same. A test taught to perform the unnatural keystroke cannot notice
the natural one failing. The workaround was written the same hour the bug was.

## 3. The stream's message shape is NOT one message per turn

Found while reading the probe output for something else, and it invalidates an
assumption `stream-feed.ts` was built on. On **three separate turns**, identical
every time:

```
message_start
content_block_start(index 0, thinking) -> delta.. -> ASSISTANT -> content_block_stop(0)
content_block_start(index 1, text)     -> delta.. -> ASSISTANT -> content_block_stop(1)
message_delta -> message_stop -> result:success
```

Two facts, both load-bearing:

1. **One `assistant` message PER CONTENT BLOCK**, not one per turn — and each
   carries a **single-element `content` array**, so *every one of them reports
   content index 0* while the `stream_event`s that built them were addressed
   0, 1, 2…
2. **It arrives MID-STREAM**, before its own `content_block_stop` — not after
   `message_stop`, which is where the tidy reading puts it.

A host that reconciles purely on content index therefore lines up the first
block and **appends a duplicate of every block after it**. Ours did. It survived
review and a full test suite because the fake sent all deltas and then one whole
message — the kinder, wrong shape.

Two smaller notes from the same runs:

- `system:thinking_tokens` exists and arrives between deltas (an estimate, not
  content).
- A real thinking block's `thinking` is often **empty**, carrying only a
  `signature`. The assistant message for it therefore claims nothing, and must
  not be allowed to retire the text block that follows.

## 4. What changed as a result

- The composer: when the typed token **is** the command, Enter **runs** it. Tab
  still completes, so a command taking arguments is one keystroke away.
- `StreamFeed`: reconcile by index **first**, then by kind among the blocks the
  deltas opened — which is shape-agnostic across both layouts.
- **The fake now emits the measured shape**: a thinking block, one assistant
  message per content block, mid-stream, and a bare
  `system:init -> assistant -> result` for a local slash command. Its old shape
  is what let both defects through.
- The e2e types `/usage` and presses Enter **once**, and asserts the popup is
  genuinely open first — an earlier version of that assertion matched the
  textarea's own value and would have passed with no popup at all.

## Method note

Two false starts were available and both were cheap to avoid by measuring:

- *"our extra flags must be breaking slash-command parsing"* — the obvious
  reading, given the probe/adapter difference. Refuted in one run.
- *"the CLI keeps `/model` and `/agents` for itself, so P7 forbids rendering
  them"* — the comfortable, principled, **wrong** answer. Refuted in one run.
  This is the second time on this exact subject that the P7-shaped conclusion
  was the one the evidence rejected.
