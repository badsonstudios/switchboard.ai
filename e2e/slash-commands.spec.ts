// P2-E10-07: composer slash-command autocomplete + ⋯ session controls.
// The popup data comes from the REAL scanner (this test seeds command/skill
// files into the session folder) and selection/submission go through the real
// PTY — the fake provider's shell echoes what the composer typed.
//
// TRANSPORT SCOPE (P2-E18-18, #404): the popup itself — the scanner, the
// filtering, the caret, Tab-vs-Enter, Escape — is renderer-side and
// transport-independent, so those tests are untagged. What is tagged `[pty]` is
// every test that proves DELIVERY by reading the shell's echo out of the
// Terminal tab, plus the /clear feed-reset, which rides the transcript watcher
// (off for stream, `deriveFeed` in `sessions/ipc.ts`). A Direct session submits
// over stdin and resets its feed off `system:init` instead — a different path
// with no e2e of its own (`sessions/ipc.ts`'s stream branch for
// `sessions:command`). Direct's own list-of-commands story is covered by
// `stream.spec.ts` → "slash commands come from the CLI in Direct mode
// (P2-E18-09)". See `launchApp` in `fixtures/app.ts` for the tag.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, retype, showTerminal, tempProjectFolder } from './fixtures/app';

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

/** Play the CLI's part: POST a hook event to the app's real listener. */
async function postHook(home: string, body: Record<string, unknown>): Promise<string> {
  const logFile = await poll(() => {
    const f = findFile(home, 'switchboard.log');
    return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
  });
  const port = Number(/"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1]);
  const tokenFile = await poll(() => findFile(home, 'hook-token'));
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
    body: JSON.stringify(body),
  });
  return r.text();
}

function seedProjectCommands(folder: string): void {
  fs.mkdirSync(path.join(folder, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, '.claude', 'commands', 'hello.md'),
    '---\ndescription: Say hello nicely\n---\nSay hello.\n'
  );
  fs.mkdirSync(path.join(folder, '.claude', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, '.claude', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo skill\n---\nDo the demo.\n'
  );
}

function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/:. ]/g, '-');
}

test.describe('composer slash commands (E10-07)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => {
    // The app's own log lives inside the temp home, and cleanup() deletes it.
    // The slash-command scan now SAYS when it fails open (#145) — which is no
    // use at all if the only copy is removed before anyone can read it, so a
    // failing test keeps it as an attachment (CI uploads test-results/).
    const info = test.info();
    if (a && info.status !== info.expectedStatus) {
      const f = findFile(a.home, 'switchboard.log');
      if (f) await info.attach('switchboard.log', { path: f });
    }
    await a?.cleanup();
  });

  test('[pty] / pops builtins + scanned project commands; arrows+Enter insert; submit reaches the PTY', async () => {
    const folder = tempProjectFolder();
    seedProjectCommands(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('/');
    // builtin + project command + project skill, with descriptions and badges
    await expect(w.getByText('/clear', { exact: true })).toBeVisible();
    await expect(w.getByText('/hello', { exact: true })).toBeVisible();
    await expect(w.getByText('/demo', { exact: true })).toBeVisible();
    await expect(w.getByText('Say hello nicely')).toBeVisible();

    // arrow keys move the highlight (list is clear · compact · demo · hello),
    // and Enter picks the highlighted command — it INSERTS, never submits
    await box.press('ArrowDown');
    await box.press('Enter');
    await expect(box).toHaveValue('/compact ');
    await expect(w.getByText('Say hello nicely')).toHaveCount(0); // popup closed
    // the caret lands AFTER the inserted command, so the next thing typed
    // continues the prompt rather than landing at the start of it
    await box.pressSequentially('x');
    await expect(box).toHaveValue('/compact x');
    await box.press('Backspace');

    // The popup's SECOND opening, in three steps that fail differently — the
    // whole point (#145). Asserting only "/hello is visible" after typing '/he'
    // cannot tell a popup that never opened from one that opened empty, and
    // that ambiguity is what made this spec's CI failure un-diagnosable.
    await retype(box, '/'); // keystrokes, never fill('') — see retype's note
    await expect(box).toHaveValue('/'); // 1. the input path: the keystrokes landed
    await expect(w.getByText('/clear', { exact: true })).toBeVisible(); // 2. the popup OPENED (a builtin)
    await expect(w.getByText('/hello', { exact: true })).toBeVisible(); // 3. …and the project scan landed
    await box.pressSequentially('he');
    await expect(box).toHaveValue('/he');
    // 4. and only now the actual subject: the list filters down to the match
    await expect(w.getByText('/clear', { exact: true })).toHaveCount(0);
    await expect(w.getByText('/hello', { exact: true })).toBeVisible();
    await box.press('Enter');
    await expect(box).toHaveValue('/hello ');

    // a second Enter submits to the real PTY — the shell echoes the text
    await box.press('Enter');
    await expect(box).toHaveValue('');
    await showTerminal(w);
    await expect(w.getByText(/\/hello/).first()).toBeVisible({ timeout: 15_000 });
  });

  // #163 hand-test, 2026-08-02. Dan, on the Direct-mode PR: "/usage does not
  // work, nor does /agents, /model, etc. It seems like NONE of the slash
  // commands work." The CLI was innocent — it answers every one of them with
  // renderable text over stream-json (probe `spike/s11/probe-140-slash-flags.cjs`).
  // The composer never sent them: the popup claimed Enter to CONFIRM, so typing
  // a command IN FULL and pressing Enter replaced `/hello` with `/hello ` and
  // ran nothing. The first Enter looked like a no-op because the text it
  // produced was the text already on screen.
  //
  // Not transport-specific, and tested here on the PTY for that reason — but
  // the PROOF is, so it carries the tag: "it really sent" is read off the
  // shell's echo in the Terminal tab, which a Direct session has nothing to
  // show in.
  test('[pty] a command typed IN FULL submits on the first Enter (#163)', async () => {
    const folder = tempProjectFolder();
    seedProjectCommands(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('/hello');
    // The popup is OPEN and offering the exact command we just typed — asserted
    // via its DESCRIPTION, because `/hello` matches the textarea's own value
    // too, and an ambiguous locator would let this pass with no popup at all,
    // i.e. without ever reaching the code #163 broke.
    await expect(w.getByText('Say hello nicely')).toBeVisible({ timeout: 15_000 });

    await box.press('Enter');

    // ONE Enter sent it: the composer is empty, not sitting on `/hello `
    await expect(box).toHaveValue('');
    await showTerminal(w);
    await expect(w.getByText(/\/hello/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Tab still COMPLETES a fully typed command instead of sending it', async () => {
    // the escape hatch for a command that takes arguments: Tab gives you the
    // trailing space, Enter runs it. Enter-completes-then-Enter-sends is what
    // #163 removed, and this is what replaced it.
    const folder = tempProjectFolder();
    seedProjectCommands(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('/hello');
    await expect(w.getByText('Say hello nicely')).toBeVisible({ timeout: 15_000 });

    await box.press('Tab');

    await expect(box).toHaveValue('/hello ');
  });

  test('no popup when the slash is mid-sentence; Escape dismisses', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('look in c:/');
    await expect(w.getByText('/clear', { exact: true })).toHaveCount(0);

    await retype(box, '/');
    await expect(box).toHaveValue('/');
    await expect(w.getByText('/clear', { exact: true })).toBeVisible();
    await box.press('Escape');
    await expect(w.getByText('/clear', { exact: true })).toHaveCount(0);
    await expect(box).toHaveValue('/'); // the draft survives the dismiss
  });

  test('[pty] ⋯ menu: Clear conversation confirms, then types /clear into the PTY', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    // controls are LOCKED while 'starting' (§5.10 startup-dialog rule)
    await w.getByTitle('Session menu').click();
    const clear = w.getByRole('button', { name: 'Clear conversation' });
    await expect(clear).toBeDisabled();

    // the session reports ready — play the CLI: SessionStart over real hooks.
    // The menu stays open and unlocks live on the status change.
    await postHook(a.home, { hook_event_name: 'SessionStart', source: 'startup' });
    await expect(clear).toBeEnabled({ timeout: 10_000 });
    await clear.click();
    await expect(w.getByText(/Clear this conversation\?/)).toBeVisible();
    await w.getByRole('button', { name: 'Clear', exact: true }).click();

    await showTerminal(w);
    await expect(w.getByText(/\/clear/).first()).toBeVisible({ timeout: 15_000 });
  });

  // `[pty]`: the wipe rides the transcript watcher's rebind on a new native id,
  // and a stream session's feed is not built from the transcript at all.
  //
  // THE DIRECT HALF NOW HAS ITS OWN COVER — `stream-feed.spec.ts` → "Clear
  // conversation on a Direct session". This comment used to end "…it resets off
  // `system:init`, which no e2e drives", and both halves of that went stale in
  // one day: #748 made `conversation_reset` the primary trigger (the init is
  // the backstop), and #752 taught the fake `/clear` so the path could be
  // driven at all. The gap this sentence described is exactly where #748's bug
  // lived, which is why it is now named rather than merely admitted.
  test('[pty] a /clear-minted session id wipes the Feed and shows the cleared marker', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    // play the CLI: a bound conversation with visible content…
    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'native-old', cwd: folder, timestamp: new Date().toISOString(), ...o }) + '\n';
    fs.writeFileSync(
      path.join(dir, 'native-old.jsonl'),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'OLD_CONversation_TEXT' }] } })
    );
    await expect(w.getByText('OLD_CONversation_TEXT')).toBeVisible({ timeout: 15_000 });

    // …then /clear executes: SessionStart(source:'clear') delivers a NEW id
    await postHook(a.home, { hook_event_name: 'SessionStart', source: 'clear', session_id: 'native-fresh' });

    // the old conversation is wiped and the app SAYS SO (silent /clear fix)
    await expect(w.getByText('Conversation cleared — context starts fresh')).toBeVisible({ timeout: 10_000 });
    await expect(w.getByText('OLD_CONversation_TEXT')).toHaveCount(0);
  });
});
