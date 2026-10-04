# switchboard.ai

**An IDE for AI sessions.** One cross-platform desktop app hosting many concurrent
AI coding-agent sessions (Claude Code first, others via adapters) — replacing the
five-VS-Code-windows workflow with one orchestrator: sessions in any folder,
attention routing, inter-session communication, per-session git/diff panes, approval
surfaces, and dispatch coordination.

**Status: Shipping.** v0.8.112 released 2026-10-03. Phase 2 (The Switchboard) complete;
Phase 3 (The IDE) in active development. See `PROGRESS.md` for current work.

## Getting started

- **Download:** [releases](https://github.com/badsonstudios/switchboard.ai/releases) page.
- **Read:** [docs/manual/](docs/manual/) — user manual (built in-app via Help ▸ User Manual).
- **Develop:** `npm install && npm run build && npm start` (see `docs/extensibility.md` for
  contribution points).
- **Design:** [docs/DESIGN.md](docs/DESIGN.md) (architecture, features, open questions).

## Documents

| Path | What it is |
|---|---|
| [PROGRESS.md](PROGRESS.md) | **Live state — current item, what's next, blockers, and the log.** Start here. |
| [docs/DESIGN.md](docs/DESIGN.md) | The design record — architecture, 34 feature sections, roadmap, competitive research. Updated as features ship. |
| [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) | The constitution — product & session-management principles, the feature litmus test, and hard constraints. |
| [docs/manual/](docs/manual/) | User manual (Markdown; also rendered in-app). |
| [docs/extensibility.md](docs/extensibility.md) | Internal contributor guide — contribution points, capability manifests. |
| [docs/reference-implementations.md](docs/reference-implementations.md) | Contract reference — Claude Code CLI, Agent SDK, stream-json protocol. |
| [docs/plans/](docs/plans/) | Phase plans and work breakdown. Process in `00-process.md`. |

## Shipped features (Phase 1–2)

- Multi-session orchestrator with card-based UI, pinning, groups, and pop-out windows
- Session approval surfaces for file edits, commands, and permissions (approval bar, session-flip, batch grouping)
- Dispatch v1: inter-session communication, background sessions, result injection
- Transcripts and conversation history (resume-on-focus, session binding, watcher tailing)
- Git read half complete: status, diff (inline/side-by-side), commit log, history tab, partial staging
- Git write half complete: stage/unstage/discard, commit, fetch/pull/push, branch create/switch, worktree querying
- Per-session context sharing and `@`-references across sessions
- Approval and permission system (plan mode, ask mode, always-allow learner)
- MCP server attachment and stdio bridges
- Usage tracking and per-session cost visibility
- Settings modal, theme support (nordic/daylight), task labels (manual + AI-generated)
- Help system and in-app user manual with screenshots

## Hard constraints (see DESIGN.md §5 for detail)

- **Subscription-first:** Drives the local `claude` CLI under the user's Claude subscription
  by default; API-key mode optional. Never requires a key.
- **Host, don't reimplement:** The real CLI does the deciding and the doing; we render, route, and notify.
  Never fork agent behavior or fake an interaction the CLI kept for itself.
- **Local-first:** No accounts, no cloud, no telemetry.
- **Cross-platform:** Windows / macOS / Linux (Electron + TypeScript + React + Monaco + Dockview).

## In development (Phase 3 — The IDE)

- Responsiveness optimization (E23): streaming batch updates, feed virtualization, process tree cleanup
- Git v2 layer 3: worktree workflows, squash-merge, cross-session conflict warnings
- Files tab v2 with full file-type dispatch (code, images, JSON, CSV, binaries)
- Fleet surfaces: review queue pane, mission-control dashboard, activity report
- Checkpoint and rollback (turn-level undo, reversible changes)
- Dispatch v2: auto-dispatch with rules engine, bounded fix/re-review loops
- Headless task panes for background work coordination
- Attention legibility and layout ergonomics
- Accessibility and voice (contrast fixes, command announcements, chord accessibility)
