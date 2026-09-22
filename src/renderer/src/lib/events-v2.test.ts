import { describe, it, expect } from 'vitest';
import { heldFor, rowArgument, visibleEvents } from './events-v2';
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';
import type { AttentionEvent } from './queue';

const ev = (id: number, sessionId: string, kind: AttentionEvent['kind'], minute = id): AttentionEvent => ({
  id,
  sessionId,
  kind,
  at: `2026-09-22T10:${String(minute).padStart(2, '0')}:00.000Z`,
});

const req = (
  requestId: string,
  sessionId: string,
  tool = 'Bash',
  input: Record<string, unknown> = { command: 'npm test' }
): PermissionRequestDto => ({ requestId, sessionId, tool, input });

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which colour?',
      header: 'Colour',
      options: [{ label: 'Red' }, { label: 'Blue' }],
      multiSelect: false,
    },
  ],
};

describe('visibleEvents (§5.12 filters)', () => {
  const events = [
    ev(1, 'a', 'ready', 1),
    ev(2, 'b', 'done', 2),
    ev(3, 'c', 'needs-permission', 3),
    ev(4, 'd', 'needs-input', 4),
  ];
  const noRail = (): undefined => undefined;
  const none = (): boolean => false;

  it('All is the panel order the list has always had: queue, then the reviewed tail', () => {
    expect(visibleEvents(events, 'all', noRail, none).map((e) => e.id)).toEqual([3, 4, 2, 1]);
  });

  it('Needed is exactly the queue — the reviewed row is the only one it drops', () => {
    expect(visibleEvents(events, 'needed', noRail, none).map((e) => e.id)).toEqual([3, 4, 2]);
  });

  it('Needed also keeps a reviewed row whose session is still HOLDING something', () => {
    const holding = (s: string): boolean => s === 'a';
    expect(visibleEvents(events, 'needed', noRail, holding).map((e) => e.id)).toEqual([3, 4, 2, 1]);
  });

  it('By session sorts by rail position, whatever the urgency', () => {
    const rail = new Map([
      ['a', 0],
      ['d', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect(visibleEvents(events, 'by-session', (s) => rail.get(s), none).map((e) => e.id)).toEqual([
      1, 4, 2, 3,
    ]);
  });

  it('By session puts a session the rail does not know LAST, in panel order, and drops nothing', () => {
    const rail = new Map([['a', 0]]);
    expect(visibleEvents(events, 'by-session', (s) => rail.get(s), none).map((e) => e.id)).toEqual([
      1, 3, 4, 2,
    ]);
  });

  it('never mutates the list it was given', () => {
    const copy = events.slice();
    visibleEvents(events, 'by-session', () => 0, none);
    expect(events).toEqual(copy);
  });
});

describe('rowArgument (the one line a row can fit)', () => {
  it('cuts a long path from the FRONT, at a separator, so the file name survives', () => {
    const out = rowArgument({
      file_path: 'C:\\Users\\dheinz\\AppData\\Local\\Temp\\sb-e2e-proj-abc123\\src\\deploy.sh',
    });
    expect(out.startsWith('…\\')).toBe(true);
    expect(out.endsWith('deploy.sh')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(42);
  });

  it('leaves a short path alone, and a long command or URL keeps its head', () => {
    expect(rowArgument({ file_path: 'src/a.ts' })).toBe('src/a.ts');
    const long = 'npm run build && npm test -- --reporter=verbose --coverage';
    expect(rowArgument({ command: long })).toBe(long);
    const url = 'https://example.com/a/very/long/path/that/goes/on/for/a/while';
    expect(rowArgument({ url })).toBe(url);
  });

  it('falls back to the argument dump the grouped card uses, not to nothing', () => {
    expect(rowArgument({ server: 'x' })).toBe('server="x"');
  });
});

describe('heldFor (the ledger joined to one row)', () => {
  it('answers the OLDEST held permission, and counts the rest', () => {
    const ledger = [req('r1', 'a'), req('r2', 'b'), req('r3', 'a', 'Write', { file_path: 'x' })];
    const h = heldFor(ledger, 'a');
    expect(h.permission?.requestId).toBe('r1');
    expect(h.permissionIds).toEqual(['r1', 'r3']);
    expect(h.questions).toEqual([]);
  });

  it('never hands another session’s request to this row', () => {
    const h = heldFor([req('r2', 'b')], 'a');
    expect(h.permission).toBeNull();
    expect(h.permissionIds).toEqual([]);
  });

  it('keeps a QUESTION out of the permission buttons and lists it instead (#563)', () => {
    const h = heldFor([req('q1', 'a', 'AskUserQuestion', QUESTION_INPUT)], 'a');
    expect(h.permission).toBeNull();
    expect(h.permissionIds).toEqual([]);
    expect(h.questions.map((q) => q.question)).toEqual(['Which colour?']);
  });

  it('a session holding both gets both, and Allow all never includes the question', () => {
    const h = heldFor(
      [req('q1', 'a', 'AskUserQuestion', QUESTION_INPUT), req('r1', 'a')],
      'a'
    );
    expect(h.permission?.requestId).toBe('r1');
    expect(h.permissionIds).toEqual(['r1']);
    expect(h.questions).toHaveLength(1);
  });

  it('an unparseable question contributes nothing rather than throwing', () => {
    const h = heldFor([req('q1', 'a', 'AskUserQuestion', { questions: 'nope' })], 'a');
    expect(h.questions).toEqual([]);
    expect(h.permission).toBeNull();
  });
});
