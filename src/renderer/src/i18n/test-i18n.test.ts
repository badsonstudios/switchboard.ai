// The proof under `test-i18n.ts` (#380): the shared harness is the app's own
// configuration, so a string written in the wrong interpolation dialect FAILS
// here — the same way, and for the same reason, that it fails on screen.
//
// This is the assertion the eleven hand-rolled harnesses could not make about
// themselves. One of them had quietly dropped `i18next-icu`, which does not
// weaken interpolation, it REPLACES it: with the plugin installed i18next never
// runs its own `{{…}}` pass, so mustache placeholders survive into the DOM. A
// harness without the plugin expands them happily and reports green. That is
// how #207's `{{file}}` reached review.
//
// `locales.test.ts` bans `{{` from `en.json`; this bans a harness that would
// not have minded it.
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import i18next from 'i18next';
import { initI18nForTests } from './test-i18n';
import { configureI18n } from './index';
import { pseudolocalize } from './pseudo';
import en from './locales/en.json';

/** Keys no shipped resource has, added after init so this file proves the
 *  CONFIGURATION rather than re-testing whatever `en.json` happens to say. */
const PROBE = {
  icu: 'writing {file}',
  mustache: 'writing {{file}}',
  plural: '{count, plural, one {# session} other {# sessions}}',
  empty: '',
};

beforeAll(async () => {
  await initI18nForTests();
  i18next.addResourceBundle('en', 'translation', { probe: PROBE }, true, true);
});

describe('the shared test harness interpolates exactly as the app does', () => {
  it('expands an ICU placeholder', () => {
    expect(i18next.t('probe.icu', { file: 'workspace.json' })).toBe('writing workspace.json');
  });

  it('leaves a mustache placeholder VERBATIM — the #207 failure, reproduced', () => {
    // The whole point. Under a harness without ICU this reads
    // "writing workspace.json" and the bug ships; under the app's real
    // configuration the user sees the braces, and so does the test.
    expect(i18next.t('probe.mustache', { file: 'workspace.json' })).toBe('writing {{file}}');
  });

  it('runs ICU plurals, which is what most of en.json interpolates with', () => {
    expect(i18next.t('probe.plural', { count: 1 })).toBe('1 session');
    expect(i18next.t('probe.plural', { count: 4 })).toBe('4 sessions');
  });
});

describe('the shared test harness is configured like the app in every other way', () => {
  it('serves the real en.json, not a stub', () => {
    // a harness pointed at a fixture would let a key be deleted from the
    // resource file without a single component test noticing
    expect(i18next.t('preflight.missingCli')).toBe(en.preflight.missingCli);
  });

  it('returns the key for an empty string, as `returnEmptyString: false` asks', () => {
    // one of the two options every hand-rolled harness had dropped. An empty
    // value is a hole in the resource file; the app is set up to make it
    // visible rather than to paint nothing
    expect(i18next.t('probe.empty')).toBe('probe.empty');
  });

  it('falls back to en, and starts there whatever preference is stored', () => {
    expect(i18next.language).toBe('en');
    expect(i18next.options.fallbackLng).toContain('en');
  });

  it('honours the language it is handed — the app hands it the stored one', () => {
    // `configureI18n`'s `lng` PARAMETER is the only thing left separating the
    // app's init from the test's, so it is the one thing worth pinning: a
    // hardcoded 'en' in there would kill the pseudo locale (§5.21's whole
    // point) with every unit test still green. A fresh instance, because the
    // singleton above is the one the migrated harnesses share.
    const inst = i18next.createInstance();
    return configureI18n(inst, 'pseudo').then(() => {
      expect(inst.t('preflight.missingCli')).toBe(pseudolocalize(en.preflight.missingCli));
    });
  });

  it('can be called again without throwing — harnesses call it per test', async () => {
    await initI18nForTests();
    await initI18nForTests();
    expect(i18next.t('probe.icu', { file: 'w.json' })).toBe('writing w.json');
  });
});

/**
 * Comments out, so a file that WRITES ABOUT `i18next.init` — this repo's tests
 * carry paragraphs of prose, and the four above are all about it — is not
 * accused of calling it. Replaced with a space rather than deleted, so nothing
 * on either side of a stripped comment fuses into a new token.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** every `*.test.ts(x)` vitest collects, as [path from the repo root, code] */
function testFiles(dir: string, out: Array<[string, string]> = []): Array<[string, string]> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (/\.test\.tsx?$/.test(e.name))
      out.push([
        relative(process.cwd(), p).replace(/\\/g, '/'),
        code(readFileSync(p, 'utf8')),
      ]);
  }
  return out;
}

/** This file, which names all three banned tokens because it IS the ban. The
 *  comment stripper cannot save it — they are in the test titles. */
const SELF = 'src/renderer/src/i18n/test-i18n.test.ts';

// both roots `vitest.config.ts` collects from; nothing in e2e/ touches i18next
// today, and the ban is worth nothing if it only covers where the problem
// already was
const TEST_FILES = [
  ...testFiles(join(process.cwd(), 'src')),
  ...testFiles(join(process.cwd(), 'e2e')),
].filter(([f]) => f !== SELF);

// The helper is only a fix while it is the ONLY door. Eleven harnesses grew
// their own chain by copy-paste, one of them lost `i18next-icu` on the way, and
// nothing in the repo could see it — the twelfth would have gone the same way.
// So the door is the assertion.
//
// Three bans, because a hand-rolled harness can evade any one of them: the
// first reads the LOCAL BINDING (`import i18n from 'i18next'` slips it), the
// second only catches a harness that remembered ICU — which is the harness
// that was never the problem. The third is the one none of them can dodge:
// binding the React layer is not optional for a component test, and
// `initReactI18next` is the only name that does it.
describe('no test builds its own i18next — that is what the helper is for (#380)', () => {
  it('sees the test tree at all', () => {
    // the witness: a walker that found nothing would make every ban vacuous
    expect(TEST_FILES.length).toBeGreaterThan(50);
  });

  it('nothing calls .use() or .init() on i18next', () => {
    // `i18next.t(...)` is fine — a test may READ through the instance. This is
    // about CONFIGURING one, which only `i18n/index.ts` may do.
    const offenders = TEST_FILES.filter(([, src]) =>
      /\bi18next\s*(\r?\n\s*)?\.(use|init)\s*\(/.test(src)
    ).map(([f]) => f);
    expect(offenders, WHY).toEqual([]);
  });

  it('nothing imports the ICU plugin directly', () => {
    const offenders = TEST_FILES.filter(([, src]) => /from ['"]i18next-icu['"]/.test(src)).map(
      ([f]) => f
    );
    expect(offenders, WHY).toEqual([]);
  });

  it('nothing names initReactI18next, whatever it imported i18next as', () => {
    const offenders = TEST_FILES.filter(([, src]) => /\binitReactI18next\b/.test(src)).map(
      ([f]) => f
    );
    expect(offenders, WHY).toEqual([]);
  });
});

const WHY =
  'this file configures i18next itself, so it is free to drift from the app — ' +
  'and the drift that already happened cost #207 a banner that would have read ' +
  '"…failing to write {{file}}" on screen while its test stayed green. Call ' +
  '`initI18nForTests()` from `src/renderer/src/i18n/test-i18n.ts`; if the app ' +
  'needs different options, change `configureI18n` and both move together.';
