# #1638: what happens to a conversation when its worktree folder is deleted

Measured 2026-11-22 against the `claude` CLI on PATH, **2.1.322**, before
building "Remove worktree…".

## Question

Claude Code files each conversation under `~/.claude/projects/<slug of the
folder it ran in>/<session id>.jsonl`. Removing a worktree deletes that folder.
Does the conversation become unreachable (stranded), so removal would have to
move or keep something?

## Method

1. In a fresh folder `C:\tmp\p1638\wt-a` (a `git init`ed scratch folder):
   `claude -p "Remember the word PELICAN. Reply only OK." --model haiku
   --output-format json`. Session id recorded; transcript appeared at
   `~/.claude/projects/C--tmp-p1638-wt-a/<id>.jsonl`.
2. Deleted `C:\tmp\p1638\wt-a` entirely.
3. From a different folder, `C:\tmp\p1638\primary`:
   `claude -p --resume <id> "What word did I ask you to remember? One word."`,
   then a second resumed turn.
4. Read where the new turns were written and with which `cwd`.

## Findings

- **The CLI found the conversation by id from the other folder and carried on**
  (it answered `PELICAN`). `--resume <id>` is not limited to the current
  folder's slug directory.
- **It appended to the ORIGINAL file** under `C--tmp-p1638-wt-a/`; nothing was
  written under the new folder's slug (only its `memory` dir appeared). The new
  lines carry `"cwd":"C:\\tmp\\p1638\\primary"`; the old ones keep the deleted
  folder.
- So **deleting a worktree folder strands nothing at the CLI level**: the
  transcript stays where it was, and the conversation can be resumed from any
  folder.

## What it means for removal

- "Remove worktree…" never touches `~/.claude/projects`. History keeps every
  conversation (it lists them from the transcripts' own `cwd`), so "keep its
  sessions in History" is not a choice to offer: it is always true. The
  mockup's checkbox became a sentence.
- The worktree's open session cards are **closed first** (the dialog names
  them), so no process holds the folder on Windows and no card restarts into a
  folder that is gone.
- **Not done here:** reopening such a conversation *from the app's History* in
  another folder. The app's own resume check (`canResume`) looks only in the
  card folder's slug directory, so a card in the main folder would not find a
  transcript filed under the removed worktree's slug, and on a later restart
  it would lose track of it. That is a change to the resume path, filed as a
  follow-up rather than squeezed into this item. Until then, the CLI itself
  resumes it (`claude --resume <id>` from any folder).

## Cleanup

The scratch folders and the two `~/.claude/projects/C--tmp-p1638-*` directories
were deleted after the probe. Nothing ran in the background (`-p` only).
