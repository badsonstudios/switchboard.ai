# S-05 — Sidechain / subagent visibility (OQ #5, + OQ #13 evidence)

**Verdict: GO — watcher windows get full live subagent visibility, and
plan-chip extraction (OQ #13) is viable.** In CLI 2.1.215 subagent transcripts
are separate nested files with an identity sidecar, discovered and tailed live
with the same sub-second lag as the main transcript.

**Tested:** Claude Code CLI 2.1.215, Windows 11, 2026-07-19. Probe:
`spike/s05/` (recursive transcript watcher + a session driving TodoWrite and a
`general-purpose` subagent).

## Where sidechains live (2.1.215 layout)

```
~/.claude/projects/<slug>/<session-uuid>.jsonl                     ← main transcript
~/.claude/projects/<slug>/<session-uuid>/subagents/
    agent-<agentId>.jsonl                                          ← subagent transcript
    agent-<agentId>.meta.json                                      ← identity sidecar
```

- **The old same-file sidechain model is gone**: every main-transcript line
  carries `isSidechain:false`; subagent lines live in their own file with
  `isSidechain:true` and an `agentId` field. Watchers must scan recursively —
  a one-level dir listing silently sees nothing (our first probe run missed it
  exactly this way).
- **`meta.json` is the identity answer**, written at spawn:
  `{"agentType":"general-purpose","description":"Count lines in data.txt",
  "toolUseId":"toolu_…","spawnDepth":1}` — `toolUseId` links the file to the
  parent's `Agent` tool_use block (note: the spawning tool is named **`Agent`**
  now, not `Task` — don't match on the old name; prompts saying "use the Task
  tool" still work via aliasing in 2.1.215, but the transcript records `Agent`), `spawnDepth` covers nesting.
- Subagent entries carry the **parent's `sessionId`**, confirming the binding
  from the content side too.

## What a watcher window can reliably show (measured)

| Signal | Source | Latency observed |
|---|---|---|
| "Subagent started" + label + type | new `agent-*.jsonl` + `meta.json` | file appeared 14.1s into the session — the moment the `Agent` tool fired; meta readable immediately |
| Subagent's current tool | `tool_use` entries in the agent file | median 158ms / max 388ms behind wall clock |
| Subagent completion | parent transcript: `tool_result` for the linked `toolUseId` | same tail lag as any main-transcript line |
| Interleaving | parent and agent files tailed independently — no shared-file ordering problem at all | — |

## OQ #13 — plan/TodoWrite extraction

**Viable.** `TodoWrite` tool_use entries in the main transcript carry the full
todo array (content + status per item). The probe watched status transitions
live: `["in_progress","pending","pending"]` → `["completed","completed",
"completed"]`. A plan-progress chip can render real state, not static labels.
Caveat: agents aren't obligated to use TodoWrite — degrade to "no plan
visible" when absent.

## Phase 1 notes

- Extend the S-04 tailer with the recursive scan + `.meta.json` pickup;
  everything else (tolerant reader, byte-offset polling) transfers unchanged.
- Subagent *directory layout* is undocumented internals — same §5.26 drift
  posture as the transcript schema: tolerate absence, re-verify per CLI
  release (the Task→Agent rename this very version is the warning shot).

## Re-running

```bash
bash spike/s05/run-sidechain.sh
```
