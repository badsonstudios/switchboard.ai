# #909 — keyboard focus lost after a renderer dialog (Windows)

Measured 2026-09-21 on Windows 11 with the v0.8.96 Electron. The probe in
`spike/probes/909/` launches the app with Playwright, then drives it with real
input (`SetCursorPos`, `mouse_event` and `SendKeys`). Playwright's own clicks
and keys go over CDP and never touch Windows focus, so no ordinary e2e can see
this bug.

## Result

| Step | Result |
|---|---|
| Control: real click in the prompt, then real typing | text arrives |
| `window.confirm` (a native `#32770` dialog), dismissed with a real Esc, then a real click and typing | **nothing arrives** (every run) |
| Same, plus main calls `webContents.focus()` | nothing |
| Same, plus main calls `win.focus()` | nothing |
| Same, plus main calls `win.blur(); win.focus()` | **text arrives** |
| Main-process `dialog.showMessageBox(win)`, dismissed with Esc | text arrives. Not a trigger, and it even heals the broken state |
| Real tab ✕, then the close confirm, then Esc, **with the fix** | text arrives, twice in a row |
| Same, with the main handler disabled (mutation) | nothing arrives |

In the broken state, **every focus signal says all is well**:

- `document.hasFocus()` is true.
- `win.isFocused()` is true.
- `webContents.isFocused()` is true.
- `BrowserWindow.getFocusedWindow() === win` is true.
- The clicked textarea is `document.activeElement`.

So the issue's first suggestion, a `!document.hasFocus()` guard, would never
fire. Nothing can detect the state, so the fix repairs it after every dialog.

## Not tested

- Trigger 3: a popout closing and handing focus back.
- Trigger 4: the relaunch after an update.

The confirm alone explains the report, because closing a session tab asks for
confirmation every time.

## Shipped fix

- Renderer dialogs go through `lib/native-dialog.ts`, which sends
  `app:refocusAfterDialog` after each one closes.
- Main then calls `blur()` and `focus()` on the window the OS says has focus,
  and only if that window is ours (`main/dialog-refocus.ts`).
- A unit test forbids bare `window.confirm`, `window.alert` and
  `window.prompt` anywhere in the renderer.
