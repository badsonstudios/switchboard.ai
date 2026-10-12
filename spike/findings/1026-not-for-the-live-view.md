# #1026 — "not rendered in the live UI": what it is, and how it is spelled

**Probe:** `spike/probes/1026/probe-transcript-only-on-stream.mjs`
**CLI:** 2.1.288 (PATH), Windows 11 native
**Date:** 2026-10-12
**Cost:** three turns (two one-word replies, one compaction of a two-line
conversation). Temp cwd removed; `claude agents --json` clean afterwards.

---

## The one-line answer

The ticket asks for a rule for `is_visible_in_transcript_only` and
`is_virtual`. **Neither reaches our stream, and one of them is not a reason to
drop anything.** What the flag marks is real, though, and it was on screen:
**every compaction's summary was being drawn as a prompt the user typed**, on
both transports, under two different spellings, neither of which is the one
the ticket names.

`blocks.ts` now drops it (`isNotForTheLiveView`).

---

## 1. What sets the flag: a compaction, and only a compaction

Read off the binary. `isVisibleInTranscriptOnly: true` is assigned in three
places, all of them the builder of a compaction's summary message:

```js
Ae({ ...eY(yt, {…}), isCompactSummary: !0, isVisibleInTranscriptOnly: !0 })
Ae({ ...eY(Ot, {…}), isCompactSummary: !0,
     ...Ee.length > 0 ? { summarizeMetadata: {…} } : { isVisibleInTranscriptOnly: !0 } })
```

The second is "summarize up to here / from here": with messages kept beside
the summary it is `isCompactSummary` and NOT transcript-only.

And the CLI's own live view honours it, in the function that decides whether a
message is drawn (`n` is "transcript mode"):

```js
function kLr(e, n) {
  if (e.type !== "user") return !0;
  if (e.isMeta) { if (x0(e.origin)) return !0; return !1 }
  if (e.isVisibleInTranscriptOnly && !n) return !1;
  return !0;
}
```

## 2. In the transcript: counted, not sampled

Every `.jsonl` under `~/.claude/projects` on this machine:

| key | files | lines |
|---|---|---|
| `"isVisibleInTranscriptOnly":true` | 13 | 16 |
| `"isCompactSummary":true` | 13 | 16 |
| `"isVirtual":true` | 0 | 0 |
| `"is_visible_in_transcript_only"` | 0 | 0 |
| `"is_virtual"` | 0 | 0 |

All 16 are the same thing: `type: "user"`, string content beginning *"This
session is being continued from a previous conversation"*, both flags on the
same line, no `isMeta`, across CLI 2.1.261, .270, .272, .280 and .288. Nothing
else has ever carried either flag here.

`deriveIntents` read neither, so each was a `user` block: a prompt pill, up to
20,000 characters of summary, under a NEW PROMPT divider, and an entry in the
prompt list. `last-prompt.ts` already carries a text match for that opening
sentence, which is the same bug met once before and patched at one reader.

## 3. On the stream: one field, and it is neither of the two in the ticket

`is_visible_in_transcript_only` occurs **twice** in the whole binary: the wire
schema's declaration, and a string table. **No converter writes it.** What the
internal -> wire converter writes for a `user` message is:

```js
case "user": { …
  return [{ type: "user", message: n.message, session_id: q(),
            parent_tool_use_id: null, uuid: n.uuid, timestamp: n.timestamp,
            isSynthetic: O4e(n), … }] }

function O4e(e) { return e.isMeta || e.isVisibleInTranscriptOnly || e.isCompactSummary || void 0 }
```

Three internal flags, **one wire field, in camelCase**: `isSynthetic`. Nothing
in `src/` read it. (It is also the documented one: the Agent SDK's user
message type declares `isSynthetic`.)

**Measured.** One turn, `/compact`, one more turn, with switchboard's own flag
list. Both control tokens came back. What `/compact` put on the wire, in order:

| frame | notes |
|---|---|
| `system:status` | `status: "compacting"` |
| `system:status` | `status: null, compact_result: "success"` |
| `system:init` | the SAME session id; nothing rotates |
| `system:compact_boundary` | `compact_metadata: {trigger: "manual", pre_tokens: 32516, post_tokens: 4760, …}` |
| **`user`** | **the summary, as a string. `isReplay: false`, `isSynthetic: true`** |
| `user` | `<local-command-stdout>Compacted </local-command-stdout>`, `isReplay: true` |
| `result:success` | |

No echo of `/compact` itself and no `assistant` frame.

The flag census over all 30 frames (every key matching `/^is[_A-Z]/`):
`isReplay` x4, `is_error` x3, `isSynthetic` x1. Nothing else: no `is_meta`, no
`is_visible_in_transcript_only`, no `is_virtual`.

And the transcript the same session wrote: the summary is there as `user` with
`isVisibleInTranscriptOnly: true, isCompactSummary: true` and no `isSynthetic`.
**The same message, two spellings, one per transport.** Also in that file: an
`isMeta: true` user line (`<local-command-caveat>…`) that was NOT sent on the
stream at all.

So before this change, a Direct session that was compacted (by the user, or by
Claude Code on its own when the window fills) grew a "prompt" nobody typed,
live. A Terminal session got the same from its transcript, and every resumed
session replayed it.

## 4. The rule

In `deriveIntents`, beside `isMeta`'s:

```ts
if (entry.isVisibleInTranscriptOnly === true || entry.is_visible_in_transcript_only === true) return true;
if (entry.isCompactSummary === true || entry.is_compact_summary === true) return true;
return entry.type === 'user' && entry.isSynthetic === true;
```

- **Why `isCompactSummary` on its own too.** The wire flag is the OR of three.
  A "summarize up to here" summary is `isCompactSummary` without the other,
  and still `isSynthetic` on the wire. For the same turn to get one answer on
  both transports, the transcript side has to drop every flag the wire folds
  in: `isMeta` (already dropped), and these two.
- **Why the snake_case twins.** Declared on the schema, unreachable today by
  reading. A guard on a declared field, as #997's `is_meta` is.
- **`is_virtual` is deliberately not in it.** The CLI's own description:
  *"Display-only: rendered in the UI but filtered before API send."* That is
  an instruction to SHOW it. Zero occurrences in any transcript here, none on
  the stream; the Feed's default already does what it asks.
- **`isSynthetic` is read on `user` entries only**, the only shape the
  converter writes it on.

To the ticket's first question: yes, one general rule, at the one place that
owns the drop decision. The two flags it names are not two cases of it: one is
the rule, the other is its opposite.

## 5. What this takes away, and what is not built

The summary pill was wrong, and it was also the only thing in the conversation
that showed WHERE a compaction happened. That is gone with it: after this
change a compaction leaves no mark in the Session view at all.

The right source for a mark is not the summary, it is the frame built for the
purpose: `system:compact_boundary`, on the stream and in the transcript
(`type: "system", subtype: "compact_boundary"`), with the token counts before
and after. `stream-feed.ts` defaults it away today ("not content"). Rendering
it as a divider, the way a `/clear` gets one, is a feature of its own and is
filed as one.

## 6. Method notes

- **The ticket's premise was half wrong, and reading found that for free.**
  Two `grep -c`s and one window of the converter said `is_visible_in_
  transcript_only` cannot be on our wire, before a token was spent. The probe
  then went after the thing that could be.
- **Count the transcripts before provoking anything.** The 16-of-16 census
  over real conversations said what the flag marks more firmly than any single
  provoked turn could.
- **The fake had no `/compact`.** It answered it like `/cost`, with an
  `assistant` frame the real CLI does not send. It now emits the measured
  frames and writes the measured transcript lines, so the two spellings are
  exercised in the real app (`e2e/feed-compaction.spec.ts`).
