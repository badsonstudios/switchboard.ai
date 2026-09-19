# Probe 801 — Level 3 fork adoption

Which probe answers which question, after the `spike/probes/721/` convention.

| probe | questions |
|---|---|
| `probe-fork-adopt.mjs` | Q1–Q7 below, in one run |

## The questions

| # | question | why it matters |
|---|---|---|
| Q1 | Does `--resume <id> --fork-session` carry A's history? | the base case for §5.5 Level 3 |
| Q2 | Is A's transcript **byte-identical** afterwards? | "fork" degrading to "resume in place" APPENDS to A — the damaging failure #801 names |
| Q3 | Cross-folder, by absolute `.jsonl` **path**, from folder B | decides whether we ever write into `~/.claude/projects` |
| Q4 | Where does the forked transcript **land** — B's project dir or A's? | decides whether the watcher finds it |
| Q5 | Does `--session-id <uuid>` pin the forked id? | if yes we know the new id at spawn instead of discovering it |
| Q6 | **CONTROL** — cross-folder by **id**, no path | if this works too, Q3 proves less than it looks like |
| Q7 | A missing file, and an id the CLI does not know | readable refusal, non-zero exit, nothing hangs |

**Q6 is what keeps the run honest.** Without it, a success on Q3 cannot
distinguish "the path form is what made this work" from "the CLI would have
found the conversation anyway" — the same role variant C played in `spike/probes/790/`.

## What was read before anything was run

The readable sources were exhausted first (`docs/reference-implementations.md`
§2.1), and they are what made the probe worth running in this shape. From the
PATH binary:

- the main resume branch has a **file form** — `fse(v.resume)` tests
  `endsWith(".jsonl")`, the expected id is derived from the **filename**
  (`Hn(Ya(v.resume,".jsonl"))`), the transcript is loaded from the file, and the
  path has its own telemetry entrypoint (`"file"`, distinct from `"cli_flag"`),
  its own error (`Unable to load transcript from file: …`) and its own log line
  (`--resume file unreadable`);
- `--fork-session` — *"When resuming, create a new session ID instead of reusing
  the original (use with `--resume` or `--continue`)"*;
- `--session-id <uuid>` — *"must be a valid UUID"*, validated against
  `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`;
- the CLI's own background launcher pairs them:
  `["--session-id", <new>, "--fork-session", "--resume", transcriptPath ?? sessionId]`;
- the CLI's human-facing cross-directory hint is
  `cd <projectPath> && claude --resume <id> --fork-session` — it changes
  directory rather than copying a transcript;
- `relocated` / `relocatedCwd` is a first-class record the CLI writes itself,
  both when relocating a transcript and when branching one.

**Reading is not measuring.** #801's done-when requires the file be "verified to
be the file the CLI then reads, not assumed", which is why this runs.

## Containment

Per `spike/findings/s-09-permission-prompt-tool.md` and #760 §8 — *a cwd is not
a sandbox*:

- `--permission-mode default`, never `bypassPermissions`;
- prompts that need no tools, so nothing has a reason to act;
- **foreground `-p` only, no `--bg`** — no background sessions to leak onto the
  owner's machine;
- every transcript the run causes is recorded and deleted at the end, and only
  ids this run minted are ever removed.

## Cost

One seeding turn plus one turn per accepted fork variant — four trivial one-word
turns at most. Q7's refusals cost nothing; they error before a model call.

## The trap this probe is written against

A silent result is indistinguishable from a broken harness (s-09). So:

- the seed's transcript is checked for the codeword **before** any verdict is
  read out of a fork — if A never carried it, no fork could have read it, and
  the run aborts saying so rather than reporting four false negatives;
- every verdict is bound to a **per-run codeword** (`SBFORK-<run>`), not to a
  generic substring that could match something else (#760);
- "A is unchanged" is a **sha256 + size** comparison, not a line count.
