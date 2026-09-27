// P2-E10-04: inline approval bar — the full loop against the REAL hook
// listener: the test plays the CLI's part (PreToolUse POST with the real
// per-session token), the UI answers, the verdict comes back in the hook
// response. No mocks between the bar and the wire.
//
// TRANSPORT SCOPE — HISTORICAL (P2-E18-18, #404; retagged by #952, which
// left one transport, so a `[pty]` tag names nothing). The note below is the
// reasoning as it stood, kept because it says what each test actually drives:
// // TRANSPORT SCOPE (P2-E18-18, #404): `[pty]` for the whole group. The loop
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
  launchApp,
  LaunchedApp,
  permissionHolderEdit,
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

test.describe('inline approval bar (E10-04)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a held Edit shows the new text, then Allow and Allow-all answer it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // A REAL `can_use_tool` request carrying an Edit's old/new pair (#952).
    //
    // The verdict used to be read out of the hook RESPONSE BODY, which is why
    // this file used to resolve a port and a token out of the app's own log. There
    // is no hook response to read: the answer goes back over the control channel.
    // So the claim is asserted where the user experiences it — the bar appears
    // with the new text in it, answering makes it go, and Allow-all stops the next
    // one appearing at all.
    const hold = permissionHolderEdit(a);

    // 1. held request -> bar appears with the edit preview -> Allow
    await hold(title, 'one');
    await expect(w.getByText('Allow Edit?')).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('new-one')).toBeVisible(); // new_string pane
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(w.getByText('Allow Edit?')).toHaveCount(0);

    // 2. next request -> "Allow all (this session)"
    await hold(title, 'two');
    await expect(w.getByText('Allow Edit?')).toBeVisible({ timeout: 15_000 });
    await w.getByRole('button', { name: 'Allow all (this session)' }).click();
    await expect(w.getByText('Allow Edit?')).toHaveCount(0);

    // 3. a third request auto-allows WITHOUT the bar ever appearing. Given time
    // to be wrong: an assertion that something does not appear is worth only the
    // wait it gives it.
    await hold(title, 'three');
    await w.waitForTimeout(3_000);
    await expect(w.getByText('Allow Edit?')).toHaveCount(0);
  });

  // ── "DAN'S CASE: A POWERSHELL DIR-LISTING HOLDS" — RETIRED (#952) ────────
  //
  // This one is worth more than a pointer, because what it guarded is genuinely
  // gone rather than moved.
  //
  // It pinned that the WINDOWS SHELL TOOL held — the exact case that slipped in
  // the 2026-07-22 probe — and that the bar appeared in the Session tab with no
  // handoff bar beside it. What made `PowerShell` hold was switchboard's OWN hold
  // policy (`GATED`, in the old hook listener), which listed the shell tools per
  // autonomy. That table is deleted: Claude Code decides what to ask about now,
  // so there is no list of ours for a tool name to slip out of.
  //
  // The general claim underneath — a delegated permission draws a bar in the
  // Session tab, and nothing sends the user to a terminal — is asserted by the
  // test above and by `stream-permissions.spec.ts`.

  // ── "RAPID HOLDS QUEUE" — MOVED, NOT LOST (#952) ─────────────────────────
  //
  // Pinned on the real transport by `stream-approval.spec.ts` → "concurrent holds
  // queue on the card, and the Session tab surfaces itself", which passes.

  // ── "DENY RETURNS A DENY VERDICT" — MOVED, NOT LOST (#952) ───────────────
  //
  // Pinned on the real transport by `stream-approval.spec.ts` → "Deny reaches the
  // CLI and the tool never runs", which passes and is the stronger assertion: it
  // checks the tool did not run, not merely that a verdict came back.

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

  // ── "A CRASHED RENDERER RELEASES THE HOLD" — MOVED, NOT LOST (#952) ───────
  //
  // Its claim — a renderer that dies must not leave the CLI parked — is pinned on
  // the real transport by `stream-approval.spec.ts` → "a CRASHED renderer
  // releases a Direct hold instead of parking the CLI", which passes. This copy
  // drove the hook hold path, which no longer exists.

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
  // ── "A PERMISSION THE CLI KEPT GETS A FULL BAR (#125)" — REMOVED (#952) ────
  //
  // It drove a permission `Notification` and asserted the terminal-handoff bar:
  // a decision the CLI KEPT for itself, announced where the user was already
  // looking, after a 10px header chip nobody ever saw.
  //
  // Both halves are gone. There is no transport on which the CLI can keep a
  // permission decision — it delegates every one over `can_use_tool` — and the
  // handoff bar was deleted with the terminal it routed to. The inverse this test
  // was read against is still pinned, in `stream-permissions.spec.ts` → "a hook
  // Notification cannot fake a permission on Direct (#313)".
  //
  // ⚠️ The QUESTION it answered is still open, and #952 did not close it: what
  // should be said when the CLI keeps a decision? Today it cannot. E18-11 owns
  // the answer if that ever changes.
});
