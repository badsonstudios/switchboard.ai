# switchboard.ai — Project Context

> **Read this at the start of EVERY session.** Run the `/startup` skill to load
> this file, the references in `skills/startup/references/`, check the
> environment, and — most importantly — read **`PROGRESS.md`** to see exactly
> where work left off. The root `CLAUDE.md` imports this file so it auto-loads.

---

## Project Overview

**switchboard.ai** is an "IDE for AI sessions": one cross-platform desktop app
(Electron + TypeScript) hosting many concurrent AI coding-agent sessions
(Claude Code first, other CLIs via adapters), each in its own project folder —
replacing the many-VS-Code-windows workflow with a single orchestrator:
attention routing, inter-session communication, per-session git/diff panes,
approvals, and usage tracking.

**Status:** design complete; implementation starting with **Spike 01**
(de-risking: PTY hosting, hook round-trips, transcript tailing).

**Design docs (the source of truth for what to build):**

| Doc | Contents |
|---|---|
| `docs/DESIGN.md` | The design record — 29 feature sections, roadmap, open questions, competitive research |
| `docs/PHILOSOPHY.md` | The constitution — principles + the feature litmus test **every feature must pass** |
| `docs/plans/00-process.md` | How we work: phases → work items → GitHub issues → PRs |
| `docs/plans/01-spike-foundations.md` | Current work: spike spec (S-01…S-08) |
| `docs/plans/02-phase-1-mvp.md` | Phase 1 epics & work items |
| `design_handoff_control_room/` | Visual design (mockup export + theme screenshots) |
| `PROGRESS.md` (root) | **Live state** — current/next item, log. Always current |

**Hard constraints (never violate):** subscription-first (local `claude` CLI,
never require an API key) · host-don't-reimplement (real CLI in real terminals)
· local-first (no accounts/cloud/telemetry) · fail-open (our breakage never
blocks a session) · every feature passes the PHILOSOPHY.md §4 litmus test.

---

## The Work Loop (GitHub issues, just-in-time)

Tracker: **GitHub issues** at `badsonstudios/switchboard.ai`, filed per-milestone
just-in-time from the plan files (see `docs/plans/00-process.md`). Milestones
mirror phases; the current one is **Spike 01 - Foundations** (issues #1–#8).

1. Dan says **"do the next item"** (or `/next-item`, or `/next-item S-03` /
   `/next-item 3`).
2. The skill reads `PROGRESS.md` → picks the issue → plans → **Gate 1: plan
   approval** → implements → tests green → `/review` → iterates → **Gate 2:
   commit approval** → `/commit-push-pr` (branch + PR referencing the issue) →
   updates `PROGRESS.md`. Dan reviews and merges the PR — that's the oversight
   point.
3. `/pm` manages planning: keeps `docs/plans/*` healthy and files the next
   milestone's issues when a phase nears exit. It does NOT bulk-file future
   phases.

**PROGRESS.md discipline (critical):** update it the moment an item starts,
the moment it finishes, and when anything notable happens between (blocker,
scope change, half-done state at session end). A fresh session must be able to
read PROGRESS.md and know *exactly* where things stand without asking.

---

## Environment & Shell

- **OS:** Windows 11, native (WSL exists but is not used).
- **Shell preference: bash first** (Git Bash) for scripts/commands; PowerShell
  only when bash genuinely can't do the job.
- Utility scripts ship in both `.sh` and `.ps1`; prefer the `.sh` version.
- **Node 22 LTS + npm**, `gh` CLI (authenticated; account login
  `badsonstudios`). The **`claude` CLI** must be installed and logged in — it is
  both a dev dependency (the spike drives it) and the product's target.

## Secrets & the `.env` file

All tokens and keys live in **`.claude/.env`** (none are required yet).

- **`.claude/.env` is NEVER committed** — git-ignored, and a PreToolUse hook
  (`.claude/hooks/block-env-staging.sh`) blocks `git add` of `.env` files.
- **`.claude/.env.example` IS committed** — placeholders only. New secret → add
  a placeholder line there and tell Dan to fill in the real value.
- The app itself stores user credentials in the OS credential store — never in
  files (DESIGN.md §5.29). No `ANTHROPIC_API_KEY` anywhere: the `claude` CLI
  runs on Dan's subscription.

## Source Control — GitHub

- **Repo:** `https://github.com/badsonstudios/switchboard.ai` (private).
- **Branches:** `main` is always-working; one `feature/s-<nn>-<slug>` (spike) or
  `feature/<issue#>-<slug>` branch per work item; PR references the issue
  (`Closes #<n>`); Dan reviews + squash-merges. Commit/push only at Gate 2.
- Details: `skills/startup/references/git-workflow.md`.

## Working / Temporary Files

- Scratch scripts, downloads, throwaway files → `.claude/work_files/` (git-ignored).
- Spike harness code lives in `spike/` (committed — it's the current work
  product) but is throwaway by design; findings are the deliverable.

---

## Skills & Agents

Run skills with `/<name>`; agents are delegated to automatically.

| Skill | Purpose |
|-------|---------|
| `/startup` | Load context + read PROGRESS.md + verify environment (every session) |
| `/pm` | Planning manager — keep `docs/plans/*` healthy, file next milestone's issues just-in-time, triage |
| `/next-item` | **Orchestrator** — pick up the next issue in the current milestone → plan → **approve** → implement → test → review → **approve** → PR → update PROGRESS.md |
| `/autopilot` | **Unattended orchestrator** — run a whole milestone issue-by-issue with the gates replaced by self-checks; single `auto/<milestone>` branch + draft PR, never merges to `main` |
| `/check-code` | Code-quality analysis of changed files |
| `/review` | Deeper architecture / correctness review (code-reviewer agent) |
| `/commit-push-pr` | Commit, push, open a PR (asks for approval) |
| `/explain` | Explain code or a concept (read-only) |
| `/deep-research` | Multi-source web research with citations |

**Commands** (`.claude/commands/`): `/commit` (stage + commit, asks first),
`/pr` (push + open a PR via the `new-pr` script).

| Agent | Purpose |
|-------|---------|
| `code-reviewer` | Read-only architecture & code review |
| `debugger` | Root-cause analysis of errors and failures |
| `deep-research-agent` | Comprehensive multi-source research |

## Keeping Skills & Agents Up to Date

The skills and agents are **living tooling** (migrated from BrainHarbor
2026-07-18, adapted to issue-driven flow). Proactively: flag drift during
`/startup`; update skills + `startup/references/*.md` after stack/structure
changes; capture repeated manual tasks as new skills/scripts; fix stale
guidance at the source and tell Dan what changed.

## Utility Scripts

In `.claude/scripts/` (see `scripts/README.md`): `new-pr` (branch/commit/push/
PR), `load-env`, `get-secret`, `statusline.sh`.

## Hooks

Configured in `.claude/settings.json`:

- **block-env-staging (PreToolUse):** blocks `git add` of secrets files;
  `.env.example` allowed. Requires Git Bash.
- **build-test-gate (Stop) — opt-in:** builds/tests before finishing; off by
  default (nothing to build until the scaffold exists). Auto-detects
  `npm run build` once package.json lands; override via `BUILD_CMD`/`TEST_CMD`
  in `.claude/.env`.

---

## Project-Specific Notes

- **No build system yet.** Spike 01 creates a minimal harness under `spike/`;
  the real scaffold arrives in Phase 1 (P1-E1-01: electron-vite + TS + React).
  Until then, build/test commands are per-item.
- **Planned stack** (DESIGN.md §6): Electron + TypeScript + React + xterm.js +
  node-pty + Monaco + Dockview; vitest for unit tests (Phase 1 decision).
- **The spike is findings-driven:** every spike item ends in a findings note,
  and S-08 writes verdicts back into DESIGN.md's open questions. Don't polish
  spike code — prove mechanisms.
- **Dogfooding is a goal:** switchboard.ai will eventually host the Claude Code
  sessions that build switchboard.ai. Design decisions that help that day
  (clean logging, stable hooks usage) are worth small extra effort.
