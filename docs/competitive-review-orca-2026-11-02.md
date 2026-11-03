# Competitive review: Orca, 2026-11-02

**Subject:** [stablyai/orca](https://github.com/stablyai/orca) (v1.4.246, read at
the head of `main` on 2026-11-02).

**Method, and its limits.** Orca's README and documentation were read, and its
source was checked by keyword search and by reading selected files. **Nobody ran
the app.** "Not found" below means a keyword search of a very large codebase
found nothing, which is evidence and not proof. Orca ships daily, so this is a
snapshot; its own README says the changelog is the real feature list.

**Ours** was read from `docs/DESIGN.md`, plan 06, the open issue list and `src/`,
at v0.8.137.

## The short version

Orca is the broader product: dozens of supported AI tools, phones, remote
machines, a built-in browser. Switchboard is narrower and deeper on what matters
with many sessions running: sessions working together, knowing what needs you,
and reviewing what an AI wants to do before it does it.

**Do not chase feature parity.** Finish the parallel-work and usage items already
planned, then take the ideas that strengthen review and attention.

## At a glance

| | Orca | Switchboard |
|---|---|---|
| Stage | v1.4.246, ships daily, started March 2026 | v0.8.137, Phase 3 |
| Scale | ~33,900 TS files; 113k stars; MIT; YC-backed | ~1,130 TS files; two users |
| Organising idea | One git worktree per agent | One conversation per session, attention routing |
| Interface | Terminal by default, chat optional | Structured chat only (terminal removed, #873) |
| AI tools | 35+ listed, plus any CLI | Claude Code, Codex, others through the ACP engine |
| Platforms | macOS, Windows, Linux, iOS, Android | Windows first; macOS on hold (#1221) |
| Privacy | PostHog telemetry on unless opted out; mobile link goes through their relay | No telemetry, no accounts, no cloud |

## What Orca has that was already on our roadmap

| Feature | Orca | Ours |
|---|---|---|
| Worktrees | The core of the product; see below | #1505, #1506. **The biggest gap** |
| Plan usage and limits | Live limits, reset times, 80% warning | #1510. Per-event usage and pricing exist; no plan meter |
| Fleet dashboard | Agent Dashboard, Agents feed | #1511, #1512 |
| Mobile companion | Native apps, push, hosted relay | Phase 4 (§5.27), LAN-first by design |
| Multi-AI breadth | 35+ | E40. Breadth past the tools actually used is not worth chasing |

## What Orca has that was not on our roadmap

### Filed

| # | Item | Why | Biggest risk |
|---|---|---|---|
| #1540 | Comment on diff lines, send to the AI | Cheapest high-value item; strengthens review | Overlap with the Review map's comment model |
| #1541 | Scheduled runs with a precheck | Recurring work already happens by hand | What an unattended run may do without approval |
| #1542 | Fan-out, compare, merge the winner | Pays off E24. **Corrected:** already in DESIGN's backlog, and Orca's version is a manual recipe | N results means N reviews; needs #1505 and #1506 |
| #1543 | Hibernate idle sessions | Relevant to #1013 | Unmeasured: memory saved vs. resume cost |
| #1544 | One-line status note the AI can set | Cheap fleet legibility | May duplicate the task label |
| #1545 | GitHub issues and PRs, start a session from one | Matches the work loop | **Issue text is untrusted input**; see #832 and #830 |
| #1546 | AI-line markers in the diff gutter | Scrutiny where it belongs | Wrong marks are worse than none; little use if nearly all lines are AI's |

All seven carry `needs-discussion`, so no automated run starts them. #1540–#1543
were recommended; #1544–#1546 are worth considering. The grouping is E41 in plan
06, except #1542, which belongs to E24.

### Deliberately not filed

- **Embedded browser and Design Mode.** Impressive, and a very large surface.
  Revisit if design work (Tanner) asks for it.
- **SSH targets, cloud VMs, computer use.** Large; no current demand.
- **Plugin catalog.** Our plugin path is §5.23 and Phase 4.
- **Multi-account switching.** Only worth it for someone running several logins.
- **Linear and Jira.** GitHub is what we use.
- **The desktop pet.**

## How Orca handles worktrees

Added 2026-11-02, read from source at commit `443140e4`. The per-ticket detail is
in comments on #1505, #1506 and #1507.

**The shape.** Every task is a real git worktree with its own branch, kept outside
the repo (`~/orca/workspaces/` by default). The lifecycle is create, work, review,
commit, push, open a PR, then delete.

**Orca has no local merge-back.** The PR is the merge. Its `src/main` shows only a
fast-forward and PR merge methods. This matters because #1506 asks for local
merge-back and one-click squash.

- **Create** runs in the background with visible progress, using `git worktree
  add --no-track -b`. It starts from a base ref, a branch, a commit or a remote
  branch, and records the base.
- **Ignored files** are handled three ways: share by link
  (`worktree.sharedDirectories`, gitignored directories only), copy
  (`.worktreeinclude`), or a setup script (`orca.yaml`).
- **Delete** refuses a dirty worktree unless forced, keeps branches git will not
  drop and offers a review step, and runs at most two at once.
- **Windows** links with a **junction**, the mechanism that wiped our real
  `node_modules` on #916. Orca removes linked paths first, re-checks git's records
  after waiting, and refuses if a different checkout now sits at that path.
- **Outside changes:** a plain `git worktree add` stays hidden until shown, and a
  `git worktree remove` is noticed.
- **Conflicts:** **Resolve with AI**, **Review conflicts** and abort buttons, with
  no prediction across branches.
- **Ports:** a per-workspace panel with a kill action. No collision warning or
  per-worktree port assignment was found.

**Take:** outside-the-repo location, background create, the share/copy/setup split,
and the delete checks. **Leave:** the scale. Over 1,000 source files mention
worktree in their name, and much of it is WSL, SSH and multi-host.

**New risks for us:** a shared `node_modules` assumes every branch has the same
dependencies; Claude Code files transcripts by folder, so deleting a worktree may
strand a session's History entry.

## Where Switchboard leads

- **Sessions working together.** Session Bus (an MCP server), blackboard, context
  transfer and lineage. Orca's nearest equivalent is a CLI-driven orchestration
  inbox behind an Experimental toggle. No in-app MCP server like ours was found;
  that search was keyword-level.
- **Approvals.** Monaco diff, deny with feedback, approve all in this file, and
  revoke. Orca's `NativeChatApprovalCard` renders a code block with option
  buttons, and covers its chat mode.
- **Attention routing.** Layout, queue and urgency, against a feed plus
  notifications.
- **Same-repo conflict warnings.** Planned (#1507); not found in Orca.
- **Provider status and voice.** Status polling is shipped; TTS is planned
  (#1218). Neither was found in Orca, which does have dictation.
- **Local-only privacy.** Our clearest public differentiator.

## Roughly even, or unknown

- Transcript search, slash commands, skills, markdown preview, keyboard palette.
- **Accessibility.** Orca uses `aria-live` in 72 files. Do not assume we lead.
- **Rewind.** Orca's chat has conversation rewind, built on forking. Whether it
  restores files was not confirmed. #1517 aims at turn checkpoints with file
  restore.

## Worth remembering

- **Orca's usage feature calls `api.anthropic.com/api/oauth/usage` with the user's
  Claude login token.** Check that against the host-don't-reimplement rule before
  copying it into #1510.
- **"Worktree checkpoints" in Orca are comments**, not code snapshots. The name
  misled at first.
- **Orca's hibernation conditions** are the best thing to borrow as-is; they are
  listed in #1543.
- **Its precheck** spends no tokens when there is nothing to do; see #1541.
- **Orca's README reads ahead of its product in places.** "Fan one prompt across
  five agents" is a manual recipe, with no broadcast or compare screen found. This
  review first took it at face value and called fan-out new to us, when DESIGN's
  backlog already had it as Best-of-N. Corrected on #1542.
- **Volume does not prove quality.** Orca has 4,231 issues in total; how many are
  bugs was not sampled.
- **Our depth counts only where it has been used.** The Phase 2 cut recorded 20
  features hand-tested against 116 untested. A lead nobody has exercised is a
  claim, not an advantage.
- **Licence.** Orca is MIT: reading is free, and reuse must keep the notice. Our
  rule on the CLI's reference implementations applies here too: read contracts,
  do not copy code.
