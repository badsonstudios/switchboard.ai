# 588 — does a plan-mode Direct session ask for permission, and what does Allow do?

**Probe:** `spike/probes/588/probe-plan-permission-bar.mjs`.
**CLI:** `claude` 2.1.288 on PATH, Windows 11, stream-json duplex with
`providers/claude.ts`'s exact flag list. **Measured 2026-10-03.**

## Why this was measured

The manual's plan-mode sentence has said two opposite things, and #588 was filed
between them.

* Until #952: *"Plan mode never asks in-app, on purpose."* True of the hook path,
  which held nothing for a plan session (`GATED.plan = []`).
* Since #952: *"Plan mode now asks in-app like every other mode… plan mode's
  write block stands **whatever you click**… nothing you can click in switchboard
  makes it not."*

The second was **reasoned, not measured** — a comment in `stream-permissions.ts`
says an allow *"is answered INTO the CLI's enforcement, so plan mode's write-block
stands"*. #948's two probes measured plan mode on this transport, but every
control request in both rounds was **denied or left hanging**. Nobody had measured
an **Allow** in plan mode, and that is the half a user acts on.

## The answer, in one paragraph

**Yes, a plan-mode Direct session shows a permission bar — for exactly one thing:
`ExitPlanMode`, which is the CLI asking you to approve the plan. And Allow on that
bar takes the session OUT of plan mode.** The CLI announces `permissionMode:
default`, and the work starts — each write then asked about, as it would be in
`ask`. So the code is right to show the bar (with no terminal, it is the only
place a plan can be approved) and **the manual was wrong**: "stays read-only
whatever you click" is false for the one bar plan mode ever shows.

## What was measured

Four real turns. In every plan trial the prompt **ordered** a change, so the model
had every reason to reach for the mutating tool.

| # | Setup | `can_use_tool` requests | Tree after |
|---|---|---|---|
| A | `plan`, ordered to run `echo canary > canary-bash.txt`. Everything allowed **except** `ExitPlanMode` | **one: `ExitPlanMode`** (denied). **No `Bash` request ever arrived** | clean |
| B | `plan`, ordered to `Write` `canary-write.txt`. Same answers | **one: `ExitPlanMode`** (denied). **No `Write` request for the folder** | clean |
| C | `plan`, the same `Write` order, **everything allowed** | `ExitPlanMode` (allowed) → **`system`/`status` with `permissionMode: default`** 7 ms later → **`Write` for the folder** (allowed) | **`canary-write.txt` written** |
| D | **control:** `default` mode, the `Bash` order, everything allowed | `Bash` (allowed) | `canary-bash.txt` written |

D is what makes A mean something: the identical order at `default` produces a
`Bash` request and a file, so A's clean tree is plan mode and not a model that
could not be bothered.

## The five things worth carrying forward

**1. Plan mode asks for one thing.** In A and B the model did not attempt the
mutating tool at all — it wrote a plan file (to `~/.claude/plans/`, #948's item 5,
with no request) and called `ExitPlanMode`. No `can_use_tool` for `Bash` or for a
`Write` into the folder was sent while the session was in plan mode. So "an allow
is answered into the CLI's enforcement" was never put to the test by the CLI: the
question it would be answering is not asked.

**2. `ExitPlanMode` is the plan-approval prompt, and it carries the plan.** The
request's `input.plan` is the whole plan as Markdown. It has **no
`decision_reason`, no `decision_reason_type` and no `permission_suggestions`** —
like `AskUserQuestion`, it is not a safety question and carries none of that
furniture.

**3. Allow leaves plan mode, and the CLI says so.** C: allowed at 6,525 ms; a
`system` message with `subtype: 'status'` and `permissionMode: 'default'` at
6,532 ms; the tool result reads *"User has approved your plan. You can now start
coding."* The session is in `default` mode from then on.

**4. After approval, writes are asked about — as in `ask`.** C's `Write` into the
folder arrived as its own `can_use_tool`. Approving a plan is not approving the
edits; it is leaving plan mode.

**5. Deny keeps plan mode and loses nothing.** A and B both reached `result`
with a sensible one-line answer (*"plan mode blocked the command, and the plan to
run it was declined"*). #948 measured the same thing with a longer prompt.

## What this decides

* **The stream path gains NO plan-mode refusal.** #588's own done-when offered one
  (*"the stream path gains the same plan-mode refusal the hook path has"*), and it
  would be wrong: that refusal existed because a HOOK allow bypassed the CLI's
  permission system. Here the only request is the CLI's own plan-approval prompt,
  and refusing it in-app would leave a plan with nowhere to be approved — P7,
  "never fake an interaction the CLI kept for itself", pointing the other way.
  The dispatched-session refusal (#948) stays: that one is about nobody watching.
* **The manual is corrected** in `04-approvals-and-autonomy.md` and
  `12-direct-mode.md`.
* **The two code comments that repeated the reasoning** (`stream-permissions.ts`
  branch 0, `hook-listener.ts`) now say what was measured.
* **A zero-token e2e holds it:** the fake provider learned `!permplan`, which
  reproduces the measured exchange — the bare request, and the `status` message
  on Allow.

## Two things this found and did not fix

**The card's mode chip does not follow the session out of plan mode.** The CLI
announces `permissionMode: default` and nothing in the app reads it, so the chip
goes on saying `plan` for a session that is now asking about writes. The manual's
*"a new mode takes effect the next time the session starts"* is about the chip
you click; this is the CLI changing mode by itself. Filed, not fixed — it is
interface work.

**The bar shows the plan as one line of escaped text.** `plan="# Plan\n\n1. …"`,
literal `\n` and all. A real plan is paragraphs of Markdown, so the thing being
approved is hard to read at exactly the moment it matters. Filed, not fixed, for
the same reason.

## Caveats

One CLI build, one machine, one model, one trial of each. Item 1 is the one most
likely to move: whether the model attempts a mutating tool in plan mode is a
decision the model makes under the CLI's plan-mode instructions, not a protocol
rule. If a build ever does send a `Bash` or `Write` request while in plan mode,
what an Allow does to it is unmeasured, and the manual's sentence should be
re-checked against it.

**Cost:** four real CLI turns. Every transcript minted and the three plan files
the CLI wrote were deleted by the probe; no background or daemon session was
started.
