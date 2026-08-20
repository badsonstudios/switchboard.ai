// P2-E10-04: inline approval bar — the full loop against the REAL hook
// listener: the test plays the CLI's part (PreToolUse POST with the real
// per-session token), the UI answers, the verdict comes back in the hook
// response. No mocks between the bar and the wire.
//
// TRANSPORT SCOPE (P2-E18-18, #404): `[pty]` for the whole group. The loop
// these tests drive is the HOOK-HOLD path, and a Direct session bypasses it
// outright — `hook-listener.ts` passes `PreToolUse` straight through for a
// stream session, because on that transport a permission arrives as a
// `can_use_tool` on the control channel instead. So none of this is coverage of
// the app's default transport, however green it is. See `launchApp` in
// `fixtures/app.ts` for the tag.
//
// The Direct counterpart is `stream-approval.spec.ts` (P2-E18-14), which ports
// Deny, queueing, cross-session grouping and the crashed-renderer release. The
// #125 test at the bottom of this file is the one behaviour whose Direct truth
// is the OPPOSITE, not a port — see the note above it.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  hookPoster,
  launchApp,
  LaunchedApp,
  tempProjectFolder,
  openEventsDrawer,
} from './fixtures/app';

function findFile(root: string, name: string, depth = 6): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) {
      const hit = findFile(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function poll<T>(fn: () => T | null, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('poll timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The hook listener's answer to a PreToolUse POST, as `hook-listener.ts` writes
 * it. `hookSpecificOutput` is absent when the request was NOT held — which is
 * itself something a test below asserts, so it is optional here.
 */
interface HookResponse {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason: string;
  };
}

/** `JSON.parse` hands back `any`; this is where that stops for this file. */
function parseVerdict(body: string): HookResponse {
  return JSON.parse(body) as HookResponse;
}

test.describe('[pty] inline approval bar (E10-04)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('held Edit -> Allow / Allow-all round-trips real hook verdicts', async () => {
    const folder = tempProjectFolder();
    const title = folder.split(/[\\/]/).pop()!;
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // the CLI's view of the world: listener port from the app log, the
    // per-session token from the state dir (both created by the real spawn)
    const logFile = await poll(() => {
      const f = findFile(a.home, 'switchboard.log');
      return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
    });
    const port = Number(/"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1]);
    const tokenFile = await poll(() => findFile(a.home, 'hook-token'));
    const token = fs.readFileSync(tokenFile, 'utf8').trim();

    const preToolUse = (marker: string) =>
      fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
        body: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: 'C:/proj/x.ts', old_string: `old-${marker}`, new_string: `new-${marker}` },
        }),
      }).then((r) => r.text());

    // 1. held request -> bar appears with the edit preview -> Allow
    const p1 = preToolUse('one');
    await expect(w.getByText('Allow Edit?')).toBeVisible({ timeout: 10_000 });
    await expect(w.getByText('new-one')).toBeVisible(); // new_string pane
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(parseVerdict(await p1).hookSpecificOutput!.permissionDecision).toBe('allow');
    await expect(w.getByText('Allow Edit?')).toHaveCount(0);

    // 2. next request -> "Allow all (this session)"
    const p2 = preToolUse('two');
    await expect(w.getByText('Allow Edit?')).toBeVisible({ timeout: 10_000 });
    await w.getByRole('button', { name: 'Allow all (this session)' }).click();
    expect(parseVerdict(await p2).hookSpecificOutput!.permissionDecision).toBe('allow');

    // 3. third request auto-allows WITHOUT the bar ever appearing
    const p3 = preToolUse('three');
    expect(parseVerdict(await p3).hookSpecificOutput!.permissionDecision).toBe('allow');
    await expect(w.getByText('Allow Edit?')).toHaveCount(0);
  });

  test("Dan's case: a PowerShell dir-listing holds and the bar appears in the Session tab", async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });
    const logFile = await poll(() => {
      const f = findFile(a.home, 'switchboard.log');
      return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
    });
    const port = Number(/"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1]);
    const tokenFile = await poll(() => findFile(a.home, 'hook-token'));
    const token = fs.readFileSync(tokenFile, 'utf8').trim();

    // the Windows shell tool (2026-07-22 probe) — the exact case that slipped
    const pending = fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'PowerShell',
        tool_input: { command: 'Get-ChildItem C:/Users/dan/Downloads', description: 'List Downloads' },
      }),
    }).then((r) => r.text());
    // the bar shows IN THE SESSION TAB — and the "answer it in the Terminal"
    // handoff must NOT appear beside it (#125): this decision was delegated to
    // us, so sending the user to the terminal would push them away from the
    // very control that answers it
    await expect(w.getByText('Allow PowerShell?')).toBeVisible({ timeout: 10_000 });
    await expect(w.locator('[data-handoff]')).toHaveCount(0);
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(parseVerdict(await pending).hookSpecificOutput!.permissionDecision).toBe('allow');
  });

  test('a hold surfaces the Session tab from Terminal, and rapid holds QUEUE (P0#4/#5)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });
    const logFile = await poll(() => {
      const f = findFile(a.home, 'switchboard.log');
      return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
    });
    const port = Number(/"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1]);
    const tokenFile = await poll(() => findFile(a.home, 'hook-token'));
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const hold = (file: string) =>
      fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
        body: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
        }),
      }).then((r) => r.text());

    // park the card on the TERMINAL tab, then hold twice in quick succession
    await w.getByRole('tab', { name: 'Terminal' }).click();
    const p1 = hold('C:/one.ts');
    const p2 = hold('C:/two.ts');
    // the Session tab auto-surfaces with the bar + queue badge
    await expect(w.getByText('Allow Edit?')).toBeVisible({ timeout: 10_000 });
    await expect(w.getByText('+1 more waiting')).toBeVisible();
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(parseVerdict(await p1).hookSpecificOutput!.permissionDecision).toBe('allow');
    // the second request advances into the bar
    await expect(w.getByText('C:/two.ts')).toBeVisible({ timeout: 10_000 });
    await w.getByRole('button', { name: 'Deny' }).click();
    expect(parseVerdict(await p2).hookSpecificOutput!.permissionDecision).toBe('deny');
    await expect(w.getByText('Allow Edit?')).toHaveCount(0);
  });

  test('Deny returns a deny verdict', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });
    const logFile = await poll(() => {
      const f = findFile(a.home, 'switchboard.log');
      return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
    });
    const port = Number(/"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1]);
    const tokenFile = await poll(() => findFile(a.home, 'hook-token'));
    const token = fs.readFileSync(tokenFile, 'utf8').trim();

    const pending = fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      }),
    }).then((r) => r.text());
    await expect(w.getByText('Allow Bash?')).toBeVisible({ timeout: 10_000 });
    await expect(w.getByText('rm -rf /').first()).toBeVisible(); // command preview
    await w.getByRole('button', { name: 'Deny' }).click();
    expect(parseVerdict(await pending).hookSpecificOutput!.permissionDecision).toBe('deny');
  });

  test('an interactive question flips the card to needs-input, not working (#92)', async () => {
    // Probed against real claude 2.1.220: an AskUserQuestion blocks MID-TURN,
    // so no Stop ever fires and the card used to sit on 'working' while the
    // CLI waited for a person (Dan: "nothing seemed to have happened").
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    const logFile = await poll(() => {
      const f = findFile(a.home, 'switchboard.log');
      return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
    });
    const port = Number(/"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1]);
    const tokenFile = await poll(() => findFile(a.home, 'hook-token'));
    const token = fs.readFileSync(tokenFile, 'utf8').trim();

    const hook = (body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
        body: JSON.stringify(body),
      }).then((r) => r.text());

    // the CLI's real payload for the picker
    const verdict = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which directory?', header: 'Directory' }] },
    });
    // it must NOT be held — the answer lives in the CLI's own TUI, so parking
    // it behind our approval bar would leave nothing to click
    expect(parseVerdict(verdict).hookSpecificOutput, 'the question was HELD').toBeUndefined();
    await expect(w.getByText('Allow AskUserQuestion?')).toHaveCount(0);

    // the shipped machinery does the rest: an Events entry saying it needs you.
    // The drawer holding that entry is collapsed by default (P2-E14-01), so it
    // is opened here — the row below is the whole point of the assertion, and
    // it does not exist in the DOM until it is.
    await openEventsDrawer(w);
    await expect(w.locator('aside').getByText('needs input')).toBeVisible({ timeout: 15_000 });

    // and answering it lets the turn resume
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' });
    await expect(w.locator('aside').getByText('needs input')).toHaveCount(0, { timeout: 15_000 });
  });

  test('a CRASHED renderer releases the hold instead of parking the CLI (P2-E15-09)', async () => {
    // Linux/xvfb can't host this scenario. Crashing the renderer there takes
    // the WINDOW with it, so `window-all-closed` fires and (non-darwin) quits
    // the whole app — the hook server dies mid-request and the POST comes back
    // `SocketError: other side closed` instead of a verdict. On Windows the
    // window provably survives the crash (probe: "windows still open: 1"),
    // which is the state this test exists to cover. The guarantee still holds
    // on Linux by a different route: app exit tears the listener down, and the
    // forwarder fails open when it can't reach us (S-03).
    test.skip(process.platform === 'linux', 'a renderer crash kills the whole app under xvfb; covered on Windows');
    // The defect this pins: the "nobody to ask" check tested permListeners.size,
    // which is never zero (ipc.ts subscribes once and never unsubscribes). So a
    // dead renderer left the CLI parked the full 300s per gated call.
    //
    // This is the one path a human cannot reasonably test on Windows — closing
    // the window quits the app there, so only a crash reaches it. Hence a test.
    const folder = tempProjectFolder();
    const title = folder.split(/[\\/]/).pop()!;
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    const post = await hookPoster(a);

    // park a real hold: the request is live on the wire, waiting for a click
    const held = post(title, {
      hook_event_name: 'PreToolUse',
      tool_name: 'PowerShell',
      tool_input: { command: 'Get-ChildItem', description: 'List' },
    });
    await expect(w.getByText('Allow PowerShell?')).toBeVisible({ timeout: 15_000 });

    // now kill the renderer. The BrowserWindow survives with dead contents —
    // which is exactly why isDestroyed() alone was not enough of a signal.
    await a.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });

    // no opinion, immediately: the CLI falls back to its own TUI prompt. Before
    // this fix the same await sat here for the full hold timeout.
    expect(await held, 'the hold outlived the renderer').toBe('{}');
  });

  // #125 — the case that started this: a decision the CLI KEPT. Dan hit it live
  // on 2026-07-31 (a `.claude\scripts\coverage.sh` write). No PreToolUse ever
  // reaches us, so there is no hold and no approval bar; the only signal is the
  // CLI's own debounced Notification. The Session tab used to answer that with
  // a 10px chip in the top-left header strip while the user stared at the
  // bottom, where every permission they had ever answered appeared.
  //
  // THE GROUP'S `[pty]` IS AT ITS SHARPEST HERE. Everywhere else in this file
  // it means "Direct takes a different route to the same place"; here it means
  // the Direct behaviour is the exact OPPOSITE of what this test pins. The
  // same `Notification` is deliberately DROPPED for a stream session (#313,
  // `hook-listener.ts`) — with permissions riding `can_use_tool`, a debounced
  // nudge with nothing held is a false alarm, and there is no terminal to send
  // anyone to. That inverse is pinned by
  // `stream-permissions.spec.ts` → "a hook Notification cannot fake a permission
  // on Direct (#313)". Read the two
  // together or each looks like a bug in the other.
  test('a permission the CLI KEPT gets a full bar in the Session tab, not a chip (#125)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    const post = await hookPoster(a);
    // Exactly what the CLI sent in the live incident: not a PreToolUse we can
    // hold, just a nudge that it is waiting on a human.
    await post(title, {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Write',
    });

    const bar = w.locator('[data-handoff="permission"]');
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await expect(bar.getByText('Claude is asking permission in the terminal')).toBeVisible();
    // it explains WHY we cannot answer, rather than just pointing elsewhere
    await expect(bar.getByText(/rather than offering it to switchboard/)).toBeVisible();

    // Docked at the BOTTOM, directly above the composer — the entire point of
    // #125. Asserted against the composer, which always exists: an earlier
    // version compared against the feed scroller behind a `.catch(() => null)`,
    // so on any run where a block had arrived the check silently evaporated.
    const barBox = (await bar.boundingBox())!;
    const composerBox = (await w.locator('textarea').first().boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(composerBox.y + 2);
    // in the bottom half of the window, i.e. emphatically not the header strip
    // it used to live in. `viewportSize()` is null for an Electron window, so
    // ask the page for its real height.
    const winHeight = await w.evaluate(() => window.innerHeight);
    expect(barBox.y).toBeGreaterThan(winHeight / 2);

    // one click reaches the real prompt
    await bar.getByRole('button', { name: 'Open Terminal' }).click();
    await expect(w.locator('.xterm')).toBeVisible({ timeout: 10_000 });
  });
});
