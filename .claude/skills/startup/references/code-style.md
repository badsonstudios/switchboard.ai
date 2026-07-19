# Code Style — switchboard.ai

Formal ESLint/Prettier config arrives with the Phase 1 scaffold (P1-E1-01);
until then, these conventions govern:

- **TypeScript strict mode**, no `any` unless justified with a comment.
- Naming: `camelCase` functions/vars, `PascalCase` types/components,
  `kebab-case` filenames. React components one-per-file.
- Prefer plain functions + explicit interfaces over classes except where
  Electron/service lifecycles genuinely want them.
- **Main/renderer boundary is sacred:** renderers never reach into Node APIs
  directly — everything crosses typed IPC. No business logic in renderers.
- Errors: fail-open philosophy (P6) — degraded features log + continue; only
  the session-safety invariants may hard-stop.
- Comments state constraints the code can't show; no narrative comments.
- **Lint-enforced once E1 lands (honor them from the start):** no raw color
  values (theme tokens only, §5.20); no hardcoded user-facing strings (i18n
  keys, §5.21); logical CSS properties (`margin-inline-start`, not `-left`).
- Spike code (`spike/`) is exempt from polish — but not from the secrets and
  logging-redaction rules.
