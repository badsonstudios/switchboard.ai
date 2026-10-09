# #1174 — asking a session which model it is on

**Measured 2026-10-09** against the CLI on PATH, `2.1.288`, and against the
older `2.1.226` binary the VS Code extension ships. Probe:
`spike/probes/1174/probe1174.mjs` (four modes; only `turn` sends a prompt, one
short one on Haiku).

```bash
node spike/probes/1174/probe1174.mjs cold   <cwd>
node spike/probes/1174/probe1174.mjs turn   <cwd>
node spike/probes/1174/probe1174.mjs resume <cwd> <session-id>
node spike/probes/1174/probe1174.mjs old    <cwd> <path-to-an-older-claude.exe>
```

The question: `stream-model.ts` recorded (against `2.1.245`) that the only
place a session's model appears is `system:init`, once per turn, so a session
that has not replied cannot say what it is on. #1115 noticed in passing that
`get_settings.applied.model` seemed to answer it. Does it, and can the model
chip trust it?

## Findings

1. **A cold session answers.** `get_settings` before any prompt:
   `"applied": {"model":"claude-opus-5-5","effort":"medium", …}`.

2. **It follows `set_model`, at once, with no turn.** `set_model haiku` →
   `claude-haiku-4-5-20251001`; `sonnet` → `claude-sonnet-5-5`; `default` →
   `claude-opus-5-5` again.

3. **It is the same string `system:init.model` carries.** One turn on a session
   started with `--model haiku`: `applied.model` before the turn,
   `system:init.model` during it, the key of `result.modelUsage`, and
   `applied.model` after it were all `claude-haiku-4-5-20251001`. So a value
   read this way is not replaced by a differently-spelled one when the first
   reply arrives.

4. **A resumed session answers too, before any prompt.** `--resume <id>` of the
   session from finding 3, started with no `--model`: `applied.model` was
   `claude-haiku-4-5-20251001`, the model the conversation had been on, not the
   account default. (Read only; no turn was sent on the resumed session to
   confirm by effect.)

5. **It joins to the `list_models` rows exactly.** On `2.1.288` every value seen
   in `applied.model` was some row's `resolvedModel`, character for character
   (`default` and `opus` both resolve to `claude-opus-5-5`; `haiku` to
   `claude-haiku-4-5-20251001`). On `2.1.226` the same held, suffix included:
   `applied.model` `claude-opus-5[1m]` and the `default` row's `resolvedModel`
   `claude-opus-5[1m]`. So `currentIndex` in `lib/model-choices.ts`, which
   already matches `value` and then `resolvedModel`, ticks the right row with
   no change. The looser prefix match `effortLevelsFor` uses was not needed
   for the tick on either CLI, and was not added.

6. **The older CLI on this machine has the `applied` block as well.** `2.1.226`
   answers `{effective, sources, applied}` with `applied.model` and
   `applied.effort`. It lacks only `ultracodeRequested` / `ultracodeAvailable`.

## Not measured

- **A CLI with no `applied` block.** The ticket asks what one answers; no such
  binary is on this machine (`2.1.226` is the oldest, and it has the block).
  The code path for it is covered by unit tests with a hand-made answer, not by
  a capture: `appliedModel` returns nothing, nothing is seeded, and the button
  reads "model?" as it did before.
- **The resumed case by effect** (finding 4).
- **A model changed from inside the session** (the CLI's own `/model`) while no
  turn runs. The app would not hear of it until the next reply or the next
  read; that was already so.

## What the app does with it

- `SessionManager.effort()` already sends `get_settings` once when a card
  appears, for the effort chip. Its answer now carries `model` as well, and the
  `sessions:effort` channel seeds `StreamModel` from it. **No second request
  per card.**
- **The seed only fills a gap** (`StreamModel.seed`): it writes when nothing is
  known and is a no-op otherwise. `system:init` and a model the app set itself
  stay the authorities, so an answer to a read that was in flight across a
  model switch cannot overwrite the newer value.
- The effort chip re-asks when the model CHANGES. The model becoming known
  because of the chip's own read is not counted as a change, or every fresh
  card would ask twice.
- "model?" stays as the fallback: no answer, or no `applied.model`, leaves the
  store empty.
