# Security — switchboard.ai

Full detail: `docs/DESIGN.md` §5.29. The rules that bind every PR:

- **Secrets:** `.claude/.env` never committed (hook enforces). No API keys in
  code, config, logs, or tests. The app stores end-user credentials in the OS
  credential store (Windows Credential Manager / Keychain / libsecret) — never
  files. There is NO Anthropic API key anywhere in this project.
- **Local listeners** (HookListener now, Session Bus + remote API later):
  bind loopback only; per-session bearer tokens; Host/Origin allowlist;
  default-deny. Any new listener follows this floor from its FIRST build — no
  "harden later".
- **Log redaction lives in the logger** (§5.22), not in developer discipline:
  tokens/keys/credentials structurally cannot reach a log line. Prompt and
  transcript content stays out of logs at default level.
- **Hook payloads and transcript lines are untrusted input** — parse
  defensively, never eval/exec content from them, never interpolate them into
  shell commands.
- **Plugin/extension boundary** (later, §5.23): capability manifests are
  enforced by the main process; PTY/exec power is brokered through approval
  surfaces, never granted raw.
- Electron hygiene: contextIsolation on, nodeIntegration off in renderers,
  sandboxed preloads, no remote content loaded into privileged windows.
