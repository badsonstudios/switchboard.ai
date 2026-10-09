# #715 — asking a session how full its context window is

**Measured 2026-10-09** against the CLI on PATH, `2.1.288`, and the older
`2.1.226` binary the VS Code extension ships. Probe:
`spike/probes/715/probe715.mjs`. Only its `turn` mode sends a prompt (one short
one, on Haiku).

```bash
node spike/probes/715/probe715.mjs cold   <cwd>
node spike/probes/715/probe715.mjs turn   <cwd>
node spike/probes/715/probe715.mjs resume <cwd> <session-id>
node spike/probes/715/probe715.mjs old    <cwd> <path-to-an-older-claude.exe>
```

`docs/reference-implementations.md` §1.2.2 recorded (#721, on `2.1.245`) that
`get_context_usage` "works" and has a `percentage`. This note is the shape, and
when it can be asked.

## Findings

1. **The answer has seventeen top-level keys.** `categories`, `totalTokens`,
   `maxTokens`, `rawMaxTokens`, `autocompactSource`, `percentage`, `gridRows`,
   `model`, `memoryFiles`, `mcpTools`, `agents`, `slashCommands`, `skills`,
   `autoCompactThreshold`, `isAutoCompactEnabled`, `messageBreakdown`,
   `apiUsage`. Identical key list on `2.1.226`.

2. **The scalars are all the meter needs.** A cold Opus session:

   ```json
   {"totalTokens":36198,"maxTokens":1000000,"rawMaxTokens":1000000,
    "autocompactSource":"model-default","percentage":4,
    "model":"claude-opus-5-5","autoCompactThreshold":967000,
    "isAutoCompactEnabled":true,"apiUsage":null}
   ```

   `percentage` is a whole number and is the CLI's own
   `totalTokens / maxTokens` (36198 / 1,000,000 → 4; 35607 / 200,000 → 18).

3. **A cold session is not at zero.** The system prompt, tools, skills, agents
   and memory files are already counted: 4% of a million here, 17% to 19% of
   Haiku's 200,000.

4. **The window follows the model, at once, with no turn.** After
   `set_model haiku` on the same cold session: `maxTokens` 200000,
   `percentage` 18, `autoCompactThreshold` 167000.

5. **It answers during a turn.** Asked on the first stream event of a reply:
   `totalTokens` 40638, `percentage` 20. After the turn: 38614, 19. (The
   mid-turn figure was higher than the settled one; it is the CLI's running
   estimate, and the app shows whatever the CLI says.)

6. **A resumed session answers before any prompt, and already counts the old
   conversation.** `--resume` of a one-turn Haiku session: `totalTokens`
   38913, `percentage` 19.

7. **`autoCompactThreshold` is below `maxTokens`.** 967,000 of 1,000,000;
   167,000 of 200,000. With `isAutoCompactEnabled: true` the CLI compacts on
   its own there, so on Haiku the meter can never be seen above about 84%
   unless auto-compact is off.

8. **The answer carries paths from the user's machine.** `memoryFiles` lists
   each memory file by absolute path; `mcpTools`, `agents` and `skills` list
   every one by name. The app reads four numbers in main and passes nothing
   else on.

## Not measured

- **What the answer looks like right after the CLI compacts.** That needs a
  window filled to the threshold, which is a great many real turns.
- **`isAutoCompactEnabled: false`.** The reader treats it as "no compaction
  point to mention"; the CLI's answer with it off was not captured.
- **A CLI that has no `percentage`.** Both binaries here have it. The reader
  works it out from the two counts when it is missing, and shows nothing when
  it cannot; that path is unit-tested with made-up answers only.

## What the app does with it

- `SessionManager.contextUsage()` sends the verb and returns
  `{percentage, totalTokens, maxTokens, autoCompactAt}`; `autoCompactAt` is the
  threshold when auto-compact is on, else `null`.
- The meter under the prompt box asks when the card appears, when a turn
  starts and ends, when the model changes, and every 20 seconds while a turn
  runs. No answer keeps the last figure; no figure at all draws nothing.
- **Colours: no yellow.** The ticket asks for yellow from about 60%. The
  owner's later rule (#1165) reserves yellow and orange for "a session needs
  you", so the meter is plain below 60, blue from 60 and red from 80. Flagged
  for him to overrule.
