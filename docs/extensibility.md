# Extensibility — internal contributor guide

> **Status: experimental seams, no plugin host.** This describes an *internal*
> contract used by first-party code that happens to be extension-shaped. There
> is no way for a third party to write, package, or install an extension today,
> and this document is not a public plugin API. Expect breaking changes without
> notice — that is the explicit policy in DESIGN.md §5.23 until an API has 2–3
> dissimilar internal consumers.
>
> Companion reading: `docs/DESIGN.md` §5.23 (the architecture decision, the
> core/extension split, the nine-item first-party roster) and
> `docs/plans/02-phase-1-mvp.md` → **P1-E1-06**, the work item that built this.

---

## Why this exists at all

The decision (2026-07-18) was: **build the seams from day one, expose a public
plugin API only after the core is stable.** So pluggable surfaces go through a
contribution point + capability manifest even while everything is in-process
and statically imported. The seam is the product decision; out-of-process
loading can arrive later without rewiring consumers.

The rule that makes the seam real: **consumers resolve contracts by
contribution point + id, never by importing a contributor module directly.**
If a consumer can `import { claudeAdapter }`, the seam is decorative.

## What exists today

| File | Role |
|---|---|
| [shared/extensibility/registry.ts](../src/shared/extensibility/registry.ts) | `ContributionRegistry` (`register` / `resolve` / `list` / `manifests`), generic over a per-process contracts map. Imports nothing from `main/` or `renderer/` |
| [main/extensibility/contributions.ts](../src/main/extensibility/contributions.ts) | Main's contracts — `ProviderAdapter` and the `MainContributions` map |
| [main/extensibility/index.ts](../src/main/extensibility/index.ts) | Main's `registry` instance (the app-wide singleton) |
| [main/bootstrap.ts](../src/main/bootstrap.ts) | The **only** main module allowed to import contributors directly; populates main's registry |
| [renderer/src/extensibility/contributions.ts](../src/renderer/src/extensibility/contributions.ts) | The renderer's contracts — `CommandSetContribution` and the `RendererContributions` map |
| [renderer/src/bootstrap.ts](../src/renderer/src/bootstrap.ts) | The **only** renderer module allowed to import contributors directly; takes the registry as an argument so tests build fresh ones. Also logs the renderer manifests at startup |
| [renderer/src/extensibility/panels.tsx](../src/renderer/src/extensibility/panels.tsx) | The four session view tabs |
| [renderer/src/extensibility/feed-blocks.tsx](../src/renderer/src/extensibility/feed-blocks.tsx) | The seven transcript block renderers |
| [renderer/src/extensibility/feed-render.ts](../src/renderer/src/extensibility/feed-render.ts) | First-match-in-order resolution for a block, fail-open |
| [renderer/src/extensibility/registry-instance.ts](../src/renderer/src/extensibility/registry-instance.ts) | The renderer's registry instance, and nothing else — consumers import this, not `bootstrap.ts`, which would close an import cycle |
| [renderer/src/extensibility/boundary.tsx](../src/renderer/src/extensibility/boundary.tsx) | `ContributionBoundary` + `safely()`: one contribution failing costs that contribution |
| [renderer/src/extensibility/status-bar-items.tsx](../src/renderer/src/extensibility/status-bar-items.tsx) | The four status bar items |
| [renderer/src/extensibility/points.test.ts](../src/renderer/src/extensibility/points.test.ts) | The E15-03 done-when, executable: a new panel / block renderer / status item takes effect with no edit to any consumer |
| [shared/…/registry.test.ts](../src/shared/extensibility/registry.test.ts) | Mechanics, against toy contracts — plus the guard that the class stays free of `main/` and `renderer/` imports |
| [main/…/contributions.test.ts](../src/main/extensibility/contributions.test.ts) | The P1-E1-06 done-when: the Claude adapter is resolvable via the registry |
| [renderer/src/bootstrap.test.ts](../src/renderer/src/bootstrap.test.ts) | The renderer half: the seed command set arrives through the registry, not an import |

### Contribution points and their registrants

The registry CLASS lives in
[`src/shared/extensibility/registry.ts`](../src/shared/extensibility/registry.ts)
and imports nothing from `main/` or `renderer/` — a unit test enforces that,
because it is the property both processes depend on. Each process owns its own
instance and its own contracts map, so a point is typed for the process that can
actually serve it.

**Main** — [`MainContributions`](../src/main/extensibility/contributions.ts):

| Point | Contract | Registered today |
|---|---|---|
| `provider-adapter` | `ProviderAdapter` | [`claudeAdapter`](../src/main/providers/claude.ts) — real; [`fakeAdapter`](../src/main/providers/fake.ts) — test double, mutually exclusive (see below) |

**Renderer** — [`RendererContributions`](../src/renderer/src/extensibility/contributions.ts):

| Point | Contract | Registered today |
|---|---|---|
| `command-set` | `CommandSetContribution` | `core-commands` — the E9-01 seed set, resolved by the palette and the keyboard dispatcher |
| `panel` | `PanelContribution` | `panel-session`, `panel-changes`, `panel-history` (placeholder), `panel-terminal` — the session card's view-tab strip |
| `feed-block-renderer` | `FeedBlockRendererContribution` | `feed-block-{todos,bash,edit,tool,thinking,user,markdown}` — one per transcript block shape |
| `status-bar-item` | `StatusBarItemContribution` | `status-{session-count,usage,cli-version,theme}` |

The three renderer points added by P2-E15-03 are deliberately **dissimilar**:
`panel` renders a whole view and has a mount lifecycle (`keepMounted`, because
unmounting the terminal throws away its xterm view), `feed-block-renderer`
*competes* to claim an input and is order-sensitive, and `status-bar-item` just
puts a thing on a bar. A contract that has only ever seen one shape of consumer
has not been tested, and the Phase-4 gate asks for dissimilar consumers for
exactly that reason.

Two rules those points established, worth knowing before you add a fourth:

- **A contribution never takes the window down.** Predicates (`enabled`,
  `badge`, `matches`) are called through `safely()` and a throw counts as the
  conservative answer; rendered output is wrapped in `ContributionBoundary`,
  which logs and renders nothing. The renderer has no other error boundary, so
  without this one bad contribution white-screens every session's terminal —
  the exact "our breakage blocks a session" outcome the constitution forbids.
- **A panel is greyed, never hidden.** `PanelContribution` has `enabled` and
  deliberately no "hide me": §5.8 says the user can always see what exists. A
  tab that vanishes teaches them the app is unpredictable; a greyed one tells
  them why. It also means a persisted view id always still names a visible tab.

`event-source` used to sit in the main table with **nothing** registered against
it. It was deleted in P2-E15-02: no registrant, no consumer, no reference to
`EventSource` anywhere in the tree. It is quoted below as the cautionary example
it became, and re-adding it beside a real registrant (the §5.14 status monitor)
is a smaller job than keeping a contract nothing has had to satisfy.

The §5.23 roster lists nine first-party extensions. Two points now carry real
registrants across two processes; items 3–9 (usage pane, notification channels,
manager panes, feed block renderers, themes, …) are still plain in-process code
that does **not** go through the registry — P2-E15-03 lands the next three.

### Registry consumers

Three production call sites resolve through the registry, and all of them
matter if you change the contracts:

- [session-manager.ts:102](../src/main/sessions/session-manager.ts#L102) —
  resolves the adapter for a session's `providerId` to build its spawn recipe.
- [index.ts:502](../src/main/index.ts#L502) — pulls the provider's builtin
  `slashCommands()` for composer autocomplete (P2-E10-07).

Plus [index.ts:409-410](../src/main/index.ts#L409-L410), which registers the
builtins at startup and logs every manifest — the closest thing we have to an
"installed extensions" view.

## The contract

```ts
interface CapabilityManifest {
  id: string;           // kebab-case, unique per point, e.g. "claude-code"
  displayName: string;
  version: string;      // the contributor's own version, not the app's
  capabilities: string[];
}
```

Every contribution, at every point, carries one. `id` is the resolution key;
`capabilities` is the declared least-privilege set.

**Capabilities are declarative only — nothing enforces them yet.** The vocabulary
in use today is `sessions.spawn`, `sessions.resume`, `settings.inject`, and
`slash-commands.list`. `registry.list(point, capability)` filters on them, and
`manifests()` reports them, but no code path checks a capability before letting
a contributor act. When the real plugin host lands, the main process becomes the
sole enforcer (§5.23) — declaring accurately now is what makes that transition
mechanical instead of archaeological.

## Adding a contribution to an existing point

Worked example — a second provider adapter:

1. **Write the contributor** in its own module (`src/main/providers/<name>.ts`),
   exporting a `const` that satisfies the point's interface. Give it a real
   manifest: unique `id`, honest `capabilities`.
2. **Implement only what you support.** Optional methods exist so a provider
   can degrade instead of lying — `slashCommands?()` is the model: a CLI without
   the concept omits it and the composer falls back to scanned project/user
   commands.
3. **Register it in `bootstrap.ts`.** Nowhere else. If you find yourself
   importing the module from a consumer, stop — that's the one rule.
4. **Test it through a fresh `ContributionRegistry`**, not the singleton, so
   tests don't leak state into each other. `registry.test.ts` shows the shape.

Duplicate ids at the same point throw at registration time. That's deliberate —
it surfaces collisions at startup rather than as a silent last-wins.

### The substitution pattern (how e2e swaps the CLI)

`fakeAdapter` registers under the *same* `claude-code` id as the real adapter,
guarded by `SWITCHBOARD_FAKE_PROVIDER=1`, and `bootstrap.ts` returns early so
only one is ever present. It spawns the OS shell in a real PTY instead of the
`claude` CLI — a genuine interactive terminal with no CLI login and no network,
so UI tests are hermetic and CI-safe.

This is the seam paying rent: the entire app runs against a different provider
implementation with a two-line change in one file and no consumer edits.

## Adding a new contribution point

1. Decide which PROCESS serves the point, and define the contract interface in
   that process's contributions module — `src/main/extensibility/contributions.ts`
   or `src/renderer/src/extensibility/contributions.ts`.
2. Add the `point → contract` entry to that process's map (`MainContributions`
   or `RendererContributions`). The registry's generics key off the map, so
   `resolve('your-point', id)` is typed correctly with no cast at the call site.
3. Register at least one real contributor, in that process's `bootstrap.ts` —
   the only module allowed to import contributors directly.
4. **A point with no registrant is a guess.** `event-source` was exactly that
   and was deleted rather than kept as decoration.

## IPC capabilities — the enforcement point

§5.23 says the main process is the sole enforcer. Until P2-E15-04 that was true
only because there was nothing to enforce: the preload exposed ~60
hand-maintained methods, and anything that could reach the bridge could call
all of them.

Now every channel declares exactly one capability in
[`src/shared/ipc/capabilities.ts`](../src/shared/ipc/capabilities.ts), and every
registration goes through [`IpcBroker`](../src/main/ipc/broker.ts), which
refuses a call whose caller does not hold it.

**First-party holds everything, so nothing changes at runtime today — that is
the point.** The check exists, so Phase 4 wires a plugin manifest into it
instead of inventing it at the moment it first matters. Narrowing our own
renderer is a separate argument with real behavioural consequences.

### The vocabulary

| Capability | Covers |
|---|---|
| `sessions.read` | list cards, statuses, pending permissions |
| `sessions.spawn` | create / resume / close — **starts processes** |
| `sessions.write` | rename, task label, autonomy, permission decisions |
| `pty.read` | attach to a terminal's output stream |
| `pty.write` | send keystrokes to a running CLI |
| `transcripts.read` | conversation blocks |
| `git.read` | status and file versions |
| `events.read` / `.write` | the attention feed; write is ack/dismiss |
| `settings.read` / `.write` | preferences, notification prefs, preflight |
| `workspace.read` / `.write` | layout and ui blob |
| `groups.read` / `.write` | session groups |
| `app.window` | display geometry, popout movement |
| `environment.probe` | runs the CLI to read its version; stats the user's home config |
| `fs.probe` | existence/type of an arbitrary caller-supplied path |
| `dialog.open` | a **native** file dialog |

The last three are named for **what they do, not where the answer is shown**.
`preflight:check` sat under `settings.read` until review pointed out that it
`execFile`s the CLI and stats `~/.claude.json` — a child process behind a
capability called "read settings". `sessions:isDirectory` stats an arbitrary
caller-supplied path with no folder scoping. And `dialog.open` is its own
capability because holding "sessions" must not imply the power to put an OS
dialog in front of the user.

### Two vocabularies, not yet joined

There are currently **two** sets of capability strings:

1. **These** — IPC channel capabilities, a typed union in
   `src/shared/ipc/capabilities.ts`, enforced by the broker.
2. **`CapabilityManifest.capabilities`** — free-form `string[]` that
   contributions declare (`commands.contribute`, `panel.render`,
   `sessions.spawn`, …), enforced by nothing.

They overlap by accident of naming (`sessions.spawn` appears in both) rather
than by design. **Joining them is the Phase-4 job** — a plugin's manifest set
becomes the grant the broker checks — and it is precisely what this seam exists
to make mechanical. Until then, do not assume a string in one means anything in
the other.

Note also that the capability system covers **channels**. The preload can still
hand the renderer non-channel powers — `pathForFile` (`webUtils.getPathForFile`)
is one — and those sit outside the vocabulary entirely.

### Rules worth knowing before you add a channel

- **You cannot register an untagged channel.** `broker.handle` takes a channel
  typed as the map's key set, so an untagged one does not compile. The unit
  test covers the other direction — a tag left behind after its channel was
  deleted, which reads like coverage and is not.
- **Outbound is gated too.** `broker.send` checks what the *target* window
  holds. A no-op for first-party; without it a Phase-4 plugin would receive
  every session event regardless of what it declared.
- **Dynamic channel families exist.** `pty:data:<sessionId>` is one channel per
  attached pane, so it is matched by prefix. A completeness check that only
  knew about fixed names would have reported full coverage while missing the
  highest-volume channel in the app. Its payload is not a bare string: every
  chunk carries the **epoch** of the attach that produced it (`shared/ipc/pty.ts`),
  which is how a consumer tells output it has not seen from output already in
  its snapshot (#117).
- **The broker fails CLOSED**, uniquely in this codebase. Everywhere else our
  breakage must not block a session; here an unknown channel or an ungranted
  caller is refused, because both mean a wiring bug rather than a degraded
  dependency.

## Standalone entry points

Main's `registry` is a singleton for the app, but `ContributionRegistry` is a plain
class and standalone tooling constructs its own — see
[hook-check.ts:33](../src/main/hooks/hook-check.ts#L33), a CLI check that builds
a private registry, registers the Claude adapter, and drives a `SessionManager`
outside Electron. Keep `SessionManager` (and anything like it) taking a registry
as a constructor argument rather than reaching for the singleton, or that stops
working.

## Known gaps — the 2026-07-26 architecture review

This section is the honest scoreboard. Full findings:
`docs/architecture-review-2026-07-26.md`; the fix is **E15** in
`docs/plans/04-phase-2-switchboard.md`, which runs next.

**Consumer count on the seams: 5** — `provider-adapter` in main, and
`command-set`, `panel`, `feed-block-renderer` and `status-bar-item` in the
renderer. It was **1** when the review was written, and the finding was never
the count itself but that it *could not grow*: the seam was main-only, so a
renderer contribution had nowhere to land. P2-E15-02 removed the ceiling and
**P2-E15-03 (done)** dogfooded three dissimilar points onto surfaces that were
already hardcoded. The Phase-4 gate ("2–3 dissimilar internal consumers") is
met for the first time — which is a starting condition for that conversation,
not a decision to ship a plugin API.

- **The seam covers the main process only, and the roster is mostly renderer.**
  Of §5.23's nine first-party extensions, eight (usage pane, notification
  channels, manager panes, feed block renderers, theme presets, status-bar
  items, dispatch templates) are renderer contributions. **Was:** no renderer
  registry at all, so seven of them were plain in-process code with nowhere to
  land. **RESOLVED.** E15-02 made `ContributionRegistry` process-agnostic and
  gave the renderer its own instance, bootstrap and contracts map; **E15-03**
  added `panel`, `feed-block-renderer` and `status-bar-item`, each replacing a
  hardcoded switch that already existed in `SessionGrid.tsx`, `FeedView.tsx` or
  `chrome.tsx`. What remains unregistered is the usage pane, notification
  channels and dispatch templates — code that does not exist yet rather than
  code with nowhere to go.
- **A second registry already exists without being called one.**
  `renderer/lib/commands.ts` + `command-set.ts` is
  `{id, title, category, enabled(ctx), run(ctx)}` — exactly a contribution
  point. **E15-02 (done)** registers it through the real registry, so there is
  one extension model rather than two: `App.tsx` resolves `command-set`
  contributions instead of importing `buildCommands`.
- **The provider contract can't describe a non-Claude CLI.** §5.3 specifies
  `capabilities: { transcripts, hooks, resume, mcp }`; the shipped interface is
  `buildSpawn()` + optional `slashCommands()`, and `sessions/ipc.ts` assumes
  Claude for everything else (hardcoded `providerId`, unconditional hook
  settings, unconditional `~/.claude/projects` watch, resume semantics owned by
  the IPC handler). By this document's own rule — *if our own adapter can't be
  expressed in the contract, the contract is wrong* — the contract is wrong.
  E15-01 fixes it. **This is the one that blocks the multi-provider goal**: you
  would discover it by writing adapter #2 and having to edit a consumer.
- **Capabilities have no enforcement point at all.** The section above says
  "declarative only — nothing enforces them yet", which is accurate but
  understates it: the preload bridge is ~60 hand-maintained methods with no
  capability scoping, so there is no place a check *could* go. E15-04 tags every
  IPC channel with one declared capability and adds a single main-side choke
  point — a runtime no-op for first-party, which is the point: Phase 4 wires a
  plugin manifest into an existing check instead of inventing a permission
  model.
- **Themes are not a contribution shape yet.** §5.20 says a theme is a JSON
  token map; the implementation is two hardcoded `[data-theme]` blocks and a
  two-value `ThemeName` union that forbids a third theme. E15-05 makes themes
  data, which is the prerequisite for a `theme` contribution point.

Owner decision 2026-07-26: **third-party plugin support is a real goal**
(first-party add-ons first). That is why E15-04 ships full-size rather than
being trimmed to internal tidiness.

## What is deliberately NOT built

No on-disk manifest format · no loader or install path · no `utilityProcess`
plugin host or typed RPC · no activation events (`onSessionStart`,
`onProviderNeeded:<id>`, `onEvent:<type>`) · no capability enforcement · no
sandboxed webview panels · no distribution story.

All of it is Phase 4, and it is **gated**: the plugin API alpha starts only
after 2–3 dissimilar internal consumers exist on the seams
(`docs/plans/03-later-phases.md`). Current count: one provider adapter. Check
the registry's actual consumer list before anyone schedules that work.

Two constraints from §5.23 worth knowing before designing against this:

- **PTY power is brokered, never sandboxed.** No JS sandbox can safely grant
  process/PTY access. Deep contributors will call permission-gated host APIs,
  and dangerous calls surface through the existing approval cards (§5.16) —
  approvals double as the plugin permission UI.
- **Two trust tiers, honestly labeled.** Tier 1 sandboxed (UI panels, themes,
  event subscriptions); Tier 2 trusted (provider adapters, deep integration) —
  security via review and capability disclosure, never a fake sandbox claim.

## Invariants to preserve

- Consumers resolve; only `bootstrap.ts` imports contributors.
- Every contribution carries a manifest with accurate capabilities.
- Kernel concerns are **never** contributions: session manager + PTY hosting,
  layout/docking, the event stream, the approval enforcer (it judges
  contributors and cannot be one), attention queue, git service, theming /
  i18n / logging runtimes.
- Never delay a feature purely to make it a purer extension. Phase 1 defined
  the shapes, Phases 2–3 consume them in-process, Phase 4 moves them out.
