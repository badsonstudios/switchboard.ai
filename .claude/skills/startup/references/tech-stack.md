# Tech Stack — switchboard.ai

Decided in `docs/DESIGN.md` §6 (cross-platform requirement drove everything):

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Electron** | Multi-window over one main process; utilityProcess for future plugin host |
| Language | **TypeScript** everywhere | |
| UI | **React** | Renderer windows are views over main-process state |
| Terminal | **xterm.js + node-pty** | ConPTY on Windows, forkpty elsewhere — the VS Code stack |
| Editor/diff | **Monaco** (read-only + diff only) | A built-in code editor is explicitly rejected (PHILOSOPHY §5) |
| Docking | **Dockview**-class library | Never hand-rolled; must support tab tear-off + cross-window drag |
| Build | **electron-vite** (Phase 1 P1-E1-01) | |
| Tests | vitest planned (Phase 1 decision) | |
| Git ops | shell out to system `git` | parsed into models; no native bindings |

**Current reality:** no scaffold yet. Spike 01 builds a throwaway harness in
`spike/` with the minimal real stack (Electron + xterm.js + node-pty). The
production scaffold is P1-E1-01.

**Day-one architecture rules (Phase 1, lint-enforced once E1 lands):**
- Colors only through theme tokens — never raw values (§5.20).
- No hardcoded user-facing strings — i18n from the first commit (§5.21).
- Structured JSON-lines logging with sessionId correlation + redaction (§5.22).
- Features built behind contribution-point interfaces where cheap (§5.23).

**Provider integration:** the `claude` CLI is driven via PTY (interactive),
hooks (events/approvals), and JSONL transcript tailing — never the Anthropic
API. Multi-provider later via adapters (Codex, Gemini, Aider).
