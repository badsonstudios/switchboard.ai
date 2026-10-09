# #1115 — setting and reading a session's effort level

**Measured 2026-10-09 against the CLI on PATH, `2.1.288`.** Probes:
`spike/probes/1115/probe1115.mjs` and `probe1115b.mjs`. Neither sends a prompt,
so neither costs a turn. Run one with:

```bash
node spike/probes/1115/probe1115.mjs "C:/Projects/Switchboard.ai"
```

The ticket was written against `2.1.245` and assumed `set_thinking_level`. That
assumption is wrong on the installed CLI, which is the reason this note exists.

## Findings

1. **`set_thinking_level` is gone.** It answers
   `Unsupported control request subtype: set_thinking_level`, and the string is
   not in the `2.1.288` binary. `docs/reference-implementations.md` listed it as
   present on `2.1.245`; that line now carries a pointer here.

2. **The level is set with `apply_flag_settings`.**
   `{subtype:"apply_flag_settings", settings:{effortLevel:"high"}}` answers
   `success` with no payload. This is the verb the Agent SDK's
   `applyFlagSettings` sends; the binary describes it as "Merges the provided
   settings into the flag settings layer, updating the active configuration."
   It is a session-scoped layer: nothing is written to a settings file.

3. **All five levels take: `low`, `medium`, `high`, `xhigh`, `max`.** `max`
   included, although the settings schema's own `effortLevel` enum stops at
   `xhigh` (after `max`, `effective.effortLevel` is absent but
   `applied.effort` is `"max"`).

4. ⚠️ **A level the CLI does not know also answers `success`, and changes
   nothing.** `{effortLevel:"no-such-level"}` → `success`; `applied.effort`
   stays where it was. The `set_model` no-field trap again. The acknowledgement
   is not evidence.

5. **The current level IS readable.** `get_settings` answers
   `{effective, sources, applied}`, and:

   ```json
   "applied": {"model":"claude-opus-5-5","effort":"medium","advisor":null,
               "ultracode":false,"ultracodeRequested":false,"ultracodeAvailable":true}
   ```

   It is there on a cold session, before any turn. `initialize` carries no
   effort field (its keys were checked).

6. **`applied.model` is the running model.** `stream-model.ts` and §1.2.2
   record that "nothing marks the current model" except `system:init`, once per
   turn. `get_settings.applied.model` does, on demand, on a cold session. Not
   used for the model chip in #1115 (out of scope); worth a ticket.

7. **A model with no effort levels answers `effort: null`.** After
   `set_model haiku`: `"model":"claude-haiku-4-5-20251001","effort":null`.

8. **The level survives a model switch.** Set `max`, switch to Haiku (`null`),
   switch to Sonnet: `"effort":"max"` again.

9. **`{effortLevel: null}` clears it**, and the level returns to the model's
   default (`medium` here).

10. **`list_models` carries the levels per model.** Thirteen entries on this
    account. Most: `["low","medium","high","xhigh","max"]`. `claude-opus-4-6`
    and `claude-sonnet-4-6`: no `xhigh`. `haiku` (4.5): neither
    `supportsEffort` nor `supportedEffortLevels` is present at all (not
    `false`: absent). `claude-haiku-5-5` has all five.

## What the app does with it

- **Set, then read back.** `SessionManager.setEffort` sends
  `apply_flag_settings` and then `get_settings`, and reports `refused` unless
  `applied.effort` is the level asked for (finding 4).
- **The chip shows `applied.effort`**, asked for when the card appears and when
  the session's model changes; `null` means no chip (finding 7).
- **The levels offered** are the `list_models` entry matched to
  `applied.model`. The match is best-effort (alias and resolved ids do not join
  exactly); a wrong match can only offer a level the model lacks, and the
  read-back catches that.
- **Remembered per card and put back** when the card's session starts again,
  because the flag layer dies with the process (finding 2).

## Not measured

- That a higher level changes what the model does on a turn. Verified here is
  that the CLI reports the level as applied; observing the effect would cost
  real turns at each level and was not done.
- Any CLI other than `2.1.288`. An older one with no `applied` block gets no
  chip (the reader returns nothing rather than guessing).
