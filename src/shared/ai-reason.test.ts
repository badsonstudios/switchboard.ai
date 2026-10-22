// #1365: main's reasons as codes — the shape, the checks, and that every code
// has words in every locale.
import { describe, it, expect } from 'vitest';
import en from './i18n/locales/en.json';
import { AI_REASON_CODES, AiReasonError, aiReason, aiReasonKey, reasonOfError } from './ai-reason';

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k] : undefined), en);
}

describe('aiReason', () => {
  it('drops empty values, so a sentence never shows a blank', () => {
    expect(aiReason('cancelled')).toEqual({ code: 'cancelled' });
    expect(aiReason('exited-before-answering', { code: 3, output: '' })).toEqual({
      code: 'exited-before-answering',
      params: { code: 3 },
    });
  });

  it('an AiReasonError keeps its English message and carries the code', () => {
    const e = new AiReasonError('npx not found', aiReason('npx-missing'));
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('npx not found');
    expect(reasonOfError(e)).toEqual({ code: 'npx-missing' });
    expect(reasonOfError(new Error('plain'))).toBeUndefined();
  });
});

describe('aiReasonKey (untrusted input)', () => {
  it('every code has an English sentence', () => {
    for (const code of AI_REASON_CODES) {
      const params = { command: 'x', seconds: 1, message: 'm', method: 'm', code: 1, ai: 'A' };
      const k = aiReasonKey({ code, params });
      expect(k, code).toBeDefined();
      expect(typeof lookup(k!.key), k!.key).toBe('string');
    }
    expect(typeof lookup('ais.reason.exitedBeforeAnsweringWithOutput')).toBe('string');
  });

  it('picks the with-output sentence only when there is output', () => {
    expect(aiReasonKey({ code: 'exited-before-answering', params: { code: 3 } })?.key).toBe('ais.reason.exitedBeforeAnswering');
    expect(aiReasonKey({ code: 'exited-before-answering', params: { code: 3, output: 'bye' } })?.key).toBe(
      'ais.reason.exitedBeforeAnsweringWithOutput'
    );
  });

  it('refuses what it cannot say whole: unknown codes, missing values, bad shapes', () => {
    expect(aiReasonKey(undefined)).toBeUndefined();
    expect(aiReasonKey('cancelled')).toBeUndefined();
    expect(aiReasonKey({ code: 'constructor' })).toBeUndefined();
    expect(aiReasonKey({ code: 'sign-in-failed' })).toBeUndefined();
    expect(aiReasonKey({ code: 'sign-in-failed', params: { message: { nested: true } } })).toBeUndefined();
    expect(aiReasonKey({ code: 'cancelled', params: ['x'] })).toBeUndefined();
    expect(aiReasonKey({ code: 'no-answer-in-time', params: { seconds: Number.NaN } })).toBeUndefined();
    expect(aiReasonKey({ code: 'cancelled', params: { extra: 1 } })).toEqual({ key: 'ais.reason.cancelled', vars: { extra: 1 } });
  });
});
