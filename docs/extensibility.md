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
| [contributions.ts](../src/main/extensibility/contributions.ts) | The contracts — `CapabilityManifest`, the `ContributionPointId` union, one interface per point, and the `ContributionContracts` map that ties them together |
| [registry.ts](../src/main/extensibility/registry.ts) | `ContributionRegistry` (`register` / `resolve` / `list` / `manifests`) plus the app-wide `registry` singleton |
| [bootstrap.ts](../src/main/bootstrap.ts) | The **only** module allowed to import contributors directly; populates the registry |
| [registry.test.ts](../src/main/extensibility/registry.test.ts) | Unit tests, including the P1-E1-06 done-when: the Claude adapter is resolvable via the registry |

### Contribution points and their registrants

| Point | Contract | Registered today |
|---|---|---|
| `provider-adapter` | `ProviderAdapter` | [`claudeAdapter`](../src/main/providers/claude.ts) — real; [`fakeAdapter`](../src/main/providers/fake.ts) — test double, mutually exclusive (see below) |
| `event-source` | `EventSource` | **nothing.** The contract is declared and unconsumed |

That is the whole roster: one genuine contributor. The `event-source` point is
a shape we committed to before we needed it — treat it as unproven. The §5.23
roster lists nine first-party extensions; items 2–9 (usage pane, notification
channels, manager panes, feed block renderers, themes, …) are currently plain
in-process code that does **not** go through the registry.

### Registry consumers

Only two production call sites resolve through the registry, and both matter
if you change the contracts:

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

1. Define the contract interface in `contributions.ts`.
2. Add the id to the `ContributionPointId` union.
3. Add the `point → contract` entry to `ContributionContracts`. The registry's
   generics key off this map, so `resolve('your-point', id)` is typed correctly
   with no cast at the call site.
4. Register at least one real contributor. **A point with no registrant is a
   guess**, and `event-source` is the cautionary example already in the tree.

## Standalone entry points

`registry` is a singleton for the app, but `ContributionRegistry` is a plain
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

**Consumer count on the seams: 1.** That is the number the Phase-4 gate reads,
and until E15 lands it *cannot grow* — which is the actual finding, not the
count itself:

- **The seam covers the main process only, and the roster is mostly renderer.**
  Of §5.23's nine first-party extensions, eight (usage pane, notification
  channels, manager panes, feed block renderers, theme presets, status-bar
  items, dispatch templates) are renderer contributions. There is no renderer
  registry, so seven of them are plain in-process code with nowhere to land.
  E15-02 makes `ContributionRegistry` process-agnostic; E15-03 adds `panel`,
  `feed-block-renderer`, and `status-bar-item` and dogfoods them with the
  hardcoded switches that already exist in `SessionGrid.tsx` and `FeedView.tsx`.
- **A second registry already exists without being called one.**
  `renderer/lib/commands.ts` + `command-set.ts` is
  `{id, title, category, enabled(ctx), run(ctx)}` — exactly a contribution
  point. E15-02 registers it through the real registry so we don't ship two
  extension models.
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
