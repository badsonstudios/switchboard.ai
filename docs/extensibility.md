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
| [renderer/src/extensibility/themes.ts](../src/renderer/src/extensibility/themes.ts) | The four theme contributions (wrapping `builtinThemes`) and their order-sorted resolution |
| [renderer/src/extensibility/commands.ts](../src/renderer/src/extensibility/commands.ts) | Flattens the registered `command-set` contributions, first-match wins |
| [renderer/src/extensibility/registry-instance.ts](../src/renderer/src/extensibility/registry-instance.ts) | The renderer's registry instance, and nothing else — consumers import this, not `bootstrap.ts`, which would close an import cycle |
| [renderer/src/extensibility/boundary.tsx](../src/renderer/src/extensibility/boundary.tsx) | `ContributionBoundary` + `safely()`: one contribution failing costs that contribution |
| [renderer/src/extensibility/status-bar-items.tsx](../src/renderer/src/extensibility/status-bar-items.tsx) | The five status bar items |
| [renderer/src/extensibility/find-providers.ts](../src/renderer/src/extensibility/find-providers.ts) | The four find providers (§5.31), their by-panel resolution, why Ctrl+F is deliberately NOT claimed from a focused terminal, and how the fourth one got registered — the dispatch half a contribution point cannot reach |
| [renderer/src/lib/find-surfaces.ts](../src/renderer/src/lib/find-surfaces.ts) | The live-surface registry a mounted panel publishes into, keyed by (card, panel) |
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
| `provider-adapter` | `ProviderAdapter` | [`claudeAdapter`](../src/main/providers/claude.ts) — real; [`fakeAdapter`](../src/main/providers/fake.ts) and [`fakeStreamAdapter`](../src/main/providers/fake-stream.ts) — test doubles, one per transport. All three claim the id `claude-code` and exactly one is ever registered (see below) |

**Renderer** — [`RendererContributions`](../src/renderer/src/extensibility/contributions.ts):

| Point | Contract | Registered today |
|---|---|---|
| `command-set` | `CommandSetContribution` | `core-commands` — the E9-01 seed set, resolved by the palette and the keyboard dispatcher |
| `panel` | `PanelContribution` | `panel-session`, `panel-changes`, `panel-history` (placeholder), `panel-terminal` — the session card's view-tab strip |
| `feed-block-renderer` | `FeedBlockRendererContribution` | `feed-block-{todos,bash,edit,tool,thinking,user,markdown}` — one per transcript block shape |
| `status-bar-item` | `StatusBarItemContribution` | `status-{session-count,usage,service-health,cli-version,theme}` |
| `theme` | `ThemeContribution` | `theme-{nordic,daylight,high-contrast,soft-contrast}` — the picker and the status bar list from here |
| `find-provider` | `FindProviderContribution` | `find-session`, `find-changes`, `find-terminal`, `find-document` — **all four of the §5.31 names** (#533) |

`theme` (P2-E15-05) is the first **data-only** point: every other contribution
hands over a function — build these commands, render this block — and this one
hands over a value (`ThemeDefinition`: a base preset plus a map of token
overrides). That is the shape a manifest can carry without executing anything,
which is what §5.23's tier-1 (sandboxed) trust level exists for. `high-contrast`
is authored as `theme/themes/high-contrast.json` and reaches the app without a
code change, which is the proof the point is real rather than ceremony —
and `soft-contrast`, asked for after that code was written, cost exactly one
JSON file, one list entry and one string, with no test edited to accommodate it.

`find-provider` (P2-E17-02, §5.31) is the sixth RENDERER point — the seventh
overall, counting main's `provider-adapter` — and the first whose
contributions **do not all do the same job**. `find-session` searches with our
bar (`mode: 'bar'`); `find-changes` hands the entire interaction to Monaco's own
find widget (`mode: 'delegated'`) because §5.31 names that widget as a thing not
to reimplement. A point whose registrants only ever varied by *which* thing they
searched would have proved much less about the contract.

**All four registrants §5.31 names now ship** (#533), and the two milestones
it took are the interesting part. P2-E17-03 added `find-terminal` — xterm's
scrollback behind `@xterm/addon-search`, `mode: 'bar'` — and with it the
grouped count the point was shaped for: one Ctrl+F now asks *every* `bar`
registrant on the focused card and the bar reports them as separate groups
("12 in Session · 3 in Terminal (scrollback only)"), because two providers can
see two different depths of the same session and one number over both would be
true of neither. That is also what made `labelKey` **required**: a group with no
name is a number the user cannot attribute.

`find-terminal` then taught the point one more thing (#517): **a surface is not
the same as the buffer behind it.** Its first version drove the renderer's
xterm, and a hidden pane is ingest-only (S-07) — so on a Terminal tab you had
never opened, the only searchable copy in the window was empty and the group had
to be withheld with a reason. The fix was not in the seam: the surface now reads
MAIN's ring buffer over `pty:snapshot` and replays it into an off-screen
terminal, and the only contract change is that `TerminalFindSurface.search` is
now genuinely asynchronous and reports `live` — whether the answer came from the
pane on screen (so a hit can be scrolled to) or from the buffer behind it (so it
can only be read). A registrant answering from somewhere the user is not looking
is a normal thing for this point to have to express; the lesson is that it must
say so per RESULT, not per availability.

The **document viewer** (§5.30) is the fourth, and it arrived carrying two
lessons rather than one registrant:

- **A contribution point does not control whether the keystroke arrives.** The
  viewer had a working, correctly scoped find of its own for two milestones and
  it was *unreachable*: `find.open` was enabled on `activeCardId !== null`, and
  a `doc-` panel is not a card, so Ctrl+F over a document was a disabled
  command. Registering here would not have fixed that by itself. What did is a
  §5.8 answer — `GridController.activeDocumentId()` threaded through
  `CommandContext` — and the closing note in
  [`find-providers.ts`](../src/renderer/src/extensibility/find-providers.ts)
  records it for the next surface that is not a session card.
- **`mode` became per-surface.** The viewer has two bodies: rendered markdown,
  which our bar marks and steps, and a Monaco source body, which §5.31 says to
  hand over whole. One panel, one provider, so the optional `modeFor(ctx)` was
  added beside the static `mode` — the other three registrants do not define it.
  A registrant that is `bar` here and `delegated` there is the strongest
  evidence so far that this point's consumers are genuinely dissimilar, which is
  what the Phase-4 gate asks for.

The three renderer points added by P2-E15-03 are deliberately **dissimilar**:
`panel` renders a whole view and has a mount lifecycle (`keepMounted`, because
unmounting the terminal throws away its xterm view), `feed-block-renderer`
*competes* to claim an input and is order-sensitive, and `status-bar-item` just
puts a thing on a bar. A contract that has only ever seen one shape of consumer
has not been tested, and the Phase-4 gate asks for dissimilar consumers for
exactly that reason.

Four rules those points established, worth knowing before you add another:

- **A contribution never takes the window down.** Predicates (`enabled`,
  `badge`, `matches`) are called through `safely()` and a throw counts as the
  conservative answer; rendered output is wrapped in `ContributionBoundary`,
  which logs and renders nothing. The renderer has no other error boundary, so
  without this one bad contribution white-screens every session's terminal —
  the exact "our breakage blocks a session" outcome the constitution forbids.
- **A feed block that can expand ships a `FeedExpander`** (#174). The `ToolBox`
  container is a mouse convenience — its whole body toggles — and it is
  deliberately not a control: a box that CONTAINS other buttons may not be one.
  The keyboard and screen-reader path is the block's own header
  [`FeedExpander`](../src/renderer/src/extensibility/feed-blocks.tsx), a real
  `<button aria-expanded>` marked with `FEED_EXPANDER_ATTR`, which is what the
  Session view's arrow-key navigation walks. A renderer that wraps in `ToolBox`
  and skips the expander ships with no keyboard path at all — and nothing will
  fail to tell you, which is why it is written down here.
- **A feed block's body text gets its own element** (#520). Find MARKS the
  searched term by splitting text nodes inside the block it jumped to, and it
  only splits text React does not track: an element whose lone child is a
  string, or anything below a `dangerouslySetInnerHTML` container. So
  `<pre>{text}</pre>` is marked and `<span>{a}{b}</span>` is skipped —
  deliberately, and safely. The shape to avoid is the one that looks like the
  first and behaves like the second: `<span>{label}{flag && <b/>}</span>`
  renders one DOM child when `flag` is false while React still holds a
  reference to that text node, and marking it is a lost update or a
  `removeChild` on a detached node mid-conversation. The rule, and why those
  two shapes and no others, is in
  [`lib/feed-marks.ts`](../src/renderer/src/lib/feed-marks.ts).
- **A panel is greyed, never hidden.** `PanelContribution` has `enabled` and
  deliberately no "hide me": §5.8 says the user can always see what exists. A
  tab that vanishes teaches them the app is unpredictable; a greyed one tells
  them why. It also means a persisted view id always still names a visible tab.

`event-source` used to sit in the main table with **nothing** registered against
it. It was deleted in P2-E15-02: no registrant, no consumer, no reference to
`EventSource` anywhere in the tree. It is quoted below as the cautionary example
it became, and re-adding it beside a real registrant (the §5.14 status monitor)
is a smaller job than keeping a contract nothing has had to satisfy.

The §5.23 roster lists nine first-party extensions, and it is **not** the same
list as the table above. **Seven points carry real registrants across two
processes**, but three of them — `command-set`, `panel` and `status-bar-item` —
are seams retrofitted onto core surfaces that already existed (the palette, the
card's view-tab strip, the workspace status bar), not roster entries.

Measured against the roster itself, three of the nine are on the seam: provider
adapters (1), theme presets (7, via P2-E15-05) and feed block renderers (8, via
P2-E15-03). The remaining five — usage pane (2), notification channels (3),
dispatch role templates (4), the service status monitor (5) and the manager
panes (6) — do not go through the registry because **they are not built yet**;
item 9 is a backlog bucket rather than a surface. That is the good version of
this gap: when those features land they land as contributions, instead of
arriving as in-process code that someone has to migrate afterwards.

### Registry consumers

Production call sites resolve through the registry in **both** processes now,
and all of them matter if you change the contracts.

> **Pointer convention (#472): a link into `src/` names the FILE and the
> SYMBOL, never a line number.** All five of main's line anchors in this
> section had rotted by the time anyone read it again — `index.ts#L1178-L1179`,
> cited as `capabilitiesOf`, landed in the middle of `update:openExternal`, and
> `index.ts#L805`, cited as the default-provider lookup, in the popout's bounds
> validation. (The renderer's six had not moved far, which is the point: you
> cannot tell the two cases apart by reading.) A rotted anchor is worse than no
> anchor, because it reads as precision. A unit test asserts that every link
> target in this file still exists and that no link carries an `#L` anchor
> ([extensibility-doc.drift.test.ts](../src/shared/extensibility/extensibility-doc.drift.test.ts));
> no test can assert that a line number is still the right one.

Main:

- [`SessionManager.create`](../src/main/sessions/session-manager.ts) — resolves
  the adapter for a session's `providerId` to build its spawn recipe.
- [`capabilitiesOf` and `isRegisteredProvider`](../src/main/index.ts), in the
  `registerSessionIpc({…})` wiring — how the session core asks §5.3's
  capability objects instead of assuming Claude. Where those answers are
  actually spent is
  [`planSessionStart`](../src/main/sessions/start-plan.ts).
- [`slashCommands`](../src/main/index.ts), the same wiring — pulls the
  provider's builtin `slashCommands()` for composer autocomplete (P2-E10-07).
- [`defaultProviderId`](../src/main/index.ts) — `list('provider-adapter')[0]`
  is the default provider for a new card, so **registration order is
  precedence**.

Renderer — one per point, each the sole resolver for its own surface:
[`buildContributedCommands`](../src/renderer/src/extensibility/commands.ts),
[`renderFeedBlock`](../src/renderer/src/extensibility/feed-render.ts),
[`listPanels`](../src/renderer/src/extensibility/panels.tsx),
[`listStatusBarItems`](../src/renderer/src/extensibility/status-bar-items.tsx),
[`listThemes`](../src/renderer/src/extensibility/themes.ts) and
[`findProviderFor`](../src/renderer/src/extensibility/find-providers.ts)
(the sole resolver the find bar calls). Each takes
the registry as an **argument** rather than reaching for the singleton, so a
test can pass a fresh one; the components (`App.tsx`, `SessionGrid.tsx`,
`FeedView.tsx`, `chrome.tsx`, `FindBar.tsx`) import `rendererRegistry` and hand
it to these
helpers, which is what keeps each point's sort / first-match rule in one place
instead of at every call site.

Plus [`registerBuiltinContributions`](../src/main/bootstrap.ts) (called once
from `index.ts`, which logs `registry.manifests()` on the next line) and the
renderer's [`initRendererContributions` /
`logManifests`](../src/renderer/src/bootstrap.ts), which register the
builtins at startup and log every manifest — the closest thing we have to an
"installed extensions" view, one line per process.

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

**Manifest capabilities are declarative only — nothing enforces them yet.** (The
IPC channel capabilities are a *different* set, and the broker does enforce
those — see "Two vocabularies, not yet joined".) The vocabulary in use today,
by process:

| Process | Strings in use |
|---|---|
| Main | `sessions.spawn`, `sessions.resume`, `settings.inject`, `slash-commands.list` |
| Renderer | `commands.contribute`, `panel.render`, `feed.render`, `statusbar.item`, `theme.contribute`, `find.provide` |

The renderer's are one per point, five of the six set through
[`manifestFor`](../src/renderer/src/extensibility/contributions.ts) —
`commands.contribute` is a literal in `bootstrap.ts`, because `core-commands` is
the one contribution that has no module of its own. Main's four are declared
identically by all three provider adapters.

(Main's four were the *whole* list until P2-E15-02 gave the renderer a registry
on 2026-07-28; that this paragraph still said so a fortnight and six renderer
strings later is why the list is now pinned by a test —
[extensibility-doc.drift.test.ts](../src/shared/extensibility/extensibility-doc.drift.test.ts).)

`registry.list(point, capability)` filters on them, and
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

The fakes register under the *same* `claude-code` id as the real adapter,
selected by `SWITCHBOARD_FAKE_PROVIDER`, and `bootstrap.ts` returns early so
only one is ever present. There are two of them, one per transport, and they are
distinct **values of one variable** rather than two flags precisely so they
cannot both be on and race to register the same id: `=1` picks `fakeAdapter`,
which spawns the OS shell in a real PTY instead of the `claude` CLI, and
`=stream` picks `fakeStreamAdapter`, the stream-json fake (P2-E18-04). Either
way it is a genuine session with no CLI login and no network, so UI tests are
hermetic and CI-safe.

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

### How the broker refuses — the contract (#346)

**A refused `invoke` RESOLVES; it never rejects.** The value is an `IpcRefusal`
from [`src/shared/ipc/refusal.ts`](../src/shared/ipc/refusal.ts):

```ts
interface IpcRefusal {
  readonly __ipcRefused: true;                 // the key is IPC_REFUSAL_BRAND in code
  readonly channel: string;                    // what was refused
  readonly reason: 'capability-not-held'       // you have a grant, not this one
                 | 'not-granted'               // you have no grant at all
                 | 'unknown-channel';          // RESERVED: a wiring bug, and
}                                              // unreachable through handle()

isIpcRefusal(value)   // the only supported way to detect one
```

Three rules follow from it, and they are the whole contract:

1. **Success passes through untouched.** The broker does not envelope replies.
   A channel that answers `null`, `false`, `{ok:false,reason}` or a record
   answers exactly that, exactly as before — which is why this contract changed
   no shipped behaviour when it landed.
2. **A handler's own throw still rejects.** The broker refuses *on the caller's
   behalf* and knows nothing about what a handler failing halfway means, so it
   does not catch. Whether a *family* throws is that family's contract — see
   `sessions/ipc.ts` and `workspace/group-ipc.ts`, both of which answer instead
   (#326, #347). A caller that is not first-party should still expect a
   rejection from a handler.
3. **One-way channels drop a refusal silently.** `ipcMain.on` has no reply, so
   a refused `send` is logged and dropped; and outbound `broker.send` to a
   window that may not hear a channel is dropped deliberately, because telling
   it "refused" on every push would leak the traffic pattern the gate exists to
   withhold. If a caller needs to know whether a one-way call landed, that
   wants an `invoke` channel.

**What a Phase-4 plugin host must do:** check `isIpcRefusal` once, in the bridge
it generates for the plugin, and translate it into that API's error model. It is
one check in one place — which is precisely why the refusal is a *branded value*
and not a bare `null`. **Nothing type-level or lint-level forces that check**;
pass-through is what buys the zero-churn contract, and this is what it costs, so
put "the bridge checks `isIpcRefusal`" on the plugin-bridge work item rather than
trusting this paragraph.

- **Not bare `null`** (what `groups:*` and `sessions:*` answer). A handler knows
  what `null` means for its own channel; the broker is generic and does not.
  `groups:update`, `pty:attach` and `sessions:create` all answer `null` for
  ordinary reasons, so a null refusal would be indistinguishable from success on
  the very channels most likely to be refused. A generic bridge can detect a
  brand; it cannot detect a null.
- **Not `{ok:false, reason}`.** That shape is already taken —
  `sessions:setTransport` legitimately answers `{ok:false, reason:'unknown-card'}`
  from its own handler. Same collision, more ceremony.
- **Not an envelope on every reply.** The only shape a caller cannot ignore, and
  it costs a rewrite of every preload signature and every call site to guard a
  branch no shipped caller can reach.
- **Not a typed error.** A throw is the thing being removed, and an `Error` does
  not survive structured clone as itself anyway: the old `refused: <channel>`
  arrived in the renderer as a string with `Error invoking remote method` glued
  to the front, which is unparseable by design.

The `reason` is coarse and does **not** name the missing capability, keeping the
broker's original intent ("an untrusted caller does not need us enumerating the
permission it should ask for"). It is not a secret — the channel → capability
map is shared code, so a host that wants the name calls `capabilityFor(channel)`
itself. Adding a field later is not a breaking change; removing one is.

**Preload types are not widened by `| IpcRefusal`**, and that is deliberate: our
renderer holds `allCapabilities()`, so it cannot be refused and its declared
return types are exact. The day a bridge is handed to a caller with a partial
grant, that bridge's types carry the refusal — the check belongs where the
refusal can arrive, not everywhere it cannot.

### The vocabulary

| Capability | Covers |
|---|---|
| `sessions.read` | list cards, statuses, pending permissions |
| `sessions.spawn` | create / resume / close — **starts processes** |
| `sessions.write` | rename, task label, autonomy, permission decisions |
| `pty.read` | attach to a terminal's output stream, or read its scrollback (§5.31's Terminal group) |
| `pty.write` | send keystrokes to a running CLI |
| `transcripts.read` | conversation blocks, and **searching the transcript file** (§5.31) |
| `git.read` | status and file versions |
| `events.read` / `.write` | the attention feed; write is ack/dismiss |
| `settings.read` / `.write` | preferences, notification prefs, preflight |
| `workspace.read` / `.write` | layout and ui blob |
| `groups.read` / `.write` | session groups |
| `app.window` | display geometry, popout movement, and the right-click menu's labels (#526) — note the labels are one **app-wide** setting, applied to every window, last writer wins |
| `environment.probe` | runs the CLI to read its version; stats the user's home config |
| `fs.probe` | existence/type of an arbitrary caller-supplied path |
| `fs.read` | the **contents** of a file, scope-checked and size-capped in main |
| `dialog.open` | a **native** file dialog |
| `update.check` | contacts the release host **over the network** |
| `update.install` | downloads an executable and runs it |
| `provider.status` | reads the provider's **public status page** over the network — read-only and unauthenticated, it sends nothing (P2-E14-07) |
| `push.read` | which phone-push / webhook switches are on, and **which** credentials exist — booleans, never a value |
| `push.write` | those switches, and depositing a credential **into the OS credential store** (P2-E14-06, §5.29). Not folded into `settings.write` for the `fs.read` reason: storing a secret is strictly more power than flipping a preference |
| `push.send` | **sends session-derived text to a third-party host** the user configured — the setup dialog's "Send test". The sharpest of the network three: the other two READ from a public host, this one writes a session's task label out of the machine |
| `shell.openExternal` | hands a URL to the user's **browser** |
| `shell.openPath` | hands a **local path** to the OS — "Open externally", "Reveal in folder". Split from `shell.openExternal` because a URL goes to the browser and a path goes to whatever is registered for that extension, which for `.exe` is execution. The handlers behind it re-check `fs.read`'s scope, so it can only ever be aimed at a file the caller could already have read |

Those are named for **what they do, not where the answer is shown**.
`preflight:check` sat under `settings.read` until review pointed out that it
`execFile`s the CLI and stats `~/.claude.json` — a child process behind a
capability called "read settings". `sessions:isDirectory` stats an arbitrary
caller-supplied path with no folder scoping. And `dialog.open` is its own
capability because holding "sessions" must not imply the power to put an OS
dialog in front of the user.

**`fs.read` is not `fs.probe` widened** (P2-E16-01, DESIGN §5.30). Probe answers
"is this there, and is it a directory"; read answers with the bytes. Existence
is strictly less power than contents, so folding the second into the first would
hand every probe-holder a file-read primitive — and the entire point of the
split vocabulary is that a Phase-4 consumer can hold one without the other. The
same argument keeps `update.check` from implying `update.install`.

Where `fs.read` may point is decided in **main and only main**
(`src/main/fs/read-scope.ts`): the folders of open session cards, plus paths the
user picked in the native dialog. Every decision is made on the **resolved real
path**, so `../` and a symlink out of the root are refused by construction
rather than by pattern-matching the string, and the size cap is applied before
the bytes cross the bridge. A renderer-side version of any of that would protect
nobody — the caller it defends against is the renderer.

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
  dependency. Failing closed is about the *decision*, not the *delivery*: the
  call is refused, and the refusal arrives as a value (see the contract above).

## Standalone entry points

Main's `registry` is a singleton for the app, but `ContributionRegistry` is a plain
class and standalone tooling constructs its own — see
[hook-check.ts](../src/main/hooks/hook-check.ts), a CLI check that builds
a private registry, registers the Claude adapter, and drives a `SessionManager`
outside Electron. Keep `SessionManager` (and anything like it) taking a registry
as a constructor argument rather than reaching for the singleton, or that stops
working.

## Known gaps — the 2026-07-26 architecture review

This section is the honest scoreboard. Full findings:
`docs/architecture-review-2026-07-26.md`; the fix is **E15** in
`docs/plans/04-phase-2-switchboard.md`. Each bullet below carries its own
status — the section is only worth reading if that status is true, which is why
a stale one counts as a defect (#472) rather than as tidying.

**Consumer count on the seams: 7** — `provider-adapter` in main, and
`command-set`, `panel`, `feed-block-renderer`, `status-bar-item`, `theme` and
`find-provider` (P2-E17-02) in the renderer. It matches "Contribution points and
their registrants" above, which is the list to change first.
It was **1** when the review was written, and the finding was never
the count itself but that it *could not grow*: the seam was main-only, so a
renderer contribution had nowhere to land. P2-E15-02 removed the ceiling and
**P2-E15-03 (done)** dogfooded three dissimilar points onto surfaces that were
already hardcoded. The Phase-4 gate ("2–3 dissimilar internal consumers") is
met for the first time — which is a starting condition for that conversation,
not a decision to ship a plugin API.

- **The seam covers the main process only, and the roster is mostly renderer.**
  Of §5.23's nine first-party extensions, only the provider adapters (item 1)
  are main's; the other eight — usage pane, notification channels, dispatch role
  templates, the service status monitor, manager panes, theme presets, feed
  block renderers, and the item-9 backlog — are renderer
  contributions. **Was:** no renderer
  registry at all, so seven of them were plain in-process code with nowhere to
  land. **RESOLVED.** E15-02 made `ContributionRegistry` process-agnostic and
  gave the renderer its own instance, bootstrap and contracts map; **E15-03**
  added `panel`, `feed-block-renderer` and `status-bar-item`, each replacing a
  hardcoded switch that already existed in `SessionGrid.tsx`, `FeedView.tsx` or
  `chrome.tsx`; **E15-05** added `theme`. What remains unregistered is the usage
  pane, notification channels, dispatch templates, the service status monitor
  and the manager panes — five roster items that are code which does not exist
  yet, rather than code with nowhere to go. See "Contribution points and their
  registrants" above for the roster-by-roster count.
- **~~A second registry already exists without being called one.~~ RESOLVED
  (E15-02).** `renderer/lib/commands.ts` + `command-set.ts` **was**
  `{id, title, category, enabled(ctx), run(ctx)}` — exactly a contribution
  point. (It has since grown `titleKey` / `categoryKey` for i18n plus
  `binding`, `scope` and `disabledReasonKey`; the shape above is the review's
  2026-07-26 snapshot, not today's `Command`.)
  **E15-02 (done)** registers it through the real registry, so there is
  one extension model rather than two: `App.tsx` resolves `command-set`
  contributions instead of importing `buildCommands`.
- **~~The provider contract can't describe a non-Claude CLI.~~ RESOLVED
  (E15-01, 2026-07-30).** **Was:** §5.3 specified
  `capabilities: { transcripts, hooks, resume, mcp }` while the shipped
  interface was `buildSpawn()` + optional `slashCommands()`, so `sessions/ipc.ts`
  assumed Claude for everything else — hardcoded `providerId`, unconditional
  hook settings, an unconditional `~/.claude/projects` watch, and resume
  semantics owned by the IPC handler. By this document's own rule — *if our own
  adapter can't be expressed in the contract, the contract is wrong* — the
  contract was wrong, and it was **the one blocking the multi-provider goal**:
  you would have discovered it by writing adapter #2 and having to edit a
  consumer. **Now:** `ProviderAdapter.capabilities` is a real object
  ([`ProviderCapabilities`](../src/main/extensibility/contributions.ts)) and
  those four assumptions live in
  [`planSessionStart`](../src/main/sessions/start-plan.ts), which ASKS the
  capability object per session and degrades where a member is absent — an
  adapter that declares nothing spawns a PTY and nothing else.
  **The member list is deliberately not restated here: `docs/DESIGN.md` §5.3 is
  the source of truth**, and it carries the as-built record of every change to
  the object (`trust` added by E15-01, `mcp` deferred to E11, `titles` added by
  P2-E7-06, and the host-resolved transcript root `resume.canResume` now takes,
  #432). This bullet described the pre-E15-01 world for two weeks *because* it
  kept a second copy of that list; a pointer cannot go stale the way a copy
  does (#472).
- **~~Capabilities have no enforcement point at all.~~ RESOLVED for IPC
  (E15-04); still true of contribution manifests.** "The contract" above says
  manifest capabilities are "declarative only — nothing enforces them yet",
  which remains accurate for *those* strings. What changed is that there is now
  a place a check can go at all: the preload bridge **was** ~60 hand-maintained
  methods with no capability scoping. E15-04 tags every IPC channel with one
  declared capability and adds a single main-side choke point — a runtime no-op
  for first-party, which is the point: Phase 4 wires a plugin manifest into an
  existing check instead of inventing a permission model.
- **~~Themes are not a contribution shape yet.~~ RESOLVED (E15-05).** §5.20 says
  a theme is a JSON token map; the implementation was two hardcoded
  `[data-theme]` blocks and a two-value `ThemeName` union that made a third
  theme a *type error*. A theme is now `{base, colorScheme, tokens}` applied to
  `documentElement`, the 43 themeable token names are enumerated in
  `theme/tokens.ts` (with a test that fails when they drift from `tokens.css`),
  and `high-contrast` ships as data. The `theme` point came with it rather than
  after it — the registry already existed, so it was ~20 lines, and it is the
  only point that proves a contribution can be inert data.

Owner decision 2026-07-26: **third-party plugin support is a real goal**
(first-party add-ons first). That is why E15-04 ships full-size rather than
being trimmed to internal tidiness.

## What is deliberately NOT built

No on-disk manifest format · no loader or install path · no `utilityProcess`
plugin host or typed RPC · no activation events (`onSessionStart`,
`onProviderNeeded:<id>`, `onEvent:<type>`) · no *join* between a contribution's
declared capabilities and the grants the broker checks · no sandboxed webview
panels · no distribution story.

Note how narrow that *join* item is: **capability enforcement itself exists.**
E15-04 tags every IPC channel with one capability and the broker refuses a
caller that does not hold it — answering an `IpcRefusal` rather than throwing
(#346, "How the broker refuses — the contract" above). What is missing is the
wiring on the other side: the strings in a `CapabilityManifest` still bind
nothing, so turning a plugin's declared set into the grant the broker already
enforces is the Phase-4 job (see "Two vocabularies, not yet joined").

Every item on that list is Phase 4, and it is **gated**: the plugin API alpha
starts only after 2–3 dissimilar internal consumers exist on the seams
(`docs/plans/03-later-phases.md`). Current count: **seven**, so that condition is
met — see "Known gaps" above for what it does and does not license. Check the
registry's actual consumer list before anyone schedules that work.

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
