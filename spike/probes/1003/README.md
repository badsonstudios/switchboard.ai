# Probe 1003 — `/clear` sent while a resumed session is still starting

One probe. It seeds a conversation, respawns it with `--resume` and the app's
own stream-json argv, and sends `/clear` twice, timing every stdout frame and
every hook POST on one clock.

| env | default | what it does |
|---|---|---|
| `TRIALS` | 3 | trials to run |
| `WAIT_MS` | 5000 | spawn → first `/clear` |
| `GAP_MS` | 10000 | first `/clear` → second |
| `TAIL_MS` | 8000 | how long to watch after the second |
| `HOOK_DELAY_MS` | 0 | hold every hook open this long, to stretch start-up |
| `SEED_TURNS` | 1 | `say ok` turns in the conversation being resumed |

```bash
# the ordinary case: start-up is long over
TRIALS=1 node spike/probes/1003/probe-clear-on-resume.mjs > run.json 2> run.txt

# the report: both clears land inside a 12 s start-up
HOOK_DELAY_MS=12000 WAIT_MS=2500 GAP_MS=5000 TAIL_MS=36000 TRIALS=2 \
  node spike/probes/1003/probe-clear-on-resume.mjs > run.json 2> run.txt
```

`reproduced=true` means the first `/clear` produced no `conversation_reset`
before the second was sent, and the second window then held at least one.

**Costs one real turn per trial** (the seed's `say ok`); `/clear` costs none.
No `--bg`. The temp cwd is removed at the end; sweep `%TEMP%\sb1003-*` if a run
is killed mid-trial. Confirm with `claude agents --json` before and after
anyway.

Findings: `spike/findings/1003-clear-during-startup.md`.
