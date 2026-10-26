# #1379: after a refused raise, which window is really in front?

Measured 2026-10-26 on Windows 11 (10.0.26300), Electron 43, on the owner's
desktop. Probes: `spike/probes/1379/`. #756's stand-in "other app"
(`spike/probes/756/holder.ps1`) held the foreground, and a PowerShell helper
asked Windows who really held it (`GetForegroundWindow`). The helper is #756's
plus a `click` command (`spike/probes/1379/helper.ps1`).

## The bug, in the real app (before the fix)

`probe-real-app.spec.ts`, first test, at bd659dbf. Raw output:
`results/real-app-before-fix.txt`.

| Step | OS foreground | Electron: popout `isFocused()` | Attention raise |
|---|---|---|---|
| Popout opened, other app in front | other app | **true** | none |
| Event 1, 🔔 off | other app | true | `notifications-off` |
| Event 2, 🔔 on | other app | true | **`already-front`**: nothing raised, nothing flashed |

The popout was lying from the moment it opened, before any raise was asked
for. Playwright launches the app without the foreground, so dockview's
`window.focus()` on the new popout is refused. A person popping a card out with
a click is not affected that way, but the issue's path (a raise declined by a
gate) is.

## Part 1: which signals lie? (`probe-signals.cjs`)

A bare main window opens a popout with `window.open`, as dockview does.

After a refused main-side `focus()` (`BrowserWindow.focus()`,
`webContents.focus()`, `show()+focus()`), every Electron signal says
"focused": `isFocused()`, `getFocusedWindow()`, `webContents.isFocused()`, the
page's `document.hasFocus()`, and the window's own `focus` event, which FIRES
for the refused call. Following `focus`/`blur` events is therefore no fix. The
opener's DOM `popout.focus()` from an honest blur was refused silently, with no
lie (2 of 2). The real app's lie came from the popout's creation.

The raw Win32 messages, read with Electron's own
`BrowserWindow.hookWindowMessage`, do tell the cases apart:

| What happened | Messages the window got |
|---|---|
| Honest activation | `WM_NCACTIVATE(TRUE)`, `WM_ACTIVATE(on)`, in one burst |
| Refused `focus()` | `WM_ACTIVATEAPP(TRUE)`, **`WM_NCACTIVATE(FALSE)`**, `WM_ACTIVATE(on)` |
| The person then clicks the lying window | `WM_NCACTIVATE(TRUE)`, `WM_NCACTIVATE(TRUE)`, **no** `WM_ACTIVATE` |
| `flashFrame(true)` | `WM_NCACTIVATE` FALSE, TRUE, FALSE, … about every 530 ms, never two TRUEs in a row |
| #756's swoop (`minimize()+restore()`) on a lying window | `WM_ACTIVATE(on)` **alone** |
| Leaving | `WM_NCACTIVATE(FALSE)`, `WM_ACTIVATE(off)`, then `WM_ACTIVATEAPP(FALSE)` if another app took it |

A refused activation still makes the window its thread's "active" window, which
is why Electron believes it, but Windows draws its caption INACTIVE, because it
is not in front. The caption message is the truth.

## The rule (`src/main/foreground.ts`)

- An activation is in front if the caption message in the SAME burst (before
  the event loop turns) was TRUE. If the burst had no caption message, nothing
  changes. That last rule came from the real app: a refused swoop on a
  flashing popout sent a bare `WM_ACTIVATE(on)` 67 ms after a blink's TRUE, and
  an earlier version of the rule read that as "in front".
- A window that is "active" but not in front comes forward on a second TRUE
  caption in a row. A blink alternates, so it never sends two.
- Deactivation means not in front. `WM_ACTIVATEAPP(FALSE)` means the app is not
  in front. A window handed over already active (a popout: `did-create-window`
  comes after its first activation) is seeded as in front only if the app was.

## Part 3: the rule against the OS (`probe-classifier.cjs`)

Four rounds of 17 cases: refused focus; a click on the lying popout; refused
focus plus flashing, then a click; the main window flashing, then a click; the
opener's DOM focus; alt-tab-style arrival on a lying window; moves between our
own windows; the swoop on a lying window, with and without a flash.
**Rule vs `GetForegroundWindow`: 70 of 70.** Electron's `getFocusedWindow()`
was wrong on 32 of them. (`results/classifier-1793039832142.json`.)

## After the fix, the real app (`results/real-app-after-fix-*.txt`)

Same probe, two runs, plus three more events with the other app put back in
front first:

| Event | OS foreground | Before | After |
|---|---|---|---|
| 2 (🔔 on) | other app | `already-front` | **`refused`**, swoop tried, taskbar flashed |
| 3, 4 | other app | (not measured) | `refused`, flashed, every time |

The next raise is no longer skipped. Each outcome matched the OS, and the
`focus` debug log shows the tracker saying "not in front" while Electron said
focused.

## Found on the way (not fixed here)

1. **#756's swoop did not bring a popout forward, 0 of 6 events in the real
   app.** The main window's did 4 of 6 (`probe 1379: the main window raise`,
   two runs: the first try refused, then raised, raised). The popout had been
   lying since it opened, and a swoop on a window that is already "active"
   sends only a bare `WM_ACTIVATE`, with no foreground. In the bare
   two-window probe (`probe-swoop.cjs`) the swoop failed 0 of 3 on honest
   windows too, and #756's own single-window probe, re-run the same day, still
   took the foreground 3 of 3. So #756's measurement does not carry over to a
   process with a popout. Since the fix, an allowed raise that does not land is
   reported as `refused` and the taskbar flashes. Before, it was skipped
   silently.
2. **The rules engine's "is the app focused" (`visibilityAcross`) still reads
   `isFocused()`.** A lying popout makes rules for "while switchboard is the
   window you're using" think you are in it. It is left alone here because
   real-app e2e specs (`rules.spec.ts`, `permission-toast.spec.ts`) rely on
   what Electron reports under Playwright.

## Not measured

macOS and Linux have no hook, and the tracker answers with `isFocused()` there,
as before. Untested on Windows: a full-screen app in front, Focus Assist, and
a touch or pen arrival (a click and a `SetForegroundWindow` arrival were
measured).
