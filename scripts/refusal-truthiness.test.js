// #440 + #650 — the refusal-truthiness scanner, pinned in both directions.
//
// The load-bearing half is the LAST describe block: it runs the analyzer over
// the real renderer and demands zero. That is what makes a new
// `if (await bridge.x())` — or a new `setEvents(await bridge.list())` — a red
// unit run rather than a defect that waits for Phase 4 to become reachable.
//
// The other halves are the lesson `eslint-hex-rule.test.js` wrote down: a guard
// that has been quietly narrowed to nothing goes green for ever and nobody
// notices, because green is what it looked like when it worked. So the shapes
// it MUST catch are pinned, the shapes it MUST NOT are pinned, and the bridge
// surface it derives from the preload is pinned too — an extraction that
// silently matched no methods would clear the whole tree in one commit.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PRELOAD,
  invokeBackedMethods,
  scanSource,
  scanTree,
  formatReport,
} from './refusal-truthiness.js';

// From this file, not `process.cwd()` — the same house rule the script under
// test writes down for itself. cwd happens to be the repo root under vitest and
// would not be if anyone ran it from `scripts/`.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** the real bridge surface — these tests judge snippets against the real thing */
let methods;
beforeAll(() => {
  methods = invokeBackedMethods(fs.readFileSync(path.join(ROOT, PRELOAD), 'utf8'));
});

/** kinds reported for a snippet, as if it were a renderer file */
const kinds = (source) =>
  scanSource('src/renderer/src/probe.ts', source, methods).map((f) => f.kind);
/** the same, judged as TSX — for the JSX positions (#650) */
const kindsTsx = (source) =>
  scanSource('src/renderer/src/probe.tsx', source, methods).map((f) => f.kind);
const wrap = (body) => `async function probe(): Promise<void> {\n${body}\n}\n`;

describe('the bridge surface it derives from the preload', () => {
  // If this ever came back empty the scanner would report a clean tree for the
  // rest of time. It is derived, not listed, so the only thing to pin is that
  // deriving it still works — and that it draws the invoke/subscribe line in
  // the right place, since a subscription cannot be refused and `const off =
  // bridge.x.onY(...)` is a truthiness test that must stay legal.
  it('finds the brokered methods — and roughly as many as there are invokes', () => {
    // A loose floor would let the extraction silently halve and still pass. The
    // preload's raw `ipcRenderer.invoke(` count is the independent number: a few
    // methods invoke more than once, so names <= invokes, and a big gap means
    // the walk up to the enclosing binding stopped finding names.
    const invokes = (
      fs.readFileSync(path.join(ROOT, PRELOAD), 'utf8').match(/ipcRenderer[?]?[.]invoke[(]/g) ?? []
    ).length;
    expect(invokes).toBeGreaterThan(60);
    expect(methods.size).toBeGreaterThan(invokes * 0.75);
    expect(methods.size).toBeLessThanOrEqual(invokes);
  });

  it.each([
    'submitPrompt',
    'interrupt',
    'isDirectory',
    'pickFolder',
    'create',
    'getLayout',
    'getUi',
    'openExternal',
    'search',
    'binding',
  ])('includes %s', (name) => {
    expect(methods.has(name)).toBe(true);
  });

  it.each(['onStatus', 'onBlock', 'onExited', 'onPermissionRequest'])(
    'excludes the subscription %s — the broker cannot refuse one',
    (name) => {
      expect(methods.has(name)).toBe(false);
    }
  );
});

describe('shapes it MUST catch', () => {
  it.each([
    ['a direct if', wrap(`if (await window.switchboard.sessions.isDirectory('/x')) return;`)],
    ['a negated direct if', wrap(`if (!(await window.switchboard.sessions.isDirectory('/x'))) return;`)],
    ['a ternary', wrap(`const v = (await window.switchboard.sessions.isDirectory('/x')) ? 1 : 2;`)],
    ['a && operand', wrap(`const v = (await window.switchboard.sessions.isDirectory('/x')) && 1;`)],
    ['a ?? left operand', wrap(`const v = (await window.switchboard.workspace.getUi()) ?? {};`)],
    ['a Boolean() coercion', wrap(`const v = Boolean(await window.switchboard.sessions.isDirectory('/x'));`)],
    ['a while test', wrap(`while (await window.switchboard.sessions.isDirectory('/x')) break;`)],
    [
      'a two-step const',
      wrap(`const r = await window.switchboard.sessions.pickFolder();\nif (r) return;`),
    ],
    [
      'a two-step const read further down the block',
      wrap(
        `const r = await window.switchboard.sessions.pickFolder();\n` +
          `console.log('x');\nconst v = r ?? '/tmp';`
      ),
    ],
    [
      'a .then parameter',
      `void window.switchboard.sessions.pickFolder().then((f) => { if (f) console.log(f); });`,
    ],
    [
      'a .then parameter in an expression body',
      `void window.switchboard.sessions.historyRepairs().then((l) => console.log(l ?? []));`,
    ],
    [
      'a call through a ?? aliased bridge (App.tsx fail-open shim)',
      `const bridge = window.switchboard ?? ({} as typeof window.switchboard);\n` +
        wrap(`if (await bridge.sessions.isDirectory('/x')) return;`),
    ],
    [
      'a call through an aliased NAMESPACE (SessionGrid rulesApi/soundsApi)',
      `const soundsApi = window.switchboard?.sounds as typeof window.switchboard.sounds;\n` +
        `void soundsApi.get('c').then((s) => console.log(s ?? null));`,
    ],
    [
      'an optional-chained call',
      `void window.switchboard?.sessions?.pickFolder?.().then((f) => { if (f) console.log(f); });`,
    ],
    [
      // the point-free shape, where four of the nineteen real sites hid: the raw
      // answer goes straight into a React setter and becomes the state
      'a point-free .then(setter)',
      `void window.switchboard.settings.getAutoTrust().then(setAutoTrust);`,
    ],
    [
      'a .then with a DESTRUCTURED parameter — unfollowable, so reported',
      `void window.switchboard.transcripts.binding('s').then(({ binding }) => use(binding));`,
    ],
    [
      // `took`/`answered` take the RESOLVED value; a Promise makes `took` a
      // permanent silent false, and reads exactly like the correct code
      'a launderer with the await FORGOTTEN',
      wrap(`if (took(window.switchboard.sessions.isDirectory('/x'))) return;`),
    ],
    [
      // #440's OWN fixes wear this shape; without the rename rule, deleting the
      // launderer from three of them left this scanner green
      'a boolean read one RENAME away from the tracked name',
      `void window.switchboard.sessions.create({}).then((a) => { const record = a; if (!record) return; use(record); });`,
    ],
  ])('catches %s', (_label, source) => {
    expect(kinds(source).length).toBeGreaterThan(0);
  });

  it('reports the RIGHT node, not merely some node', () => {
    const found = scanSource(
      'src/renderer/src/probe.ts',
      wrap(`const r = await window.switchboard.sessions.pickFolder();
if (!r) return;`),
      methods
    );
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('negation');
    // the whole guard expression, which is what a reader needs to act on —
    // not the bare identifier, and not the statement wrapped around it
    expect(found[0].source).toBe('!r');
    expect(found[0].line).toBe(3);
  });
});

describe('shapes it MUST NOT flag', () => {
  it.each([
    [
      'the laundered boolean read',
      wrap(`if (took(await window.switchboard.sessions.isDirectory('/x'))) return;`),
    ],
    [
      'the laundered value read',
      wrap(`const r = answered(await window.switchboard.sessions.pickFolder());\nif (r) return;`),
    ],
    [
      // The laundered value is what gets USED, not just what gets tested. The
      // snippet this replaced was `if (answered(f)) console.log(f)`, which
      // tests the clean value and then uses the dirty one — legal under #440
      // (the read is not a boolean) and a #650 defect, so the scanner is right
      // to have started reporting it.
      'a laundered .then parameter',
      `void window.switchboard.sessions.pickFolder().then((f) => { const p = answered(f); if (p) console.log(p); });`,
    ],
    [
      'an explicit === true',
      `void window.switchboard.rules.notifyWhenDone('c').then((on) => console.log(on === true));`,
    ],
    [
      'an explicit === false (App.tsx decidePermission)',
      `void window.switchboard.sessions.decidePermission('r', 'allow').then((o) => { if (o === false) console.log('x'); });`,
    ],
    [
      'an isIpcRefusal branch',
      wrap(
        `const r = await window.switchboard.sessions.pickFolder();\n` +
          `if (isIpcRefusal(r)) return;`
      ),
    ],
    [
      'an unsubscribe function from a subscription',
      `const off = window.switchboard.sessions.onStatus(() => {});\nif (off) off();`,
    ],
    [
      'an await of something that is not the bridge',
      wrap(`if (await somethingElse.pickFolder()) return;`),
    ],
    [
      // Not because the scanner knows `mainTook` narrows — it has no idea. It
      // passes because `mainTook` is not a bridge method, so an identically
      // shaped helper that DID leak the raw answer would pass too. That is the
      // injected-dependency blind spot, stated rather than papered over.
      'a call of a local helper rather than of the bridge (composer mainTook)',
      wrap(`if (await mainTook('submitPrompt', () => window.switchboard.sessions.submitPrompt('s', 't'))) return;`),
    ],
    [
      '.then(() => …) that discards the answer entirely',
      `void window.switchboard.sessions.closeCard('c').then(() => refresh());`,
    ],
    [
      // the false positive that cost the first draft of this scanner: a closure
      // that MENTIONS the bridge is not an alias of it, and reading it as one
      // made TerminalPane's own shadow search look like `transcripts.search`
      'a closure that merely mentions the bridge',
      `const shadow = () => new TerminalShadow({ read: () => window.switchboard.pty.snapshot('s') });\n` +
        wrap(`const out = await shadow().search('q');\nreturn out && { ...out };`),
    ],
    [
      // #650's degraded-value shapes, one per fallback style. These are the
      // fixes the sweep applied; if the scanner started objecting to one of
      // them the story would have no legal spelling left.
      'a laundered list with an empty fallback',
      `void window.switchboard.events.list().then((l) => setEvents(answered(l) ?? []));`,
    ],
    [
      'a laundered record with an early return',
      `void window.switchboard.notifications.getPrefs().then((raw) => { const p = answered(raw); if (!p) return; setOn(p.sounds === true); });`,
    ],
    [
      // the two `as` casts #650 was filed for, fixed: laundered BEFORE the cast
      'a laundered value cast after laundering',
      `void window.switchboard.git.status('/f').then((s) => { const next = answered(s) as GitStatusDto | undefined; if (next) use(next.files); });`,
    ],
    [
      'a laundered optional-chained map with a null fallback',
      `void window.switchboard.groups.list().then((gs) => answered(gs)?.map((g) => g.id) ?? null);`,
    ],
    [
      // A comparison cannot misbehave on the brand, and whatever the code does
      // with the value afterwards is caught on its own. Reporting these too
      // would outlaw the explicit `=== true` / `=== false` form the contract
      // recommends, and fire twice on one defect.
      'a === null comparison',
      wrap(`const r = await window.switchboard.sessions.cards();\nif (r === null) return;`),
    ],
    [
      'a typeof test',
      wrap(`const r = await window.switchboard.workspace.getUi();\nif (typeof r === 'object') return;`),
    ],
  ])('leaves %s alone', (_label, source) => {
    expect(kinds(source)).toEqual([]);
  });
});

// #650. The sibling of "shapes it MUST catch" above, for the OTHER half of the
// defect: not a refusal read as a yes, but a refusal used as the ANSWER. Each
// case pins the KIND as well as the count, because the kind is what tells a
// reader which of `valuePositionOf`'s branches is load-bearing — a rewrite that
// collapsed them all into one label would still pass a count-only assertion.
describe('the VALUE class it MUST catch (#650)', () => {
  it.each([
    [
      'property-read',
      wrap(`const cards = await window.switchboard.sessions.cards();\nconsole.log(cards.length);`),
    ],
    [
      'property-read',
      `void window.switchboard.sessions.setTransport('c', 'pty').then((r) => { if (!r?.ok) return; use(r); });`,
    ],
    [
      'passed-on',
      `void window.switchboard.events.list().then((l) => setEvents(l));`,
    ],
    [
      // THE SHAPE THIS ITEM WAS FILED FOR: `events:list` is declared
      // `Promise<unknown[]>`, so the cast is the only thing between the wire
      // and a typed store, and it happily launders the brand INTO it.
      'passed-on',
      `void window.switchboard.events.list().then((l) => setEvents(l as EventDto[]));`,
    ],
    [
      // the same cast worn as a RENAME rather than as an argument — the shape
      // that made DiffPane's `git.status` answer invisible to the first draft
      'property-read',
      `void window.switchboard.git.status('/f').then((s) => { const next = s as GitStatusDto; use(next.files); });`,
    ],
    [
      'iterated',
      wrap(`for (const c of await window.switchboard.sessions.cards()) use(c);`),
    ],
    [
      'destructured',
      wrap(`const { hits } = await window.switchboard.transcripts.search({});\nuse(hits);`),
    ],
    [
      'returned',
      wrap(`const r = await window.switchboard.sessions.cards();\nreturn r;`),
    ],
    [
      // the RIGHT of `??` — the opposite side from #440's `nullish`, and just
      // as much a way for the brand to become the state
      'stored',
      `void window.switchboard.health.get().then((s) => setHealth((prev) => prev ?? s));`,
    ],
    [
      'spread',
      `void window.switchboard.sessions.cards().then((l) => use([...l]));`,
    ],
    [
      'assigned',
      wrap(`const r = await window.switchboard.sessions.cards();\nref.current = r;`),
    ],
    [
      // `Promise.resolve(bridge.x?.())` — WorkspaceNoticeBanner's wrapper for an
      // optional-chained call. Without seeing through it the whole file read as
      // bridge-free, which is a clean scan of nothing.
      'passed-on',
      `void Promise.resolve(window.switchboard?.workspace?.saveState?.()).then((s) => apply(s));`,
    ],
  ])('catches it as %s', (kind, source) => {
    expect(kinds(source)).toContain(kind);
  });

  it('catches a refusal rendered into JSX', () => {
    expect(
      kindsTsx(`void window.switchboard.sessions.cards().then((l) => render(<div>{l}</div>));`)
    ).toContain('rendered');
  });

  it('reports one finding per READ, not one per mention', () => {
    // `answered` is deliberately NOT applied here, so the two reads of `r` are
    // two real defects — but the declaration itself is not a third. A rule that
    // counted the binding would make every fixed site look half-fixed.
    const found = scanSource(
      'src/renderer/src/probe.ts',
      wrap(`const r = await window.switchboard.sessions.cards();\nuse(r.length);\nuse(r[0]);`),
      methods
    );
    expect(found.map((f) => f.kind)).toEqual(['property-read', 'property-read']);
  });
});

describe('the renderer itself', () => {
  // THE POINT OF THE FILE. Every site this found is listed in the #440 and
  // #650 handoffs; if it goes red, a new bridge answer is being used somewhere
  // without being laundered first, and the report says which line and how.
  it('uses no brokered bridge answer without laundering it first', () => {
    const result = scanTree(ROOT);
    expect(formatReport(result).join('\n')).toContain('clean');
    expect(result.offenders).toEqual([]);
  });

  it('actually looked at the tree — a scan of nothing is not a clean scan', () => {
    const result = scanTree(ROOT);
    expect(result.files.length).toBeGreaterThan(50);
    expect(result.files).toContain('src/renderer/src/App.tsx');
  });
});
