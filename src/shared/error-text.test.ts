import { describe, expect, it } from 'vitest';
import { errorText } from './error-text';

describe('errorText', () => {
  it('reads an Error exactly as String(err) did, so no useful log line changes', () => {
    const err = new Error('disk full');
    expect(errorText(err)).toBe('Error: disk full');
    expect(errorText(new TypeError('not a function'))).toBe('TypeError: not a function');
  });

  it('passes a primitive through', () => {
    expect(errorText('plain string')).toBe('plain string');
    expect(errorText(42)).toBe('42');
    expect(errorText(undefined)).toBe('undefined');
    expect(errorText(null)).toBe('null');
  });

  it('shows the message of a thrown plain object instead of [object Object]', () => {
    expect(errorText({ code: -32601, message: 'Method not found' })).toBe('Method not found');
  });

  it('shows the fields when a thrown object has no message', () => {
    expect(errorText({ code: 'EBUSY', path: 'x.txt' })).toBe('{"code":"EBUSY","path":"x.txt"}');
    expect(errorText({})).toBe('{}');
  });

  it('honours an object that has its own toString', () => {
    expect(errorText({ toString: () => 'custom words' })).toBe('custom words');
  });

  it('does not let an array of objects through as [object Object]', () => {
    expect(errorText([{ a: 1 }])).toBe('[{"a":1}]');
  });

  it('caps a huge object so one log line stays one line', () => {
    const text = errorText({ blob: 'x'.repeat(5000) });
    expect(text.length).toBe(501);
    expect(text.endsWith('…')).toBe(true);
  });

  it('names the keys of an object that cannot be serialised', () => {
    const cycle: Record<string, unknown> = { id: 7 };
    cycle.self = cycle;
    expect(errorText(cycle)).toBe('a thrown object that could not be shown (keys: id, self)');
  });

  it('never throws, whatever it is handed', () => {
    const hostile = {
      toString(): string {
        throw new Error('no');
      },
      get message(): string {
        throw new Error('no');
      },
      toJSON(): never {
        throw new Error('no');
      },
    };
    expect(() => errorText(hostile)).not.toThrow();
    expect(errorText(hostile)).toBe('a thrown object that could not be shown (keys: toString, message, toJSON)');
    expect(errorText(Object.create(null))).toBe('{}');
  });

  it('never returns the text it exists to remove', () => {
    for (const v of [{}, { a: 1 }, [{}], new Map(), Object.create(null), { message: '' }]) {
      expect(errorText(v)).not.toContain('[object ');
    }
  });
});
