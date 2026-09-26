# E13-948 — can a `plan`-mode session finish unattended?

**Probes:** `spike/probes/948/probe-plan-unattended.mjs` (round 1, five questions),
`spike/probes/948/probe-plan-write-after-deny.mjs` (round 2, two questions).
**CLI:** `claude` 2.1.280 on PATH, Windows 11, stream-json duplex with
`providers/claude.ts`'s exact flag list. **Measured 2026-09-26.**

## Why this was measured

#946 shipped the built-in **Code Reviewer** at autonomy `plan`, and flagged that
default as a **guess in three places** — beside `BUILT_INS` in
`shared/dispatch.ts`, in DESIGN §5.15's as-built note, and as a comment on #948.
The reasoning for `plan` was good: it maps to `--permission-mode plan`, whose
write block is the CLI's **own**, and §5.16's plan-mode rule says nothing in-app
may Allow past it — the strongest "do not touch the author's tree" available,
needing no new machinery.

The doubt was equally good: **exiting plan mode is an approval the CLI keeps for
itself.** A dispatched reviewer that wants to present findings might therefore
park waiting for a human who, by definition, is not watching.

## The answer, in one paragraph

**Keep `plan`. It is the real write block — measured, twice, including a control
that proves the model genuinely tried.** But the parking fear was also real and
sharper than expected: `ExitPlanMode` **is** requested for the review prompt,
**is retried after a refusal**, and an unanswered one parks the CLI with **no
timeout of its own**. So `plan` is correct *and* it needs the deny-writes story
#946 predicted — not as a replacement for the default, but underneath it.

## What was measured

| # | Setup | Result |
|---|---|---|
| Q1 | `plan`, #946's real Code Reviewer prompt, **nobody answering** | **finished in 19.0 s**, `result: success`, 1,463 chars of findings, **zero `control_request`s**. Tools: `Read`, `Glob` |
| Q3 | `default` (our `ask`), same prompt, nobody answering | finished in 12.0 s, zero `control_request`s, 1,720 chars |
| Q4 | `plan`, same prompt, **every `control_request` denied** | **one `ExitPlanMode` at 30.5 s**; denied; **still finished** (37.0 s, 1,727 chars of findings) |
| Q5 | `plan`, prompt **ordering** a file write, nobody answering | `ExitPlanMode` at 14.8 s → **timed out at 120 s with no `result`**. Canary **not** written |
| R1 | `plan`, exit denied, prompt ordering `FINDINGS.md` into the folder | **`ExitPlanMode` TWICE** (31.7 s, 36.9 s), both denied, session finished — and **the working tree was clean**: `git status` showed no new files |
| R2 | **control:** `acceptEdits`, identical prompt | **`FINDINGS.md` was written.** So R1's clean tree is a block, not a model that could not be bothered |

## The five things worth carrying forward

**1. A plan-mode review does not *need* to exit plan mode to report.** Q1 finished
with zero control requests. Asked to *report*, the model reports.

**2. But it reaches for `ExitPlanMode` anyway, and it retries.** Q4 and R1 are the
same review prompt as Q1 and both asked — because the model decided to write its
findings to a file first. R1 asked **twice**, the second time after being refused.
So "it finished in Q1" is one sample of a non-deterministic choice, not a property.

**3. An unanswered `ExitPlanMode` parks the CLI indefinitely.** Q5: 120 s, no
`result`, nothing moving. This confirms from the outside what
`stream-permissions.ts` already records from the inside — *"the CLI itself waits
for ever (measured: 180 s with no fallback and no timeout of its own)"*.

**⚠️ In the app it is not unanswered, it is answered LATE.**
`StreamPermissions` holds a non-question request on a **300 s deadline** and then
`failOpen`s it to a deny. So a dispatched plan-mode reviewer does not wedge — it
loses **five minutes per request**, and R1 says there can be two of them. For the
whole of that time the card sits in `needs-permission`, which rings the attention
machinery for a question whose only in-app answer is the one it will get anyway.

**4. A denial does not cost the findings.** Q4 and R1 both reached `result` with
the full review after their exit request was refused. This is what makes the
deny-writes story cheap: refusing loses nothing.

**5. ⚠️ PLAN MODE STILL WRITES A FILE — just not in your tree.** R1's `Write`
**succeeded**, to:

```
C:\Users\dheinz\.claude\plans\you-are-reviewing-a-zippy-pizza.md
```

The CLI redirects a plan-mode write into **its own plans directory under the
user's home**, and names the file after the prompt. The author's folder is
untouched, which is the guarantee `plan` was chosen for and it holds. But it means
**a dispatched reviewer can leave litter in `~/.claude/plans/`** — outside the
session folder, outside the repo, and outside anything switchboard tracks or
cleans. Worth knowing before #950 runs reviews in a loop.

Also incidental: **`Bash` ran in plan mode un-gated** (`ls -la`, a `git` call) with
no `control_request`, so plan mode's block is about mutation, not about tools.

## What this decides

* **`BUILT_INS[0].autonomy` stays `plan`.** The guess is now a measurement, and the
  three "#948 must measure this" comments become as-built notes.
* **A dispatched session gets the deny-writes story**, narrowly: an `ExitPlanMode`
  request from a session nobody is watching is answered **deny, at once**, instead
  of being held for 300 s. Not a blanket auto-deny — any other held tool on a
  dispatched session is a genuine "this needs a human" and the attention queue is
  the right answer for it.
* **`ask` was never the better default.** Q3 finished, but `ask` gates
  `SHELLISH ∪ MUTATING` in our own hold policy, so an `ask` reviewer that reached
  for a write would park on **our** hold rather than the CLI's — the same failure
  one layer in, having given up the CLI's write block to get there.
* **#950 should not expect a findings FILE.** The result is a transcript and the
  last turn is prose; in plan mode a file the reviewer writes goes to
  `~/.claude/plans/`, not to the folder under review.

## Caveats

One CLI build, one machine, one model. Items 2 and 5 are the ones most likely to
move with a build: whether the model reaches for `ExitPlanMode` is a decision, not
a protocol rule, and the plans directory is an implementation detail of the CLI's
plan mode. Item 3 — an unanswered control request parking for ever — is the one to
re-measure if the CLI ever grows a timeout of its own, because the 300 s deadline
in `stream-permissions.ts` is sized against its absence.

**Cost:** seven real CLI turns. Every transcript minted was deleted by the probes
(`cleanup`), and no background or daemon session was started.
