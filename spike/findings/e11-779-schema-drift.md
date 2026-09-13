# #779 — the transcript schema, re-measured (and the list the CLI publishes)

**Verdict: the declaration was five keys behind by its own harness's reckoning,
thirty findings behind by the corpus's, and twenty-five line types behind by the
CLI's own.** All of it is now classified as `ignored`; nothing new is consumed,
and four follow-ups carry what a feature would want.

**Measured:** Windows 11, 2026-09-12, PATH CLI **2.1.261**. Probes:
`spike/probes/779/` (`corpus-drift.ts` + `run.mjs`, `usage-details.mjs`).

---

## 1. Five was one turn's worth

`npm run check:transcripts` had been printing five unknown keys. It is not wrong
— it is narrow. That harness drives **one `-p` turn**: no tool calls, no
subagents, no compaction, no forks, no errors, no queueing. Five keys is what a
hello-world transcript can disagree about.

Walking every transcript on the machine instead:

| | 2026-07-31 (the header `schema.ts` was written against) | 2026-09-12 (#779) |
|---|---|---|
| transcripts | 250 | **3,259** |
| lines | 10,138 | **244,916** |
| malformed | — | **0** |
| findings | (the 69 declared as ignored) | **30** |

**Precisely what the 30 were**, because the distinction matters for the rest of
this note: **26 unknown field names + 4 unknown line `type` values** (the
detector reports an unknown type as the pseudo-key `type=<value>`, which is one
signal but not a field).

**`message` and `message.content.*` produced ZERO findings across all 244,916
lines.** Those two contracts are complete. Every finding was top-level or a
single `message.usage` key — worth knowing on its own, because it says the
API-shaped part of the format is stable and the CLI's *own* bookkeeping is where
the movement is.

### The `version` field is what makes a corpus more than a pile

Every line carries the CLI version that wrote it, so a key's version range dates
it and separates two very different findings:

- `apiBlockIndex` — **2.1.261 only, and the dating is earned**: 18,101 of that
  release's 18,111 assistant lines carry it, nothing before does. Genuinely new;
  the detector working.
- `agentId` (80,128 occurrences), `attributionAgent` (42,894) — **2.1.226 →
  2.1.261.** Not new at all. The old corpus was too small to contain a subagent
  run, so these were a measurement gap dressed as drift.
- `message.usage.output_tokens_details` — 2.1.233 → 2.1.261.

Without the version stamp both groups read as "the CLI changed something", and
the second would have sent someone hunting a release note that does not exist.

⚠️ **The method has a floor, and one finding is under it.**
`isAbortedMidStream` occurs **once** in 246,237 lines. At n=1 a version range
cannot separate "new in 2.1.261" from "a rare event that happened to occur on
2.1.261", so it is deliberately left undated. An early draft of this note dated
it alongside `apiBlockIndex`; review caught that, and it was worth catching — the
version-range method is this measurement's centrepiece and misusing it in one
place devalues it everywhere.

## 2. The CLI publishes its own list of line types

`KNOWN_LINE_TYPES` held 13 types, measured off the corpus. The PATH binary
(§2.1 of `docs/reference-implementations.md`) carries **two independent routing
tables** — one mapping a line type to a GC policy (`last-wins` / `accumulate` /
`boundary-cleared`), one to a dedup/routing policy (`always` /
`dedup-transcript` / `route-by-agent`) — and **they enumerate the same 38
types**. All 13 of ours are among them.

Of the 25 we were missing, be precise about which were hurting:

- **4 were arriving on ordinary sessions** and reporting as drift every time —
  `atis-latch` (6,599 occurrences), `relocated` (17), `worktree-state` (17),
  `cost-state` (14).
- **21 have never appeared here**, and were queued up to fire the first time the
  feature behind them got used.

The same binary's reducer chain **names the payload field it reads for each
type** — `tag`→`tag`, `agent-name`→`agentName`, `isolation-latch`→`side`,
`custom-title`→`customTitle`, `continued-in`→`continuedInSessionId`,
`frame-link`→`artifactCount`/`path`/`frameUrl`/`title`, `bridge-session`→seven
fields. So the payload keys for types nobody here has triggered are **read, not
guessed**.

⚠️ **It is the CLI's declared set, not a proof of exhaustiveness.** Both tables
fall back to a default for an unlisted type, so a 39th type the CLI writes
without routing it specially would be absent from both maps *and* from our list.
That is the case the detector still exists to catch, and it is why expanding the
list does not retire it.

**This is #776's lesson on a different file: don't work out what you can ask.**
`schema.ts`'s header had carried the caveat "THE CORPUS IS A LOWER BOUND, NOT THE
FORMAT" since July. The format was greppable on disk the whole time.

## 3. `output_tokens_details` — the one question that could have changed a number

The issue flagged it as most likely to matter, and it is: usage totals are
already consumed, so a details breakdown next to them is one careless `+=` away
from inflating every number the app shows, with nothing going red.

The binary shows the CLI's own aggregator adding `output_tokens` to a running
total while tracking `thinking_tokens` in a **separate** field — which proves it
never sums them, but not whether one contains the other. So measure it
(`usage-details.mjs`):

```
lines with message.usage            : 80140
  ...carrying output_tokens_details : 42374   <- control, non-zero
  ...actually comparable (both nums): 42374   <- control, the verdict's denominator
  ...with thinking_tokens > 0       : 26078   <- control, non-zero
sub-keys under the details object   : thinking_tokens (only)
max thinking_tokens / output_tokens : 0.9928
thinking_tokens > output_tokens      : 0
```

**It is a breakdown OF `output_tokens`.** Zero violations, and a maximum ratio
that climbs to 0.9928 without crossing 1.0 — what a subset does on a
thinking-heavy turn, and not what an independent quantity does.

**Three controls are printed beside the result on purpose** (#776's lesson: a
probe that agrees with you is not evidence). "Zero violations" would be vacuous
over a corpus where the field was always absent, or always zero — or where only
three of the 42,374 lines were actually comparable. The third counter is a review
finding: the original probe silently skipped uncomparable lines, so its
denominator was invisible. Today `compared == withDetails` exactly, which is
what makes the verdict sound rather than merely green.

Treatment: `ignored`, alongside the two warnings of exactly this shape already in
the file (`cache_creation`, "never added on top"; `iterations`, "an iteration
count, not tokens"). Interior deliberately not descended, with a test pinning
that.

## 4. ⚠️ THE FIX CONTAINED THE NEXT HOLE, AND IT WAS THE DETECTOR'S WHOLE PURPOSE

The #776 pattern again, and this one is worth reading before the next schema
change.

**The first cut put all 44 new root keys in the flat root `ignored` list.** The
contract is keyed by PATH, not by line type, so that list is shared by all 38
types. Among the 44 were `path` and `title`, which belong to a `frame-link`
(artifacts) line. And:

- **`cwd` is CONSUMED** — the primary binding evidence in `readHead`/`claim`.
- **`aiTitle` is read** by `readAiTitle`, whose own doc names it a §5.26 drift
  item: the drift log is the *only* thing that would ever report it breaking.

So declaring `path` and `title` flat made a **`cwd` → `path`** or **`aiTitle` →
`title`** rename permanently and completely silent — and a consumed-field rename
is the single loudest thing this detector exists for (`drift.ts`'s own header
uses exactly that example). Both would have fired before the change.

**What it bought in exchange: nothing.** Measured, `path` and `title` occur
**zero** times in 246,237 lines, while `cwd` occurs 207,502 times and `aiTitle`
3,229. They were declared purely off the binary, for a feature that has never run
here. The trade was "pre-silence a hypothetical one-off warning, in exchange for
permanent blindness on the two renames most worth hearing about".

**The fix, and the rule that came out of it.** `TYPE_SCOPED_ROOT_KEYS`: **a key
we have never actually seen is declared only for the line type the CLI says
writes it.** 19 of the 44 were unmeasured, and for every one of them the
reducer already named the owning type, so all 19 moved. The 25 measured keys stay
flat — their presence genuinely is not news anywhere, which is the entire reason
they are `ignored`.

If a scoped key turns up on an unexpected type it costs one warn-once slot and
says something true ("the CLI moved this"). That is the right side of the trade;
permanent silence is not.

**Honest framing of what still rests on a binary read:** 19 of the 44 keys and 21
of the 25 types have zero corpus evidence. A *wrong* name there is safe — the
real key would drift and be reported. The unsafe case was only a guessed name
colliding with a real generic one, which is what the scoping removed.

**The legacy 69 keys are still flat** and re-partitioning them means re-measuring
which type each belongs to. Nothing load-bearing waits on it, which is the
difference between that and the note this section replaced.

## 5. Classified: nothing new is consumed

All of it is `ignored`. Four things are worth a feature and are follow-ups, per
the issue's own done-when:

- **#787 — `cost-state` carries the CLI's own accounting**: `totalCostUSD`,
  `modelUsage` (per-model tokens *and* cost), `totalLinesAdded`/`Removed`,
  `totalAPIDuration`. §5.13 currently **estimates** cost from token counts. The
  CLI writes its own number into the transcript, and `hasUnknownModelCost` is the
  honesty field that makes it usable.
- **#788 — `agentId` + the `attribution*` fields** would let the Feed **group**
  subagent blocks and name the agent behind one. Today only `isSidechain` is
  read, which indents a sidechain but cannot separate two agents running
  concurrently — they interleave into one indented run. Adjacent to #757.
- **#789 — `output_tokens_details.thinking_tokens`**, a thinking breakdown for
  §5.13's usage pane, now known to be safe to display and unsafe to add.
- **#790 — `continued-in`** (a review finding). This is the only one of the 44
  keys whose mere ARRIVAL means the watcher should behave differently: it is the
  CLI's on-disk record that the conversation has moved to another file, and today
  the watcher learns that only through the hooks. When that channel is quiet we
  go on tailing a dead transcript, which reaches a bug report as "the Feed just
  froze".

## 6. A number that had already rotted

The root `ignored` list's comment read **"68 keys, measured"** over a list of
**69**. Nothing noticed, because the only thing that number does is tell a reader
the scale of what they are about to trust — and a hand-written count beside a
hand-written list is wrong the first time someone appends without counting.

The first fix pinned the count as a literal in the test. **Review pointed out
that makes it worse**: the comment, the list and the test literal are now three
places to keep in sync, so the next appender bumps the test, forgets the comment,
and gets green with a rotted comment — the same failure one level deeper. The
test now **reads the claimed number out of `schema.ts` and compares it to the
list**. Nothing to bump; it can only fail when the two genuinely disagree. There
was already precedent for source-reading tests in this repo.

#774's lesson, generalised: **a claim with nowhere to be tested is a claim
waiting to be wrong** — and the mechanism you pin it with can be wrong too.

## 7. Verification

- **The corpus probe, before and after, is the control pair**: 30 findings over
  244,916 lines → **0 over 246,579 lines**, same probe, same corpus.
- `npm run check:transcripts` against 2.1.261: **`no schema drift against this
  CLI build`**, PASS. The issue's done-when, verbatim.
- **35 mutants, all die** — and the second number matters more than the first:

  **ROUND 1's MUTANT EVIDENCE WAS VACUOUS, AND REVIEW CAUGHT IT.** The suite then
  had a guard asserting the root list's *length*, so deleting any single key
  failed it on arithmetic alone — 113 ≠ 112 — whether or not a single test
  exercised that key. "18 mutants, all die" was guaranteed by counting and said
  nothing about per-key coverage. It is #776's "a widened bound swallowed the
  mutant" one level up: **a blanket guard swallows every mutant.** The re-run
  neutralises the count guard first, so 29 of the 33 die *cleanly*; the 4 that
  also trip the guard were each re-run in isolation with the count left honest,
  and died anyway.
- **The regression guard for §4's hole is itself mutant-tested**: putting `path`
  and `title` back in the flat root list reddens the scoping test. Before review
  there was no test that could have noticed.
- One mutant in round 1 **skipped itself** because its anchor string did not match
  the file (a trailing comment), and the runner reported SKIP rather than a kill —
  a mutant whose edit silently no-ops is a green run that proves nothing, so the
  runner checks its own anchor exists before believing the result.
- Full suite green apart from one unrelated machine-load timeout
  (`update/install.test.ts`, 34 tests in 78 ms in isolation).

## 8. One correction worth keeping, because it pointed the wrong way

An early draft's comment on attachment lines said `attachment` was "the old
payload key" and `rendered` was where 2.1.261 puts the text. **Backwards, and a
future Feed built on it would have rendered 27% of attachment lines and dropped
the rest.** Measured: `attachment` is the STRUCTURED payload, on **75,487 of
75,487** attachment lines, versions 2.1.217 → 2.1.261. `rendered` /
`renderedInHumanTurn` are a PRE-RENDERED text form 2.1.261 adds for only *some*
attachment kinds — 9,883 of 36,095 of its attachment lines. A Feed needs both.

The general shape: a comment in this file is consumed as documentation by whoever
builds the next feature, so a plausible-sounding one that was never measured is
more dangerous than a missing one.
