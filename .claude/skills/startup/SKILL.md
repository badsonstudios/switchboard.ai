---
name: startup
description: Initialize the session — load project context from .claude/CLAUDE.md and the startup references, read PROGRESS.md to see exactly where work left off, check the current milestone's issues, and verify the environment. Run at the start of every session.
user-invocable: true
---

Initialize the development session for **switchboard.ai**.

## Step 1: Load project context

Read, in order:

1. `.claude/CLAUDE.md` — high-level project context and index (required).
2. **`PROGRESS.md`** (repo root) — the live state: current/in-progress item,
   next up, blockers, recent log. **This is how we resume across sessions.**
3. The current milestone's plan file (`docs/plans/01-spike-foundations.md`
   while Spike 01 is active) — skim the items.
4. The relevant files in `.claude/skills/startup/references/` —
   `project-info.md`, `tech-stack.md`, `architecture.md`, `git-workflow.md`,
   `code-style.md`, `testing.md`, `security.md`, `api-keys-config.md`.
5. `docs/DESIGN.md` sections relevant to the current item (the plan file cites
   them) — not the whole document.

## Step 2: Check the secrets setup

- Confirm `.claude/.env.example` exists; note which variables the project
  expects (see `references/api-keys-config.md` — currently none are required).
- If `.claude/.env` is missing, note it (fine for now — no required secrets).
  **Never print the contents of `.claude/.env`.**
- Confirm `.claude/.env` and `.claude/work_files/` are git-ignored.

## Step 3: Check the environment

```bash
git status --short
git branch --show-current
git log --oneline -5
gh issue list --milestone "Spike 01 - Foundations" --state open 2>/dev/null | head -5
node --version 2>/dev/null || echo "Node not found"
claude --version 2>/dev/null || echo "claude CLI not found (required for spike work)"
```

Only flag what's relevant to the current work (e.g. no npm-install checks
before the Phase 1 scaffold exists).

## Step 4: Report

```
## Session Initialized — switchboard.ai

**Milestone**: <current milestone from PROGRESS.md>
**In progress**: <item + state, or "nothing mid-flight">
**Next up**: <next item id + title>
**Branch**: <branch>
**Uncommitted changes**: <count or "none">
**claude CLI**: <version / MISSING>

### Recent log (from PROGRESS.md)
<last few log lines>

### Ready to go
<anything needing attention; usually: "Say 'next item' (or /next-item) to start <S-##>">
```

Keep it short — this is orientation, not a report card. Flag any skill/agent
guidance that has drifted from reality (living-tooling rule in CLAUDE.md).
