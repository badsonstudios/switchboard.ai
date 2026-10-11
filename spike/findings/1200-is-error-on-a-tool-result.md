# 1200 — does a failed command's result say so, on the stream and in the transcript?

**Question.** Folding a run of shell commands (#1200) must never fold a command
that failed. That needs a reliable "this one failed" for every tool result, on
both sources the conversation is built from: the transcript on disk and the
live `stream-json` output. Is the CLI's `is_error` that signal?

**Answer: yes, on both. Measured, CLI 2.1.288, 2026-10-11.**

## The transcript

Counted over the 25 most recently written conversations under
`~/.claude/projects` on the owner's desktop (main conversation only, sidechains
skipped), every `tool_result` whose `tool_use` was `Bash` or `PowerShell`:

| | count |
|---|---|
| shell results | 3,153 |
| with `is_error: true` | 76 (2.4%) |
| text begins "Exit code N" but **no** `is_error` | **0** |
| `is_error: true` with no exit code in the text | 21 |

The 21 are commands that did not run: blocked by the harness
(`<tool_use_error>Blocked: sleep 45 followed by…`) or declined because nobody
answered the approval in time. They are failures the reader needs to see as
much as a non-zero exit, and the flag covers them where reading the text for
"Exit code" would not.

The same pass counted run lengths (consecutive shell calls with no prose and no
other tool between them): of 1,227 runs, 503 were one command, 305 two, 319
three to five, 85 six to eleven, 15 twelve or more. About a third of runs are
long enough to fold at a minimum of three.

## The stream

`claude -p "<run `exit 3`, then `echo OK_AFTER`>" --output-format stream-json
--verbose --allowedTools Bash`, in an empty folder. The two `tool_result` items,
as the CLI wrote them (trimmed copy: `spike/probes/1200/stream-is-error.ndjson`):

```
{"type":"tool_result","content":"Exit code 3","is_error":true}
{"type":"tool_result","content":"OK_AFTER","is_error":false}
```

So on the stream the flag is present on **every** result, `true` or `false`, in
the same content item as the output. (In the transcript a successful result
usually carries no `is_error` key at all; `=== true` reads both.)

The frame also carries a top-level `tool_use_result`: a string for the failed
call and an object for the successful one. Not used.

## What was not measured

- A stream session driven through `--input-format stream-json` (the app's own
  transport). The output format is the same writer; this probe used `-p`.
- Tools other than the shell. `is_error` is set for any failed tool result (a
  Read of a missing file, a refused Edit); only the shell block reads it today.
