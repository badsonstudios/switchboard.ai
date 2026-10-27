# #1468: why the swoop never brought a popped-out window forward

Measured 2026-10-27 on Windows 11 (10.0.26300), Electron 43, on the owner's
desktop. Probe: `spike/probes/1468/probe-swoop-configs.cjs`; raw rows in
`spike/probes/1468/results/configs-*.json`. #756's stand-in "other app"
(`spike/probes/756/holder.ps1`) held the foreground and got a Shift tap before
every raise ("the person just typed there"); #1379's helper asked Windows who
held the foreground (`GetForegroundWindow`) 700 ms after the raise.

## The answer: any OTHER visible window of ours makes the swoop lose

#756's swoop (`minimize()` then `restore()`) takes the foreground only when no
other window of the process is on screen. It has nothing to do with the target
being a popout:

| Process | Target | Swoop took the foreground |
|---|---|---|
| one window | main | **10/10** |
| main + popout from `window.open` (the app's shape) | main | 0 |
| | popout | 0 |
| main + a second `BrowserWindow` made by main | either | 0 |
| main + popout OWNED by main (`parent`) | popout | 0 |
| | main | 3/3 (minimizing an owner hides its owned windows too) |
| main + popout, the OTHER window already minimized | either | **12/12** |

All two-window rows together: **0 of 59** (51 behind-the-holder targets, 8
minimized targets). A popped-out session always has the main window on screen
beside it, which is why #1379's real-app probe saw 0 of 6. The main window's 4
of 6 there came from a test with no popout open.

Candidates the issue listed: the owner/parent relationship does not matter
(owned or not, 0); focus/show/moveTop ordering and the always-on-top flicker
were already measured refused in #756 and are not used; the foreground-lock
"who had input last" rule is the same in the winning and losing rows (the other
app had the last input in every row).

## The fix measured: hide our other windows for the swoop

`hide-others`: hide every OTHER visible, un-minimized window of ours, swoop
the target, and 150 ms later show them again with `showInactive()` (no
activation).

| Start state | Swoop alone | hide-others |
|---|---|---|
| honest (target behind the other app) | 0/43 | **50/50** |
| target left "active" by a refused `focus()` (#1379's lie) | 0/8 | **16/16** |
| of which, the final before/after run (`configs-1793117319359`) | **0/12** | **12/12** |
| target minimized (`restore` alone) | 0/8 | 5/8 |

(hide-others from an honest or focus-poisoned start, every run: **66 of 66**.)
Side effects measured with both windows placed UNDER the other app: the
hidden-and-shown window came back behind the other app after every granted
raise (65/65), not over it; a maximized one came back maximized (6/6). Variants `blur()` then
hide-others, and hiding the target too, also won 4/4 each and add nothing.
Minimizing every window and restoring only the target (`swoop-all`) won only
after a first refusal (2/3 pattern) and is not used.

## What it does not fix

1. **Right after a refused swoop, the next attempt is refused too, whatever
   the variant**: 0 of 48 (`--poison-swoop`: a refused swoop, the other app
   back in front, then the raise). Waiting 3 s or 10 s did not clear it
   (0/12), and an immediate retry did not either (0/8). In the long sequential
   run, the attempt after that one was granted again. Not understood further.
2. **The real app** (`spike/probes/1379/probe-real-app.spec.ts`, copied into
   `e2e/`, four runs; output in `results/real-app-after-fix-*.txt`): the
   popout's allowed raises went refused, refused, raised, raised in EVERY run.
   Before the fix (#1379's runs, same probe): refused every time. The two
   refusals are the first raise after the popout was opened behind the other
   app, and its immediate repeat (the answered turn's `done`, 2.4 s later, with
   no other-app activation between). Every raise after the other app was put
   back in front was granted. When a raise is refused, the taskbar button
   blinks (PR 1467's fallback), unchanged.
3. A minimized target with another window on screen: 5 of 8 with hide-others,
   alternating (granted, refused, ...), against 0 of 8 before.

## A blinking window steps aside too

The notifier blinks the main window's taskbar button for every attention event
while it is not in front (`flashUntilArrival`). A version that left blinking
windows on screen (so the hide could not drop the blink) put the main window
back beside the popout on every raise, and the real-app probe went back to
refused 6 of 6 (`results/real-app-blinking-main-kept-on-screen.txt`). So a
blinking window steps aside like any other, and its blink is started again
(`flashFrame(true)`) once it is shown back. Final code, two more real-app runs
(`results/real-app-after-fix-3.txt`, `-4.txt`): refused, refused, raised,
raised, each, as in runs 1 and 2.

## Why this is host-honest

It uses no Windows trick the app did not already use: the swoop is #756's
measured, opt-in technique ("Always jump to it" only), and it already takes
the foreground from the person's app. Hiding our own other windows for 150 ms
only removes the condition Windows refuses it under; no other app's window is
touched, nothing is made always-on-top, no input is synthesized, and the
other windows return behind the app the person was in. It never runs for a
raise between our own windows, off Windows, in full screen, or quiet.

The visible cost: while the swoop lands, switchboard's other windows vanish
for about a sixth of a second and come back (their taskbar buttons too). If
that is not wanted, the alternative is "flash only" for any raise while
another window of ours is on screen (the behaviour before this, minus the
pointless swoop).

## Not measured

macOS and Linux (unchanged: they never swoop). A full-screen OTHER window of
ours (hidden and shown like any other; unmeasured). More than two windows (the
code hides all of them; only two were measured).
