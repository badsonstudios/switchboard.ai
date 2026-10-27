# #1035 — feed skipping with N full cards open: the observers cost something, and it is not yet a frame

**Probe:** `spike/probes/740/feed-relayout.spec.ts`, second test (`-g 1035`).
**Machine:** the dev desktop, Windows 11, one 1266x737 window (no secondary display).
**Conditions:** the #740 conditions exactly. 4x CPU throttle (`Emulation.setCPUThrottlingRate`),
40 keys per run, a 600-character draft already in the composer, one key per
animation frame, layout priced by one flushing `scrollHeight` read. Every card
filled to the 1,000-block cap (`FEED_VIEW_CAP`) with five `!bulk 200` turns.
**Builds:** `main` at cec7bfc2, unmodified. The probe changes nothing in the app.

---

## Verdict

**Fine. No mitigation shipped.** At every N the median keystroke frame is one
frame (16.6-16.9ms) and the layout a keystroke forces is flat or falling. What
does grow with N is the browser's per-frame ResizeObserver pass. It grows in a
straight line and is easy to see in a trace. At the busiest layout the app's
presets can produce, it costs about **3.5ms of a 16.6ms frame** and moves
**about 5% of keystrokes** into a second frame, against 0-0.3% with the
observers cut. That is a tail, not a broken frame budget. It is written down
below with the mitigation candidate, so the next person starts from a number
and not a guess.

### The threshold, and why

Declared in the plan comment before any run. The curve counts as **bad** if,
at N=8:

* the **median** keystroke frame leaves one 60Hz frame. Operationally that
  means more than ~20ms: the paced frame is key, then rAF, then `setTimeout(0)`,
  so an on-budget key reads 16.7ms plus timer slack. Or
* the **layout per key** grows materially over N=1.

This is the bar #740 itself shipped against: "the frame is back inside its
budget", 43.3 -> 16.6ms. The slow-frame share (frames over 25ms, i.e. at
least one missed vsync) is reported next to it as the tail. It is not the
bar, because a 5% tail at a 4x throttle is not the "keystrokes buffer and then
appear all at once" failure #740 was about.

---

## 1. The curve

Two sweeps, both interleaved. Each (rep, N) is a fresh launch, and the N order
rotates every rep, so a background .NET build cannot pass for a slope. Sweep A
ran 5 launches x 3 runs per cell (15 runs = 600 keys). Sweep B ran
3 launches x 3 runs, traced every launch, and added the `grid-again` order
check. Medians are of the per-run medians. The spread is min-max across runs.

**What the rows mean:**

* `tabbed` is the default: every card a tab in one place, one on screen. The
  others stay mounted and detached, with their observers still live.
* `grid` is the `grid` layout preset, all cards on screen. **It has at most
  four places** (`layout-presets.ts`, `MOST.grid = 4`), so at N=8 four are on
  screen and four are tabs behind them. That is the busiest main-window layout
  the app offers.
* `-noRO` is **the control**: the same launch, the same DOM, the same inline
  `content-visibility` / `contain-intrinsic-size`, with **only the feed-skipping
  observers disconnected**. Skipping keeps working, because the styles stay. The
  only thing removed is the per-frame gathering of their targets. "On minus off"
  is the observers' bill and nothing else's.
* `targets` comes from a counting wrapper on `ResizeObserver.prototype.observe`,
  installed before the first block arrived: blocks plus groups that are still
  attached to a parent, across every observer. `on screen` is the subset in the
  document. **No block geometry is read anywhere.**

### Sweep A (5 launches x 3 runs per cell)

| layout | N | targets | on screen | layout ms/key | frame ms/key | frame p90 | slow frames |
|---|---|---|---|---|---|---|---|
| tabbed | 1 | 1,026 | 1,026 | **5.00** (4.70-5.40) | **16.70** (16.70-17.00) | 17.70 | 0.2% |
| tabbed | 2 | 2,052 | 1,026 | **4.90** (4.70-5.20) | **16.70** (16.50-16.80) | 17.80 | 0.0% |
| tabbed | 4 | 4,104 | 1,026 | **4.60** (4.30-5.40) | **16.70** (16.40-17.60) | 17.80 | 1.0% |
| tabbed | 8 | 8,208 | 1,026 | **4.50** (4.20-5.40) | **16.70** (16.50-17.40) | 17.70 | 1.5% |
| tabbed-noRO | 8 | 0 | 0 | 4.40 (4.30-4.80) | 16.70 (16.50-16.80) | 17.60 | 0.0% |
| grid | 2 | 2,052 | 2,052 | **4.30** (4.10-4.80) | **16.70** (15.90-16.80) | 17.70 | 0.2% |
| grid | 4 | 4,104 | 4,104 | **2.80** (2.60-3.00) | **16.70** (16.30-18.10) | 18.80 | 3.0% |
| grid | 8 | 8,208 | 4,104 | **2.80** (2.70-3.00) | **16.80** (16.50-17.40) | 20.40 | **4.5%** |
| grid-noRO | 4 | 0 | 0 | 2.70 (2.60-3.60) | 16.70 (16.50-18.10) | 17.90 | 0.8% |
| grid-noRO | 8 | 0 | 0 | 2.70 (2.60-3.10) | 16.70 (16.50-17.00) | 17.80 | 0.3% |

Sweep B reproduces every row within its spread: grid N=8 is 2.90 / 16.90 / 6.1%
slow, and grid-noRO N=8 is 2.80 / 16.70 / 0.0%. Grid layout ms are lower than
tabbed because each card is a quarter of the window, so there is less feed on
screen to lay out.

### Where the frame actually goes: renderer main thread, ms per keystroke (Sweep B, 3 traced runs per cell)

| layout | N | targets (on screen) | `NotifyResizeObservers` | whole lifecycle | `Layout` | `Paint` |
|---|---|---|---|---|---|---|
| tabbed | 1 | 1,026 (1,026) | 0.59 (0.55-0.60) | 7.28 | 5.34 | 3.12 |
| tabbed | 2 | 2,052 (1,026) | 0.79 (0.74-0.82) | 6.70 | 5.39 | 3.46 |
| tabbed | 4 | 4,104 (1,026) | 1.10 (1.03-1.23) | 7.15 | 4.60 | 3.58 |
| tabbed | 8 | 8,208 (1,026) | **1.77** (1.70-1.94) | 7.97 | 4.65 | 3.64 |
| tabbed-noRO | 8 | 0 | 0.08 | 5.76 | 5.02 | 3.63 |
| grid | 2 | 2,052 (2,052) | 1.52 (1.35-1.52) | 8.42 | 4.89 | 3.60 |
| grid | 4 | 4,104 (4,104) | **3.36** (2.87-3.69) | 11.97 | 2.82 | 1.97 |
| grid | 8 | 8,208 (4,104) | **3.73** (3.50-4.52) | 12.84 | 2.88 | 2.18 |
| grid-noRO | 4 | 0 | 0.13 | 8.41 | 2.79 | 1.85 |
| grid-noRO | 8 | 0 | 0.15 | 9.15 | 2.84 | 2.10 |

"Whole lifecycle" is `WebFrameWidgetImpl::UpdateLifecycle`. Traced numbers
include tracing's own overhead (the `blink` category was on), so treat them as
an upper bound. Their *differences* between on and off in the same launch are
the clean part.

**Reading the slope off it:**

* **About 0.8ms per 1,000 on-screen targets per frame**: grid 4 vs grid-noRO 4
  is 3.2ms for 4,104 targets.
* **About 0.16ms per 1,000 detached targets per frame**: tabbed 8 minus tabbed 1
  is 1.2ms for 7,182 extra targets that are not in the document. Detached
  cards are cheap, but not free.
* **Layout and paint do not move** with the observers on or off. The observer
  pass is its own line item. It is not making layout more expensive.

## 2. The order check

The control runs last in every launch, because cutting the observers cannot be
undone. So the grid row's tail could have been "the first pass after the grid
remount" rather than "the observers". Sweep B measured the grid twice before
cutting:

| N | grid | grid-again | grid-noRO |
|---|---|---|---|
| 4 | 0.6% slow, NotifyRO 3.36 | 1.4% slow, NotifyRO 3.51 | 0.6% slow, NotifyRO 0.13 |
| 8 | 6.1% slow, NotifyRO 3.73 | **4.7%** slow, NotifyRO 3.54 | **0.0%** slow, NotifyRO 0.15 |

The second pass looks like the first. The tail belongs to the observers.

## 3. What this is NOT

* **Not 8 cards on screen.** The presets stop at four places. Eight visible
  cards would take hand-made splits. Extrapolating the slope, that is about
  8,200 on-screen targets: ~6.5-7ms of observer pass on a ~9ms floor, which
  is about one whole frame at a 4x throttle. **Not measured; an extrapolation.**
  If someone tiles eight cards by hand on the laptop, this is the first place
  to look.
* **Not only keystrokes.** The observer pass runs in every rendering lifecycle
  that has observations to check, not just after a key. A streaming card, a
  scroll or an animation pays the same per-frame bill for every card's
  targets. The keystroke is just the frame this harness can pace.
* **Not the laptop.** The 4x throttle stands in for it, as it did for #740.
  E21's laptop capture is the real test. Laptop-only AV (VIPRE) taxes spawns
  and file reads, not this.
* **Not Linux or macOS.** Same caveat as #740's findings.

## 4. If it ever needs taking: the candidate, and why it was not taken blind

The cost is per **observation**, not per observer, so two of the issue's three
named mitigations do not touch it:

* **One observer shared across cards:** the same number of targets, so the same
  gather.
* **Unobserve on eviction:** ResizeObserver holds its targets weakly, and an
  evicted block leaves the document. At the cap, the live count is the ~1,025
  in the DOM either way, so there is nothing to win.
* **Observe only while the card is visible** would take the *detached* share,
  ~0.16ms per 1,000, the smaller of the two. It also collides with why
  `reconcile` exists: dockview's idea of visible is not reliable (#555).

The candidate that targets the **on-screen** share, which is the share that
matters, is different: **stop observing a block while the engine is skipping
it.** A skipped block's observer can only ever report back the height we wrote
(the loop closes by construction, see `use-feed-skipping.ts`), so observing it
buys nothing. `contentvisibilityautostatechange` (Chromium 150 has it, per
#740's findings) says when a block starts and stops being skipped. Observing
only the unskipped ones would cut ~1,000 targets per on-screen card to the
~20-40 that are actually rendered.

Why it is not in this PR:

1. The numbers do not cross the declared threshold.
2. It rewrites the one invariant #740 paid four probe runs to establish: every
   height arrives from an observer. The first delivery after re-observing has
   to measure a block that has *just* been un-skipped. Whether Chromium
   delivers that before or after the frame that paints it is exactly the class
   of question that reverted the first attempt.
3. Whether the state event fires at all inside a dockview-*detached* subtree is
   unverified. That is the same "dockview's visibility is not reliable" trap,
   one level down.

If it is ever taken, this harness is the before/after. The `-noRO` rows are
already the floor it would be approaching.

---

## What this cost to learn

* **The keystroke metrics alone said "flat", and they were right about the
  frame and silent about the cost.** Layout ms/key and the median frame do not
  move with N, because the observer pass is a separate lifecycle step from the
  forced layout this harness prices. The slope only shows up in a trace and in
  the slow-frame tail. A probe reporting only #740's two columns would have
  closed this as "no cost", which is not what it is.
* **Re-arranging the dock REMOUNTS every card**, and each remounted `FeedView`
  makes a fresh observer for all its blocks. The first control run cut the
  observers, then switched layout, and the census read 1,026 live targets in a
  row labelled "no observers". The control now cuts again after every
  re-arrange. The census column is what caught it.
* **The composer's placeholder is no longer "Prompt this session"** (it reads
  "Message ..."), so the #740 test's first wait had silently rotted. Both tests
  now wait on `.composer-box`.
