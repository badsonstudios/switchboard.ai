# #801 — Level 3 fork adoption: what was measured, and the design premise it overturned

**Issue:** #801 · **Probes:** `spike/probes/801/` · **Measured:** 2026-09-19,
`claude` **2.1.272** on PATH, Windows 11, Node 22.20.0.
**Cost:** six trivial one-word turns across two rounds.

**Verdict in one line: `--resume <id> --fork-session --session-id <uuid>`, run
with the cwd set to the target folder, does the whole job — same-folder AND
cross-folder, on both transports — so switchboard never writes into
`~/.claude/projects`, and DESIGN §5.5's "copy A's transcript into the target
project's transcript dir" is unnecessary.**

---

## The questions, and the answers

| # | question | answer |
|---|---|---|
| Q1 | Does `--resume <id> --fork-session` carry A's history? | **Yes** (§1) |
| Q2 | Is A's transcript byte-identical afterwards? | **Yes** — same sha256, size AND mtime, across every variant (§1) |
| Q3 | Cross-folder by absolute `.jsonl` **path**? | **Yes** (§1) |
| Q4 | Where does the fork's transcript land? | **The TARGET cwd's project dir** — not the parent's (§1) |
| Q5 | Does `--session-id` pin the forked id? | **Yes**, every time (§1) |
| Q6 | **CONTROL** — cross-folder by plain **id**, no path? | **Yes — and this is the finding that decides the design** (§2) |
| Q7 | A missing file / an unknown id? | Exit 1 in <1 s, readable sentence, no hang (§4) |
| S2 | On stream-json, does `system:init` announce OUR id or the PARENT's? | **Ours** — the safety-critical answer (§3) |

---

## 1. The base measurements (round 1, `probe-fork-adopt.mjs`, headless `-p`)

Three variants, all exit 0, all carrying a per-run codeword that only A's
conversation contained:

| variant | cwd | resume value | carried history | A byte-identical | fork landed in |
|---|---|---|---|---|---|
| A | folder A | `<idA>` | ✅ | ✅ | A's dir (= the cwd) |
| B | folder B | **absolute `.jsonl` path** | ✅ | ✅ | **B's dir** |
| C | folder B | **`<idA>`, no path** | ✅ | ✅ | **B's dir** |

A's transcript after all three: `sha256 5e34388e…`, 142,982 bytes — **identical
to before, mtime included**. The damaging failure #801 names ("fork" degrading
to "resume in place", which APPENDS to A) did not occur on any path.

`--session-id <uuid>` pinned the forked id in all three. The id must be a valid
UUID — the CLI validates against
`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`, read out of
the binary.

## 2. ⚠️ THE CONTROL IS THE FINDING. The path form is not needed — and neither is the copy.

Variant C is why this note exists. **Cross-folder by plain id worked exactly as
well as by path**: the CLI resolved a conversation belonging to folder A from a
process whose cwd was folder B, forked it, and wrote the new transcript into
**B's** project directory.

The binary explains it — `jX`, the resume resolver, has three lookups in
sequence, and the second and third are cross-directory fallbacks with their own
telemetry:

```js
b = await Gee(e, void 0, r.storageV5, at)   // the ordinary lookup
 ?? await _es(e, r.storageV5)               // tengu_resume_worktree_fallback
 ?? await bes(e, r.storageV5);              // tengu_transcript_id_scan_fallback
```

So there are **three** ways to express the cross-folder fork, and they are
ordered by how much we have to invent:

1. **plain id** — nothing invented. ✅ **This is what ships.**
2. absolute `.jsonl` path — a real argv form (§5), but it makes us construct a
   path into a directory the CLI owns;
3. copy the transcript into the target dir first — DESIGN §5.5's assumption, and
   the only one that WRITES into `~/.claude/projects`.

**Option 3 was the riskiest line in the ticket and it buys nothing.** §5.5 is
amended rather than implemented, and this section is why.

## 3. The stream transport, measured separately (round 2, `probe-fork-stream.mjs`)

Round 1 drove `-p`. **The app does not spawn that way** — Direct is the default
transport and `providers/claude.ts` passes the full duplex stream-json flag list.
Measuring only `-p` would have been the "their behaviour is not our guarantee"
gap one layer in, so round 2 re-ran the cross-folder fork under the **exact flag
list copied from `claude.ts:485-503`**, plus the three fork flags.

Result: turn completed in 3,170 ms, `result:success`, frames
`command_lifecycle, system:init, system:status, user, stream_event, assistant,
rate_limit_event, result:success`.

⚠️ **`system:init.session_id` WAS OUR `--session-id`, NOT THE PARENT'S.** This is
the one that decides whether the feature is safe to build. The app binds a card
to the id the CLI announces; had the fork announced A's id, the new card would
have bound to **A's transcript** and two cards would have tailed one file — the
failure #484 and #539 both exist to prevent. Measured explicitly, asserted as
three separate facts (`announcedMatchesRequest: true`, `announcedIsParent:
false`, and the id itself), because a single equality check that happened to
pass would not have distinguished them.

Also measured: **zero control requests** arrived. A prompt that needs no tools
produces no `can_use_tool`, so the fork adds nothing to answer on that channel.

## 4. Failure modes

| input | exit | time | stderr |
|---|---|---|---|
| a `.jsonl` path that does not exist | 1 | 975 ms | `No conversation found with session ID: <id>` |
| an id the CLI has never seen | 1 | 940 ms | `No conversation found with session ID: <id>` |

Both **refuse readably and fast, and neither hangs** — the done-when. The
sentence is the CLI's own and should be passed through rather than reworded
(the rule `mcp/cli.ts` and `#721` already follow).

⚠️ **ONE ODDITY, RECORDED RATHER THAN SMOOTHED OVER.** For the missing-FILE case
the error named an id (`4fb97c25…`) matching **neither** the filename in the argv
(`078eb1db…`) **nor** anything else in the run. Consistent with the CLI minting a
fresh id when handed a `.jsonl` it cannot load — there is a resolver in the
binary that does exactly that (`{sessionId: Pn(), jsonlFile: e, isJsonlFile: true}`)
— but that was **not** confirmed to be on this code path, and the alias it sits
under (`X8n`) has at least two unrelated definitions in different module scopes.
It does not affect the shipped design, which never passes a path. **Do not build
on it.**

## 5. What was READ, and what was MEASURED

The done-when asks which parts of the storage layout were verified against the
PATH binary and at what version. Split honestly:

**MEASURED against `claude` 2.1.272 by driving it** (§§1–4): fork carries
history; parent byte-identical; fork lands in the target cwd's project dir;
`--session-id` pins the forked id; `system:init` announces it; cross-folder works
by plain id; refusals are fast and readable; zero control traffic.

**READ from the binary's embedded source, 2.1.272, not driven:**

- `--fork-session` — *"When resuming, create a new session ID instead of reusing
  the original (use with `--resume` or `--continue`)"*;
- `--session-id <uuid>` — *"must be a valid UUID"*, with the regex above;
- `--resume [value]` — *"Resume a conversation by session ID, or open interactive
  picker with optional search term"*. **The help text does not mention the file
  form**, but the file form is real: `fse(v.resume)` tests `endsWith(".jsonl")`,
  the expected id is derived from the FILENAME, and the branch has its own
  telemetry entrypoint (`"file"` vs `"cli_flag"`), its own error (`Unable to load
  transcript from file: …`) and its own log line (`--resume file unreadable`);
- the CLI's own background launcher pairs the flags the same way we do:
  `["--session-id", <new>, "--fork-session", "--resume", transcriptPath ?? sessionId]`;
- the CLI's human-facing cross-directory hint is `cd <projectPath> && claude
  --resume <id> --fork-session` — it changes DIRECTORY, it does not copy a file;
- `relocated` / `relocatedCwd` is a first-class record the CLI writes itself, both
  when relocating a transcript and when branching one. **We observed ZERO of them
  across every fork variant**, so nothing in our path depends on it.

**NOT MEASURED, and not built on:**

- the `left_arrow` REPL fork gesture (inherited from #790, still undriven);
- `--resume-session-at=` and `--resume-drops-turn=`, which the SDK's argument
  builder emits and we never send;
- what a fork does to a conversation that is **currently live in another
  process**. Every probe forked an idle session. The CLI has a holder check with
  a `canFork: true` hint, and `--fork-session` skips it — but the behaviour was
  not driven.
- whether the fork's transcript is a full COPY of the parent's history. Line
  counts suggest it is (A: 24 lines → fork: 30–31), which would make a fork of a
  7 MB conversation cost 7 MB on disk. **Suggested, not measured**; nothing in
  the design depends on it, but it is the first thing to check if disk use is
  ever reported.

## 6. What this changes

| item | change |
|---|---|
| DESIGN §5.5 | The cross-folder variant's "copy A's transcript into the target project's transcript dir, then fork-resume there" is **not needed**. Amended, with §2 as the reason |
| #801 | Ships on the plain-id form. The app writes nothing into `~/.claude/projects` — it would have been the first code in the repo to do so |
| the lineage model | A forked card's head is the **fork's** id. A's id must NOT enter the new card's lineage, or the new card would `claim` A's conversation (`ConversationRow.claimed`) and two cards would contend for one transcript |
| `--session-id` | Validated as a UUID before spawn. The CLI refuses a bad one, but a refusal at spawn is a card that crashes on open |

## 7. Containment

Both probes ran `--permission-mode default` with prompts that needed no tools,
**foreground `-p`/stream only — no `--bg`**, so no background session was
created and none could leak (the standing hazard: `claude agents --json` is the
check). Every transcript either run created was recorded by id and **deleted at
the end** — six in total, all confirmed removed. Scratch folders were temp dirs.
