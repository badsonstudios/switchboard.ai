# Architecture — switchboard.ai

Full detail: `docs/DESIGN.md` §5 (cite sections when implementing). The shape:

```
Renderer windows (React)          ← views over main-process state; any number,
  session grid · rail · feed        any monitor; popped-out windows stay
  terminals (xterm.js) · Monaco     orchestrator-owned
─────────────────────────────────
Main process (the orchestrator)
  SessionManager   – session registry + state machine (hook-event driven)
  PtyService       – node-pty spawn/resize/kill; scrollback caps
  ProviderAdapters – claude (first-class) | codex | gemini | generic
  TranscriptWatcher– tolerant JSONL tailing → status/usage/events
  HookListener     – loopback HTTP, per-session tokens (§5.29 floor)
  SessionBus       – pub/sub + per-session MCP server (Phase 2)
  GitService       – status/diff/worktree via system git
  WorkspaceStore   – sessions, layouts, geometry w/ display fingerprints
```

**Key invariants:**
- **One session = one CLI child process = one transcript.** The transcript is
  the durable record; the Restoration Guarantee (§5.25) rests on it.
- **Interaction belongs to the CLI** (real TUI in the PTY). We render/route/
  notify. The Feed is read-only display over transcript events (§5.10).
- **Approvals**: PreToolUse hook round-trip if S-03 proves it; PTY-keystroke
  fallback otherwise (§5.16). The approval enforcer is kernel, never a plugin.
- **Extension seams** (§5.23): adapters, panels, event rules, notification
  channels, themes are contribution-shaped from day one; first-party features
  dogfood the internal contract.
- **Security floor** (§5.29): loopback binds, per-session tokens, OS credential
  store, log redaction.

**Spike-first discipline:** the three load-bearing mechanisms (PTY hosting,
hook round-trip, transcript tailing) must be proven by Spike 01 before Phase 1
assembly. If an implementation contradicts a DESIGN.md assumption, amend the
doc in the same PR.
