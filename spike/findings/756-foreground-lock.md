# #756 — can a background Electron window take the Windows foreground?

Measured 2026-10-18 on Windows 11 (10.0.26300) with Electron 43.1.1 (the app's
own `node_modules/electron`). Probe: `spike/probes/756/` — a bare
`BrowserWindow`, no app, no CLI. Raw rows: `spike/probes/756/results/`;
`node spike/probes/756/summarize.cjs` rebuilds the table.

## Setup

- **The other app** is a separate PowerShell process with a WinForms window
  (`holder.ps1`) that covers the probe window. Before each attempt it is handed
  the foreground and then gets one Shift tap, so it, not us, received the last
  input. That is the normal state when a session calls: you are typing
  somewhere else.
- **The probe window** is put in its start state (behind the holder, or
  minimized), one technique runs, and the OS is asked who holds the foreground
  (`GetForegroundWindow`) at 150, 700 and 2000 ms, and whose window is on top
  at the probe window's centre (`WindowFromPoint`).
- **Every technique in a FRESH Electron process**, 3 attempts each. An early
  all-in-one-process run gave contradictory answers (one technique's leftovers,
  such as a restored placement, leaked into the next); those rows were thrown
  away.
- `HKCU\Control Panel\Desktop\ForegroundLockTimeout` = 200000 ms (the default).

## Result

| Technique | Start | Took the foreground | On top, no keyboard | `isFocused()` true without the foreground |
|---|---|---|---|---|
| `focus()` | behind | 0/3 | 0/3 | **3/3** |
| `show()+focus()` (today's `raiseWindow`) | behind | 0/3 | 0/3 | **3/3** |
| `app.focus({ steal: true })` | behind | 0/3 | 0/3 | **3/3** |
| `moveTop()+focus()` | behind | 0/3 | 0/3 | **3/3** |
| `webContents.focus()` | behind | 0/3 | 0/3 | **3/3** |
| `hide()+show()` | behind | 0/3 | 0/3 | **3/3** |
| `setAlwaysOnTop(true)+show()+focus()+setAlwaysOnTop(false)` | behind | 0/3 | **3/3** | 3/3 |
| **`minimize()+restore()`** | behind | **3/3** | — | 0/3 |
| **`minimize()`, 400 ms, `restore()`** | behind | **3/3** | — | 0/3 |
| `focus()` | minimized | 0/3 (stays minimized) | 0/3 | 0/3 |
| **`restore()`** | minimized | **3/3** | — | 0/3 |
| **`restore()+show()+focus()`** (`raiseWindow` on a minimized window) | minimized | **3/3** | — | 0/3 |
| `showInactive()` (the #1332 quiet path) | minimized | 0/3 | 0/3 | 0/3 |
| `show()+focus()` after 205 s with no probe input | behind | 0/1 | 0/1 | 1/1 |
| **`minimize()+restore()`** on a **maximized** window | behind | **3/3**, and it came back maximized 3/3 | — | 0/3 |
| **`show()+focus()`** while a sibling window **of ours** holds the foreground | behind it | **3/3** | — | 0/3 |

The last two rows were added after code review, to measure the two cases the
first table left open.

Every "took" was already true at 150 ms, and still true at 2000 ms.

## What it means

1. **Windows' foreground lock refuses every `focus()` route to a window that is
   merely behind**, Electron's `app.focus({ steal })` included (its docs say
   `steal` is macOS-only, and it is). This is the #705 lock, measured.
2. **A refused `focus()` is worse than nothing: it makes `isFocused()` lie.**
   After every refused call Electron reported the window focused while another
   process held the foreground, and kept saying so through later attempts. The
   notifier's taskbar flash is guarded by `!win.isFocused()`, so a refused
   attention `focus()` would also have silenced the next event's flash. The
   attention raise therefore makes NO `focus()` call on Windows, and "was it
   already in front?" is read when the event arrives, not after the in-app
   jump (whose dockview DOM `focus()` on a popout can cause exactly this lie).
   **Known limit:** that only helps if no earlier refused `focus()` poisoned
   the window. One remaining path does: a popped-out card under `focus` whose
   raise was declined (quiet hours, notifications off) still gets dockview's
   refused DOM `focus()`, and its next event can then read "already in front".
   Electron exposes no way to ask the OS which window really holds the
   foreground, so this is recorded, not fixed.
3. **What Windows does allow is restoring a minimized window.** `restore()` on a
   minimized window took the foreground every time, and so did
   `minimize()+restore()` on a buried one. That is the technique
   `raiseForAttention` uses: a visible swoop, which is what "Always jump to it"
   asked for. A full-screen window is not minimized (that would leave full
   screen) and gets NO call — every option left is the refused-and-lying
   `focus()` family — so it goes straight to the flash fallback.
4. **The always-on-top flicker is the wrong trade**: the window lands on top
   but the keyboard stays with the other app — you see it and your typing goes
   elsewhere.
5. **Between our OWN windows the plain raise works.** When one of the app's
   windows holds the foreground, `show()+focus()` on another of them took it
   3/3 — the foreground process may hand the foreground to itself. So the swoop
   is only used when ANOTHER app is in front; moving from the main window to a
   popout (or back) is the plain raise, with no animation. Which case it is
   comes from the event-time snapshot.
6. **A maximized window survives the swoop**: it came back maximized and in
   front, 3/3. The swoop is the same `minimize`/`restore` pair a person makes
   from the taskbar, so the app's window-state saving sees nothing new; each
   swoop does leave a `minimize` + `restore` pair in the main-window placement
   log, which is expected and not a user action.
7. **The quiet e2e path holds**: `showInactive()` never took the foreground.
8. **Idle did not unlock it.** After 205 s with no probe input,
   `show()+focus()` was still refused. Not conclusive — the owner's own input
   during those minutes would reset the timeout, and the probe cannot tell — so
   nothing relies on the idle timeout.

## Not measured

- macOS and Linux (the raise there is the plain `raiseWindow`, unmeasured).
- A real full-screen app (game, video) holding the foreground; Focus Assist /
  Do Not Disturb. The fallback (flash + lamp, logged at info) is what covers
  them; the app's log line `attention raise: …` records each outcome.
- Whether a refused raise flashes the taskbar by itself: the flash cannot be
  read back from outside, so the app flashes the window explicitly on refusal.

## Excluded on purpose

Synthesised input (the ALT-key or `AttachThreadInput` tricks that unlock
`SetForegroundWindow`). The probe's own stand-in app uses the ALT trick to take
the foreground for setup; the product will not — it would mean injecting a key
into whatever you are typing in, and a native dependency for it.
