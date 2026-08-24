import { describe, it, expect } from 'vitest';
import { pseudolocalize, pseudolocalizeResource } from './pseudo';
import en from './locales/en.json';

function leafStrings(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') acc.push(node);
  else if (typeof node === 'object' && node !== null) {
    for (const v of Object.values(node)) leafStrings(v, acc);
  }
  return acc;
}

describe('pseudolocalize', () => {
  it('wraps and mangles plain text', () => {
    const out = pseudolocalize('Session done');
    expect(out.startsWith('⟦')).toBe(true);
    expect(out.endsWith('⟧')).toBe(true);
    expect(out).not.toContain('Session');
  });

  it('preserves ICU argument blocks verbatim', () => {
    const out = pseudolocalize('theme: {theme} of {count, number}');
    expect(out).toContain('{theme}');
    expect(out).toContain('{count, number}');
  });

  it('mangles EVERY leaf string of the real en.json (the done-when)', () => {
    const pseudo = pseudolocalizeResource(en);
    const before = leafStrings(en);
    const after = leafStrings(pseudo);
    expect(after).toHaveLength(before.length);
    for (const s of after) {
      expect(s.startsWith('⟦')).toBe(true);
      expect(s.endsWith('⟧')).toBe(true);
    }
    // and none survive unmangled
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).not.toBe(before[i]);
    }
  });
});
