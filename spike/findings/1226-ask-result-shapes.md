# #1226 — what the CLI writes as the result of `AskUserQuestion`

**Measured 2026-10-11 against the CLI on PATH, 2.1.288.** Probe:
`spike/probes/1226/probe-ask-result-shapes.cjs`. Artifacts:
`spike/findings/artifacts/1226/ask-result-<mode>.json` (ten runs).

S-11 measured the six shapes switchboard's own panel can produce
(`s-11-ask-user-question.md`, CLI 2.1.233). The question read-back (#1201)
also handles shapes only ANOTHER client can produce, and those had been read
out of the binary rather than measured. This note is the measurement.

## The contract, from the binary

The result is built by the tool's `mapToolResultToToolResultBlockParam`. It
takes more than the `answers` map:

| field on `updatedInput` | what it is |
|---|---|
| `answers` | `{ [question text]: string \| string[] }` |
| `annotations` | `{ [question text]: { notes?, preview? } }` |
| `response` | free text, instead of or beside the answers |
| `followUp` | `true`: the user wants more questions first |
| `afkTimeoutMs` | a number: nobody answered in time |

**The CLI accepts every one of them from a client on `updatedInput`.** None was
refused, in any combination tried.

## What it writes

One pair per question that has an answer or a note, joined with `, `:

```
"<question>"="<answer>"[ selected preview:\n<preview>][ notes: <notes>]
"<question>"=(no option selected) notes: <notes>
```

Then one of these, chosen in this order:

| when | the result |
|---|---|
| `afkTimeoutMs` | `No response after 60s — the user may be away from keyboard. Proceed using your best judgment … still relevant.\n\nBefore going idle the user had selected: <pairs>.` |
| `followUp`, with pairs | `The user asked for more questions before you proceed. So far they answered: <pairs>.[ They also wrote: "<response>".] Call AskUserQuestion again with follow-up questions that build on these answers (do not repeat these); do not start the task yet.` |
| `followUp`, no pairs | `The user asked for more questions before answering.[ They also wrote: "<response>".] Call AskUserQuestion again now with further questions about this decision (do not repeat these); do not proceed with the task yet.` |
| `response` | `The user responded: <response>` |
| pairs, every answer an offered label | `Your questions have been answered: <pairs>. You can now continue with these answers in mind.` |
| pairs, otherwise | `The user answered: <pairs>. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.` |
| nothing | `The user did not answer the questions.` |

## What was not what the strings suggested

1. **`response` beats `answers`.** Sent together (mode `both`), the result is
   `The user responded: …` and the answers are not in it at all. Read from the
   binary's strings alone, the two looked independent.
2. **A note demotes the sentence.** With a note on any question the result is
   `The user answered:` even when every answer is an offered label (modes
   `note`, `preview`). The reader does not depend on which opening it is.
3. **The follow-up wording is not "wants to clarify".** The synthetic test
   string had `The user wants to clarify before you proceed`; the CLI writes
   `The user asked for more questions before you proceed`. The reader found
   the pairs by `So far they answered: ` either way, so it was right by luck.
4. **A follow-up can carry the user's own words after the pairs, and they are
   not escaped.** `… "TypeScript, Rust". They also wrote: "… "shade" too". Call
   …`. The reader took a pair to run to its LAST quote, which here is inside
   the user's words: the last answer would have swallowed them. Fixed: a
   follow-up's ending is found from the last pair forwards.
5. **An array answer is joined with a bare comma.** `"TypeScript,Rust"`, not
   `"TypeScript, Rust"`. It was read as typed text and ticked nothing. Fixed:
   split on a bare comma when every piece is an offered label.
6. **A follow-up with no pairs but words of their own** had no reading at all
   and fell to "not answered", showing the whole instruction sentence. It is
   now read as a response, with the user's words.

## What the read-back does with each

| shape | read as |
|---|---|
| note, preview, note with no pick | answered; the note is kept, the preview is not |
| `response` (with or without answers) | responded, with the text |
| follow-up with pairs | answered (the "also wrote" words are not shown) |
| follow-up, no pairs, with words | responded, with the words |
| follow-up, no pairs, no words | not answered, in the CLI's own sentence |
| gone idle | answered, from what had been selected |
| array answer | answered, and its choices are ticked |

## Not measured

- The `kind: "text"` and `kind: "number"` questions the binary's schema now
  has (`textCount`, `numberCount`, `min`, `max`). The model did not ask one,
  and the read-back treats every question as a choice.
- A preview that is refused (`preview must be an HTML fragment …`): the
  binary validates it; what the result is then was not looked at.

## Cost

Ten short sessions on the subscription, about twenty seconds each. No
background session was left behind (`claude agents --json` checked).
