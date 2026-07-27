# Handoff: switchboard.ai — Sessions Rail (grouped, no-icon variant "3a")

## Overview
The **sessions rail** is the left-hand panel of switchboard.ai's main window. It lists every
live agent session in the workspace, organized into **user-created groups** (a group is just a
name + a color; sessions live under it, and ungrouped sessions collect in a trailing
"Ungrouped" card). Its job is to make two things instant: *which group is a session in*, and
*which sessions need me right now*.

This replaces the current rail, whose problem was that group headers and session rows carried
the same visual weight, every row repeated a `diff ●` pair plus a sub-label, and status was
communicated by a small blinking circle. The approved design fixes all three.

Read `PHILOSOPHY.md` and `DESIGN.md` for product context — this panel implements parts of
§5.8 (attention-driven layout), §5.11 (session identity kit), and §5.13 (usage/status surfacing).

## About the Design Files
`Sessions Rail 3a.dc.html` is a **design reference created in HTML** — a prototype of look and
behavior, **not production code to copy**. It is a "Design Component" (`.dc.html`): an HTML
template plus a small `Component` logic class run by an in-house prototyping runtime.
**Ignore the `.dc.html` mechanics entirely.**

Recreate this in switchboard.ai's real codebase using its established patterns. Per
`DESIGN.md §6` that is **Electron + TypeScript + React**, so build it as a React + TypeScript
component tree (`SessionsRail` → `GroupCard` → `SessionRow`) driven by live session state, not
the hardcoded array in the mock.

`Sessions Rail.dc.html` (also in the project, not required here) is the exploration canvas
containing all 15 rail directions — useful only if you want to see rejected alternatives.

## Fidelity
**High-fidelity.** Colors, type, spacing, and interaction are final. The *content* (session
names, group names, sub-labels) is sample data — it comes from real sessions at runtime.

---

## The chosen direction: no session icon

Sessions deliberately have **no icon or avatar**. Earlier rounds tried folder icons, language
glyphs, monograms, provider marks, geometric shapes, channel numbers and identicons; all were
rejected as noise. The **colored left edge bar is the identity mark**, which means every
session name starts at one flush left margin and the name itself becomes the thing you scan.
Do not reintroduce a per-session icon.

**Groups do have an icon** — a small outline folder in the group's color. This is deliberate:
the group glyph and the session rows must read as *different kinds of thing*, and since
sessions have no icon, the folder unambiguously means "container."

---

## Design Tokens (Daylight / light theme — the approved appearance)

### Typography
- UI: `'IBM Plex Sans', system-ui, sans-serif` · Mono: `'IBM Plex Mono', monospace`
- Rail eyebrow: 9px / 600 / letter-spacing 1.4px / mono / `#9098a6`
- Group name: 11.5px / 600 · Session name: 11.5px / 600 (**700 when it needs you**)
- Sub-label: 9.5px — mono `#5f6875` when calm, **IBM Plex Sans 600 in the status color** when it needs you
- Count chip / footer: 9–10px mono

### Surfaces
| Token | Value | Use |
|---|---|---|
| rail background | `#f4f6f9` | the canvas group cards sit on |
| card / header strip background | `#ffffff` | group card body, rail header, footer |
| card border | `#dde1e7` | 1px, radius 8px, shadow `0 1px 2px rgba(20,30,50,.04)` |
| group header tint | group color @ **7%** | header band, with `1px solid #e7eaef` bottom border |
| row hover | `#eef1f6` | |
| divider | `#e7eaef` | |

### Session identity accents (theme-independent, §5.11)
`#e3b341` amber · `#39c5bb` teal · `#a78bfa` violet · `#3fb950` green · `#db61a2` pink ·
`#f0776b` coral · `#58a6ff` blue · `#f0883e` orange.
Used **only** for the left edge bar and the selected-row tint.

### Group colors (darkened so the name is legible as text)
`Current Dev #2f6ad9` · `General #1a7431` · `amd #b03b78` · `shamoody #6b4fd1` · `Ungrouped #5f6875`.
Group color is used for: the folder icon, the group name text, the count chip (color + 12% bg),
and the 7% header tint.

### Status ramp — **light theme text ink** (darkened for ≥4.5:1 on white)
| Status | Text ink | Label | Right-edge indicator |
|---|---|---|---|
| working | `#1c62c9` | working | **rotating ring** (spinner) |
| needs input | `#8a5a06` | needs input | `?` |
| needs permission | `#94500d` | permission | `!` |
| done | `#1a7431` | done | `✓` |
| idle | `#5f6875` | idle | `–` |
| crashed | `#b02722` | crashed | `✕` |

> These are **light-theme overrides**. The Nordic/dark tokens in
> `design_handoff_control_room/README.md` (working `#58a6ff`, needs-input `#e3b341`,
> done `#3fb950`, idle `#8a92a0`, crashed `#f85149`) are the brighter hues. Implement status
> color as a `{ text, indicator }` pair **per theme** rather than one value — small 9.5px text
> needs the dark ink, dots/rings can keep the bright hue.

### Geometry
- Rail width **286px** (resizable in production). Card radius 8px, row radius 7px.
- Rail padding 10px; group card margin-bottom 9px; row padding `8px 8px 8px 13px`; row gap 2px.
- Left edge bar: absolutely positioned, `left:0; top:3px; bottom:3px`, radius `0 2px 2px 0`.
  **2.5px** normally, **4px** when the session needs you.
- Status indicator box: 16×16, radius 4px, status color on status @14% background.
- Spinner: 12×12 circle, `1.6px` border in status @22%, `border-top-color` = status color,
  `spin 1.1s linear infinite`.

---

## Layout

```
┌ SESSIONS · 10                    ＋ group ┐   header (white, 1px bottom border)
├───────────────────────────────────────────┤
│ ┌─ group card ─────────────────────────┐ │   canvas #f4f6f9, 10px padding
│ │ ▾ 📁 Current Dev  (3)  1 need you ⊕✕ │ │   header band = group color @7%
│ ├──────────────────────────────────────┤ │
│ │ ▌ Moodathon                    ✕  ⟳  │ │   row: bar · name/sub · right column
│ │   Testing this                       │ │
│ │ ▌ ClaudeMon                    ✕  ?  │ │   ← needs you: tinted, bold, thick bar
│ │   Asked you a question               │ │
│ └──────────────────────────────────────┘ │
│ ┌─ General (1) ────────────────────────┐ │
│ …                                        │
├───────────────────────────────────────────┤
│ 10 sessions                  4 need you  │   footer
└───────────────────────────────────────────┘
```

**Rail header** — "SESSIONS · {n}" eyebrow + "＋ group" button (border `#dde1e7`, radius 5px).

**Group card** — white card on the tinted canvas. Header band (group color @7%) contains, left
to right: disclosure chevron (8px, rotates −90° when collapsed, 120ms) · outline folder icon in
the group color · group name · count chip · **need summary** pushed right ("2 need you" in
`#8a5a06`, or "calm" in `#5f6875`) · `⊕` add-session and `✕` close-group tools.

**Session row** — three parts:
1. **Left edge bar** in the session's identity color (thick + status-colored when it needs you).
2. **Body** (flex:1, min-width:0) — name on line 1, sub-label on line 2. Both truncate with
   ellipsis. When the session needs you the sub-label is replaced by **the ask**
   ("Asked you a question", "Wants permission to run", "Crashed — needs restart",
   "Finished — review changes") in the status color at 600 weight.
3. **Right column** (`flex-direction: column; align-items: flex-end`) — **`✕` close at the
   top**, status indicator below it. This is the requested placement: close pinned top-right of
   every row, busy/status indicator on the far right edge.

**Attention treatment** — a session needing you gets: row background = status @10%, 4px
status-colored bar, name at 700, and the ask spelled out. Calm sessions stay plain. This
contrast is intentional and should not be softened.

**Footer** — "{n} sessions" + "{k} need you".

## Interactions & Behavior
- **Click a group header** → collapse/expand that group (chevron rotates). Collapse state is
  per group and should persist across restarts.
- **Click a session row** → select it (and, in the full window, maximize/focus that session —
  see the Control Room handoff).
- **`✕` on a row** → close that session. **`✕` on a group header** → delete the group (its
  sessions should fall back to Ungrouped, not be killed — confirm this in the real product).
  **`⊕`** → new session in that group.
- **Close buttons are always present, never hidden.** Resting state `#7d8695` at full opacity
  (≈3.4:1 on white, clearing WCAG 1.4.11's 3:1 for controls); on hover `#b02722` with a
  `rgba(176,39,34,.10)` rounded backplate. Each is an **18×18 hit target** (flex-centred box with
  a 4px radius) — grow the box with padding, never by enlarging the glyph.
- **Motion:** the *only* animation is the working spinner (1.1s linear). No blinking, no pulsing
  dots — this was an explicit rejection. Every other state is static.
- Row hover `#eef1f6`; chevron rotation 120ms.
- Production behaviors implied but not mocked: drag a session between groups, drag to reorder,
  right-click context menu, and keyboard nav (↑/↓ plus Ctrl+N to jump to the Nth session).

## State Management
```ts
type Status = 'working' | 'input' | 'perm' | 'done' | 'idle' | 'crashed';

interface Session { id: string; name: string; accent: string; status: Status; sub: string; groupId: string | null; }
interface Group   { id: string; name: string; color: string; collapsed: boolean; }
```
- `selectedSessionId: string | null`
- `collapsedGroups: Record<string, boolean>` — persisted
- Derived per group: `needCount` = sessions with status ∈ {input, perm, done, crashed} → drives
  the header summary; total `needCount` drives the footer.
- `sessions` and their `status`/`sub` come from the hook listener + transcript watcher
  (`DESIGN.md §5.2`), not from local state.

## Assets
No image files. The only icon is the group folder, an inline SVG (16×16 viewBox, `fill:none`,
`stroke:currentColor`, `stroke-width:1.6`) — swap for your icon set's folder if you have one.
Other glyphs are Unicode: `▾ ＋ ⊕ ✕ ? ! ✓ –`. Fonts: IBM Plex Sans + IBM Plex Mono.

## Files
- `Sessions Rail 3a.dc.html` — the approved design, standalone. Open in a browser; click group
  headers to collapse, rows to select.
- `PHILOSOPHY.md`, `DESIGN.md`, `README.md` — product docs (project root).
