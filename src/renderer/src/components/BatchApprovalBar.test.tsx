// @vitest-environment jsdom
// The grouped permission prompt, as a rendered contract (P2-E9-11, §5.8).
//
// Three claims that no unit test of the grouping rule can make, because they
// are about the DOM the user clicks:
//
//   • "one Allow answers both" — the group button really does call
//     `decidePermission` once per member, and does not quietly reach for
//     `allowAllSession` on the way (which would write a standing grant to N
//     sessions from one click);
//   • "declining one leaves the other held" — the per-member Deny answers
//     exactly one request;
//   • the sessions are named by the §5.11 identity kit and not by their paths.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { BatchApprovalBar } from './BatchApprovalBar';
import { chooseBatch, memberViews } from '../lib/permission-batches';
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';
import type { RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

async function mount(tree: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(tree);
  });
  return host;
}

function req(
  requestId: string,
  sessionId: string,
  over: Partial<PermissionRequestDto> = {}
): PermissionRequestDto {
  return {
    requestId,
    sessionId,
    cardId: 'card-' + sessionId,
    tool: 'Bash',
    input: { command: 'npm test' },
    ...over,
  };
}

const sessions: RailSession[] = [
  { id: 'card-live-A', title: 'switchboard', accent: 'var(--status-working)', folder: 'C:/Projects/sb' },
  { id: 'card-live-B', title: 'brainharbor', folder: 'C:/Projects/bh' },
];

/** the whole surface, driven by the real rule rather than a hand-built batch */
async function mountBatch(
  pending: PermissionRequestDto[],
  calls: Array<[readonly string[], 'allow' | 'deny']> = []
): Promise<HTMLElement> {
  const batch = chooseBatch(pending, null);
  return mount(
    <BatchApprovalBar
      batch={batch}
      members={batch ? memberViews(batch, sessions) : []}
      onDecide={(ids, decision) => calls.push([ids, decision])}
    />
  );
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the grouped prompt renders one question for several sessions', () => {
  it('renders nothing at all when nothing groups', async () => {
    // a band of dead chrome above the workspace is worse than no band
    const host = await mountBatch([req('r1', 'live-A')]);
    expect(host.querySelector('[data-testid="batch-approval"]')).toBeNull();
  });

  it('counts the sessions and names the tool once', async () => {
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B')]);
    const bar = host.querySelector<HTMLElement>('[data-testid="batch-approval"]')!;
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain('2 sessions want to run Bash');
    // and the argument, so nobody answers a question they cannot see
    expect(bar.textContent).toContain('npm test');
  });

  it('names each member by its session, never by its folder (5.11)', async () => {
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B')]);
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-batch-member]'));
    expect(rows.map((r) => r.getAttribute('title'))).toEqual(['switchboard', 'brainharbor']);
    expect(host.textContent).not.toContain('C:/Projects');
  });

  it('says so plainly when a session has no name yet', async () => {
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-unknown')]);
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-batch-member]'));
    expect(rows[1].getAttribute('title')).toBe('unnamed session nown');
    // …and its buttons still work: the CLI is blocked whether or not the rail
    // has caught up
    expect(rows[1].querySelectorAll('button')).toHaveLength(2);
  });

  it('keeps two unnamed sessions tellable apart', async () => {
    // this is the one surface where the user CHOOSES between sessions; two
    // rows reading the same words with different buttons is a coin toss
    const host = await mountBatch([req('r1', 'live-ax91'), req('r2', 'live-bq47')]);
    const titles = Array.from(host.querySelectorAll<HTMLElement>('[data-batch-member]')).map((r) =>
      r.getAttribute('title')
    );
    expect(titles).toEqual(['unnamed session ax91', 'unnamed session bq47']);
  });

  it('describes a tool with no path, command or url rather than naming it alone', async () => {
    // one click answers for N sessions, so "what am I agreeing to" has to be
    // answerable from this card — the per-card bar has the session's whole
    // conversation above it and this does not
    const input = { query: 'switchboard release notes', allowed: ['docs'] };
    const host = await mountBatch([
      req('r1', 'live-A', { tool: 'WebSearch', input }),
      req('r2', 'live-B', { tool: 'WebSearch', input }),
    ]);
    const text = host.querySelector<HTMLElement>('[data-testid="batch-approval"]')!.textContent;
    expect(text).toContain('query="switchboard release notes"');
  });

  it('lists one row per HELD REQUEST, so a doubled session is answered twice', async () => {
    // live-A is asking the same thing twice; a card that listed it once would
    // leave one of its two questions held with nothing on screen saying so
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B'), req('r3', 'live-A')]);
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-batch-member]'));
    expect(rows).toHaveLength(3);
    // …while the headline still counts SESSIONS, which is what the user reads
    expect(host.textContent).toContain('2 sessions want to run Bash');
  });

  it('shows the CLI\u2019s own reason, once, for the whole group', async () => {
    const host = await mountBatch([
      req('r1', 'live-A', { reason: 'writes outside the project folder' }),
      req('r2', 'live-B', { reason: 'writes outside the project folder' }),
    ]);
    const text = host.querySelector<HTMLElement>('[data-testid="batch-approval"]')!.textContent;
    expect(text.split('writes outside the project folder')).toHaveLength(2);
  });
});

describe('the buttons answer exactly what they name', () => {
  it('answers every member with one click of the group Allow', async () => {
    const calls: Array<[readonly string[], 'allow' | 'deny']> = [];
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B')], calls);
    const allow = host.querySelector<HTMLElement>('[data-testid="batch-allow-all"]')!;
    expect(allow.tagName).toBe('BUTTON'); // Enter and Space from the platform
    expect(allow.textContent).toBe('Allow in all 2 sessions');

    await act(async () => allow.click());
    expect(calls).toEqual([[['r1', 'r2'], 'allow']]);
  });

  it('denies every member with one click of the group Deny', async () => {
    const calls: Array<[readonly string[], 'allow' | 'deny']> = [];
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B')], calls);
    await act(async () => host.querySelector<HTMLElement>('[data-testid="batch-deny-all"]')!.click());
    expect(calls).toEqual([[['r1', 'r2'], 'deny']]);
  });

  it('leaves the sibling held when one member is declined', async () => {
    // the item's done-when, at the surface that has to honour it
    const calls: Array<[readonly string[], 'allow' | 'deny']> = [];
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B')], calls);
    await act(async () => host.querySelector<HTMLElement>('[data-batch-deny="r1"]')!.click());
    expect(calls).toEqual([[['r1'], 'deny']]);
  });

  it('allows one member without touching the other — the cherry-pick half', async () => {
    const calls: Array<[readonly string[], 'allow' | 'deny']> = [];
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B')], calls);
    await act(async () => host.querySelector<HTMLElement>('[data-batch-allow="r2"]')!.click());
    expect(calls).toEqual([[['r2'], 'allow']]);
  });

  it('offers no standing grant — every button answers only what it lists', async () => {
    // "Allow all (this session)" writes a grant that answers every FUTURE gated
    // call with no bar and no event. Doing that to N sessions from one click is
    // a far larger promise than this card is entitled to make, so the string
    // must not be reachable from here at all.
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B')]);
    expect(host.textContent).not.toContain('this session');
  });
});

describe('the a11y contract (issue 197 rules, one surface later)', () => {
  it('is real buttons, each naming the session it answers for', async () => {
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B')]);
    const row = host.querySelector<HTMLElement>('[data-batch-member]')!;
    // the row itself is a role-less mouse convenience; the controls are buttons
    expect(row.tagName).toBe('DIV');
    expect(row.getAttribute('role')).toBeNull();
    const [allow, deny] = Array.from(row.querySelectorAll<HTMLElement>('button'));
    expect(allow.getAttribute('aria-label')).toBe('Allow in switchboard');
    expect(deny.getAttribute('aria-label')).toBe('Deny in switchboard');
  });

  it('announces itself, on the message and not on the controls', async () => {
    // it arrives without anyone navigating to it (#314's idiom). A region
    // wrapping the buttons would re-read "Allow Deny Allow Deny" on every
    // change.
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B')]);
    const region = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(region).not.toBeNull();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.querySelector('button')).toBeNull();
    expect(region.textContent).toContain('2 sessions want to run Bash');
  });

  it('labels the group with the question it is asking', async () => {
    const host = await mountBatch([req('r1', 'live-A'), req('r2', 'live-B')]);
    const bar = host.querySelector<HTMLElement>('[data-testid="batch-approval"]')!;
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.getAttribute('aria-label')).toBe('2 sessions want to run Bash');
  });
});
