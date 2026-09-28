# #977 — where a subagent run actually comes from on the stream transport

**Probes:** `spike/probes/977/` — two scripts, three real CLI turns between them,
against the **PATH CLI 2.1.280** on our exact stream flag list. Each deletes the
transcripts it minted and starts no background session.

---

## The question, and why the issue's answer was half right

#977 says: *"build sidechain blocks from `parent_tool_use_id` — it is on every
stream message and needs no probe to read."* That is true about the FIELD and
wrong about the DATA behind it.

## 1. `--forward-subagent-text` gates the subagent's own voice, and we do not pass it

From the CLI's own help text (read out of the binary):

> `--forward-subagent-text` — Forward subagent text and thinking blocks as
> assistant/user messages with `parent_tool_use_id` set (only works with
> `--print` and `--output-format=stream-json`)

Measured, one `Agent` call, our flags:

| | sidechain frames on the stream | what they are |
|---|---|---|
| our flags today | **1** | the `user` frame that SEEDS the subagent (its prompt) |
| `+ --forward-subagent-text` | **2** | that, plus the subagent's own `assistant` reply |

So today we receive enough to know a subagent RAN, what it is called and what it
was asked — and nothing it said.

## 2. ⚠️ BUT THE REPLY IS ON DISK ANYWAY, WITHOUT THE FLAG — and that decides the item

Second probe, baseline flags, **no** `--forward-subagent-text`:

```
subagentFiles:  [agent-afb9ed2ef24b4c224.jsonl, agent-afb9ed2ef24b4c224.meta.json]
subagentLineCount: 13
DISK_SAID_PINEAPPLE: true          <- the subagent's reply, in full
assistantAgentId:          afb9ed2ef24b4c224
assistantAttributionAgent: general-purpose
```

Line shapes in that file:

```
user/sidechain
attachment/sidechain  x9
assistant/sidechain/named:general-purpose
attachment/sidechain  x2
```

Every line carries `isSidechain: true`; the `assistant` line carries `agentId`
**and** `attributionAgent`. That is **exactly #788's contract**, unchanged on
2.1.280 — the fields its renderer, its grouping rule and its caption were built
for.

## 3. And the watcher is ALREADY TAILING those files

`watcher.ts` sets `deriveFeed: false` for a stream session so the transcript
cannot double every block. That flag stops `deriveBlocks` from producing
anything — **it does not stop the tail.** The drain is explicitly ungated:

> *"The tail drain is NEVER gated. It is the latency-critical path (it is what
> puts words on the screen), and it is a cheap stat + read from a known offset on
> a file we already hold"*

and bound sessions sweep for new subagent files on a swept tick
(`subagentFiles`), on a 100 ms timer.

**So the IO is already being paid. The bytes are already being read. The only
thing being thrown away is the derivation.**

## What this means for the design

Two candidate sources, and the measurement separates them cleanly:

| | (A) the stream | (B) the watcher |
|---|---|---|
| needs a new CLI flag | **yes** (`--forward-subagent-text`) | no |
| additional file IO | none | **none — already tailed** |
| carries `agentId` / `attributionAgent` | no (maps `parent_tool_use_id` / `subagent_type` instead) | **yes, #788's own fields** |
| fixes the REPLAYED half (#395's note) | no — a resumed card has no stream history | **yes, free**: `subagentFiles` reads the directory that is already there |
| latency | immediate | ≤ ~100 ms tick + the CLI's flush |
| code | new branch in `StreamFeed`, new origin mapping, new fake verb | **one condition in `deriveBlocks`** |

**(B), and it is not close.** The #719 objection — "do not give the watcher more
to do" — is what a reader will reach for, and the measurement answers it: the
files are read either way, so the delta is a `deriveIntents` call per sidechain
line, not a watch.

### What (B) does NOT get, recorded so nobody re-derives it

- **No token-level streaming for a subagent.** A subagent's reply appears when
  its line is flushed, not as it types. Measured on the other side too: **zero**
  `stream_event` frames carried a `parent_tool_use_id` in either run, with or
  without the flag — so the stream would not have given deltas either. Nothing
  is lost.
- **`--forward-subagent-text` stays off**, and the reason is now written down
  rather than being an omission: it duplicates on the stream what the watcher
  already reads from disk, and turning it on would put the same subagent text
  into one `FeedBuffer` twice.

## Two smaller findings, both about assumptions in the issue

**The tool is called `Agent`, not `Task`.** On 2.1.280 the `tool_use` block is
`name: "Agent"`, input `{description, prompt, subagent_type, run_in_background}`.
Anything keying on `'Task'` keys on a name this CLI does not emit.

**`subagent_type` and `task_description` are on the stream ENVELOPE**, beside
`parent_tool_use_id`:

```
keys: [type, message, parent_tool_use_id, session_id, uuid, timestamp,
       subagent_type, task_description]
```

The issue expected to have to correlate with the `Agent` call's input to get a
name. It would not have needed to — and under (B) the question does not arise at
all, because `attributionAgent` is on the line.

## Unmeasured, and named rather than assumed

- Whether `forwardSubagentText` in the `initialize` control request (the SDK in
  the VS Code extension carries it beside `agentProgressSummaries`) can turn the
  stream forwarding on at RUNTIME. Irrelevant under (B); worth knowing if (A)
  ever becomes interesting.
- Whether a subagent that runs in the background (`run_in_background: true`)
  writes the same layout. Not exercised.
