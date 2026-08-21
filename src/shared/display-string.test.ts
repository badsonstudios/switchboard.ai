// The boundary read that used to say `[object Object]` (#255 T1).
//
// Thirteen call sites across the stream protocol, the stream fake's CLI and
// check script, the permission-offer path and the Feed derivation each read a
// field out of a payload they did not shape. Twelve were `no-base-to-string`
// errors (eleven of them literally `String(x ?? fallback)`, one a `String()`
// inside a truthiness ternary); the thirteenth was a
// `restrict-template-expressions` error on `${m.type}` and came along because
// it is the same read. In every one the static type is `unknown`, so a
// malformed payload rendered as literal `[object Object]` — on a permission
// card, in a Feed checklist, and potentially as a FILE NAME.
//
// What is pinned here is the pair of promises the callers depend on: it never
// throws (fail-open, the same as `String`), and a value that is not display
// text at all gets the caller's fallback so the caller's existing empty-value
// path — "no id, cannot answer", "no path, cannot write" — takes over.
import { describe, it, expect } from 'vitest';
import { asDisplayString } from './display-string';

describe('asDisplayString', () => {
  it('passes a string through untouched', () => {
    expect(asDisplayString('toolu_123')).toBe('toolu_123');
    expect(asDisplayString('')).toBe('');
  });

  it('keeps falsy primitives, because `??` did', () => {
    // The idiom replaced was `x ?? fallback`, NOT `x || fallback`: 0 and false
    // are real values a payload can carry and they must survive.
    expect(asDisplayString(0)).toBe('0');
    expect(asDisplayString(false)).toBe('false');
    expect(asDisplayString(0, 'unknown')).toBe('0');
  });

  it('stringifies the other primitives', () => {
    expect(asDisplayString(42)).toBe('42');
    expect(asDisplayString(true)).toBe('true');
    expect(asDisplayString(10n)).toBe('10');
    expect(asDisplayString(Number.NaN)).toBe('NaN');
  });

  it('falls back for nullish', () => {
    expect(asDisplayString(null)).toBe('');
    expect(asDisplayString(undefined)).toBe('');
    expect(asDisplayString(null, 'unknown')).toBe('unknown');
  });

  it('falls back for anything that is not display text — the whole point', () => {
    // Every one of these used to produce a string a person would then SEE.
    expect(asDisplayString({ id: 1 })).toBe('');
    expect(asDisplayString(['a', 'b'])).toBe('');
    expect(asDisplayString(() => 'x')).toBe('');
    expect(asDisplayString(Symbol('s'))).toBe('');
    expect(asDisplayString({}, 'unknown')).toBe('unknown');
  });

  it('never throws, whatever arrives', () => {
    // `String(Symbol())` is fine but a template literal on one throws, and an
    // object with a hostile `toString` throws from either. Callers are on
    // untrusted JSON and have no catch.
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    };
    expect(() => asDisplayString(hostile)).not.toThrow();
    expect(asDisplayString(hostile)).toBe('');
    expect(() => `${asDisplayString(Symbol('s'))}`).not.toThrow();
  });
});
