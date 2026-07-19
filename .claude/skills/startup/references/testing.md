# Testing — switchboard.ai

**Current phase (Spike 01):** no test suite. Spike items are findings-driven —
each item's "done when" is an observable behavior plus a written findings note.
Verify by actually driving the harness (spawn a real `claude` session, trigger
a real hook, watch a real transcript) and record what happened, including
numbers (latency, CPU, memory) where the item asks for them.

**Phase 1 onward (set up in P1-E1):**
- **vitest** for unit tests (services: SessionManager state machine,
  TranscriptWatcher tolerant parsing, GitService output parsing, token/theme
  utilities).
- Integration tests around the CLI boundary use recorded fixtures (captured
  transcripts, hook payloads) so CI never needs a live `claude` login.
- E2E (Playwright-for-Electron) considered at Phase 2 — decide when the UI
  stabilizes.
- CI (GitHub Actions) runs lint + typecheck + build on Windows/macOS/Linux for
  every PR; red CI blocks merge.

**Rules:**
- Never report half-working code as done — record blockers in PROGRESS.md with
  failing output.
- When there's a runtime surface, run the app and see the change work; tests
  alone don't count as verification.
- The tolerant-parser tests must include garbage/unknown-schema lines — the
  transcript format is an unofficial contract that WILL drift (OQ #3).
