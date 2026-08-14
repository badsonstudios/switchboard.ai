// `docs/extensibility.md` may not lie about the code (#472).
//
// The doc is the internal contributor guide — the thing someone reads BEFORE
// writing an adapter or a contribution point — and it had drifted in three
// different ways at once by the time this was written: a "known gaps" bullet
// still describing the pre-E15-01 provider contract, a manifest vocabulary
// listing main's four strings and none of the renderer's six, and five link
// anchors into `src/main` pointing at unrelated code. Prose cannot be tested;
// LISTS can, and every drift above was a list the doc kept its own copy of.
//
// So: the two capability tables are parsed out of the markdown and compared to
// the code, and every link into `src/` must resolve. What is deliberately NOT
// tested is the prose around them — the fix for a stale paragraph is a pointer
// at DESIGN.md rather than a regex, which is why the provider-contract bullet
// now says "§5.3 is the source of truth" instead of restating the members.
//
// The tokens.drift.test.ts pattern, one layer up: that one keeps a TS list and
// a stylesheet in agreement; this one keeps a markdown table and a TS list.
//
// ON LIVING IN `shared/extensibility/`: this directory's invariant is that it
// imports nothing from `main/` or `renderer/` (`registry.test.ts` and the
// `no-restricted-imports` rule both enforce it). Nothing here breaks that —
// the only import is `CAPABILITIES`, which is shared. Both processes' files
// are READ off disk as text, never imported, precisely so a doc pin cannot
// become the thing that couples the two halves.
//
// KNOWN GAP, worth stating because it decides what the next reader should
// reach for: this pins the doc's two capability LISTS, not its COUNTS. The
// file table's "the seven transcript block renderers" and the roster's "two of
// the four §5.31 names" are equally mechanical and equally rot-prone —
// P2-E17-03 (#415) will stale the second the day it registers a third find
// provider, and every assertion below will stay green, because a third
// registrant declares the same `find.provide` string.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CAPABILITIES } from '../ipc/capabilities';

const repoRoot = path.join(__dirname, '..', '..', '..');
const docDir = path.join(repoRoot, 'docs');
const docPath = path.join(docDir, 'extensibility.md');
// `.gitattributes` pins checkouts to LF (#280); normalised anyway, because a
// CRLF working copy would fail every match below for a reason that has nothing
// to do with drift.
const doc = fs.readFileSync(docPath, 'utf8').replace(/\r\n/g, '\n');

/**
 * The lines of the markdown table whose header row contains `headerCell`.
 *
 * Every parse below is called from INSIDE a test rather than at describe-time.
 * At describe-time a reworded header fails collection, which vitest reports as
 * "suite failed to collect" — and the guard-the-guard tests that exist to
 * explain exactly that never run.
 */
function tableAfter(headerCell: string): string[] {
  const rows = doc.split('\n');
  const start = rows.findIndex((l) => l.startsWith('|') && l.includes(headerCell));
  expect(start, `no table header containing "${headerCell}" in extensibility.md`).toBeGreaterThan(
    -1
  );
  const body: string[] = [];
  // +2 skips the header and the `|---|---|` separator
  for (let i = start + 2; i < rows.length && rows[i].startsWith('|'); i++) body.push(rows[i]);
  expect(body.length, `the table at "${headerCell}" has no rows`).toBeGreaterThan(0);
  return body;
}

/** The cells of one row, header pipes stripped. */
function cells(row: string): string[] {
  return row.split('|').slice(1, -1);
}

/** The backticked code spans in a cell. */
function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/**
 * Expand the doc's `x.read` / `.write` shorthand.
 *
 * The IPC table pairs the read/write halves of a namespace on one row
 * (`` `events.read` / `.write` ``), which reads far better than eleven
 * near-identical rows — so the parser understands the shorthand rather than
 * the doc being reshaped to suit the parser. A leading-dot token takes the
 * namespace of the token before it in the SAME cell.
 */
function expandShorthand(names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith('.')) {
      out.push(name);
      continue;
    }
    const prev = out[out.length - 1];
    expect(
      prev,
      `"${name}" is shorthand with nothing before it to borrow a namespace from`
    ).toBeDefined();
    out.push(`${prev.split('.')[0]}${name}`);
  }
  return out;
}

/** The IPC vocabulary table's capability names, in document order. */
function documentedIpcCapabilities(): string[] {
  return tableAfter('| Capability |').flatMap((row) => expandShorthand(codeSpans(cells(row)[0])));
}

describe('the IPC capability table', () => {
  it('parses as capability names at all', () => {
    // the guard's guard: a reworded header or a table converted to a list
    // leaves this empty, and every assertion below would pass by having
    // nothing to compare
    const documented = documentedIpcCapabilities();
    expect(documented.length).toBeGreaterThan(20);
    for (const name of documented) expect(name).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
  });

  it('documents every capability the code declares', () => {
    // the #425 defect verbatim: `provider.status` shipped, the table did not
    // learn about it, and nothing said so
    const documented = documentedIpcCapabilities();
    expect([...CAPABILITIES].filter((c) => !documented.includes(c))).toEqual([]);
  });

  it('documents no capability the code does not declare', () => {
    // the other direction — a capability renamed or deleted in code leaves a
    // row describing a power nothing can hold
    const documented = documentedIpcCapabilities();
    expect(documented.filter((c) => !(CAPABILITIES as readonly string[]).includes(c))).toEqual([]);
  });

  it('keeps them in the same order as the source', () => {
    // not cosmetic: the source list is grouped by what a capability COSTS
    // (`update.check` immediately above `update.install`, and the reason the
    // split exists is written between them), and a table in a different order
    // silently loses that argument
    expect(documentedIpcCapabilities()).toEqual([...CAPABILITIES]);
  });
});

// --- The contribution-manifest vocabulary, per process ----------------------
//
// A DIFFERENT vocabulary from the one above (see the doc's "Two vocabularies,
// not yet joined"): free-form strings a contribution declares, enforced by
// nothing. Which is exactly why the doc's copy of the list rots — no compiler
// and no broker is reading it.

/** where each process's contributions live, as the doc's own row labels */
const CONTRIBUTION_SOURCES: Record<string, string[]> = {
  Main: [path.join(repoRoot, 'src', 'main', 'providers')],
  Renderer: [
    path.join(repoRoot, 'src', 'renderer', 'src', 'extensibility'),
    // the one contribution registered from a bootstrap rather than from a
    // module of its own (`core-commands`)
    path.join(repoRoot, 'src', 'renderer', 'src', 'bootstrap.ts'),
  ],
};

/**
 * Every capability string a shipped contribution in `roots` declares.
 *
 * Two spellings, because there are two: main's adapters write a literal
 * `capabilities: ['a', 'b']`, and the renderer's contributions go through
 * `manifestFor(id, name, capability)` — one capability per point.
 *
 * KNOWN BLIND SPOTS, both narrow and both one-directional:
 *  - A contribution registered from a directory not listed above is missed and
 *    this stays green. The reverse direction (a string in the doc that no
 *    longer exists in code) has no such gap. Widening the scan to the whole
 *    tree would pick up every unrelated `capabilities:` in the IPC layer,
 *    which is the other vocabulary and the confusion the doc exists to avoid.
 *  - `manifestFor(…)` is matched up to the first `)`, so a call with a nested
 *    one (`manifestFor(id, t('x'), 'foo.bar')`) is skipped rather than
 *    misread; and a call whose capability is an identifier but whose
 *    displayName happens to contain a dot would be picked up as a capability.
 *    Neither shape exists today, and both fail LOUDLY rather than silently —
 *    the "lists no string nothing declares" case names the offender.
 */
function declaredIn(roots: string[]): string[] {
  const files = roots.flatMap((root) =>
    fs.statSync(root).isDirectory()
      ? fs
          .readdirSync(root)
          .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
          .map((f) => path.join(root, f))
      : [root]
  );
  expect(files.length, `nothing to scan under ${roots.join(', ')}`).toBeGreaterThan(0);

  const found = new Set<string>();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    // `capabilities: [...]` — a list of literals. `capabilities: [capability]`
    // (the manifestFor helper itself) contributes nothing, correctly.
    for (const m of src.matchAll(/capabilities:\s*\[([^\]]*)\]/g)) {
      for (const s of m[1].matchAll(/'([^']+)'/g)) found.add(s[1]);
    }
    // `manifestFor(…, 'capability')` — the last string argument
    for (const m of src.matchAll(/manifestFor\(([^)]*)\)/g)) {
      const strings = [...m[1].matchAll(/'([^']+)'/g)].map((s) => s[1]);
      // ...but only when the call actually spells the capability out; the
      // helper's own signature passes it through as an identifier
      const last = strings[strings.length - 1];
      if (last?.includes('.')) found.add(last);
    }
  }
  return [...found];
}

/** the vocabulary table as `{ process -> strings }` */
function documentedManifestVocabulary(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of tableAfter('| Process | Strings in use |')) {
    const [process, list] = cells(row);
    out[process.trim()] = codeSpans(list);
  }
  return out;
}

describe('the contribution-manifest vocabulary table', () => {
  it('names the processes the scan knows about', () => {
    // the guard's guard, and the thing that makes the per-process assertions
    // below meaningful rather than a flattened union
    expect(Object.keys(documentedManifestVocabulary()).sort()).toEqual(
      Object.keys(CONTRIBUTION_SOURCES).sort()
    );
  });

  it('keeps the cells to capability names', () => {
    // Every code span in the second cell is read as a capability, so a helper
    // or a file name dropped in there would be compared against the code and
    // reported as drift that isn't. Pointers go in the prose under the table —
    // which is where `manifestFor`'s link had to move to make this pass.
    const documented = documentedManifestVocabulary();
    const all = Object.values(documented).flat();
    expect(all.length).toBeGreaterThan(8);
    for (const name of all) expect(name).toMatch(/^[a-z-]+\.[a-zA-Z-]+$/);
  });

  it('lists every string a shipped contribution declares, under its own process', () => {
    // what went stale: main's four were the whole list until the renderer got
    // a registry (P2-E15-02), and the paragraph never learned the other six
    const documented = documentedManifestVocabulary();
    for (const [process, roots] of Object.entries(CONTRIBUTION_SOURCES)) {
      const declared = declaredIn(roots);
      expect(declared.length, `${process} declares nothing — did the modules move?`).toBeGreaterThan(
        3
      );
      expect(
        declared.filter((c) => !documented[process].includes(c)).sort(),
        `${process} declares these and the table does not list them`
      ).toEqual([]);
    }
  });

  it('lists no string nothing declares, and none under the wrong process', () => {
    // the per-process half matters: a flattened comparison would let
    // `find.provide` be filed under Main and stay green
    const documented = documentedManifestVocabulary();
    for (const [process, roots] of Object.entries(CONTRIBUTION_SOURCES)) {
      const declared = declaredIn(roots);
      expect(
        documented[process].filter((c) => !declared.includes(c)).sort(),
        `the table lists these under ${process} and nothing there declares them`
      ).toEqual([]);
    }
  });
});

describe('the pointer convention (#472)', () => {
  const links = (): string[] => [...doc.matchAll(/\]\((\.\.\/[^)\s]+)\)/g)].map((m) => m[1]);

  it('has links to check', () => {
    expect(links().length).toBeGreaterThan(20);
  });

  it('points only at files that exist', () => {
    const missing = links().filter((l) => !fs.existsSync(path.join(docDir, l.split('#')[0])));
    expect(missing, 'a link into src/ that no longer resolves').toEqual([]);
  });

  it('carries no line-number anchor', () => {
    // The rule the doc's own "Registry consumers" section states. All five of
    // main's `#Lnnn` anchors there had rotted: `index.ts#L1178-L1179`, cited
    // as `capabilitiesOf`, landed inside `update:openExternal`, and `#L805`,
    // cited as the default-provider lookup, inside the popout's bounds
    // validation. A file link can be checked; a line number cannot, so the
    // convention is to name the SYMBOL and let the reader search for it.
    expect(
      links().filter((l) => /#L\d/.test(l)),
      'name the file and the symbol — a line anchor rots silently'
    ).toEqual([]);
  });
});
