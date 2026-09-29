# #978 — local slash commands on the stream, re-measured

**Date:** 2026-09-29 · **Probe:** `spike/probes/978/probe-local-commands.mjs` ·
**CLI:** 2.1.280 on PATH, owner's subscription, Windows 11 ·
**Supersedes:** `s-11-local-slash-commands.md` (2026-08-02, CLI 2.1.220) on the
stream side; that note's transcript findings still hold verbatim.

**Headline: the capability already works, and the issue that says otherwise was
filed 2h12m before the change it blames.** What is broken is everything that
tells the user it does not work — the in-app release notes, the manual, and a
`test.fixme` left as a placeholder.

---

## What the CLI emits, spawned the way switchboard spawns it

Four turns in one real session with the app's verbatim flag list
(`--output-format stream-json --verbose --input-format stream-json
--permission-prompt-tool stdio --replay-user-messages
--include-partial-messages`): `/usage`, `/cost`, `/context`, and a **plain
prompt as a control**.

The control matters and is not ceremony. S-11's own method note warns that the
available false conclusions here are reached by reasoning rather than looking;
without a control turn, "the local command produced no text" cannot be told
apart from "the probe never worked", and the second is the more likely of the
two. The control returned its token.

| turn | frames | assistant text |
|---|---|---|
| `/usage` | `system:init` · `assistant` · `result:success` | 1,043 chars |
| `/cost` | `system:init` · `assistant` · `result:success` | 1,043 chars, **byte-identical to `/usage`** |
| `/context` | `system:init` · `assistant` · `result:success` | 3,035 chars |
| plain prompt (control) | `system:init` · `system:status` · `user` · `stream_event` ×7 · `assistant` · `rate_limit_event` · `result:success` | the control token |

**Two differences from an ordinary turn, both of which matter to a consumer:**

* **No `user` echo.** `--replay-user-messages` is on, and a local command is
  still not echoed. Anything keyed on "the CLI acknowledged my send" will not
  fire for these.
* **No `stream_event` at all.** No `message_start`, no deltas. This is the one
  turn shape where the assembler has nothing streamed to reconcile against —
  the `assistant` message is the first and only carrier of the text.

## The assistant frame, and what is new since 2.1.220

```jsonc
{
  "type": "assistant",
  "message": {
    "model": "<synthetic>",
    "role": "assistant",
    "stop_reason": "end_turn",
    "usage": { "input_tokens": 0, "output_tokens": 0, … },
    "content": [{ "type": "text", "text": "You are currently using your subscription…" }]
  },
  "parent_tool_use_id": null,
  "local_command_source": "<local-command-stdout>…</local-command-stdout>",
  "local_command_run": { "command": "usage", "args": "" },
  "usage_report": { "session": {…}, "rate_limits": {…} }
}
```

**`local_command_source` and `local_command_run` did not exist when S-11 ran.**
The CLI now states outright that the turn was a local command, and hands over the
raw `<local-command-stdout>` wrapper *alongside* the unwrapped text — so a
consumer no longer has to infer it from `model: "<synthetic>"` or from the
absence of deltas.

**`stream-feed.ts` reads both as of this item** (`wasNeverStreamed`), together
with `<synthetic>` as the older and broader fallback — see "the part that was
actually broken", below. The breadth of `<synthetic>` was checked against the
2.1.280 binary rather than reasoned about: it appears in exactly three assistant
builders (a `PushNotification` tool_use, a `"(no content)"` text message, and one
generic), and all three construct their `content` inline, so none can be the
completion of a token stream. `local_command_source` has one builder, which the
CLI's own schema calls *"the local-command twin"*.

`/cost` is **rewritten to `/usage` by the CLI itself** — a `/cost` turn writes
`<command-name>/usage</command-name>` into the transcript. S-11 guessed they were
"the same command"; they are, and the transcript says so.

## The transcript still disagrees, and is still the poorer side

Unchanged from S-11, re-confirmed on 2.1.280. One `/usage` turn writes:

| entry | notes |
|---|---|
| `queue-operation` ×2 | the raw typed text, then an empty one |
| `user`, `isMeta: true` | the `<local-command-caveat>` preamble |
| `user` | `<command-name>/usage</command-name>…` |
| `system`, `subtype: "local_command"` | the output, in `<local-command-stdout>` |

**Still no `assistant` entry.** So S-11's caution stands and is worth restating:
the transcript is not a faithful record of what the user saw, and on this turn
type the stream is strictly richer — now by two labelled fields rather than one
message.

## Why it renders today — three links, each measured separately

1. **The frame arrives.** The probe above.
2. **It derives.** The captured frame, fed verbatim through `deriveIntents`
   with the real display caps, yields exactly one `assistant` prose block
   carrying the output. Nothing filtered it: there was no `<synthetic>` check
   anywhere in the feed path, and the frame carries no `isMeta`. Pinned by
   `stream-feed.test.ts` against the fixture in
   `src/main/feed/fixtures/local-command-frame.ts`.
3. **It renders.** `e2e/stream.spec.ts` → *"a local slash command's output
   renders (#156)"* types `/usage` into the composer and asserts `.feed-md`
   shows the output. It passes on `main` **unmodified** — it was not touched by
   this item and did not need to be.

## The part that was actually broken

**#978 was created 2026-09-27T17:08Z. #952 merged 2026-09-27T19:20Z.** The
sentence *"since #952 it does not work anywhere"* was a prediction about a change
still in flight. What #952 really did was set `e2e/feed.spec.ts`'s local-command
test to `test.fixme` — and that test asserts the **transcript**-driven Feed
renders `system:local_command`, which is the mechanism #952 deleted on purpose
and which `watcher.ts`'s `deriveFeed: 'sidechains'` early-return now skips for
the bound file by design. It can never pass again, and it should not.

**A placeholder became evidence.** The `fixme` was read as "the capability is
missing" rather than "this test measures a mechanism we removed", and from there
it reached the issue tracker, the manual, and — through the in-app update dialog,
which serves every release body newer than the running build — every user.

The generalisable lesson is not about slash commands. **A disabled test states a
claim about the product, and `test.fixme` states the strongest one available:
"this does not work."** Deleting a test that measures a deleted mechanism is a
smaller lie than leaving it disabled with a ticket number on it.

## …and the bug that WAS there, which nobody had reported

Looking at the turn shape rather than the symptom turned one up. A local command
emits no `message_start`, no deltas and **no `message_stop`** — so it never
reaches `endMessage`, which is the only thing that CLEARS `StreamFeed`'s assembly
map. `finalize` deliberately does not (#154: an interrupted turn's `assistant`
can arrive after its own `result`).

If anything is still in that map, `claim()`'s index-miss fallback hands it over —
the fallback takes ANY open block of a superseding kind, because the real CLI
reports content index 0 on every `assistant` message of a multi-block turn. The
local command's text then **replaces that block's text in place, at the same
seq**: text the user has already read, silently overwritten. Fixed by
`wasNeverStreamed`; revert-proof run (removing the guard fails exactly the two
tests that describe it, and no others).

⚠️ **THE PRECONDITION IS UNMEASURED, AND SAYING SO IS THE POINT.** The bug needs
an *orphan* in the map — a streamed block no `assistant` message ever claimed.
The obvious way to make one is to interrupt a reply, but this repo's own #154
finding is that an interrupted turn's `assistant` message **does** usually
arrive, which would claim the block and empty the map. So the guard is correct on
the class's contract (`claim()`'s own comment allows for an orphan) while how
often a user can actually trigger it is **not established**. The dogfood row says
so rather than promising a repro, and the CHANGELOG describes the condition
instead of asserting the symptom — which is the same failure mode this whole item
exists to clean up after.

## Method note

Two things this probe got right only because they were built in deliberately:

* **The control turn.** Without it the run says "three local commands produced
  no user echo and no deltas", which reads exactly like a broken harness.
* **Raw frames, not just a summary.** The first run reduced each turn to text
  lengths and frame-type counts, which was enough to say the text arrived and
  not enough to say whether it arrived in a shape our derivation accepts.
  `local_command_source` and `local_command_run` — the only genuinely new facts
  here — were invisible until the raw frame was dumped.

And one it got wrong: the first run reported `closedByResult: false` for four
turns that all ended in a clean `result`, because the frame-type key is
`result:success` and the check read `types.result`. Caught by reading the output
against the frame list, not by the probe noticing. **A probe's own reporting is
not evidence until it has been checked against its raw data.**
