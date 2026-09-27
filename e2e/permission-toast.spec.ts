// P2-E14-04 — the actionable permission toast, in a real window on a real
// desktop.
//
// TRANSPORT SCOPE — HISTORICAL (P2-E18-18, #404; retagged by #952, which
// left one transport, so a `[pty]` tag names nothing). The note below is the
// reasoning as it stood, kept because it says what each test actually drives:
// // TRANSPORT SCOPE (P2-E18-18, #404): `[pty]` for the whole group. The stimulus
// is a HELD `PreToolUse` hook, which is the PTY transport's permission path; a
// Direct session's permission rides `can_use_tool` instead. The behaviour under
// test is transport-blind by construction — `pendingPermissionFor` and
// `decidePermission` both fall through BOTH routers, and `ipc.test.ts` pins the
// stream half of each — so what is PTY-specific here is only how the request is
// made to exist.
//
// WHAT THIS CAN AND CANNOT PROVE. No harness can press a button on a real OS
// notification: the click happens in the shell, not in the page. So the split
// is deliberate and it is the one the issue asks for —
//
//   • the ROUTING (index 0 allows, index 1 denies, a dead session decides
//     nothing, a throw is contained) is unit-tested in
//     `src/main/events/permission-toast.test.ts`, against the same objects main
//     wires up;
//   • what only a real app can show is HERE: that a held permission really
//     produces a toast, that the toast really carries buttons on a desktop that
//     can render them, that the desktop really accepted it, and that a verdict
//     given at the approval bar really takes the toast back down.
//
// Read through the app LOG, the house pattern for main-process facts
// (`rules.spec.ts`, `approval.spec.ts`, `hookPoster`): the lines are written by
// the code under test, so they say what it DID rather than what a mock saw.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  blurApp,
  findFile,
  launchApp,
  LaunchedApp,
  poll,
  tempProjectFolder,
  permissionHolderBash,
} from './fixtures/app';

interface ToastLine {
  kind: string;
  cardId: string;
  visibility: string;
  ruleId: string;
  /** did the desktop take it? false where the OS has no notifier at all */
  shown: boolean;
  /** how many Allow/Deny buttons went on it */
  buttons: number;
  /** the held request those buttons would answer; '' when there is none */
  requestId: string;
}

/** every line of `msg` the app has written so far, parsed */
function lines<T>(home: string, msg: string): T[] {
  const f = findFile(home, 'switchboard.log');
  if (!f) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.includes(`"${msg}"`))
    .map((l) => JSON.parse(l) as T);
}

const toasts = (home: string): ToastLine[] => lines<ToastLine>(home, 'os toast rule fired');

/** Whether THIS desktop can put a button on a toast — `toastActionsSupported`. */
const BUTTONS_HERE = process.platform === 'darwin' || process.platform === 'win32';

/** How many permissions main is holding right now. */
async function heldCount(w: Page): Promise<number> {
  const held = (await w.evaluate(() =>
    window.switchboard.sessions.pendingPermissions()
  )) as unknown[];
  return held.length;
}

test.describe('actionable permission toasts (P2-E14-04)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a held permission toasts with Allow/Deny, and the bar withdraws it', async () => {
    const folder = tempProjectFolder();
    const title = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // OS toasts are opt-in (§5.9, off by default). Through the SAME bridge the
    // settings screen uses, so nothing here is a test-only door.
    await w.evaluate(() =>
      window.switchboard.notifications.setPrefs({ enabled: true, osToasts: true })
    );

    // The listener port and the per-session token used to be dug out of the app's
    // own log and state dir here, so the test could POST a `PreToolUse` as the CLI.
    // A permission is a control request now (#952) — `permissionHolderBash` below
    // sends it through the session itself, so none of that discovery is needed.

    // The user looks away — the toast's own condition (§5.9: no popup over the
    // window you are already reading). Asserted rather than assumed by
    // `blurApp`, which re-issues the blur until it takes and throws if it never
    // does (#538): a blur that did nothing would leave this test proving the
    // rule fired for a reason it did not have.
    await blurApp(a);

    // …and the CLI asks for something. A REAL `can_use_tool` request (#952): the
    // command has to be real, because the safety half below asserts the toast's
    // body was built from the request main is actually holding.
    await permissionHolderBash(a)(title, 'npm run build');

    const fired = await poll(() => {
      const t = toasts(a.home).filter((x) => x.kind === 'needs-permission');
      return t.length > 0 ? t : null;
    }, 20_000);
    expect(fired).toHaveLength(1);
    expect(fired[0].visibility).not.toBe('focused');
    // The toast is ABOUT a specific held request — this is the join that makes
    // an Allow button mean anything at all. Without it the buttons would be
    // decorations aimed at nothing.
    expect(fired[0].requestId).not.toBe('');

    // Buttons where the platform can carry them (Electron 43: darwin + win32),
    // and honestly none where it cannot. Both halves asserted, so neither can
    // rot unnoticed: a regression that dropped the actions on Windows fails
    // here, and one that started claiming buttons on Linux fails here too.
    expect(fired[0].buttons).toBe(BUTTONS_HERE ? 2 : 0);
    if (process.platform === 'win32') {
      // Where a notifier exists, insist the toast actually went out — and that
      // the desktop did not REFUSE the actionable one. A toast Windows rejects
      // is the failure this whole item could have shipped invisibly.
      expect(fired[0].shown).toBe(true);
      expect(lines(a.home, 'the desktop refused an OS toast')).toHaveLength(0);
    }

    // The SAFETY half. The toast body is `permissionSummary(req)` of the
    // request main is holding — so an Allow pressed off-screen grants a tool
    // call the user was actually shown, which is the whole promise (§5.9, P6).
    // `permission-toast.test.ts` pins the string that function builds; what is
    // proved here is that the request it is built from is the real one, with
    // the real command in it, and that the bar on screen says the same thing.
    await expect(w.getByText('Allow Bash?')).toBeVisible({ timeout: 15_000 });
    const pending = (await w.evaluate(() =>
      window.switchboard.sessions.pendingPermissions()
    )) as Array<{ requestId: string; tool: string; input: Record<string, unknown> }>;
    expect(pending[0].requestId).toBe(fired[0].requestId);
    expect(pending[0].tool).toBe('Bash');
    expect(pending[0].input.command).toBe('npm run build');

    // Now decide it SOMEWHERE ELSE — the approval bar, the surface that was
    // always there. The toast must come down: a notification offering Allow for
    // a question the CLI has already been answered is a button that can only
    // mislead.
    await w.getByRole('button', { name: 'Allow', exact: true }).click();

    // The answer used to be read out of the parked hook response. There is no
    // parked response — it goes back over the control channel — so the assertion
    // is made where a user would see it: main is holding nothing afterwards.
    await expect.poll(() => heldCount(w)).toBe(0);

    // Gated on the DESKTOP'S capability, not on the platform, and for the same
    // reason `shown` exists at all (#421's CI lesson): a Linux CI container has
    // no notification daemon, `Notification.isSupported()` is false there, and
    // nothing was ever put on screen — so there is no toast to withdraw and a
    // green assertion here would be a lie. The half that is real everywhere is
    // the verdict above, which is asserted unconditionally; where a toast DID
    // go out (Windows CI, and any real desktop), the withdrawal is insisted on.
    if (fired[0].shown) {
      const withdrawn = await poll(() => {
        const l = lines<{ requestId: string }>(a.home, 'permission toast withdrawn');
        return l.length > 0 ? l : null;
      }, 15_000);
      expect(withdrawn[0].requestId).toBe(fired[0].requestId);
    } else {
      // …and the complement is worth pinning too: nothing may claim to have
      // withdrawn a toast that was never shown.
      expect(lines(a.home, 'permission toast withdrawn')).toHaveLength(0);
    }
  });
});
