// Every string in `en.json` is written in the dialect the app actually parses.
//
// WHY THIS FILE EXISTS
// --------------------
// `i18n/index.ts` installs `i18next-icu`. When an `i18nFormat` plugin is
// present, i18next hands the whole message to it and NEVER runs its own
// mustache interpolator — so a value written `{{file}}` instead of ICU's
// `{file}` is not a formatting nit, it is a placeholder rendered verbatim to
// the user. #207 shipped exactly that into review: a data-loss banner whose one
// actionable fact read "…keeps failing to write {{file}}".
//
// It was green because the component's own test harness initialised i18next
// WITHOUT the ICU plugin, where mustache still works. That harness is fixed,
// but the same trap is one copy-paste away in any of the other files that
// render a string — so the check belongs to the resource file, once, rather
// than to whichever test happens to touch a key.
import { describe, it, expect } from 'vitest';
import en from './locales/en.json';

/** Every leaf string in the resource tree, with the dotted key that found it. */
function leaves(node: unknown, path: string[] = []): Array<[string, string]> {
  if (typeof node === 'string') return [[path.join('.'), node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, [...path, k]));
}

const STRINGS = leaves(en);

describe('en.json speaks ICU, because that is what parses it', () => {
  it('has strings to check at all', () => {
    // the walker is the witness for everything below it; a walker that found
    // nothing would make every assertion here vacuously true
    expect(STRINGS.length).toBeGreaterThan(50);
  });

  it('uses no mustache placeholders', () => {
    const mustache = STRINGS.filter(([, v]) => v.includes('{{')).map(([k]) => k);
    expect(
      mustache,
      'these keys interpolate with {{name}}, which i18next-icu never expands — ' +
        'the user sees the braces. Write them ICU-style, as {name}'
    ).toEqual([]);
  });

  it('leaves no brace unclosed', () => {
    // an unbalanced brace is an ICU parse error at RENDER time, in whichever
    // window happened to need that string — cheaper to find here
    const unbalanced = STRINGS.filter(([, v]) => {
      let depth = 0;
      for (const ch of v) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (depth < 0) return true;
      }
      return depth !== 0;
    }).map(([k]) => k);
    expect(unbalanced, 'these keys have unbalanced ICU braces').toEqual([]);
  });
});
