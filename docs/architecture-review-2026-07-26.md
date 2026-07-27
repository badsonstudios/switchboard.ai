# Architecture Review — 2026-07-26

**Scope:** full architectural review of the shipped implementation against
`DESIGN.md`, `PHILOSOPHY.md`, `extensibility.md`, and the plan files. Read at
Phase 2 mid-flight (E7 + E8 + E10 + E12 merged; E9-01/02/03 merged; E11/E13/E14
still outlines). ~15k lines of `src/` plus the full doc set.

**Reviewer's verdict:** the architecture is sound and unusually disciplined. The
core abstraction (durable card / ephemeral live session), the authority split
(hooks = status, transcript = telemetry), and fail-open are real in code, not
just in the doc. **But the extensibility seam covers one wall of the building**,
and three structural gaps get exponentially more expensive after E9 lands eleven
more work items on the current shape.

**Owner decisions taken on this review (2026-07-26):**
1. **Third-party plugin support is a real goal** — initially first-party
   add-ons only, but the public API is the destination. Capability brokering
   therefore stays full-size; it is not trimmed to "internal structure only."
2. **Phase 3/4 scope is not being cut** — reassessed when we get there.
3. This document is the record; the work is filed as **E15 — Structural
   foundations** in `docs/plans/04-phase-2-switchboard.md`, which runs NEXT,
   ahead of the rest of E9.

Findings carry IDs (`AR-P0-1` …) so plan items and issues can cite them.

---

## What is right (do not "fix" these)

- **The card/live split.** `cardId` durable, `liveId` ephemeral, `cardOfLive`
  mapping in [ipc.ts](../src/main/sessions/ipc.ts). Correct core abstraction,
  already paying rent across suspend/resume, pop-out close, restart, and rail
  rendering.
- **Fail-open is implemented, not aspirational.** Every listener loop
  try/catches. Hook holds release on timeout, on session close, and on listener
  throw. Store corruption backs the file aside and starts fresh. This is the
  strongest single property in the codebase.
- **The §5.29 security floor is built, not deferred.** Loopback bind + Host
  allowlist + per-session token + token-in-a-file-not-argv; `app.enableSandbox()`,
  contextIsolation, a narrowly scoped `setWindowOpenHandler`; git IPC scoped to
  known session folders with path-traversal guards. Above typical Electron
  hygiene, and specified before the first listener as promised.
- **The state machine encodes earned knowledge** — `SessionStart(source:'compact')`
  mid-turn, done-is-turn-terminal, interactive tools ≠ working. Bugs that cost
  real debugging, now permanent.
- **The tolerant reader is real** — malformed counted, never thrown; unknown
  hook events log-and-stay.
- **Lint-enforced token and i18n discipline from commit one.** The right call;
  retrofits are brutal.
- **The seam rule that matters is being followed** — only `bootstrap.ts` imports
  contributors, and `fakeAdapter` proves it by swapping the entire provider with
  a two-line change.

---

## P0 — blocks a stated goal

### AR-P0-1 · The provider adapter contract cannot express a second provider

Contradicts Goal #8 (multi-provider). §5.3 specifies
`capabilities: { transcripts, hooks, resume, mcp }`. The shipped contract
([contributions.ts](../src/main/extensibility/contributions.ts)) is
`buildSpawn()` + optional `slashCommands()`. Everything else is assumed by the
call site:

- [ipc.ts](../src/main/sessions/ipc.ts) hardcodes `providerId: 'claude-code'`
- `settingsFor: (id) => hooks.buildHookSettings(id)` runs unconditionally —
  Claude-shaped `--settings` hook injection for any provider
- `transcripts.watch(...)` runs unconditionally against `~/.claude/projects`
- `conversationExists()` / `--resume` semantics live in the IPC handler, not
  the adapter

By §5.23's own test — *"if our own adapter can't be expressed in the contract,
the contract is wrong"* — the contract is wrong today. You would discover this
by writing adapter #2 and finding you must edit `ipc.ts`, which is exactly the
failure the seam exists to prevent.

**Fix:** move the four capability objects onto the adapter; session creation
*asks* rather than assumes. Claude implements all four; a generic adapter
implements none and degrades to PTY-only, which is what §5.3 promises.
→ **P2-E15-01**

### AR-P0-2 · There is no renderer-side extensibility seam at all

The registry exists only in the main process: 2 contribution points, 1 real
contributor. But the §5.23 first-party roster — usage pane, notification
channels, manager panes, feed block renderers, theme presets, status-bar items,
dispatch templates — is **eight of nine renderer contributions**, and none has
a contract or a place to land.

The preload bridge is a hand-maintained flat object of ~60 concrete methods:
a hardcoded API, not a capability-brokered one. There is no mechanism to scope
what a given extension may reach, which is the entire premise of the capability
manifest.

**Consequence: the Phase-4 gate can never trip.** "2–3 dissimilar internal
consumers before we freeze" is unreachable when dissimilar consumers have
nothing to consume. Count is 1 and structurally cannot grow.

Note also that a second registry already exists without being called one:
[lib/commands.ts](../src/renderer/src/lib/commands.ts) +
[lib/command-set.ts](../src/renderer/src/lib/command-set.ts) is
`{id, title, category, enabled(ctx), run(ctx)}` — precisely VS Code's
`contributes.commands` shape. It simply does not go through
`ContributionRegistry`. Two registries with one job means two extension models
unless unified now.

**Fix:** make `ContributionRegistry` process-agnostic, instantiate one per
process, and add renderer points **dogfooded by features already being built**:

| Point | Dogfooded by | Why this one |
|---|---|---|
| `command` | the E9-01 registry that already exists | zero new work — register through it |
| `feed-block-renderer` | FeedView's hardcoded block switch (1,070 lines) | DESIGN calls it "the likeliest community-creativity surface" |
| `panel` (view-tab) | Session / Changes / History / Inspector / Terminal | all five are already this shape |
| `status-bar-item` | service-status monitor (§5.14, the designated "hello world") | smallest surface |
| `notification-channel` | E14's ntfy / TTS / webhook | proves the action surface |
| `theme` | AR-P0-3 | proves data-only contributions |

That reaches 5–6 dissimilar consumers as a **byproduct** of Phase 2/3 work
rather than as a Phase 4 project — the difference between the gate opening on
schedule and never opening.
→ **P2-E15-02, P2-E15-03, P2-E15-04**

### AR-P0-3 · Themes are not what the design says, and the preference does not persist

§5.20 promises: *"a theme = a JSON token map"*, dark/light/high-contrast +
presets, user themes import/export as JSON, the escape hatch satisfying the
litmus "from day one."

Shipped: two hardcoded `[data-theme]` blocks in
[tokens.css](../src/renderer/src/theme/tokens.css), and
`type ThemeName = 'nordic' | 'daylight'` — the type system actively forbids a
third theme. No token map, no loader, no import path, no high-contrast theme.
The lint rule enforcing `var(--)` is excellent and is the load-bearing half;
the runtime half does not exist.

Largest DESIGN↔reality gap on the "configurable everything" axis (P4).

**Live bug inside this finding:** theme and language preferences are stored in
`localStorage` ([theme.ts](../src/renderer/src/theme/theme.ts),
[i18n/index.ts](../src/renderer/src/i18n/index.ts)) — but the workspace store's
own comment says why that is unsafe:

> *"Lives here, not localStorage: the packaged renderer's loopback origin
> changes port per launch, so localStorage resets every run."*
> — [store.ts](../src/main/workspace/store.ts)

So in packaged builds, **theme and language reset on every launch**. It works
in dev because Vite's origin is stable. Both belong in the `ui` blob that
exists for exactly this reason. *(Verify against a packaged build; the two
comments cannot both be right.)*
→ **P2-E15-05, P2-E15-06**

---

## P1 — will bite during E9–E11

### AR-P1-4 · The renderer has no state layer, and the strain is visible

`App.tsx`: ~15 `useState` + 6 refs, closures drilled down.
`SessionGrid.tsx`: 1,310 lines holding **module-level mutable maps outside
React** — `liveToCard`, `allowAllByLive`, `cardActions`, `dockingBackByButton`.
Three symptoms:

- Module-level `Map`s no test can reset and no second window can share.
- `window.dispatchEvent(new CustomEvent('switchboard:groups-changed'))` as an
  intra-renderer bus — a DOM event bus is what you build when there is no store.
- Refs shadowing state (`eventsRef`, `railSessionsRef`, `visitedRef`) to defeat
  React batching. The reasoning in App.tsx is *correct* and the problem is real —
  but "derived ordering must be readable synchronously" is a store's job.

Works today; will not survive E9-05 (presentation ladder), E9-07 (layout modes),
E9-09 (pinning) — all cross-cutting per-session state — nor E11's bus or E13's
lineage.

**Fix:** one renderer-side observable store (plain class + `useSyncExternalStore`;
no library) owning cards, per-card status/usage/plan/permissions, and the ui
blob. **Before E9-05, not after.** It is also the read-only surface to expose to
Tier-1 sandboxed panels later.
→ **P2-E15-07**

### AR-P1-5 · Presentation state lives where E9 cannot reach it

`view`, `poppedOut`, `suspended`, `menuOpen` are `useState` inside
`SessionCardPanel`. E9-05's contract is *"reveal restores it to EXACTLY its
prior dock slot or monitor"*, and E9-07 needs layout modes to drive every card
at once from the palette/queue/policy engine. Panel-local state can do neither —
the state must outlive the panel's unmount.

Without this called out explicitly, E9-05 and E9-07 will each independently
discover it and solve it differently.
→ **P2-E15-08** (hard prerequisite for E9-05 / E9-07)

### AR-P1-6 · Session Bus (E11): make stdio the only v1 transport

§5.29 already says "prefer stdio where the CLI supports it." Confirmed current
(2026-07): Claude Code's stdio MCP transport has no network exposure and needs
no auth — process isolation is the security model, one server process per
client, no shared state.

HookListener *must* be HTTP (hook commands are separate processes). The Session
Bus has no such constraint. One stdio MCP server per session **deletes** the
DNS-rebinding / CSRF / origin-check class from Phase 2 instead of hardening
against it.

Second reason, and the decisive one: **an MCP tool call carries no ambient
session identity.** The bus must know which switchboard session is calling.
With stdio that is free — one process per session, identity in argv/env at
spawn. With HTTP you are back to minting and rotating tokens, i.e. adding a
transport in order to need the defense you added the transport to avoid.

**Decision:** stdio-only for Session Bus v1. HTTP/WebSocket is deferred to
§5.27 (mobile companion), where it is genuinely unavoidable.
→ DESIGN.md §5.4 + §5.29 amended 2026-07-26; E11 scope note added.

**Owner-confirmed 2026-07-26**, after being asked the deciding question in
plain terms: *is there anything you'd want reaching into your running sessions
that isn't itself a session?* — a browser dashboard, a hand-run script, another
app, the phone. Answer: nothing came to mind. The cost of stdio is exactly that
list being empty, so the trade was made knowingly rather than inherited from
the review. **Reversal trigger** (the only one): a wanted feature where a
non-session caller must reach the bus.

### AR-P1-7 · The permission hold's "nobody to ask" check tests the wrong thing

[hook-listener.ts](../src/main/hooks/hook-listener.ts):
`if (this.permListeners.size === 0) return 'pass'` — right intent, wrong signal.
Permission listeners register once at IPC setup and are never removed. So the
real "nobody to ask" case — renderer crashed, window closed, headless sessions
still running — is **not** detected: the listener still exists, the request
holds the full 300s, and the CLI stalls five minutes per gated call.

The replay path (`pendingPermissions`) covers a *reloading* renderer — the
common case, well handled. The uncovered case is a dead or closed window.

**Fix:** gate on window liveness, not listener count. Consider splitting the
deadline: a short "did any renderer acknowledge within ~5s" release, separate
from the 300s human-decision budget.
→ **P2-E15-09**

### AR-P1-8 · Transcript binding is a heuristic stack under the primary UI surface

Discovery: slug prefilter → widen → 256KB head parse → cwd match → native-id
match → 30s ambiguity fallback. Every rule was earned by a real bug and the
comments are a valuable archaeology record — keep all of it. But the Session
view is now *the primary working surface* and renders only if binding succeeds,
which depends on two undocumented contracts in series (storage layout + hooks
liveness).

Two gaps:

- **The §5.26 round-trip drift detector is specified and not implemented.** It
  is the cheapest early warning that a CLI release broke us: re-serialize a
  parsed line, diff the key set, warn once per new key. It slots in beside the
  `malformed` counter already kept.
- **Binding state is invisible.** An unbound session shows an empty Session
  view. "Waiting for transcript…" vs "couldn't bind this session's transcript"
  is P9 (trust through transparency) applied to our own plumbing.

**I/O note:** `poll()` runs every 100ms, and any session unbound past 10s
triggers a full recursive `scan()` of `~/.claude/projects` — on the same thread
that pumps every PTY, serves every IPC, and answers hooks.
→ **P2-E15-10, P2-E15-11**

---

## P2 — record and schedule

### AR-P2-9 · `WorkspaceState.version` is never read

`version: 1` exists; `load()` ignores it and sanitizes field-by-field. That is
the more robust pattern and should stay — but §5.26 promises a versioned schema
with export/import. Write the migration hook while there is exactly one version
and it is free. → **P2-E15-13**

### AR-P2-10 · CSP is meta-tag-based and works in dev by accident

[index.html](../src/renderer/index.html) says so itself, and says "revisit
(header-based CSP from main) when IPC handlers land in E2." E2 landed long ago.
Header-based CSP via `onHeadersReceived` on our own static server is ~10 lines
and removes the accident. Must precede any sandboxed-webview plugin panel —
that is when CSP becomes load-bearing. → **P2-E15-12**

### AR-P2-11 · The perf premise is validated but stale

[S-07](../spike/findings/s-07-concurrency-perf.md) is genuinely good work — 12
sessions, ~2.3% of one core each, and the correct conclusion (hidden panes
ingest-only) which was then implemented. But it measured a **spike harness**:
PTY + tailer + one xterm. Since then the app added dockview, Monaco (9MB
bundle), live FeedView block streaming, per-card git polling, and the
slash-command scanner.

Re-run against the real app **before E9 declares the queue the primary workflow
at 7–8 sessions** — that is where S6/S7 become load-bearing claims.
→ **P2-E15-14**

### AR-P2-12 · Cost estimation lives in the renderer

`estimateCostUsd` in [lib/usage.ts](../src/renderer/src/lib/usage.ts) bakes
pricing into the UI layer; it belongs in the ClaudeMon shared engine.
**OQ #8 is overdue by our own plan** — `03-later-phases.md` says the ClaudeMon
read gates Phase 3 planning, "ideally far earlier", and the 2026-07-21
reconciliation moved *more* into Phase 3. Three Phase-3 surfaces depend on it.
Highest-value non-code item on the list. → tracked in `03-later-phases.md`

### AR-P2-13 · `event-source` is a point with no registrant

`extensibility.md` already calls it the cautionary example. When the renderer
points land, decide whether to delete it rather than keep a guess in the tree.
→ folded into **P2-E15-02**

### AR-P2-14 · The main process is a monolith on one thread

`index.ts` (600 lines) does windows, popout geometry, static server, five
subsystems' IPC, git, notifications, preflight. Fine today. When work must move
off the main thread (git shell-outs and transcript parsing are the candidates),
the mechanism is `utilityProcess` — the same one VS Code built for its
extension host, and the same one §5.23 names for our plugin host.

That is the strongest argument for pulling `utilityProcess` forward: it builds
the Phase-4 substrate while solving a Phase-2 throughput problem. Not scheduled
now; recorded in `03-later-phases.md` → Phase 3 so the two are planned together.

---

## Answering the governing question

> *"When we have add-ins, can we do things like that, and is it very
> customizable?"*

**Today: no, and the gap is wider than `extensibility.md` admits.** That doc is
admirably honest ("one genuine contributor", "the seam is decorative if
consumers import directly") — but it is honest about a seam that only covers
spawning a CLI. Everything a user would actually extend — panels, feed
renderers, themes, notification channels, commands — has no contract, and the
preload bridge has no capability scoping.

**The foundation is correct; it was laid under one wall.** The bootstrap rule
holds, the substitution pattern is proven, the manifest shape is right.

**The path is cheap taken now** — AR-P0-1 through AR-P1-5 are not a rewrite,
and all of them get materially harder after E9 lands eleven more work items on
the current shape. Hence E15 running next.

---

## Sources consulted

- [Migrating VS Code to Process Sandboxing](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)
  — extension host as `utilityProcess`, message ports, sandboxed renderers
- [Electron `utilityProcess`](https://www.electronjs.org/docs/latest/api/utility-process)
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) — stdio transport
  security model (process isolation, no network exposure, one process per client)
