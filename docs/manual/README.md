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

**The app carries a copy.** Every numbered page here is installed with
switchboard.ai and opens from **Help ▸ User manual**, starting at
`contents.md` — the reader's contents page (this index and `_template.md` are
not shipped — they are about writing the manual). **A new page needs a row in
`contents.md` as well as in the table below, and the Contents link at its top
and bottom that `_template.md` carries**; a test fails without either.

**Pictures live in `img/` and are generated, not hand-made.**
`e2e/manual-shots.spec.ts` launches the real app with made-up but believable
data, draws the arrows and labels, and writes the PNGs. Regenerate them with
`npm run manual:shots` after the interface changes; never edit one by hand,
because the next run overwrites it. A picture no page shows fails a test. That is why links
between pages are plain relative links to a neighbouring file (`02-sessions.md`,
never `../something`): they have to work from inside the installed folder,
where nothing but these pages exists. A test fails on a link that points
anywhere else.

## Contents

| Page | Covers | Status |
|---|---|---|
| [00 — Day one](00-day-one.md) | **Start here if you have never seen the app.** Install, open a project, start a session, answer approvals, review and commit — one page, with links to the rest | draft |
| [01 — Getting started](01-getting-started.md) | Installing, first launch, opening your first session | draft |
| [02 — Sessions](02-sessions.md) | Creating, resuming, opening a conversation you had before, suspending, closing sessions, and how sessions read each other's work and send each other messages | draft |
| [03 — The session view](03-session-view.md) | Reading the conversation, the prompt box, detail levels | draft |
| [04 — Approvals & autonomy](04-approvals-and-autonomy.md) | Allowing/denying tool use, answering Claude's questions, the four autonomy modes | draft |
| [05 — Slash commands](05-slash-commands.md) | `/clear`, `/compact`, autocomplete, the Clear and Compact buttons, the ⋯ menu | draft |
| [06 — Keyboard & commands](06-keyboard.md) | Shortcuts, the command list, the palette | draft |
| [07 — Organizing your workspace](07-workspace.md) | The sidebar, groups, pop-out windows, layout | draft |
| [08 — Changes & git](08-changes-and-git.md) | The Changes tab: the four groups, name-first rows, per-file line counts, the branch and push/pull line, filtering, giving a diff its own panel or window, syntax colouring | draft |
| [09 — Notifications & events](09-notifications.md) | Sounds, the Events drawer, who needs you, when you get told what | draft |
| [10 — Settings](10-settings.md) | The Settings window (`Ctrl+,`), the chips that stayed on the title bar, and why | current |
| [11 — Troubleshooting](11-troubleshooting.md) | The Help menu; when a session won't start, hangs, or vanishes; sending a problem report; asking for a feature | draft |
| [12 — Direct mode](12-direct-mode.md) | How sessions talk to Claude: fixes the `.claude` double-prompt, costs you the terminal | draft |
| [13 — Updates](13-updates.md) | When it checks for a new version, what the release box offers, what Skip means | draft |
| [14 — Is it me or is it them?](14-provider-status.md) | The status dot, provider incidents, and the "several sessions just hit errors" strip | draft |
| [15 — Reading files in the app](15-document-viewer.md) | Opening a file, rendered Markdown, source view, find, reading this manual in the app, what won't be shown | draft |
| [16 — Finding something](16-find.md) | `Ctrl+F` over a session: the find bar, the results list, what it searches that you can't see | draft |
| [17 — MCP servers](17-mcp-servers.md) | `/mcp`: what tools a session is wired to, which scope each comes from, adding and removing them, and why one is waiting on you | current |
| [18 — Choosing a model](18-model.md) | Switching a session between Opus, Sonnet and Haiku mid-conversation — the one-click menu on the model name and the fuller `/model` picker — and why the tick is sometimes missing | draft |
| [19 — When it feels slow](19-performance.md) | The performance summary (`Ctrl+Shift+P`), the detailed capture switch in Settings, what it records and what it never touches, and how to send the file | current |
| [20 — Handing work to a fresh session](20-dispatch.md) | Dispatch: ⋯ → Dispatch… and the palette's per-role entries, why a reviewer deliberately does not get your conversation, the task line worth reading before you send it, getting the findings back, where a dispatched session sits in the list and when it closes itself | draft |
| [21 — The Files tab](21-files.md) | Browsing the session's folder: git badges on files and folders, opening files from the tree, what the keyboard does, why the list doesn't update by itself, and the entries it deliberately leaves out | draft |
| [22 — History](22-history.md) | The History tab: the commit graph and what its lines mean, what a row tells you, opening a commit to see its files and their diffs, branch and tag chips, detached HEAD, commits to pull and push, searching | draft |

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
