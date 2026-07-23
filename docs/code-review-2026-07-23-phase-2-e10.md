# Code Review — `auto/phase-2-e10` vs `main` (2026-07-23)

> **For the session working this file:** This is a verified deep review of the
> branch diff (`git diff main...HEAD` on `auto/phase-2-e10`, ~3,750 lines,
> 35 files). Every finding below was independently confirmed against the code
> by a verification pass — line numbers were accurate at review time but the
> code may have moved; re-locate by symbol name if a line is stale. Work the
> sections in order (P0 → P1 → P2 → P3). For each finding: re-read the cited
> code, apply the fix, add/adjust a test where one is suggested, and check the
> box. Run the existing test suite (`npm test` / e2e lanes per
> `.claude/skills/startup/references/testing.md`) after each section. Update
> `PROGRESS.md` when you start and when you finish, per project rules.

**Review scope:** branch `auto/phase-2-e10` (E10 + live-test fixes), diff vs `main`.
**Method:** 8 finder angles → 42 candidates → dedup → adversarial verification (18 individual correctness verifiers + 3 batched cleanup verifiers). 36 confirmed, 1 plausible, 1 refuted (dropped).

> **Status 2026-07-23 (commit `7c55c78`):** P0 #1–#5 all fixed, tested, and
> pushed. #1 resolved by OWNER DECISION (Option A): plan mode never holds —
> `GATED.plan = []` and plan excluded from the out-of-cwd read rule; DESIGN
> §5.16 records the rule. Everything from P1 down is still OPEN — nothing
> later was incidentally fixed (verified against the code before this
> annotation). Next: P1 #6–#8 (watcher trio).

---

## P0 — Permission-hold cluster (fix before merge)

These five compound: a held request can be invisible (#5), lost (#4),
auto-approved when it shouldn't be (#1, #2), or dropped with no replay (#3).
The net effect violates the project's hard **fail-open** constraint ("our
breakage never blocks a session") and the permission model's intent.

### [x] 1. Plan-mode "Allow" bypasses the CLI's permission system

- **Where:** `src/main/hooks/hook-listener.ts:77` (GATED table) and `decide()` (~lines 200–209)
- **Bug:** `'plan'` autonomy gates Write/Edit/Bash into the hold flow, and a user "Allow" replies to the PreToolUse hook with `hookSpecificOutput.permissionDecision: 'allow'` — per Claude Code hook semantics that **bypasses** the CLI's permission system, including plan mode's write-block. Clicking Allow in a plan session performs a real file write in a session the user believes is read-only planning.
- **Fix direction:** In plan mode, an "allow" decision should *not* return `permissionDecision:'allow'`. Either return no decision (let the CLI's own plan-mode prompt/block run), or don't gate mutating tools in plan mode at all and let the CLI enforce plan semantics. Decide deliberately; document in DESIGN.md if behavior changes.
- **Test:** unit test on `decide()` output for autonomy `'plan'` + tool `Write`.

- **DONE (7c55c78):** Option A per owner — `GATED.plan = []`, plan excluded from `READ_GATED_AUTONOMIES`; DESIGN 5.16 note; policy unit tests assert plan never holds any tool or out-of-cwd read.

### [x] 2. "Allow all (this session)" outlives the session

- **Where:** `src/renderer/src/components/SessionGrid.tsx:667` (`allowAllByCard`), consulted at ~line 230
- **Bug:** The Set is module-level, keyed by **durable card id**, and never cleared (comment admits "cleared on app restart by construction"). Live sessions are ephemeral and respawn/`--resume` under the same cardId — so a new session inherits auto-approval with no prompt, despite the "this session" wording.
- **Fix direction:** Key by live session id, or clear the card's entry on session exit/respawn. (See also P2 finding #16 — the flag arguably belongs in the main process entirely; if you do #16, this collapses into it.)
- **Test:** e2e or unit: allow-all → session restart → next gated call must prompt again.

- **DONE (7c55c78):** `allowAllByLive` keyed by LIVE session id (set from the held request's sessionId); a respawn/resume gets a fresh id and prompts again. Revisit home with P2 #19 (main-process move) later.

### [x] 3. Fire-and-forget permission push; fail-open guard permanently defeated

- **Where:** `src/main/sessions/ipc.ts:89` (`hooks.onPermissionRequest(...)`), `send()` guard at ~lines 58–61; `src/main/hooks/hook-listener.ts:329` (`permListeners.size === 0` guard), pending map + 300s timer ~lines 346–355
- **Bug:** `ipc.ts` registers a permission listener unconditionally at startup, so hook-listener's "nobody listening → fail open" guard can never fire. But `send()` silently drops the push when the window is destroyed/reloading, and there is **no pending-list/replay API** — a request that misses the renderer (reload, pre-mount race, missing `cardOfLive` mapping → `cardId` undefined) parks the CLI for the full 300s hold timeout with no UI able to answer.
- **Fix direction:** Expose the pending map over IPC (e.g. `sessions:pendingPermissions` invoke) and re-push pending requests when the renderer (re)subscribes / window recreates. Also consider releasing the hold immediately if the push provably has no recipient.
- **Test:** unit on hook-listener + a replay test: hold → simulate renderer resubscribe → request re-delivered.

- **DONE (7c55c78):** pending map now stores the full request; `pendingRequests()` + `sessions:pendingPermissions` invoke; the card replays pending holds on (re)subscribe. Unit test: replay list populated while held, empty after decide.

### [x] 4. Concurrent held requests overwrite the single `perm` slot

- **Where:** `src/renderer/src/components/SessionGrid.tsx:234` (`setPerm({...})` overwrites), `:248` (`setPerm(null)` on decide)
- **Bug:** hook-listener imposes no per-session limit on holds (pending keyed by requestId) and the CLI can issue parallel tool calls. The card holds ONE request: a second overwrites the first; deciding either dismisses the bar. The orphaned request stalls until the 300s fail-open.
- **Fix direction:** Queue: hold a list of pending requests per card, show them one at a time (or stacked); on decide, advance to the next.
- **Test:** unit on the queue logic; e2e with two rapid holds if feasible.

- **DONE (7c55c78):** per-card queue (`permQueue`), bar shows head + "+N more waiting", decide advances; resolved events prune idempotently. e2e: two rapid holds -> allow first, deny second, both verdicts asserted.

### [x] 5. ApprovalBar unreachable when card is on Terminal/Changes tab

- **Where:** `src/renderer/src/components/SessionGrid.tsx:531` (`{view === 'feed' && <FeedView ...>}`), perm state at ~:116, passed only to FeedView at ~:539
- **Bug:** The ApprovalBar renders only inside FeedView. On the Terminal or Changes tab there is **no affordance at all** — the hold precedes the CLI's own TUI prompt so even the terminal shows nothing; the status pill is a non-clickable span. Session appears frozen up to 300s.
- **Fix direction:** Render the approval UI at card level (above the tab switch), or auto-switch to the Session tab on a held request, or make the needs-permission pill a click-through to the bar. Card-level render is the robust option.
- **Test:** e2e: hold while Terminal tab active → approval UI visible/decidable.

- **DONE (7c55c78):** a held request auto-surfaces the Session tab (`setView('feed')` on enqueue) — keeps the owner's above-composer placement AND reachability from any tab. e2e: hold while Terminal active -> bar visible + decidable.

---

## P1 — Correctness bugs (fix before merge)

### [ ] 6. Wrong transcript can be bound when head lacks a parseable sessionId

- **Where:** `src/main/transcripts/watcher.ts:386` (mismatch guard requires truthy `head.sessionId`), idMatch ~:394–395, cwd-only branch ~:399–405
- **Bug:** `main`'s old guard `if (w.nativeSessionId && head.sessionId !== w.nativeSessionId) return false` rejected candidates with an unparseable/absent head sessionId (`undefined !== nativeId`). The new guard requires `head.sessionId &&` to be truthy, and the filename is only used as *positive* evidence — so a file whose sessionId-bearing head lines are oversized/unparseable (readHead's catch "keeps scanning" and can return `{cwd, sessionId: undefined}`) can be claimed via the cwd path even though its filename is not `<nativeId>.jsonl`. Wrong conversation streams into the session.
- **Fix direction:** When `w.nativeSessionId` is set, also reject candidates whose *filename* doesn't match `<nativeId>.jsonl` (or restore the strict head check). Filename check is cheap and robust.
- **Test:** extend `watcher.test.ts`: nativeSessionId set + candidate with unparseable head sessionId + matching cwd → must NOT bind.

### [ ] 7. `resetBinding()` never tells the renderer — stale blocks after a mis-bind correction

- **Where:** `src/main/transcripts/watcher.ts:217–234`; only renderer channel is `sessions:feedBlock` (`src/main/sessions/ipc.ts:102`); renderer refetch only on sessionId change (`FeedView.tsx:289`); `upsertBlock` matches by seq (`src/renderer/src/lib/feed.ts:25`)
- **Bug:** After a mis-bind correction, main clears blocks and resets `blockSeq = 0` but emits nothing. The renderer keeps the stolen blocks; the correct transcript re-emits from seq 1 and overwrites them one-by-one — if it's shorter, the tail still shows the other session's conversation until remount.
- **Fix direction:** Emit a `sessions:feedReset` (or a `{kind:'reset'}` sentinel on the existing channel) from `resetBinding()`; renderer clears its block state on receipt.
- **Test:** unit: resetBinding emits the reset; renderer store clears on it.

### [ ] 8. Same-cwd sessions never bind when hooks are dead (fail-open regression)

- **Where:** `src/main/transcripts/watcher.ts:396–403` (`if (this.hasCwdSibling(w)) return false;`), `hasCwdSibling` ~:242–247
- **Bug:** cwd-only binds are hard-rejected whenever ANY other watched session (bound or unbound) shares the folder, with no time-based relaxation (`WIDEN_AFTER_MS` widens scan scope, not this rule). If hooks never deliver native ids (hook listener broken/blocked — the designed-for fail-open path — or a future no-hooks provider), two same-cwd sessions never bind; feed/usage/Session views stay empty forever. `main` bound first-match.
- **Fix direction:** Add a deadline: after N seconds without a native id, fall back to best-effort cwd binding (accepting the ambiguity), or at least surface the unbound state in the UI instead of silent emptiness.
- **Test:** watcher.test.ts: two same-cwd watchers, no native ids, advance past the deadline → binding proceeds (or documented alternative).

### [ ] 9. Shell blocks render rich only for tool name `Bash` — misses `PowerShell` on Windows

- **Where:** `src/renderer/src/components/FeedView.tsx:210` (`b.tool?.name === 'Bash'`); `src/main/hooks/hook-listener.ts:68–71` (`SHELLISH = ['Bash','PowerShell']`, probe-dated comment)
- **Bug:** The branch's rich shell rendering (description header, IN/OUT sections, attached output) dispatches on exactly `'Bash'`. Windows CLI sessions emit a `PowerShell` tool (the codebase itself records this) — so the feature silently degrades to a generic ToolRow on the app's primary platform.
- **Fix direction:** Classify shell-ness once in the main process — extract the SHELLISH/MUTATING/READ taxonomy into a shared module, have the watcher stamp blocks with a category (`'shell' | 'edit' | ...`), and have the renderer dispatch on category, never raw tool names. (This also serves P2 finding #15.)
- **Test:** feed e2e/unit: a PowerShell tool block renders the rich shell layout.

### [ ] 10. `isOutsideCwd` misclassifies paths (two defects, same function)

- **Where:** `src/main/hooks/hook-listener.ts:95–103`
- **Bug (a) — resolve base:** `path.resolve(x)` resolves relative tool paths against the **Electron process's cwd**, not the session folder. Glob/Grep `path` params can realistically be relative → in-workspace paths spuriously held; outside paths that happen to resolve under the app cwd wrongly allowed.
- **Bug (b) — drive root (empirically reproduced):** `path.resolve('D:\\')` keeps the trailing separator, so `base + path.sep` = `'d:\\\\'` and no path matches the prefix — with a drive-root session folder, **every** Read/Glob/Grep is held. Nothing upstream normalizes: `cwdFor` returns `identity.folder` verbatim (`src/main/index.ts:290`), `sessions:open` only type-checks the string (`src/main/sessions/ipc.ts:138`).
- **Fix direction:** `const r = path.resolve(cwd, x)` for (a); for (b) compare via `path.relative(base, r)` (outside iff it starts with `..` or is absolute on another root) instead of string-prefixing — that fixes both trailing-sep and case handling in one move. Keep the win32 lowercase fold.
- **Test:** unit table: relative in/out paths, drive-root base, normal base, cross-drive.

### [ ] 11. Auto-compact `SessionStart` flips a working session to idle

- **Where:** `src/main/sessions/state-machine.ts:86–91`; hook-listener `ingest()` ~:384–394 never extracts `source`
- **Bug:** `SessionStart` unconditionally `to('idle')`. The CLI also fires SessionStart with `source: 'compact'` mid-turn during auto-compaction — the working banner disappears and the feed event is dropped even though the turn resumes seconds later.
- **Fix direction:** Extract `source` in ingest and pass it through; state machine ignores SessionStart when `source === 'compact'` (and consider `'resume'` semantics deliberately).
- **Test:** state-machine unit: working + SessionStart(compact) → stays working.

### [ ] 12. Composer Enter submits mid-IME-composition

- **Where:** `src/renderer/src/components/FeedView.tsx:632–637`
- **Bug:** `e.key === 'Enter' && !e.shiftKey` with no composition guard — confirming a CJK/IME candidate sends the half-typed draft + CR to the live PTY.
- **Fix direction:** Bail when `e.nativeEvent.isComposing` (add `keyCode === 229` for Safari-family robustness if desired).

### [ ] 13. Any prefs update wipes `osToasts` (and quiet hours) to defaults

- **Where:** `src/main/workspace/store.ts:210–211` (`setNotificationPrefs` replaces wholesale), sanitize at ~:280 (`osToasts: x.osToasts === true`); preload type omits `osToasts` (`src/preload/index.ts:181–185`); only caller sends `{ enabled: next }` (`App.tsx:209`)
- **Bug:** Replace-then-sanitize semantics mean the UI's enabled-toggle resets every other notification pref. `osToasts` isn't even settable from the UI.
- **Fix direction:** Merge patch onto existing prefs before sanitizing: `sanitizeNotifications({ ...this.state.notifications, ...p })`.
- **Test:** store unit: set osToasts true → setNotificationPrefs({enabled:false}) → osToasts still true.

### [ ] 14. `upsertBlock` appends evicted-seq re-emits out of order

- **Where:** `src/renderer/src/lib/feed.ts:24–33`; watcher re-emit paths `watcher.ts:543–548`, `toolBlocks` retention ~:597–602, BLOCK_CAP eviction ~:501
- **Bug:** On a seq miss (block evicted past the 1000 cap), the re-emitted old block is appended at the tail — an ancient block renders as newest. Reachable: toolBlocks keeps up to 200 in-flight blocks with no age pruning while the main list evicts.
- **Fix direction:** On findIndex miss, insert by seq order (or drop re-emits whose seq is below the current window's minimum — dropping is simpler and correct for a capped view).

### [ ] 15. EventsPanel initial `list()` races the `events:changed` push

- **Where:** `src/renderer/src/components/EventsPanel.tsx:35–38`
- **Bug:** `void events.list().then(setEvents)` + `onChanged` subscription with no staleness guard: a push arriving while `list()` is in flight is overwritten by the stale snapshot; self-heals only on the *next* change.
- **Fix direction:** Ignore the `list()` result if a push has landed first (a `gotPush` flag in the effect), or subscribe first and re-fetch after.

---

## P1-test — Test-code bugs

### [ ] 16. `feed.spec.ts` relaunch test leaks the first app instance on failure

- **Where:** `e2e/feed.spec.ts:92–103`; afterEach cleans only `a` (`:15`)
- **Bug:** `const first = await launchApp(...)` is never assigned to the shared `a` until after `first.close()`; an assertion failure in between leaks the Electron/PTY tree — the exact CI tree-kill poison documented in project memory.
- **Fix direction:** `a = first` immediately after launch (afterEach then covers it), or wrap in try/finally. Audit the file for the same pattern elsewhere.

### [ ] 17. real-claude fixture copies live OAuth credentials into %TEMP% and can leak them

- **Where:** `e2e/fixtures/app.ts:74–81` (copy happens before `electron.launch`, ~:99–101); rmSync failures swallowed ~:127–131
- **Bug:** `~/.claude/.credentials.json` + `~/.claude.json` are copied to `mkdtempSync(os.tmpdir())`. If launch throws before the handle is returned, `afterEach a?.cleanup()` is a no-op and real subscription tokens persist on disk. Opt-in local lane and per-user %TEMP% temper severity, but it conflicts with the project's credentials-never-in-files rule.
- **Fix direction:** try/catch around launch inside the fixture that rms the temp dir on failure; consider a process-exit hook as a backstop. Document the residual copy in the lane's README/comment.

---

## P2 — Design/altitude improvements (post-merge OK, file issues if deferred)

### [ ] 18. Hold policy ignores the CLI's `permission_mode` and uses a spawn-time autonomy snapshot

- **Where:** `src/main/hooks/hook-listener.ts:75` (GATED/READ_TOOLS tables), `maybeHold` ~:321–343; `ipc.ts:302–303` ("applies on the NEXT spawn/resume")
- **Issue:** The PreToolUse payload carries `permission_mode`, which is the CLI's live truth — the code parses the payload and never reads it. A live Shift+Tab mode change or settings allow-rules make switchboard's holds diverge from what the CLI would actually prompt for (nagging for pre-approved tools; the PowerShell miss already proved the table rots).
- **Fix direction:** Read `permission_mode` from the event as the authority (fall back to the stored autonomy), and move the tool taxonomy into a per-CLI provider-adapter module (shared with #9's fix).

### [ ] 19. Allow-all belongs in the main process

- **Where:** `src/renderer/src/components/SessionGrid.tsx:230` + notifier path (`notifier.ts:64` beeps on needs-permission)
- **Issue:** Every gated call in an allow-all session still gets held, flips to needs-permission, **beeps/flashes**, and round-trips IPC before the renderer auto-decides. If the renderer is wedged/reloading, approvals stall.
- **Fix direction:** Store per-session allow-all in HookListener (checked in `maybeHold` before parking); renderer sets it via one IPC call. Fixes #2's lifetime question at the same time (key it by live session).

### [ ] 20. UserPill regex-parses command-wrapper XML in the renderer

- **Where:** `src/renderer/src/components/FeedView.tsx:441` (extracts only `<command-name>`; expand at ~:467–468 shows raw XML); watcher's `isPlumbing` (`watcher.ts:106–108`) only filters `<local-command-*>`
- **Issue:** Sibling `<command-message>`/`<command-args>` tags render as escaped raw XML in the pill; the CLI's wrapper format is now handled in two layers.
- **Fix direction:** Parse command wrappers in the watcher (which owns plumbing knowledge), emit a structured block (`kind:'command'`, name/args fields); renderer renders fields only.

### [ ] 21. Feed events ship raw live-session ids; renderer reconstructs identity

- **Where:** `src/renderer/src/components/EventsPanel.tsx:42–46` (byId join, `events.unknownSession` fallback at ~:163); `ipc.ts:45` owns `cardOfLive` and already enriches permission requests (~:90) but ships events raw (~:69)
- **Issue:** Any event whose session isn't in the current rail snapshot degrades to "unknown session"; every event consumer must re-implement the join.
- **Fix direction:** Attach `cardId`/title in ipc.ts when pushing `events:changed`, mirroring the permission-request enrichment.

---

## P3 — Cleanup: efficiency + duplication (batch into one tidy commit)

Efficiency (all verified in code):

- [ ] 22. `hook-listener.ts:313–316` — each hook POST body is `JSON.parse`d twice (`maybeHold` :324 and `ingest` :379). Parse once in the request handler, pass the object to both.
- [ ] 23. `watcher.ts:418` — `readHead` reads a 256KB buffer + parses 25 lines for every unbound candidate every ~100ms tick, no cache (was 4KB/1 line on main). Cache per file keyed by `(size, mtime)`; remember rejected-ambiguous candidates until `nativeSessionId` changes.
- [ ] 24. `FeedView.tsx` — wrap `Block`/`EditBlock`/`BashBlock`/`TodosBlock`/`ToolRow` in `React.memo` (upsertBlock preserves reference identity of untouched elements, so memo is fully effective); useMemo the EditBlock line-count computation.
- [ ] 25. `SessionGrid.tsx:226–243` (+ :202, :218) — per-card global IPC listeners fan every event out to N cards. One app-level dispatcher routed by cardId. Low impact today; do it if touching the file for P0 #4/#5 anyway.
- [ ] 26. `ipc.ts:69` — full events list pushed per change. Verified low-cost today (list stays ~N sessions); optional delta push. Skip unless convenient.

Duplication / simplification (all verified):

- [ ] 27. `FeedView.tsx:496–508` — ApprovalBar's `pane()` is property-identical to module-level `editPane()` (:50–64). Delete `pane`, call `editPane`.
- [ ] 28. Autonomy order list exists **three times with a discrepancy**: `App.tsx:99` and `SessionGrid.tsx:110` use `['ask','plan','auto-edit','full-auto']`; `ipc.ts:306` validator uses `['plan','ask','auto-edit','full-auto']`. Export one `AUTONOMY_ORDER` + `nextAutonomy()` from a shared module.
- [ ] 29. `hook-listener.ts:96–99` — the win32 path normalizer duplicates the closure inside `sameFolder` (`watcher.ts:150–155`). Extract one exported normalizer both import (fold into #10's fix).
- [ ] 30. `hook-listener.ts` — `this.opts.holdTimeoutMs ?? 300_000` duplicated at :273 and :353 (the CLI-side timeout must stay above the server hold — one getter protects the invariant). `tool_input` narrowing duplicated at :331–334 and :360–363 with drifting fallbacks (`undefined` vs `{}`) — reuse the local.
- [ ] 31. `watcher.ts:387` + `:399` — the cwd predicate evaluated in two complementary forms calling `sameFolder` twice; compute `cwdOk` once (fold into #6's fix).
- [ ] 32. `FeedView.tsx` — `String.fromCharCode(10)` at :99, :444, :607 where plain `'\n'` is used elsewhere in the same file; UserPill's expandable predicate spelled three ways (:443, :447, :456) — reduce to one `expandable` boolean.
- [ ] 33. `e2e/approval.spec.ts:29–37` — hand-rolled `poll()` duplicates `expect.poll` (used in session.spec.ts/reconnect.spec.ts); the log-file/port/token extraction block repeats verbatim at :52–58, :96–102, :126–132 — hoist into a fixture helper. `e2e/real-claude.spec.ts:37` — use the `showTerminal()` fixture (`e2e/fixtures/app.ts:137`) instead of a raw Terminal-button click.

---

## Refuted during verification (do NOT "fix")

- **state-machine.ts:103 needs-input narrowing** — the claim that mapping "Claude is waiting for your input" to idle drops genuine ask-the-user cases was **refuted**: a genuine question ends the turn → Stop hook → `to('done')`, which is an attention feed kind that beeps/flashes; the idle_prompt notification arrives while status is 'done', where it was already inert (`stay('idle-after-done')`). The narrowing is correct as-is.

## Suggested working order

1. P0 #1–#5 as one focused branch/commit series (they all touch hook-listener/ipc/SessionGrid; #19 and #2 interact — decide the allow-all home first).
2. P1 #6–#8 (watcher trio), then #9–#10 (shared taxonomy + isOutsideCwd), then #11–#15 individually.
3. P1-test #16–#17.
4. P2/P3 as follow-ups; file GitHub issues for anything deferred past the merge.
