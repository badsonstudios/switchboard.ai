# #1616: what the CLI does when the agent moves itself into a worktree

Measured 2026-11-22 against the `claude` CLI on PATH, **2.1.322**, before
building "the session follows its agent". Shapes first read off the binary's
embedded schemas (`docs/reference-implementations.md` §2.1), then confirmed
with two cheap real runs (`--model haiku`, `-p`, a throwaway repo).

## Method

1. `C:\tmp\p1616\repo`: `git init`, one commit.
2. `claude -p "Call the EnterWorktree tool with name \"probe\" …" --model haiku
   --output-format stream-json --verbose --allowedTools
   "EnterWorktree,ExitWorktree,ToolSearch" --max-turns 8`.
3. From the SAME starting folder: `claude -p --resume <id> "Call the
   ExitWorktree tool with action \"keep\" …"` with the same flags.
4. Read the stream (`spike/probes/1616/enter.jsonl`, `exit.jsonl`, trimmed to
   the frames that matter) and where the transcript lived after each step.

Both tools are deferred (`shouldDefer: true`): the model loads them with
`ToolSearch` first. Haiku did so unprompted beyond "load it if needed".

## The contract

- **Tool use**: `EnterWorktree` input `{name?}` or `{path?}` (mutually
  exclusive; `path` switches into an existing worktree that `git worktree list`
  knows). `ExitWorktree` input `{action: "keep" | "remove", discard_changes?}`.
- **Tool result** (the `user` frame): `content` is the tool's `message` string,
  and the structured output rides at top level as `tool_use_result`:
  - EnterWorktree: `{worktreePath, worktreeBranch?, message}` (binary schema
    `Xa`). Measured: `worktreePath: "C:\tmp\p1616\repo\.claude\worktrees\probe"`,
    `worktreeBranch: "worktree-probe"`.
  - ExitWorktree: `{action, originalCwd, worktreePath, worktreeBranch?,
    tmuxSessionName?, discardedFiles?, discardedCommits?, restoredCwd?,
    originalCwdMissing?, message}` (schema `ol`). `restoredCwd` is where the
    session really ended up (a fallback when `originalCwd` is gone).
- A tool result names its call only by `tool_use_id`, and the Agent tool's
  result also carries `worktreePath` / `worktreeBranch`, so a reader must
  remember which call ids were the worktree tools rather than guess from shape.

## What the CLI does around it

- **It MOVES the transcript.** After EnterWorktree the whole conversation file
  lived under `~/.claude/projects/C--tmp-p1616-repo--claude-worktrees-probe/`,
  and nothing under the starting folder's slug. After ExitWorktree it was back
  under `C--tmp-p1616-repo/`. Read off the binary: `relocateSessionTranscript`
  renames the file (and the session's subagent folder) and stamps a
  `{"type":"relocated","relocatedCwd":…}` line; the move can FAIL ("transcript
  relocation failed", logged, non-fatal), leaving the file where it was.
- The transcript's earlier lines keep the old `cwd`; lines after the move carry
  the worktree. A `worktree-state` line records `originalCwd`, `worktreePath`,
  `worktreeBranch`.
- **A resume from the starting folder goes back INTO the worktree by itself**:
  the resumed run's `system:init` reported `cwd: …\.claude\worktrees\probe`.
  `--resume <id>` found the conversation by id although it was filed under the
  worktree's slug (consistent with `spike/findings/1638-transcripts-after-removal.md`).

## What it means for the app (#1616)

- Watch the agent's own tool calls (P7): remember `EnterWorktree` /
  `ExitWorktree` call ids from the `assistant` frame, read `tool_use_result`
  from the matching result. A failed call (`is_error`) or an unknown shape moves
  nothing (P6).
- `system:init`'s `cwd` restates where the session is each turn; use it only to
  CORRECT a card already believed moved (a junction or 8.3 spelling of the start
  folder must not read as a move).
- The resume check must also look under the folder the agent last worked in,
  because that is where the conversation is filed after a successful move, and
  under the start folder, because the move can fail.
- The transcript watch must follow the renamed file (offsets intact) or usage
  totals freeze after the move.
- Spawning in the start folder is enough to "reopen in the folder it was last
  in": the CLI restores the worktree itself.

## Cleanup

`git worktree remove --force`, branch deleted, `C:\tmp\p1616` and both
`~/.claude/projects/C--tmp-p1616-*` directories removed. Only `-p` runs, so no
background sessions (`claude agents --json` showed none for the folder).
