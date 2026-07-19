# API Keys & Config — switchboard.ai

**Currently required: nothing.** The project deliberately runs on ambient auth:

| Need | How it's authenticated | Notes |
|---|---|---|
| GitHub (`gh`, pushes, issues) | `gh` CLI keyring auth (login `badsonstudios`) | `GITHUB_TOKEN` in `.claude/.env` only as fallback |
| Claude Code CLI | Dan's Max 20x subscription via `claude login` | Dev dependency AND the product's target. **Never an API key** |
| npm registry | anonymous | |

`.claude/.env` exists for future tooling convenience (template:
`.claude/.env.example`). Add a placeholder line there when introducing any new
secret, and tell Dan to fill in the real value. Never print `.env` contents.

**App-level (product) credentials** — API-key auth mode for sessions, pairing
tokens for the mobile companion — are Phase 4 concerns and go through the OS
credential store per `references/security.md`, never through `.env` files.

Optional `.env` entries today: `GITHUB_TOKEN` (fallback), `GITHUB_PROJECT`
(convenience URL), `BUILD_CMD`/`TEST_CMD` (build-test-gate hook overrides).
