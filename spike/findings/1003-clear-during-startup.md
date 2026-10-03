# #1003 — "I had to clear the conversation twice"

**Date:** 2026-10-03 · **CLI:** 2.1.288 (PATH), Windows 11 ·
**Probe:** `spike/probes/1003/probe-clear-on-resume.mjs` — real CLI, 9 trials ·
**Evidence:** the report's own diagnostic bundle (v0.8.101, attached to the
issue)

## 1. What the report's log says

One card, one conversation, 18 seconds:

| time | log line |
|---|---|
| 12:25:34.5 | session created, `--resume`, **996 entries replayed into the Feed**; status `starting → idle (transport-ready)` |
| 12:25:39.8 | `idle → working (prompt-sent)` — **the first Clear, 5.2 s after the spawn** |
| 12:25:41.4 | `working → idle (hook:SessionStart)` — and **no** `stream feed reset`, **no** transcript rebind |
| 12:25:50.5 | `idle → working (prompt-sent)` — the second Clear |
| 12:25:50.9 | `stream feed reset` · rebind `d4ef → 4dd4` · `hook:SessionStart` |
| 12:25:51.7 | `stream:result:success`, then a **second** `stream feed reset` · rebind `4dd4 → fc06` |

Three conversation ids for two presses. **The CLI ran both clears, back to
back, after the second one was sent.** The first was not lost and was not
ignored by the app: nothing came back for it to act on.

The hook at 12:25:41 cannot have been `SessionStart source:'clear'`. That one
carries a new conversation id, and the watcher logs a rebind the moment it
sees one (`transcripts/watcher.ts`). It logged none until 12:25:51. So it was
the session's own **start-up** hook (`source:'resume'`) — arriving 6.9 s after
the spawn, and 1.6 s after the first Clear.

The same log has four other first-clears on freshly resumed cards on that
machine. Send → reset took **1.7 s, 3.7 s, 4.3 s and 26.2 s**. On a card that
had been open a while it is 20–50 ms.

## 2. The question

Is a prompt written while the CLI is still starting dropped, or queued? And
does the app say anything while it waits?

## 3. Measurement

Seed a conversation (`say ok`), stop, respawn with `--resume <id>` and the
app's own argv, then send `/clear` at `WAIT_MS` and again `GAP_MS` later.
`HOOK_DELAY_MS` holds every hook open, which is how a ~1 s start-up on this
machine is stretched to the length the report's machine showed.

| `WAIT_MS` | `HOOK_DELAY_MS` | first `/clear` sent | start-up ended | first `conversation_reset` | trials |
|---|---|---|---|---|---|
| 5000 | 0 | after start-up | 0.6 s | **184 ms** after the send | 1 |
| 0 | 0 | before start-up | 0.7–1.7 s | 0.9–2.0 s after the send, **211–317 ms after start-up ended** | 2 |
| 300 | 0 | before start-up | 0.65–0.67 s | 0.57–0.65 s after the send, **235–322 ms after start-up ended** | 2 |
| 2500 | 4000 | **during** start-up | 4.7 s | 2.3 s after the send, **204–221 ms after start-up ended** | 2 |
| 2500, second at 7500 | 12000 | both **during** start-up | 10.7 s | none in the gap; then **two**, back to back, the first 151–161 ms after start-up ended | 2 |

The last row is the report. Its timeline, milliseconds from the spawn:

```
   590  hook_started            (SessionStart, resume)
  2517  → /clear
  7521  → /clear
 10742  hook_response           start-up ends
 10893  conversation_reset      c70c → d766      first clear runs
 10952  SessionStart(clear)
 21053  result
 21078  conversation_reset      ffa6 → f3d4      second clear runs
 21139  SessionStart(clear)
 31246  result
```

`reset → SessionStart(clear) → result → reset` is the log in §1, frame for
frame. **2 of 2.**

## 4. What that means

- **Queued, never dropped.** In 8 of 8 trials a `/clear` written before or
  during start-up ran 151–322 ms after start-up ended. (The ninth trial sent
  it after, as the control.)
- **The delay is the start-up, not the clear.** A resumed conversation takes
  the CLI as long to load as it takes; on the report's machine that was 5–30 s.
- **The app said "ready" the whole time.** `transport-ready` promotes a stream
  session to `idle` at the spawn (`state-machine.ts` explains why: stream mode
  has no start-up frame of its own). So the Clear button was live, and when
  the start-up hook landed it answered `working` with `idle` — a card that
  read "ready" with the user's `/clear` still outstanding. They pressed again.

## 5. What was changed, and what was not

**Changed:** `SessionStart` with `source: 'startup' | 'resume'` no longer moves
a `working` session to `idle`. That early, `working` can only be our own
`prompt-sent`. The card keeps its "Claude is working" strip until the queued
command actually finishes.

**Not changed, on purpose:**

- **The second press is not swallowed.** Two clears is harmless — the second
  clears an already-empty conversation — and de-duplicating sends is a
  different feature with its own ways to be wrong.
- **`transport-ready` still means the spawn succeeded.** Holding the card at
  `starting` until the start-up hook lands would be the fuller answer, and it
  makes the hook listener load-bearing for readiness: a lost hook would leave
  a card unusable for ever. That is a design decision, not a bug fix.

## 6. What is NOT established

- **The report's machine was not measured.** The mechanism is reproduced with
  an artificially slow hook; that its 9.5 s wait was the same start-up is read
  off its log, not observed. What it was waiting ON after its start-up hook had
  already fired is not known — more hooks, the bus's MCP server connecting,
  and antivirus on every spawn are all candidates.
- **CLI 2.1.280 was not tested.** That is what the report's machine was writing
  transcripts with; this is 2.1.288.
- **The second send may have mattered.** In §1 the reset came 456 ms after the
  second Clear. That is consistent with start-up ending just then, and equally
  with the second write waking something. Nothing here distinguishes them: in
  every trial the first clear ran on its own, but no trial waited longer than
  12 s.

So the issue stays open until it is re-tested on that machine.
