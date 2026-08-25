# switchboard.ai — User Manual

Plain-English documentation for people **using** switchboard.ai, not building
it. If you want to know *why* something works the way it does, that's
`docs/DESIGN.md`; this folder only answers *how do I do the thing*.

**These pages are the source for the shipped HTML manual.** They're written in
Markdown and compiled later (see `docs/plans/03-later-phases.md` → "User
manual build"). Write for the reader, not the repo: no issue numbers, no work
item IDs, no file paths into `src/`.

## How these pages get written

Every work item that changes something a user can see or do writes its manual
page **before the PR opens** — while the feature is fresh. That's Step 8 of
`/next-item` and part of the definition of done in `docs/plans/00-process.md`.
Drafts are fine. Placeholders are fine. Silence is not: a shipped feature with
no page is an unfinished work item.

## Contents

| Page | Covers | Status |
|---|---|---|
| [01 — Getting started](01-getting-started.md) | Installing, first launch, opening your first session | draft |
| [02 — Sessions](02-sessions.md) | Creating, resuming, suspending, closing sessions | draft |
| [03 — The session view](03-session-view.md) | Reading the conversation, the prompt box, detail levels | draft |
| [04 — Approvals & autonomy](04-approvals-and-autonomy.md) | Allowing/denying tool use, answering Claude's questions, the four autonomy modes | draft |
| [05 — Slash commands](05-slash-commands.md) | `/clear`, `/compact`, autocomplete, the ⋯ menu | draft |
| [06 — Keyboard & commands](06-keyboard.md) | Shortcuts, the command list, the palette | draft |
| [07 — Organizing your workspace](07-workspace.md) | The sidebar, groups, pop-out windows, layout | draft |
| [08 — Changes & git](08-changes-and-git.md) | The Changes tab, diffs, syntax colouring, branch info | draft |
| [09 — Notifications & events](09-notifications.md) | Sounds, the Events drawer, the lamp strip, when you get told what | draft |
| [10 — Settings](10-settings.md) | Theme, language, notification preferences, trust | draft |
| [11 — Troubleshooting](11-troubleshooting.md) | When a session won't start, hangs, or vanishes | draft |
| [12 — Direct mode (beta)](12-direct-mode.md) | How sessions now talk to Claude by default: fixes the `.claude` double-prompt, costs you the terminal | draft |
| [13 — Updates](13-updates.md) | When it checks for a new version, what the release box offers, what Skip means | draft |
| [14 — Is it me or is it them?](14-provider-status.md) | The status dot, provider incidents, and the "several sessions just hit errors" strip | draft |
| [15 — Reading files in the app](15-document-viewer.md) | Opening a file, rendered Markdown, source view, find, what won't be shown | draft |
| [16 — Finding something](16-find.md) | `Ctrl+F` over a session: the find bar, the results list, what it searches that you can't see | draft |
| [17 — MCP servers](17-mcp-servers.md) | `/mcp`: what tools a session is wired to, which scope each comes from, and why one is waiting on you | draft |

Backfilled 2026-07-24 from the shipped app (Phase 1 + Phase 2 epics E7, E8,
E10, E12) — written against the actual UI strings and behavior, not from
memory. Nothing here has been checked against a running build yet, which is
what keeps it at `draft`.

Status is `stub` (skeleton only), `draft` (written, unreviewed), or `current`
(accurate as of the last release).

## House style

- **Second person, present tense.** "Click ⊕ and pick a folder." Not "the user
  may then elect to…".
- **Lead with the task, not the mechanism.** The reader wants to close a
  session, not to learn about card records.
- **Say what they'll see.** Name the actual button text, tab name, or icon.
- **No jargon without a gloss.** "PTY", "hook", and "transcript" are our words,
  not theirs. If a term must appear, define it once in plain English.
- **Short sections with headings** — people scan manuals, they don't read them.
- Mark anything unfinished with `TODO:` so the compiler can flag it later.
- Screenshots: not yet. Leave `<!-- screenshot: description -->` where one
  should go, and we'll capture a set before the manual ships.
