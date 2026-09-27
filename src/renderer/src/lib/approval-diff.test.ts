// P2-E22-01 (#972) — what a held tool call looks like as a diff.
//
// The interesting half of putting Monaco in the approval card is arithmetic, not
// pixels: which payloads are diffable, in what order, and how much of one we are
// willing to render. That is why it is a pure module, and this is where the
// claims live. The component test covers the dispatch and the fail-open path; the
// e2e covers "a real held permission, answered, with a diff on screen".
import { describe, expect, it } from 'vitest';
import {
  approvalDiff,
  joinHunks,
  lineCount,
  MAX_HUNKS,
  MAX_SIDE_CHARS,
  MAX_TOTAL_CHARS,
  separatorFor,
} from './approval-diff';

describe('which payloads are diffable at all', () => {
  it('diffs an Edit — the shape that always had two sides', () => {
    const d = approvalDiff({ file_path: '/x/a.ts', old_string: 'a', new_string: 'b' });
    expect(d?.kind).toBe('edit');
    expect(d?.hunks).toEqual([{ index: 1, total: 1, original: 'a', modified: 'b' }]);
    expect(d?.path).toBe('/x/a.ts');
  });

  it('diffs a Write against an EMPTY original, because that is all the payload proves', () => {
    // The renderer holds a `tool_use`, not the disk. A `Write` may be creating a
    // file or replacing one wholesale and nothing here knows which — so every
    // line reads as added, which is exactly what having a `content` proves and no
    // more. Implying a "before" would be the card guessing on the user's behalf.
    const d = approvalDiff({ file_path: '/x/new.ts', content: 'one\ntwo\n' });
    expect(d?.kind).toBe('write');
    expect(d?.hunks[0].original).toBe('');
    expect(d?.hunks[0].modified).toBe('one\ntwo\n');
  });

  it('does NOT diff an empty Write — two blank panes say less than the caption does', () => {
    // `ToolInputPreview` already has a caption for exactly this ("New contents —
    // empty"), and it is the whole message. Falling through is the answer.
    expect(approvalDiff({ file_path: '/x/a.ts', content: '' })).toBeNull();
  });

  it('does not diff a Bash command — one side is not a diff', () => {
    expect(approvalDiff({ command: 'npm run build' })).toBeNull();
  });

  it('lets `command` WIN over a diffable field, because the fallback does too', () => {
    // ⚠️ THE TWO BODIES MUST AGREE (found in review). `ToolInputPreview` — which is
    // still the fallback — tests `command` first, so an input carrying both would
    // otherwise render as a diff of the content in the editor and as the command in
    // the panes: one question answered two different ways depending on whether
    // Monaco happened to load. §5.16's rule about a user who reads one thing on one
    // surface and another on the other is why the body is shared at all.
    expect(approvalDiff({ command: 'rm -rf /', content: 'harmless' })).toBeNull();
    expect(approvalDiff({ command: 'rm -rf /', old_string: 'a', new_string: 'b' })).toBeNull();
    expect(approvalDiff({ command: 'rm -rf /', edits: [{ old_string: 'a', new_string: 'b' }] })).toBeNull();
  });

  it('does not diff a NotebookEdit, which also has only a new side', () => {
    expect(approvalDiff({ notebook_path: '/x/a.ipynb', new_source: 'print(1)' })).toBeNull();
  });

  it('does not diff a tool it has never heard of', () => {
    expect(approvalDiff({ some_future_key: 'whatever' })).toBeNull();
  });

  it('reads the path out of whichever key the tool spells it in', () => {
    expect(approvalDiff({ notebook_path: '/n.ipynb', old_string: 'a', new_string: 'b' })?.path).toBe(
      '/n.ipynb'
    );
    expect(approvalDiff({ path: '/p.md', old_string: 'a', new_string: 'b' })?.path).toBe('/p.md');
    // and an input with no path at all is still diffable — the path only picks a
    // language, and plaintext is a perfectly good answer
    expect(approvalDiff({ old_string: 'a', new_string: 'b' })?.path).toBe('');
  });
});

describe('MultiEdit — N changes, in the order they apply', () => {
  const multi = (n: number): Record<string, unknown> => ({
    file_path: '/x/a.ts',
    edits: Array.from({ length: n }, (_, i) => ({
      old_string: `old${i + 1}`,
      new_string: `new${i + 1}`,
    })),
  });

  it('keeps apply order and numbers each change against the total', () => {
    const d = approvalDiff(multi(3));
    expect(d?.kind).toBe('multi-edit');
    expect(d?.hunks.map((h) => [h.index, h.total, h.original, h.modified])).toEqual([
      [1, 3, 'old1', 'new1'],
      [2, 3, 'old2', 'new2'],
      [3, 3, 'old3', 'new3'],
    ]);
  });

  it('wins over the singular pair when an input carries both', () => {
    // The CLI treats the two as mutually exclusive and strips the singular pair
    // when the array is present, so an input carrying both IS a multi-edit. Same
    // ordering rule `ToolInputPreview` follows, and for the same reason.
    const d = approvalDiff({
      old_string: 'SINGULAR_OLD',
      new_string: 'SINGULAR_NEW',
      edits: [{ old_string: 'ARRAY_OLD', new_string: 'ARRAY_NEW' }],
    });
    expect(d?.kind).toBe('multi-edit');
    expect(d?.hunks[0].original).toBe('ARRAY_OLD');
  });

  it('keeps the readable changes when ONE entry is malformed, and counts it', () => {
    const d = approvalDiff({
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'only-old' },
        { old_string: 'c', new_string: 'd' },
      ],
    });
    expect(d?.hunks).toHaveLength(2);
    expect(d?.unreadable).toBe(1);
    // ⚠️ AND THE NUMBERING IS AGAINST THE CLI'S ARRAY, not against the survivors,
    // which is the whole point of the counter beside it (found in review). The
    // readable changes here are entries 1 and 3, so they are labelled "1 of 3" and
    // "3 of 3" — leaving a visible gap where the unreadable one sits. Numbering them
    // 1 and 2 would label the THIRD edit the CLI is going to apply as "change 2",
    // which is a caption about apply order that is wrong about apply order.
    expect(d?.hunks.map((h) => [h.index, h.total])).toEqual([
      [1, 3],
      [3, 3],
    ]);
  });

  it('falls through when nothing in the array is readable', () => {
    // Then the key/value dump genuinely is the better answer, and
    // `ToolInputPreview` is the thing that renders it.
    expect(approvalDiff({ edits: [{ nope: 1 }, 'also nope'] })).toBeNull();
  });

  it('is not fooled by an empty array', () => {
    expect(approvalDiff({ edits: [] })).toBeNull();
  });

  it(`caps at ${MAX_HUNKS} changes and SAYS how many it did not render`, () => {
    const d = approvalDiff(multi(MAX_HUNKS + 7));
    expect(d?.hunks).toHaveLength(MAX_HUNKS);
    expect(d?.withheld?.changes).toBe(7);
    // the total is the REAL total, so "1 of 47" is honest about the size of what
    // is being approved even though only 40 are drawn
    expect(d?.hunks[0].total).toBe(MAX_HUNKS + 7);
  });

  it('spends ONE budget across all its changes, and reports what ran out', () => {
    // ⚠️ THE BOUND `MAX_SIDE_CHARS` DOES NOT PROVIDE (found in review): it is per
    // side per hunk, so forty hunks could have reached ~16M characters and
    // `joinHunks` would have concatenated the lot into two Monaco models. The `Edit`
    // and `Write` paths were protected and the richest payload the card has to
    // review was not.
    const chunk = 'a\n'.repeat(60_000); // 120,000 chars a side
    const d = approvalDiff({
      edits: Array.from({ length: 12 }, () => ({ old_string: chunk, new_string: chunk })),
    })!;
    const rendered = d.hunks.reduce((n, h) => n + h.original.length + h.modified.length, 0);
    expect(rendered).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    // …and nothing vanished quietly: whatever the budget could not afford is
    // reported, as trimmed text and as whole changes that were never drawn
    expect(d.withheld).not.toBeNull();
    expect(d.withheld!.chars + d.withheld!.changes).toBeGreaterThan(0);
    expect(d.hunks.length).toBeLessThan(12);
  });

  it('reports nothing withheld when everything fits', () => {
    expect(approvalDiff(multi(3))?.withheld).toBeNull();
  });
});

describe('the bound, and #953 — never silently truncate what a user signs for', () => {
  it('leaves an ordinary payload completely alone', () => {
    const content = 'x\n'.repeat(1_000); // 2,000 chars: past the OLD 1500 clip
    const d = approvalDiff({ content });
    expect(d?.hunks[0].modified).toBe(content);
    expect(d?.withheld).toBeNull();
  });

  it('bounds a pathological payload and NAMES what it withheld', () => {
    // The old behaviour was `slice(0, 1500)` plus an ellipsis and no number at
    // all — a user could not tell a short file from the first page of a long one.
    const content = 'line\n'.repeat(60_000); // 300,000 chars
    const d = approvalDiff({ content });
    expect(d?.withheld).not.toBeNull();
    expect(d?.withheld?.lines).toBeGreaterThan(0);
    expect(d?.withheld?.chars).toBeGreaterThan(0);
    // and what IS shown, plus what is reported, accounts for the whole payload —
    // nothing falls down the gap between them
    expect(d!.hunks[0].modified.length + d!.withheld!.chars).toBe(content.length);
  });

  it('cuts at a line boundary, not mid-token', () => {
    // A diff whose last line is half an identifier reads as a change that was
    // never proposed.
    const d = approvalDiff({ content: 'abcdefghij\n'.repeat(30_000) });
    expect(d!.hunks[0].modified.endsWith('\n')).toBe(true);
    expect(d!.hunks[0].modified.length).toBeLessThanOrEqual(MAX_SIDE_CHARS);
  });

  it('falls back to the hard offset when there is no line to cut at', () => {
    // A minified file. There is nothing better to do, and silently rendering
    // nothing would be worse.
    const d = approvalDiff({ content: 'z'.repeat(MAX_SIDE_CHARS + 500) });
    expect(d!.hunks[0].modified).toHaveLength(MAX_SIDE_CHARS);
    expect(d!.withheld?.chars).toBe(500);
  });

  it('bounds BOTH sides of an Edit, and does not double-count the LINES', () => {
    const big = 'a\n'.repeat(120_000); // 240,000 chars a side
    const d = approvalDiff({ old_string: big, new_string: big });
    // Characters add up — they are two different strings.
    expect(d!.withheld!.chars).toBe(
      big.length - d!.hunks[0].original.length + (big.length - d!.hunks[0].modified.length)
    );
    // LINES take the worst side, not the sum (found in review): the two sides are
    // two versions of ONE thing, and adding them reported "240,000 lines not shown"
    // for a 120,000-line file — a number larger than the thing it describes, on the
    // one line whose entire job is to be trusted about size.
    expect(d!.withheld!.lines).toBeLessThan(120_000);
  });

  it('bounds every hunk of a MultiEdit, not just the first', () => {
    const big = 'a\n'.repeat(120_000);
    const d = approvalDiff({
      edits: [
        { old_string: big, new_string: 'small' },
        { old_string: 'small', new_string: big },
      ],
    });
    expect(d!.hunks[0].original.length).toBeLessThanOrEqual(MAX_SIDE_CHARS);
    expect(d!.hunks[1].modified.length).toBeLessThanOrEqual(MAX_SIDE_CHARS);
    expect(d!.withheld!.lines).toBeGreaterThan(0);
  });
});

describe('joining the hunks for ONE editor', () => {
  it('adds no separator to a single change — "change 1 of 1" is noise', () => {
    const d = approvalDiff({ old_string: 'a', new_string: 'b' })!;
    expect(joinHunks(d)).toEqual({ original: 'a', modified: 'b' });
  });

  it('puts the separator on BOTH sides, identically — the whole trick', () => {
    // ⚠️ THIS IS THE ASSERTION THAT PROTECTS THE DESIGN. Monaco reads a line that
    // matches on both sides as unchanged CONTEXT, which is what forces a hunk
    // break exactly on the change boundary. Drop the separator and adjacent
    // changes merge into one hunk; put a DIFFERENT line on each side and every
    // separator becomes a change of its own, which is worse than the blob.
    const d = approvalDiff({
      edits: [
        { old_string: 'old1', new_string: 'new1' },
        { old_string: 'old2', new_string: 'new2' },
      ],
    })!;
    const { original, modified } = joinHunks(d);
    const sep1 = separatorFor(1, 2);
    const sep2 = separatorFor(2, 2);
    expect(original.split('\n')).toEqual([sep1, 'old1', sep2, 'old2', '']);
    expect(modified.split('\n')).toEqual([sep1, 'new1', sep2, 'new2', '']);
  });

  it('spaces every separator the same, whatever the change ends with', () => {
    // One change ending in a newline and the next not would otherwise put the
    // separators at different distances from the changes above them, which reads
    // as meaning something.
    const d = approvalDiff({
      edits: [
        { old_string: 'a\n', new_string: 'b' },
        { old_string: 'c', new_string: 'd\n' },
      ],
    })!;
    const { original, modified } = joinHunks(d);
    expect(original.split('\n')).toEqual([separatorFor(1, 2), 'a', separatorFor(2, 2), 'c', '']);
    expect(modified.split('\n')).toEqual([separatorFor(1, 2), 'b', separatorFor(2, 2), 'd', '']);
  });

  it('uses a glyph no language has as syntax, so it cannot read as proposed code', () => {
    expect(separatorFor(2, 5)).toBe('──── change 2 of 5 ────');
    expect(separatorFor(2, 5)).not.toMatch(/[A-Za-z0-9]{2}[^\s]*[(){};=]/);
  });

  it('WIDENS the rule when the payload already contains one', () => {
    // ⚠️ The one way this trick can misfire (found in review): a payload line equal
    // to a separator lets Monaco align real content against the scaffolding, and so
    // show the user a change that was never proposed. It takes a documentation file
    // that draws its own rules — rare, and cheap to rule out rather than admit to.
    const collide = separatorFor(2, 2);
    const d = approvalDiff({
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: collide, new_string: 'c' },
      ],
    })!;
    const { original } = joinHunks(d);
    // The payload line is still there, untouched — the SCAFFOLDING moved, rather
    // than the change being edited to fit around it.
    expect(original).toContain(collide);
    // …and every separator actually emitted is a line the payload did not have, so
    // nothing in the change can be mistaken for one. Three rule-shaped lines are in
    // the joined text: the payload's own, once, and the two this emitted — and the
    // split between them is the assertion. (Counting only the emitted ones would
    // need a locator that already knew the answer.)
    const ruleShaped = original.split('\n').filter((l) => /^─+ change \d+ of 2 ─+$/.test(l));
    expect(ruleShaped).toHaveLength(3);
    expect(ruleShaped.filter((l) => l === collide)).toHaveLength(1);
    expect(new Set(ruleShaped.filter((l) => l !== collide)).size).toBe(2);
  });

  it('ends a MULTI-hunk join with a newline, so a diff ending on a change can draw it', () => {
    const d = approvalDiff({
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    })!;
    expect(joinHunks(d).original.endsWith('\n')).toBe(true);
    expect(joinHunks(d).modified.endsWith('\n')).toBe(true);
  });

  it('hands a SINGLE hunk through byte-exact, trailing newline or not', () => {
    // ⚠️ DELIBERATELY NOT NORMALISED, and this is a #953 claim rather than a
    // convenience. With one change there is no scaffolding — no separators — so
    // what the editor shows IS the payload, and appending a newline would show the
    // user a file ending they are not being asked to approve. The trailing newline
    // in the multi-hunk case is scaffolding on both sides, like the separators,
    // and misrepresents no individual change.
    expect(joinHunks(approvalDiff({ content: 'no trailing newline' })!)).toEqual({
      original: '',
      modified: 'no trailing newline',
    });
    expect(joinHunks(approvalDiff({ content: 'has one\n' })!).modified).toBe('has one\n');
  });
});

describe('lineCount counts the way a person does', () => {
  it('does not count a trailing newline as another line', () => {
    // Almost every file an agent writes ends in one, and this number's entire job
    // is to tell the user how big the thing they are signing for is.
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\nb')).toBe(2);
  });

  it('calls a one-line file one line', () => {
    expect(lineCount('just this')).toBe(1);
  });

  it('calls nothing ZERO lines, not one', () => {
    // Different from `ToolInputPreview`'s version on purpose: there it captions a
    // file ("1 line"), here it counts what was WITHHELD, and "1 line withheld"
    // when nothing was is a false alarm on the one number that must not cry wolf.
    expect(lineCount('')).toBe(0);
  });
});
