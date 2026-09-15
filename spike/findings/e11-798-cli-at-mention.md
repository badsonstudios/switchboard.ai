# E11 #798 — the CLI expands `@path` itself, in Direct mode too

**Date:** 2026-09-15 · **CLI:** PATH `claude` 2.1.272, Windows 11 ·
**Probe:** `spike/probes/798/probe-at-file.mjs` (real CLI, one stream-json session, two turns)

## 1. Why this was measured before building anything

#798 resolves `@Name` in the composer to a sibling session's recent output and
injects it ahead of the prompt. Its negative half says an unresolvable `@word`
reaches the model "as the literal characters the user typed". Both halves
quietly assume the text after send is inert. The review of #797 asked whether
the CLI treats `@something` in a prompt as its own file reference. If it does,
neither half means what it says.

## 2. What the binary does (read, 2.1.272)

**Extractor (`vjr`)** pulls two shapes out of a prompt:

| shape | pattern |
|---|---|
| quoted | `/(^\|[\s。、？！])@"([^"]+)"/g`, excluding the CLI's own `@"… (agent)"` form |
| bare | `/(^\|[\s。、？！])@([^\s]+)\b/g`: **any `@word`** at the start or after whitespace, running to the next whitespace |

**Path parser (`hZs`)** accepts `name#L10` and `name#L10-20` line ranges.

**Attacher (`eZs`, the `at_mentioned_files` step)** resolves each candidate
against the session's cwd:
- it refuses trusted-network and outside-project paths;
- it **lists a directory (≤1,000 entries)** or reads a file;
- it skips a missing path silently.

The step sits in the general per-prompt attachment builder, gated only on
`CLAUDE_CODE_EVAL_CONFINED`. That suggests it isn't transport-specific, which
was measured next rather than assumed.

## 3. Measured

A temp cwd holding `NOTES.md` with a token the model could not guess
(`PERIWINKLE-7731`). One stream-json session, flags as Direct mode uses them.

| turn | prompt | reply | tool calls | transcript |
|---|---|---|---|---|
| 1 | `What is the magic word in @NOTES.md? Answer with just the word.` | `PERIWINKLE-7731` | **none** | an `attachment` line, `attachment.type: "file"`, carrying the token |
| 2 | `What is the magic word in @NOPE.md? If there is no such file, answer MISSING.` | `MISSING` | **`Read`** | no attachment line |

- **Turn 1:** the CLI attached the file before the model saw the prompt. The
  answer came with no tool call, and the transcript records the attachment.
- **Turn 2:** the attacher skipped the missing path silently (no error, no
  attachment), and the MODEL then spent a `Read` looking for it, because it had
  been shown `@NOPE.md`.

Session hygiene: no `--bg`; `claude agents --json` identical before and after
(four interactive sessions); the temp cwd was removed.

## 4. What it means for #798

1. **A literal `@Name` in a sent prompt is also a file mention.** If the
   receiving session's folder holds a `Name` file or folder, it is attached or
   listed, beside whatever switchboard injected for the session of that name.
2. **Even a miss has a cost.** The model has seen `@Name` and may spend a tool
   call hunting for a path.
3. **So #798 rewrites a RESOLVED mention so it is not `@`-shaped** in the sent
   text (`"TradingApp" (session)`). Only the `@` shape changes; every word
   the user typed is still sent, so the line is NOT quoted again inside the
   injected block (that would send it twice).
   Recorded on the issue as a judgment call on the done-when's "original prose
   intact".
4. **The unresolvable half is unchanged.** An `@word` that matches no session
   is sent exactly as typed. The CLI treating it as a path is its own behaviour
   for any `@word`, not something #798 introduces.

## 5. What would falsify this

| observation | meaning |
|---|---|
| a CLI release where the bare-`@` extractor requires a path-like shape (a `/`, a `.`) | `@Name` would stop being a file candidate, and the rewrite in (3) becomes optional |
| `CLAUDE_CODE_EVAL_CONFINED` set in a Direct-mode session | the attacher is skipped: re-run the probe under that env |
| turn 1 answered only AFTER a `Read` call on a later CLI | expansion moved out of the prompt pipeline; re-read `eZs` and its caller |
| a TERMINAL-mode session behaving differently | the probe measured stream-json only; the binary reading says the step is shared, so re-run it in a PTY if #798 ever sends through the terminal |

## 6. Reproducing

```bash
node spike/probes/798/probe-at-file.mjs > report.json
```

Two cheap turns. Check `claude agents --json` before and after.
