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
- Host, don't reimplement: the real CLI runs in real terminals; we render, route,
  and notify — we never fork agent behavior.
- Local-first: no accounts, no cloud, no telemetry.
- Cross-platform: Windows / macOS / Linux (Electron + TypeScript + xterm.js +
  node-pty + Monaco).

## Next steps

1. Phase 1 de-risking spike: PTY-host the CLI · hook round-trip for approvals ·
   transcript tailing (proves the three load-bearing mechanisms; retires open
   questions #2, #3, #5, #10)
2. ClaudeMon architecture read (settles DESIGN.md open question #8)
3. Phase 1 proper: Electron scaffold + day-one architecture (theme tokens, i18n
   strings, logging pipeline) + session manager
