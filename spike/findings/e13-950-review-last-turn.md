# E13-950 — what does a real clean-room review leave as its last turn?

**Probe:** `spike/probes/950/probe-review-last-turn.mjs` (four questions, one run).
**CLI:** `claude` 2.1.280 on PATH, Windows 11, stream-json duplex with
`providers/claude.ts`'s exact flag list, `buildDispatchPrompt`'s exact message
shape (clean-room bundle first, `## Your instructions`, then the built-in role
prompt verbatim). **Measured 2026-09-26.**

## Why this was measured

#950's plan note, written when E13 was filed, says the item must *"measure
rather than design what a real clean-room review session actually leaves as its
last turn, since 'the result' is a transcript and not a structured object"* —
and the issue adds the warning that matters: **do not design the delimiter first
and hope the model honours it.**

#948 had already removed one candidate. Its findings
(`e13-948-plan-unattended.md`, item 5) establish that a plan-mode reviewer's
`Write` does not land in the author's tree — the CLI redirects it into
`~/.claude/plans/` — so **there is no artifact on disk to watch for** and a file
watcher is the wrong shape. What was left was the transcript, and the question
of which part of it.

**The doubt #948 left behind, and the reason this probe exists at all.** #948
reported that denying `ExitPlanMode` "costs the findings nothing", and it does —
but it measured that as a TOTAL, concatenating every assistant text frame in the
run into one character count. It never asked which TURN the findings were in.
The app now denies a dispatched session's `ExitPlanMode` at once
(`StreamPermissions.setDispatched`). If the model's shape were *review → ask to
exit plan mode → refused → "Understood, I'll stop here"*, then the last turn
would be a **sign-off**, "inject the final turn" would deliver an apology to the
author instead of the review, and #948's totals would look identical either way.

## The answer, in one paragraph

**The last assistant turn is the findings, in every run, including the one whose
`ExitPlanMode` was refused.** There is no sign-off turn after a denial: the model
answers the refusal by *reporting anyway*, in the same turn. And the last turn is
not merely a good guess — it is **byte-identical to the `result` frame's own
`result` string in all four runs**, which is the CLI's own answer to "what came
of this". What does NOT survive contact with measurement is §5.15's example
event text: **the findings are not countable**, so "3 findings" cannot be
produced honestly.

## What was measured

| # | Setup | Turns | Last turn | Controls |
|---|---|---|---|---|
| Q1 | `plan`, every `control_request` **denied at once** (the app today) | 2 (85, **2,867**) | **the full review** | none asked |
| Q2 | the same, second sample | 3 (63, 156, **1,663**) | **the full review** | **1 × `ExitPlanMode` at 60.4 s, denied** |
| Q3 | `plan`, nobody answering (control) | 2 (94, **3,289**) | **the full review** | none asked |
| Q4 | PR Author at `default` (our `ask`), controls denied | 2 (77, **2,572**) | **the full PR text** | none asked |

Wall clock 32–72 s. Every run reached `result: success`. Tools seen: `Read`,
`Bash`, `Grep`, `Glob`, `ToolSearch`, and in Q2 a `Write` and the `ExitPlanMode`
that followed it.

## The six things worth carrying forward

**1. THE LAST ASSISTANT TURN IS THE RESULT, AND THE DENIAL DOES NOT MOVE IT.**
Q2 is the case the probe was built for: the model reviewed, reached for
`ExitPlanMode` sixty seconds in, was refused with `"nobody is watching this
session"`, and then **produced its entire report as the next and final turn**. Not
one of the four runs ended on an apology, a question, or a request. The sign-off
heuristic the probe carried flagged nothing in any of the eleven turns it saw.
So the cheapest extraction on the issue's list is also the correct one, and it is
correct *for the path the app actually runs*, not only for the undisturbed one.

**2. ⚠️ IT IS THE LAST TURN, NOT ALL THE TURNS.** Every run opened with a short
throat-clearing turn — 63 to 94 characters, "The working tree matches the diff.
Here's the review." — then a tool call, then the substance. Joining every
assistant turn would prepend that to the author's composer. Taking the last one
does not.

**3. ⚠️ AND THE FINDINGS ARE NOT COUNTABLE. §5.15's "3 findings" CANNOT BE
HONESTLY PRODUCED.** Four runs of the *same prompt on the same diff* enumerated
four different ways:

| | numbered items | bullets | `##` headings |
|---|---|---|---|
| Q1 | 0 | 7 | 3 |
| Q2 | 0 | 9 | 0 |
| Q3 | **4** | 4 | 3 |
| Q4 | 0 | 10 | 2 |

No shape is present in all four, and the bullet count is not a finding count in
any of them — Q1's seven bullets are four correctness findings plus three
maintenance notes under a second heading, and Q2's nine are three findings, three
unstated assumptions and three costs.

**The self-reported count is worse than useless.** A regex for "N findings /
issues / problems" fired on exactly one run, Q1, and matched **"the first two
problems"** — a back-reference inside a *maintenance* bullet, pointing at two of
the four correctness findings above it. A count scraped from that sentence would
have printed "2" for a review that made four.

So the Feed event must say something true instead of a number. It can say who
finished, what role they wore, whom they reviewed, and **the first line of what
they actually wrote**, which is true by construction.

**4. `result.result` IS THE LAST TURN, VERBATIM — 4/4, byte for byte.** The
`result` frame carries the final assistant turn exactly (`resultTextEqualsLastTurn:
true` in every run). This is worth recording for two opposite reasons. It is a
**cross-check**: reading the last assistant block out of the Feed gives the same
bytes the CLI itself calls the outcome, so the extraction is not our invention.
And it is a **reason not to plumb it**: `feed/stream-feed.ts` treats `result` as a
lifecycle signal and reads no text off it, and teaching it to would create a
second source for one fact — the drift #947 refused — with no caller that needs
the second copy. The Feed already holds the bytes.

**5. SIZE IS COMFORTABLE, BUT THE CAP STILL HAS TO EXIST.** The candidate text ran
1,663–3,289 characters against `SIBLING_MESSAGE_CHAR_CAP`'s 20,000 — an order of
magnitude of headroom on a ten-line diff. A real review of a real branch is the
case that will not have it, and an over-cap sibling message is **refused, not
cut** (`delivery.ts`), so an uncapped inject would fail at the click with a
message about shortening text the user did not write.

**6. Q2 CONFIRMED #948's PLANS-DIRECTORY FINDING FROM THE INSIDE.** Its final turn
ends *"Write-up saved at `C:\Users\dheinz\.claude\plans\clean-room-handoff-from-
sharded-quail.md`"* — the model telling the author, in the text that would be
injected, about a file outside anything switchboard tracks. The probe removed it
(one plan file, one of four transcripts' worth of litter). Nothing in v1 cleans
that up for a real dispatch; it is a known cost, not a defect this item fixes.

## What this decides

* **The result is the LAST CONTIGUOUS RUN OF ASSISTANT PROSE BLOCKS**, read from
  `StreamFeed.blocks(sessionId)` — the same blocks the user is looking at, so what
  is injected is what is on screen. A run rather than a single block because
  `assistantIntents` emits **one block per content item**, so a final turn split
  into two text items is two blocks; `thinking` is transparent to the walk, and a
  `tool`, `user`, `todos` or `notice` block ends it. On this probe's transcripts
  that run is exactly the final turn, in all four.
* **No hook, no file watcher, no delimiter in the role prompt.** The first is
  unnecessary, the second was ruled out by #948, and the third is the thing the
  issue told this item not to do — and item 3 above is why it would not have held
  if it had been tried.
* **The event does not count anything.** It names the role, the reviewer and the
  author, and carries the first line of the report as its detail.
* **The inject is capped** at `SIBLING_MESSAGE_CHAR_CAP` before it reaches
  `SiblingDelivery.send`, in-band marker and all, rather than being refused there.
* **A reviewer that produced no prose at all still reaches the author** — as an
  event saying so, with nothing to inject. `delivery.ts` refuses an empty message,
  and an inject button that cannot work must not be offered.

## Caveats

One CLI build, one machine, one model, one small diff. Item 1 is the one to
re-measure if the CLI's plan-mode refusal behaviour changes, since it rests on
what the model chooses to do after a denial rather than on a protocol rule — and
#948's own caveat says the same about whether `ExitPlanMode` is reached for at
all (Q1, Q3 and Q4 did not; Q2 did). Item 3 is the most robust of the six: it is
four disagreeing samples, and more samples can only add shapes.

**Cost:** four real CLI turns. Every transcript minted was deleted by the probe,
as was the one file it caused the CLI to leave in `~/.claude/plans/`. No
background or daemon session was started.
