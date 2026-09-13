# Probes for #790 — `continued-in`

Findings: [`spike/findings/e11-790-continued-in.md`](../../findings/e11-790-continued-in.md).

| Probe | Question it answers |
|---|---|
| `probe-continued-in.mjs` | Does `claude --resume <id> --bg` write a `continued-in` line into the parent transcript? |
| `probe-fork.mjs` | Round 2 — three ways of forcing the CLI to mint a NEW session id, plus a foreground-fork control |

```bash
node spike/probes/790/probe-continued-in.mjs
node spike/probes/790/probe-fork.mjs
```

**Both spend tokens** (one trivial turn each to seed a conversation), unlike
#779's pure-read probes. Backgrounding an idle session costs nothing — that is
one of the findings, not an assumption.

## Why round 1's answer was not the answer

`probe-continued-in.mjs` returned zero records and that is a **true negative for
the wrong question**. The CLI's own output says why:

```
backgrounded · 7b6d4e3c (idle — send a prompt to start)
```

The same short id the parent had, exactly as `--help` documents. No new id means
no successor to name. Round 2 exists because a zero is only a finding once you
know which question it answers — and its variant C is a deliberate **control**:
without a foreground fork to compare against, a hit on the background path would
not distinguish "written when the conversation MOVES" from "written whenever it
forks", and those imply different watcher behaviour.

Round 2 also fixes a self-inflicted wound from round 1: `rmSync` on a scratch
directory a background session still holds throws `EBUSY` on Windows, which in
round 1 threw away the probe's own findings output on its way to the `catch`.
Cleanup is non-fatal here.

## Containment

`spike/findings/e11-00-bus-feasibility.md` §8 records a probe that, given
`bypassPermissions` and a reason to act, read six unrelated projects' transcripts
and messaged live sessions from a "scratch" directory. **A cwd is not a sandbox.**
Both probes here run with the default permission mode and prompts that need no
tools, which is the containment that actually holds, and every background session
they create is stopped and removed — including on failure.

Verify with `claude agents --json` after a run: it should list no `"kind":
"background"` entries left behind.
