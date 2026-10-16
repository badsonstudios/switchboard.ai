# #1285 — Codex over ACP, measured

Findings: `spike/findings/e40-codex-acp.md`. Plain Node (22), no dependencies.
Run from this folder. **Every probe except the spawn-shape check spends real
tokens on whatever ChatGPT account `~/.codex` is logged into.**

| Script | What it measures | Model turns | Capture(s) |
|---|---|---|---|
| `probe-a-spawn-shapes.mjs` | Three Windows spawn shapes for `npx.cmd`, `--version` only | 0 | `captures/a-spawn-shapes.jsonl` |
| `probe-a-init.mjs [in\|out\|both]` | `initialize` + `session/new`, logged in, and logged out via an empty temp `CODEX_HOME` | 0 | `captures/a-init-in.jsonl`, `captures/a-init-out.jsonl` |
| `probe-b-session.mjs` | Stub MCP attach, model switch, update variants, permission allow, cancel, `/status` | 6 | `captures/b-session.jsonl`, `captures/b-mcp-stub.jsonl`, `captures/b-session-id.txt` |
| `probe-c-resume.mjs` | `session/resume`, `session/load` in fresh processes; permission REJECT | 2 | `captures/c-resume.jsonl`, `captures/c-load.jsonl` |
| `probe-d-app-server.mjs` | `codex app-server`: structured rate limits, per-turn usage pushes | 1 | `captures/d-app-server.jsonl` |

`probe-c-resume.mjs` resumes the session id `probe-b-session.mjs` wrote, so run
B first. `node show.mjs <capture-stem> [kinds|result:<id>|method:<m>|update:<kind>|notes]`
prints parts of a capture.

**Before running:** create `sandbox/` with its own `git init`, an `AGENTS.md`
saying "Begin every reply with the code word AGENTSWORD-7731." and a
`CLAUDE.md` saying the same with `CLAUDEWORD-4492`. `sandbox/` is git-ignored.
The probes run Codex with `cwd` = `sandbox/` only; a permission answered
"allow" really runs.

**After running:** `tasklist | grep -i codex` must be empty (each probe kills
its tree on exit and on a crash), and the probe sessions land in
`~/.codex/sessions/`; remove them with `codex delete --force <uuid>`.

**Capture format:** one JSON object per line, `{t, dir, frame|text|extra}`;
`dir` is `out` (we sent), `in` (parsed stdout frame), `nonjson-stdout`,
`stderr` or `note`. Redacted at write time (`lib.mjs` `redactValue`): email
addresses, JWT-shaped strings, and the value of any key naming a token, cookie,
secret, API key, password, account id or user id.

**Spawn shape:** `lib.mjs` copies `src/main/transport/win-cmd.ts` `execSpec`
and `stream-service.ts` `launchSpec`; `SPAWN_SHAPE=exec` selects the former
(it fails here, see the findings), the default is `launch`.
