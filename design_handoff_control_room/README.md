# Handoff: switchboard.ai — Control Room (main orchestrator window)

## Overview
The **Control Room** is switchboard.ai's primary screen: one desktop window hosting many
concurrent AI coding-agent sessions (Claude Code first-class). It shows every session's
live status, routes the user's attention to what needs them, and lets any session be
blown up to a full-window "focus mode." This handoff covers that single screen in two
canonical themes (**Nordic** dark, **Daylight** light) with a working
**click-to-maximize** interaction.

Read `PHILOSOPHY.md` and `DESIGN.md` (in the repo root / project uploads) for the product
constitution and the full feature spec — this screen implements pieces of §5.8
(attention-driven layout), §5.10 (Feed), §5.11 (session identity kit), §5.12 (event feed),
§5.13 (usage bars), and §5.20 (token-based theming).

## About the Design Files
The file in this bundle (`Control Room.dc.html`) is a **design reference created in HTML** —
a prototype showing intended look and behavior, **not production code to copy directly**.
It is a "Design Component" (`.dc.html`): an HTML template + a small `Component` logic class,
rendered by a lightweight in-house runtime. **Ignore the `.dc.html` mechanics** — they are a
prototyping harness, not a target architecture.

Your task: **recreate this design in switchboard.ai's real codebase** using its established
patterns. Per `DESIGN.md §6`, the chosen stack is **Electron + TypeScript + React + xterm.js
+ node-pty + Monaco**. So: build this as **React + TypeScript components**, back the real
terminal panes with **xterm.js/node-pty** and the diff pane with the **Monaco diff editor**,
and drive status/usage/events from the hook + transcript pipeline described in `DESIGN.md
§5.2`. The mock's terminal/diff/feed content is illustrative — wire it to live data.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, and the maximize interaction are
all intentional. Recreate the chrome pixel-accurately with the exact tokens below. The one
thing that is *placeholder* is the **content inside** terminals, diffs, and feed rows — that
comes from real sessions at runtime.

---

## Design Tokens

### Typography
- **UI font:** `'IBM Plex Sans', system-ui, sans-serif`
- **Mono font** (terminals, diffs, metadata, branch names, token counts):
  `'IBM Plex Mono', monospace`
- Sizes in use (px): 9 (section eyebrows, letter-spacing 1.3–1.4px, weight 600), 9.5–10
  (metadata/mono), 10.5–11 (body, status pills, feed body), 12–12.5 (session names,
  titlebar), 13.5 (maximized session title).
- Weights: 400 / 500 / 600 (600 = names, labels, eyebrows) / 700 (identity icon glyphs).

### Theme tokens (CSS custom properties — swap the whole set to change theme)
| Token | Nordic (dark) | Daylight (light) | Used for |
|---|---|---|---|
| `--bg`      | `#242933` | `#eef1f5` | window / center canvas background |
| `--panel`   | `#2b313d` | `#ffffff` | rail, feed, cards, titlebar-adjacent panels |
| `--panel2`  | `#333a48` | `#f4f6f9` | feed rows, watcher strip, selected rail row |
| `--border`  | `#3b4252` | `#dde1e7` | all hairline borders / dividers |
| `--chip`    | `#39414f` | `#e9edf2` | chips, usage-bar track, urgency lamps, active tab |
| `--bar`     | `#20252e` | `#ffffff` | titlebar + status bar background |
| `--text`    | `#e5e9f0` | `#1b2230` | primary text |
| `--muted`   | `#9aa4b8` | `#5b6470` | secondary text |
| `--faint`   | `#6d7689` | `#9098a6` | tertiary text, eyebrows, line numbers |
| `--term`    | `#cdd4e2` | `#2c3444` | terminal body text |
| window shadow | `0 24px 70px rgba(0,0,0,.5)` | `0 24px 70px rgba(20,30,50,.16)` | outer window |

Default theme = **Nordic**. Toggle swaps to Daylight. In the real app this maps to
`DESIGN.md §5.20` (theme = JSON token map; follow OS light/dark by default).

### Session identity accent colors (SEPARATE from theme — survive theme switches, §5.11)
Auto-assigned per session from a distinguishable palette; user-overridable.
| Session | Accent | Lang badge |
|---|---|---|
| TradingApp  | `#e3b341` (amber)  | TS |
| PropaneMon  | `#39c5bb` (teal)   | Rs |
| BrainSite   | `#a78bfa` (violet) | JS |
| ledger-core | `#3fb950` (green)  | Go |
| docs-site   | `#58a6ff` (blue)   | JS |
| pixel-forge | `#f0776b` (coral)  | Py |
| api-gateway | `#db61a2` (pink)   | Go |
| mobile-sync | `#f0883e` (orange) | TS |

Accent is applied to: 3px left stripe on cards/rows, identity icon (accent @ 16% alpha bg +
solid accent glyph), usage-bar fill, urgency-lamp dot, @-mention token.

### Status colors (the status machine — `working | needs-input | needs-permission | idle | done | crashed`)
| Status | Color | Label | Notes |
|---|---|---|---|
| working          | `#58a6ff` | "working"          | dot **pulses** (see animation) |
| needs-input      | `#e3b341` | "needs input"      | card gets amber border + soft glow |
| needs-permission | `#f0883e` | "needs permission" | card gets orange border + soft glow |
| idle             | `#8a92a0` | "idle"             | |
| done             | `#3fb950` | "done"             | |
| crashed          | `#f85149` | "crashed"          | |
- "needs you" set = `needs-input | needs-permission | crashed | done` → these light the
  urgency strip and drive the "N need you" count.
- Status pill = status color text on `statusColor @ 14% alpha` background, radius 5px, pad 2×9px.
- Semantic (theme-independent) syntax/diff colors: added `#3fb950` (bg `rgba(63,185,80,.16)`),
  removed `#f85149` (bg `rgba(248,81,73,.15)`), file paths / links `#58a6ff`, subagent `#a78bfa`,
  primary button `#238636` on `#fff`.

### Spacing / radius / misc
- Card/panel radius **8px**; window radius **10px**; chips/pills **5–6px**; usage-bar track **3px**.
- Grid gap **11px**, grid padding **12px**; rail padding **7px** horizontal; feed row pad **9×10px**.
- Left accent stripe: `position:absolute; left:0; top:0; bottom:0; width:3px`.
- Attention glow on a card: `box-shadow: 0 0 0 1px rgba(<status>,.12–.14)` + `1px solid rgba(<status>,.5)` border.

---

## Layout

Fixed reference size **1360 × 848** (the real window is resizable — treat these as proportions).
Vertical stack, all `flex`:

1. **Titlebar** — height **40px**, bg `--bar`, bottom border `--border`. Windows-style
   (no macOS traffic lights).
   - Left: `◈` logo (`#58a6ff`) · "switchboard.ai" (600/12.5px) · workspace pill
     ("workspace **side-projects** ▾", chip bg + border) · "**＋** New session" button (border, green +).
   - Right: **theme toggle** button (`☾ Nordic · dark` / `☀ Daylight · light`, border, radius 7px) ·
     window controls `﹘ ▢ ✕` (each 42×40, hover brighten; ✕ hover would be red in production).
2. **Urgency strip** — height **38px**, bg `--panel`, bottom border. Eyebrow "URGENCY" +
   a horizontal row of 8 **lamps** (one per session): pill with accent-square dot + name +
   status label. "Needs-you" lamps get `statusColor @ 12%` bg + `statusColor @ 42%` border;
   others use `--chip` bg + `--border`. **Each lamp is clickable → maximizes that session.**
   Right-aligned "● N need you" in amber.
3. **Body** — `flex:1`, three columns:
   - **Sessions rail** — width **240px**, bg `--panel`, right border. Header "SESSIONS · 8"
     + "sort: usage ▾". Scrolling list of 8 **session rows**, each:
     accent left-stripe · status dot · name (600/12px) · lang badge (mono, bordered) ·
     status label (right). Second line (mono/faint): "⌥ {branch} · +{dirtyCount}".
     Third line: usage bar (track `--chip`, fill = accent, width = usage %) + token count (right).
     **Whole row clickable → maximize.** Selected row: bg `--panel2` + `inset 0 0 0 1px accent@50%`.
     Rail footer: "5-hr window 68%" + gradient meter (`#3fb950`→`#e3b341`).
   - **Center** — `flex:1`, column. Contains EITHER the grid or the maximized panel, then the composer.
     - **Grid mode** (default): 2×2 grid (`1fr 1fr` / `1fr 1fr`, gap 11, pad 12) of **session cards**.
       Card = header (icon · name · pulsing status dot · status label · token/burn chip) +
       terminal body (mono, `--term`, ~11px/1.62) + footer. Footer varies by status:
       tab row (Terminal/Feed/Files/Diff) for working; "⌨ waiting in Terminal … jump →" strip for
       needs-input; watcher strip ("🗔 watcher test-runner 12.4k … auto-close ▾ 📌 ✕") for the
       session running a subagent; Allow/Allow-once/Deny button row for needs-permission.
       **Whole card clickable → maximize.**
     - **Maximized mode** (focus): the grid is replaced by ONE panel filling the center
       (margin 12, radius 9, border, bg `--panel`, drop shadow). Header: accent stripe-badge ·
       identity icon · name (13.5px) · status pill · mono meta ("⌥ branch · +dirty · tok · provider") ·
       right side: "● focus mode" indicator + **⤡ Restore to grid** + **Hide ▾** buttons.
       Body splits: left `flex:1.6` live **terminal** (mono 12px/1.75, `--term`, blinking caret),
       right `flex:1` **diff/files/feed** pane — tab row (Diff active) with "+31 −9" totals, then a
       Monaco-style unified diff (line numbers faint, removed rows red bg, added rows green bg).
     - **Composer** (always present, bottom of center) — top border, bg `--panel`, pad 9×12.
       Left hint "⊕ drag files · text · diffs across sessions". Center: input field (bg `--bg`,
       border, radius 8) showing an @-mention prototype: "Take **@TradingApp**'s last output and
       apply the same fix here" — `@TradingApp` rendered as an accent token (amber @16% bg) + blinking
       caret. Right: green "Send ⏎" button. Above the field: an **@-autocomplete popup** (250px,
       `--panel2`, listing sessions with accent squares + status).
   - **Event feed** — width **308px**, bg `--panel`, left border. Header "EVENT FEED" +
     "group by session ▾", then **filter chips** All / Attention / Warning (active chip = `--chip`
     bg + border). Scrolling list of **event rows** (bg `--panel2`, 2px left border in the event's
     color): session name · tag (colored) · time (right) · body · optional mono stat · optional
     inline action buttons (e.g. Allow[green]/Deny[red], View diff, Restart & resume, Jump to terminal).
4. **Status bar** — height **26px**, bg `--bar`, top border, mono `--muted`.
   Left: "● All systems operational" (green) · "5-hr window 68% — mostly TradingApp".
   Right: "8 sessions · 3 working · 1 idle" · "⚠ 4 need you" (amber) · provider counts
   ("claude 6" / "codex 1"[orange] / "gemini 1"[violet]).

---

## Interactions & Behavior
- **Click-to-maximize (the headline interaction).** Clicking a session anywhere — rail row,
  grid card, or urgency lamp — sets it as the focused session and switches the center from
  grid → maximized panel for that session. Clicking the **same** session again toggles back to
  grid. **Restore to grid** and **Hide ▾** buttons in the maximized header both return to grid
  (in production, "Hide" should instead remove the session from the workspace per the
  presentation ladder in `DESIGN.md §5.8` — expanded → collapsed → tabbed → hidden — leaving it
  reachable only via the rail / urgency lamps; the mock treats Hide as restore for now).
- **Theme toggle** flips every `--*` token between Nordic and Daylight instantly. Session accent
  colors and status colors do NOT change (identity is theme-independent). In production, default
  to following the OS light/dark setting.
- **Feed filter chips** filter the event list by severity: All / Attention
  (`done`, `needs permission`, `needs input`) / Warning (`crashed`, `high usage`, `git`).
- **Hover:** rows/cards/buttons brighten ~12% (`filter: brightness(1.12)`), pointer cursor.
- **Animations:**
  - `pulse` — working status dots: keyframes `box-shadow 0 0 0 0 rgba(88,166,255,.5)` → `0 0 0 6px
    rgba(...,0)` over **1.8s infinite**.
  - `caret` — blinking cursor in terminals/composer: opacity 1↔0, **1s infinite** step.
  - The maximize transition is instant in the mock — **add a short (~150–200ms) ease** when you
    build it (a requested next step).
- Table-stakes production behaviors not fully mocked but implied: keyboard path for everything
  (Ctrl+1..9 to jump to session N, Ctrl+Space to advance the attention queue), drag-and-drop of
  files/text/diffs into a session's composer, and inline actions actually sending keystrokes to
  the target PTY.

## State Management
Minimal client state for this screen:
- `theme: 'nordic' | 'daylight'` — active token set (default from OS).
- `maximizedSessionId: string | null` — which session owns the center; `null` = grid mode.
- `feedFilter: 'all' | 'attention' | 'warning'`.
- `sessions: Session[]` — id, name, accent, lang, provider, status, task label, branch,
  dirtyCount, usagePct (share of the 5-hr window), tokenTotal. **Live data**, sourced from the
  hook listener + transcript watcher (`DESIGN.md §5.2/§5.13`).
- `events: FeedEvent[]` — session, severity, tag, time, body, stat, actions[]. Streamed from the
  same pipeline (`DESIGN.md §5.12`).
- Derived: `needCount` = sessions where status ∈ {needs-input, needs-permission, crashed, done};
  `selected` = sessions.find(maximizedSessionId).
- Terminal panes = **xterm.js** bound to the session PTY; diff pane = **Monaco diff editor** on
  the session's uncommitted diff. Neither should be re-implemented in DOM as in the mock.

## Assets
No image/icon files — everything is Unicode glyphs (`◈ ﹘ ▢ ✕ ☾ ☀ ⌥ ⌨ 🗔 📌 ↳ ⎿ ● ▌ ❯ ⊕ ⤡`) and CSS.
In production, swap glyphs for the codebase's icon set where appropriate (window controls,
watcher pin, etc.). Fonts: **IBM Plex Sans** + **IBM Plex Mono** (Google Fonts / self-hosted).

## Screenshots
In `screenshots/` — reference renders of both themes and both center modes:
- `nordic-grid.png` — Nordic (dark), grid mode (default landing state).
- `nordic-maximized.png` — Nordic, ledger-core maximized into focus mode (terminal + Monaco diff).
- `daylight-grid.png` — Daylight (light), grid mode.
- `daylight-maximized.png` — Daylight, TradingApp maximized.

## Files
- `Control Room.dc.html` — the hifi prototype (this handoff's subject). Open in a browser to see
  both themes and the maximize interaction (click any session; use the top-right toggle).
- Also in the project (context, not part of this screen): `Switchboard Main Window.dc.html`
  — the exploration canvas with five structural layouts (turn 1) and five theme/dock directions
  (turn 2). `SwitchWindow.dc.html` — the reusable themed-window component used by turn 2.
- Product docs: `PHILOSOPHY.md`, `DESIGN.md`, `README.md`.
