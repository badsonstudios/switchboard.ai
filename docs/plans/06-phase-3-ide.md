# Phase 3 — The IDE

**Theme:** review, safety, and fleet-level surfaces. Phase 2 made sessions aware
of each other; Phase 3 makes the *work they produce* reviewable, reversible, and
legible across the whole fleet.

**Prerequisite:** Phase 2 cut 2026-09-28 at v0.8.100 (milestone closed, 0 open /
406 closed). Authoritative feature list: **DESIGN.md §8 "Phase 3"**. This file
breaks it into epics and records what the cut's sweep handed the phase.

**Milestone:** `Phase 3 - The IDE` (opened 2026-09-28), plus the standing
`Flakes & CI health` lane which is **deliberately not part of this phase**.

> **⚠️ WHAT THIS FILE IS AND IS NOT.** It is **epic-level scope**: enough to
> sequence the phase and to know which swept issue belongs to which surface. It
> is **not** a filed work-item plan. Per `00-process.md`, work items are written
> and filed **just-in-time** as the preceding epics near exit, and bulk-filing a
> phase is explicitly against process. **The 45 issues listed under the epics
> below are raw material, not work items** — they were swept in at the cut so the
> queue would stop lying about what Phase 2 owed, and most will be absorbed into
> an item rather than worked as filed.
>
> **`PROGRESS.md` is the authority on live state.** Never read the current item
> off this file; it is the one mistake this project keeps making.

---

## What the cut handed this phase

Phase 2 shipped on its exit criteria, not on an empty queue (owner, 2026-09-26).
Of the 63 open issues at the cut, **45 came here**, 14 went to the flake lane and
4 were closed as verified-dead. Three arrivals do not appear on DESIGN §8's
Phase 3 list at all and would otherwise have no parent:

1. **E21 responsiveness, carried forward** — it was never a Phase 2 exit
   criterion and is blocked on the owner's laptop capture, so it moved rather
   than held the cut. **#719 is the most severe open issue in the repo.**
2. **The injected-context trust boundary** (#832, #830) — a forgery hole in the
   signature feature.
3. **Onboarding and the manual** (#966, #965) — and #965 contradicts a Phase 4
   planning note; see its issue comment.

> **⚠️ AND THE DEBT PHASE 2 HANDED OVER, which outranks every epic below.** The
> dogfood tracker reads **20 hand-tested against 116 untested**. Phase 2's nine
> exit criteria were *demonstrated* (largely by e2e), not *used* — criterion 5
> rests on `dispatch.spec.ts`, and all six items of E13/Dispatch shipped in
> v0.8.100 without a single hand-test. **The owner's dogfood sitting comes before
> any epic here, and bugs it files outrank everything in this file.** Exit
> criterion 10 exists so this cannot happen twice.

**Seventeen epics is a lot, and Phase 2 was reconciled down once already
(2026-07-21) for exactly this reason.** Expect this list to be split or demoted
before it is filed. E24–E26 are the phase; E30–E32 are the likeliest candidates
to slip to Phase 4.

---

## Epics

### E23 — Responsiveness *(carried forward from Phase 2's E21)*
**Blocked on the owner.** Measure where the app is slow on the *laptop* at 3+
sessions, then fix the worst offenders — with real evidence, not the synthetic
throttle this epic exists to stop trusting.
`perf` · **#904** (measure, local-only timings) · **#719** (laptop CPU peg;
26h forensic + 5 watcher bugs inside) · **#716** (composer typing lag) · **#740**
(feed re-lays-out on any panel change — the other half of #716; deliberately
waits for real evidence) · **#743** (`seenNames.clear()` false new-file sweeps) ·
**#744** (Electron cache grew to 236 MB) · **#697** (watcher tuning follow-ups,
needs an SMB dogfood).
**Do not start the capture-dependent items without the capture.**

### E24 — The write half of git *(§5.7 — the phase's spine)*
Everything shipped so far is git's READ half (status, diff, log). This is the
write half, and it must be **one** commit path, not two.
Worktree create/merge-back flows with a review step · editable diff +
commit-from-diff (*table-stakes: Crystal shipped it*) · one-click squash-merge to
main + update-from-main (*table-stakes across Crystal / Claude Squad / Conductor /
parallel-code*) · cross-session same-repo conflict warnings · port/resource
conflict Feed warnings.
**Run the OQ #9 spike FIRST** — 7–8 real branches, merge-conflict endgame — and
design the worktree flows *from* its findings. The spike was billed as "embedded
in Phase 2" gated on *"once parallel worktree use is real"*, a gate that could
never open inside Phase 2. Mis-sequenced, not late.

### E25 — Files tab & document viewer v2 *(§5.7 + §5.30)*
The **Files** tab + file tree with VCS decorations · full file-type dispatch
(code / image / JSON / JSONL / CSV + a card for binaries) · live re-render
follow-tail for append-shaped files · viewer restore across relaunch.
**#521** (*owner-reported: "no discoverable way to open a file — I expected a
Files tab"*) · **#504** (`openDiff` can land a Changes tab in the document area) ·
**#506** (closing the source card silently stops live re-render — needs a "no
longer following" state) · **#508** (viewer copy button in a popped-out window).
One surface, one epic: planning the tree separately from the viewer builds two
file-navigation surfaces that disagree.

### E26 — Fleet surfaces *(§5.13, §5.16 mode 2, mission control)*
Plan these together — same fleet-wide "here is every session's pending thing"
plumbing, and independently-built versions would disagree within a release.
Cross-session review dashboard (all pending diffs, ranked by readiness) ·
**review queue pane** (§5.16 placement mode 2, deferred out of Phase 2 by the
2026-09-26 scope call) · mission-control dashboard (promoted from backlog —
research v2 made fleet dashboards the category standard) · usage tracking
(per-session chips, plan-usage meter, burn-rate / rate-limit events).
**#715** (per-session context-usage % in the card header — the number §5.13 never
surfaced) · **#722** (activity report: "what did we do" across sessions by date).
**Carry the `estimateCostUsd` fix here** (AR-P2-12): model pricing is baked into
the renderer's UI layer and an unknown model defaults to Sonnet rates — i.e. it
invents a number. With OQ #8 closed (no ClaudeMon engine coming) that logic needs
a home in main/shared, and this is the epic that gives it one.

### E27 — Windows, tray & archive *(§5.6, §5.24, §5.25, §7)*
All one window-management problem — decide them together or none of them.
Watcher windows for subagents · undercard tray + attention bubbling · **floating
approval window** (§5.16 mode 3; §5.16's own as-built note wanted it here or
dropped — kept) · tray mode + session archive v1 · fleet snapshots + layout DSL
v1 with the restore confirm gate (OQ #14/#15).
**#756** (focus-stealing policy: smart / urgent / focus / none, global +
per-session).

### E28 — Checkpoint & rollback v1 *(§5.28)*
Auto-checkpoint per turn · Feed-anchored restore chips · reversible rollback.
**Must land BEFORE E29** — autonomy without seatbelts inverts the risk order.

### E29 — Dispatch v2 *(depends on E28)*
`spawn_session` bus tool (agent-initiated) · rules-engine auto-dispatch (on done
+ tests pass → clean-room review) · bounded fix / re-review loops.
**Gate:** E13/Dispatch v1 has never been hand-tested (see the debt note above).
Do not automate a loop over a v1 nobody has watched run.

### E30 — Cross-session drag *(§5.4 Tier 1 + §5.5 Level 1)*
**Blocked on E24 and E25 by design.** The **file drag** needs E25's Files tab to
drag from; the **diff-hunk drag** shares a selection model with E24's editable
diff and building it alone would grow a second hunk-selection path. §5.5 **Level
1 (excerpt injection)** rests on that tier and comes along — with its open
question intact rather than pre-answered: *with `@`-references and the context
chip both shipped, is dragging raw text between sessions still worth a gesture?*
Answer it here, with the dogfooding behind it.

### E31 — Capability Inspector *(§5.19)*
Per-session skills/agents view · drag-to-copy across sessions with
provenance-aware semantics.

### E32 — Headless task panes
Stream-json fire-and-forget queue.

### E33 — Onboarding & the manual
**#966** (first-run tutorial: skippable coach-mark tour, re-runnable from Help) ·
**#965** (HTML user manual: audit every shipped feature, reconcile
`docs/manual/`, render to HTML, owner screenshot shot-list).
**#965 contradicts `03-later-phases.md`'s Phase 4 note**, which dated the manual
build late so it would "compile content that already exists, not become a writing
project". A filed issue outranks a note, so it is scoped here — but the note's
reasoning holds: auditing 116 untested features audits what nobody has used.
**Sequence it after the dogfood sitting; the owner may prefer it back in Phase 4.**

### E34 — Trust, input & error hardening
**#832** (*bug* — another session's output can steer THIS session's file
attachments via `@word` inside injected context) · **#830** (collapse injected
`@`-mention context inside a sent turn, **with the forgery guard** — the shared
piece, so run it with #832 or as one item) · **#499** (unbounded prompt text over
IPC; the reference extension truncates at 50k — plus bidi characters in
attachment titles) · **#670** (`String(err)` in ~50 catch blocks renders
`[object Object]` to users; unreachable by #255's campaign, needs its own
decision) · **#824** (drift detector: `sessionKind` is a CLI envelope key
declared nowhere).

### E35 — Layout & tab ergonomics
**#619** (middle-click a tab to close it) · **#620** (drag a session tab onto
another group's tab strip to dock as a sibling — no center-target hunting) ·
**#631** (hover a tab or rail entry → the session's last prompt) · **#695** (card
overflow menu clips on 3–4-way splits; needs a rect-anchored `placeMenu`) ·
**#702** (E12-04's grid-drag membership adoption looks dead in general —
`openPanel` fires `onDidGroupChange` before `doAddPanel` registers) · **#731**
(can't drag a stacked session out to a full-height column) · **#582** (cross-group
drop lands by arrival order, and nav's ungroup drop lacks a `from===to` guard).

### E36 — Attention legibility *(owner sittings — gated on Dan)*
`owner-action` · **#528** (session attention states: the coloring scheme and
needs-attention behaviour aren't intuitive) · **#529** (the focused session's
border is not prevalent enough — which-window-am-I-in must be unmissable) ·
**#710** (does a stuck pinned row read as floating, and should a pin escape its
group card?) · **#718** (working sessions are too quiet in the rail; the busy
spinner isn't enough).
**Three of these four are `[user]` design sittings: they are decisions, not
tickets.** Nothing here can be built until the owner sits with the app. #718
carries options inside and is the one that could move first.

### E37 — Feed & composer follow-ups
**#978** (local slash-command output — `/usage`, `/cost`, `/context` — never
reaches the Feed on the stream; **this is the one caveat v0.8.100's in-app
release notes still advertise to users**) · **#981** (the composer's height cap
does not enforce the room it was offered; the conversation pays ~49px and
`MIN_FEED_PX` is not held) · **#680** (Feed ignores `isReplay` on user echoes — a
duplicate-rendering bug the day resume-plus-replay exists) · **#693**
(unmeasured: does the CLI write an attachment-only turn as an ordinary user line
or `isMeta`?) · **#757** (a small identifying icon per tool block) · **#717**
(turn boundary round 2 — the #640 rule + NEW PROMPT caption still isn't easily
spotted; owner's verdict after hand-testing).

### E38 — Accessibility & voice
**#685** (post-#268 contrast stragglers: `--muted` on `--chip` 4.10:1 nordic,
`--faint` timestamps 2.57–2.73:1 app-wide, runtime group-header palettes
unauditable) · **#941** (the palette's four named-rung commands are still silent —
only the ladder STEPS got a voice in #581) · **#942** (a chord whose command is
disabled is completely silent; the dispatcher has a `disabledReasonKey` and never
speaks it) · **#851** (the context chip is drag-only — no keyboard or palette way
to hand a session's context to another).

### E39 — Bus, approvals & notification follow-ups
**#861** (Blackboard has no way to remove a note, so the 100-key cap is a one-way
door — the same shape as #974's finding that a standing grant had no revoke) ·
**#588** (do plan-mode Direct sessions surface an in-app permission bar?
*partly answered by #952 — read the issue comment before re-deriving it*) ·
**#675** (expired-toast Allow needs a `ToastActivatorCLSID` the NSIS shortcut
doesn't write — Action Center activation gap).

---

## Order

**Before any epic: the owner's dogfood sitting.** 116 untested features, all of
Dispatch among them. Bugs it files re-order everything below.

1. **E23** as soon as the capture lands — it is blocked on evidence, not effort,
   and #719 is the worst open issue in the repo.
2. **E24's OQ #9 spike first**, then E24 proper. It is the phase's spine and
   everything in E30 and half of E25's value waits behind its commit path.
3. **E25** beside E24 (different surfaces, no shared code until E30) — #521 is
   owner-reported and unblocks three viewer bugs.
4. **E34** can run any time and should run early: #832 is a trust bug in a
   shipped feature, and it is small next to the epics around it.
5. **E26** after E24/E25 — it composes their surfaces plus the usage engine.
6. **E28 → E29**, in that order, never the reverse.
7. **E27**, then **E30** (hard-blocked on E24+E25), then **E31/E32**.
8. **E35 / E37 / E38 / E39** interleave anywhere — they are the sweep's long
   tail and are the natural filler between heavy epics.
9. **E36** whenever the owner sits. **E33** last, or back in Phase 4.

---

## Exit criteria (Phase 3 ships when)

0. **The write half of git is real:** a hunk can be edited in the diff pane and
   committed from it, and a worktree branch squash-merged to main with a review
   step — without dropping to a terminal. (E24)
1. **A file can be found and read:** a Files tab shows the project tree with VCS
   decorations, every file type opens in a viewer, and open viewers survive
   relaunch. (E25)
2. **Every session's pending approval is answerable from one surface**, arrowed
   through and batch-grouped. (E26)
3. **A subagent gets its own watcher window** and its attention bubbles up to the
   undercard tray without stealing focus. (E27)
4. **A turn can be rolled back, and the rollback undone.** (E28)
5. **Auto-dispatch runs a bounded loop with seatbelts on:** done + tests pass →
   clean-room review → bounded fix/re-review. (E29, after E28)
6. **Usage is visible per-session and fleet-wide, and invents no numbers** — an
   unknown model must not silently price as Sonnet. (E26)
7. **OQ #9 is answered empirically**, from 7–8 real branches rather than from
   argument, and the worktree flows were designed from the answer. (E24)
8. **The app feels responsive on the LAPTOP at 3+ sessions**, demonstrated by
   measurement on the owner's own hardware — not by a synthetic throttle. (E23)
9. **Litmus test passes on everything shipped** (PHILOSOPHY §4) — the standing
   per-item gate.
10. **(NEW, and it is the lesson of Phase 2's cut.) Hand-testing is not a
    backlog.** Every user-facing item shipped in this phase is hand-tested and
    recorded in `docs/plans/dogfood-testing.md` **before the phase cuts**, and no
    exit criterion above is ticked on the strength of an e2e alone. Phase 2 cut
    with 20 tested against 116 untested and with criterion 5 resting entirely on
    `dispatch.spec.ts`; that was a legitimate call made once, with eyes open. It
    is not a precedent.
