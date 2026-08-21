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
 * *Reactivating* a toast from the Action Center after it has expired is
 * documented as needing a registered **ToastActivatorCLSID**, and
 * `WinShell::SetLnkAUMI` does not write one. That matters here specifically
 * because `permission-toast.ts` deliberately keeps a toast alive in the Action
 * Center after `close` — so whether an **Allow** pressed there still reaches
 * the session is a HAND-TEST, logged in `docs/plans/dogfood-testing.md`, not
 * something this constant settles.
 */
export const APP_USER_MODEL_ID = 'com.badsonstudios.switchboard';
