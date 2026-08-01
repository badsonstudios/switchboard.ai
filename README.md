# switchboard.ai

**An IDE for AI sessions.** One cross-platform desktop app hosting many concurrent
AI coding-agent sessions (Claude Code first, others via adapters) — replacing the
five-VS-Code-windows workflow with one orchestrator: sessions in any folder,
attention routing, inter-session communication, per-session git/diff panes.

Status: **design phase** (started 2026-07-18). No code yet.

## Documents

| Path | What it is |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | The working design record — architecture, 29 feature sections, roadmap, open questions, competitive research. |
| [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) | The constitution — product & session-management principles, layout model, and the feature litmus test every feature must pass. |
| [docs/plans/](docs/plans/) | Implementation plans (spike specs, phase plans) as they're written. |
| [design_handoff_control_room/](design_handoff_control_room/) | Visual design handoff — main-window mockup export with nordic/daylight theme screenshots. |

## Hard constraints (see DESIGN.md for detail)

- Subscription-first: drives the local `claude` CLI under the user's Claude
  subscription by default; per-session API-key mode optional. Never requires an API key.
- Host, don't reimplement: the real CLI does the deciding and the doing; we
  render, route, and notify — we never fork agent behavior, and we never fake an
  interaction the CLI kept for itself.
- Local-first: no accounts, no cloud, no telemetry.
- Cross-platform: Windows / macOS / Linux (Electron + TypeScript + xterm.js +
  node-pty + Monaco).

## Status

**`PROGRESS.md` is the live state** — current item, what's next, and the log.
Read it first; this section only says which phase we're in.

- **Spike 01 — Foundations: DONE.** All three load-bearing mechanisms proved
  (PTY-hosting the CLI, hook round-trip for approvals, transcript tailing);
  retired open questions #2, #3, #5, #10.
- **Phase 1 — MVP: DONE and merged.** Session core, hooks, transcripts, git,
  notifications, persistence + resume-on-focus, auto-trust.
- **Phase 2 — The Switchboard: IN PROGRESS.** Richer cards, pop-out /
  multi-monitor, session groups, the Session tab and approval surfaces are
  merged; attention routing (E9) and the structural foundations from the
  2026-07-26 architecture review (E15) are the current work.
- **Phase 3 / 4** — see `docs/plans/03-later-phases.md`.

> DESIGN.md open question #8 (ClaudeMon integration) was **closed 2026-07-29:
> we are not integrating.** Usage tracking is first-party and native (§5.13);
> the idea is parked in §10 with its reversal trigger.
