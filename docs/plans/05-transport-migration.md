# E18 — The stream-json transport migration

**Milestone:** Phase 2 — The Switchboard (epic E18; next free epic number)
**Status:** planned 2026-08-01. **E18-01…E18-10 filed 2026-08-01 as issues
#131–#140** (in order), plus **#149 (E18-08b)** when E18-08 was split;
E18-11…E18-16 deliberately unfiled — see *What is NOT
fileable yet* below.

**Theme:** switchboard stops emulating a terminal and starts speaking the CLI's
own protocol. `StreamService` lands **beside** `PtyService` behind a per-session
flag; the feed, transcript stack, state machine and extensibility registry all
survive the cut.

---

## Why this epic exists (the short version)

Our entire approval path rides **PreToolUse hooks**, which is a workaround. It is
blind to anything the CLI decides *above* the hook layer, and on 2026-08-01 that
stopped being theoretical:

- Editing a file in a project's own `.claude/` folder prompted the owner
  **twice** — our bar, then the CLI's own terminal prompt six seconds after he
  allowed it. Measured in the log, not inferred. The CLI honours a hook's
  `permissionDecision:"allow"` for the ordinary permission layer, then applies
  its `.claude/` safety check **on top**, which a hook verdict does not satisfy.
  **His answer was discarded.**
- The *identical* write arrived over stream-json as a `can_use_tool` control
  request with `decision_reason_type:"safetyCheck"`. We answered allow and
  **the file was written, with no second prompt** (S-10 probe B).

⇒ **The same verdict is worth less from a hook than from the permission-prompt
channel. Our approval path is structurally second-class.** That is the epic's
one-sentence justification.

**S-09 closed the cheap door:** `--permission-prompt-tool` is honoured under
`--print` and **silently ignored by an interactive TUI session**. There is no
flag that gives switchboard the permission prompt while it hosts a TUI.

**PHILOSOPHY P7 was amended 2026-07-31 (§6 Amendments)** to permit this:
fidelity to the CLI's behaviour is the invariant; the terminal was one transport
for it. The amendment explicitly did **not** decide that the terminal goes away.

> ## ▶ THE OWNER HAS NOW DECIDED IT: **THE TERMINAL IS GOING.**
>
> Dan, 2026-08-02, declining to hand-test a change in Terminal mode: *"We're
> going to be dropping Terminal Mode anyway once we get Direct Mode completely
> tested here and working."*
>
> **The condition is real and it is the only one: Direct mode has to be tested
> and working first.** This is a direction, not a date, and nothing is deleted
> until it is met.
>
> **▶ UPDATE 2026-08-09 (#381): the default is flipped.** Dan: *"all sessions
> default to direct mode. not terminal."* Every card that has never chosen a
> transport now starts in Direct; a card that explicitly chose keeps its choice,
> Terminal included. This is the condition above being worked on rather than
> waited for — real use is what tests Direct mode, and nothing was going to be
> in real use while the mode had to be found in a menu. Point 3 below hardens
> slightly as a result: PTY mode must keep working, and it is now reached by an
> explicit per-card choice or `SWITCHBOARD_TRANSPORT=pty`, not by doing nothing.
>
> **What this changes in the plan, concretely:**
>
> 1. **E18-16 is no longer a decision, it is an execution.** It used to ask
>    *whether* the terminal is deleted or kept as an escape hatch. That is
>    answered. What remains is sequencing and what gets dropped honestly.
> 2. **E18-11 changes job, exactly as S-11 did before it.** It was a go/no-go —
>    *"if either chooser is CLI-kept, the terminal stays"*. It is now a scoping
>    probe: a CLI-kept chooser becomes **a gap to build for or to accept and
>    document**, not a reason to keep a terminal. The measurement matters as
>    much as it ever did; only the question it answers has changed.
> 3. **Terminal-mode behaviour stops being a testing obligation.** Regressions
>    there are worth knowing about and are no longer worth blocking on. What
>    must not slip: PTY mode has to keep WORKING until the flip, because it is
>    the fallback while Direct mode is being tested.
> 4. **Anything that exists only in a terminal is now a known loss, not an open
>    question** — Ctrl-R history, vim mode, and the `/resume` · `/rewind` ·
>    `--from-pr` pickers. Each is rebuilt properly, or dropped and SAID so in
>    the manual. Screen-scraping is rejected precedent (§5, P7) and stays
>    rejected: a decision the CLI keeps we may never fake.
>
> **What it does NOT change.** The litmus test still applies to whatever
> replaces each terminal-only affordance, and P7's hard line is untouched. The
> decision is *the terminal goes*; it is not *therefore anything is permitted
> in its place*.

**Sources.** `spike/findings/s-10-stream-json-transport.md` (what the transport
costs — the blast-radius table is §4), `spike/findings/s-09-permission-prompt-tool.md`
(why the cheap route is closed), and the S-11 probe notes (long-run stability;
findings note pending). **When a CLI contract is unclear, read
`docs/reference-implementations.md` before guessing** — the VS Code extension is
unpacked on this machine and is a known-correct consumer of every contract this
epic touches.

---

## What we are NOT re-litigating

Recorded so no item re-opens it:

- **WHETHER — decided.** P7 amended; the owner's call, 2026-07-31.
- **VIABLE — measured.** S-10, against the PATH CLI on the subscription. No API
  key; `rate_limit_event` reports the same five-hour/weekly windows.
- **SEQUENCING — known.** Beside, not instead of, behind a per-session flag. The
  VS Code extension keeps both modes itself (`claudeCode.useTerminal`, default
  false), which is the precedent.
- **The transcript stack survives.** The JSONL is still written in stream mode,
  so `watcher.ts` / `drift.ts` / binding / #107's contract keep working
  **through** the migration rather than needing replacement in the same step.
  (The stream also carries `transcript_mirror`, so they become redundant later,
  on their own schedule — not this epic's problem.)

## What this epic does NOT claim

- ~~It does not decide the terminal is removed. E18-16 does, on S-11's
  evidence.~~ **SUPERSEDED 2026-08-02 — the owner decided it: the terminal goes,
  once Direct mode is tested and working.** See the decision block above. E18-16
  now executes that rather than settling it; S-11's chooser probes scope the
  loss instead of gating the direction.
- It does not touch the Session Bus (E11). The one thread that used to tie them
  together — "permission delegation would be the first customer for E11's `mcp`
  capability" — was **cut by S-09**: permission delegation rides the stream-json
  control channel, not MCP. E11 remains a separate epic about sessions talking
  to *each other*.

---

## Two measured facts every item must respect

1. **`system:init` is emitted ONCE PER TURN, not once per session** (S-11: 4
   turns → 4 `system:init`). A host that treats `init` as a one-time event —
   which is exactly how one naively consumes it for `slash_commands` — will
   re-initialise on every turn. E18-05 and E18-09 both pin this with a test.
2. **Child RSS is ~300–380 MB for ONE idle-ish session** (3 processes:
   cmd.exe → claude.cmd → node). The product targets 8 concurrent sessions, so
   that is ~2.4–3 GB of CLI before switchboard's own footprint. Not a blocker,
   but it is the migration's cost column and it belongs in **#111**'s
   re-measure.

**Backpressure is answered, and it is good news.** S-11 stopped draining stdout
for 150 s mid-turn: **359,003 bytes piled up behind us and arrived intact — 0
parse failures, the turn completed with its full output, and the process never
died.** A message written to the CLI *while it was blocked* was queued, not
lost. The #112/#117-class deadlock we most feared did not reproduce. E18-03
still must never pause its reader — but it does not need heroics.

---

## Work items

### E18-01 · DESIGN.md amendment: the transport is a choice — S (docs only) — [#131](https://github.com/badsonstudios/switchboard.ai/issues/131)

**What.** DESIGN.md describes a PTY substrate in ~30 places (§6 stack rationale,
§5.10 view set, §5.16 approvals, the architecture diagram, §5.9's Esc-to-PTY,
§5.28's `/reload-plugins` injection). PHILOSOPHY P7 has been amended; DESIGN has
not. Amend it **before** code, so no later PR silently forks the design or
re-argues the decision in review.

Scope: an amendment note recording the transport as a per-session choice, the
§6 stack entry gaining `child_process` + NDJSON beside `node-pty`/xterm, and the
§5 sections that assert "sends a keystroke to the PTY" reworded to "sends the
input to the session's transport". **Not** a rewrite — DESIGN keeps describing
PTY hosting, because PTY hosting still ships.

*Done when:* §6 records both transports and why; every §5 line that names the
PTY as *the* input route names the transport instead; the amendment cites P7 §6,
S-09 and S-10 by name; no code changes. (The pointer from
`docs/plans/04-phase-2-switchboard.md` was added when this plan was written.)
*Depends on:* nothing.

### E18-02 · The transport seam — S — [#132](https://github.com/badsonstudios/switchboard.ai/issues/132)

**What.** Make the transport a declared choice rather than a hardcoded
`PtyService`. `SessionManager` already takes a narrow `PtyLike` (spawn/remove;
pid/onExit/kill) — widen it to a `SessionTransport` interface, add
`SpawnRecipe.transport?: 'pty' | 'stream'` (defaulting to `'pty'`) so the
adapter declares what its recipe wants, and route on it. **No `StreamService`
yet.** Pure refactor: PTY remains the only implementation and behaviour is
byte-identical, which is what makes every item after this one purely additive.

*Done when:* all existing unit + e2e tests pass **unedited**; `SpawnRecipe`
without `transport` still spawns a PTY; a test adapter declaring `'stream'`
fails loudly ("transport not implemented") rather than silently receiving a PTY;
the S-01 env scrub (`buildEnv`, `SCRUB_ALWAYS`) moves somewhere both transports
import, with one copy of the landmine list.
*Depends on:* E18-01.

### E18-03 · StreamService: spawn, NDJSON framing, lifecycle — M — [#133](https://github.com/badsonstudios/switchboard.ai/issues/133)

**What.** The sibling service. `child_process.spawn` over pipes —
**`windowsHide: true` on every spawn** — line-delimited JSON framing with
partial-line buffering, a bounded ring of parsed messages (the scrollback
analogue), stderr captured separately and logged, and the PtyService lifecycle
logic (dead-process write guard, exit codes, listener-exception swallowing)
ported near-verbatim. Not wired into the app yet: driven by unit tests and a
`lifecycle-check` sibling.

**`windowsHide` is called out because it has already bitten us.** S-11's first
run set it on the interesting spawn and missed it on the boring one, and flashed
a console window on the owner's desktop 96 times over 8 hours. *Every* spawn on
Windows needs it.

*Done when:* framing survives a message split across chunks, several messages in
one chunk, and a single ~500 KB message; a partial trailing line is held, not
dropped; **the stdout reader is never paused** (a test asserts we consume on
`data` unconditionally, since S-11 proved the CLI blocks and recovers rather
than corrupting); malformed JSON increments a counter and is logged **without**
killing the pump (fail-open, P6); kill resolves `onExit`; no console window
appears on Windows.
*Depends on:* E18-02.

### E18-04 · The stream-json fake provider — M — [#134](https://github.com/badsonstudios/switchboard.ai/issues/134)

**What.** **The precondition, and it is missing from S-10's blast-radius
table.** `providers/fake.ts` spawns the OS shell in a **real PTY**, and all 98
e2e tests plus the entire CI-safe-without-a-login property rest on it. Stream
mode has no fake at all. A fake that speaks stream-json — emits `system:init`
(with a `slash_commands` list), `stream_event` deltas, `assistant`, `result`,
and can be *told* to raise a `can_use_tool` control request and to await our
answer — is a **precondition for testing stream mode, not a follow-on.**

Scriptable from the spec side, so a test can say "next turn, ask permission for
a `.claude/` write" without a login or a network.

*Done when:* ~~an e2e drives a full turn in stream mode against the fake~~
**(CORRECTED — see below)**; a control request round-trips (raise → our answer →
the fake proceeds or aborts); the fake honours `--input-format stream-json`
framing exactly as the real CLI does; **the existing PTY fake is untouched and
all 98 existing e2e tests still pass**; CI needs no `claude` login.

> **Done-when correction, made while building it (2026-08-01).** The first
> criterion was unmeetable by this item, and it was a planning error here rather
> than a shortfall there: driving a full turn *end to end* needs session wiring
> (E18-05) and a way to CREATE a stream session from the UI (E18-08). E18-04
> only builds the fake. The turn is proven two other ways —
> `fake-stream-protocol.test.ts` (synchronous, runs in the CI unit job) and
> `npm run check:fake-stream` (the compiled program over real pipes, driven
> through the real `StreamService` and the real adapter recipe) — and **the e2e
> criterion moves to E18-08**, where it first becomes possible. Recorded rather
> than silently redefined.

*Depends on:* E18-03.

### E18-05 · Session status and lifecycle from the stream — M — [#135](https://github.com/badsonstudios/switchboard.ai/issues/135)

**What.** In PTY mode the state machine is fed by hook events. In stream mode
the messages themselves are the signal: `system:init`, assistant start,
`result`, `rate_limit_event`, exit. Feed the existing state machine from them —
same statuses, same transitions, new source. Hooks stay live in PTY mode and are
not touched.

**Pin the once-per-turn fact.** `system:init` arrives on every turn; a second
one must not re-initialise the session, reset its native id, or re-derive
anything treated as start-of-session.

*Done when:* a stream session walks starting → idle → working → idle across
three turns driven only by stream messages; a second and third `system:init`
change nothing (explicit test, named for the finding); `killRequested` still
distinguishes a wind-down from a crash; the native session id is learned from
`system:init.session_id` and `/clear`'s new conversation is detected (the #107
`/clear` rule still holds).
*Depends on:* E18-04.

> **2026-08-10 (#404):** the "learned from `system:init.session_id`" half was
> found unimplemented after this item closed — the only writer of the native id
> was the hook listener's SessionStart. Landed in #404 slice 1, together with
> the measurement the code had been calling UNMEASURED: hooks DO fire under
> `--input-format stream-json` (claude 2.1.226), which is why nothing had
> visibly broken. The stream fake now honours `--resume`, and a relaunch e2e
> pins the persisted-id → `--resume` journey on the default transport.

### E18-06 · Prompt submission; `composer.ts` deleted — S — [#136](https://github.com/badsonstudios/switchboard.ai/issues/136)

**What.** One `stdin.write(JSON.stringify(msg) + '\n')`. The bracketed-paste
wrapper and the 75 ms delayed CR (S-03) — an entire class of timing bug — stop
existing in stream mode. `--replay-user-messages` gives us a real send
acknowledgment instead of inferring one.

*Done when:* a multi-line prompt containing backticks, a leading `/`, and a
trailing newline arrives **verbatim** (asserted against the fake's received
frames); ~~the replay echo marks the message sent~~ **(MOVED to E18-08 — see the
planning gap below)**; `renderer/lib/composer.ts` is
unreferenced on the stream path (**deleted outright when PTY mode goes in
E18-16**, not before); submitting to a dead child is a no-op, not a throw.
*Depends on:* E18-05.

### E18-07 · `can_use_tool` → the approval bar — M — [#137](https://github.com/badsonstudios/switchboard.ai/issues/137)

**What. The reason the epic exists.** Answer `can_use_tool` control requests
over the pipe we already own, and render what the payload gives us:
`decision_reason` (renderable prose we did not have to write),
`decision_reason_type`, `title`/`display_name`, `blocked_path`, and
`permission_suggestions` (e.g. *"switch this session to acceptEdits"*) as
offered actions. The hold-and-release dance over a local HTTP listener collapses
into replying on a socket.

**The #127 stopgap is scoped OUT of stream mode.** `shouldHoldPermission`
declines edit-family writes into `<cwd>/.claude/` because a hook's allow is
discarded there. Over `can_use_tool` it is **not** discarded, so the carve-out
must not fire in stream mode — that is the whole point. It stays in force for
PTY mode until E18-16.

*Done when:* a write to `<cwd>/.claude/scripts/coverage.sh` raises **our** bar,
and Allow writes the file with **no second prompt anywhere** (the acceptance
test, and it is the exact case that started this); Deny propagates and the CLI
reports the denial; `decision_reason` renders as prose; ~~at least one
`permission_suggestion` is offered as a real action~~ **(BLOCKED — see below)**; a control request that
arrives while the card is closed is answered deny rather than left hanging; the
#127 carve-out is asserted **not** to fire in stream mode and asserted to still
fire in PTY mode.
*Depends on:* E18-05.

### E18-08a · A real stream session runs — M — [#138](https://github.com/badsonstudios/switchboard.ai/issues/138)

**What.** The back half. Everything needed for a real stream session to spawn,
take a prompt and finish a turn — with no UI to select it, exactly as the two
fakes are selected today.

**Split from a single E18-08 on 2026-08-01, because it had become an L** and
`00-process.md` says an L is split before work starts. It grew that way for
reasons worth naming: it absorbed the e2e-drives-a-turn criterion from E18-04,
`--replay-user-messages` from E18-06, and a **planning gap nobody owned** — the
real adapter's stream recipe. On top of that, **`StreamService` is still not
constructed anywhere**: every item so far has driven it from tests.

Scope: `providers/claude.ts` builds S-10 §1's flags (`--output-format
stream-json --verbose --input-format stream-json --permission-prompt-tool
stdio`, copied from the SDK's own arg builder) and declares `transport:
'stream'`; `StreamService` is constructed in `index.ts` and handed to
`SessionManager` and `StreamPermissions`; `--replay-user-messages` acknowledges
a sent prompt.

*Done when:* a stream session spawns, takes a prompt and reaches `done` — driven
by an **e2e against the E18-04 fake** (the criterion inherited from E18-04, and
the first point it is meetable); the replay echo marks a prompt sent; the real
adapter's stream recipe matches S-10 §1 flag for flag, asserted against the
findings note rather than reconstructed from memory; **all 98 PTY e2e tests
still pass**.
*Depends on:* E18-07.

### E18-08b · Turn stream mode on — M — [#149](https://github.com/badsonstudios/switchboard.ai/issues/149)

**What.** The front half: the user-facing choice, and being honest about what
changes when they make it.

Scope: a per-session transport setting (default **PTY** when this item shipped;
**inverted to Direct on 2026-08-09 by #381** — see the update in the decision
block above), persisted with the session record and
surfaced at session creation; the **Terminal tab explains itself** in a stream
session rather than showing an empty black pane; switching a **running**
session's transport refused with a reason.

**The Feed needs no work** — the JSONL transcript is still written in stream
mode (S-10), so the existing transcript-driven Feed renders a stream session
as-is. E18-10 is an upgrade to that, not a prerequisite.

*Done when:* a new session can be created in stream mode from the UI; the choice
survives a relaunch; the Terminal tab in a stream session explains itself in one
sentence and offers no dead controls; the Feed renders a stream session's turn
via the existing transcript path; switching a running session's transport is
refused with a reason, not silently ignored; **user documentation written** —
this is the first user-visible surface of the whole epic.
*Depends on:* E18-08a.

### E18-09 · Slash commands from `system:init` — S — [#139](https://github.com/badsonstudios/switchboard.ai/issues/139)

**What.** `CLAUDE_BUILTIN_COMMANDS` in `main/providers/claude.ts` is 40
hand-curated builtins that the file itself calls "version-volatile by nature… a
maintenance chore". `system:init.slash_commands` came back with **59 entries
including this machine's own project and user commands** (`/startup`,
`/check-code`, the android-* set) — ground truth, plus commands we could never
have enumerated.

Feeds the existing composer autocomplete (P2-E10-07) through the existing
`slashCommands()` adapter contract; no new contribution point.

*Done when:* the composer popup in a stream session lists this machine's own
`/startup`; the list refreshes if `system:commands_changed` arrives; a session
that has not yet received `init` falls back to the hand-curated list rather than
showing nothing; **a second `system:init` replaces rather than appends** (the
once-per-turn fact, again); the hand-curated list stays for PTY mode and is
deleted with it.
*Depends on:* E18-05.

### E18-10 · Feed from typed messages — M — [#140](https://github.com/badsonstudios/switchboard.ai/issues/140)

**What.** Same blocks, better source: typed messages and token-level
`stream_event` deltas instead of file-poll latency. The block shapes, the
renderer contribution points and `lib/feed.ts` all survive — this changes what
feeds them.

**Sidechain rendering is explicitly out of scope here** — `parent_tool_use_id`
is on every message, but driving our S-05 sidechain rendering from it is
unmeasured and is E18-13, behind S-11.

*Done when:* assistant text appears token-by-token in a stream session rather
than in file-poll bursts; every existing Feed block type renders from the stream
source; the transcript-driven path still renders PTY sessions unchanged (both
sources, one renderer, one test matrix); a stream session that never receives a
`result` does not leave a block open for ever; **a local slash command's output
appears in the Session view** (#156 — the named case Dan added, evidence in
`spike/findings/s-11-local-slash-commands.md`).
*Depends on:* E18-08.

**Shipped 2026-08-02**, then **reopened the same day by Dan's hand-test and
fixed** — see `spike/findings/s-11-slash-commands-and-message-shape.md`. Two
measured corrections: (1) the composer's autocomplete claimed **Enter**, so a
slash command typed IN FULL was completed rather than sent and NONE of them ran,
in either transport; (2) the real CLI emits **one `assistant` message per
content block, mid-stream, each reporting content index 0**, so an
index-only reconcile duplicated every block after the first. The fake sent the
kinder shape and hid both. Original entry follows.

**Shipped 2026-08-02.** Both sources now run the SAME derivation
(`main/feed/blocks.ts` + `main/feed/buffer.ts`, extracted out of the watcher), so
a block cannot look one way from a transcript and another from a stream. The
stream source is `main/feed/stream-feed.ts`; a stream session's watch is created
with `deriveFeed: false` so exactly one source is live per session. The adapter
gained `--include-partial-messages`. **#156 was fixed on BOTH transports**: the
stream delivers a local command as an ordinary `assistant` message, and the
shared derivation now also renders the transcript's `system`/`local_command`
entry with the `<local-command-stdout>` wrapper stripped — as an *assistant*
block, deliberately, so one output cannot render two ways.

---

## Behind S-11 — do not file, do not start

These are gated on the S-11 probes, and the gate is real: **the ones that turn
out to be *choosers* are what decide whether the terminal survives as an escape
hatch.** Probe 1 (long-run stability) is running; probes 2–6 are unstarted.
Writing done-when criteria for these now would be writing them against guesses.

### E18-11 · Plan mode, `ExitPlanMode` and `AskUserQuestion` — M [S-11 gate]

The two choosers. `--permission-mode plan` sets the mode, but plan approval is a
TUI interaction: does it arrive as `can_use_tool`, or does it need a control
request we have not seen? `AskUserQuestion` is the same question in the shape
that most looks like *"interaction the CLI owns"* under P7.

**The `AskUserQuestion` half SHIPPED 2026-08-17 (#563, owner priority).** It is
**not** CLI-kept: it is delegated over the very `can_use_tool` channel the
approval bar already consumes, and the answer rides back as `answers` written
onto `updatedInput`. Measured across five probe modes against the CLI on PATH —
`spike/findings/s-11-ask-user-question.md`, probe
`spike/s11/probe-2-ask-user-question.cjs`. Two findings changed the design
rather than merely confirming it: a bare allow (what allow-all would send) is
read as *"The user did not answer the questions"*, so questions are exempt from
both allow-all paths and from the OS toast's buttons; and an unanswered question
parks **for ever** — 180s with no TUI fallback and no CLI-side timeout — which
makes the existing 300s fail-open the only thing between it and a wedged session.

**Extended 2026-08-19/20 (#567):** two more probe modes closed the hole #563
left open — a **partial** `answers` map (a question's key omitted) and a
**blank** one (the key present, `""`). Both are accepted like a complete answer,
byte-identically, and the CLI strips empty-string values before writing its
`tool_result`, so an unanswered question reads as **skipped** and can never be
handed to the model as answered-with-silence (findings §3a). **Send answer**
therefore gates on one answer rather than all of them, and the panel shows what
a send would leave out. Still unmeasured, and still refused by
`answersLookRight`: an `answers` key holding **zero** entries.

**Still open here: plan mode and `ExitPlanMode`,** which remain unmeasured. The
gate stands for that half.

~~**If either is CLI-kept, the terminal stays**~~ — **no longer true as of the
owner's 2026-08-02 decision.** A CLI-kept chooser is now a **gap to build for or
to accept and document**, not a reason to keep a terminal. This probe still
comes before E18-16, because it is what says how much is being given up — but it
no longer holds a veto.

### E18-12 · Session controls as control requests — M [S-11 gate]

`interrupt`, `set_permission_mode`, `set_model`, `rewind` become first-class
operations instead of keystroke injection (§5.9's Esc-to-PTY becomes a real
interrupt). `interrupt` is in the protocol and has never been exercised.

### E18-13 · Sidechains from `parent_tool_use_id` — M [S-11 gate]

Drive the S-05 sidechain rendering from the field that is already on every
message. Unmeasured against our feed. **Note from #395 (2026-08-11):** a
resumed Direct card's replay reads only the main conversation file, so
subagent sidechains are absent from replayed history too — a visible
difference vs a resumed Terminal card. This item owns both the live and the
replayed sidechain path when picked up.

### E18-14 · Transport-matrix e2e — M [issue #416, filed 2026-08-11]

The specs that assert against terminal output or the hook path —
`real-claude`, `reconnect`, `session`, `approval`, `binding`, `slash-commands`,
`split` — get run against **both** transports where the behaviour should be
identical, and split where it should not. ~~Sized after E18-11 tells us how many
behaviours genuinely differ.~~ **Sized 2026-08-11 by the #404 audit** (37 of 39
e2e spec files silently run the PTY; the port list — permissions, attention,
feed — is in #416).

**Shipped 2026-08-11 (PR #430):** 11 Direct-mode e2e tests in 3 files, all on
the app's REAL default (no transport var): permissions (Deny, queueing,
cross-session band, crash-releases-hold), attention (lamp/queue/Events/jump,
§5.8 focus policies), feed (blocks, Edit diffs, Bash IN/OUT, verbosity, #174
keyboard walk, #196 landmark, tail pin). Three new fake verbs (`!perm a b …`,
`!tools`, `!bulk`) + `fake.test.ts` pinning the PTY fake's refusal. Falsified
by forcing PTY: 8 fail / 3 don't run. **Deferred, priority order:**
presentation-policy/layout-modes on Direct · feed position-restore across a
panel switch · `/clear` feed reset (needs the fake to emit a second
session_id first) · session/reconnect/split ports. No product bugs found —
every ported behaviour was already correct.

### E18-15 · Retire the hook listener — M [gated on the default flip]

`hook_callback` on the control channel can delete the local HTTP listener
outright (`hook-listener.ts`, 27.6 KB + 30.3 KB of tests) along with the
forwarder script and the per-session token files. Only once stream mode is the
default and PTY mode's fate is settled — until then the listener is load-bearing
for every PTY session.

### E18-16 · Cutover: the default flip and the terminal's removal — M

**No longer a decision — an execution.** The owner settled the terminal's fate
on 2026-08-02 (see the decision block at the top of this file). This item flips
the default and deletes `TerminalPane.tsx`, `terminal-attach.ts`,
`shared/ipc/pty.ts`, the #117 epoch protocol, `PtyService` and `node-pty`.

**The one condition, and it is the whole gate: Direct mode tested and working.**
Not "shipped" — *used*, by the person who has to live in it. Until then PTY mode
stays entirely functional, because it is the fallback while Direct mode is being
tested, and a broken fallback turns a bad week into a stopped one.

What is lost, and must be stated plainly in the user manual rather than quietly
dropped: **Ctrl-R history, vim mode, and the `/resume` · `/rewind` ·
`--from-pr` pickers**, plus whatever E18-11 finds is CLI-kept. Each is either
rebuilt properly or dropped honestly. **Screen-scraping remains rejected
precedent (§5, P7)** — the terminal going away does not make faking it
permissible; it makes saying "this is gone" mandatory.

*Sizing note:* this is the item where the epic's cost is repaid — the deletion
list above is most of the 14 load-bearing files in S-10's blast-radius table.

### E18-17 · Cheap transport unit pins — S [issue #417, filed 2026-08-11]

The #404 audit's checkbox-3 batch: adapter-fallback pin, command-rejection
try/catch tests, the `SWITCHBOARD_TRANSPORT` parser extraction + tests,
`PersistedSession.transport` round-trip, fake-ignores-transport pin,
bracketed-paste coverage. Full list in #417.

### E18-18 · Mark transport-scoped specs honestly — S [issue #418, filed 2026-08-11]

Rename/annotate the PTY-by-construction specs (#404 checkbox 4) so their green
stops implying default-transport coverage. Coordinates with E18-14: a ported
spec doesn't also need the rename.

### E18-19 · Renderer transport UI unit tests — S [issue #419, filed 2026-08-11]

The ⋯ transport toggle, mode label, pending-restart affordance, and
StreamTerminalNotice are e2e-only (#404 checkbox 5). Component tests for all
four, pinning the seed-from-default path.

---

## What is NOT fileable yet, and why

**Filed now: E18-01…E18-10.** Every one of them is independent of how the S-11
chooser probes turn out. They build the spine — seam, service, fake, lifecycle,
submission, approvals, the opt-in flag, commands, feed — and by E18-08 the epic
is dogfoodable.

**Unfiled: E18-11…E18-13, E18-15, E18-16.** Their done-when depends on
measurements that do not exist yet. Per `00-process.md` we do not file issues
whose acceptance criteria we know to be unstable. File them when S-11's
findings note lands. **E18-14 and E18-17…19 were filed 2026-08-11 (#416–#419)**
— the #404 audit supplied the measurements E18-14 was waiting on.

## Relationship to the rest of Phase 2

- **E15's remaining items are parked behind this epic, not cancelled** — #109
  (header CSP), #110 (workspace schema migration), #111 (concurrency
  re-measure).
- **#111 is doubly parked.** Its premise is *"measure the shape we are
  keeping"*, and until E18-16 we do not know whether PTY concurrency is that
  shape. It also gains a new question from this epic: the ~300–380 MB per
  session number above is a **stream-mode** cost too, and 8 sessions is the
  target.
- **#129** (a transcript-discovery session that has given up still full-scans
  the root) is unrelated to the transport and can be taken at any time.
- **E11 is untouched.** See *What this epic does NOT claim*.

## E18 exit

A session runs a whole turn over stream-json — prompt, token-by-token output,
tool calls, and **a `.claude/` permission answered once, in switchboard, and
honoured** — with the transport chosen per session and the PTY path still green.
Whether the terminal survives is answered by evidence, recorded in DESIGN.md,
and whatever the CLI keeps for itself is stated plainly rather than faked.
