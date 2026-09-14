# E11 / #787 — `cost-state`: the CLI's own cost accounting

**Date:** 2026-09-14 · **Probe:** `spike/probes/787/probe-cost-state.mjs`
**Corpus:** 3,210 transcripts / 243,649 lines under `~/.claude/projects`
**CLI:** PATH binary 2.1.270 (`claude.exe`, win32-x64); corpus lines written by
2.1.261.

---

## 1. The headline: it is an EPITAPH, not a live readout

The ticket asked for this to be checked "before designing a pane around them,
because *the CLI's number* is worth much less if it only lands after the session
closes." It does.

**From the CLI's own code.** The builder for the line is registered with
`exitReStampProviders.add(...)`, drained by `appendOwedEntryAtExit(...)`. Its
only other two call sites are the `conversation_reset` path (`/clear`) and the
fork/resume path. **There is no periodic writer and no per-turn writer.**

**From the corpus.** 22 of 3,210 transcripts carry a `cost-state` line, and in
**22 of 22 it is the LAST LINE of the file.** Two of the 22 carry a *pair* —
the #790 probe transcripts, written 108 ms apart with `mode` and
`permission-mode` latches between them, which is a teardown flush superseding
itself, not a periodic sample.

> **Consequence for the design.** `cost-state` cannot *replace* the estimate,
> which is how the ticket was worded. It can only *supersede* it once a session
> ends. Anything built on it has to keep both numbers and say which it is
> showing — which is why `costLine` exists and why the strip has three tooltips.

## 2. The estimate it supersedes was wrong by 2.4×, in both directions

Measured against the CLI's own per-model `costUSD`:

| model | shipped table (pre-#787) | true | our error |
|---|---|---|---|
| `claude-opus-5` | $15 / $75 | **$5 / $25** | **2.0–2.8× TOO HIGH** |
| `claude-fable-5-1` | *(no row — fell through to sonnet)* | **$10 / $50** | **2.6–3.0× TOO LOW** |
| `claude-haiku-4-5` | $0.8 / $4 | $1 / $5 | slightly low |
| `claude-sonnet-5` | $3 / $15 | $2 / $10 | high |

**The control that says the method was sound and only the numbers were stale:**
one real haiku session with `webSearchRequests: 0` reconciles against the CLI's
own `costUSD` at ratio **1.0000** — exact, to six decimal places
(442,414 in + 6,441 out ⇒ $0.474619, both ways). The four haiku rows that *do*
have web searches are short by exactly `$0.01 × webSearchRequests`, which
isolates that constant rather than fitting it.

**A residual remains and it is one-directional.** Opus reconciles at 0.91–0.97
of the CLI's figure and Fable at 0.79–0.86 — always *under*, never over. That is
the `ephemeral_5m` / `ephemeral_1h` cache-write split DESIGN §5.13 already names:
the CLI sees the per-request breakdown, the transcript does not carry it, so
every cache write is priced at the cheaper 5m rate. **The estimate is therefore
structurally a floor**, and is labelled as one.

## 3. Three facts the ticket's field list did not have

1. **`modelUsage[m].costUSD` exists**, and is *required* in the CLI's zod
   schema. `sum(modelUsage[*].costUSD) === totalCostUSD` **exactly, 22/22** —
   a free invariant, asserted in the parser's tests to prove the fixture is real.
2. **`hasUnknownModelCost` is `.optional()`.** The ticket describes it as a
   plain field. Absent ≠ `false`: "this CLI did not say" is a different claim
   from "I priced every model I used". It is preserved as three states, not
   flattened — the #776/#785 lesson in a new place.
3. **`thinkingTokens` is optional too**, per model. Carried through for #789.

The CLI's schema, for the record:

```js
nt({ type: xu("cost-state"), sessionId: le(),
     totalCostUSD: e, totalAPIDuration: e, totalAPIDurationWithoutRetries: e,
     totalToolDuration: e, totalLinesAdded: e, totalLinesRemoved: e,
     totalDuration: e, startTime: e,
     modelUsage: gm(le().regex(/^[^\p{Cc}\p{Cf}]+$/u),
       nt({ inputTokens: e, outputTokens: e, thinkingTokens: e.optional(),
            cacheReadInputTokens: e, cacheCreationInputTokens: e,
            webSearchRequests: e, costUSD: e })),
     hasUnknownModelCost: Io().optional() })
// where e = Zt().nonnegative().finite()
```

Every numeric is **non-negative and finite**. `cost-state.ts` holds to the same
contract and rejects the whole line otherwise — a partial parse is not a cheaper
cost figure, it is a wrong one, and it would be wrong in the under-reporting
direction while still claiming to be the CLI's exact number.

## 4. The keys are type-exclusive — measured, not assumed

All ten payload keys appear on `cost-state` lines and **nowhere else**: 24
occurrences across 243,649 lines, zero on any other type. That is what licensed
moving them out of the root `ignored` list (94 keys → 84) into
`TYPE_SCOPED_ROOT_KEYS['cost-state']`, on the precedent #790 wrote down: the
drift detector treats `consumed` and `ignored` identically, so the root list's
only effect is to make a name legal on all 38 line types — which matters *more*
once we render the value as money.

## 5. ⚠️ "LAST LINE OF THE FILE" IS A MEASUREMENT, NOT AN INVARIANT

The review round found the implementation leaning on §1's measurement as though
it were a guarantee, and it is not.

**A resumed conversation appends to the same transcript**, and switchboard
replays that file from byte 0 when it re-adopts it (`isOwnResumedFile`, and
`newTail()` starting at `offset: 0` — both deliberate, both older than this
item). So on resume the previous run's `cost-state` line is re-read, and without
a retirement rule it would pin the old total to a live session **labelled as
Claude Code's EXACT figure, frozen, while real spend climbed** — with the
estimate that would have tracked it suppressed the whole time. Exactly the
reading the manual promises does not happen.

The fix is that any **usage-bearing line on the bound file** retires the figure.
Three properties are load-bearing and each has its own test:

- **spend, not merely a later line** — the teardown flush writes two
  `cost-state` lines 108 ms apart with `mode` / `permission-mode` latches
  *between* them; a cruder "any later line wins" rule would discard the figure
  on the exact shape it exists for. (Asserting only the final value cannot tell
  the two rules apart — a mutant proved it, because the last line is a
  `cost-state` either way. The latch has to be asserted on its own drain.)
- **the bound file only** — tails drain per file with no ordering between them,
  so a subagent's lines arriving after the main file's teardown line would clear
  a genuinely final figure. That race would present as a cost that sometimes
  vanishes, which is unreadable as a bug report.
- **the estimate it falls back to covers the whole replayed history**, so the
  fallback is a smaller number than the truth rather than a wrong one.

**A second, narrower consequence of the same fact:** the capture only happens
when the CLI exits *by itself while still being watched*. `tearDownLive`
unwatches the transcript before tearing the process down, so ending a session
from the UI never captures a figure, and a hard kill means the CLI never writes
one. `/exit` in the Terminal tab is the path that works, and the manual says so.

## 6. What is NOT fixed, and is a real gap

**Our token totals under-count the CLI's ledger by 8–33%**, and on `input`
specifically by up to 500×: one session shows 732 input tokens against the CLI's
443,398. The cause is structural rather than arithmetic — subagent turns send
large uncached prompts, and subagent transcripts are separate *files* for us
while the CLI folds them into one per-session ledger.

This is **not** why the dollar figure was wrong (that was purely the rate table,
and it was wrong in the opposite direction, which is how it hid). It is its own
defect, it is bigger than #787, and it has been filed separately.

## 7. Reproducing

```bash
node spike/probes/787/probe-cost-state.mjs > report.json 2> summary.txt
```

Read-only over `~/.claude/projects`; spawns nothing, so there are no background
sessions to clean up. `PROBE_ROOT` overrides the corpus location.
