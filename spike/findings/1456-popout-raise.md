# #1456: why a rail click did not raise a popped-out session's window

**Probe:** `spike/probes/1456/probe-popout-raise.spec.ts` (Playwright, real app,
Windows 11 desktop, 2026-10-26). It used the app's real raise path: the e2e quiet
mode (`SWITCHBOARD_E2E_NO_ACTIVATE`) was forced off, as `popout-raise.spec.ts`
does. The question was the issue's: which link breaks between the rail click and
`app:raisePopout`?

## What the probe measured (main at c991c42e, before the fix)

The main window was put in front each time, then a rail row was clicked. The
probe read which window the OS reported focused 1.5 s later.

| Case | In front after the click |
|---|---|
| One session popped out, behind the main window | **popout** (works) |
| The same popout, minimised | **popout**, un-minimised (works) |
| A second session started in the popout, then dragged to its right edge so the two sit side by side (2 groups in one window). Click the SECOND | **main (broken)** |
| Same window, click the FIRST | **popout** (works) |

The popout's frame name was `1-2`: dockview names a popout window
`<componentId>-<groupId>` after the group it was opened FOR.

## The cause

Main's popout registry (`popoutWindows` in `main/index.ts`) is keyed by the
group id parsed from that frame name in `did-create-window`. The renderer asked
`app:raisePopout(panel.group.id)`. dockview 7 lets a popout window hold
**several groups**. Splitting a session beside another inside the popout, or
dropping a tab on its edge, creates a new group with a new id in the same OS
window. dockview also promotes another member to anchor when the first one
leaves. The frame name never changes. So any session that is not in the
window's first group sent an id main had never heard of, and the handler
answered `false` with nothing raised.

The other candidates the issue listed were ruled out by the same run:

- **The click path:** the row reached `focusSession`. The anchor case raised.
- **`raiseWindow: false`:** that path fires only on the attention auto-focus.
- **Card id vs live id:** the panel was found, and the miss was in main.
- **Minimised:** `raiseWindow` already restores, and the probe saw it do so.
- **The foreground lock:** not involved in a rail click. The click leaves our
  process in the foreground, and Windows lets it hand the foreground to its own
  windows (measured for #571 and #756).

The same key was used by two other renderer → main requests, which had the same
blind spot: the attention raise (`hostWindowOf` → `app:attentionRaise`) and the
folder dialog's parent (#531, `pickFolder`).

## The fix

The renderer reads the key from the same place main does: the popout DOM
window's own `window.name`, which is the frame name, same-origin.
`shared/popout-frame.ts` holds the one parser and `lib/popout-window-key.ts`
does the read. All three requests use it. With `SWITCHBOARD_DEBUG=focus`, main
logs each raise: the window key asked for, the panel's real group, whether a
window was found (and which keys it knows when not), and the result.

## After the fix (same probe, same machine, 2026-10-26)

| Case | In front after the click |
|---|---|
| One session, behind main | popout |
| Minimised | popout, un-minimised |
| **Second group of a split popout** | **popout** (was main) |
| First group after the split | popout |

**Not measurable here:** a popout behind ANOTHER app. Playwright cannot put a
foreign app in front. That case, and the taskbar blink when Windows refuses the
raise (`main/user-raise.ts`), are in the dogfood tracker's row for this issue.
