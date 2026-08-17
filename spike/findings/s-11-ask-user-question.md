# S-11 probe 2 — `AskUserQuestion`, the chooser

**Date:** 2026-08-17 · **CLI on PATH:** `claude` 2.1.233 · **Extension read:**
`anthropic.claude-code-2.1.226-win32-x64` · **Probe:**
`spike/s11/probe-2-ask-user-question.cjs` (5 modes) · **Artifacts:**
`spike/findings/artifacts/s11/ask-user-question-{answer,other,deny,ignore,empty}.json`
· **Issue:** #563 (the `AskUserQuestion` half of plan item E18-11)

---

## The verdict in one line

**`AskUserQuestion` is not CLI-kept.** It is delegated over the same
`can_use_tool` control channel the approval bar has consumed since P2-E18-07,
and the answer travels back as ordinary tool input. There was nothing new to
build in the transport; the whole item was a UI surface and one extra field on
`decide`.

That settles half of what E18-11 was gated on. Plan mode / `ExitPlanMode` is
still unmeasured and stays in that item.

---

## 1. How the question arrives

```
control_request
  request_id: "<id>"
  request:
    subtype:   "can_use_tool"
    tool_name: "AskUserQuestion"
    tool_use_id: "toolu_…"
    input: { questions: [ … ] }
```

**No `decision_reason`, no `decision_reason_type`, no
`permission_suggestions`** — none of the permission furniture a `Write` request
carries (compare S-10 probe B). That is correct and worth noticing: it is not
asking for permission, so there is nothing to justify and nothing to suggest.
Anything rendering "which is a sensitive file" beside a question is inventing it.

### The input

```jsonc
{
  "questions": [
    {
      "question": "Which colour do you prefer?",   // ALSO the answer's key
      "header": "Colour",                          // short tab-style label
      "options": [
        { "label": "Red", "description": "Prefer red" },
        { "label": "Green", "description": "Prefer green" },
        { "label": "Blue", "description": "Prefer blue" }
      ],
      "multiSelect": false
    },
    { "…": "second question, multiSelect: true" }
  ]
}
```

Several questions arrive in ONE call. There is **no id on a question** — the
question TEXT is the only key it has, which is what the answer map is keyed by
and therefore what a duplicate text would collide on.

## 2. How the answer goes back

```jsonc
{ "behavior": "allow",
  "updatedInput": {
    ...input,                                     // carried back verbatim
    "answers": {
      "Which colour do you prefer?": "Red",
      "Which of these languages do you use?": "TypeScript, Rust"
    } } }
```

Three properties, all measured, none obvious:

1. **Keyed by question text.** No index, no id — there is nothing else.
2. **A multi-select answer is a comma-space joined STRING**, not an array.
3. **Free text is indistinguishable from a label** on the wire. There is no
   `other` field; the typed text simply occupies the value.

The CLI's tool_result on success:

> `Your questions have been answered: "Which colour do you prefer?"="Red",
> "Which of these languages do you use?"="TypeScript, Rust". You can now
> continue with these answers in mind.`

## 3. The four failure modes, measured

| Mode | What we sent | What the CLI did |
|---|---|---|
| `other` | free text in no option list | **Accepted, and NOTICED.** The tool_result changes to *"The user answered: … Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say."* The model then said, unprompted, "You didn't pick any of the offered options — you typed free-text answers instead". **"Other" is first-class, not a workaround.** |
| `deny` | `{behavior:'deny', message}` | `is_error` tool_result carrying our message. The model recovered gracefully and asked the same thing in prose. **Refusing is safe.** |
| `empty` | `allow` with the input echoed back, **no `answers`** | `"The user did not answer the questions."` — no error, no retry, the turn just moves on without the answer. |
| `ignore` | nothing at all, for **180 seconds** | **Nothing. No TUI fallback, no CLI-side timeout, no nudge.** The tool_result only appeared when the probe killed the process, and then as a rejection. |

### Why `empty` is the finding that changed the design

A bare allow is precisely what **allow-all** would send, on two separate paths:
`StreamPermissions.offer`'s server-side short-circuit (which never pushes to a
renderer at all) and the renderer's `intakePermission`. Left alone, a session in
allow-all — or full-auto — would have silently skipped **every question it ever
asked**, with nothing on screen to say so. Both paths now exempt
`AskUserQuestion`, as does the OS toast's Allow button, which would have been the
same skip fired from a notification.

"Allow all tools in this session" is not "answer all questions in this session".

The same reasoning closed one more door that review found still open: main
validates the renderer's `updatedInput` before it reaches the CLI's stdin, and a
rejected payload used to fall back to the request's own input — which is a bare
allow, i.e. this exact skip, fired from inside the validator meant to prevent
it. An answer that was offered and cannot be carried is now a **deny** saying so.

### Why `ignore` makes the fail-open load-bearing

The existing 300s deadline in `StreamPermissions` is not belt-and-braces here —
it is the only thing between an unanswered question and a session that waits for
ever. P6 is doing real work on this message class.

## 4. What the VS Code extension contributed

Read first, per the standing rule, and it pointed the probe at the right channel
before a line was written:

```js
class iX extends Ji { name = Zc /* "AskUserQuestion" */;
  renderInput(){ return null }
  permissionRequest(e,t,i,n){ return b(Lct,{input:t,onInputChange:i,options:n}) } }
```

It is a **tool-permission renderer** — same base class as `Bash` and `Edit` —
which is what said "this rides `can_use_tool`". Its panel builds the same
`answers` map (`webview/index.js`, the `", "` join and the Other substitution
are visible in the minified source). Everything above was then **verified against
the CLI on PATH**, because the extension ships its own 265 MB binary and S-10's
lesson is that the two can differ.

Two UI choices we did **not** copy, and why:

- **The tab strip.** A multi-question call renders as tabs with a 300ms
  auto-advance. Prettier, and it lets Submit be reached with an unanswered tab
  off screen. Ours stacks them and gates Submit on all of them.
- **The literal string `"Other"`** as an option label. Ours is a translated UI
  label that never crosses the wire — the typed text replaces it either way, so
  there is nothing to keep in English.

## 5. Open, and deliberately not measured

- **A partial `answers` map** (some questions answered, some absent) was never
  sent, so its reading is unknown. The UI refuses to produce one — Submit
  requires every question — which is why it stayed unmeasured. If a future
  surface wants partial answers, probe it first.
- **Two questions with identical text in one call.** The CLI's own consumer
  collapses them (one key), so we do too. Not observed in the wild.
- **Plan mode / `ExitPlanMode`** — the other chooser. Still unmeasured; still
  E18-11.

## 6. Reproducing

```bash
cd spike/s11
node probe-2-ask-user-question.cjs            # answer  (the happy path)
node probe-2-ask-user-question.cjs other      # free text
node probe-2-ask-user-question.cjs deny
node probe-2-ask-user-question.cjs empty      # the allow-all shape
node probe-2-ask-user-question.cjs ignore     # 3 minutes, on purpose
```

Each run writes its full transcript to
`../findings/artifacts/s11/ask-user-question-<mode>.json`. `SB_CLAUDE` overrides
the CLI under test.
