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

**Yes, a plan-mode Direct session shows a permission bar: `ExitPlanMode`, which is
the CLI asking you to approve the plan. And Allow on that bar takes the session
OUT of plan mode.** The CLI announces `permissionMode: default`, and the work
starts — each write then asked about, as it would be in `ask`. Ordered to run a
command or write a file while planning, it sent **no request for either**; it
asked to leave plan mode instead. So the code is right to show the bar (with no
terminal, it is the only place a plan can be approved) and **the manual was
wrong**: "stays read-only whatever you click" is false for the plan-approval bar.

## What was measured

Seven real turns. In every plan trial the prompt **ordered** the thing being
tested, so the model had every reason to reach for the tool.

| # | Setup | `can_use_tool` requests | Tree after |
|---|---|---|---|
| A | `plan`, ordered to run `echo canary > canary-bash.txt`. Everything allowed **except** `ExitPlanMode` | **`ExitPlanMode`** (denied). **No `Bash` request arrived** | clean |
| B | `plan`, ordered to `Write` `canary-write.txt`. Same answers | **`ExitPlanMode`** (denied). **No `Write` request for the folder** | clean |
| C | `plan`, the same `Write` order, **everything allowed** | `ExitPlanMode` (allowed) → **`system`/`status` with `permissionMode: default`** 7 ms later → **`Write` for the folder** (allowed) | **`canary-write.txt` written** |
| D | **control for A:** `default` mode, the `Bash` order, everything allowed | `Bash` (allowed) | `canary-bash.txt` written |
| E | `plan`, ordered to ask a multiple-choice question | **`AskUserQuestion`** (denied) | clean |
| F | `plan`, ordered to `Read` a file in a different temp folder | **none** — the read ran | clean |
| G | **control for F:** `default` mode, the same outside `Read` | **none** — the read ran | clean |

D is what makes A mean something: the identical order at `default` produces a
`Bash` request and a file, so A's clean tree is plan mode and not a model that
could not be bothered. G is what stops F meaning too much: that read is not
asked about in `default` either, so F says nothing about plan mode.

## What to carry forward

**1. While planning, no command or edit is asked about — because none is
attempted.** In A and B the model wrote a plan file (to `~/.claude/plans/`, #948's
item 5, with no request) and called `ExitPlanMode`. No `can_use_tool` for `Bash`
or for a `Write` into the folder was sent. So "an allow is answered into the CLI's
enforcement" was never put to the test by the CLI: the question it would be
answering was not asked.

**2. That is NOT "plan mode asks for exactly one thing".** The first draft of this
note said so, and review caught it: A–C ordered only a command and an edit. E
shows a **question** (`AskUserQuestion`) is asked in plan mode like anywhere else.
Web fetches, MCP tools and anything else a session can be asked about are
**unmeasured** here.

**3. `ExitPlanMode` is the plan-approval prompt, and it carries the plan.** The
request's `input.plan` is the whole plan as Markdown. It has **no
`decision_reason`, no `decision_reason_type` and no `permission_suggestions`** —
like `AskUserQuestion`, it is not a safety question and carries none of that
furniture.

**4. Allow leaves plan mode, and the CLI says so.** C: allowed at 6,525 ms; a
`system` message with `subtype: 'status'` and `permissionMode: 'default'` at
6,532 ms; the tool result reads *"User has approved your plan. You can now start
coding."* The session is in `default` mode from then on.

**5. After approval, writes are asked about — as in `ask`.** C's `Write` into the
folder arrived as its own `can_use_tool`. Approving a plan is not approving the
edits; it is leaving plan mode. ⚠️ **In the app there is one way it IS both:**
the bar carries **Allow all (this session)**, and `StreamPermissions.offer`
auto-allows everything that follows for a session holding that grant. Pressing it
on a plan approves the plan and every write after it, for as long as that session
keeps running. That is what the button says, and the manual now says it too.

**6. Deny keeps plan mode and loses nothing.** A and B both reached `result`
with a sensible one-line answer (*"plan mode blocked the command, and the plan to
run it was declined"*). #948 measured the same thing with a longer prompt.

## What this decides

* **The stream path gains NO plan-mode refusal.** #588's own done-when offered one
  (*"the stream path gains the same plan-mode refusal the hook path has"*), and it
  would be wrong: that refusal existed because a HOOK allow bypassed the CLI's
  permission system. Here the request is the CLI's own plan-approval prompt, and
  refusing it in-app would leave a plan with nowhere to be approved — P7, "never
  fake an interaction the CLI kept for itself", pointing the other way. The
  dispatched-session refusal (#948) stays: that one is about nobody watching.
* **The manual is corrected** in `04-approvals-and-autonomy.md` and
  `12-direct-mode.md`, and so is the plan mode tooltip on the shield chip, which
  carried the same sentence.
* **The two code comments that repeated the reasoning** (`stream-permissions.ts`
  branch 0, `hook-listener.ts`) now say what was measured.
* **A zero-token e2e holds it:** the fake provider learned `!permplan`, which
  reproduces the measured exchange — the bare request, and the `status` message
  on Allow.

## Three things this found and did not fix

**The card's mode chip does not follow the session out of plan mode.** The CLI
announces `permissionMode: default` and nothing in the app reads it, so the chip
goes on saying `plan` for a session that is now asking about writes. Filed, not
fixed — it is interface work.

**The bar shows the plan as one line of escaped text** — the Markdown with its
line breaks written out as backslash-n. A real plan is paragraphs, so the thing
being approved is hard to read at exactly the moment it matters. Filed, not
fixed, for the same reason.

**Allow all (this session) is offered on the plan-approval bar.** See item 5.
Whether a plan should be approvable "for everything after it" in one press is a
product question; it is recorded on the same issue as the bar's rendering.

Aside, not chased: G shows a `Read` outside the session folder is NOT asked about
at `default` on this build, for a file under the user's temp folder. The manual's
`ask` row says reading outside the folder stops for you. One path on one build is
not enough to rewrite that row, but it is enough to doubt it.

## Caveats

One CLI build, one machine, one model, **one trial of each**. Item 1 is the one
most likely to move: whether the model attempts a mutating tool in plan mode is a
decision the model makes under the CLI's plan-mode instructions, not a protocol
rule. If a build ever does send a `Bash` or `Write` request while in plan mode,
what an Allow does to it is unmeasured, and the manual's sentence should be
re-checked against it. Whether a RESUMED session that had left plan mode comes
back in plan mode is also unmeasured — the app passes `--permission-mode plan`
again on every spawn, and what the CLI does with that on a resume was not probed.

**Cost:** seven real CLI turns. Every transcript minted and the three plan files
the CLI wrote were deleted by the probe; no background or daemon session was
started.
