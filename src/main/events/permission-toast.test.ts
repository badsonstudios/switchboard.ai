// P2-E14-04 — the routing behind an Allow/Deny toast.
//
// What only a unit test can cover: the button press itself. No harness can
// click a real OS notification, so the contract between "the OS said index 1"
// and "the CLI was told deny" is pinned here, and the e2e
// (`e2e/permission-toast.spec.ts`) proves the toast that carries those buttons
// is really built and really withdrawn.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Logger } from '../log/logger';
import type { PermissionRequest } from '../../shared/ipc/permissions';
import {
  answerableFromToast,
  DECIDE_BUTTONS,
  decideButtonActions,
  PermissionToasts,
  permissionSummary,
  toastActionsSupported,
} from './permission-toast';
import { createMainI18n } from '../i18n';
import type { LanguageChoice, Translate } from '../../shared/i18n';
import { pseudolocalize } from '../../shared/i18n/pseudo';

// THE REAL TRANSLATOR, not a fake (#471).
//
// `permissionSummary` composes the one sentence in this app that stands between
// a user and an **Allow** button, and since #471 it composes it out of catalog
// keys. A stub `t` would assert that the code asked for `approval.title` and
// prove nothing about whether that key exists, parses as ICU, or interpolates
// `{tool}` — which is the whole class of defect #207 shipped. So these tests run
// the process's own i18next, against the shipped `en.json`, through ICU.
//
// `lang` is a mutable module variable and `language` is a thunk over it, which
// is exactly how `main/index.ts` wires it: that is what lets the locale-switch
// block below flip languages between two calls with nothing to re-initialise.
let lang: LanguageChoice = 'en';
let t: Translate;
beforeAll(async () => {
  t = (await createMainI18n({ language: () => lang })).t;
});
// English unless a test says otherwise, so a locale left behind by one block
// cannot silently decide another one's assertions.
beforeEach(() => {
  lang = 'en';
});

/**
 * A real `Logger` whose four levels are spies, so the assertions below can read
 * `l.warn.mock.calls` while `PermissionToasts` receives the type it actually
 * declares — which is the point: the `as any` this replaced was suppressing the
 * argument check on every `toHaveBeenCalledWith` below, and those are now
 * checked against `Parameters<Logger['warn']>`.
 *
 * `child` is required by `Logger` and nothing in `permission-toast.ts` calls
 * it; returning the same object means a future chained logger would still
 * record into these spies rather than into a second, unwatched one.
 */
type MockLogger = Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

function log(): MockLogger {
  const l: MockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => l,
  };
  return l;
}

/**
 * vitest's asymmetric matchers are declared `any`. Same matcher, typed
 * `unknown`, so that `any` does not spread into the matcher around it —
 * identical object, identical matching, only the static type differs.
 */
const stringContaining = (str: string): unknown => expect.stringContaining(str);

/** a toast that records whether it was closed, standing in for `Notification` */
function fakeToast(): { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() };
}

function harness(decide = vi.fn().mockReturnValue(true)) {
  const l = log();
  const reveal = vi.fn();
  const toasts = new PermissionToasts({ decide, reveal, log: l });
  return { toasts, decide, reveal, l };
}

describe('PermissionToasts — the button routing (P2-E14-04)', () => {
  it('button 0 allows and button 1 denies, on the app one decision path', () => {
    const { toasts, decide } = harness();
    toasts.press('req-a', 0);
    toasts.press('req-b', 1);
    expect(decide.mock.calls).toEqual([
      ['req-a', 'allow'],
      ['req-b', 'deny'],
    ]);
  });

  it('the labels and the indices come from ONE array, so they cannot drift', () => {
    // The whole failure this pins: reorder the buttons on the notification and
    // forget the routing, and Allow sends deny. There is exactly one source.
    expect(DECIDE_BUTTONS).toEqual(['allow', 'deny']);
    // …and every button has a label, in the SAME order, so a third one cannot
    // ship blank and a reorder cannot label Allow "Deny".
    expect(decideButtonActions(t)).toEqual([
      { type: 'button', text: 'Allow' },
      { type: 'button', text: 'Deny' },
    ]);
  });

  it('an index this build never attached decides NOTHING', () => {
    const { toasts, decide, l } = harness();
    expect(toasts.press('req', 2)).toBe(false);
    expect(toasts.press('req', -1)).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalledTimes(2);
  });

  it('deciding withdraws the toast it came from', () => {
    const { toasts } = harness();
    const t = fakeToast();
    toasts.track('req', t);
    toasts.press('req', 0);
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(toasts.size).toBe(0);
  });

  it('a decision made ANYWHERE ELSE withdraws the toast (bar / Events / band)', () => {
    const { toasts, decide } = harness();
    const t = fakeToast();
    toasts.track('req', t);
    // this is what `onPermissionResolved` calls — no verdict of our own
    toasts.withdraw('req');
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
    // and it is idempotent: both routers fire, and teardown may fire again
    toasts.withdraw('req');
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it('a toast for a DEAD session decides nothing and logs instead of throwing', () => {
    // `decide` answers false when no router holds the request any more — a
    // session that exited, or a verdict that already landed elsewhere.
    const { toasts, l } = harness(vi.fn().mockReturnValue(false));
    const t = fakeToast();
    toasts.track('req', t);
    expect(() => toasts.press('req', 0)).not.toThrow();
    expect(toasts.press('req', 0)).toBe(false);
    expect(l.warn).toHaveBeenCalledWith(
      'a permission toast answered a request nobody is holding',
      expect.objectContaining({ requestId: 'req', decision: 'allow' })
    );
    // and it never claims a verdict landed — the withdrawal line is the only
    // `info` here, because the toast really did come down
    expect(l.info).not.toHaveBeenCalledWith(
      'permission decided from an OS toast',
      expect.anything()
    );
    expect(t.close).toHaveBeenCalled(); // the stale toast still goes away
  });

  it('a decide that THROWS is contained — an OS callback may not crash main', () => {
    const { toasts, l } = harness(
      vi.fn().mockImplementation(() => {
        throw new Error('router exploded');
      })
    );
    expect(() => toasts.press('req', 1)).not.toThrow();
    expect(l.warn).toHaveBeenCalledWith(
      'a permission toast decision threw',
      expect.objectContaining({ error: stringContaining('router exploded') })
    );
  });

  it('a close() that throws does not cost the caller mid-decision', () => {
    const { toasts } = harness();
    toasts.track('req', {
      close: () => {
        throw new Error('already retired');
      },
    });
    expect(() => toasts.withdraw('req')).not.toThrow();
    expect(toasts.size).toBe(0);
  });
});

describe('PermissionToasts — the click path', () => {
  it('a click REVEALS the card and never decides', () => {
    const { toasts, decide, reveal } = harness();
    const t = fakeToast();
    toasts.track('req', t);
    toasts.activate('req', 'card-7');
    expect(reveal).toHaveBeenCalledWith('card-7');
    // A click is how you dismiss a notification by reflex. Reflex must not be
    // able to grant a tool call.
    expect(decide).not.toHaveBeenCalled();
    expect(t.close).toHaveBeenCalled();
  });

  it('a reveal that throws is contained', () => {
    const l = log();
    const toasts = new PermissionToasts({
      decide: () => true,
      reveal: () => {
        throw new Error('window died');
      },
      log: l,
    });
    expect(() => toasts.activate('req', null)).not.toThrow();
    expect(l.warn).toHaveBeenCalledWith(
      'raising the window from a permission toast failed',
      expect.objectContaining({ requestId: 'req' })
    );
  });

  it('a second toast for the same request replaces the first', () => {
    const { toasts } = harness();
    const first = fakeToast();
    const second = fakeToast();
    toasts.track('req', first);
    toasts.track('req', second);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(toasts.size).toBe(1);
    toasts.withdraw('req');
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('a toast is tracked until its REQUEST resolves, not until the OS closes it', () => {
    // Electron's docs: a Windows toast that times out emits `close` and then
    // lives on in the Action Center, where `close()` still removes it. So there
    // is no "the OS closed it, stop caring" path — the tracking is keyed to the
    // permission, and a verdict given at the bar long afterwards still reaches
    // the Action Center copy.
    const { toasts } = harness();
    const t = fakeToast();
    toasts.track('req', t);
    expect(toasts.size).toBe(1);
    toasts.withdraw('req');
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(toasts.size).toBe(0);
  });

  it('withdrawAll takes every toast down (app quit)', () => {
    const { toasts } = harness();
    const a = fakeToast();
    const b = fakeToast();
    toasts.track('a', a);
    toasts.track('b', b);
    toasts.withdrawAll();
    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
    expect(toasts.size).toBe(0);
  });
});

describe('toastActionsSupported — read off Electron 43 docs, not folklore', () => {
  it('macOS and Windows can carry buttons; Linux cannot', () => {
    expect(toastActionsSupported('darwin')).toBe(true);
    expect(toastActionsSupported('win32')).toBe(true);
    expect(toastActionsSupported('linux')).toBe(false);
    expect(toastActionsSupported('freebsd')).toBe(false);
  });
});

describe('permissionSummary — a toast that names what Allow would allow', () => {
  const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
    requestId: 'r',
    sessionId: 's',
    tool: 'Edit',
    input: {},
    ...over,
  });

  it('names the tool, in the approval bar wording', () => {
    expect(permissionSummary(req(), t)).toBe('Allow Edit?');
  });

  it('prefers the CLI own display name over our tool id', () => {
    expect(permissionSummary(req({ displayName: 'Write file' }), t)).toContain('Allow Write file?');
  });

  it('shows the sharpest field it has — the command, the path, the url', () => {
    expect(permissionSummary(req({ tool: 'Bash', input: { command: 'rm -rf build' } }), t)).toBe(
      'Allow Bash? rm -rf build'
    );
    expect(permissionSummary(req({ input: { file_path: 'C:/proj/x.ts' } }), t)).toBe(
      'Allow Edit? C:/proj/x.ts'
    );
    expect(permissionSummary(req({ tool: 'WebFetch', input: { url: 'https://x.dev' } }), t)).toBe(
      'Allow WebFetch? https://x.dev'
    );
  });

  it('a command beats a description when both are there', () => {
    expect(
      permissionSummary(req({ tool: 'Bash', input: { command: 'ls', description: 'List' } }), t)
    ).toBe('Allow Bash? ls');
  });

  it("falls back to the CLI own prose, which is text we did not write (P7)", () => {
    expect(permissionSummary(req({ input: {}, reason: 'edits inside .claude/' }), t)).toBe(
      'Allow Edit? edits inside .claude/'
    );
  });

  it('collapses newlines and truncates — a toast is one or two lines', () => {
    const long = 'x'.repeat(400);
    const out = permissionSummary(req({ tool: 'Bash', input: { command: `a\n  b ${long}` } }), t);
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThan(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('survives a request with no input at all', () => {
    // The hook path carries far less than the stream path does (#312); a body
    // built from a missing field must still be a sentence.
    expect(
      permissionSummary(
        { requestId: 'r', sessionId: 's', tool: '', input: undefined as never },
        t
      )
    ).toBe('Allow a tool?');
  });
});

// The click path crosses main -> preload -> App, and no runtime test in this
// repo can reach it: a click on a real OS toast happens in the shell, and App
// is never mounted in a unit test (it is a 100vh shell over dockview — see
// `always-visible-notices.test.ts`, which reads App's source for exactly this
// reason). So the witness is the SOURCE TEXT, the established fallback here.
// Without it, `sessions:revealCard` could be deleted at any one of the three
// ends and everything would stay green while the only gesture a Linux user has
// stopped working.
describe('the click path is wired end to end (P2-E14-04)', () => {
  const read = (...p: string[]): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

  it('the channel is declared, or the broker would refuse main own push', () => {
    expect(read('shared', 'ipc', 'capabilities.ts')).toContain("'sessions:revealCard': 'sessions.read'");
  });

  it('the preload exposes it on that channel', () => {
    const preload = read('preload', 'index.ts');
    expect(preload).toContain('onRevealCard');
    expect(preload).toContain("ipcRenderer.on('sessions:revealCard'");
  });

  it('App subscribes and lands on the card, rather than merely raising a window', () => {
    const app = read('renderer', 'src', 'App.tsx');
    expect(app).toMatch(/onRevealCard\?\.\(\(r\) => \{[\s\S]{0,120}focusCard\(r\.cardId\)/);
  });
});

// ── #563 — a question is not a permission ───────────────────────────────────
describe("the CLI's own question on a toast (#563)", () => {
  const question = (questions: unknown): PermissionRequest => ({
    requestId: 'r-q',
    sessionId: 's1',
    tool: 'AskUserQuestion',
    input: { questions },
  });

  it('carries NO buttons — an Allow here would discard the question, not grant it', () => {
    // Measured: an allow with no `answers` comes back as "The user did not
    // answer the questions." (probe mode `empty`). A notification is the worst
    // possible place to discover you threw one away.
    expect(
      answerableFromToast(question([{ question: 'q', options: [{ label: 'a' }] }]))
    ).toBe(false);
  });

  it('leaves every other tool answerable', () => {
    expect(
      answerableFromToast({
        requestId: 'r',
        sessionId: 's1',
        tool: 'Write',
        input: { file_path: '/p/x.ts' },
      })
    ).toBe(true);
  });

  it('says what is being asked instead of "Allow AskUserQuestion?"', () => {
    const summary = permissionSummary(
      question([
        { question: 'Which colour do you prefer?', options: [{ label: 'Red' }], multiSelect: false },
      ]),
      t
    );
    expect(summary).toBe('A question for you: Which colour do you prefer?');
    expect(summary).not.toContain('Allow');
  });

  it('counts the ones the line has no room for', () => {
    const summary = permissionSummary(
      question([
        { question: 'First?', options: [{ label: 'a' }] },
        { question: 'Second?', options: [{ label: 'b' }] },
        { question: 'Third?', options: [{ label: 'c' }] },
      ]),
      t
    );
    expect(summary).toBe('A question for you: First? (+2 more)');
  });

  it('falls back to plain prose when the payload will not parse', () => {
    expect(permissionSummary(question('not an array'), t)).toBe(
      'Claude is asking you a question'
    );
  });
});

// ---------------------------------------------------------------------------
// #471 — the toast speaks the user's language, and switches mid-session.
// ---------------------------------------------------------------------------
//
// The issue's done-when, pinned: "a test pins locale-switched toast text".
//
// `pseudo` is the only non-English locale this build ships, and that is exactly
// what makes it the right witness here — every string it renders is a
// MECHANICAL transform of the English one, so the assertion can be "this is the
// English string, put through the locale" rather than a hand-copied literal
// that would still pass if the language never changed at all. A real second
// locale, when one lands, needs nothing new: it is a JSON file.
describe('a toast is composed in the user language (#471)', () => {
  const bash = (): PermissionRequest => ({
    requestId: 'r',
    sessionId: 's',
    tool: 'Bash',
    input: { command: 'npm run build' },
  });

  it('renders the SAME request differently once the language moves', () => {
    lang = 'en';
    const english = permissionSummary(bash(), t);
    expect(english).toBe('Allow Bash? npm run build');

    // The switch. Nothing is re-initialised, nothing is awaited, no channel is
    // pushed — `main/index.ts` passes a thunk over the workspace preference and
    // this is the same thunk. A toast fired on the next line is already in the
    // new language, which is the behaviour a mid-session switch has to have.
    lang = 'pseudo';
    const other = permissionSummary(bash(), t);
    expect(other).not.toBe(english);
    expect(other).toContain('⟦');

    // The COMMAND is untouched, in either language. §5.21's last bullet: we
    // translate our chrome, not CLI output — a pseudolocalized `npm run build`
    // would be a lie about what Allow would run.
    expect(other).toContain('npm run build');
    expect(other).toBe(
      pseudolocalize('Allow {tool}? {detail}')
        .replace('{tool}', 'Bash')
        .replace('{detail}', 'npm run build')
    );
  });

  it('translates the BUTTONS too, in order', () => {
    lang = 'pseudo';
    const [allow, deny] = decideButtonActions(t);
    expect(allow.text).toBe(pseudolocalize('Allow'));
    expect(deny.text).toBe(pseudolocalize('Deny'));
    // …and the order still decodes to the right verdict.
    expect(DECIDE_BUTTONS[0]).toBe('allow');
  });

  it('translates a question, ICU plural and all', () => {
    lang = 'pseudo';
    const summary = permissionSummary(
      {
        requestId: 'r',
        sessionId: 's',
        tool: 'AskUserQuestion',
        input: {
          questions: [
            { question: 'First?', options: [{ label: 'a' }] },
            { question: 'Second?', options: [{ label: 'b' }] },
          ],
        },
      },
      t
    );
    // The plural block survived pseudo-localization (its braces are preserved)
    // and still counted — a `{{more}}`-style mistake would have rendered the
    // braces at the user instead.
    expect(summary).toContain('(+1 more)');
    expect(summary).toContain('⟦');
    expect(summary).toContain('First?');
  });

  it('goes back to English when the preference does', () => {
    lang = 'pseudo';
    expect(permissionSummary(bash(), t)).toContain('⟦');
    lang = 'en';
    expect(permissionSummary(bash(), t)).toBe('Allow Bash? npm run build');
  });
});
