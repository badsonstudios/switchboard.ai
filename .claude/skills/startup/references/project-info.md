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

**Source of truth:** `docs/DESIGN.md` (features, **34** sections §5.1–§5.34) +
`docs/PHILOSOPHY.md` (principles + the litmus test every feature must pass).
Never implement against memory of the design — cite the section.

**Read §8's Phase 2 audit block before assuming a feature exists** (added
2026-09-25). A feature audit against the code found six §8 Phase 2 items that were
never filed as issues — including all of Dispatch v1 (E13), which is exit criterion
5. The open-issue queue could not reveal them, because an unfiled epic contributes
nothing to it. §8 carries the table; §5.16, §5.13, §5.7 and §5.4 carry as-built
notes saying exactly how far the code is behind the words.

**Naming:** product is "switchboard.ai" (lowercase). Repo:
github.com/badsonstudios/switchboard.ai (private). Name-collision/domain check
is open question #6 — required before anything public.
