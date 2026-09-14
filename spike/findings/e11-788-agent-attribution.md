# #788 — where subagent lines actually live, and who interleaves them

**Probe:** `spike/probes/788/` (two read-only scripts; they spawn nothing and
write nothing). **Corpus:** `~/.claude/projects`, 3,214 transcripts / 246,541
lines, CLI **2.1.226 → 2.1.261**, measured 2026-09-14.

---

## 1. The ticket's premise was wrong, and the repo already knew

#788 was filed on the reading that the CLI writes two concurrent subagents into
one transcript, where they "interleave into one indented run". It does not.

| measurement | result |
|---|---|
| lines in **parent** transcripts | 177,544 |
| of those, carrying `isSidechain` | 136,807 |
| of those, `isSidechain: **true**` | **0** |
| `agentId` anywhere in a parent transcript | **0** |
| lines in `subagents/agent-*.jsonl` | 68,997 |
| of those, `isSidechain: true` | **68,997 — every one** |
| of those, carrying `agentId` | **68,997 — every one** |
| distinct `agentId` **per subagent file** | **1**, in **333 of 333** files |
| files where two `agentId`s interleave | **0** |

The 3,531-line real-capture fixture in `src/main/transcripts/fixtures/` agrees:
zero `isSidechain: true`.

And **DESIGN.md's own resolved open question #5 had recorded this in Spike 01**
(S-05, CLI 2.1.215): *"Subagent transcripts are separate nested files … no
interleaving problem (separate files)."* The ticket was written against a
mechanism the project had already measured and written down. Checking a premise
costs one probe; inheriting it cost this item a design that could not have
worked.

## 2. So who interleaves them? We do

`watcher.ts`'s `deriveBlocks`:

```ts
const sidechain = full !== w.boundFile || e.isSidechain === true;
```

The **left** half fires; the right half is dead code on any CLI from 2.1.226.
The watcher tails every `subagents/agent-*.jsonl` a session owns and drains all
of them into **one** `FeedBuffer`, in tail-arrival order, with nothing on the
blocks to say which file they came from.

**The symptom the ticket describes is real. Its location is exactly where the
ticket said. Only the mechanism was ours rather than the CLI's** — which is
lucky, because it means the fix lands in one place instead of requiring us to
out-parse the CLI.

It is also not hypothetical:

| subagents per parent session | parents |
|---|---|
| 1 | 27 |
| 2 | 15 |
| 3 | 8 |
| 4–6 | 4 |
| 15, 16, 30, 32, 32, 48, 58 | 7 |

Of 61 parent sessions with subagents, **34 ran two or more**, and **10 ran two
whose time spans genuinely OVERLAP** — the longest overlap measured is **757
seconds**.

## 3. Two measurements that shaped the design

**(a) A name does not identify an agent.** One session
(`C--Projects-Ashenfall/0d9e2283…`) ran **three overlapping
`deep-research-specialist`s** plus two overlapping `general-purpose`s. Labelling
a run with `attributionAgent` and stopping there would have produced three
identical captions and separated nothing. `agentId` is the grouping key;
the name is only ever the caption.

**(b) The name is sparser than the id, and systematically so.**

| field | occurrences | line types |
|---|---|---|
| `agentId` | 68,997 | `assistant` 35,287 · `user` 22,506 · `attachment` 11,204 |
| `attributionAgent` | 35,287 | `assistant` **only** |

35,287 is exactly the number of `assistant` lines carrying an `agentId` — so
**every** assistant line in a subagent file is named and **no** `user` or
`attachment` line ever is. A subagent transcript *opens* with a `user` line, so
a run resolved from its head block is anonymous.

Worse, the case that nearly shipped wrong: a **second** run of an agent, after
the parent has said something in between, frequently contains no named line at
all. Resolved per run it would have rendered a bare `Subagent` directly beneath
the same agent's named caption. **Names are therefore resolved per AGENT across
the visible list**, not per run.

Both directions have their own test in `feed-groups.test.ts`, because asserting
only the first run's caption cannot tell the two rules apart.

## 4. The `.meta.json` sidecar (unused, recorded)

Every one of the 333 subagent transcripts has a matching
`agent-<id>.meta.json`; none is missing. Keys, with counts:

`agentType` 333 · `description` 333 · `toolUseId` 333 · `spawnDepth` 333 ·
`model` 116 · `parentAgentId` 115 · `stoppedByUser` 3

`description` is the task the agent was given and would make a richer caption
than `agentType`. **Not used, deliberately:** it reaches us through
`pickupSubagentMeta` on a *schedule*, so a block derived before pickup would
never get one and would never be re-emitted to receive it late. The name on the
line arrives with the line. `parentAgentId` and `spawnDepth` say subagents nest
— worth knowing for anything that later wants a tree rather than a list.

## 5. Schema

`agentId` and `attributionAgent` moved from the root `ignored` list into
`TYPE_SCOPED_ROOT_KEYS`, on #787's and #790's precedent: they are consumed now,
and the two lists are identical to the drift detector, so the only thing a flat
declaration would buy is the names becoming legal on all 38 line types. The
scoping is measured, not inferred from the CLI's reducer — **zero occurrences of
either on any other type.**

`attributionSkill`, `attributionMcpServer` and `attributionMcpTool` stay
`ignored`. We do not read them, and declaring a key consumed that nothing reads
is the claim #779 was filed to stop.

## 6. What would falsify this

Per #787's lesson — a measurement becoming an invariant nobody declared — the
load-bearing claims and their falsifiers:

| claim | falsified by | what breaks |
|---|---|---|
| `agentId` never appears in a parent transcript | a CLI that stamps one on a main-chain line | nothing: `agentOriginFor` **gates on `sidechain`**, so the id is not read there at all |
| one subagent file holds one `agentId` | a CLI that appends two agents to one file | grouping would split on the id, which is still correct — the *file* fallback would mis-attribute an id-less line, and only such a line |
| `attributionAgent` is on `assistant` lines only | the CLI naming `user` lines too | nothing: more names is strictly better, and first-wins-per-agent already tolerates it |
| `isSidechain: true` never appears in a parent transcript | an older transcript on disk | already handled — the `|| e.isSidechain === true` half is kept for exactly this, and such a block is indented and ungrouped, as before |

The gate in `agentOriginFor` is the one that matters: it makes the first claim
**safe to be wrong about** rather than merely likely to be right.
