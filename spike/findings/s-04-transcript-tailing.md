# S-04 — Transcript discovery & live tailing (OQ #3)

**Verdict: GO.** A spawned session's JSONL transcript can be discovered within
~4s of spawn, tailed live with **sub-second lag (median 268ms)**, and parsed
tolerantly: status, running token totals, tool calls, and touched file paths
all derive cleanly from the transcript alone, and garbage/unknown lines cannot
crash the reader.

**Tested:** Claude Code CLI 2.1.215, Windows 11, 2026-07-19. Probe kit:
`spike/s04/` (tailer + live driver + malformed-line test).

## Discovery mechanism (Phase 1 uses this)

- Transcripts land in `~/.claude/projects/<slug>/<session-uuid>.jsonl`.
- **Slug mapping:** cwd with separators replaced by `-`. Confirmed for `:` and
  `/` (`C:/tmp/s04-project` → `C--tmp-s04-project`); dot/space/backslash in
  the char class are assumed, not exercised — another reason slug math should
  only scope the watch, not bind the session (next bullet).
- Robust discovery that needs no slug math at all: snapshot existing `.jsonl`
  files before spawn, poll for the first new one (100ms poll). New transcript
  appeared **3.9s after spawn** (includes CLI startup); first line readable
  at 4.0s. **Known race:** any concurrent session creating a transcript in the
  discovery window gets adopted — the spike accepts this (single-session
  fixtures); Phase 1 MUST validate the binding by cross-checking the
  transcript's `cwd`/`sessionId` fields against the spawned session before
  trusting it (the spike records but does not validate them).

## Tailing & lag (measured)

Byte-offset polling every 100ms (`fs.watch` avoided on Windows). During a live
session doing a Write + a Bash call: 16 lines, lag between an entry's own
`timestamp` and wall-clock read time: **min 24ms / median 268ms / max 815ms**
(13 timestamped samples). Comfortably inside the "feels live" budget for
watcher windows; no polling-rate tuning needed yet.

## What the transcript yields (2.1.215 schema notes)

- **Tokens:** `message.usage` on assistant entries — `input_tokens`,
  `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
  Running totals track cleanly (cache-read dominates: 119k cache-read vs 8
  fresh input tokens in the probe session — display design should expect
  that shape).
- **Tool calls:** `message.content[]` items with `type:"tool_use"` carry
  `name` + full `input` (file_path for Write etc.) — enough for per-session
  files-touched lists without PostToolUse hooks.
- **Entry types seen** (several undocumented — the tolerant reader is not
  optional): `user`, `assistant`, `queue-operation`, `attachment`,
  `file-history-snapshot`, `file-history-delta`, `ai-title`, `last-prompt`.
- **No terminal "done" marker observed**: the headless session's transcript
  ended on an `assistant` entry — status derived from transcript alone cannot
  distinguish "done" from "paused". This confirms DESIGN §2's split: transcript
  = telemetry authority, **Stop/Notification hooks = status-transition
  authority** (S-06's job). Transcript-only status is a fallback, not the
  mechanism.

## Tolerant reader (verified by test)

`malformed-test.js`: synthetic transcript fed valid entries interleaved with
raw garbage, truncated JSON, unknown future types, blank lines, and
string-instead-of-array content. Reader survives all of it, counts
malformed lines (2), parses the rest (4), extracts tokens from the valid ones,
and treats unknown types as countable opaque entries. PASS.

## Phase 1 notes

- 100ms byte-offset polling is cheap and lag is already sub-second; per-session
  tailers at S-07 concurrency will confirm CPU cost.
- Do not key any logic on the presence/absence of undocumented entry types;
  count-and-ignore unknowns (per §5.26 tolerant-reader spec).
- The status line in this spike is console-rendered; wiring into the Electron
  harness UI is S-06/Phase 1 assembly, not a mechanism risk.

## Re-running

```bash
bash spike/s04/run-tail.sh        # live probe: discovery + tail during a real session
node spike/s04/malformed-test.js C:/Projects/Switchboard.ai/.claude/work_files/s04-malformed
```
