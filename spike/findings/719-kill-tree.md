# #719: does closing a stream session strand the CLI's MCP servers?

**Date:** 2026-09-22 · **CLI:** 2.1.272 (native `claude.exe` behind npm's
`claude.cmd`) · **Machine:** dev desktop, Windows 11, Defender only ·
**Probe:** `spike/probes/719-kill-tree/probe.cjs`

## Why

The laptop had 122 `node.exe` at idle: 53 `npx-cli.js` wrappers, 53 Azure
DevOps MCP servers, and 4+4 each of two other MCP pairs. The ticket's last
diagnosis blamed `StreamSession.kill()`, a single-process kill of the
`cmd.exe` launcher, and prescribed `killTree`. This probe measured that before
building it.

## Method

The real CLI, launched exactly as `StreamSession` launches it
(`cmd.exe /c claude.cmd --output-format stream-json --verbose --input-format
stream-json --permission-prompt-tool stdio`), plus `--mcp-config` with one
stdio server and `--strict-mcp-config`. Once the server tree was up, the
probe snapshotted every process below cmd.exe (Win32_Process), ended the
session, and counted survivors 8 to 15 s later. Every survivor was killed
before exit.

## Results

| scenario | launcher kill (old `kill()`) | `taskkill /T /F` |
|---|---|---|
| server fully up: stand-in, real `npx @azure/mcp`, `cmd /c npx` | 0 survivors, ~12 runs | 0, ~8 runs |
| killed mid-startup (stand-in delayed 10 s, real npx from an empty cache) | 0, ~10 runs | 0 |
| first-ever run: real npx still checking the registry for `@latest` | **2** (npx-cli node + conhost), once, not reproduced | — |
| stdin closed only (`eof`) | exits in **~170 ms**, code 1, 0 survivors, 4 runs | — |
| stdin closed **mid-turn** (haiku, counting to 400) | exits in **~210 ms**, code 1, the turn is abandoned | — |
| **CLI gives up on its own** (`MCP_TIMEOUT=3000`, stand-in behind `cmd /c`, delayed 10 s, ignores EOF), session left ALIVE | **wrapper orphaned while the session lives, then starts its server**: the npx-cli + server pair shape | cannot reach it: already outside the tree |
| same give-up, stand-in NOT behind `cmd /c` | 0 | — |
| same give-up, real npx (`server-everything`, `@azure/mcp`) from an empty cache | 0: both exit on stdin EOF | — |

## Findings

1. **The CLI reaps its own MCP servers when we kill the launcher.** The
   premise that every close, Restart and quit leaks does not hold here.
2. **The CLI's give-up path can orphan an MCP server.** When a server is
   behind a `cmd /c` layer (every `npx` server on Windows) and is too slow to
   start, the CLI kills that cmd.exe only. A wrapper that ignores stdin EOF
   survives it, then starts its server, and the pair lives on. This is
   CLI-side, and no kill of ours can reach it. The servers I could test here
   exit on EOF and did not leak. The laptop's Azure **DevOps** server was not
   available to test.
3. **Node children never show the launcher problem.** libuv puts every child
   in a kill-on-close job object, so a node grandchild of a node child dies
   with it. The first unit test built on node → node passed against the old
   `proc.kill()`. A real `.cmd` launcher is what exposes it.
4. **Closing stdin is a clean, fast shutdown** (~200 ms, even mid-turn, same
   exit code 1). That made "close stdin, then `killTree` after a 3 s grace"
   the shipped design. It keeps the CLI's own cleanup (SessionEnd hooks, final
   transcript write), which a `/F` tree kill would skip.

5. **At app quit, our own kill needs the app alive.** Every child libuv
   spawns sits in a kill-on-close job object, `taskkill` included, so a
   fire-and-forget tree kill at quit can die before it runs. Quit therefore
   holds on `will-quit` and drains (`StreamService.shutdownAll`). Two things
   were learned in e2e along the way. A `preventDefault` + `app.quit()` issued
   in the same breath is silently dropped by Electron, and the app hangs with
   no windows. So the re-quit goes on a fresh tick, and there is no hold at
   all when no stream is alive. Real app, `stream*.spec.ts`: 33 quits with a
   live Direct session, each drained in ~70 ms, 35 of 35 quits completed.

## Open

Which of these produced the laptop's 53 is not settled. The heartbeat now
carries a process census (`sysProcs`, `sysTop`, `sysEnumMs`) and our own live
children by kind. A climb in `node.exe` while `children.stream` stays flat,
during sessions and not at closes, points at finding 2.
