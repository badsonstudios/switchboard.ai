# Probe 812 — team-session envelope keys in the corpus

`count-envelope-keys.mjs` counts transcript lines carrying `teamName`,
`agentName` or `sessionKind` at the ROOT, per line type.

```bash
node spike/probes/812/count-envelope-keys.mjs
```

Read-only over `~/.claude/projects` (`PROBE_ROOT` overrides); spawns nothing.

**2026-09-15:** 3,151 transcripts / 270,366 lines, **0** of each key on any
type. The corpus is pruned over time (3,259 transcripts at #779), so this is
"none among the transcripts still on disk", not "never happened".

Why these keys: the CLI's generic append writes `teamName` and `agentName` on
every line when a team context is set (PATH binary 2.1.270; unchanged in
2.1.272), and `sessionKind` on every line when `CLAUDE_CODE_SESSION_KIND` is set.
The schema's handling of the first two is #812. `sessionKind` is a follow-up.

**2026-10-23 (#824, PATH CLI 2.1.288):** re-run for `sessionKind` — 3,680
transcripts / 360,600 lines, still **0** of each key. Binary re-read: the
identity block is `Jqn(e) = {sessionKind:KF(), userType, entrypoint, cwd,
sessionId:e, version}`, spread AFTER the entry in the generic append; `KF()`
returns `CLAUDE_CODE_SESSION_KIND` when it is `bg` / `daemon` /
`daemon-worker`; the background spawner's env literals set it to `"bg"` (two
sites, no other value). Switchboard never spawns `--bg`, which is why the
corpus is empty. `sessionKind` is now declared flat in `schema.ts`.
