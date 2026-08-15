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
| `docs/extensibility.md` | Internal contributor guide — contribution points, capability manifests, the bootstrap rule (§5.23 seams; NOT a public plugin API) |
| `docs/reference-implementations.md` | **When a CLI contract is unclear, read this first.** The Claude Code VS Code extension is unpacked on this machine — a known-correct consumer of every contract we depend on (the embedded Agent SDK, the stream-json protocol, the full `settings.json` schema). How to navigate the minified bundle, and the rules for using it |
| `docs/plans/00-process.md` | How we work: phases → work items → GitHub issues → PRs |
| `docs/plans/01-spike-foundations.md` | Current work: spike spec (S-01…S-08) |
| `docs/plans/02-phase-1-mvp.md` | Phase 1 epics & work items |
| `design_handoff_control_room/` | Visual design (mockup export + theme screenshots) |
| `docs/manual/` | **User manual** (Markdown) — written as features ship; source for the future HTML manual |
| `PROGRESS.md` (root) | **Live state** — current/next item, log. Always current |

**Hard constraints (never violate):** subscription-first (local `claude` CLI,
never require an API key) · host-don't-reimplement (the real CLI decides and
does; never fake an interaction it kept for itself — **P7 amended 2026-07-31,
PHILOSOPHY §6: the terminal is a transport, not the constitution**)
· local-first (no accounts/cloud/telemetry) · fail-open (our breakage never
blocks a session) · every feature passes the PHILOSOPHY.md §4 litmus test.

---

## Standing rule: never guess a CLI contract

**If you are stuck on how the `claude` CLI behaves — a flag, a payload shape, a
protocol message, a settings key — read `docs/reference-implementations.md`
BEFORE guessing.** This applies to every item, not just the transport work.

The **Claude Code VS Code extension is unpacked on this machine** and is a
*known-correct consumer* of every contract we depend on:

- the **embedded Agent SDK**, including its full **CLI argument builder** — the
  authoritative list of what the CLI accepts and in what combination;
- the **stream-json protocol** — message types, the `control_request` /
  `control_response` channel, `can_use_tool` payloads;
- the complete **`settings.json` schema**, including keys `--help` never
  mentions.

**How to read it without destroying your context:** the bundle is minified —
`extension.js` is one 2.6 MB line, `webview/index.js` is 4.8 MB. **`Read` will
blow up your context.** Use `grep -o` with fixed context widths; the recipes are
in the doc.

**The rules:** read *contracts*, don't copy *code* · **verify anything
load-bearing against the CLI on PATH** — the extension ships its own `claude`
binary (265 MB, `resources/native-binary/`) and can differ from Dan's install,
which is exactly why S-10 probe A had to be run instead of assumed.

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

**User docs are part of every item (added 2026-07-24):** anything user-facing
writes its `docs/manual/` page **before the PR opens**, while the feature is
fresh. Plain English, for someone who has never read DESIGN.md. Drafts and
`TODO:` placeholders are fine; a missing page is not. Details:
`docs/plans/00-process.md` → User documentation.

**Every item ends with a hand-off (added 2026-07-26):** before the technical
summary and before the PR, say in **plain English what the thing does**, then
give a **numbered list of what Dan should test** — actions plus what he should
see, noting what the automated tests already cover so he never repeats machine
work. `/next-item` Step 9; the same two sections go in the PR body (test list
as checkboxes) and in `/autopilot`'s draft PR. Details:
`docs/plans/00-process.md` → The hand-off.

**PROGRESS.md discipline (critical):** update it the moment an item starts,
the moment it finishes, and when anything notable happens between (blocker,
scope change, half-done state at session end). A fresh session must be able to
read PROGRESS.md and know *exactly* where things stand without asking.

**Dogfood test tracker (standing rule, added 2026-08-15 at Dan's request):**
`docs/plans/dogfood-testing.md` records what Dan has and hasn't hand-tested.
**Update it automatically, without asking**, whenever: a user-facing feature
merges to main (add it as UNTESTED with a how-to-test line); Dan reports a
hand-test result (move to TESTED, or to the found-a-bug log with the ticket
number); or a fix for a logged bug ships (move it to RE-TEST). When Dan asks
"what should I test?", answer from this file — the UNTESTED and RE-TEST
sections, as numbered steps with expected results. Commit tracker updates
with the same rhythm as PROGRESS.md.

---

## Environment & Shell

- **OS:** Windows 11, native. The app is developed and run natively; WSL
  (Ubuntu 24.04) exists and is used for **one** thing: reproducing a Linux CI
  failure locally instead of pushing and waiting ~10 minutes for the runner.
  Recipe, proven 2026-07-28 (#112):
  - Clone into the WSL filesystem (`git clone /mnt/c/Projects/Switchboard.ai
    ~/sb-linux`), **not** `/mnt/c` — `node_modules` there holds win32 binaries
    for electron and node-pty, and `/mnt/c` I/O is slow. Then `npm ci`.
  - **WSLg gives a real display** (`DISPLAY=:0`), so `xvfb` is not needed and
    Playwright runs as-is. Note this means it is NOT a faithful CI repro: CI
    uses `xvfb-run -a` (screen `1280x1024x8`), and some failures are specific
    to that. Rootless Xvfb does **not** work here — WSLg owns
    `/tmp/.X11-unix` and `xkbcomp` is missing.
  - Electron's system libs can be had **without sudo**: `apt-get download
    <pkg>` then `dpkg-deb -x <deb> ~/elibs/root`, and export
    `LD_LIBRARY_PATH=~/elibs/root/usr/lib/x86_64-linux-gnu`. Only
    `libasound2t64` was missing on this machine (`ldd node_modules/electron/
    dist/electron | grep "not found"` tells you).
  - **Check Windows first.** #112 looked Linux-only and reproduced on Windows
    at ~1 in 3 isolated runs; the WSL detour cost more than it returned.
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
| `/orchestrate` | **Parallel orchestrator (Fable)** — analyze the queue, dispatch parallel Opus workers in worktrees, sole writer of PROGRESS.md, merge internal PRs on green CI, queue user-facing PRs for Dan. Supersedes /next-item + /autopilot while a run is active |
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
