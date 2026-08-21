// #440 — the refusal-truthiness scanner, pinned in both directions.
//
// The load-bearing half is the LAST describe block: it runs the analyzer over
// the real renderer and demands zero. That is what makes a new
// `if (await bridge.x())` a red unit run rather than a defect that waits for
// Phase 4 to become reachable.
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
import {
  PRELOAD,
  invokeBackedMethods,
  scanSource,
  scanTree,
  formatReport,
} from './refusal-truthiness.js';

const ROOT = process.cwd();

/** the real bridge surface — these tests judge snippets against the real thing */
let methods;
beforeAll(() => {
  methods = invokeBackedMethods(fs.readFileSync(path.join(ROOT, PRELOAD), 'utf8'));
});

/** kinds reported for a snippet, as if it were a renderer file */
const kinds = (source) =>
  scanSource('src/renderer/src/probe.ts', source, methods).map((f) => f.kind);
const wrap = (body) => `async function probe(): Promise<void> {\n${body}\n}\n`;

describe('the bridge surface it derives from the preload', () => {
  // If this ever came back empty the scanner would report a clean tree for the
  // rest of time. It is derived, not listed, so the only thing to pin is that
  // deriving it still works — and that it draws the invoke/subscribe line in
  // the right place, since a subscription cannot be refused and `const off =
  // bridge.x.onY(...)` is a truthiness test that must stay legal.
  it('finds the brokered methods', () => {
    expect(methods.size).toBeGreaterThan(40);
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
  ])('catches %s', (_label, source) => {
    expect(kinds(source).length).toBeGreaterThan(0);
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
      'a laundered .then parameter',
      `void window.switchboard.sessions.pickFolder().then((f) => { if (answered(f)) console.log(f); });`,
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
      'a local helper that already narrows (composer mainTook)',
      wrap(`if (await mainTook('submitPrompt', () => window.switchboard.sessions.submitPrompt('s', 't'))) return;`),
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
      'a bridge result used as a VALUE rather than a boolean',
      wrap(`const cards = await window.switchboard.sessions.cards();\nconsole.log(cards.length);`),
    ],
  ])('leaves %s alone', (_label, source) => {
    expect(kinds(source)).toEqual([]);
  });
});

describe('the renderer itself', () => {
  // THE POINT OF THE FILE. Every site this found is listed in the #440 handoff;
  // if it goes red, a new bridge answer is being read as a boolean somewhere,
  // and the report says which line.
  it('reads no brokered bridge answer as a bare boolean', () => {
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
