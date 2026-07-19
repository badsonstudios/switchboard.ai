# switchboard.ai

**An IDE for AI sessions.** One cross-platform desktop app hosting many concurrent
AI coding-agent sessions (Claude Code first, others via adapters) — replacing the
five-VS-Code-windows workflow with one orchestrator: sessions in any folder,
attention routing, inter-session communication, per-session git/diff panes.

Status: **design phase** (started 2026-07-18). No code yet.

## Documents

| File | What it is |
|---|---|
| [DESIGN.md](DESIGN.md) | The working design record — architecture, 23 feature sections, roadmap, open questions, competitive research. |
| [PHILOSOPHY.md](PHILOSOPHY.md) | The constitution — product & session-management principles, layout model, and the feature litmus test every feature must pass. |
| [mockups/main-window-v1.html](mockups/main-window-v1.html) | Static visual mockup of the main window (open in a browser; annotations keyed to DESIGN.md sections). |

## Hard constraints (see DESIGN.md for detail)

- Subscription-first: drives the local `claude` CLI under the user's Claude
  subscription by default; per-session API-key mode optional. Never requires an API key.
- Host, don't reimplement: the real CLI runs in real terminals; we render, route,
  and notify — we never fork agent behavior.
- Local-first: no accounts, no cloud, no telemetry.
- Cross-platform: Windows / macOS / Linux (Electron + TypeScript + xterm.js +
  node-pty + Monaco).

## Next steps

1. Mockup v2 (pending owner feedback on v1 density / event feed / approval loudness)
2. Phase 1 de-risking spike: PTY-host the CLI · hook round-trip for approvals ·
   transcript tailing (proves the three load-bearing mechanisms)
3. ClaudeMon architecture read (settles DESIGN.md open question #8)
4. `git init` this folder
