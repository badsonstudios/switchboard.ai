# Phases 2–4 — Outlines

Deliberately thin: detailed work items get written just-in-time when the prior
phase nears exit (see 00-process.md). The authoritative feature list per phase
is DESIGN.md §8; this file only adds sequencing intent and planning notes.
Bulk-filing issues from this file is explicitly against process.

## Phase 2 — The Switchboard
*Theme: sessions become aware of each other; attention system matures.*

**Broken out → `docs/plans/04-phase-2-switchboard.md`** (epics E7–E14;
milestone "Phase 2 - The Switchboard", opened 2026-07-20; reconciled against
DESIGN.md §8 on 2026-07-21 — the original E7–E11 break-out had dropped several
§8 items, restored as E13/E14 + additions, with three items demoted to
Phase 3). Original planning notes retained below.

Planning notes for when this gets broken out:
- **Approval surfaces v1 is the crown jewel** of the phase (owner's #1 pain) —
  sequence it early, not last; it depends only on the S-03 verdict + Monaco.
- Attention-driven layout + presentation ladder next (the 7-8 session
  experience), then Session Bus + context transfer (the signature features),
  then dispatch v1, pop-outs/multi-monitor, fleet snapshots.
- Feed view v1 and notifications v2 can interleave anywhere.
- Empirical spike embedded in this phase: OQ #9 (merge-conflict endgame) wants
  its 7-8-real-branches experiment once parallel worktree use is real.

## Phase 3 — The IDE
*Theme: review, safety, and fleet-level surfaces.*

Planning notes:
- **`utilityProcess` offload — plan it WITH the plugin host, not after**
  (added 2026-07-26, architecture review AR-P2-14). `src/main/index.ts` is a
  600-line monolith doing windows, popout geometry, the static server, five
  subsystems' IPC, git, notifications, and preflight — on the one thread that
  also pumps every PTY. When work has to move off it, the candidates are git
  shell-outs and transcript parsing, and the mechanism is Electron's
  `utilityProcess` — **the same mechanism §5.23 names for the Phase 4 plugin
  host**, and the same one VS Code built its extension host on. That makes the
  Phase-2/3 throughput fix and the Phase-4 substrate one piece of work. Trigger
  to schedule it: P2-E15-14's real-app perf re-measure showing main-thread
  contention, or the first plugin-host design session — whichever comes first.
- **OQ #8 (ClaudeMon) is CLOSED — we are not integrating** (2026-07-29, owner's
  call). Usage tracking is first-party and native (DESIGN §5.13); ClaudeMon
  stays a separate product; the idea is parked in DESIGN §10 with its reversal
  trigger. **This unblocks Phase 3 planning** — it was the last gate on it.
  What does NOT go away is the code consequence: `estimateCostUsd` bakes model
  pricing into the renderer's UI layer (`lib/usage.ts`, AR-P2-12). With no
  shared engine coming, that logic needs a home in main/shared **here**, and
  the current implementation is wrong in ways DESIGN §5.13 now spells out —
  notably it defaults an UNKNOWN model to Sonnet rates, i.e. it invents a
  number. Fix when usage work is scheduled; it is not urgent, but it is not
  waiting on anything either.
- **Inherited from Phase 2** (2026-07-21 reconciliation, now in DESIGN.md §8
  Phase 3): watcher windows + undercard tray + attention bubbling (§5.6,
  §5.24) · tray mode + session archive v1 (§5.25) · fleet snapshots + layout
  DSL v1 + restore confirm gate (§7, OQ #14/#15). Include them when this phase
  gets broken out.
- Checkpoint & rollback v1 (§5.28) should land BEFORE dispatch v2's
  auto-dispatch loops — autonomy without seatbelts inverts the risk order.
- Cross-session review dashboard + mission-control dashboard + the usage
  surfaces (§5.13) share data plumbing — plan those three together. (Was
  "share plumbing with ClaudeMon integration"; the third leg is now our own
  usage engine.)
- **Document viewer v2 belongs with the file tree** (added 2026-07-30). Phase 2's
  E16 ships the markdown half — rendered view, source toggle, a tab per file
  (the peek slot it shipped with was removed by #530), viewer window, the
  `fs.read` capability (DESIGN §5.30). What is left is the same
  surface as §5.7's file tree and should be planned as one epic, not two: the
  **Files** tab + tree with VCS decorations, the full file-type dispatch
  (code / image / JSON / JSONL / CSV, and a card for binaries), follow-tail for
  append-shaped files, and restoring open viewers across relaunch. Planning it
  separately would build two file-navigation surfaces that disagree.

## Phase 4 — The Ecosystem
*Theme: beyond Claude, beyond the desktop, beyond first-party.*

Planning notes:
- **User manual build (added 2026-07-24, owner request).** `docs/manual/*.md`
  is written page-by-page as features ship (see `00-process.md` → User
  documentation). This item turns that folder into the shipped manual: a
  static-site build (Markdown → HTML, table of contents from the index,
  searchable, themed to match the app), a screenshot pass, an in-app **Help**
  entry pointing at it, and a `TODO:`/stub-page audit that fails the build on
  unfinished pages. Deliberately late — the manual should compile content that
  already exists, not become a writing project. Pull it earlier if the app
  reaches outside users first (public release triggers it regardless).
- Adapter order by likely demand: Codex → Gemini → Aider → generic.
- Plugin API alpha gate: only after 2-3 dissimilar internal consumers exist on
  the seams (§5.23) — check the registry's actual consumer list before
  scheduling. **Status 2026-07-26:** the count was 1 and *structurally could
  not grow* — the seam covered the main process only, while 8 of the 9
  first-party roster items are renderer contributions (architecture review
  AR-P0-2). Phase 2's **E15** fixes that and should land the count at 4+ as a
  byproduct of rewiring code that already exists. Re-check the roster table in
  `docs/extensibility.md` — which states the real number — when this phase is
  broken out. **Third-party support is a confirmed goal** (owner, 2026-07-26),
  so E15-04's capability enforcement point is what this phase wires plugin
  manifests into; it should not need to invent a permission model.
- **Plugin host prerequisites now partly paid by Phase 2** (2026-07-26): E15
  delivers the contribution points, the capability vocabulary + choke point,
  and header-based CSP (E15-12 — load-bearing the moment a sandboxed webview
  panel exists). What remains genuinely Phase 4: the `utilityProcess` host
  itself, typed RPC, activation events, Tier-1 webview panels, and any
  install/distribution path.
- Mobile companion's security policy questions (OQ #12) need answers before its
  first line of code.
- Packaging/public-release items trigger the name check (OQ #6) as a hard
  prerequisite.
