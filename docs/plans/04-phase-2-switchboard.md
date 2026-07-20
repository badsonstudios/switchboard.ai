# Phase 2 — The Switchboard

**Theme:** sessions become aware of each other; the attention system matures;
the session window grows up (richer cards, layout modes, pop-outs).

**Prerequisite:** Phase 1 merged (the app shell, session core, hooks,
transcripts, git, persistence). Authoritative feature list: DESIGN.md §8
"Phase 2". This file breaks it into epics + work items.

**Sequencing intent (why this order):** DESIGN's §8 notes call Approval
Surfaces the crown jewel and suggest it early. We deliberately open instead
with **E7 Richer Cards** — it wires data the app already collects (transcript
tokens, git status, state machine, autonomy) into the session card, so it's a
fast, low-risk, visibly-satisfying win and the thing the owner asked for first.
Pop-outs (E8) follow because the Phase-1 display-fingerprint groundwork already
exists. Then the heavier signature epics: presentation/attention (E9),
approvals (E10), and the Session Bus (E11).

**Epics:** E7 Richer session cards · E8 Pop-out & multi-monitor · E9
Attention-driven layout · E10 Approval surfaces v1 · E11 Session Bus & context
transfer. (E9/E10/E11 work items get filed just-in-time as E7/E8 near exit —
per `00-process.md`, we do NOT bulk-file the whole phase.)

---

## E7 — Richer session cards (Identity v2 + live telemetry)

*Goal: a card tells you what the session is, what it's doing, and what it's
costing — at a glance. Uses existing data; mostly UI wiring.*

- **P2-E7-01 · Live usage & cost on the card — M (§5.13).** Surface the
  TranscriptWatcher's per-session token totals (in/out/cache) + a derived cost
  estimate as a compact usage bar in the card header and rail row. Aggregate
  total in the status bar.
  *Done when:* a running session shows live-updating tokens and an estimated
  cost; the status bar shows the workspace total; numbers survive a resume.
- **P2-E7-02 · Git context line — S (§5.11).** A one-line branch + dirty-count
  indicator on the card header, from GitService (already built), refreshed on
  focus and on Stop.
  *Done when:* the card shows `⎇ branch ·  N changed` for a repo folder,
  nothing for a non-repo, and it updates after the agent edits files.
- **P2-E7-03 · Autonomy badge + editable task label — S (§5.11).** Show the
  session's autonomy mode as a badge on the card; let the user set a freeform
  task label (persisted with the card record) distinct from the folder title.
  *Done when:* the badge reflects the spawn autonomy; a task label round-trips
  across restart.
- **P2-E7-04 · Plan-as-progress chip — M (§5.11, OQ #13).** Extract TodoWrite
  plan state from the transcript (S-05 proved viable) and render a compact
  "3/5 steps" progress chip on the card; degrade to the task label when no plan
  is present.
  *Done when:* a session running a TodoWrite plan shows live step progress; a
  session without one shows no chip and does not error.
- **P2-E7-05 · Suspended cards in the rail — S.** Close the Phase-1 gap: the
  rail lists ALL cards (from `knownCards`), suspended ones included, so a
  restored-but-not-yet-resumed session is navigable from the rail, not only the
  grid. Clicking a suspended rail row focuses + resumes it.
  *Done when:* after relaunch, every restored card appears in the rail before
  it is focused, with a "suspended" affordance.

**E7 exit:** a 5-session workspace reads at a glance — identity, live status,
cost, git, and plan progress — and the rail mirrors every card. Litmus
(PHILOSOPHY §4) checked on each visible surface.

---

## E8 — Pop-out & multi-monitor (outline; work items filed at E7 exit)

*Goal: tear a session card out into its own OS window and place it on any
monitor; geometry persists and rescues like the main window does.*

Planning notes:
- dockview-react supports floating/pop-out groups + tab tear-off natively —
  validate that path first (spike-sized) before committing the work items.
- Reuse the Phase-1 display-fingerprint + missing-display rescue (workspace
  store already has it) for popped-out window geometry.
- Pop-out windows are orchestrator-owned Electron subwindows over the shared
  session core (DESIGN §7): the PTY/hooks/transcript stay in main; only the
  render surface moves.
- Open question to resolve early: how a popped-out card rejoins the grid, and
  what happens to its layout slot while out.

---

## E9 — Attention-driven layout (outline)

Layout modes (grid/focus/queue), attention queue + hotkeys (Ctrl+Space / Ctrl+
1..9), idle collapse, urgency strip, presentation ladder, pinning contract,
batch permission handling (§5.8). Filed just-in-time.

## E10 — Approval surfaces v1 (outline — DESIGN's crown jewel)

The in-app approve/deny UI over the S-03 HOOK PATH: PreToolUse hold → card
flips to a review bar (diff + allow/deny/allow-all) → decision returned to the
CLI. Depends only on the S-03 verdict + Monaco (both in hand). §5.16.

## E11 — Session Bus & context transfer (outline)

Session Bus MCP server (`list/get/send/publish`), @-references in a prompt
composer, drag-drop text/files between sessions, context chips + summary
handoff (Level 2). The signature "sessions aware of each other" feature.
§5.2–5.5.

---

## Exit criteria (Phase 2 ships when)
1. The 7–8 session experience works: cards are information-rich, attention
   routing (queue + hotkeys) is the primary workflow, idle sessions collapse.
2. A session can pop out to a second monitor and rescue on display change.
3. In-app approvals handle a real permission prompt without dropping to the TUI.
4. Two sessions can exchange context via the bus.
5. Litmus test passes on everything shipped.

## Order
E7 first (fast win, owner's ask) → E8 (groundwork exists) → then E9/E10/E11
sequenced by feedback; approvals (E10) can jump ahead if the manual TUI
approval flow becomes the daily pain the design predicts.
