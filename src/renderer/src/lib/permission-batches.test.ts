// The grouping rule (P2-E9-11, §5.8's batch bullet).
//
// This rule decides how many sessions one click answers for, so the tests are
// weighted the way the design is: most of them are about NOT grouping. Grouping
// too little costs the user a second click; grouping too much authorises
// something they never read.
import { describe, it, expect } from 'vitest';
import {
  argumentDetail,
  argumentSummary,
  batchKey,
  chooseBatch,
  memberViews,
  sameBatch,
} from './permission-batches';
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';
import type { RailSession } from '../model/types';

/** one held request, as main pushes it */
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

describe('batchKey — the same question, and only the same question', () => {
  it('gives two identical requests from two sessions one key', () => {
    expect(batchKey(req('r1', 'live-A'))).toBe(batchKey(req('r2', 'live-B')));
  });

  it('ignores the order the argument keys arrived in', () => {
    // two CLI versions building the same object in a different order are
    // asking the same question; a key that preserved insertion order would
    // split them and nobody would ever know why the group stopped forming
    const a = req('r1', 'live-A', { input: { file_path: 'x.ts', old_string: 'a', new_string: 'b' } });
    const b = req('r2', 'live-B', { input: { new_string: 'b', file_path: 'x.ts', old_string: 'a' } });
    expect(batchKey(a)).toBe(batchKey(b));
  });

  it('separates a different VALUE, not merely a different shape', () => {
    // the whole design in one assertion: same tool, same argument shape,
    // catastrophically different question
    const safe = req('r1', 'live-A', { input: { command: 'rm -rf build' } });
    const not = req('r2', 'live-B', { input: { command: 'rm -rf /' } });
    expect(batchKey(safe)).not.toBe(batchKey(not));
  });

  it('separates a different tool with identical arguments', () => {
    const bash = req('r1', 'live-A', { tool: 'Bash', input: { command: 'ls' } });
    const shell = req('r2', 'live-B', { tool: 'PowerShell', input: { command: 'ls' } });
    expect(batchKey(bash)).not.toBe(batchKey(shell));
  });

  it('cannot be forged by a tool name that carries the separator', () => {
    // tool names come from MCP servers too, so "no tool name contains a NUL"
    // is an assumption about other people's strings, not a guarantee
    const nul = String.fromCharCode(0);
    const real = req('r1', 'live-A', { tool: 'Bash', input: { command: 'rm -rf /' } });
    const forged = req('r2', 'live-B', {
      tool: `Bash${nul}{"command":"rm -rf /"}${nul}`,
      input: {},
    });
    expect(batchKey(real)).not.toBe(batchKey(forged));
  });

  it('separates an extra argument nobody read', () => {
    const bare = req('r1', 'live-A', { input: { command: 'ls' } });
    const more = req('r2', 'live-B', { input: { command: 'ls', timeout: 600000 } });
    expect(batchKey(bare)).not.toBe(batchKey(more));
  });

  it('separates a string from the number that prints the same', () => {
    const s = req('r1', 'live-A', { input: { port: '8080' } });
    const n = req('r2', 'live-B', { input: { port: 8080 } });
    expect(batchKey(s)).not.toBe(batchKey(n));
  });

  it('separates an absent argument from a null one', () => {
    const absent = req('r1', 'live-A', { input: { command: 'ls' } });
    const nulled = req('r2', 'live-B', { input: { command: 'ls', cwd: null } });
    expect(batchKey(absent)).not.toBe(batchKey(nulled));
  });

  it('separates different reasons, because the card shows only one of them', () => {
    // `reason` is the CLI's own prose (P2-E18-07) and the grouped card renders
    // it once for every member. Two members that gave different reasons cannot
    // honestly share a card, so they do not share a key.
    const a = req('r1', 'live-A', { reason: 'writes outside the project' });
    const b = req('r2', 'live-B', { reason: 'touches .claude' });
    expect(batchKey(a)).not.toBe(batchKey(b));
    // and two that gave the SAME reason still group
    expect(batchKey(a)).toBe(batchKey(req('r3', 'live-C', { reason: 'writes outside the project' })));
  });

  it('goes deep — a nested argument is part of the question', () => {
    const a = req('r1', 'live-A', { input: { edits: [{ old: 'a', new: 'b' }] } });
    const b = req('r2', 'live-B', { input: { edits: [{ old: 'a', new: 'c' }] } });
    expect(batchKey(a)).not.toBe(batchKey(b));
    expect(batchKey(a)).toBe(batchKey(req('r3', 'live-C', { input: { edits: [{ new: 'b', old: 'a' }] } })));
  });

  it('gives an unserialisable input a key nothing can equal', () => {
    // a cycle cannot come off the wire, but a throw inside a render is a blank
    // window — and the fallback has to mean "asked separately", never "asked
    // nowhere"
    const cyclic: Record<string, unknown> = { command: 'ls' };
    cyclic.self = cyclic;
    const a = req('r1', 'live-A', { input: cyclic });
    const b = req('r2', 'live-B', { input: cyclic });
    expect(batchKey(a)).not.toBe(batchKey(b));
    expect(chooseBatch([a, b], null)).toBeNull();
  });
});

describe('chooseBatch — which group is on screen', () => {
  it('groups two sessions asking the identical question', () => {
    const batch = chooseBatch([req('r1', 'live-A'), req('r2', 'live-B')], null)!;
    expect(batch).not.toBeNull();
    expect(batch.sessionCount).toBe(2);
    expect(batch.tool).toBe('Bash');
    expect(batch.members.map((m) => m.requestId)).toEqual(['r1', 'r2']);
    expect(batch.members.map((m) => m.cardId)).toEqual(['card-live-A', 'card-live-B']);
  });

  it('never groups one session with itself', () => {
    // parallel tool calls in ONE session are that card's own queue (E10-04's
    // "+N more waiting"); moving them to a cross-session card gains nothing and
    // takes the question off the card that raised it
    expect(chooseBatch([req('r1', 'live-A'), req('r2', 'live-A')], null)).toBeNull();
  });

  it('leaves a lone request alone', () => {
    expect(chooseBatch([req('r1', 'live-A')], null)).toBeNull();
    expect(chooseBatch([], null)).toBeNull();
  });

  it('picks only the matching pair out of a mixed ledger', () => {
    const batch = chooseBatch(
      [
        req('r0', 'live-A', { input: { command: 'git status' } }),
        req('r1', 'live-B'),
        req('r2', 'live-C', { tool: 'Edit', input: { file_path: 'x.ts' } }),
        req('r3', 'live-D'),
      ],
      null
    )!;
    expect(batch.members.map((m) => m.requestId)).toEqual(['r1', 'r3']);
  });

  it('shows ONE group at a time, oldest first', () => {
    // a stack of grouped cards would move the buttons under the cursor every
    // time a session parked; the unchosen group's members stay on their own
    // cards until this one clears
    const pending = [
      req('r1', 'live-A', { input: { command: 'first' } }),
      req('r2', 'live-B', { input: { command: 'second' } }),
      req('r3', 'live-C', { input: { command: 'first' } }),
      req('r4', 'live-D', { input: { command: 'second' } }),
    ];
    expect(chooseBatch(pending, null)!.input).toEqual({ command: 'first' });
  });

  it('keeps the group already on screen even when an older one forms', () => {
    // the sticky clause: a card whose contents can be swapped between the read
    // and the click is a card that answers a question the user never saw
    const showing = chooseBatch([req('r1', 'live-A'), req('r2', 'live-B')], null)!;
    const withOlder = [
      req('r0', 'live-X', { input: { command: 'older' } }),
      req('r0b', 'live-Y', { input: { command: 'older' } }),
      req('r1', 'live-A'),
      req('r2', 'live-B'),
    ];
    expect(chooseBatch(withOlder, showing.key)!.key).toBe(showing.key);
  });

  it('lets a later matching request JOIN the group on screen', () => {
    // Safe ONLY because the key is exact: the newcomer is byte-for-byte the
    // question the user has already read, so "Allow in all 3" authorises the
    // same thing they were about to authorise twice. If the key ever loosens,
    // this has to become a queue instead.
    const showing = chooseBatch([req('r1', 'live-A'), req('r2', 'live-B')], null)!;
    const grown = chooseBatch([req('r1', 'live-A'), req('r2', 'live-B'), req('r3', 'live-C')], showing.key)!;
    expect(grown.key).toBe(showing.key);
    expect(grown.sessionCount).toBe(3);
    expect(grown.members.map((m) => m.requestId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('dissolves the group the moment one of two members is answered', () => {
    // "declining one leaves the other held": the survivor is not answered and
    // not lost — it falls back to its own card's bar
    const showing = chooseBatch([req('r1', 'live-A'), req('r2', 'live-B')], null)!;
    expect(chooseBatch([req('r2', 'live-B')], showing.key)).toBeNull();
  });

  it('moves on to the next group once the sticky one is gone', () => {
    const showing = chooseBatch([req('r1', 'live-A'), req('r2', 'live-B')], null)!;
    const next = chooseBatch(
      [
        req('r3', 'live-C', { input: { command: 'other' } }),
        req('r4', 'live-D', { input: { command: 'other' } }),
      ],
      showing.key
    )!;
    expect(next.input).toEqual({ command: 'other' });
  });
});

describe('sameBatch — the identity guard useSyncExternalStore needs', () => {
  it('calls a recompute over unchanged input the same batch', () => {
    const pending = [req('r1', 'live-A'), req('r2', 'live-B')];
    expect(sameBatch(chooseBatch(pending, null), chooseBatch(pending, null))).toBe(true);
  });

  it('sees a member arriving and a member leaving', () => {
    const two = chooseBatch([req('r1', 'live-A'), req('r2', 'live-B')], null);
    const three = chooseBatch([req('r1', 'live-A'), req('r2', 'live-B'), req('r3', 'live-C')], null);
    expect(sameBatch(two, three)).toBe(false);
    expect(sameBatch(three, two)).toBe(false);
  });

  it('sees a member LEARNING its card id', () => {
    // main stamps the card id at send time, so a push that beat the binding
    // carries none and the replay carries it. Calling those the same batch
    // would leave that row reading "unnamed session" for the rest of the run.
    const early = chooseBatch([req('r1', 'live-A', { cardId: undefined }), req('r2', 'live-B')], null);
    const bound = chooseBatch([req('r1', 'live-A'), req('r2', 'live-B')], null);
    expect(sameBatch(early, bound)).toBe(false);
  });

  it('handles the null ends', () => {
    expect(sameBatch(null, null)).toBe(true);
    expect(sameBatch(chooseBatch([req('r1', 'live-A'), req('r2', 'live-B')], null), null)).toBe(false);
  });
});

describe('memberViews — naming the sessions (issue 5.11)', () => {
  const sessions: RailSession[] = [
    { id: 'card-live-A', title: 'switchboard', accent: 'var(--status-working)', folder: 'C:/a' },
    { id: 'card-live-B', title: 'brainharbor', folder: 'C:/b' },
  ];

  it('names each member by its session, with its accent', () => {
    const batch = chooseBatch([req('r1', 'live-A'), req('r2', 'live-B')], null)!;
    expect(memberViews(batch, sessions)).toEqual([
      {
        requestId: 'r1',
        sessionId: 'live-A',
        cardId: 'card-live-A',
        title: 'switchboard',
        accent: 'var(--status-working)',
      },
      { requestId: 'r2', sessionId: 'live-B', cardId: 'card-live-B', title: 'brainharbor', accent: undefined },
    ]);
  });

  it('leaves an unknown session unnamed rather than guessing a path', () => {
    // the folder is right there on the request's card and it is deliberately
    // not used: §5.11 names sessions, and this is the one surface that names
    // several of them side by side
    const batch = chooseBatch([req('r1', 'live-A'), req('r2', 'live-Z')], null)!;
    const views = memberViews(batch, sessions);
    expect(views[1].title).toBeUndefined();
    expect(views[1].sessionId).toBe('live-Z');
  });

  it('keeps a member whose card main could not resolve', () => {
    const batch = chooseBatch(
      [req('r1', 'live-A', { cardId: undefined }), req('r2', 'live-B')],
      null
    )!;
    expect(memberViews(batch, sessions)[0]).toEqual({
      requestId: 'r1',
      sessionId: 'live-A',
      cardId: undefined,
      title: undefined,
      accent: undefined,
    });
  });
});

describe('argumentSummary — the one line both bars show', () => {
  it('prefers the file, then the command, then the url', () => {
    expect(argumentSummary({ file_path: 'x.ts', command: 'ls' })).toBe('x.ts');
    expect(argumentSummary({ command: 'npm test' })).toBe('npm test');
    expect(argumentSummary({ url: 'https://example.test' })).toBe('https://example.test');
  });

  it('says nothing rather than "undefined" for a tool with none of them', () => {
    expect(argumentSummary({ pattern: '*.ts' })).toBe('');
  });

  it('says nothing rather than "[object Object]" for a malformed field (#255)', () => {
    // `input` comes off the CLI's `tool_use` block, so a field we expect to be
    // a path can be anything. `String()` used to render this as the literal
    // text `[object Object]` on the approval card; the honest answer is that
    // there is no summary, which is a state both bars already handle.
    expect(argumentSummary({ file_path: { path: 'x.ts' } })).toBe('');
    expect(argumentSummary({ command: ['ls', '-l'] })).toBe('');
    // ...and a falsy PRIMITIVE is still a real value, not an absence
    expect(argumentSummary({ file_path: '', command: 'ls' })).toBe('');
  });
});

describe('argumentDetail — what the GROUPED card shows when there is no summary', () => {
  it('is the summary whenever there is one', () => {
    expect(argumentDetail({ command: 'npm test' })).toBe('npm test');
  });

  it('falls back to the arguments themselves, rather than the tool name alone', () => {
    // this card answers for N sessions with one click, so it has to be
    // readable without the session's conversation beside it
    expect(argumentDetail({ pattern: '*.ts', limit: 20 })).toBe('pattern="*.ts"  limit=20');
  });

  it('truncates instead of growing the band without limit', () => {
    const detail = argumentDetail({ blob: 'x'.repeat(1000) });
    expect(detail.length).toBeLessThanOrEqual(301);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('stays empty for a tool that takes no arguments at all', () => {
    expect(argumentDetail({})).toBe('');
  });

  it('dumps the arguments when the summary field was malformed (#255)', () => {
    // The grouped card's half of the behaviour above: no summary means the
    // fallback runs, so a malformed `file_path` is READ rather than shown as
    // punctuation.
    expect(argumentDetail({ file_path: { path: 'x.ts' } })).toBe('file_path={"path":"x.ts"}');
  });
});

// ── #563 — a question never joins a group ───────────────────────────────────
describe('the CLI own questions are never grouped (#563)', () => {
  const ask = (sessionId: string, requestId: string): PermissionRequestDto => ({
    requestId,
    sessionId,
    cardId: `card-${sessionId}`,
    tool: 'AskUserQuestion',
    input: {
      questions: [{ question: 'Which colour?', options: [{ label: 'Red' }], multiSelect: false }],
    },
  });

  // The key is EXACT, so two sessions running the same prompt really can ask a
  // byte-identical question — the grouping rule alone would not stop this. It
  // has to be stopped anyway: this card's Allow sends the input back with no
  // `answers`, which the CLI reads as "The user did not answer the questions",
  // so one click would answer N sessions with nothing.
  it('two identical questions from two sessions do NOT form a group', () => {
    expect(chooseBatch([ask('live-A', 'q1'), ask('live-B', 'q2')], null)).toBeNull();
  });

  it('does not stop the ordinary requests around them grouping', () => {
    const write = (sessionId: string, requestId: string): PermissionRequestDto => ({
      requestId,
      sessionId,
      cardId: `card-${sessionId}`,
      tool: 'Write',
      input: { file_path: 'C:/p/x.ts' },
    });

    const batch = chooseBatch(
      [ask('live-A', 'q1'), write('live-A', 'w1'), write('live-B', 'w2'), ask('live-B', 'q2')],
      null
    );

    expect(batch?.tool).toBe('Write');
    expect(batch?.members.map((m) => m.requestId)).toEqual(['w1', 'w2']);
  });
});
