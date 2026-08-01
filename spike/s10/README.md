# S-10 — the stream-json transport, measured

Three probes against the CLI **on PATH** (Dan's own install, not the copy the
VS Code extension bundles). Each spends a tiny amount of real subscription
tokens — one turn.

```
cd spike/s10
node probe-a-duplex.cjs       # does duplex stream-json run without --print?
node probe-b-permission.cjs   # does --permission-prompt-tool stdio deliver the .claude/ prompt?
node probe-c-slash.cjs        # do slash commands work, and what does system:init advertise?
```

Override the CLI with `SB_CLAUDE`, e.g.
`SB_CLAUDE="C:\\Users\\dheinz\\AppData\\Roaming\\npm\\claude.cmd"`.

Each probe makes its own trusted temp folder under `%TEMP%`. Unlike S-09's
`run-interactive.cjs`, none of them touch `~/.claude.json` — stream-json mode
never opens the trust dialog, which is itself part of the finding.

Verdicts: `spike/findings/s-10-stream-json-transport.md`.
