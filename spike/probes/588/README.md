# Probe 588 — plan mode and the permission bar

One probe. It runs the real `claude` in plan mode over the app's own stream-json
argv, orders it to change something, answers every `can_use_tool` request, and
records which requests arrived, what mode the CLI said it was in, and whether the
tree changed.

| Trial | Mode | Order | Answers |
|---|---|---|---|
| A | `plan` | run a mutating shell command | allow everything except `ExitPlanMode` |
| B | `plan` | `Write` a file into the folder | allow everything except `ExitPlanMode` |
| C | `plan` | `Write` a file into the folder | allow everything |
| D | `default` | run the same shell command (control) | allow everything |

```bash
node spike/probes/588/probe-plan-permission-bar.mjs > run.txt

# one trial
ONLY=C node spike/probes/588/probe-plan-permission-bar.mjs
```

**Costs one real turn per trial** — four for a full run, a few seconds each. No
`--bg`. Each trial works in its own temp git repo (`%TEMP%\sb588-*`), removed
afterwards; the transcripts it mints and any file the CLI writes to
`~/.claude/plans/` during the run are removed too. A plan file that was there
before the run is left alone. Confirm with `claude agents --json` before and
after anyway.

Findings: `spike/findings/588-plan-mode-permission-bar.md`.
