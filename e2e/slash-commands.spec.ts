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
import { launchApp, LaunchedApp, retype, tempProjectFolder } from './fixtures/app';

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

  // Retagged by #952: the tag marked how the SUBMIT at the end was delivered,
  // and there is one delivery route now. Everything above it — the popup, the
  // scan, the arrow keys, the insert-not-submit rule — was never transport-bound.
  test('/ pops builtins + scanned project commands; arrows+Enter insert; submit sends', async () => {
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

    // a second Enter submits. That it REACHED the CLI used to be read off the
    // shell's echo in the Terminal tab; with no terminal surface (#873) the
    // composer emptying is what is left, which proves the submit happened but
    // not that anything received it.
    await box.press('Enter');
    await expect(box).toHaveValue('');
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
  // Not transport-specific, and no longer tagged: the tag existed only because
  // the PROOF was — "it really sent" was read off the shell's echo in the
  // Terminal tab. That surface is gone (#873), and the load-bearing assertion
  // never needed it: an empty composer rather than one sitting on `/hello ` is
  // exactly the difference #163 broke, and it is transport-independent.
  test('a command typed IN FULL submits on the first Enter (#163)', async () => {
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

  // ⚠️ THE 'starting' LOCK WAS ASSERTED HERE AND IS NOT ANY MORE (#952). Said out
  // loud rather than quietly dropped, because the rule itself is untouched.
  //
  // `sessionControlLock` still returns `'starting'` for a starting session and
  // both surfaces still obey it (§5.10's startup-dialog rule: the CLI may be in a
  // TUI dialog the composer cannot see, so a write now lands in the wrong place).
  // What changed is that the state is no longer REACHABLE from a test. A PTY
  // session sat in `starting` until a `SessionStart` hook arrived, which is why
  // this test posted one; a Direct session is `idle` the moment its transport is
  // up, and there is no knob to hold it open. Asserting `toBeDisabled()` in that
  // window would be a race, and a race is worse than no test.
  //
  // The rule is owned by unit tests, on both arms and in both surfaces:
  // `lib/session-controls.test.ts` (the rule, including `'done'` NOT locking) and
  // `components/FeedView.session-controls.test.tsx` → "a starting session has both
  // buttons disabled, and says why in the name". What is left here is the part
  // that needs a real app: the ⋯ route reaching the real session.
  test('⋯ menu: Clear conversation confirms before it sends', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    await w.getByTitle('Session menu').click();
    // scoped to the menu: since #903 the composer's own row carries a button
    // with the same accessible name, and it is the same action by design
    const clear = w.getByTestId('card-menu').getByRole('button', { name: 'Clear conversation' });
    await expect(clear).toBeEnabled({ timeout: 15_000 });
    await clear.click();
    await expect(w.getByText(/Clear this conversation\?/)).toBeVisible();
    // scoped for the same reason the locator above is: the row's controls sit
    // a few pixels below this menu and answer to similar names (#903)
    await w.getByTestId('card-menu').getByRole('button', { name: 'Clear', exact: true }).click();

    // That the confirm went on to type `/clear` into the PTY was read off the
    // Terminal tab's scrollback, and that surface is gone (#873). The Direct
    // half of this claim is covered end to end by `stream-feed.spec.ts` →
    // "wipes the conversation, and the next turn survives".
    await expect(w.getByText(/Clear this conversation\?/)).toHaveCount(0);
  });

  // ⚠️ A SECOND CLEAR TEST STOOD HERE AND IS DELETED, NOT MOVED (#952).
  //
  // "a /clear-minted session id wipes the Feed and shows the cleared marker" was
  // tagged `[pty]` and earned it: the wipe it drove rode the transcript watcher
  // rebinding onto a new native id, and it proved the wipe by seeding a JSONL and
  // watching the text vanish. Neither half exists for a real session — the Feed
  // is built from typed messages, and `conversation_reset` on the stream has been
  // the primary trigger since #748.
  //
  // Its claim is not lost, and was already double-covered before this deletion:
  // `stream-feed.spec.ts` → "Clear conversation on a Direct session" asserts the
  // same cleared marker and the same disappearance, plus the resumed-card case
  // that was #748's actual bug — which this test could never have caught.
});
