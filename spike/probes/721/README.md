# Control-protocol probes (#721, #723)

The harnesses behind **`docs/reference-implementations.md` §1.2.2**. They live
here, committed, because that section makes load-bearing claims about the CLI
and a citation into a git-ignored scratch directory dies with the worktree.

Run against the **CLI on PATH** (measured on 2.1.245, 2026-08-28), spawning with
the same stream flag list as `main/providers/claude.ts`. They talk to the real
binary on the real account, so they cost real turns only where noted — none of
these send a prompt.

```bash
node spike/probes/721/probe721.mjs  "C:/Projects/Switchboard.ai"
```

| probe | question it answers |
|---|---|
| `probe721.mjs` | The envelope, verb by verb: `initialize`, `list_models`, `set_model` (good / bad id / **no field** / non-string), an unknown subtype, `get_context_usage`. Prints the top-level vs nested `request_id` for each reply. |
| `probe721b.mjs` | Where does the CURRENT model live? Dumps `initialize`'s keys and every `list_models` entry. Answer: **nowhere** — see finding 3. |
| `probe721c.mjs` | Does `list_models` work on a **cold** session — no `initialize`, no turn? Answer: **yes**, and this one exists because the first version of finding 1 said otherwise and was wrong. |
| `probe-mcp-status.mjs` | `mcp_status` (#723) — the runtime MCP inventory, which the config files cannot reach. |

## The two traps these cost us

1. **`request_id` is NESTED** at `msg.response.request_id` and absent at the top
   level — the opposite of the inbound `can_use_tool` requests the app already
   parses. A correlator that copies the inbound reader matches nothing, for
   ever, and looks exactly like a CLI that never answers.
2. **A silent CLI is worth suspecting your own probe over.** `probe721c` exists
   because an earlier probe appeared to prove the CLI needs an `initialize`
   handshake. It did not: that probe only sent its verb from inside a
   `system:init` handler, and `system:init` arrives **once per turn**, so on a
   session that had run no turn it never sent anything at all.

## Note on `probe721b.mjs`

Its read loop uses `return` where the others use `continue`, so it abandons the
rest of a chunk after the first non-`control_response` line. Both of its
captures landed regardless, but treat any *absence* it reports as unproven.
