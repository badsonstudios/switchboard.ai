# #1268 — what the CLI sends when a turn is stopped with a request held

**Measured 2026-10-17 against the CLI on PATH, 2.1.288** (`claude --version`;
`system:init.claude_code_version` agreed), model `claude-haiku-4-5-20251001`.
Probe: `spike/probes/1268/probe-held-on-interrupt.mjs`. Captures:
`spike/probes/1268/captures/<mode>.json` (four runs, one per mode; every line
the CLI wrote, timestamped, `stream_event` deltas counted rather than stored).

```bash
node spike/probes/1268/probe-held-on-interrupt.mjs approval   # or question | subagent | prompt
```

Spawned with exactly the stream flags `providers/claude.ts` pushes, plus
`--model haiku --permission-mode default --session-id <minted>`. Each run uses
its own temp folder and removes it, the transcript, the CLI's project folder for
that path and any background-task output afterwards. No `--bg`.
`claude agents --json` listed the same two pre-existing sessions before and
after the four runs.

## The question

#1258 taught the router to let go of a request when the CLI sends
`control_cancel_request` (the contract was read from the Agent SDK in the VS
Code extension). Nobody had measured **whether the CLI sends one when a turn is
interrupted**. If it did not, a request held when its turn ended would keep its
bar on the card until the five-minute deadline, or for good for a question.

## What the app sends

The Stop button calls `sessions:interrupt`, which reaches
`claude-controls.ts`: `{type:'control_request', request_id:<uuid>,
request:{subtype:'interrupt'}}`. No signal, no stdin close. The probe sends
that, byte for byte, 3 s after a `can_use_tool` arrives and goes unanswered.

## What the CLI sent back

Times are ms after the interrupt was written.

| mode | +ms | frame |
|---|---|---|
| **approval** (`Write`) | +2 | `control_cancel_request` for the held id |
| | +2 | `control_response` to the interrupt, `{still_queued: []}` |
| | +6 | `user` `tool_result`: "The user doesn't want to proceed with this tool use…" |
| | +6 | `user` text `[Request interrupted by user for tool use]` |
| | +22 | `result` `error_during_execution`, `is_error: true`, `terminal_reason: aborted_tools` |
| **question** (`AskUserQuestion`) | +2 | `control_cancel_request` for the held id |
| | +2 | `control_response` to the interrupt |
| | +5..+6 | the same two `user` messages |
| | +23 | `result` `error_during_execution` |
| **subagent** (a background `Agent` asks for `Write`) | +6 | `control_cancel_request` for the held id |
| | +7 | `system:background_tasks_changed` (empty), `task_updated` (killed), `task_notification` (stopped) |
| | +8 | `control_response` to the interrupt |
| | +9..+10 | the two `user` messages, `parent_tool_use_id` = the `Agent` tool use |
| | — | **no `result`** — the parent turn had already ended |

**The cancel comes first, every time:** ahead of the interrupt's own
acknowledgement and ahead of the `result`.

### A late answer to the cancelled request

8 s after the interrupt the probe answered the stale id anyway (`allow` with
the original input; for the question, a valid `answers` map). In all three
modes: **nothing came back** — no echo, no error, no tool ran (the file the
`Write` would have made did not exist afterwards). The next prompt
("Reply with just the word OK") ran normally in all three: `result:success`.

This is what the binary's own schema says the cancel means — `control_cancel_
request`'s description reads: *"Tells the other side that the sender no longer
needs the answer to one of its own in-flight control_requests (for example a
pending can_use_tool prompt after the turn was interrupted …). The sender stops
waiting at once and ignores any control_response that still arrives for that
request_id."*

### A request that arrives AFTER its turn's `result`

The subagent run is the case the ticket warned about. The model launched the
subagent in the background (`task_started … is_backgrounded: true`), said it
was running, and the parent turn ended: **`result:success` at 8961 ms. The
subagent's `can_use_tool` arrived at 9098 ms, 137 ms later**, and was genuinely
waiting — answered, it would have run.

### A new prompt while a request is held (`prompt` mode)

Instead of interrupting, the probe sent a second user prompt 3 s into the hold.
**Nothing was cancelled and nothing was emitted** for the 8 s that followed: the
prompt is queued. When the held request was then answered (deny), the CLI
echoed that `control_response` back on stdout, wrote the `tool_result`, replayed
the queued prompt and ran it (`BANANA`, `result:success`). The echo is harmless
to the app: the translator lists `control_response` as understood and silent
(`providers/claude-events.ts`).

## What this decides

1. **The app's existing handling is the fix.** The CLI does send
   `control_cancel_request` on interrupt, for an approval, a question and a
   background subagent's request, and `StreamPermissions.withdrawn` already
   lets the request go, moves the status and tells the bar. The fake CLI did
   not do this (it cleared its requests silently), which is why no test could
   show it; it now emits the cancel in the measured order.
2. **A turn ending is NOT what ends a hold.** A background subagent's request
   can arrive after the turn's `result` and still be waiting, so a router that
   released holds at turn end would refuse it. The CLI says when it no longer
   needs an answer, and it is the only one that knows. Nothing new was added
   to end holds at turn end.
3. **A late click on a bar that was slow to close is harmless.** The router
   has already let go, so `decide` sends nothing; and the CLI would ignore it
   anyway.

## Not measured, or left

- **The Stop button is not offered while a request is held.** It renders only
  in `working`, and since #1258 a held request pins the card at
  `needs-permission`. So from the UI today, nothing can interrupt a turn with a
  bar up; the e2e drives the same `sessions:interrupt` call through the bridge.
  Whether Stop should be offered there is a product question, not this one.
- **A background subagent's request withdrawn after its parent turn ended**
  moves the card from `needs-permission` to `working` (the router applies
  `permission-resolved`), and the CLI sends no `result` after it, so nothing
  moves it to `done`. Not reachable from the UI today for the reason above.
- Other reasons the CLI may cancel (the schema mentions "one that another
  client already answered") were not exercised; the app handles any cancel the
  same way.
