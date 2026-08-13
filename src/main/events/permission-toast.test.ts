// P2-E14-04 — the routing behind an Allow/Deny toast.
//
// What only a unit test can cover: the button press itself. No harness can
// click a real OS notification, so the contract between "the OS said index 1"
// and "the CLI was told deny" is pinned here, and the e2e
// (`e2e/permission-toast.spec.ts`) proves the toast that carries those buttons
// is really built and really withdrawn.
import { describe, it, expect, vi } from 'vitest';
import type { PermissionRequest } from '../../shared/ipc/permissions';
import {
  DECIDE_BUTTONS,
  PermissionToasts,
  permissionSummary,
  toastActionsSupported,
} from './permission-toast';

function log(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** a toast that records whether it was closed, standing in for `Notification` */
function fakeToast(): { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() };
}

function harness(decide = vi.fn().mockReturnValue(true)) {
  const l = log();
  const reveal = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toasts = new PermissionToasts({ decide, reveal, log: l as any });
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
      expect.objectContaining({ error: expect.stringContaining('router exploded') })
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: l as any,
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
    expect(permissionSummary(req())).toBe('Allow Edit?');
  });

  it('prefers the CLI own display name over our tool id', () => {
    expect(permissionSummary(req({ displayName: 'Write file' }))).toContain('Allow Write file?');
  });

  it('shows the sharpest field it has — the command, the path, the url', () => {
    expect(permissionSummary(req({ tool: 'Bash', input: { command: 'rm -rf build' } }))).toBe(
      'Allow Bash? rm -rf build'
    );
    expect(permissionSummary(req({ input: { file_path: 'C:/proj/x.ts' } }))).toBe(
      'Allow Edit? C:/proj/x.ts'
    );
    expect(permissionSummary(req({ tool: 'WebFetch', input: { url: 'https://x.dev' } }))).toBe(
      'Allow WebFetch? https://x.dev'
    );
  });

  it('a command beats a description when both are there', () => {
    expect(
      permissionSummary(req({ tool: 'Bash', input: { command: 'ls', description: 'List' } }))
    ).toBe('Allow Bash? ls');
  });

  it("falls back to the CLI own prose, which is text we did not write (P7)", () => {
    expect(permissionSummary(req({ input: {}, reason: 'edits inside .claude/' }))).toBe(
      'Allow Edit? edits inside .claude/'
    );
  });

  it('collapses newlines and truncates — a toast is one or two lines', () => {
    const long = 'x'.repeat(400);
    const out = permissionSummary(req({ tool: 'Bash', input: { command: `a\n  b ${long}` } }));
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThan(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('survives a request with no input at all', () => {
    // The hook path carries far less than the stream path does (#312); a body
    // built from a missing field must still be a sentence.
    expect(
      permissionSummary({ requestId: 'r', sessionId: 's', tool: '', input: undefined as never })
    ).toBe('Allow a tool?');
  });
});
