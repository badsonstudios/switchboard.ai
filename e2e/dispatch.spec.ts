// §5.15's Trigger 1, end to end (P2-E13-03, #948): the ⋯ menu's `Dispatch…`
// spawns a real Code Reviewer whose first turn already carries the briefing.
//
// WHAT ONLY THIS CAN SEE. The units pin the bundle builder (#947), the pending
// registry, the prompt composition, the dialog and the spawn path — each against
// stand-in collaborators. None of them can see `main/index.ts`, which is the file
// with no tests of its own and the place `registerDispatchIpc` is handed the real
// `sessionQueries`, the real workspace store and the real `defaultProviderId`. Nor
// can they see the real preload, the two real broker channels, a real git diff, or
// a briefing actually arriving as another session's first user turn. That gap is
// #763's worst finding — "the units can be tested while the wiring is not" — and
// this is the same answer `context-drop.spec.ts` gives.
//
// THE REPO FIXTURE IS LOAD-BEARING, not scenery. A clean-room bundle is built from
// `get_session_diff`'s own answer (#764), so without an uncommitted change the
// document would say "the working tree is clean" and the spec would prove only that
// a card appeared. The assertion below reads the DIFF's own content out of the
// dispatched session's first turn, which is the whole round trip in one string.
//
// Direct transport, the fake stream CLI: a dispatched session's briefing goes in
// through `SessionManager.submitPrompt`, which needs a typed-message transport —
// main refuses a dispatch on a PTY rather than starting one it cannot brief.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, pollAsync, registerTempDir, sessionStatuses } from './fixtures/app';

/** The file the fixture edits, and the two versions of it. */
const FILE = 'total.js';
const COMMITTED = 'export function total(items) {\n  return items.length;\n}\n';
/** The uncommitted change under review — the marker the briefing must carry. */
const MARKER = 'BROKEN_TOTAL_MARKER';
const WORKING = `export function total(items) {\n  // ${MARKER}\n  return items.length - 1;\n}\n`;

/**
 * A throwaway git repo with one committed file and an uncommitted edit to it.
 *
 * Local to this spec, like `diff.spec.ts`'s: the content and the assertions are
 * one thought. Registered on the line it is created rather than by the caller once
 * it is built (#180 — specs leaking temp dirs): registering after the `git` calls
 * would leak the folder on any machine where they fail.
 */
function tempGitProject(): string {
  const dir = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-dispatch-')));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };
  git(['init', '-b', 'main']);
  // Local identity: a CI runner with no global `user.email` cannot commit at all,
  // and the commit is what makes the working-tree edit a DIFF rather than a new file.
  git(['config', 'user.email', 'e2e@switchboard.test']);
  git(['config', 'user.name', 'switchboard e2e']);
  fs.writeFileSync(path.join(dir, FILE), COMMITTED);
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  fs.writeFileSync(path.join(dir, FILE), WORKING);
  return dir;
}

test.describe.configure({ mode: 'serial' });

test.describe('dispatching a Code Reviewer (#948, §5.15)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.cleanup();
  });

  const dialog = (w: Page) => w.locator('[data-testid="dispatch-dialog"]');

  /** every live session the app knows, as the renderer sees them */
  async function liveSessions(w: Page): Promise<Array<{ id: string; title: string }>> {
    return await w.evaluate(async () => {
      const rows = (await window.switchboard.sessions.list()) as Array<{
        id: string;
        identity: { title: string; accentColor?: string };
      }>;
      return rows.map((r) => ({ id: r.id, title: r.identity.title }));
    });
  }

  test('spawns a peer whose first turn carries the diff, the task and the role', async () => {
    test.setTimeout(240_000);
    const folder = tempGitProject();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    const project = path.basename(folder);

    await expect(w.getByText(project).first()).toBeVisible({ timeout: 25_000 });
    // LIVE, not merely present: a dispatch is resolved by LIVE session id, and an
    // unstarted card has none — the ⋯ row is absent for exactly that reason.
    await pollAsync(async () => {
      const s = await sessionStatuses(a);
      return s.size >= 1 && [...s.values()].every((v) => v !== 'suspended');
    }, 'the author session never came up live — a dispatch is resolved by LIVE id', 60_000);

    const before = await liveSessions(w);
    expect(before).toHaveLength(1);

    // ── the gesture: ⋯ → Dispatch… ─────────────────────────────────────────
    // By its title, like `slash-commands.spec.ts` — the ⋯ button's accessible name
    // is the one stable handle on it.
    await w.getByTitle('Session menu').click();
    const row = w.getByTestId('card-menu').getByTestId('card-dispatch');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();

    // ── the dialog: the three built-ins, Code Reviewer preselected ─────────
    await expect(dialog(w)).toBeVisible({ timeout: 20_000 });
    for (const id of ['builtin:code-reviewer', 'builtin:doc-writer', 'builtin:pr-author']) {
      await expect(w.locator(`[data-dispatch-template="${id}"]`)).toBeVisible();
    }
    // #946 put the built-ins first and Code Reviewer first among them, and that
    // order is the default a user should not have to choose.
    expect(
      await w.locator('[data-dispatch-template="builtin:code-reviewer"]').getAttribute('data-selected')
    ).toBe('yes');

    // THE TASK LINE — the reason this dialog exists (#947's measurement: a session
    // started from a slash command reports its task as `"do it."`). Typed here, and
    // asserted below inside the briefing that actually reached the reviewer.
    const TASK = 'Rewrite total() as an index loop over items.';
    const CRITERIA = 'Every item is counted, including the last one.';
    await w.locator('[data-testid="dispatch-task"]').fill(TASK);
    await w.locator('[data-testid="dispatch-criteria"]').fill(CRITERIA);
    await w.locator('[data-testid="dispatch-go"]').click();
    await expect(dialog(w)).toBeHidden({ timeout: 20_000 });

    // ── A SECOND, LIVE SESSION: a full peer, not a subagent (§5.15) ────────
    await pollAsync(
      async () => (await liveSessions(w)).length >= 2,
      'the dispatch never produced a second live session',
      90_000
    );
    const after = await liveSessions(w);
    const reviewer = after.find((s) => !before.some((b) => b.id === s.id));
    expect(reviewer, 'a dispatched session must be its own session').toBeTruthy();
    // Named for its ROLE, so it is visibly not the author — the done-when's phrase.
    // Not simply "different from the author's title": a basename-titled second card
    // in the same folder would pass that and be indistinguishable on screen.
    expect(reviewer!.title).toContain('Code Reviewer');

    // ── THE BRIEFING IS ITS FIRST TURN, not a message awaiting a keypress ──
    //
    // SCOPED TO THE DISPATCHED CARD'S OWN PANEL. `[data-feed-block]` is
    // document-wide and two cards can render feeds side by side, so a bare
    // `.first()` would work today only because the author happens to have no user
    // turns — and would silently start asserting against the wrong feed the moment
    // a future version of this spec typed into the author first.
    // The handle is the feed region's own `aria-label`, which carries the session's
    // title (`feedView.regionLabelNamed`) — the same hook `feed-restore-position`
    // uses to tell two cards' feeds apart.
    const reviewerFeed = w.locator(
      '[data-feed-region][aria-label*="Code Reviewer"] [data-feed-block="user"]'
    );
    await pollAsync(
      async () => (await reviewerFeed.count()) >= 1,
      'the dispatched session never received a first turn',
      60_000
    );
    const first = reviewerFeed.first();
    // A briefing is thousands of characters, so the feed collapses the turn and the
    // body is not in the DOM until it is opened — `context-drop.spec.ts` learned
    // this by asserting against `▸…click to expand`.
    const expander = first.locator('[data-feed-expander]').first();
    if ((await expander.count()) > 0) await expander.click();
    else await first.click();

    const text = (await first.innerText()).replace(/\s+/g, ' ');
    // 1. It knows it is clean-room, which is the honesty rule stated to the reader
    //    that acts on it (#947's preamble).
    expect(text).toContain('clean-room');
    // 2. THE REAL DIFF, from the real repo, through the real git service. This is
    //    the assertion that would fail if the bundle were built from an empty
    //    package, a second git call, or nothing at all.
    expect(text).toContain(MARKER);
    // 3. THE TASK THE USER TYPED — not the transcript's opening prompt. The
    //    override's whole justification.
    expect(text).toContain(TASK);
    // 4. …and the criteria, which no transcript could have supplied.
    expect(text).toContain(CRITERIA);
    // 5. The ROLE, under its own heading, after the document — the order that keeps
    //    an unclosed fence in a template from swallowing the briefing.
    expect(text).toContain('Your instructions');
    expect(text).toContain('You are reviewing a change you did not write');
  });
});
