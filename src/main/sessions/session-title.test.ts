import { describe, expect, it } from 'vitest';
import { MAX_SESSION_TITLE, uniqueSessionTitle } from './session-title';

describe('uniqueSessionTitle (#1282)', () => {
  it('a free name is kept exactly', () => {
    expect(uniqueSessionTitle('Switchboard.ai', ['other', 'another'])).toBe('Switchboard.ai');
  });

  it('a taken name gets -2 — there is no -1', () => {
    expect(uniqueSessionTitle('app', ['app'])).toBe('app-2');
  });

  it('the first FREE number, not one past the highest', () => {
    expect(uniqueSessionTitle('app', ['app', 'app-2', 'app-3'])).toBe('app-4');
    expect(uniqueSessionTitle('app', ['app', 'app-3'])).toBe('app-2');
  });

  it('clashes are found without case, and the wanted spelling is kept', () => {
    expect(uniqueSessionTitle('App', ['app'])).toBe('App-2');
    expect(uniqueSessionTitle('app', ['APP', 'App-2'])).toBe('app-3');
  });

  it('a suggestion offered back is itself free, so accepting it changes nothing', () => {
    const taken = ['app', 'app-2'];
    const first = uniqueSessionTitle('app', taken);
    expect(first).toBe('app-3');
    expect(uniqueSessionTitle(first, taken)).toBe(first);
  });

  it('nothing taken at all', () => {
    expect(uniqueSessionTitle('x', [])).toBe('x');
  });

  it('cuts to the limit, the way sessions:create always did', () => {
    const long = 'a'.repeat(MAX_SESSION_TITLE + 30);
    expect(uniqueSessionTitle(long, [])).toBe('a'.repeat(MAX_SESSION_TITLE));
  });

  it('a malformed saved title is skipped rather than thrown on', () => {
    expect(uniqueSessionTitle('app', [undefined as unknown as string, 'app'])).toBe('app-2');
  });
});
