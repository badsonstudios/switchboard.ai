# switchboard.ai Design Philosophy

This is the constitution. Every feature, screen, and PR is judged against this
document. When a design argument stalls, this document wins. When a feature
conflicts with it, the feature changes — not the philosophy. Amendments are
allowed but deliberate: change this file first, then the feature.

(Companion to DESIGN.md, which says *what* we build. This says *how we decide*.)

---

## 1. Product Principles

**P1. Instant on.**
A developer gets value in under a minute: install → point at a folder → session
running. No config file, no account, no tutorial required for the first win.

**P2. Intuitive first, discoverable depth.**
The obvious action is the correct one. Power reveals itself when reached for and
is invisible until then (progressive disclosure). If a feature needs the manual,
its *default* must not.

**P3. Calm, not a casino.**
Pleasing to look at without being overbearing. Quiet by default; loud only when
something genuinely needs the user. Density where it informs (mission control),
whitespace where it calms. A well-run control room, not a slot machine.

**P4. Configurable everything, required nothing.**
Every default is livable, so configuration is a choice, never a chore. Two
developers' setups may look completely different — both are right.

**P5. Attention is the product.**
The user's scarcest resource is attention, not screen space. Every feature is
judged on attention ROI: it must save more attention than it costs. This is the
principle the others serve.

**P6. Fail open, never block.**
If switchboard.ai crashes, lags, or misbehaves, sessions keep running as plain
Claude Code. Approvals time out into the normal terminal prompt. Killing the app
never kills work; recovery is resume. We are a layer over the CLI — never a
hostage-taker.

**P7. Host, don't reimplement.** *(amended 2026-07-31 — see §6)*
The real CLI does the deciding and the doing. We render, decorate, route, and
notify — we never fork the agent's behavior, and we never invent an interaction
the CLI did not offer us.

Three lines, in order of hardness:

- **The process is the product.** We host the actual `claude` binary on the
  user's own subscription. We never reimplement the agent, and we never
  reimplement a decision it makes. Non-negotiable.
- **Rendering is ours, and the transport is an implementation detail.** Drawing
  the CLI's ANSI in a terminal emulator and rendering the CLI's typed message
  stream are the same act — display — and neither is more "real" than the other.
  Choose the transport that shows the user more of what the CLI is actually
  doing.
- **A decision the CLI delegates, we may present. A decision the CLI keeps, we
  may not fake.** If the CLI hands us a choice (a `can_use_tool` request), a
  native surface for it is hosting. If the CLI keeps a choice for itself, we do
  not screen-scrape it, guess at it, or answer it on the user's behalf — we say
  so plainly and route the user to where the decision actually lives.

The old wording said "interaction belongs to the CLI," which read as *the
terminal is the constitution*. It is not. **Fidelity to the CLI's behavior is
the constitution; the terminal was one way to get it.**

**P8. Local-first and private.**
No accounts, no cloud dependency, no telemetry. Everything lives on the user's
machine. The subscription the user already pays for is the only service involved.

**P9. Trust through transparency.**
What each agent is doing, is about to do, and has changed is always visible and
attributable. We never hide an action to appear smoother.

## 2. Session-Management Principles

**S1. Any session in ≤ 2 gestures.**
One hotkey or one click from anywhere reaches any session. Measured, not vibes.

**S2. Attention state at a glance.**
From any screen state, within one second: which sessions need me, and why.
(Urgency strip, status badges, attention queue — all serve this line.)

**S3. Notify like a good colleague.**
Right channel, right urgency, actionable at the point of notification, never
nags twice for the same thing. Quiet hours respected.

**S4. Organize your way.**
Groups, tabs, splits, floats — the user's mental model wins. The app remembers
arrangements exactly and never rearranges on its own. (See §3.)

**S5. Keyboard-first, mouse-equal.**
Every flow has a complete keyboard path and a complete mouse path.

**S6. Scale from 1 to 12.**
Great with one session; calm with twelve. Every feature is sanity-checked at
both extremes before it ships.

**S7. Never be the bottleneck.**
The app is snappy at all times. Background sessions cost ~nothing to render.
switchboard.ai never makes an agent — or the user — wait on it.

## 3. Layout Freedom — the organizing model

Hierarchy: **session → tab stack → group → workspace.**

- Sessions can be tiled in the orchestrator grid, **tabbed together** into
  stacks, collected into named **groups**, and any group can be **docked**
  inside the main window or **popped out** as its own OS window (e.g. "Dev"
  tabbed in the main window; "IT" floating on monitor 2). Any mix is valid.
- Groups are first-class: named, colored, collapsible, minimizable as a unit;
  notification rules can be scoped per group.
- Everything is drag-and-drop rearrangeable; every arrangement is remembered
  per workspace; named layouts capture entire arrangements for recall.
- **The default is a plain grid.** The hierarchy materializes only when the
  user drags something. Complexity is earned by the user's own gesture, never
  imposed. (P2 in layout form.)
- Popped-out windows remain orchestrator-owned: drag-and-drop, context
  transfer, and the attention queue work identically across OS windows.

Implementation note: docking/tab-stack UIs are a solved problem (e.g. Dockview
and similar proven libraries). We integrate one; we do not hand-roll one.

## 4. The Feature Litmus Test

Before any feature ships, it must pass ALL of:

1. **Zero-config default** — works sensibly with no setup? (P1, P4)
2. **Attention ROI** — saves more attention than it costs? (P5)
3. **Fail-open** — if it breaks, the session keeps working? (P6)
4. **Escape hatch** — can be done manually and turned off? (P4)
5. **Two-gesture rule** — every session still ≤ 2 gestures away? (S1)
6. **Calm check** — adds zero noise to the default experience, or is opt-in? (P3)
7. **Host check** — does not reimplement or fork CLI behavior, and does not
   fake an interaction the CLI kept for itself? (P7)

A feature that fails any test gets redesigned, parked in the DESIGN.md backlog,
or killed. **"It would be cool" is not a reason.** The backlog exists precisely
so good ideas can wait without bloating the product.

## 5. Litmus in practice — worked examples

- *Approval surfaces (DESIGN §5.16)*: passes — falls through to terminal on
  timeout (3), saves squint-and-hunt attention (2), off = normal TUI prompts (4).
- *TTS announcements*: passes only as opt-in — fails the calm check (6) as a
  default, so it ships off-by-default under Notifications v2.
- *A built-in code editor*: fails host check spirit and attention ROI — users
  have editors. Monaco stays read-only + diff-only. Rejected as a feature
  direction; recorded here as precedent.
- *Screen-scraping the TUI's permission prompt* (S-09 option 3): fails the host
  check under the amended P7 — the CLI kept that decision, so parsing its prose
  and sending `1`/`2`/`3` is faking an interaction, and a mis-parse answers the
  wrong question. Rejected; recorded as precedent.

## 6. Amendments

Amendments are deliberate: this file changes first, then the feature. Each one
records what changed, what forced it, and what it does **not** license.

### 2026-07-31 — P7, on terminals vs. transports

**Changed.** P7 no longer implies that hosting the CLI means hosting a terminal
emulator. Fidelity to the CLI's behavior is the invariant; the terminal was one
means to it. Three explicit lines replace one sentence, and a new one is added:
a decision the CLI *delegates* may be presented natively, a decision the CLI
*keeps* may never be faked.

**What forced it.** A permission prompt switchboard could see but not answer —
Claude Code guards `.claude/**` writes above both the `permissions.allow` layer
and the PreToolUse hook layer, so our entire approval path was blind to it
(`spike/findings/s-09-permission-prompt-tool.md`). No flag surfaces that prompt
to a host that runs a TUI; the workaround was attempted and failed. The CLI's
stream-json transport delivers it as a `can_use_tool` request with a
human-readable reason attached, verified against our own PATH CLI on the
subscription (`spike/findings/s-10-stream-json-transport.md`). The old reading
of P7 forbade the only route that reaches the user's goal, which is the
definition of a principle that needs amending rather than a feature that needs
redesigning.

**What it does NOT license.**
- It does not authorize reimplementing the agent, its permission logic, or any
  decision it makes. That line got *harder*, not softer.
- It does not decide that the terminal goes away. It removes the constitutional
  objection to a native surface; whether the terminal stays as an escape hatch
  is an engineering call, and the fail-open and escape-hatch tests (litmus 3 and
  4) still apply to it. Anthropic's own extension keeps both modes.
- It does not license screen-scraping. The new third line forbids it explicitly,
  and the §5 example records that.
