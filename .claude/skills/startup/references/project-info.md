# Project Info — switchboard.ai

**What:** an "IDE for AI sessions" — a cross-platform desktop app hosting many
concurrent AI coding-agent sessions (Claude Code first), each in its own
project folder, in one orchestrator window. Replaces the many-VS-Code-windows
workflow with: attention routing (urgency lamps, attention queue), an event
feed, inter-session communication (drag-and-drop, @-references, Session Bus
MCP server), per-session git/diff panes, rich approval surfaces, and usage
tracking.

**Who:** Dan (owner/solo dev, evenings & weekends), overseeing implementation
via GitHub PR review. Heavy Claude Code user (Max 20x subscription) — he is
also user #1.

**Why it wins (research-verified 2026-07):** ~79 competitors exist; worktree
isolation, notifications, and per-session diff review are commodity. The open
ground: persistent attention queue, cross-session review, inter-session
context transfer (no precedent found), session identity, first-class Windows.

**Source of truth:** `docs/DESIGN.md` (features, 29 sections) +
`docs/PHILOSOPHY.md` (principles + the litmus test every feature must pass).
Never implement against memory of the design — cite the section.

**Naming:** product is "switchboard.ai" (lowercase). Repo:
github.com/badsonstudios/switchboard.ai (private). Name-collision/domain check
is open question #6 — required before anything public.
