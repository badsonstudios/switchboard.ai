// Who this app says it is to the operating system (#471).

/**
 * The Windows **AppUserModelID**.
 *
 * WHAT IT IS FOR. Windows keys a running process to a taskbar button, a jump
 * list and — the reason it landed in #471 — an **Action Center identity** by
 * this string. With none set, Electron falls back to a default derived from the
 * electron executable, so every toast this app raises is filed in the Action
 * Center under *Electron*, with Electron's icon and Electron's name, next to
 * every other unconfigured Electron app on the machine. Notifications are the
 * one surface a user meets when the window is not in front of them; being
 * anonymous there is the wrong kind of quiet. (Discovered in #422's self-review,
 * deliberately deferred there, folded into this item.)
 *
 * **IT MUST MATCH THE INSTALLER, AND IT DOES.** electron-builder's NSIS script
 * stamps the Start-Menu and desktop shortcuts with `${APP_ID}`
 * (`app-builder-lib/templates/nsis/include/installer.nsh` →
 * `WinShell::SetLnkAUMI`), and `APP_ID` is `appInfo.id`, which is `appId` from
 * `electron-builder.js`. So the value below is the same one the shortcut
 * carries — which is what makes a packaged build's toasts show the app's own
 * name and icon rather than Electron's. `src/main/packaging.test.ts` pins the
 * two together, because "they agree" is a fact that would otherwise be true
 * only until someone renamed one of them.
 *
 * **WHAT THIS DOES NOT BUY, stated rather than assumed** (the standing rule:
 * never guess a contract). Attribution and filing are the AUMID's job.
 * *Reactivating* a toast from the Action Center after it has expired needs a
 * registered **ToastActivatorCLSID**, and `WinShell::SetLnkAUMI` does not
 * write one. Since #675 that is `TOAST_ACTIVATOR_CLSID` below.
 */
export const APP_USER_MODEL_ID = 'com.badsonstudios.switchboard';

/**
 * The Windows **Toast Activator CLSID** (#675): the COM class Windows starts or
 * calls when a toast is pressed AFTER it has left the screen, from the Action
 * Center. Without one the press goes nowhere — a toast still on screen is
 * answered in-process, which is why that case always worked.
 *
 * Three things must carry the same value, and `packaging.test.ts` pins them:
 *
 * - **the running app**, `app.setToastActivatorCLSID` in `main/index.ts`.
 *   Left unset, Electron 43 generates a RANDOM one per run (its API docs say
 *   so), so a toast from yesterday's run named a class nobody serves today —
 *   and every run wrote another `HKCU/Software/Classes/CLSID` key, never
 *   removed. A developer machine had 1,008 of them on 2026-11-09.
 * - **the Start-menu shortcut**, `System.AppUserModel.ToastActivatorCLSID`.
 *   electron-builder's NSIS template cannot write it (WinShell has only
 *   `SetLnkAUMI`), so the app stamps it itself at boot through Electron's
 *   own `shell.writeShortcutLink` (`main/toast-shortcut.ts`).
 * - **the installer's COM registration**, `build/installer.nsh`: the
 *   `LocalServer32` key that lets Windows start the app for a press when it is
 *   not running.
 *
 * NEVER CHANGE IT after a release: a toast already in someone's Action Center
 * carries the old one.
 */
export const TOAST_ACTIVATOR_CLSID = '{B09A799F-F4F1-40E7-BD3A-A3CF14B0AF11}';
/**
 * The one an UNPACKAGED run (`npm start`, every e2e) claims: fixed, so those
 * runs stop leaving a new registry key each time, and different from the
 * installed app's, so a dev run never answers for (or steals) the installed
 * app's toasts.
 */
export const DEV_TOAST_ACTIVATOR_CLSID = '{2652DD87-9A81-4F36-8F24-AC0B73BB611B}';

/** the name the installer gives the Start-menu shortcut (`nsis.shortcutName`) */
export const START_MENU_SHORTCUT_NAME = 'switchboard.ai';
