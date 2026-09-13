# #790 — `continued-in`: what the CLI declares, and what four probes could not make it write

**Issue:** #790 · **Probes:** `spike/probes/790/` · **Measured:** 2026-09-13,
`claude` **2.1.261** on PATH, Windows 11, Node 22.20.0.
**Cost:** two trivial turns. Backgrounding an idle session spends nothing — that
is itself one of the measurements below.

**Verdict in one line: the record's shape and trigger are the CLI's own
declaration, not a capture — four CLI-driven variants failed to produce one, and
the negative results are what narrow the trigger to a gesture a person makes
inside a session, which is exactly the case switchboard hosts.**

---

## The questions

| # | question | answer |
|---|---|---|
| Q1 | What does a `continued-in` line contain? | **Four fields**, from the CLI's own factory (§1) |
| Q2 | What writes one? | The **background-session module**; telemetry `repl_background_fork` (§2) |
| Q3 | Does `--bg` with `--resume` write one? | **No** — it keeps the same id, so there is no successor to name (§3) |
| Q4 | Does `--bg --fork-session`? | **No** (§3) |
| Q5 | Does the documented "starts a copy" case? | **No** — a new id was minted and no record was written (§3) |
| Q6 | Does `claude stop`? | **No** (§3) |
| Q7 | Is it really `last-wins`, as #790 said? | **No — `boundary-cleared`.** The ticket was wrong (§4) |
| Q8 | Does the CLI itself treat the predecessor as dead? | **Yes** — `/resume` marks it `superseded` (§5) |
| Q9 | Does it occur in this machine's corpus? | **Zero**, re-confirmed independently (§6) |

---

## 1. The shape, from the CLI's own factory

```js
function BXn(e,t){return{type:"continued-in",timestamp:new Date().toISOString(),
                         sessionId:e,continuedInSessionId:t}}
```

Four fields, and the direction is the thing worth writing down: **`sessionId`
names the session being LEFT** and `continuedInSessionId` names the successor. A
reader that takes `sessionId` as "the session this line is about" gets it exactly
backwards.

The **reader-side** zod schema in the same module is looser than the writer:

```js
it({type:R("continued-in"),continuedInSessionId:s()})
```

Only `type` and `continuedInSessionId` are required. So the CLI itself does not
depend on `sessionId` or `timestamp` being present, and neither should we —
`absorbContinuation` reads only the two the schema guarantees.

## 2. What writes one, and why that makes it OUR problem

The writer lives in the background-session module and its own failure log says so:

```js
async function $Xe(w,P,ne,me){ … await SE(w,BXn(fe,Se),me,{onlyIfExists:!0})
  .catch(Te=>n(`[bg] continued-in record not written: ${l(Te)}`,{level:"warn"})) }
```

Two live call sites in that module. The telemetry event beside them names the
trigger: **`repl_background_fork`**, fired on `xe==="left_arrow"`. A `keepParent`
option suppresses the write, and it is written with `onlyIfExists`.

⚠️ **`$Xe` is a reused alias.** The binary has at least four unrelated `$Xe`
definitions in different module scopes (an HTML helper, a cache-invalidation
predicate, …). `docs/reference-implementations.md` warns that short names are
only unambiguous inside their own module; that warning is load-bearing here, and
the three sites quoted above were confirmed to share a window with the
definition rather than merely matching the name.

**The consequence for switchboard.** This is not an exotic storage detail — it is
a gesture a person makes in a session they are sitting in. In our product that
session is a card. The user backgrounds the conversation, the CLI moves it to a
new file, and the watcher goes on tailing the old one: the Feed stops updating,
the card still looks alive, and nothing says why.

## 3. ⚠️ Four variants, four negatives — and the CLI explains the first one itself

| variant | result |
|---|---|
| `--resume <id> --bg` (idle session) | **no record** |
| `--resume <id> --bg --fork-session` | **no record** |
| `--resume <id> --bg` while it is already running (the documented "starts a copy") | **no record** |
| `claude stop <id>` | **no record** |

The first is explained by the CLI's own output rather than by inference:

```
backgrounded · 7b6d4e3c (idle — send a prompt to start)
```

— the **same short id the parent had**, exactly as `--help` says: with
`--resume`, `--bg` "continues that session in the background **under the same
ID**". No new id means no successor to name.

The third is the interesting negative, because the CLI announced that it did the
thing the help text says should produce a copy:

```
note: session 8a8b5428 is already running in the background, so this started a
copy as 34744c4d. `claude attach 8a8b5428` opens the original.
```

A genuinely new id — and still nothing in the parent transcript. The new job's
`~/.claude/jobs/<short>/state.json` shows why the record would have been
premature: its `resumeSessionId` is **its own** new id, so no history had been
copied yet at spawn time.

**What is NOT proven:** the `left_arrow` REPL gesture itself. It is guarded by
editing-quiet windows, an attach-confirm gap, human-cadence checks and a
"not-solo" rejection (all visible in the binary as `tengu_left_arrow_blocked`
reasons), so driving it through node-pty is a probe of its own — and one where a
false negative is the likely outcome, which is the trap #760 §7 records. It was
not attempted, and this note says so instead of calling the `--bg` variants
equivalent.

## 4. ⚠️ The ticket said `last-wins`. The CLI says `boundary-cleared`.

#790's own text states that "the CLI's own routing table marks it `last-wins` —
the newest one is the current answer", and reasons from that to the successor
being the same session continuing. The table says otherwise:

```
"last-prompt":"boundary-cleared","continued-in":"boundary-cleared",
"marble-origami-commit":"boundary-cleared", …
summary:"last-wins","custom-title":"last-wins","ended-by-model":"last-wins",
"ai-title":"last-wins",tag:"last-wins",relocated:"last-wins", …
```

`continued-in` sits with `file-history-snapshot`, `last-prompt` and the
`marble-origami-*` family, not with the latches. The second table (the one #779
used) routes it under `"always"`.

Nothing in the fix depends on this — a tail reader acts on arrival and has no
opinion about reduction — but the premise was being inherited and is now
corrected. **`boundary-cleared` means the record does not survive a compaction
boundary**, which is close to the opposite of "the newest one is durable".

## 5. The CLI already treats the predecessor as finished

```js
if(o.continuedInSessionId!==void 0){ if(M.continuedInSessionId=o.continuedInSessionId,
  await s_n(e.fullPath,o.continuedInSessionId,r)) …, M.superseded=!0 }
```

A session carrying a `continuedInSessionId` is marked `superseded` and filtered
out of the `/resume` picker — after a check that the successor actually exists.
The watcher's conclusion ("stop reading this file") is the same one the CLI
reaches about the same fact, which is the strongest evidence available short of
capturing a live record.

## 6. Zero in the corpus, re-confirmed

`"type":"continued-in"` appears **0 times** across `~/.claude/projects`
(~3,300 transcripts, ~246,000 lines). #779 reported this and it was re-measured
here rather than quoted — a zero is the one result cheap enough to re-derive and
expensive enough to be wrong about.

---

## What this changes

| item | change |
|---|---|
| #790 | The `last-wins` premise is **wrong** (§4); the trigger is a REPL gesture, not a resume artifact (§2); `sessionId` names the session being LEFT (§1); the shape is a DECLARATION, and the source says so where the next reader will see it |
| schema.ts | `continuedInSessionId` becomes **consumed** and **stays type-scoped**. Moving it to the flat root list would allow the name on all 38 types — #779's own mistake, and worse for a consumed key than an ignored one |
| `claim()` | Now refuses a file the session has ABANDONED — see §7. A property `resetBinding` had asserted in a comment since #129 with nothing enforcing it |
| `drain()` | A mid-slice guard: a line can now change the binding while the slice is still being read, which the hooks path could never do |

## 7. ⚠️ Three defects the fix itself contained, all found in review and all measured

Recorded because the pattern is now six items long and the value is in the
*shape* of what keeps getting missed — not in the individual bugs.

**A record in a DYING session's last unread bytes wiped the dead card.**
`noteSessionExited` drains `Infinity` **before** `maybeQuiesce`, so the
`w.quiesced` guard that protects a corpse's Feed is not yet armed when that
drain runs. Measured: the dead card was blanked, its remaining tails lost their
final drain (`resetBinding` clears `w.tails` while `noteSessionExited` iterates
it), and the corpse then **bound the successor and streamed a live conversation
into an exited card**. The gate is `exitedAt`, not `quiesced` — the two differ by
exactly one window, and that window is the one that bites. (`quiesce()` itself is
safe: it latches before draining.)

**Two transcripts pointing at each other rebound for ever.** Measured at ~30
resets/second under a 25 ms poll, never converging, firing `sessions:feedReset`
every pass — a permanently blanking Session view plus a busy main thread.
`w.abandoned` did not prevent it because `claim()` never consulted it; only
`isEvidence` did. Harmless for the pre-existing causes (a mis-bind and a `/clear`
never reinstate the old id) and fatal for this one, which moves the id under our
feet. Now bounded at two hops.

**The rebind silently no-opped when the snapshot had no native id.**
`setNativeSessionId` unbinds only when it can SEE the id move —
`w.snap.nativeSessionId && w.snap.nativeSessionId !== nativeId`. A transcript
whose head is unparseable binds by FILENAME and leaves that undefined, and §1's
schema does not oblige the record to carry a `sessionId` either. So the id was
installed, nothing unbound, and the watcher kept tailing the finished file —
**#790's own freeze, inside #790's fix**, in a sub-case the CLI's schema permits.

**And one claim in the first draft of the fix was simply wrong.** A comment
asserted that a continuation "deliberately leaves `conversationStarted` set, so
the session lands in `searching`, not `awaiting-prompt`". `conversationStarted`
is only ever set by `noteConversationStarted`, so a restored card that bound
without a turn has it false and the continuation *does* land there. The cost is
real but small (the fast discovery ladder, not the hunt) and is now written down
as such instead of denied. #779's lesson, again: **a plausible-sounding comment
nobody measured is worse than a missing one.**

## What is NOT proven

- **The `left_arrow` REPL gesture was never driven** (§3). Everything about the
  on-disk record is the CLI's declaration.
- **`keepParent`** — what sets it, and therefore how often the record is
  suppressed even when the conversation does move.
- **Whether the successor is always in the same project directory.** The fix
  does not assume it is: it installs the successor id and lets ordinary
  discovery find the file, which is the same path a hooks-delivered id takes.
- **What the card's PTY shows** after its conversation is backgrounded. The
  watcher follows the conversation; whether the terminal half still makes sense
  to the user is a UX question this item did not open.
